'use strict';
// 🎤✂ Vocal remover: makes <id>.nv.mp4 next to a downloaded song, same video with the singing taken out.
//   • AI (Demucs), if it's installed on this computer — real separation, sounds like a proper backing track.
//     Takes roughly the song's length on a normal CPU (much faster with a graphics card).
//   • Quick (built in, ffmpeg) — cancels whatever is panned dead-centre (usually the lead vocal) and keeps the bass.
//     Takes seconds. Works well on older stereo mixes, can leave reverb "ghosts" and thin out modern mixes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const QUICK_FILTER = '[0:a]aformat=channel_layouts=stereo,asplit=2[a][b];' +
  '[a]lowpass=f=160,pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1[low];' +          // bass + kick live in the centre too: keep them
  '[b]highpass=f=160,pan=stereo|c0=c0-c1|c1=c1-c0[side];' +                          // centre-cancel everything above
  '[low][side]amix=inputs=2:normalize=0,volume=1.4[out]';

function findDemucs() {
  const home = os.homedir();
  const c = [process.env.KQ_DEMUCS, 'demucs',
    path.join(home, '.local', 'bin', 'demucs'),
    path.join(home, '.local', 'pipx', 'venvs', 'demucs', 'bin', 'demucs'),
    '/usr/local/bin/demucs', '/opt/homebrew/bin/demucs',
    process.env.APPDATA && path.join(process.env.APPDATA, 'Python', 'Scripts', 'demucs.exe'),
    path.join(home, '.local', 'bin', 'demucs.exe')].filter(Boolean);
  return new Promise(resolve => {
    let i = 0;
    const next = () => {
      if (i >= c.length) return resolve(null);
      const bin = c[i++];
      if (path.isAbsolute(bin) && !fs.existsSync(bin)) return next();
      execFile(bin, ['--help'], { timeout: 60000 }, err => (err ? next() : resolve(bin)));
    };
    next();
  });
}

class Vocals extends EventEmitter {
  constructor({ cacheDir, ffmpeg = 'ffmpeg' }) {
    super();
    this.cacheDir = cacheDir;
    this.ffmpeg = ffmpeg;
    this.st = new Map();   // videoId → { state, pct?, error?, engine? }
    this.wanted = [];
    this.active = null;
    this.demucs = null;
    this.engine = 'quick';
    for (const f of fs.readdirSync(cacheDir)) { const m = f.match(/^([\w-]{11})\.nv\.mp4$/); if (m) this.st.set(m[1], { state: 'ready' }); }
    if (process.env.KQ_DEMUCS !== '0') findDemucs().then(b => { if (b) { this.demucs = b; this.engine = 'demucs'; console.log(`      Vocal remover: Demucs (${b})`); } });
  }
  fileFor(id) { return path.join(this.cacheDir, `${id}.nv.mp4`); }
  status(id) { return this.st.get(id) || null; }
  _set(id, s) { this.st.set(id, s); this.emit('update', id, s); }
  info() { return { engine: this.engine, demucs: !!this.demucs }; }

  // ids whose original download is ready and need a vocal-free copy, in queue order
  want(ids) {
    this.wanted = ids.filter(id => !['ready', 'error'].includes((this.st.get(id) || {}).state));
    for (const id of this.wanted) if (!this.st.has(id)) this._set(id, { state: 'pending' });
    this._pump();
  }
  retry(id) { this.st.delete(id); }
  _pump() {
    if (this.active) return;
    const id = this.wanted.find(x => (this.st.get(x) || {}).state === 'pending');
    if (!id) return;
    this.active = id;
    const src = path.join(this.cacheDir, `${id}.mp4`), out = this.fileFor(id), work = path.join(this.cacheDir, `${id}.nvwork.mp4`);
    const engine = this.demucs ? 'demucs' : 'quick';
    this._set(id, { state: 'downloading', pct: 0, engine, note: 'removing vocals' });
    const job = engine === 'demucs' ? this._demucs(id, src, work) : this._ff(['-i', src, '-filter_complex', QUICK_FILTER, '-map', '0:v:0', '-map', '[out]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', work], id);
    job.then(() => { fs.renameSync(work, out); this._set(id, { state: 'ready', engine }); },
      e => { try { fs.unlinkSync(work); } catch { } this._set(id, { state: 'error', engine, error: String(e.message || e).slice(0, 300) }); })
      .finally(() => { this.active = null; this._pump(); });
  }

  async _demucs(id, src, work) {
    const dir = path.join(this.cacheDir, `${id}.demucs`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const wav = path.join(dir, 'song.wav');
      await this._ff(['-i', src, '-vn', '-ac', '2', '-ar', '44100', wav], id, 0, 5);
      await new Promise((resolve, reject) => {
        const p = spawn(this.demucs, ['--two-stems=vocals', '-n', 'htdemucs', '-o', dir, wav], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        const onData = d => {
          const t = String(d); err = (err + t).slice(-1500);
          const m = [...t.matchAll(/(\d{1,3})%\|/g)].pop();
          if (m) this._set(id, { state: 'downloading', pct: 5 + Math.round(Number(m[1]) * 0.9), engine: 'demucs', note: 'removing vocals' });
        };
        p.stdout.on('data', onData); p.stderr.on('data', onData);
        p.on('error', reject);
        p.on('close', c => c === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || 'Demucs failed')));
      });
      const nv = path.join(dir, 'htdemucs', 'song', 'no_vocals.wav');
      if (!fs.existsSync(nv)) throw new Error('Demucs made no backing track');
      await this._ff(['-i', src, '-i', nv, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', work], id, 95, 5);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  _ff(args, id, base = 0, span = 100) {
    return new Promise((resolve, reject) => {
      const p = spawn(this.ffmpeg, ['-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', d => { err = (err + d).slice(-1500); });
      p.stdout.on('data', d => {
        const m = String(d).match(/out_time_us=(\d+)/g);
        if (m && span > 10) { const t = Number(m.pop().split('=')[1]) / 1e6; this._set(id, { state: 'downloading', pct: base + Math.min(span - 5, Math.round(span * (1 - Math.exp(-t / 90)))), engine: 'quick', note: 'removing vocals' }); }
      });
      p.on('error', reject);
      p.on('close', c => c === 0 ? resolve() : reject(new Error((err.trim().split('\n').pop() || 'ffmpeg failed').slice(0, 300))));
    });
  }
}

module.exports = { Vocals };
