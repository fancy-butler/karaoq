'use strict';
// The queue engine. Single source of truth for who's singing, who's next, and who stepped out.
// Every change is saved to disk, so a crash, a refresh or a restart never loses anyone's spot.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DEFAULTS = { countdown: 15, fair: true, showQr: true, showNext: true, cacheGB: 5 };
const NEW_NIGHT_GAP = 6 * 3600 * 1000; // idle this long → counts reset for a new night
const norm = s => String(s || '').trim().toLowerCase();
const clampKey = k => Math.max(-7, Math.min(7, Math.round(Number(k) || 0)));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));

class Party extends EventEmitter {
  constructor({ file, yt }) {
    super();
    this.file = file;
    this.yt = yt;
    this.s = {
      phase: 'idle',          // idle | upnext | playing | paused
      current: null,          // item being sung
      upnextId: null,         // id of queue[0] while it's being called up
      countdownEndsAt: null,  // epoch ms; null during upnext = wait for a manual start
      queue: [],
      held: [],               // "stepped out" — keeps their song, out of the rotation until they're back
      history: [],
      settings: { ...DEFAULTS },
      nightStartedAt: Date.now(),
    };
    this.undoStack = [];
    this.favFile = path.join(path.dirname(file), 'favourites.json');
    this.faves = {};   // normName -> { name, songs: [{videoId,title,channel,duration,thumb,key}] }
    try { this.faves = JSON.parse(fs.readFileSync(this.favFile, 'utf8')); } catch { }
    this.timer = null;
    this.saveTimer = null;
    this.emitTimer = null;
    this.lastEmit = 0;
    this._load();
    yt.on('update', (videoId, dl) => this._onDl(videoId, dl));
    this.pruneCache();
    this._refresh();
  }

