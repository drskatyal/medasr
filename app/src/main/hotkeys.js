'use strict';
// Electron accelerator helpers. Pure JS — no Electron import — so unit tests run in Node.
//
// Defaults: Alt+X hold / Alt+Z toggle on Windows and Linux. On macOS the same
// accelerators are Option+X / Option+Z (Electron maps Alt → Option). The Mac
// Fn/Globe key is a hardware modifier apps cannot bind; F13–F19 are the
// closest editable stand-ins.

const HOLD_DEFAULT = 'Alt+X';
const TOGGLE_DEFAULT = 'Alt+Z';

// libuiohook keycodes used by uiohook-napi (hex as documented by the package).
const UIOHOOK_KEY = {
  BACKSPACE: 0x000E, TAB: 0x000F, ENTER: 0x001C, ESCAPE: 0x0001, SPACE: 0x0039,
  PAGEUP: 0x0E49, PAGEDOWN: 0x0E51, END: 0x0E4F, HOME: 0x0E47,
  LEFT: 0xE04B, UP: 0xE048, RIGHT: 0xE04D, DOWN: 0xE050,
  INSERT: 0x0E52, DELETE: 0x0E53,
  '0': 0x000B, '1': 0x0002, '2': 0x0003, '3': 0x0004, '4': 0x0005,
  '5': 0x0006, '6': 0x0007, '7': 0x0008, '8': 0x0009, '9': 0x000A,
  A: 0x001E, B: 0x0030, C: 0x002E, D: 0x0020, E: 0x0012, F: 0x0021,
  G: 0x0022, H: 0x0023, I: 0x0017, J: 0x0024, K: 0x0025, L: 0x0026,
  M: 0x0032, N: 0x0031, O: 0x0018, P: 0x0019, Q: 0x0010, R: 0x0013,
  S: 0x001F, T: 0x0014, U: 0x0016, V: 0x002F, W: 0x0011, X: 0x002D,
  Y: 0x0015, Z: 0x002C,
  F1: 0x003B, F2: 0x003C, F3: 0x003D, F4: 0x003E, F5: 0x003F, F6: 0x0040,
  F7: 0x0041, F8: 0x0042, F9: 0x0043, F10: 0x0044, F11: 0x0057, F12: 0x0058,
  F13: 0x005B, F14: 0x005C, F15: 0x005D, F16: 0x0063, F17: 0x0064,
  F18: 0x0065, F19: 0x0066, F20: 0x0067, F21: 0x0068, F22: 0x0069,
  F23: 0x006A, F24: 0x006B,
  SEMICOLON: 0x0027, EQUAL: 0x000D, COMMA: 0x0033, MINUS: 0x000C,
  PERIOD: 0x0034, SLASH: 0x0035, BACKQUOTE: 0x0029, BRACKETLEFT: 0x001A,
  BACKSLASH: 0x002B, BRACKETRIGHT: 0x001B, QUOTE: 0x0028,
  PLUS: 0x000D,
};
const MOD_CODES = new Set([
  0x001D, 0x0E1D, // Ctrl
  0x0038, 0x0E38, // Alt
  0x002A, 0x0036, // Shift
  0x0E5B, 0x0E5C, // Meta
]);

function normalizeKey(p) {
  const raw = String(p || '').trim();
  const l = raw.toLowerCase();
  if (!raw) return '';
  if (l === 'space' || l === 'spacebar') return 'SPACE';
  if (l === 'plus' || l === 'add') return 'PLUS';
  if (l === 'minus' || l === 'subtract') return 'MINUS';
  if (l === 'esc' || l === 'escape') return 'ESCAPE';
  if (l === 'return' || l === 'enter') return 'ENTER';
  if (l === 'tab') return 'TAB';
  if (l === 'backspace') return 'BACKSPACE';
  if (l === 'delete' || l === 'del') return 'DELETE';
  if (l === 'home') return 'HOME';
  if (l === 'end') return 'END';
  if (l === 'pageup' || l === 'pgup') return 'PAGEUP';
  if (l === 'pagedown' || l === 'pgdn') return 'PAGEDOWN';
  if (l === 'left' || l === 'arrowleft') return 'LEFT';
  if (l === 'right' || l === 'arrowright') return 'RIGHT';
  if (l === 'up' || l === 'arrowup') return 'UP';
  if (l === 'down' || l === 'arrowdown') return 'DOWN';
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  if (raw.length === 1) return raw.toUpperCase();
  return raw.toUpperCase();
}

