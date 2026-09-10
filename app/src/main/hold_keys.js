'use strict';
// Optional OS-level keyup for hold-to-talk. Electron globalShortcut only fires
// on key down, so true press-and-hold needs uiohook-napi. If that native
// module is missing, callers fall back to "tap to start, tap again to stop".

const { parseAccelerator, eventMatchesUiohook, holdShouldStop } = require('./hotkeys');

function startHoldHook({ getHoldAccel, onDown, onUp, log }) {
  const note = (m) => { if (log) log(m); };
  let uio;
  try {
    uio = require('uiohook-napi');
  } catch (e) {
    note('uiohook-napi not available — hold hotkey is tap-to-toggle; Hold button still press-and-hold');
    return { ok: false, reason: 'missing-module' };
  }
  const { uIOhook } = uio;
  if (!uIOhook || typeof uIOhook.start !== 'function') {
    return { ok: false, reason: 'no-start' };
  }

  let down = false;
  const onKeyDown = (e) => {
    const parsed = parseAccelerator(getHoldAccel());
    if (!eventMatchesUiohook(parsed, e)) return;
    if (down) return;
    down = true;
    try { onDown(); } catch (err) { note('hold down err: ' + (err && err.message || err)); }
  };
  const onKeyUp = (e) => {
    const parsed = parseAccelerator(getHoldAccel());
    if (!holdShouldStop(parsed, e)) return;
    if (!down) return;
    down = false;
    try { onUp(); } catch (err) { note('hold up err: ' + (err && err.message || err)); }
  };

  try {
    uIOhook.removeAllListeners('keydown');
    uIOhook.removeAllListeners('keyup');
    uIOhook.on('keydown', onKeyDown);
    uIOhook.on('keyup', onKeyUp);
    uIOhook.start();
    note('hold-to-talk hook started (uiohook-napi)');
    return {
      ok: true,
      stop() {
        down = false;
        try {
          uIOhook.removeAllListeners('keydown');
          uIOhook.removeAllListeners('keyup');
          uIOhook.stop();
        } catch (e) { /* already stopped */ }
      },
    };
  } catch (e) {
    note('uiohook start failed: ' + (e && e.message || e));
    return { ok: false, reason: String(e && e.message || e) };
  }
}

module.exports = { startHoldHook };
