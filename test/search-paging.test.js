'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), path = require('path'), fs = require('fs');
const { YT } = require('../lib/yt');

test('search pages return different results, and page is clamped', async () => {
  const yt = new YT({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kq-')), bin: 'yt-dlp', mock: true });
  const p0 = await yt.search('abba', true, 0), p1 = await yt.search('abba', true, 1);
  assert.ok(p0.length && p1.length);
  const ids0 = new Set(p0.map(v => v.videoId));
  assert.ok(p1.every(v => !ids0.has(v.videoId)), 'page 2 repeats nothing from page 1');
  const big = await yt.search('abba', true, 99), five = await yt.search('abba', true, 5);
  assert.deepStrictEqual(big.map(v => v.videoId), five.map(v => v.videoId));
});
