'use strict';
// Renderer: mic capture + 16kHz mono resample, driven by main-process messages.

const dot = document.getElementById('dot');
const label = document.getElementById('label');
const sub = document.getElementById('sub');

const TARGET_SR = 16000;
let audioCtx = null;
let stream = null;
let source = null;
let processor = null;
let collected = [];   // Float32Array chunks at the AudioContext's native rate
let nativeSR = 48000;

function setState(state) {
  dot.className = 'dot';
  if (state === 'recording') { dot.classList.add('rec'); label.textContent = 'Listening…'; sub.textContent = 'Press hotkey again to finish'; }
  else if (state === 'transcribing') { dot.classList.add('busy'); label.textContent = 'Transcribing…'; sub.textContent = ''; }
  else if (state === 'done') { dot.classList.add('done'); label.textContent = 'Done'; sub.textContent = 'Typed into your app'; }
  else { label.textContent = 'Idle'; sub.textContent = 'MedASR Dictate'; }
}

async function startCapture() {
  collected = [];
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  audioCtx = new AudioContext();
  nativeSR = audioCtx.sampleRate;
  source = audioCtx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but works everywhere without shipping a worklet file.
  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    collected.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(audioCtx.destination);
}

function stopCapture() {
  try { if (processor) processor.disconnect(); } catch (e) {}
  try { if (source) source.disconnect(); } catch (e) {}
  try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  try { if (audioCtx) audioCtx.close(); } catch (e) {}
  const merged = mergeFloat32(collected);
  collected = [];
  return resampleTo16k(merged, nativeSR);
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
window.medasr.onRecord(async (msg) => {
  if (msg.action === 'start') {
    try { await startCapture(); } catch (e) { setState('idle'); }
  } else if (msg.action === 'stop') {
    const pcm = stopCapture();
    // Transfer the underlying buffer to main to avoid a copy.
    await window.medasr.sendAudio(pcm);
  }
});
