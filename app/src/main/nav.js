'use strict';
// Voice navigation: spoken "go to <term>" / "find <term>" / "search <term>"
// jumps the cursor to that word in whatever app is focused, using the app's own
// Find (Ctrl/Cmd+F). Best-effort and app-dependent (some apps leave the match
// selected, some place the caret) — reliable navigation needs Template Mode.
//
// Detection is conservative: the utterance must START with a trigger and the
// target must be short (<= 4 words), so normal dictation isn't hijacked.

const { execFile } = require('child_process');

const TRIGGERS = [
  /^(?:go to|goto|jump to|navigate to|move to)\s+(?:the\s+)?(.+)$/i,
  /^(?:find|search(?:\s+for)?|locate)\s+(?:the\s+)?(.+)$/i,
];

// Returns the sanitized search term if `text` is a navigation command, else null.
function parseNav(text) {
  if (!text) return null;
  const t = text.trim().replace(/[.?!,;:]+$/, '');
  for (const re of TRIGGERS) {
    const m = t.match(re);
    if (m) {
      const term = m[1].trim().replace(/[^\p{L}\p{N} ]/gu, '').trim();
      if (term && term.split(/\s+/).length <= 4) return term;
    }
  }
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

// Open Find, type the term, go to first match, close Find, collapse selection
// to the end so dictation continues after the term.
async function navigate(term) {
  const t = term.replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 40);
  if (!t) return { ok: false, reason: 'empty term' };
  try {
    if (process.platform === 'win32') {
      const s = "Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.SendKeys]; " +
        "$s::SendWait('^f'); Start-Sleep -Milliseconds 220; " +
        `$s::SendWait('${t}'); Start-Sleep -Milliseconds 140; ` +
        "$s::SendWait('{ENTER}'); Start-Sleep -Milliseconds 140; " +
        "$s::SendWait('{ESC}'); Start-Sleep -Milliseconds 60; $s::SendWait('{RIGHT}')";
      await run('powershell', ['-NoProfile', '-Command', s]);
    } else if (process.platform === 'darwin') {
      const script =
        'tell application "System Events"\n' +
        ' keystroke "f" using command down\n delay 0.22\n' +
        ` keystroke "${t}"\n delay 0.14\n` +
        ' key code 36\n delay 0.14\n key code 53\n key code 124\n' +
        'end tell';
      await run('osascript', ['-e', script]);
    } else {
      await run('xdotool', ['key', 'ctrl+f']);
      await new Promise((r) => setTimeout(r, 200));
      await run('xdotool', ['type', t]);
      await run('xdotool', ['key', 'Return']);
      await run('xdotool', ['key', 'Escape']);
      await run('xdotool', ['key', 'Right']);
    }
    return { ok: true, term: t };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

module.exports = { parseNav, navigate };
