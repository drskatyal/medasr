'use strict';
// "Type anywhere" text injection into the currently-focused app of ANY
// application, with no native npm modules: put text on the clipboard, then
// synthesize the OS paste shortcut via a built-in scripting tool.
//
//   macOS   -> osascript (System Events keystroke "v" using command down)
//   Windows -> PowerShell SendKeys ^v
//   Linux   -> xdotool key ctrl+v   (falls back to wtype on Wayland)
//
// macOS requires the app to be granted Accessibility permission (System
// Settings > Privacy & Security > Accessibility). Windows/Linux work out of box
// (Linux needs `xdotool` on X11 or `wtype` on Wayland installed).

const { clipboard } = require('electron');
const { execFile } = require('child_process');
const focus = require('./focus');

let focusLock = false;
function setFocusLock(b) { focusLock = !!b; }

// Real-time replace strategy: 'span' selects exactly the dictated characters
// (safe anywhere, but sends N arrow keys = a visible sweep); 'all' uses Ctrl/
// Cmd+A (one keystroke, instant — but replaces the ENTIRE field, so only for a
// box that holds just your dictation).
let replaceMode = 'span';
function setReplaceMode(m) { replaceMode = m === 'all' ? 'all' : 'span'; }

async function selectAll() {
  if (process.platform === 'darwin') {
    await run('osascript', ['-e', 'tell application "System Events" to keystroke "a" using command down']);
  } else if (process.platform === 'win32') {
    await run('powershell', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^a")']);
  } else {
    await run('xdotool', ['key', '--clearmodifiers', 'ctrl+a']);
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Single clipboard mutex: every write/paste/restore runs to completion before
// the next begins, so overlapping utterances (real-time mode) can't clobber the
// clipboard mid-paste or restore the wrong value into an EHR field.
let clipChain = Promise.resolve();
function serialClip(fn) {
  const run = clipChain.then(fn, fn);
  clipChain = run.then(() => {}, () => {});
  return run;
}

async function pasteMac() {
  await run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
}

async function pasteWin() {
  const script = 'Add-Type -AssemblyName System.Windows.Forms; ' +
    '[System.Windows.Forms.SendKeys]::SendWait("^v")';
  await run('powershell', ['-NoProfile', '-Command', script]);
}

async function pasteLinux() {
  try {
    await run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
  } catch (e) {
    await run('wtype', ['-M', 'ctrl', 'v', '-m', 'ctrl']); // Wayland fallback
  }
}

async function paste() {
  // Bring the locked target field back to the foreground before pasting, so
  // text lands in the original field even if focus moved (e.g. PACS).
  if (focusLock) await focus.restoreTarget();
  if (process.platform === 'darwin') await pasteMac();
  else if (process.platform === 'win32') await pasteWin();
  else await pasteLinux();
}

// Inject text at the current cursor position of the focused app. Serialized on
// the clipboard mutex; does not resolve until the prior clipboard is restored.
async function injectText(text) {
  if (!text) return;
  return serialClip(async () => {
    const prev = clipboard.readText();
    clipboard.writeText(text);
    await sleep(60);              // let the target register the new clipboard
    try { await paste(); }
    finally { await sleep(180); clipboard.writeText(prev); }  // restore inside the lock
  });
}

// Replace previously-typed text with corrected text. Selects `graphemeLen`
// characters backward (Shift+ArrowLeft) then pastes — one atomic edit / undo.
// MEDICAL SAFETY: if anything looks unsafe (huge length, or cleaned text is
// suspiciously shorter), we DO NOT delete — we put the corrected text on the
// clipboard and return false so the caller can surface it instead.
async function selectLeft(n) {
  if (n <= 0) return;
  if (process.platform === 'darwin') {
    await run('osascript', ['-e',
      `tell application "System Events" to repeat ${n} times` +
      ` key code 123 using shift down` + ` end repeat`]);
  } else if (process.platform === 'win32') {
    // Select all n characters in ONE keystroke. The parenthesized form
    // "+({LEFT n})" holds Shift across all n presses (more reliable than
    // "+{LEFT n}"), so the selection is instant — no visible char-by-char sweep.
    const script = 'Add-Type -AssemblyName System.Windows.Forms; ' +
      `[System.Windows.Forms.SendKeys]::SendWait("+({LEFT ${n}})")`;
    await run('powershell', ['-NoProfile', '-Command', script]);
  } else {
    await run('xdotool', ['key', '--repeat', String(n), 'shift+Left']);
  }
}

async function replaceText(oldText, newText, graphemeLen) {
  const n = graphemeLen || oldText.length;
  const shrinkRatio = newText.length / Math.max(1, oldText.length);
  // MEDICAL SAFETY guardrails — refuse the auto-replace (never risk eating chart
  // text) and fall back to the clipboard, if:
  //  - the correction is empty/whitespace (a paste of "" over a selection would
  //    DELETE the note),
  //  - the selection would be huge (key-repeat select is slow + lossy), or
  //  - the cleanup wiped most of the text (possible hallucinated deletion).
  if (!newText || !newText.trim()) {
    return { replaced: false, reason: 'empty correction — kept the original text' };
  }
  if (shrinkRatio < 0.4) {   // cleanup wiped most of the text — possible hallucinated deletion
    clipboard.writeText(newText);
    return { replaced: false, reason: 'unsafe shrink — corrected text copied to clipboard' };
  }
  // 'span' mode only: a very long selection via key-repeat is slow/lossy.
  if (replaceMode !== 'all' && n > 3000) {
    clipboard.writeText(newText);
    return { replaced: false, reason: 'too long — corrected text copied to clipboard' };
  }
  return serialClip(async () => {
    const prev = clipboard.readText();
    clipboard.writeText(newText);
    await sleep(60);
    try {
      // Restore the locked target FIRST, so the selection happens in the report
      // field — not in whatever else grabbed focus during cleanup.
      if (focusLock) { await focus.restoreTarget(); await sleep(60); }
      if (replaceMode === 'all') await selectAll();   // one keystroke, no sweep (whole field)
      else await selectLeft(n);                       // exactly the dictated span (sends N keys)
      await sleep(120);
      await paste();              // paste() re-asserts focus, then pastes
      await sleep(180);
      return { replaced: true };
    } catch (e) {
      return { replaced: false, reason: String(e) };
    } finally {
      clipboard.writeText(prev);
    }
  });
}

module.exports = { injectText, replaceText, setFocusLock, setReplaceMode };
