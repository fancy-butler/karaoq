'use strict';
// The queue engine. Single source of truth for who's singing, who's next, and who stepped out.
// Every change is saved to disk, so a crash, a refresh or a restart never loses anyone's spot.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { applySettings } = require('./settings');
const stats = require('./stats');

const DEFAULTS = { countdown: 15, fair: true, showQr: true, showNext: true, cacheGB: 5, genreRows: true, hostMode: 'open', maxPerPerson: 0, levelVolume: true, oledCare: true, introCard: true, theme: 'neon', streamFirst: true, lyricsWarn: true, autoLyrics: true,
  mic: { on: false, vol: [0.8, 0.8, 0.8, 0.8], reverb: 0.25, echo: 0.1, master: 0.9 } };
// titles that look like karaoke / lyric videos (anything else probably has vocals and no words on screen)
const KARAOKE_RE = /karaoke|instrumental|lyrics?|backing track|minus ?one|off ?vocal|sing ?a?long|videoke|piano version|no vocals?/i;
// Idle this long (closed, or open with nothing happening) → a new night: fresh queue + counts,
// last night's songs parked as leftovers. KQ_NIGHT_GAP_MIN overrides it for testing.
const NEW_NIGHT_GAP = (Number(process.env.KQ_NIGHT_GAP_MIN) || 360) * 60 * 1000;
const norm = s => String(s || '').trim().toLowerCase();
const clampKey = k => Math.max(-7, Math.min(7, Math.round(Number(k) || 0)));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));

class Party extends EventEmitter {
  constructor({ file, yt, genres, people, vocals, lyrics }) {
    super();
    this.vocals = vocals || null;
    this.lyrics = lyrics || null;
    this.file = file;
    this.yt = yt;
    this.genres = genres;
    this.people = people;
    this.sungLog = path.join(path.dirname(file), 'sung.jsonl');
    this.s = {
      phase: 'idle',          // idle | upnext | playing | paused
      current: null,          // item being sung
      upnextId: null,         // id of queue[0] while it's being called up
      countdownEndsAt: null,  // epoch ms; null during upnext = wait for a manual start
      queue: [],
      held: [],               // "stepped out" — keeps their song, out of the rotation until they're back
      history: [],
      settings: { ...DEFAULTS },
      hosts: [],            // phone IDs with host rights when hostMode is 'hosted'
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
    // Opening KARAO-Q with songs still waiting from last time: don't start a countdown straight away —
    // people are still finding the remote. The first song waits for a Start (Enter / ▶ on a phone).
    this.s.resumeHold = this.s.queue.length > 0;
    yt.on('update', (videoId, dl) => this._onDl(videoId, dl));
    if (this.lyrics) this.lyrics.on('update', (videoId, st) => {
      let hit = false;
      for (const it of [this.s.current, ...this.s.queue, ...this.s.held]) if (it && it.videoId === videoId && it.lyr) { it.lyr = st; hit = true; }
      if (hit) this._emit();
    });
    if (this.vocals) this.vocals.on('update', (videoId, nv) => {
      let hit = false;
      for (const it of [this.s.current, ...this.s.queue, ...this.s.held]) if (it && it.videoId === videoId && it.novox) { it.nv = nv; hit = true; }
      if (!hit) return;
      if (nv.state === 'ready' || nv.state === 'error') this._refresh(); else this._emit();
    });
    if (genres) {
      genres.on('update', (videoId, g) => this._onGenre(videoId, g));
      for (const it of [...this.s.queue, ...this.s.held]) { Object.assign(it, genres.get(it.videoId)); genres.lookup(it); }
    }
    this.yt.level = this.s.settings.levelVolume !== false;
    this.pruneCache();
    // Left running overnight? Roll over once nothing has happened for the gap.
    setInterval(() => {
      if (Date.now() - (this.lastActivity || Date.now()) > NEW_NIGHT_GAP && (this.s.queue.length || this.s.held.length || this.s.current || this.stats().length)) {
        console.log('      New night: queue parked as leftovers, counts reset');
        this._newNight(true); this._refresh();
      }
    }, Math.min(5 * 60 * 1000, NEW_NIGHT_GAP / 4)).unref();
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
      this.s.hosts = Array.isArray(d.hosts) ? d.hosts : [];
      this.s.nightStartedAt = d.nightStartedAt || Date.now();
      this.s.leftovers = d.leftovers || null;
      // Server died mid-song? That singer goes back to the front — they didn't get their turn.
      if (d.current) this.s.queue.unshift(d.current);
      this.lastActivity = d.lastActivity || Math.max(d.savedAt || 0, ...(this.s.history.map(h => h.endedAt || 0)));
      if (Date.now() - this.lastActivity > NEW_NIGHT_GAP) this._newNight(true);
    } catch { /* fresh party */ }
    for (const it of [...this.s.queue, ...this.s.held]) it.dl = this.yt.status(it.videoId);
  }

