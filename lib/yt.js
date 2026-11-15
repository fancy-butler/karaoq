'use strict';
// yt-dlp wrapper: search, single-video lookup, and a sequential prefetch downloader.
// Videos are pulled straight from YouTube's streams, so there are no ads to block.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// Prefer H.264/AAC (plays everywhere), cap at 1080p, fall back to whatever exists.
const FORMAT = 'bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b';

// Channels that reliably upload proper karaoke tracks get bumped up in results.
const KARAOKE_CHANNELS = [
  'sing king', 'karafun', 'zoom karaoke', 'stingray karaoke', 'sunfly', 'karaoke version',
  'cc karaoke', 'party tyme', 'singsong karaoke', 'karaoke hits', 'musisi karaoke', 'atomic karaoke',
  'coversph', 'pinoy videoke', 'karaokeonvevo', 'karaocraze', 'piano karaoke', 'curtainup', 'tracks planet', 'pinoy karaoke', 'stingray',
];

function parseVideoId(input) {
  const s = String(input || '').trim();
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
  if (m) return m[1];
  if (/^[\w-]{11}$/.test(s)) return s;
  return null;
}

function run(bin, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    let p;
    try { p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return reject(e); }
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('yt-dlp timed out')); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(t); reject(new Error(`Could not run ${bin}: ${e.message}`)); });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error((err.trim().split('\n').pop() || `yt-dlp exited ${code}`).slice(0, 300)));
    });
  });
}

