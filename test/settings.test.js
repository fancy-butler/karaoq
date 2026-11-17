'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applySettings } = require('../lib/settings');
const base = { countdown: 15, fair: true, theme: 'neon', cacheGB: 5, maxPerPerson: 0, mic: { on: false, vol: [0.8, 0.8], reverb: 0.25, echo: 0.1, master: 0.9 } };

test('valid values are applied, junk is ignored or clamped', () => {
  const s = applySettings(base, { countdown: '30', fair: 0, theme: 'hacker', maxPerPerson: 99, cacheGB: 'lots' }, base);
  assert.equal(s.countdown, 30); assert.equal(s.fair, false); assert.equal(s.theme, 'neon'); assert.equal(s.maxPerPerson, 10); assert.equal(s.cacheGB, 5);
});
test('mic settings merge and clamp', () => {
  const s = applySettings(base, { mic: { on: 1, echo: -3, vol: [2] } }, base);
  assert.deepEqual(s.mic, { on: true, fxOnly: false, vol: [2, 0.8, 0.8, 0.8], reverb: 0.25, echo: 0, master: 0.9 });
});
test('nothing / garbage in → nothing changes', () => {
  assert.deepEqual(applySettings(base, null, base), base);
  assert.deepEqual(applySettings(base, 'lol', base), base);
});
