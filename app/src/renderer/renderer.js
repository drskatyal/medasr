'use strict';
// Renderer: mic capture + 16kHz mono resample, driven by main-process messages.

const orb = document.getElementById('orb');

// Drag the orb to move the widget; a click (no drag) toggles dictation.
let dragFrom = null;
let dragDist = 0;
orb.addEventListener('mousedown', (e) => { dragFrom = { x: e.screenX, y: e.screenY }; dragDist = 0; });
window.addEventListener('mousemove', (e) => {
  if (!dragFrom) return;
  const dx = e.screenX - dragFrom.x;
  const dy = e.screenY - dragFrom.y;
  if (dx || dy) {
    dragDist += Math.abs(dx) + Math.abs(dy);
    try { window.medasr.moveBy(dx, dy); } catch (err) {}
    dragFrom = { x: e.screenX, y: e.screenY };
  }
});
window.addEventListener('mouseup', () => {
  if (dragFrom && dragDist < 5) {
    // Flip the orb colour immediately (don't wait for the main-process round
    // trip) so the click feels instant; main confirms/corrects the state next.
    const goingToRec = !document.body.classList.contains('rec');
    setState(goingToRec ? 'recording' : 'idle');
    try { window.medasr.toggle(); } catch (e) {}
  }
  dragFrom = null;
});

// Orb states: idle (black), recording (red), and the processing states
// transcribing / cleaning / downloading (tint + smooth arc + small caption).
const cap = document.getElementById('cap');
function setState(state, pct) {
  const cls = { recording: 'rec', transcribing: 'transcribing', cleaning: 'cleaning', downloading: 'downloading' }[state] || '';
  document.body.className = cls;
  if (cap) {
    cap.textContent = state === 'cleaning' ? 'Cleaning…'
      : state === 'transcribing' ? 'Transcribing…'
      : state === 'downloading' ? (typeof pct === 'number' ? pct + '%' : 'Downloading…')
      : '';
  }
}

const TARGET_SR = 16000;
const PREROLL_S = 0.8;   // audio kept before you press the key, so the start isn't clipped

let audioCtx = null;
let stream = null;
let source = null;
let processor = null;
let nativeSR = 48000;
let warm = false;         // mic pipeline is alive and buffering
let recording = false;    // push-to-talk capture in progress
let streaming = false;    // real-time mode: stream frames to main
let streamingCmd = false; // always-on command listener: stream frames to Vosk
let preRoll = [];         // rolling last ~PREROLL_S of audio (Float32Array chunks)
let collected = [];       // chunks captured during the active recording

const rlog = (m) => { try { window.medasr.log(m); } catch (e) {} };

// Bring up the mic pipeline once and keep it warm (buffering a short pre-roll),
// so there's no device-acquisition delay when recording starts.
async function ensureWarm() {
  if (warm) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    rlog('getUserMedia FAILED: ' + (e && e.message || e));
    return false;
  }
  audioCtx = new AudioContext({ sampleRate: 48000 });
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (e) { rlog('resume failed: ' + (e && e.message || e)); }
  }
  nativeSR = audioCtx.sampleRate;
  source = audioCtx.createMediaStreamSource(stream);
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const maxPre = PREROLL_S * nativeSR;
  processor.onaudioprocess = (e) => {
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    // maintain the rolling pre-roll buffer
    preRoll.push(data);
    let total = preRoll.reduce((n, c) => n + c.length, 0);
    while (preRoll.length > 1 && total - preRoll[0].length >= maxPre) total -= preRoll.shift().length;
    if (recording) collected.push(data);
    if (streaming) { try { window.medasr.sendFrame(streamResample16k(data, nativeSR)); } catch (err) {} }
    // Always-on command listener taps the same mic (separate resampler phase).
    if (streamingCmd) { try { window.medasr.sendCmdFrame(cmdResample16k(data, nativeSR)); } catch (err) {} }
  };
  source.connect(processor);
  processor.connect(audioCtx.destination);
  warm = true;
  rlog('mic warm @ ' + nativeSR + ' Hz, state=' + audioCtx.state);
  return true;
}

