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
    fs.mkdirSync(cacheDir, { recursive: true });
    for (const f of fs.readdirSync(cacheDir)) {
      const m = f.match(/^([\w-]{11})\.mp4$/);
      if (m) this.st.set(m[1], { state: 'ready' });
    }
  }

  status(id) { return this.st.get(id) || { state: 'pending' }; }
  fileFor(id) { return path.join(this.cacheDir, `${id}.mp4`); }

  _set(id, s) { this.st.set(id, s); this.emit('update', id, s); }

  // Ordered list of videos the queue needs. Downloads go one at a time, in queue order.
  want(ids) { this.wanted = [...new Set(ids)]; this._pump(); }

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
      this.active = null;
      if (ok && fs.existsSync(this.fileFor(id))) this._set(id, { state: 'ready' });
      else this._set(id, { state: 'error', error: (errTail.trim().split('\n').pop() || 'Download failed').slice(0, 300) });
      this._pump();
    };
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

  // MOCK=1: fake a download by rendering a short test clip with ffmpeg.
  _mockDownload(id, done) {
    const tmp = this.fileFor(id) + '.tmp.mp4';
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=330',
      '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', tmp]);
    let pct = 0;
    const tick = setInterval(() => { pct = Math.min(95, pct + 20); this._set(id, { state: 'downloading', pct }); }, 300);
    p.on('close', code => {
      clearInterval(tick);
      if (code === 0) fs.renameSync(tmp, this.fileFor(id));
      done(code === 0);
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
        return { videoId: id, title: `${q} (Karaoke Version) #${i + 1}`, channel: i % 2 ? 'Sing King' : 'Some Channel', duration: 20, thumb: '' };
      });
    } else {
      const out = await run(this.bin, ['--flat-playlist', '-J', '--no-warnings', `ytsearch15:${query}`], 30000);
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