  // Start a new night: empty queue + counts; park last night's songs as restorable leftovers.
  _newNight(parkQueue) {
    const s = this.s;
    if (parkQueue) {
      const left = [s.current, ...s.queue, ...s.held].filter(Boolean).map(({ startedAt, ...it }) => it);
      if (left.length) s.leftovers = { songs: left, from: this.lastActivity || Date.now() };
      s.queue = []; s.held = []; s.current = null;
      s.phase = 'idle'; s.upnextId = null; s.countdownEndsAt = null;
      this._clearTimer && this._clearTimer();
      this.undoStack = [];
    }
    s.nightStartedAt = Date.now();
    this.lastActivity = Date.now();
    if (this.people) this.people.newNight();
  }

  _persist() {
    const { queue, held, history, settings, current, nightStartedAt, leftovers, hosts } = this.s;
    const lastActivity = this.lastActivity;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ queue, held, history, settings, current, nightStartedAt, leftovers, hosts, lastActivity, savedAt: Date.now() }, null, 1));
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
  // numbers about tonight / all nights: see lib/stats.js
  _sungLines() { return stats.readSungLog(this.sungLog); }
  stats() { return stats.tonightBySinger(this.s); }
  react() { if (this.s.current) this.s.current.reacts = (this.s.current.reacts || 0) + 1; } // counts toward 'Crowd Favourite'
  awards() { return stats.awards(this.s); }
  nightStats() { return stats.nightStats(this.s); }
  houseFaves(limit = 12) { return stats.houseFaves(this._sungLines(), limit); }
  forYou(name) { return require('./foryou').forYou({ name, lines: this._sungLines(), nightStartedAt: this.s.nightStartedAt, queued: [this.s.current, ...this.s.queue, ...this.s.held].filter(Boolean) }); }
  personalStats(name) { return stats.personalStats(this._sungLines(), name); }
  mix() { return stats.mix(this.s); }

  // Open party: every phone on the Wi-Fi can manage. Hosted: only the host phones (and the party computer).
  isHostClient(clientId, viaNet) {
    if (this.s.settings.hostMode !== 'hosted') return !viaNet;
    return !!clientId && this.s.hosts.includes(clientId);
  }

  publicState() {
    const { history, hosts, ...rest } = this.s;
    return { ...rest, history: history.filter(h => h.endedAt >= this.s.nightStartedAt).slice(0, 50), stats: this.stats(), mix: this.mix(), faves: this.faves, awards: this.awards(), night: this.nightStats(), people: this.people ? this.people.public(this.s.settings.hostMode === 'hosted' ? hosts : []) : {}, cacheBytes: this.cacheBytes || 0, leftovers: rest.leftovers ? { count: rest.leftovers.songs.length, from: rest.leftovers.from } : null };
  }

  // ---------- the state machine ----------
  _clearTimer() { clearTimeout(this.timer); this.timer = null; }

  _callUp(item) {
    const s = this.s;
    s.phase = 'upnext';
    s.upnextId = item.id;
    const c = s.resumeHold ? 0 : s.settings.countdown;
    s.countdownEndsAt = c > 0 ? Date.now() + c * 1000 : null;
    this._clearTimer();
    if (c > 0) this.timer = setTimeout(() => this._refresh(), c * 1000 + 30);
    this.emit('cmd', { cmd: 'chime' });
    this._prepStream(item);
  }

  // 📝 look up synced lyrics for songs that need them: not karaoke videos, or vocals removed (forced = asked by hand)
  _wantLyrics(item, forced = false) {
    if (!this.lyrics || !item || String(item.videoId).startsWith('lc_')) return;
    if (!forced && (this.s.settings.autoLyrics === false || KARAOKE_RE.test(`${item.title} ${item.channel || ''}`))) return;
    item.lyr = this.lyrics.status(item.videoId) || 'looking';
    this.lyrics.find({ videoId: item.videoId, title: item.title, duration: item.duration, force: forced });
  }

  // Stream-first: while someone's being called up and their song is still downloading, get a direct stream ready
  // so the song can start on time instead of waiting for the download.
  _prepStream(item) {
    if (!this.s.settings.streamFirst || !item || String(item.videoId).startsWith('lc_') || item.streamFailed || (item.dl && item.dl.state === 'ready')) return;
    if (item.streamReady) return;
    this.yt.streamUrl(item.videoId).then(() => {
      const it = this.s.queue.find(i => i.id === item.id);
      if (it) { it.streamReady = true; this._refresh(); }
    }).catch(e => console.error(`stream prep for ${item.videoId} failed: ${e.message}`));
  }

  _tryStart() {
    const s = this.s;
    if (s.phase !== 'upnext') return;
    const head = s.queue[0];
    if (!head || s.countdownEndsAt === null || Date.now() < s.countdownEndsAt - 60) return;
    let ready = head.dl && head.dl.state === 'ready';
    // vocals removed on request: wait for the backing-track copy (if removal failed, the original plays)
    if (ready && head.novox && this.vocals && !(head.nv && ['ready', 'error'].includes(head.nv.state))) return;
    // (nearly-finished downloads get a moment longer: the downloaded copy has levelled volume and better quality)
    const stream = !ready && !head.novox && s.settings.streamFirst && head.streamReady && !head.streamFailed && !(head.dl && head.dl.state === 'error') && !(head.dl && head.dl.state === 'downloading' && head.dl.pct >= 85);
    if (!ready && !stream) { this._prepStream(head); return; } // still downloading: start the moment it lands (or a stream is ready)
    s.queue.shift();
    const { streamReady: _sr, ...h } = head;
    s.current = { ...h, startedAt: Date.now(), stream: stream || undefined };
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
    if (this.vocals) this.vocals.want([s.current, ...s.queue, ...s.held].filter(i => i && i.novox && i.dl && i.dl.state === 'ready').map(i => i.videoId));
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

  _onGenre(videoId, g) {
    let hit = false;
    for (const it of [this.s.current, ...this.s.queue, ...this.s.held, ...this.s.history]) {
      if (it && it.videoId === videoId) { it.genre = g.genre; it.year = g.year; hit = true; }
    }
    if (hit) { this._save(); this._emit(); }
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
    const { dl: _dl, ...rest } = s.current;
    const entry = { ...rest, endedAt: Date.now(), skipped: !!skipped, error: error || undefined };
    s.history.unshift(entry);
    if (s.history.length > 200) s.history.length = 200;
    // permanent, append-only log of songs actually sung → personal stats across nights
    if (!skipped && this.sungLog) {
      const line = { singer: entry.singer, with: entry.with, videoId: entry.videoId, title: entry.title, genre: entry.genre, year: entry.year, key: entry.key || 0, at: entry.endedAt, night: s.nightStartedAt, startedAt: entry.startedAt, reacts: entry.reacts || 0 };
      try { fs.appendFileSync(this.sungLog, JSON.stringify(line) + '\n'); } catch (e) { console.error('sung log:', e.message); } // sync: tiny, and survives a crash right after
    }
    s.current = null;
    s.phase = 'idle';
    this._refresh();
  }

  ended(itemId) { this.lastActivity = Date.now(); if (this.s.current && this.s.current.id === itemId) this._finish(false); }
  playerError(itemId, msg) {
    const c = this.s.current;
    if (!c || c.id !== itemId) return;
    if (c.stream) {
      // the stream wouldn't play: put them back at the front and wait for the real download instead of skipping
      const { stream: _st, startedAt: _sa, ...it } = c;
      this.yt.streams.delete(c.videoId);
      this.s.queue.unshift({ ...it, streamFailed: true, dl: this.yt.status(c.videoId) });
      this.s.current = null; this.s.phase = 'idle';
      this.emit('cmd', { cmd: 'toast', text: 'Streaming hiccup — starting as soon as the download finishes' });
      return this._refresh();
    }
    this._finish(true, String(msg || 'playback error').slice(0, 200));
  }

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
    this.lastActivity = Date.now();
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
        const label = it => (it.with ? `${it.singer} & ${it.with}` : it.singer);
        if (!m.force) { // catch accidental doubles; the phone asks "add anyway?"
          const there = [s.current, ...s.queue, ...s.held].find(i => i && i.videoId === v.videoId);
          if (there) return { ok: false, dup: true, error: `That song is already ${s.current && s.current.id === there.id ? 'on stage' : 'in line'} for ${label(there)}` };
          const recent = s.history.find(h => h.videoId === v.videoId && !h.skipped && Date.now() - h.endedAt < 90 * 60 * 1000);
          if (recent) return { ok: false, dup: true, error: `${label(recent)} sang that ${Math.max(1, Math.round((Date.now() - recent.endedAt) / 60000))} min ago` };
        }
        const max = Number(s.settings.maxPerPerson) || 0;
        if (max && !host) {
          const mineInLine = [...s.queue, ...s.held].filter(i => [i.singer, i.with].some(n => norm(n) === norm(singer))).length;
          if (mineInLine >= max) return { ok: false, error: `${singer} already has ${mineInLine} song${mineInLine > 1 ? 's' : ''} in line waiting (limit ${max} at a time). Add another as soon as one's sung!` };
        }
        if (this.people) { this.people.touch(singer); if (partner) this.people.touch(partner); }
        this._snap();
        const item = {
          id: uid(), videoId: v.videoId,
          title: String(v.title || 'Untitled').slice(0, 200), channel: String(v.channel || '').slice(0, 100),
          duration: Number(v.duration) || null, thumb: String(v.thumb || '').slice(0, 300),
          singer, with: partner && norm(partner) !== norm(singer) ? partner : undefined,
          key: clampKey(m.key !== undefined ? m.key : fav ? fav.key : 0),
          clientId: who.clientId || null, addedAt: Date.now(), deferred: 0, dl: this.yt.status(v.videoId),
        };
        if (m.novox && this.vocals) { item.novox = true; item.nv = this.vocals.status(item.videoId) || { state: 'pending' }; }
        this._wantLyrics(item);
        if (this.genres) Object.assign(item, this.genres.get(item.videoId));
        const idx = s.settings.fair ? this._fairIndex(singer) : s.queue.length;
        s.queue.splice(idx, 0, item);
        if (this.genres) this.genres.lookup(item);   // after it's in the queue, so the result has somewhere to land
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
        s.resumeHold = false;
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
      case 'novox': { // 🎤✂ take the vocals out of this song (or put them back)
        const it = (s.current && s.current.id === m.id) ? s.current : (inQueue(m.id) || inHeld(m.id) || {}).item;
        if (!it) return notFound;
        if (!this.vocals) return { ok: false, error: 'Vocal remover not available' };
        it.novox = !!m.on;
        if (it.novox && this.vocals.status(it.videoId)?.state === 'error') this.vocals.retry(it.videoId);
        it.nv = it.novox ? (this.vocals.status(it.videoId) || { state: 'pending' }) : undefined;
        this._wantLyrics(it);
        break;
      }
      case 'prefetch': { // ⬇ get a list of songs (someone's faves) downloaded before they're needed
        const ids = (Array.isArray(m.ids) ? m.ids : []).map(String).slice(0, 60);
        return { ok: true, ...this.yt.prefetch(ids) };
      }
      case 'lyrics': { // 📝 words on screen for this song: on / off
        const it = (s.current && s.current.id === m.id) ? s.current : (inQueue(m.id) || inHeld(m.id) || {}).item;
        if (!it) return notFound;
        if (m.on) { it.lyrHide = false; this._wantLyrics(it, true); }
        else it.lyrHide = true;
        break;
      }
      case 'retry': {
        const f = inQueue(m.id) || inHeld(m.id); if (!f) return notFound;
        if (f.item.novox && f.item.nv && f.item.nv.state === 'error' && f.item.dl && f.item.dl.state === 'ready') { this.vocals.retry(f.item.videoId); f.item.nv = { state: 'pending' }; break; }
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
        const before = s.settings;
        s.settings = applySettings(before, st, DEFAULTS);
        if (s.settings.levelVolume !== before.levelVolume) this.yt.level = s.settings.levelVolume;
        if (s.settings.cacheGB !== before.cacheGB) this.pruneCache();
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
      case 'genre': { // correct a song's genre by hand (remembered for that video)
        const target = m.id ? (inQueue(m.id) || inHeld(m.id) || {}).item : s.current;
        if (!target) return notFound;
        if (this.genres) this.genres.setManual(target.videoId, m.genre || null);
        return result;
      }
      case 'profile': { // who this phone belongs to + their look
        if (!this.people) return result;
        const name = String(m.name || '').trim().slice(0, 40);
        if (!name) return { ok: false, error: 'Need a name' };
        this.people.touch(name, who.clientId);
        if (m.preset !== undefined && !this.people.setPreset(name, m.preset, who.clientId)) return { ok: false, error: 'Unknown avatar' };
        if (m.keep !== undefined) this.people.setKeep(name, m.keep);
        if (m.removePhoto) this.people.removePhoto(name);
        this._emit();
        return result;
      }
      case 'claimHost': { // "Be the host": switches the party to hosted, with this phone in charge
        if (who.viaNet) return { ok: false, error: 'Join on the Wi-Fi to host' };
        if (s.settings.hostMode === 'hosted' && !host) return { ok: false, error: 'Someone is already hosting — ask them to make you a co-host' };
        s.settings.hostMode = 'hosted';
        if (who.clientId && !s.hosts.includes(who.clientId)) s.hosts.push(who.clientId);
        result = { ok: true, note: "You're the host 👑" };
        break;
      }
      case 'setHost': { // host makes someone a co-host (on) or removes them (off)
        if (!host) return deny;
        if (!this.people) return notFound;
        const ids = this.people.clientsOf(m.name);
        if (!ids.length) return { ok: false, error: `${m.name} hasn't joined on a phone yet` };
        if (m.on) { for (const c of ids) if (!s.hosts.includes(c)) s.hosts.push(c); }
        else s.hosts = s.hosts.filter(c => !ids.includes(c));
        if (!s.hosts.length) s.settings.hostMode = 'open';
        break;
      }
      case 'handOff': { // give the crown to someone else and step down
        if (!host) return deny;
        const ids = this.people ? this.people.clientsOf(m.name) : [];
        if (!ids.length) return { ok: false, error: `${m.name} hasn't joined on a phone yet` };
        s.hosts = [...new Set([...s.hosts.filter(c => c !== who.clientId), ...ids])];
        break;
      }
      case 'endHosting': { // back to an open party: everyone can manage
        if (!host) return deny;
        s.settings.hostMode = 'open'; s.hosts = [];
        break;
      }
      case 'swap': { // wrong version → replace the video, keep the singer's spot, key and duet
        const f = inQueue(m.id) || inHeld(m.id); if (!f) return notFound;
        if (!host && !mine(f.item)) return deny;
        const v = m.video || {};
        if (!/^[\w-]{11}$/.test(v.videoId || '')) return { ok: false, error: 'Bad video' };
        this._snap();
        Object.assign(f.item, { videoId: v.videoId, title: String(v.title || '').slice(0, 200), channel: String(v.channel || '').slice(0, 100), duration: Number(v.duration) || null, thumb: String(v.thumb || '').slice(0, 300), dl: this.yt.status(v.videoId), genre: null, year: null });
        if (this.genres) { Object.assign(f.item, this.genres.get(v.videoId)); this.genres.lookup(f.item); }
        if (s.upnextId === f.item.id) { s.upnextId = null; } // re-call so the countdown waits for the new download
        result = { ok: true, note: 'Swapped — same spot in line' };
        break;
      }
      case 'awards': { // show the awards on the TV
        if (!host) return deny;
        this.emit('cmd', { cmd: 'awards', awards: this.awards() });
        return result;
      }
      case 'newNight': { // fresh night now: empty queue (parked as leftovers) + reset counts
        if (!host) return deny;
        this._newNight(true);
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
