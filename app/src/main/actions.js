'use strict';
// Voice actions: spoken commands that DO something instead of being typed.
//  - macros    : user-defined "trigger = expansion" text templates (typed)
//  - runApp    : launch an application (cross-platform Windows/macOS/Linux)
//  - systemKey : an OS action (show desktop / minimize all)
//  - internal  : control the app itself (stop dictation)
//
// Matching is STRICT: an utterance triggers an action only when the whole
// utterance equals a trigger (after normalization). Since real-time utterances
// are pause-delimited, "open chrome" said alone fires; "open chrome and check"
// is typed normally — so commands don't misfire inside a dictated report.

const { execFile, spawn } = require('child_process');
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

function norm(s) {
  return (s || '').toLowerCase().trim().replace(/[.?!,;:]+$/, '').replace(/\s+/g, ' ');
}

// ---- built-in command set (~25 triggers) ----
// value.app: { win, mac, linux } app name/exe for launching.
const DEFAULT_COMMANDS = [
  { type: 'runApp', triggers: ['open chrome', 'launch chrome', 'open google chrome'], app: { win: 'chrome', mac: 'Google Chrome', linux: 'google-chrome' } },
  { type: 'runApp', triggers: ['open edge', 'open microsoft edge'], app: { win: 'msedge', mac: 'Microsoft Edge', linux: 'microsoft-edge' } },
  { type: 'runApp', triggers: ['open firefox'], app: { win: 'firefox', mac: 'Firefox', linux: 'firefox' } },
  { type: 'runApp', triggers: ['open explorer', 'open file explorer', 'open finder', 'open files'], app: { win: 'explorer', mac: 'Finder', linux: 'xdg-open' } },
  { type: 'runApp', triggers: ['open notepad', 'open text editor'], app: { win: 'notepad', mac: 'TextEdit', linux: 'gedit' } },
  { type: 'runApp', triggers: ['open word', 'open microsoft word'], app: { win: 'winword', mac: 'Microsoft Word' } },
  { type: 'runApp', triggers: ['open outlook', 'open email', 'open mail'], app: { win: 'outlook', mac: 'Microsoft Outlook' } },
  { type: 'runApp', triggers: ['open calculator'], app: { win: 'calc', mac: 'Calculator', linux: 'gnome-calculator' } },
  { type: 'runApp', triggers: ['open pacs', 'open p a c s', 'launch pacs'], app: { custom: true } },
  { type: 'systemKey', triggers: ['show desktop', 'minimize all', 'minimise all'], key: 'show-desktop' },
  { type: 'internal', triggers: ['stop dictation', 'stop listening', 'stop recording', 'finish dictation'], action: 'stopDictation' },
  { type: 'internal', triggers: ['start dictation', 'begin dictation', 'start listening', 'start recording'], action: 'startDictation' },

  // ---- editing / keyboard-shortcut commands (sent to the focused app) ----
  // `combo` is canonical: "mod" = Ctrl on Win/Linux, Cmd on macOS.
  { type: 'keys', triggers: ['copy', 'copy that', 'copy this', 'copy selection'], combo: 'mod+c' },
  { type: 'keys', triggers: ['paste', 'paste here', 'paste that', 'paste it'], combo: 'mod+v' },
  { type: 'keys', triggers: ['cut', 'cut that', 'cut this'], combo: 'mod+x' },
  { type: 'keys', triggers: ['select all', 'select everything'], combo: 'mod+a' },
  { type: 'keys', triggers: ['undo', 'undo that', 'scratch that', 'delete that', 'strike that'], combo: 'mod+z' },
  { type: 'keys', triggers: ['redo', 'redo that'], combo: MAC ? 'mod+shift+z' : 'mod+y' },
  { type: 'keys', triggers: ['save', 'save that', 'save report', 'save document'], combo: 'mod+s' },
  { type: 'keys', triggers: ['bold', 'bold that'], combo: 'mod+b' },
  { type: 'keys', triggers: ['italic', 'italicize', 'italics'], combo: 'mod+i' },
  { type: 'keys', triggers: ['underline', 'underline that'], combo: 'mod+u' },
  { type: 'keys', triggers: ['next field', 'next box', 'press tab', 'tab key'], combo: 'tab' },
  { type: 'keys', triggers: ['press enter', 'press return', 'submit'], combo: 'enter' },
  { type: 'keys', triggers: ['escape', 'press escape', 'cancel that'], combo: 'escape' },
  { type: 'keys', triggers: ['backspace', 'delete last character'], combo: 'backspace' },
  { type: 'keys', triggers: ['delete word', 'delete last word'], combo: 'mod+backspace' },
  { type: 'keys', triggers: ['forward delete', 'delete key'], combo: 'delete' },
];

// ---- macros: "trigger = expansion" lines (expansion may use \n) ----
const DEFAULT_MACROS = [
  'normal chest = No acute cardiopulmonary process. The heart size is normal. The lungs are clear. No pleural effusion or pneumothorax.',
  'normal abdomen = No acute abdominal abnormality. The visualized bowel is unremarkable. No free air or free fluid.',
].join('\n');

function parseMacros(text) {
  const out = [];
  for (const line of (text || '').split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const trigger = norm(line.slice(0, i));
    const expansion = line.slice(i + 1).trim().replace(/\\n/g, '\n');
    if (trigger && expansion) out.push({ trigger, expansion });
  }
  return out;
}

