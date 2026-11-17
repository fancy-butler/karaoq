'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applySettings, THEMES } = require('../lib/settings');

test('new skins are accepted, junk themes ignored', () => {
  for (const t of ['hall', 'laser', 'diner', 'amp', 'rhythm']) assert.ok(THEMES.includes(t));
  assert.strictEqual(applySettings({ theme: 'neon' }, { theme: 'amp' }).theme, 'amp');
  assert.strictEqual(applySettings({ theme: 'neon' }, { theme: 'nope' }).theme, 'neon');
});

test('dance-stage arrow speed only takes known values', () => {
  assert.strictEqual(applySettings({ stepSpeed: 'random' }, { stepSpeed: 'fast' }).stepSpeed, 'fast');
  assert.strictEqual(applySettings({ stepSpeed: 'random' }, { stepSpeed: 'ludicrous' }).stepSpeed, 'random');
});

test('lyrics-safe layout is a plain on/off', () => {
  assert.strictEqual(applySettings({ safeLayout: true }, { safeLayout: 0 }).safeLayout, false);
});
