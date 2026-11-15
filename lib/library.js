'use strict';
// 💾 Local karaoke library: folders of real karaoke files (the kind a KJ keeps on a hard drive).
//   • CD+G pairs: song.cdg + song.mp3 (or .ogg/.wav/.flac/.m4a), loose or inside a .zip
//   • karaoke videos: .mp4 .mkv .avi .mov .m4v .webm .mpg .mpeg .wmv .flv .vob .ts
// Songs show up in search next to YouTube results. When one is queued it's converted once into the
// same cached .mp4 the YouTube songs use (ffmpeg draws CD+G graphics natively), so the TV, levelling,
// key change and everything else just work.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const VIDEO = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.mpg', '.mpeg', '.wmv', '.flv', '.vob', '.ts']);
const AUDIO = ['.mp3', '.ogg', '.wav', '.flac', '.m4a', '.aac'];
const PASS_THROUGH = new Set(['.mp4', '.m4v', '.mov']); // usually H.264/AAC already: copy instead of re-encoding

const isLocalId = id => typeof id === 'string' && id.startsWith('lc_');
const flat = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// "SC8123-05 - Bon Jovi - Livin' On A Prayer [Karaoke]" → { disc: 'SC8123-05', artist: 'Bon Jovi', title: "Livin' On A Prayer" }
function parseName(base) {
  let s = base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[\[(](karaoke|kar|cdg|mp3g|instrumental|with vocals?|no vocals?|lyrics|hd|official)[^\])]*[\])]/gi, '').trim();
  let parts = s.split(/\s+[-–—]\s+|\s*[-–—]\s+|\s+[-–—]\s*/).map(x => x.trim()).filter(Boolean);
  let disc = '';
  // disc / track codes: SC8123-05, SF001-01, PHM0901-03, CB60123-08, DK 012-3, 01, 0123
  if (parts.length >= 3 && /^[a-z]{0,6}\s?\d{1,6}([- .]\d{1,3})?$/i.test(parts[0])) disc = parts.shift();
  if (parts.length >= 3 && /^\d{1,3}$/.test(parts[0])) disc = (disc ? disc + '-' : '') + parts.shift(); // "SC8123 - 05 - Artist - Title"
  if (!disc && parts.length) {
    const m = parts[0].match(/^([a-z]{1,6}\d{2,6}(?:-\d{1,3})?)\s+(.+)$/i); // "SC8123-05 Artist - Title" without the first dash
    if (m) { disc = m[1]; parts[0] = m[2]; }
  }
  if (parts.length >= 2) return { disc, artist: parts[0], title: parts.slice(1).join(' - ') };
  return { disc, artist: '', title: parts[0] || base };
}

