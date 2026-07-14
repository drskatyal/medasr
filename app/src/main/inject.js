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

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });
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

// Inject text at the current cursor position of the focused app.
// Preserves the user's prior clipboard contents.
async function injectText(text) {
  if (!text) return;
  const prev = clipboard.readText();
  clipboard.writeText(text);
  // Small delay so the target app registers the new clipboard before paste.
  await new Promise((r) => setTimeout(r, 60));
  try {
    if (process.platform === 'darwin') await pasteMac();
    else if (process.platform === 'win32') await pasteWin();
    else await pasteLinux();
  } finally {
    // Restore previous clipboard shortly after paste completes.
    setTimeout(() => clipboard.writeText(prev), 250);
  }
}

// Replace previously-typed text with corrected text. Selects `graphemeLen`
// characters backward (Shift+ArrowLeft) then pastes — one atomic edit / undo.
// MEDICAL SAFETY: if anything looks unsafe (huge length, or cleaned text is
// suspiciously shorter), we DO NOT delete — we put the corrected text on the
// clipboard and return false so the caller can surface it instead.
async function selectLeft(n) {
  if (process.platform === 'darwin') {
    await run('osascript', ['-e',
      `tell application "System Events" to repeat ${n} times` +
      ` key code 123 using shift down` + ` end repeat`]);
  } else if (process.platform === 'win32') {
    const script = 'Add-Type -AssemblyName System.Windows.Forms; ' +
      `for($i=0;$i -lt ${n};$i++){[System.Windows.Forms.SendKeys]::SendWait("+{LEFT}")}`;
    await run('powershell', ['-NoProfile', '-Command', script]);
  } else {
    await run('xdotool', ['key', '--repeat', String(n), 'shift+Left']);
  }
}

async function replaceText(oldText, newText, graphemeLen) {
  const n = graphemeLen || oldText.length;
  const shrinkRatio = newText.length / Math.max(1, oldText.length);
  // Guardrails: don't attempt a giant selection, and don't accept a cleanup
  // that wiped most of the text (possible hallucinated deletion).
  const unsafe = n > 4000 || shrinkRatio < 0.4;
  if (unsafe) {
    clipboard.writeText(newText);
    return { replaced: false, reason: 'unsafe — corrected text copied to clipboard' };
  }
  const prev = clipboard.readText();
  clipboard.writeText(newText);
  await new Promise((r) => setTimeout(r, 60));
  try {
    await selectLeft(n);                 // select what we typed
    await new Promise((r) => setTimeout(r, 40));
    if (process.platform === 'darwin') await pasteMac();
    else if (process.platform === 'win32') await pasteWin();
    else await pasteLinux();
    return { replaced: true };
  } catch (e) {
    return { replaced: false, reason: String(e) };
  } finally {
    setTimeout(() => clipboard.writeText(prev), 300);
  }
}

module.exports = { injectText, replaceText };