async function startCapture() {
  const ok = await ensureWarm();
  if (!ok) throw new Error('mic unavailable');
  streaming = false;             // batch mode is NEVER streaming (clear any stuck real-time flag)
  collected = preRoll.slice();   // seed with the pre-roll so the start isn't cut
  recording = true;
  rlog('recording (with ' + PREROLL_S + 's pre-roll)');
}

function stopCapture() {
  recording = false;             // keep the pipeline warm for next time
  const merged = mergeFloat32(collected);
  collected = [];
  return resampleTo16k(merged, nativeSR);
}

// Stateful linear resampler for the real-time stream: carries the phase and the
// last sample across chunks so there's no discontinuity at chunk boundaries
// (per-chunk stateless resampling aliases glitches into the speech band).
let rsPos = 0;
let rsPrev = 0;
function streamResample16k(input, srcSR) {
  if (srcSR === TARGET_SR) return input;
  const ratio = srcSR / TARGET_SR;
  const ext = new Float32Array(input.length + 1);
  ext[0] = rsPrev; ext.set(input, 1);
  const out = [];
  let pos = rsPos;
  const last = ext.length - 1;
  while (pos < last) {
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    out.push(ext[i0] + (ext[i0 + 1] - ext[i0]) * frac);
    pos += ratio;
  }
  rsPos = pos - last;                 // carry fractional phase into next chunk
  rsPrev = input[input.length - 1];   // next chunk's ext[0]
  return Float32Array.from(out);
}

// Independent stateful resampler for the always-on command stream, so its phase
// never collides with the real-time dictation stream (they tap the same mic).
let rsPosCmd = 0;
let rsPrevCmd = 0;
function cmdResample16k(input, srcSR) {
  if (srcSR === TARGET_SR) return input;
  const ratio = srcSR / TARGET_SR;
  const ext = new Float32Array(input.length + 1);
  ext[0] = rsPrevCmd; ext.set(input, 1);
  const out = [];
  let pos = rsPosCmd;
  const last = ext.length - 1;
  while (pos < last) {
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    out.push(ext[i0] + (ext[i0 + 1] - ext[i0]) * frac);
    pos += ratio;
  }
  rsPosCmd = pos - last;
  rsPrevCmd = input[input.length - 1];
  return Float32Array.from(out);
}

function computeRms(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / (frame.length || 1));
}

function mergeFloat32(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Linear-interpolation resampler to 16kHz. Adequate for ASR features.
function resampleTo16k(input, srcSR) {
  if (srcSR === TARGET_SR) return input;
  const ratio = srcSR / TARGET_SR;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] || 0;
    const b = input[idx + 1] || a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

window.medasr.onState(setState);
// Always-on command listener: bring up the mic and stream continuously.
window.medasr.onCmdListen(async (on) => {
  if (on) {
    const ok = await ensureWarm();
    if (ok) { rsPosCmd = 0; rsPrevCmd = 0; streamingCmd = true; rlog('command listener streaming on'); }
  } else {
    streamingCmd = false; rlog('command listener streaming off');
  }
});
window.medasr.onRecord(async (msg) => {
  if (msg.action === 'start') {
    if (msg.mode === 'realtime') {
      const ok = await ensureWarm();
      rsPos = 0; rsPrev = 0;   // reset resampler phase for a fresh session
      if (ok) { streaming = true; rlog('realtime streaming on'); } else { streaming = false; setState('idle'); }
    } else {
      try { await startCapture(); } catch (e) { setState('idle'); }
    }
  } else if (msg.action === 'stop') {
    if (streaming) { streaming = false; rlog('realtime streaming off'); return; }
    const pcm = stopCapture();
    const rms = computeRms(pcm);
    const secs = pcm.length / 16000;
    rlog('stop -> ' + secs.toFixed(2) + 's, rms=' + rms.toFixed(4));
    // Skip near-silent captures so a stray toggle doesn't transcribe ambient noise.
    if (secs < 0.3 || rms < 0.006) { rlog('no real speech -> not sending'); return; }
    await window.medasr.sendAudio(pcm);
  }
});
