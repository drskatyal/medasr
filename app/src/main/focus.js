'use strict';
// Focus-lock: remember the text field that was focused when dictation started,
// and bring it back to the foreground right before pasting — so the transcript
// lands in the original field (e.g. a report box) even if the user clicked into
// a PACS viewer or another window meanwhile.
//
// Windows: user32 GetForegroundWindow / SetForegroundWindow via PowerShell.
// macOS:  best-effort via AppleScript frontmost app (window-level, not field).
// Linux:  xdotool getactivewindow / windowactivate.
// Best-effort only — if capture/restore fails we simply paste into whatever is
// focused (current behaviour). Gate with settings.lockFocus.

const { execFile } = require('child_process');

let target = null;      // opaque window id (platform-specific)
let targetTitle = '';   // for the "typing into …" tooltip

function ps(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-Command', script], { windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve((stdout || '').trim())));
  });
}
function sh(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve((stdout || '').trim())));
  });
}

async function captureTarget() {
  target = null; targetTitle = '';
  try {
    if (process.platform === 'win32') {
      const out = await ps(
        "Add-Type -Namespace Win -Name U -MemberDefinition '" +
        '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow();' +
        "[DllImport(\"user32.dll\")] public static extern int GetWindowText(System.IntPtr h, System.Text.StringBuilder s, int n);'; " +
        '$h=[Win.U]::GetForegroundWindow(); $sb=New-Object System.Text.StringBuilder 256; ' +
        '[Win.U]::GetWindowText($h,$sb,256) | Out-Null; ' +
        '"$($h.ToInt64())|$($sb.ToString())"');
      const [id, title] = out.split('|');
      if (id && id !== '0') { target = id; targetTitle = (title || '').trim(); }
    } else if (process.platform === 'linux') {
      target = await sh('xdotool', ['getactivewindow']).catch(() => null);
      if (target) targetTitle = await sh('xdotool', ['getwindowname', target]).catch(() => '');
    } else if (process.platform === 'darwin') {
      targetTitle = await sh('osascript', ['-e',
        'tell application "System Events" to get name of first application process whose frontmost is true']).catch(() => '');
      target = targetTitle || null;
    }
  } catch (e) { target = null; }
}

async function restoreTarget() {
  if (!target) return;
  try {
    if (process.platform === 'win32') {
      // Only un-minimize if it's actually minimized — do NOT SW_RESTORE a
      // maximized window (that shrinks it). Then bring it to the foreground.
      await ps(
        "Add-Type -Namespace Win -Name F -MemberDefinition '" +
        '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr h);' +
        '[DllImport(\"user32.dll\")] public static extern bool IsIconic(System.IntPtr h);' +
        "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(System.IntPtr h,int c);'; " +
        `$h=[System.IntPtr]${target}; if([Win.F]::IsIconic($h)){[Win.F]::ShowWindow($h,9)|Out-Null}; [Win.F]::SetForegroundWindow($h) | Out-Null`);
    } else if (process.platform === 'linux') {
      await sh('xdotool', ['windowactivate', '--sync', target]);
    } else if (process.platform === 'darwin') {
      await sh('osascript', ['-e', `tell application "${target}" to activate`]).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 50));
  } catch (e) { /* fall through: paste into whatever is focused */ }
}

function clearTarget() { target = null; targetTitle = ''; }
function getTargetTitle() { return targetTitle; }

module.exports = { captureTarget, restoreTarget, clearTarget, getTargetTitle };
