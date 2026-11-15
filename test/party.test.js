'use strict';
// Queue engine rules, without a server, browser or YouTube: fake downloader/genres/people.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Party } = require('../lib/party');

class FakeYT extends EventEmitter {
  constructor() { super(); this.st = new Map(); this.wanted = []; this.level = true; this.streams = new Map(); }
  status(id) { return this.st.get(id) || { state: 'pending' }; }
  want(ids) { this.wanted = ids; }
  ready(id) { this.st.set(id, { state: 'ready' }); this.emit('update', id, { state: 'ready' }); }
  retry(id) { this.st.delete(id); }
  prefetch(ids) { return { queued: ids.length, ready: 0 }; }
  prune() { return 0; }
  streamUrl() { return Promise.resolve('x'); }
}
const fakeGenres = Object.assign(new EventEmitter(), { get: () => null, lookup: () => { }, setManual: () => { } });
const fakePeople = { touch: () => { }, clientsOf: () => [], newNight: () => { }, public: () => ({}), removePhoto: () => { }, setKeep: () => { }, setPreset: () => { } };

let n = 0;
const vid = () => `vid${String(++n).padStart(8, '0')}`; // 11 chars like a YouTube id
function setup(settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-test-'));
  const yt = new FakeYT();
  const p = new Party({ file: path.join(dir, 'party.json'), yt, genres: fakeGenres, people: fakePeople });
  const host = { clientId: 'host', isHost: true };
  p.act('settings', { settings: { countdown: 0, ...settings } }, host);
  const add = (singer, opts = {}) => {
    const v = { videoId: opts.videoId || vid(), title: opts.title || `${singer} song (Karaoke)`, duration: 200 };
    return p.act('add', { video: v, singer, ...opts }, opts.who || { clientId: 'c-' + singer, isHost: false });
  };
  const order = () => p.s.queue.map(i => i.singer);
  const cleanup = () => { p._clearTimer(); clearTimeout(p.saveTimer); clearTimeout(p.emitTimer); fs.rmSync(dir, { recursive: true, force: true }); };
  return { p, yt, host, add, order, cleanup, dir };
}

test('fair rotation: everyone gets one before anyone gets two', t => {
  const { add, order, cleanup } = setup();
  t.after(cleanup);
  add('Ann'); add('Ann'); add('Ann'); add('Bob'); add('Cat'); add('Bob');
  assert.deepEqual(order(), ['Ann', 'Bob', 'Cat', 'Ann', 'Bob', 'Ann']);
});

test('fair rotation off: plain first come, first served', t => {
  const { add, order, cleanup } = setup({ fair: false });
  t.after(cleanup);
  add('Ann'); add('Ann'); add('Bob');
  assert.deepEqual(order(), ['Ann', 'Ann', 'Bob']);
});

test('same song twice is caught, and can be forced', t => {
  const { add, cleanup } = setup();
  t.after(cleanup);
  const v = vid();
  assert.equal(add('Ann', { videoId: v }).ok, true);
  const again = add('Bob', { videoId: v });
  assert.equal(again.ok, false); assert.ok(again.dup);
  assert.equal(add('Bob', { videoId: v, force: true }).ok, true);
});

test('per-person limit counts songs waiting, not songs for the night; hosts are exempt', t => {
  const { p, add, host, cleanup } = setup({ maxPerPerson: 2 });
  t.after(cleanup);
  assert.equal(add('Ann').ok, true);
  assert.equal(add('Ann').ok, true);
  assert.equal(add('Ann').ok, false, 'third waiting song is refused');
  assert.equal(add('Ann', { who: host }).ok, true, 'host can still add');
  p.act('remove', { id: p.s.queue.find(i => i.singer === 'Ann').id }, host);
  p.act('remove', { id: p.s.queue.find(i => i.singer === 'Ann').id }, host);
  assert.equal(add('Ann').ok, true, 'a slot opened up again');
});

test('a song starts when its download is ready, and finishing records it', async t => {
  const { p, yt, add, cleanup } = setup();
  t.after(cleanup);
  const v = vid();
  add('Ann', { videoId: v });
  p.act('startNow', {}, { clientId: 'host', isHost: true });
  assert.notEqual(p.s.phase, 'playing', 'not yet downloaded');
  yt.ready(v);
  p.act('startNow', {}, { clientId: 'host', isHost: true });
  assert.equal(p.s.phase, 'playing');
  assert.equal(p.s.current.singer, 'Ann');
  p.ended(p.s.current.id);
  assert.equal(p.s.history[0].singer, 'Ann');
  assert.equal(p.s.history[0].skipped, false);
  assert.equal(p.stats().find(s => s.singer === 'Ann').sung, 1);
});

test('skipped songs do not count as sung', t => {
  const { p, yt, add, host, cleanup } = setup();
  t.after(cleanup);
  const v = vid(); add('Ann', { videoId: v }); yt.ready(v);
  p.act('startNow', {}, host);
  p.act('skip', {}, host);
  assert.equal(p.s.history[0].skipped, true);
  assert.ok(!(p.stats().find(s => s.singer === 'Ann') || {}).sung);
});

