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
function log(...a) { console.log('[medasr]', ...a); }
const { execFile } = require('child_process');
const focus = require('./focus');

let focusLock = false;
function setFocusLock(b) { focusLock = !!b; }

// Real-time replace strategy:
//  'smart' (default): READ the target field (Ctrl/Cmd+A → copy → read clipboard),
//    verify its tail matches the hidden slate (what we dictated), then repaint
//    the field as (existing prefix)+(corrected) in ONE paste over the select-all.
//    No character sweep, and it only touches the dictated tail — anything already
//    in the field is preserved. Falls back to clipboard if it can't verify.
//  'all': Ctrl/Cmd+A → paste corrected (no read) — fastest; assumes the field
//    holds only your dictation.
//  'span': select exactly N dictated chars (sends N arrow keys = a visible sweep).
let replaceMode = 'smart';
function setReplaceMode(m) { replaceMode = (m === 'all' || m === 'span') ? m : 'smart'; }

function winKey(seq) {
  return run('powershell', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${seq}")`]);
}
async function selectAll() {
  if (process.platform === 'darwin') await run('osascript', ['-e', 'tell application "System Events" to keystroke "a" using command down']);
  else if (process.platform === 'win32') await winKey('^a');
  else await run('xdotool', ['key', '--clearmodifiers', 'ctrl+a']);
}
async function copyKey() {
  if (process.platform === 'darwin') await run('osascript', ['-e', 'tell application "System Events" to keystroke "c" using command down']);
  else if (process.platform === 'win32') await winKey('^c');
  else await run('xdotool', ['key', '--clearmodifiers', 'ctrl+c']);
}
async function collapseRight() {   // drop a selection without changing text
  if (process.platform === 'darwin') await run('osascript', ['-e', 'tell application "System Events" to key code 124']);
  else if (process.platform === 'win32') await winKey('{RIGHT}');
  else await run('xdotool', ['key', '--clearmodifiers', 'Right']);
}

// Read the focused field's text via select-all + copy. Returns null if the copy
// didn't take (field doesn't support it) so we never act on stale data.
async function readFocusedField() {
  const PROBE = '__flowrad_probe__';
  clipboard.writeText(PROBE);
  await selectAll(); await sleep(80);   // field is now fully selected
  await copyKey(); await sleep(150);
  const t = clipboard.readText();
  return (!t || t === PROBE) ? null : t;
}

// The 'smart' replace: verify + repaint, preserving any pre-existing content.
async function replaceSmart(rawTyped, corrected) {
  return serialClip(async () => {
    const orig = clipboard.readText();
    let handled = false;
    try {
      if (focusLock) { await focus.restoreTarget(); await sleep(60); }
      const fieldRaw = await readFocusedField();     // leaves the field all-selected
      if (fieldRaw == null) {
        await collapseRight(); handled = true;
        clipboard.writeText(corrected);
        return { replaced: false, reason: 'could not read field — corrected text on clipboard' };
      }
      const field = fieldRaw.replace(/\r/g, '');
      const raw = rawTyped.replace(/\r/g, '');
      let next = null;
      if (field.endsWith(raw)) next = field.slice(0, field.length - raw.length) + corrected;
      else {
        const t = raw.replace(/\s+$/, '');
        const idx = field.lastIndexOf(t);
        if (idx >= 0 && field.slice(idx + t.length).trim() === '') next = field.slice(0, idx) + corrected;
      }
      if (next == null) {   // our dictation isn't the field's tail (it changed) — don't touch it
        await collapseRight(); handled = true;
        clipboard.writeText(corrected);
        return { replaced: false, reason: 'field changed — corrected text on clipboard' };
      }
      clipboard.writeText(next);
      await sleep(90);
      // Re-select the whole field RIGHT before pasting — the earlier selection
      // from the read step may not survive the gap, so a paste could just insert
      // instead of replace. Focus is already on the target; don't re-grab it.
      await selectAll();
      await sleep(90);
      await pasteKeys();    // paste over the fresh full selection = replace
      await sleep(250);     // let the target consume the paste before we restore the clipboard
      handled = true;
      log(`[inject] smart replace: field ${field.length} -> ${next.length} chars`);
      return { replaced: true, mode: 'smart' };
    } catch (e) {
      try { if (!handled) await collapseRight(); } catch (x) {}
      return { replaced: false, reason: String(e) };
    } finally {
      clipboard.writeText(orig);
    }
  });
}

async function replaceAllField(corrected) {   // 'all' mode: no read, whole field
  return serialClip(async () => {
    const orig = clipboard.readText();
    try {
      if (focusLock) { await focus.restoreTarget(); await sleep(60); }
      clipboard.writeText(corrected); await sleep(80);
      await selectAll(); await sleep(90);
      await pasteKeys(); await sleep(250);   // pasteKeys: don't re-grab focus (would deselect)
      return { replaced: true, mode: 'all' };
    } catch (e) { return { replaced: false, reason: String(e) }; }
    finally { clipboard.writeText(orig); }
  });
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

async function pasteKeys() {   // just send the paste shortcut (no focus change)
  if (process.platform === 'darwin') await pasteMac();
  else if (process.platform === 'win32') await pasteWin();
  else await pasteLinux();
}
async function paste() {
  // Bring the locked target field back to the foreground before pasting, so
  // text lands in the original field even if focus moved (e.g. PACS).
  if (focusLock) await focus.restoreTarget();
  await pasteKeys();
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
  // Default: verify-and-repaint (no sweep, preserves pre-existing field content).
  if (replaceMode === 'smart') return replaceSmart(oldText, newText);
  if (replaceMode === 'all') return replaceAllField(newText);
  // 'span' fallback: select exactly the dictated chars (sends N keys).
  if (n > 3000) {
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
      await selectLeft(n);        // exactly the dictated span (sends N keys)
      await sleep(120);
      await pasteKeys();          // don't re-grab focus (would drop the selection)
      await sleep(220);
      return { replaced: true, mode: 'span' };
    } catch (e) {
      return { replaced: false, reason: String(e) };
    } finally {
      clipboard.writeText(prev);
    }
  });
}

module.exports = { injectText, replaceText, setFocusLock, setReplaceMode };