function parseAccelerator(accel) {
  const parts = String(accel || '').split('+').map((s) => s.trim()).filter(Boolean);
  const mods = { alt: false, ctrl: false, shift: false, meta: false };
  let key = '';
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === 'alt' || l === 'option' || l === 'opt') mods.alt = true;
    else if (l === 'control' || l === 'ctrl' || l === 'cmdorctrl' || l === 'commandorcontrol') mods.ctrl = true;
    else if (l === 'shift') mods.shift = true;
    else if (l === 'super' || l === 'meta' || l === 'command' || l === 'cmd' || l === 'win' || l === 'windows') mods.meta = true;
    else key = normalizeKey(p);
  }
  return { mods, key };
}

function sameCombo(a, b) {
  const pa = parseAccelerator(a);
  const pb = parseAccelerator(b);
  return pa.key === pb.key
    && pa.mods.alt === pb.mods.alt
    && pa.mods.ctrl === pb.mods.ctrl
    && pa.mods.shift === pb.mods.shift
    && pa.mods.meta === pb.mods.meta
    && !!pa.key;
}

function formatAccelerator(accel, platform) {
  const { mods, key } = parseAccelerator(accel);
  if (!key) return String(accel || '');
  const mac = platform === 'darwin';
  const parts = [];
  if (mods.ctrl) parts.push(mac ? 'Control' : 'Ctrl');
  if (mods.alt) parts.push(mac ? 'Option' : 'Alt');
  if (mods.shift) parts.push('Shift');
  if (mods.meta) parts.push(mac ? 'Cmd' : 'Win');
  let prettyKey = key;
  if (key === 'SPACE') prettyKey = 'Space';
  else if (!/^F\d+$/.test(key) && key.length > 1) {
    prettyKey = key.charAt(0) + key.slice(1).toLowerCase();
  }
  parts.push(prettyKey);
  return parts.join('+');
}

function formatCompact(accel, platform) {
  const { mods, key } = parseAccelerator(accel);
  if (!key) return '';
  const prettyKey = key === 'SPACE' ? 'Space' : key;
  if (platform === 'darwin') {
    return (mods.ctrl ? '⌃' : '') + (mods.alt ? '⌥' : '') + (mods.shift ? '⇧' : '')
      + (mods.meta ? '⌘' : '') + prettyKey;
  }
  const bits = [];
  if (mods.ctrl) bits.push('Ctrl');
  if (mods.alt) bits.push('Alt');
  if (mods.shift) bits.push('Shift');
  if (mods.meta) bits.push('Win');
  bits.push(prettyKey);
  return bits.join('+');
}

function keycodeFor(key) {
  if (!key) return null;
  const k = String(key).toUpperCase();
  if (Object.prototype.hasOwnProperty.call(UIOHOOK_KEY, k)) return UIOHOOK_KEY[k];
  return null;
}

function eventMatchesUiohook(parsed, e) {
  if (!parsed || !parsed.key || !e) return false;
  const code = keycodeFor(parsed.key);
  if (code == null || e.keycode !== code) return false;
  return !!e.altKey === !!parsed.mods.alt
    && !!e.ctrlKey === !!parsed.mods.ctrl
    && !!e.shiftKey === !!parsed.mods.shift
    && !!e.metaKey === !!parsed.mods.meta;
}

function isModifierKeycode(code) {
  return MOD_CODES.has(code);
}

function holdShouldStop(parsed, e) {
  if (!parsed || !parsed.key || !e) return false;
  const code = keycodeFor(parsed.key);
  if (code != null && e.keycode === code) return true;
  if (!isModifierKeycode(e.keycode)) return false;
  if (parsed.mods.alt && (e.keycode === 0x0038 || e.keycode === 0x0E38)) return true;
  if (parsed.mods.ctrl && (e.keycode === 0x001D || e.keycode === 0x0E1D)) return true;
  if (parsed.mods.shift && (e.keycode === 0x002A || e.keycode === 0x0036)) return true;
  if (parsed.mods.meta && (e.keycode === 0x0E5B || e.keycode === 0x0E5C)) return true;
  return false;
}

function migrateHotkeys(s) {
  const out = { ...s };
  if (!out.toggleHotkey) out.toggleHotkey = out.hotkey || TOGGLE_DEFAULT;
  if (!out.holdHotkey) out.holdHotkey = HOLD_DEFAULT;
  out.hotkey = out.toggleHotkey;
  return out;
}

function defaultHoldHotkey() { return HOLD_DEFAULT; }
function defaultToggleHotkey() { return TOGGLE_DEFAULT; }

module.exports = {
  HOLD_DEFAULT, TOGGLE_DEFAULT,
  parseAccelerator, sameCombo, formatAccelerator, formatCompact,
  keycodeFor, eventMatchesUiohook, holdShouldStop, isModifierKeycode,
  migrateHotkeys, defaultHoldHotkey, defaultToggleHotkey, normalizeKey,
};