function matchCommand(text, commands = DEFAULT_COMMANDS) {
  const n = norm(text);
  for (const c of commands) if (c.triggers.some((t) => norm(t) === n)) return c;
  return null;
}

// In hands-free batch (push-to-talk) mode the mic keeps recording until the
// listener hears "stop dictation", so that phrase lands at the tail of the
// captured audio and MedASR transcribes it into the report. Strip a trailing
// stop/finish trigger before typing. (Real-time mode doesn't need this: each
// utterance is segmented, so "stop dictation" is its own utterance and is
// swallowed as a command.)
function stripTrailingStop(text) {
  if (!text) return text;
  const stop = DEFAULT_COMMANDS.find((c) => c.action === 'stopDictation');
  for (const t of stop.triggers) {
    const re = new RegExp('\\b' + t.replace(/\s+/g, '\\s+') + '\\s*[.?!]*$', 'i');
    if (re.test(text)) return text.replace(re, '').replace(/[\s,]+$/, '').trim();
  }
  return text;
}

function matchMacro(text, macros) {
  const n = norm(text);
  const m = macros.find((x) => x.trigger === n || n === 'insert ' + x.trigger || n === 'template ' + x.trigger);
  return m ? m.expansion : null;
}

function launchApp(app, pacsCommand) {
  try {
    if (app.custom) {                       // user-configured (e.g. PACS)
      if (!pacsCommand) return;
      if (WIN) spawn('cmd', ['/c', 'start', '', pacsCommand], { detached: true });
      else if (MAC) spawn('open', [pacsCommand.includes('/') ? pacsCommand : '-a', pacsCommand], { detached: true });
      else spawn('sh', ['-c', pacsCommand], { detached: true });
      return;
    }
    if (WIN) spawn('cmd', ['/c', 'start', '', app.win], { detached: true, windowsHide: true });
    else if (MAC) spawn('open', ['-a', app.mac], { detached: true });
    else if (app.linux) spawn(app.linux, [], { detached: true });
  } catch (e) { /* ignore */ }
}

function systemKey(key) {
  if (key !== 'show-desktop') return;
  if (WIN) execFile('powershell', ['-NoProfile', '-Command', '(New-Object -ComObject Shell.Application).MinimizeAll()'], { windowsHide: true }, () => {});
  else if (MAC) execFile('osascript', ['-e', 'tell application "System Events" to key code 103'], () => {});
}

// Send a keyboard shortcut to the focused app. `combo` tokens joined by '+';
// "mod" = Ctrl (Win/Linux) or Cmd (macOS). Last token is a letter or named key.
function sendKeys(combo) {
  const parts = String(combo).split('+');
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  try {
    if (WIN) {
      const named = { tab: '{TAB}', escape: '{ESC}', enter: '{ENTER}', backspace: '{BS}', delete: '{DEL}',
        home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}' };
      let s = '';
      if (mods.includes('mod')) s += '^';
      if (mods.includes('shift')) s += '+';
      if (mods.includes('alt')) s += '%';
      s += named[key] || key;
      const script = "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('" + s.replace(/'/g, "''") + "')";
      execFile('powershell', ['-NoProfile', '-Command', script], { windowsHide: true }, () => {});
    } else if (MAC) {
      const codes = { tab: 48, escape: 53, enter: 36, backspace: 51, delete: 117,
        home: 115, end: 119, pageup: 116, pagedown: 121, up: 126, down: 125, left: 123, right: 124 };
      const using = [];
      if (mods.includes('mod')) using.push('command down');
      if (mods.includes('shift')) using.push('shift down');
      if (mods.includes('alt')) using.push('option down');
      const clause = using.length ? ' using {' + using.join(', ') + '}' : '';
      const stmt = codes[key] != null ? `key code ${codes[key]}${clause}` : `keystroke "${key}"${clause}`;
      execFile('osascript', ['-e', `tell application "System Events" to ${stmt}`], () => {});
    } else {
      const named = { tab: 'Tab', escape: 'Escape', enter: 'Return', backspace: 'BackSpace', delete: 'Delete',
        home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', up: 'Up', down: 'Down', left: 'Left', right: 'Right' };
      const seq = [...mods.map((m) => (m === 'mod' ? 'ctrl' : m)), named[key] || key].join('+');
      execFile('xdotool', ['key', '--clearmodifiers', seq], () => {});
    }
  } catch (e) { /* ignore */ }
}

// Execute a matched command. hooks: { stopDictation, startDictation }.
async function executeCommand(cmd, { pacsCommand, hooks } = {}) {
  hooks = hooks || {};
  if (cmd.type === 'runApp') launchApp(cmd.app, pacsCommand);
  else if (cmd.type === 'systemKey') systemKey(cmd.key);
  else if (cmd.type === 'keys') sendKeys(cmd.combo);
  else if (cmd.type === 'internal' && cmd.action === 'stopDictation' && hooks.stopDictation) hooks.stopDictation();
  else if (cmd.type === 'internal' && cmd.action === 'startDictation' && hooks.startDictation) hooks.startDictation();
  return true;
}

module.exports = {
  DEFAULT_COMMANDS, DEFAULT_MACROS, parseMacros, matchCommand, matchMacro, executeCommand, norm,
  stripTrailingStop,
};
