'use strict';
// Always-on command listener (Vosk / Kaldi streaming).
//
// A small, cheap recognizer that runs continuously in the background — even when
// the dictation mic is "off" — so voice commands and "start/stop dictation" work
// hands-free, without being gated by the hotkey. It is NOT used for the report
// text (MedASR is far more accurate for medical dictation); it only listens for
// the fixed command set and fires a callback on a final recognized utterance.
//
// We feed it 16 kHz mono PCM. It endpoints on silence and emits final results;
// we only act on finals (never partials) so nothing fires mid-word. Matching is
// still done by actions.matchCommand (strict whole-utterance == trigger), so a
// stray full-vocab mishearing won't launch anything.
//
// `vosk` is an optionalDependency (prebuilt native lib). If it isn't installed
// or the model is missing, this stays disabled and the app works as before.

let vosk = null;

function f32ToInt16Buffer(f32) {
  const buf = Buffer.allocUnsafe(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    let s = f32[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    buf.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, i * 2);
  }
  return buf;
}

class VoskCommand {
  constructor({ modelDir, onCommand, log = () => {} }) {
    this.modelDir = modelDir;
    this.onCommand = onCommand;
    this.log = log;
    this.model = null;
    this.rec = null;
    this.ready = false;
  }

  load() {
    if (!vosk) vosk = require('vosk');   // throws if the optional dep is absent
    vosk.setLogLevel(-1);
    this.model = new vosk.Model(this.modelDir);
    this.rec = new vosk.Recognizer({ model: this.model, sampleRate: 16000 });
    this.ready = true;
    this.log('Vosk command listener loaded');
    return this;
  }

  // Feed a Float32 16 kHz mono frame. On an end-of-utterance (silence), pull the
  // final text and hand it to onCommand.
  feed(f32) {
    if (!this.ready || !f32 || !f32.length) return;
    try {
      const done = this.rec.acceptWaveform(f32ToInt16Buffer(f32));
      if (done) {
        const text = (this.rec.result().text || '').trim();
        if (text) this.onCommand(text);
      }
    } catch (e) { /* keep listening; a bad frame shouldn't kill the loop */ }
  }

  free() {
    try { if (this.rec) this.rec.free(); } catch (e) {}
    try { if (this.model) this.model.free(); } catch (e) {}
    this.ready = false; this.rec = null; this.model = null;
  }
}

module.exports = { VoskCommand };