class Library {
  constructor({ dataDir, ffmpeg = 'ffmpeg', mock = false }) {
    this.file = path.join(dataDir, 'library.json');
    this.ffmpeg = ffmpeg;
    this.dirs = [];
    this.songs = new Map(); // id → { id, kind: 'video'|'cdg'|'zip', file, audio?, inner?, artist, title, disc, folder }
    this.scanning = false;
    this.lastScan = 0;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.dirs = j.dirs || [];
      for (const s of j.songs || []) this.songs.set(s.id, s);
      this.lastScan = j.lastScan || 0;
    } catch { }
    for (const d of String(process.env.KQ_LIBRARY || '').split(path.delimiter).filter(Boolean)) if (!this.dirs.includes(d)) this.dirs.push(d);
  }

  info() {
    const by = {};
    for (const s of this.songs.values()) by[s.root] = (by[s.root] || 0) + 1;
    return { dirs: this.dirs.map(d => ({ dir: d, songs: by[d] || 0, ok: fs.existsSync(d) })), total: this.songs.size, scanning: this.scanning, lastScan: this.lastScan };
  }
  _save() { try { fs.writeFileSync(this.file, JSON.stringify({ dirs: this.dirs, lastScan: this.lastScan, songs: [...this.songs.values()] })); } catch (e) { console.error('library save:', e.message); } }

  addDir(d) { d = path.resolve(String(d)); if (!this.dirs.includes(d)) this.dirs.push(d); this._save(); return this.scan(); }
  removeDir(d) { this.dirs = this.dirs.filter(x => x !== d); for (const [id, s] of this.songs) if (s.root === d) this.songs.delete(id); this._save(); }

  // Walk every folder. 50k files takes a few seconds; it runs in the background and search works meanwhile.
  async scan() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const found = new Map();
      for (const root of this.dirs) {
        if (!fs.existsSync(root)) continue;
        const stack = [root];
        let n = 0;
        while (stack.length) {
          const dir = stack.pop();
          let ents;
          try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
          const names = new Set(ents.map(e => e.name.toLowerCase()));
          for (const e of ents) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { stack.push(full); continue; }
            const ext = path.extname(e.name).toLowerCase(), base = e.name.slice(0, -ext.length);
            let song = null;
            if (ext === '.cdg') {
              const a = AUDIO.find(x => names.has((base + x).toLowerCase()));
              if (a) song = { kind: 'cdg', file: full, audio: path.join(dir, ents.find(x => x.name.toLowerCase() === (base + a).toLowerCase()).name) };
            } else if (ext === '.zip') song = { kind: 'zip', file: full };
            else if (VIDEO.has(ext)) song = { kind: 'video', file: full };
            if (!song) continue;
            const id = 'lc_' + crypto.createHash('sha1').update(full).digest('hex').slice(0, 8);
            found.set(id, { id, ...song, ...parseName(base), root, folder: path.relative(root, dir) });
            if (++n % 500 === 0) await new Promise(r => setImmediate(r));
          }
        }
      }
      this.songs = found;
      this.lastScan = Date.now();
      this._save();
      console.log(`      Karaoke library: ${found.size} songs in ${this.dirs.length} folder(s)`);
      this.scanning = false;
      return found.size;
    })();
    return this.scanning;
  }

  // Every word must match artist/title/disc; whole-word and title matches rank higher.
  search(q, limit = 8) {
    if (!this.songs.size) return [];
    const words = flat(q).split(' ').filter(w => w && !['karaoke', 'version', 'lyrics', 'the'].includes(w));
    if (!words.length) return [];
    const out = [];
    for (const s of this.songs.values()) {
      const hay = s._hay || (s._hay = ` ${flat(s.artist)} ${flat(s.title)} ${flat(s.disc)} `);
      if (!words.every(w => hay.includes(w))) continue;
      const t = ` ${flat(s.title)} `;
      const score = words.reduce((a, w) => a + (hay.includes(` ${w} `) ? 2 : 1) + (t.includes(w) ? 1 : 0), 0) + (s.kind === 'video' ? 0.5 : 0);
      out.push({ s, score });
    }
    return out.sort((a, b) => b.score - a.score || a.s.title.localeCompare(b.s.title)).slice(0, limit).map(({ s }) => this.result(s));
  }
  result(s) {
    const what = s.kind === 'video' ? 'video' : 'CD+G';
    return { videoId: s.id, local: true, title: s.artist ? `${s.artist} - ${s.title}` : s.title, channel: `💾 Your library · ${what}${s.disc ? ' · ' + s.disc : ''}`, duration: null, thumb: '/local-song.svg' };
  }
  get(id) { return this.songs.get(id); }

  // Make the cached .mp4 for a library song. onPct(0–100) reports progress.
  async prepare(id, out, onPct = () => { }) {
    const s = this.songs.get(id);
    if (!s) throw new Error('Not in the library any more (was the drive unplugged or the folder moved?)');
    if (!fs.existsSync(s.file)) throw new Error(`Can't find ${s.file} — is the drive plugged in?`);
    const tmp = out + '.tmp.mp4';
    if (s.kind === 'video') {
      const ext = path.extname(s.file).toLowerCase();
      if (PASS_THROUGH.has(ext)) {
        try { await this._ff(['-i', s.file, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], onPct); fs.renameSync(tmp, out); return; }
        catch { /* not H.264 inside: re-encode below */ }
      }
      await this._ff(['-i', s.file, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], onPct);
      fs.renameSync(tmp, out); return;
    }
    let cdg = s.file, audio = s.audio, cleanup = null;
    if (s.kind === 'zip') ({ cdg, audio, cleanup } = await this._unzip(s.file, out));
    try {
      // CD+G is 300×216 pixel art: scale up with nearest-neighbour so it stays crisp on a TV
      await this._ff(['-i', cdg, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-vf', 'scale=960:720:flags=neighbor,format=yuv420p', '-r', '30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'animation', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tmp], onPct);
      fs.renameSync(tmp, out);
    } finally { if (cleanup) cleanup(); }
  }

  _unzip(zipFile, out) {
    const yauzl = require('yauzl');
    const dir = out + '.unzip';
    fs.mkdirSync(dir, { recursive: true });
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } };
    return new Promise((resolve, reject) => {
      yauzl.open(zipFile, { lazyEntries: true }, (err, z) => {
        if (err) { cleanup(); return reject(new Error('Could not open the zip: ' + err.message)); }
        let cdg = null, audio = null;
        z.on('entry', e => {
          const ext = path.extname(e.fileName).toLowerCase();
          if (/\/$/.test(e.fileName) || !(ext === '.cdg' || AUDIO.includes(ext)) || (ext === '.cdg' ? cdg : audio)) return z.readEntry();
          const dest = path.join(dir, 'song' + ext);
          z.openReadStream(e, (er, rs) => {
            if (er) return z.readEntry();
            rs.pipe(fs.createWriteStream(dest)).on('finish', () => { if (ext === '.cdg') cdg = dest; else audio = dest; z.readEntry(); });
          });
        });
        z.on('end', () => (cdg && audio) ? resolve({ cdg, audio, cleanup }) : (cleanup(), reject(new Error('That zip has no .cdg + audio pair inside'))));
        z.on('error', e => { cleanup(); reject(e); });
        z.readEntry();
      });
    });
  }

  _ff(args, onPct) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.ffmpeg, ['-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '', dur = 0;
      p.stderr.on('data', d => { err = (err + d).slice(-1500); });
      // no reliable duration up front for CD+G; report a steady creep from the encoded time instead
      p.stdout.on('data', d => {
        const m = String(d).match(/out_time_us=(\d+)/g);
        if (m) { const t = Number(m.pop().split('=')[1]) / 1e6; dur = Math.max(dur, t); onPct(Math.min(95, Math.round(100 * (1 - Math.exp(-t / 120))))); }
      });
      p.on('error', e => reject(e));
      p.on('close', code => code === 0 ? resolve() : reject(new Error((err.trim().split('\n').pop() || 'conversion failed').slice(0, 300))));
    });
  }
}

module.exports = { Library, isLocalId, parseName };