test('"not here" (hold) keeps the song out of rotation; "back" returns it', t => {
  const { p, add, order, host, cleanup } = setup();
  t.after(cleanup);
  add('Ann'); add('Bob'); add('Cat');
  const ann = p.s.queue[0];
  assert.equal(p.act('hold', { id: ann.id }, host).ok, true);
  assert.deepEqual(order(), ['Bob', 'Cat']);
  assert.equal(p.s.held[0].singer, 'Ann');
  assert.equal(p.act('back', { id: ann.id }, host).ok, true);
  assert.ok(order().includes('Ann'));
  assert.equal(p.s.held.length, 0);
});

test('defer pushes a song back without losing it', t => {
  const { p, add, order, host, cleanup } = setup();
  t.after(cleanup);
  add('Ann'); add('Bob'); add('Cat');
  p.act('defer', { id: p.s.queue[0].id }, host);
  assert.notEqual(order()[0], 'Ann');
  assert.ok(order().includes('Ann'));
  assert.equal(order().length, 3);
});

test('undo brings back a removed song', t => {
  const { p, add, host, cleanup } = setup();
  t.after(cleanup);
  add('Ann'); add('Bob');
  const id = p.s.queue[1].id;
  p.act('remove', { id }, host);
  assert.equal(p.s.queue.length, 1);
  assert.equal(p.act('undo', {}, host).ok, true);
  assert.equal(p.s.queue.length, 2);
});

test('guests can only change their own songs; hosts can change any', t => {
  const { p, add, host, cleanup } = setup({ hostMode: 'hosted' });
  t.after(cleanup);
  add('Ann', { who: { clientId: 'ann-phone', isHost: false } });
  const id = p.s.queue[0].id;
  assert.equal(p.act('remove', { id }, { clientId: 'someone-else', isHost: false }).ok, false);
  assert.equal(p.act('remove', { id }, host).ok, true);
});

test('key change is clamped to ±7 semitones', t => {
  const { p, yt, add, host, cleanup } = setup();
  t.after(cleanup);
  const v = vid(); add('Ann', { videoId: v }); yt.ready(v);
  p.act('startNow', {}, host);
  p.act('key', { value: 12 }, host);
  assert.equal(p.s.current.key, 7);
  p.act('key', { value: -30 }, host);
  assert.equal(p.s.current.key, -7);
});

test('settings are sanitised (no junk values get through)', t => {
  const { p, host, cleanup } = setup();
  t.after(cleanup);
  p.act('settings', { settings: { countdown: 9999, cacheGB: -5, mic: { on: true, reverb: 99, vol: ['x', 0.5] } } }, host);
  assert.equal(p.s.settings.countdown, 120);
  assert.equal(p.s.settings.cacheGB, 1);
  assert.equal(p.s.settings.mic.on, true);
  assert.equal(p.s.settings.mic.reverb, 1.5);
  assert.deepEqual(p.s.settings.mic.vol, [0.8, 0.5]);
});

test('guests cannot change settings when a host is in charge', t => {
  const { p, cleanup } = setup({ hostMode: 'hosted' });
  t.after(cleanup);
  p.s.hosts = ['host'];
  const r = p.act('settings', { settings: { countdown: 60 } }, { clientId: 'guest', isHost: false });
  assert.equal(r.ok, false);
  assert.notEqual(p.s.settings.countdown, 60);
});

test('queue survives a restart (saved to disk and loaded back)', t => {
  const { p, add, dir, yt, cleanup } = setup();
  t.after(cleanup);
  add('Ann'); add('Bob');
  p.flush();
  const p2 = new Party({ file: path.join(dir, 'party.json'), yt, genres: fakeGenres, people: fakePeople });
  t.after(() => { p2._clearTimer(); clearTimeout(p2.saveTimer); clearTimeout(p2.emitTimer); });
  assert.deepEqual(p2.s.queue.map(i => i.singer), ['Ann', 'Bob']);
});

test('a corrupted save file does not stop the party from starting', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kq-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'party.json'), '{ this is not json');
  const p = new Party({ file: path.join(dir, 'party.json'), yt: new FakeYT(), genres: fakeGenres, people: fakePeople });
  t.after(() => { p._clearTimer(); clearTimeout(p.saveTimer); clearTimeout(p.emitTimer); });
  assert.deepEqual(p.s.queue, []);
});

test('unknown actions are refused, not crashed on', t => {
  const { p, host, cleanup } = setup();
  t.after(cleanup);
  const r = p.act('definitely-not-an-action', {}, host);
  assert.equal(r.ok, false);
});

test('stats, awards and the night in numbers add up', t => {
  const { p, yt, add, host, cleanup } = setup();
  t.after(cleanup);
  for (const who of ['Ann', 'Bob', 'Ann']) {
    const v = vid(); add(who, { videoId: v }); yt.ready(v);
  }
  for (let i = 0; i < 3; i++) {
    p.act('startNow', {}, host);
    assert.equal(p.s.phase, 'playing');
    p.react(); p.react();
    p.ended(p.s.current.id);
  }
  assert.deepEqual(p.stats().map(s => [s.singer, s.sung]), [['Ann', 2], ['Bob', 1]]);
  const night = p.nightStats();
  assert.equal(night.songs, 3); assert.equal(night.singers, 2); assert.equal(night.reacts, 6);
  const aw = p.awards();
  assert.ok(aw.find(a => a.title === 'Mic Hog' && a.name === 'Ann'));
  assert.ok(aw.find(a => a.title === 'Opening Act'));
  // the permanent log feeds house favourites and personal stats
  assert.equal(p.personalStats('ann').songs, 2);
  assert.equal(p.houseFaves().length, 3);
});
