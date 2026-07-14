'use strict';
// Real-time (VAD) dictation session. One finite state machine, driven by frames
// streamed from the renderer. Detects utterances on pauses (Silero VAD), types
// each utterance live, and on session end runs the cleanup LLM ONCE over the
// whole text and replaces what was typed.
//
// Anti-loop invariants (per Grok's review):
//  - a single `epoch`; any async result from an old epoch is dropped;
//  - never emit an utterance without VAD-confirmed speech >= minSpeech;
//  - one serialized queue so utterances transcribe + type in order;
//  - the orb is just "recording" for the whole session (no per-utterance flicker).

const WINDOW = 512;   // Silero VAD window @ 16kHz (~32ms); matches vad.js
const SR = 16000;

function mergeF32(chunks) {
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Float32Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Grapheme-accurate length so the "delete what we typed" step is correct with
// accents/emoji (Intl.Segmenter is available in modern Node/Electron).
function graphemeLen(s) {
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    let n = 0; for (const _ of seg.segment(s)) n++; return n;
  } catch (e) { return [...s].length; }
}

class RealtimeSession {
  // deps: { vad, transcribe(pcm)->text, cleanup(text)->text|null, hooks }
  // hooks: { setState(s), typeDelta(text)->Promise, replaceAll(oldText,newText)->Promise, log }
  constructor(deps) {
    this.d = deps;
    this.epoch = 0;
    this.active = false;
  }

  cfg() {
    const s = this.d.getSettings();
    return {
      probThreshold: s.vadProbThreshold ?? 0.5,  // Silero speech probability cutoff
      silenceMs: s.vadSilenceMs ?? 700,           // pause that ends an utterance
      minSpeechMs: s.vadMinSpeechMs ?? 250,       // ignore blips shorter than this
      prerollMs: 300,                             // lead-in kept before speech start
    };
  }

  start() {
    this.epoch++;
    const ep = this.epoch;
    this.active = true;
    this.d.vad.reset();
    this.pending = new Float32Array(0);
    this.preroll = [];
    this.utter = null;
    this.speaking = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.typedText = '';
    this.rawText = '';
    this.queue = Promise.resolve();
    this._inbox = [];
    this._draining = false;
    this.d.hooks.setState('recording');
    this.d.hooks.log(`realtime start (epoch ${ep})`);
    return ep;
  }

  // Serialize frame handling: frames can arrive faster than VAD processes them,
  // so drain one at a time to avoid racing on the pending buffer.
  onFrame(pcm) {
    if (!this.active) return;
    this._inbox.push(pcm);
    if (this._draining) return;
    this._draining = true;
    (async () => {
      while (this._inbox.length && this.active) {
        await this._process(this._inbox.shift());
      }
      this._draining = false;
    })();
  }

  // pcm: Float32Array @16k streamed from the renderer.
  async _process(pcm) {
    if (!this.active) return;
    const ep = this.epoch;
    const c = this.cfg();
    const prerollWins = Math.ceil((c.prerollMs / 1000) * SR / WINDOW);

    // accumulate + window
    if (this.pending.length) {
      const merged = new Float32Array(this.pending.length + pcm.length);
      merged.set(this.pending, 0); merged.set(pcm, this.pending.length);
      this.pending = merged;
    } else {
      this.pending = pcm;
    }

    while (this.pending.length >= WINDOW) {
      if (ep !== this.epoch) return;
      const frame = this.pending.subarray(0, WINDOW);
      this.pending = this.pending.slice(WINDOW);
      let prob = 0;
      try { prob = await this.d.vad.process(frame); } catch (e) { this.d.hooks.log('vad err: ' + (e && e.message)); }
      if (ep !== this.epoch) return;

      this.preroll.push(frame);
      if (this.preroll.length > prerollWins) this.preroll.shift();

      const isSpeech = prob >= c.probThreshold;
      const stepMs = (WINDOW / SR) * 1000;
      if (isSpeech) {
        if (!this.speaking) { this.speaking = true; this.speechMs = 0; this.utter = this.preroll.slice(); }
        this.utter.push(frame);
        this.speechMs += stepMs;
        this.silenceMs = 0;
      } else if (this.speaking) {
        this.utter.push(frame);
        this.silenceMs += stepMs;
        if (this.silenceMs >= c.silenceMs) {
          const samples = mergeF32(this.utter);
          const enough = this.speechMs >= c.minSpeechMs;
          this.speaking = false; this.utter = null; this.silenceMs = 0; this.speechMs = 0;
          if (enough) this._enqueueUtterance(samples, ep);
        }
      }
    }
  }

  _enqueueUtterance(samples, ep) {
    this.queue = this.queue.then(async () => {
      if (ep !== this.epoch) return;
      const text = (await this.d.transcribe(samples) || '').trim();
      if (ep !== this.epoch || !text) return;
      const delta = (this.typedText ? ' ' : '') + text;
      this.typedText += delta;
      this.rawText += delta;
      this.d.hooks.log('utterance: ' + JSON.stringify(text));
      await this.d.hooks.typeDelta(delta);
    }).catch((e) => this.d.hooks.log('utterance err: ' + (e && e.message)));
  }

  // Hotkey pressed again -> end session: flush, clean once, replace.
  async finish() {
    if (!this.active) return;
    this.active = false;
    const ep = this.epoch;

    // flush a still-open utterance
    if (this.speaking && this.utter && this.speechMs >= this.cfg().minSpeechMs) {
      const samples = mergeF32(this.utter);
      this._enqueueUtterance(samples, ep);
    }
    this.speaking = false; this.utter = null;
    await this.queue;                       // wait for all utterances to type
    if (ep !== this.epoch) return;

    // one cleanup pass over the whole session, then safe replace
    if (this.rawText && this.d.cleanup) {
      try {
        this.d.hooks.log('cleaning full session…');
        const cleaned = (await this.d.cleanup(this.rawText) || '').trim();
        if (ep !== this.epoch) return;
        if (cleaned && cleaned !== this.typedText) {
          await this.d.hooks.replaceAll(this.typedText, cleaned, graphemeLen(this.typedText));
          this.typedText = cleaned;
        }
      } catch (e) { this.d.hooks.log('cleanup/replace err: ' + (e && e.message)); }
    }
    this.d.hooks.setState('idle');
    this.d.hooks.log('realtime finished');
  }

  cancel() { this.active = false; this.epoch++; this.d.hooks.setState('idle'); }
}

module.exports = { RealtimeSession, graphemeLen };
