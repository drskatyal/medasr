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

module.exports = { injectText };
