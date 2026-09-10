'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAccelerator, sameCombo, formatAccelerator, formatCompact, keycodeFor,
  eventMatchesUiohook, holdShouldStop, migrateHotkeys, normalizeKey,
  HOLD_DEFAULT, TOGGLE_DEFAULT,
} = require('./hotkeys');

test('default hold is Alt+X and toggle is Alt+Z', () => {
  assert.equal(HOLD_DEFAULT, 'Alt+X');
  assert.equal(TOGGLE_DEFAULT, 'Alt+Z');
});

test('parseAccelerator reads Option as Alt and letters', () => {
  const p = parseAccelerator('Option+X');
  assert.equal(p.key, 'X');
  assert.equal(p.mods.alt, true);
  assert.equal(p.mods.ctrl, false);
  assert.deepEqual(parseAccelerator('Control+Shift+Space').mods, {
    alt: false, ctrl: true, shift: true, meta: false,
  });
  assert.equal(parseAccelerator('Control+Shift+Space').key, 'SPACE');
});

test('sameCombo treats Option+X and Alt+X as equal', () => {
  assert.equal(sameCombo('Alt+X', 'Option+X'), true);
  assert.equal(sameCombo('Alt+X', 'Alt+Z'), false);
  assert.equal(sameCombo('Command+Shift+F13', 'Cmd+Shift+F13'), true);
});

test('formatAccelerator uses Option on macOS and Alt on Windows', () => {
  assert.equal(formatAccelerator('Alt+X', 'darwin'), 'Option+X');
  assert.equal(formatAccelerator('Alt+X', 'win32'), 'Alt+X');
});

test('formatCompact uses glyphs on macOS and words on Windows', () => {
  assert.equal(formatCompact('Alt+X', 'darwin'), '⌥X');
  assert.equal(formatCompact('Alt+Z', 'win32'), 'Alt+Z');
  assert.equal(formatCompact('Control+Shift+Space', 'darwin'), '⌃⇧Space');
});

test('normalizeKey maps F-keys and space', () => {
  assert.equal(normalizeKey('f18'), 'F18');
  assert.equal(normalizeKey('Space'), 'SPACE');
  assert.equal(normalizeKey('x'), 'X');
});

test('uiohook match: Alt+X keydown with matching modifiers', () => {
  const parsed = parseAccelerator('Alt+X');
  const x = keycodeFor('X');
  assert.ok(x);
  assert.equal(eventMatchesUiohook(parsed, { keycode: x, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }), true);
  assert.equal(eventMatchesUiohook(parsed, { keycode: x, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false }), false);
  assert.equal(eventMatchesUiohook(parsed, { keycode: keycodeFor('Z'), altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }), false);
});

test('holdShouldStop on main key or Alt release', () => {
  const parsed = parseAccelerator('Alt+X');
  assert.equal(holdShouldStop(parsed, { keycode: keycodeFor('X') }), true);
  assert.equal(holdShouldStop(parsed, { keycode: 0x0038 }), true); // Alt
  assert.equal(holdShouldStop(parsed, { keycode: keycodeFor('Z') }), false);
});

test('migrateHotkeys copies legacy hotkey onto toggleHotkey', () => {
  const s = migrateHotkeys({ hotkey: 'Alt+Q' });
  assert.equal(s.toggleHotkey, 'Alt+Q');
  assert.equal(s.holdHotkey, 'Alt+X');
  assert.equal(s.hotkey, 'Alt+Q');
});