class YT extends EventEmitter {
  constructor({ cacheDir, bin = 'yt-dlp', mock = false }) {
    super();
    this.cacheDir = cacheDir;
    this.bin = bin;
    this.mock = mock;
    this.st = new Map();      // videoId -> { state: pending|downloading|ready|error, pct?, error? }
    this.wanted = [];
    this.active = null;
    this.searchCache = new Map();
    this.level = true; // volume levelling on by default (party setting)
    this._retried = new Set();
    this.streams = new Map(); // videoId -> { url, at } direct stream URLs for stream-first playback
    this.ytVersion = null;
    fs.mkdirSync(cacheDir, { recursive: true });
    // When each cached song was last wanted, for least-recently-used cleanup.
    this.indexFile = path.join(cacheDir, 'index.json');
    try { this.used = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { this.used = {}; }
    for (const f of fs.readdirSync(cacheDir)) {
      const m = f.match(/^([\w-]{11})\.mp4$/);
      if (m) this.st.set(m[1], { state: 'ready' });
    }
  }

  status(id) { return this.st.get(id) || { state: 'pending' }; }
  fileFor(id) { return path.join(this.cacheDir, `${id}.mp4`); }

  _set(id, s) { this.st.set(id, s); this.emit('update', id, s); }

  // Ordered list of videos the queue needs. Downloads go one at a time, in queue order.
  want(ids) {
    this._queueIds = ids;
    // queue first, then anything asked for ahead of time (⬇ get my faves ready)
    const extra = (this.extra || []).filter(id => !['ready', 'error'].includes(this.status(id).state));
    this.extra = extra;
    this.wanted = [...new Set([...ids, ...extra])];
    const now = Date.now();
    for (const id of this.wanted) this.used[id] = now;
    this._saveIndex();
    this._pump();
  }

  // ⬇ download songs ahead of time (they wait behind the queue's own songs)
  prefetch(ids) {
    const fresh = ids.filter(id => /^[\w-]{11}$/.test(id) && this.status(id).state !== 'ready');
    this.extra = [...new Set([...(this.extra || []), ...fresh])].slice(0, 60);
    this.want(this._queueIds || []);
    return { queued: fresh.length, ready: ids.length - fresh.length };
  }

  _saveIndex() {
    clearTimeout(this._idxT);
    this._idxT = setTimeout(() => { try { fs.writeFileSync(this.indexFile, JSON.stringify(this.used)); } catch { } }, 1000);
  }

  // Cache cleanup: never touch songs in the queue; drop anything unplayed for 60 days;
  // then delete least-recently-used songs until the cache fits under the cap.
  prune(maxBytes, protect = []) {
    const keep = new Set([...protect, ...this.wanted, this.active].filter(Boolean));
    const files = [];
    for (const f of fs.readdirSync(this.cacheDir)) {
      const m = f.match(/^([\w-]{11})(\.nv)?\.mp4$/); // song, or its vocals-removed copy
      if (!m) continue;
      try { const st = fs.statSync(path.join(this.cacheDir, f)); files.push({ id: m[1], nv: !!m[2], f, size: st.size, used: this.used[m[1]] || st.mtimeMs }); } catch { }
    }
    let total = files.reduce((a, x) => a + x.size, 0);
    const old = Date.now() - 60 * 24 * 3600 * 1000;
    let freed = 0;
    for (const x of files.sort((a, b) => a.used - b.used)) {
      if (keep.has(x.id)) continue;
      if (x.used > old && total <= maxBytes) break;
      try { fs.unlinkSync(path.join(this.cacheDir, x.f)); total -= x.size; freed += x.size; if (x.nv) this.emit('pruned-nv', x.id); else { this.st.delete(x.id); delete this.used[x.id]; } } catch { }
    }
    // stray partial downloads
    for (const f of fs.readdirSync(this.cacheDir)) if (/\.(part|ytdl|tmp\.mp4|lvl\.mp4)$/.test(f) && !(this.active && f.startsWith(this.active))) { try { fs.unlinkSync(path.join(this.cacheDir, f)); } catch { } }
    this._saveIndex();
    if (freed) console.log(`      Cache cleanup: freed ${(freed / 1e9).toFixed(2)} GB`);
    return total;
  }

  // ---------- keeping yt-dlp fresh ----------
  // YouTube breaks old yt-dlp versions every few weeks. The desktop app runs a writable copy of yt-dlp,
  // so we can run its built-in self-updater: at startup, twice a day, and right after a failure.
  canUpdate() { return path.isAbsolute(this.bin) && fs.existsSync(this.bin); }
  async version() {
    if (this.mock) return (this.ytVersion = 'mock');
    try { this.ytVersion = (await run(this.bin, ['--version'], 15000)).trim(); } catch { }
    return this.ytVersion;
  }
  selfUpdate(why = 'scheduled') {
    if (this.mock || !this.canUpdate()) return Promise.resolve(false);
    if (this._updating) return this._updating;
    if (why !== 'startup' && Date.now() - (this._lastUpdate || 0) < 30 * 60 * 1000) return Promise.resolve(false); // don't hammer GitHub
    this._lastUpdate = Date.now();
    this._updating = (async () => {
      // wait for the current download to finish so we never swap the binary under a running copy (Windows locks it)
      while (this.active && why !== 'download failed') await new Promise(r => setTimeout(r, 2000));
      const before = await this.version();
      try { await run(this.bin, ['-U'], 180000); } catch (e) { console.error(`      yt-dlp update (${why}) failed: ${e.message}`); }
      const after = await this.version();
      if (after && after !== before) { console.log(`      yt-dlp updated ${before} → ${after} (${why})`); this.searchCache.clear(); this.streams.clear(); }
      this._updating = null;
      return after !== before;
    })();
    return this._updating;
  }

  // ---------- stream-first playback ----------
  // Direct stream URL for a song that hasn't finished downloading. Single-file MP4 (itag 18, 360p, or better
  // if YouTube offers one) so the TV can play it straight away; the server proxies it so it stays same-origin.
  async streamUrl(id) {
    const hit = this.streams.get(id);
    if (hit && Date.now() - hit.at < 2 * 3600 * 1000) return hit.url;
    if (this._streamReq && this._streamReq.has(id)) return this._streamReq.get(id);
    this._streamReq = this._streamReq || new Map();
    const p = (async () => {
      let url;
      if (this.mock) { await this._mockClip(); url = 'mock'; }
      else {
        // -j gives the chosen format's URL plus the exact headers YouTube expects with it
        const j = JSON.parse(await run(this.bin, ['-j', '-f', 'b[ext=mp4][vcodec^=avc1][acodec!=none][height<=720]/18/b[acodec!=none][vcodec!=none]', '--no-playlist', '--no-warnings', `https://www.youtube.com/watch?v=${id}`], 45000));
        const f = (j.requested_downloads && j.requested_downloads[0]) || j;
        url = f.url || j.url;
        if (!/^https?:/.test(url || '')) throw new Error('no stream URL');
        this.streamHeaders = this.streamHeaders || new Map();
        this.streamHeaders.set(id, f.http_headers || j.http_headers || {});
      }
      this.streams.set(id, { url, at: Date.now() });
      return url;
    })().finally(() => this._streamReq.delete(id));
    this._streamReq.set(id, p);
    return p;
  }
  mockClipFile() { return path.join(this.cacheDir, '_mockstream.mp4'); }
  _mockClip() {
    if (fs.existsSync(this.mockClipFile())) return Promise.resolve();
    const tmp = this.mockClipFile() + '.tmp.mp4';
    return (this._clipP ||= new Promise(res => spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', tmp])
      .on('error', e => { console.error('mock clip: ffmpeg missing?', e.message); this._clipP = null; res(); })
      .on('close', () => { try { fs.renameSync(tmp, this.mockClipFile()); } catch { } res(); })));
  }

  retry(id) {
    const s = this.st.get(id);
    if (s && s.state === 'error') { this._set(id, { state: 'pending' }); this._pump(); }
  }

  _pump() {
    if (this.active) return;
    const id = this.wanted.find(v => { const s = this.st.get(v); return !s || s.state === 'pending'; });
    if (id) this._download(id);
  }

  _download(id) {
    this.active = id;
    this._set(id, { state: 'downloading', pct: 0 });
    let errTail = '';
    const done = ok => {
      const finish = () => {
        this.active = null;
        if (ok && fs.existsSync(this.fileFor(id))) this._set(id, { state: 'ready' });
        else if (!this.mock && !id.startsWith('lc_') && !this._retried.has(id) && this.canUpdate()) {
          // Most "it suddenly stopped working" failures are YouTube changing something; a fresh yt-dlp fixes them.
          this._retried.add(id);
          this._set(id, { state: 'downloading', pct: 0, note: 'updating downloader' });
          return this.selfUpdate('download failed').then(() => { this._set(id, { state: 'pending' }); this._pump(); });
        }
        else this._set(id, { state: 'error', error: (errTail.trim().split('\n').pop() || 'Download failed').slice(0, 300) });
        this._pump();
      };
      if (ok && this.level && fs.existsSync(this.fileFor(id))) this._levelAudio(id, finish);
      else finish();
    };
    if (id.startsWith('lc_')) {
      // 💾 local karaoke file: convert it into the cache (see lib/library.js)
      if (!this.library) { errTail = 'No karaoke library'; return done(false); }
      let last = -10;
      return this.library.prepare(id, this.fileFor(id), pct => { if (pct - last >= 3) { last = pct; this._set(id, { state: 'downloading', pct, note: 'converting' }); } })
        .then(() => done(true), e => { errTail = e.message; done(false); });
    }
    if (this.mock) return this._mockDownload(id, done);

    const args = [
      '-f', FORMAT, '--merge-output-format', 'mp4', '--remux-video', 'mp4',
      '--no-playlist', '--newline', '--no-warnings',
      '-o', path.join(this.cacheDir, `${id}.%(ext)s`),
      `https://www.youtube.com/watch?v=${id}`,
    ];
    let p;
    try { p = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { errTail = e.message; return done(false); }
    let lastPct = -10;
    const onLine = d => {
      const text = String(d);
      const m = [...text.matchAll(/\[download\]\s+([\d.]+)%/g)].pop();
      if (m) {
        const pct = Math.floor(parseFloat(m[1]));
        if (Math.abs(pct - lastPct) >= 3) { lastPct = pct; this._set(id, { state: 'downloading', pct }); }
      }
    };
    p.stdout.on('data', onLine);
    p.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
    const kill = setTimeout(() => p.kill('SIGKILL'), 15 * 60 * 1000);
    p.on('error', e => { errTail += e.message; });
    p.on('close', code => { clearTimeout(kill); done(code === 0); });
  }

  // Volume levelling: loudness-normalise the audio (EBU R128, -14 LUFS like streaming services) so a quiet
  // 1970s upload doesn't follow a blasting modern one. Video is copied untouched; takes a few seconds per song.
  _levelAudio(id, cb) {
    this._set(id, { state: 'downloading', pct: 99, note: 'levelling' });
    const src = this.fileFor(id), tmp = src + '.lvl.mp4';
    const p = spawn(this.ffmpeg || 'ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy',
      '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    const kill = setTimeout(() => p.kill('SIGKILL'), 5 * 60 * 1000);
    p.on('error', () => { clearTimeout(kill); cb(); });
    p.on('close', code => {
      clearTimeout(kill);
      if (code === 0) { try { fs.renameSync(tmp, src); } catch { } }
      else { try { fs.unlinkSync(tmp); } catch { } console.error(`levelling ${id} failed, using original: ${err.trim().split('\n').pop()}`); }
      cb();
    });
  }

  // MOCK=1: fake a download by rendering a short test clip with ffmpeg.
  _mockDownload(id, done) {
    const tmp = this.fileFor(id) + '.tmp.mp4';
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=330',
      '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', tmp]);
    p.on('error', e => { errTailMock = e.message; });
    let errTailMock = '';
    let pct = 0;
    const step = this.slowMock && this.slowMock.has(id) ? 1 : (Number(process.env.MOCK_DL_STEP) || 20); // smoke test: slow download → stream-first
    const tick = setInterval(() => { pct = Math.min(95, pct + step); this._set(id, { state: 'downloading', pct }); }, 300);
    p.on('close', code => {
      const finish = () => { clearInterval(tick); if (code === 0) fs.renameSync(tmp, this.fileFor(id)); done(code === 0); };
      if (step >= 20) return finish();
      const wait = setInterval(() => { if (pct >= 95) { clearInterval(wait); finish(); } }, 200); // slow mock download (testing stream-first)
    });
  }

  _map(e) {
    return {
      videoId: e.id,
      title: e.title || '',
      channel: e.channel || e.uploader || '',
      duration: Number(e.duration) || null,
      thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
    };
  }

  async search(q, karaoke = true) {
    const query = karaoke && !/karaoke|instrumental|backing track|off vocal|minus one/i.test(q) ? `${q} karaoke` : q;
    const key = query.toLowerCase();
    const hit = this.searchCache.get(key);
    if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit.results;

    let results;
    if (this.mock) {
      results = Array.from({ length: 8 }, (_, i) => {
        const id = crypto.createHash('sha1').update(query + i).digest('base64url').slice(0, 11);
        if (/\[slow\]/.test(q)) (this.slowMock ||= new Set()).add(id);
        return { videoId: id, title: `${q} (Karaoke Version) #${i + 1}`, channel: i % 2 ? 'Sing King' : 'Some Channel', duration: 20, thumb: '' };
      });
    } else {
      const args = ['--flat-playlist', '-J', '--no-warnings', `ytsearch15:${query}`];
      let out;
      try { out = await run(this.bin, args, 30000); }
      catch (e) { if (!(await this.selfUpdate('search failed'))) throw e; out = await run(this.bin, args, 30000); }
      const j = JSON.parse(out);
      results = (j.entries || []).filter(e => e && /^[\w-]{11}$/.test(e.id || '')).map(e => this._map(e));
    }
    if (karaoke) {
      const score = r => {
        const t = r.title.toLowerCase(), c = r.channel.toLowerCase();
        return (KARAOKE_CHANNELS.some(k => c.includes(k)) ? 3 : 0) + (/karaoke|instrumental/.test(t) ? 2 : 0);
      };
      results = results.map((r, i) => ({ r, i, s: score(r) })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.r);
    }
    this.searchCache.set(key, { at: Date.now(), results });
    return results;
  }

  async lookup(url) {
    const id = parseVideoId(url);
    if (!id) throw new Error("That doesn't look like a YouTube link");
    if (this.mock) return { videoId: id, title: `Pasted video ${id}`, channel: 'Mock', duration: 20, thumb: '' };
    const out = await run(this.bin, ['-J', '--no-warnings', '--no-playlist', '--skip-download', `https://www.youtube.com/watch?v=${id}`], 30000);
    return this._map(JSON.parse(out));
  }
}

module.exports = { YT, parseVideoId };