  // ---------- persistence ----------
  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.s.queue = Array.isArray(d.queue) ? d.queue : [];
      this.s.held = Array.isArray(d.held) ? d.held : [];
      this.s.history = Array.isArray(d.history) ? d.history.slice(0, 200) : [];
      this.s.settings = { ...DEFAULTS, ...(d.settings || {}) };
      this.s.nightStartedAt = d.nightStartedAt || Date.now();
      const last = Math.max(d.savedAt || 0, ...(this.s.history.map(h => h.endedAt || 0)));
      this.s.leftovers = d.leftovers || null;
      if (Date.now() - last > NEW_NIGHT_GAP) {
        // New night: start with an empty queue, but park last time's songs so they can be restored with one tap.
        this.s.nightStartedAt = Date.now();
        const left = [...this.s.queue, ...this.s.held];
        if (left.length) this.s.leftovers = { songs: left, from: last };
        this.s.queue = []; this.s.held = [];
      }
      // Server died mid-song? That singer goes back to the front — they didn't get their turn.
      if (d.current) this.s.queue.unshift(d.current);
    } catch { /* fresh party */ }
    for (const it of [...this.s.queue, ...this.s.held]) it.dl = this.yt.status(it.videoId);
  }

  _persist() {
    const { queue, held, history, settings, current, nightStartedAt, leftovers } = this.s;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ queue, held, history, settings, current, nightStartedAt, leftovers, savedAt: Date.now() }, null, 1));
    fs.renameSync(tmp, this.file);
  }

  _save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { try { this._persist(); } catch (e) { console.error('save failed:', e.message); } }, 250);
  }

  _saveFaves() {
    try {
      fs.mkdirSync(path.dirname(this.favFile), { recursive: true });
      fs.writeFileSync(this.favFile + '.tmp', JSON.stringify(this.faves, null, 1));
      fs.renameSync(this.favFile + '.tmp', this.favFile);
    } catch (e) { console.error('favourites save failed:', e.message); }
  }

  flush() { clearTimeout(this.saveTimer); try { this._persist(); } catch (e) { console.error('save failed:', e.message); } }

  // ---------- broadcasting ----------
  _emit() {
    if (this.emitTimer) return;
    const wait = Math.max(0, 150 - (Date.now() - this.lastEmit));
    this.emitTimer = setTimeout(() => { this.emitTimer = null; this.lastEmit = Date.now(); this.emit('change'); }, wait);
  }

  // Songs actually sung tonight (skips don't count), per singer, most first.
  stats() {
    const by = new Map();
    for (const h of this.s.history) {
      if (h.endedAt < this.s.nightStartedAt || h.skipped) continue;
      for (const name of [h.singer, h.with].filter(Boolean)) {
        const k = norm(name);
        const e = by.get(k) || { singer: name, sung: 0 };
        e.sung++; by.set(k, e);
      }
    }
    return [...by.values()].sort((a, b) => b.sung - a.sung || a.singer.localeCompare(b.singer));
  }

  publicState() {
    const { history, ...rest } = this.s;
    return { ...rest, history: history.filter(h => h.endedAt >= this.s.nightStartedAt).slice(0, 50), stats: this.stats(), faves: this.faves, cacheBytes: this.cacheBytes || 0, leftovers: rest.leftovers ? { count: rest.leftovers.songs.length, from: rest.leftovers.from } : null };
  }

  // ---------- the state machine ----------
  _clearTimer() { clearTimeout(this.timer); this.timer = null; }

  _callUp(item) {
    const s = this.s;
    s.phase = 'upnext';
    s.upnextId = item.id;
    const c = s.settings.countdown;
    s.countdownEndsAt = c > 0 ? Date.now() + c * 1000 : null;
    this._clearTimer();
    if (c > 0) this.timer = setTimeout(() => this._refresh(), c * 1000 + 30);
    this.emit('cmd', { cmd: 'chime' });
  }

  _tryStart() {
    const s = this.s;
    if (s.phase !== 'upnext') return;
    const head = s.queue[0];
    if (!head || s.countdownEndsAt === null || Date.now() < s.countdownEndsAt - 60) return;
    if (!head.dl || head.dl.state !== 'ready') return; // still downloading: start the moment it lands
    s.queue.shift();
    s.current = { ...head, startedAt: Date.now() };
    s.phase = 'playing';
    s.upnextId = null;
    s.countdownEndsAt = null;
    this._clearTimer();
  }

  // Reconcile after any change: who's being called up, can we start, what to prefetch, save, broadcast.
  _refresh() {
    const s = this.s;
    if (s.phase === 'idle' || s.phase === 'upnext') {
      const head = s.queue[0];
      if (!head) { s.phase = 'idle'; s.upnextId = null; s.countdownEndsAt = null; this._clearTimer(); }
      else if (s.phase === 'idle' || s.upnextId !== head.id) this._callUp(head); // new person at the top → fresh countdown
    }
    this._tryStart();
    this.yt.want([s.current && s.current.videoId, ...s.queue.map(i => i.videoId), ...s.held.map(i => i.videoId)].filter(Boolean));
    this._save();
    this._emit();
  }

  // Keep the song cache under the size cap. Queue/held/current songs are protected.
  pruneCache() {
    try {
      const protect = [this.s.current && this.s.current.videoId, ...this.s.queue.map(i => i.videoId), ...this.s.held.map(i => i.videoId), ...((this.s.leftovers && this.s.leftovers.songs) || []).map(i => i.videoId)];
      this.cacheBytes = this.yt.prune(this.s.settings.cacheGB * 1e9, protect);
    } catch (e) { console.error('cache cleanup failed:', e.message); }
  }

  _onDl(videoId, dl) {
    let hit = false;
    for (const it of [this.s.current, ...this.s.queue, ...this.s.held]) {
      if (it && it.videoId === videoId) { it.dl = dl; hit = true; }
    }
    if (!hit) return;
    if (dl.state === 'ready') this.pruneCache();
    if (dl.state === 'ready' || dl.state === 'error') this._refresh();
    else this._emit();
  }

  _finish(skipped, error) {
    const s = this.s;
    if (!s.current) return;
    const { dl, ...rest } = s.current;
    s.history.unshift({ ...rest, endedAt: Date.now(), skipped: !!skipped, error: error || undefined });
    if (s.history.length > 200) s.history.length = 200;
    s.current = null;
    s.phase = 'idle';
    this._refresh();
  }

  ended(itemId) { if (this.s.current && this.s.current.id === itemId) this._finish(false); }
  playerError(itemId, msg) { if (this.s.current && this.s.current.id === itemId) this._finish(true, String(msg || 'playback error').slice(0, 200)); }

  // ---------- fair rotation ----------
  // Round of each queued item = how many songs that singer already has ahead of it (counting the one on stage).
  _rounds() {
    const counts = {};
    if (this.s.current) counts[norm(this.s.current.singer)] = 1;
    return this.s.queue.map(it => { const k = norm(it.singer); const r = counts[k] || 0; counts[k] = r + 1; return r; });
  }

  // Where a new song goes: end of the first round this singer doesn't already have a song in.
  _fairIndex(singer) {
    const k = norm(singer);
    let mine = this.s.current && norm(this.s.current.singer) === k ? 1 : 0;
    mine += this.s.queue.filter(i => norm(i.singer) === k).length;
    const rounds = this._rounds();
    let last = -1;
    rounds.forEach((r, i) => { if (r <= mine) last = i; });
    return Math.max(last + 1, this._floor());
  }

  // Nothing jumps in front of the person currently being called up.
  _floor() { return this.s.phase === 'upnext' && this.s.queue.length ? 1 : 0; }

  _snap() {
    this.undoStack.push(JSON.stringify({ queue: this.s.queue, held: this.s.held }));
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  // ---------- actions (from phones / stage) ----------
  act(action, m, who) {
    const s = this.s;
    const host = !!who.isHost;
    const deny = { ok: false, error: 'Only the host can do that' };
    const mine = it => it && it.clientId && it.clientId === who.clientId;
    const inQueue = id => { const i = s.queue.findIndex(x => x.id === id); return i < 0 ? null : { i, item: s.queue[i] }; };
    const inHeld = id => { const i = s.held.findIndex(x => x.id === id); return i < 0 ? null : { i, item: s.held[i] }; };
    const notFound = { ok: false, error: "That song isn't in the queue anymore" };
    let result = { ok: true };

    switch (action) {
      case 'add': {
        const v = m.video || {};
        if (!/^[\w-]{11}$/.test(v.videoId || '')) return { ok: false, error: 'Bad video' };
        const singer = String(m.singer || '').trim().slice(0, 40);
        if (!singer) return { ok: false, error: 'Who is singing? Set a name first' };
        const partner = String(m.with || '').trim().slice(0, 40);
        const fav = (this.faves[norm(singer)]?.songs || []).find(f => f.videoId === v.videoId);
        this._snap();
        const item = {
          id: uid(), videoId: v.videoId,
          title: String(v.title || 'Untitled').slice(0, 200), channel: String(v.channel || '').slice(0, 100),
          duration: Number(v.duration) || null, thumb: String(v.thumb || '').slice(0, 300),
          singer, with: partner && norm(partner) !== norm(singer) ? partner : undefined,
          key: clampKey(m.key !== undefined ? m.key : fav ? fav.key : 0),
          clientId: who.clientId || null, addedAt: Date.now(), deferred: 0, dl: this.yt.status(v.videoId),
        };
        const idx = s.settings.fair ? this._fairIndex(singer) : s.queue.length;
        s.queue.splice(idx, 0, item);
        result = { ok: true, position: idx + 1, id: item.id };
        break;
      }
      case 'remove': {
        const f = inQueue(m.id) || inHeld(m.id);
        if (!f) return notFound;
        if (!host && !mine(f.item)) return deny;
        this._snap();
        (inQueue(m.id) ? s.queue : s.held).splice(f.i, 1);
        break;
      }
      case 'move': {
        if (!host) return deny;
        const f = inQueue(m.id); if (!f) return notFound;
        const to = Math.max(0, Math.min(s.queue.length - 1, Number(m.to) | 0));
        if (to === f.i) return result;
        this._snap();
        s.queue.splice(f.i, 1); s.queue.splice(to, 0, f.item);
        break;
      }
      case 'playNext': {
        if (!host) return deny;
        const f = inQueue(m.id); if (!f) return notFound;
        this._snap();
        s.queue.splice(f.i, 1); s.queue.splice(Math.min(this._floor(), s.queue.length), 0, f.item);
        break;
      }
      case 'defer': { // "Not here" — swap back one spot. Keeps their place in line, just lets the next person go.
        const f = inQueue(m.id || s.upnextId); if (!f) return notFound;
        if (!host && !mine(f.item)) return deny;
        if (f.i >= s.queue.length - 1) return { ok: false, error: "Nobody behind them to swap with — use Stepped out instead" };
        this._snap();
        s.queue.splice(f.i, 1); s.queue.splice(f.i + 1, 0, f.item);
        f.item.deferred = (f.item.deferred || 0) + 1;
        break;
      }
      case 'hold': { // "Stepped out" — off the rotation, song kept, one tap to bring them back
        const f = inQueue(m.id || s.upnextId); if (!f) return notFound;
        if (!host && !mine(f.item)) return deny;
        this._snap();
        s.queue.splice(f.i, 1);
        f.item.heldAt = Date.now();
        s.held.push(f.item);
        break;
      }
      case 'back': { // They're back: slot them in right after whoever is being called now
        const f = inHeld(m.id); if (!f) return notFound;
        if (!host && !mine(f.item)) return deny;
        this._snap();
        s.held.splice(f.i, 1);
        delete f.item.heldAt;
        f.item.deferred = 0;
        s.queue.splice(Math.min(this._floor(), s.queue.length), 0, f.item);
        break;
      }
      case 'shuffle': { // Shuffle, but keep it fair: everyone's first song before anyone's second
        if (!host) return deny;
        this._snap();
        const start = this._floor();
        const head = s.queue.slice(0, start), rest = s.queue.slice(start);
        for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
        s.queue = head.concat(rest);
        if (s.settings.fair) {
          const r = this._rounds();
          const tail = s.queue.slice(start).map((it, i) => ({ it, r: r[start + i], i }));
          tail.sort((a, b) => a.r - b.r || a.i - b.i);
          s.queue = head.concat(tail.map(x => x.it));
        }
        break;
      }
      case 'startNow': {
        if (!host) return deny;
        if (s.phase !== 'upnext') return { ok: false, error: 'Nobody is up' };
        s.countdownEndsAt = Date.now();
        this._clearTimer();
        if (s.queue[0] && s.queue[0].dl.state !== 'ready') result = { ok: true, note: 'Starts as soon as the download finishes' };
        break;
      }
      case 'skip': {
        if (!host && !mine(s.current)) return deny;
        if (!s.current) return { ok: false, error: 'Nothing playing' };
        this._finish(true);
        return result;
      }
      case 'pause': if (!host) return deny; if (s.phase === 'playing') s.phase = 'paused'; break;
      case 'resume': if (!host) return deny; if (s.phase === 'paused') s.phase = 'playing'; break;
      case 'restart': if (!host) return deny; this.emit('cmd', { cmd: 'restart' }); return result;
      case 'retry': {
        const f = inQueue(m.id) || inHeld(m.id); if (!f) return notFound;
        this.yt.retry(f.item.videoId);
        return result;
      }
      case 'undo': {
        if (!host) return deny;
        const prev = this.undoStack.pop();
        if (!prev) return { ok: false, error: 'Nothing to undo' };
        const d = JSON.parse(prev);
        const curId = s.current && s.current.id;
        const fix = list => list.filter(i => i.id !== curId).map(i => ({ ...i, dl: this.yt.status(i.videoId) }));
        s.queue = fix(d.queue); s.held = fix(d.held);
        break;
      }
      case 'settings': {
        if (!host) return deny;
        const st = m.settings || {};
        if (st.countdown !== undefined) s.settings.countdown = Math.max(0, Math.min(120, Number(st.countdown) | 0));
        if (st.fair !== undefined) s.settings.fair = !!st.fair;
        if (st.showQr !== undefined) s.settings.showQr = !!st.showQr;
        if (st.showNext !== undefined) s.settings.showNext = !!st.showNext;
        if (st.cacheGB !== undefined) { s.settings.cacheGB = Math.max(1, Math.min(200, Number(st.cacheGB) || 5)); this.pruneCache(); }
        break;
      }
      case 'key': { // transpose: the song on stage, or a queued one
        const target = m.id ? (inQueue(m.id) || inHeld(m.id) || {}).item : s.current;
        if (!target) return notFound;
        if (!host && !mine(target)) return deny;
        target.key = clampKey(m.value !== undefined ? m.value : (target.key || 0) + (Number(m.delta) || 0));
        // remember the key on this singer's favourite, if it's starred
        const f = (this.faves[norm(target.singer)]?.songs || []).find(x => x.videoId === target.videoId);
        if (f) { f.key = target.key; this._saveFaves(); }
        result = { ok: true, key: target.key };
        break;
      }
      case 'fave': { // star / unstar a song for a singer (kept across nights)
        const v = m.video || {};
        const name = String(m.singer || '').trim().slice(0, 40);
        if (!name || !/^[\w-]{11}$/.test(v.videoId || '')) return { ok: false, error: 'Need a singer and a song' };
        const k = norm(name);
        const entry = this.faves[k] || (this.faves[k] = { name, songs: [] });
        const i = entry.songs.findIndex(x => x.videoId === v.videoId);
        if (m.on === false || (m.on === undefined && i >= 0)) { if (i >= 0) entry.songs.splice(i, 1); result = { ok: true, on: false }; }
        else if (i < 0) {
          entry.songs.unshift({ videoId: v.videoId, title: String(v.title || '').slice(0, 200), channel: String(v.channel || '').slice(0, 100), duration: Number(v.duration) || null, thumb: String(v.thumb || '').slice(0, 300), key: clampKey(v.key) });
          entry.songs.length = Math.min(entry.songs.length, 100);
          result = { ok: true, on: true };
        } else result = { ok: true, on: true };
        if (!entry.songs.length) delete this.faves[k];
        this._saveFaves();
        break;
      }
      case 'duet': { // add / change / clear a duet partner on a queued song
        const f = inQueue(m.id) || inHeld(m.id); if (!f) return notFound;
        if (!host && !mine(f.item)) return deny;
        const partner = String(m.with || '').trim().slice(0, 40);
        f.item.with = partner && norm(partner) !== norm(f.item.singer) ? partner : undefined;
        break;
      }
      case 'leftovers': { // restore or clear last time's queue
        if (!host) return deny;
        const lo = s.leftovers; if (!lo) return { ok: false, error: 'Nothing left over' };
        if (m.restore) { this._snap(); for (const it of lo.songs) { it.dl = this.yt.status(it.videoId); it.deferred = 0; delete it.heldAt; s.queue.push(it); } }
        s.leftovers = null;
        result = { ok: true, count: m.restore ? lo.songs.length : 0 };
        break;
      }
      case 'newNight': {
        if (!host) return deny;
        s.nightStartedAt = Date.now();
        break;
      }
      default:
        return { ok: false, error: `Unknown action: ${action}` };
    }
    this._refresh();
    return result;
  }
}

module.exports = { Party };
