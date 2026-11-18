'use strict';
// 📝 Synced lyrics for songs that aren't karaoke videos (or had their vocals removed), from LRCLIB
// (https://lrclib.net — a free, open, community lyrics database). Saved next to the song as <id>.lrc.json
// so the TV can scroll them line by line.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const { parseArtistTitle } = require('./genre');

const UA = 'KARAO-Q ( https://github.com/fancy-butler/karaoq )';
const getJSON = url => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 10000 }, res => {
    let d = ''; res.on('data', c => { d += c; });
    res.on('end', () => { if (res.statusCode === 404) return resolve(null); if (res.statusCode >= 400) return reject(new Error(`LRCLIB ${res.statusCode}`)); try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
});

// "[01:23.45] line" → [{ t: 83.45, text: 'line' }]
function parseLrc(lrc) {
  const out = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / (m[3].length === 3 ? 1000 : 100) : 0), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

class Lyrics extends EventEmitter {
  constructor({ cacheDir, mock = false }) {
    super();
    this.cacheDir = cacheDir;
    this.mock = mock;
    this.st = new Map(); // videoId → 'looking' | 'ready' | 'none'
    for (const f of fs.readdirSync(cacheDir)) { const m = f.match(/^([\w-]{11})\.lrc\.json$/); if (m) this.st.set(m[1], 'ready'); }
  }
  fileFor(id) { return path.join(this.cacheDir, `${id}.lrc.json`); }
  status(id) { return this.st.get(id) || null; }

  async find(item) {
    const id = item.videoId;
    const s = this.st.get(id);
    if (s === 'ready' || s === 'looking') return s;
    if (s === 'none' && !item.force) return s;
    this.st.set(id, 'looking'); this.emit('update', id, 'looking');
    let lines = null, source = null;
    try {
      if (this.mock) {
        await new Promise(r => setTimeout(r, 300));
        lines = Array.from({ length: 12 }, (_, i) => ({ t: 1 + i * 1.6, text: i % 4 === 3 ? '' : /\[long\]/.test(item.title || '') ? `♪ Test lyric line ${i + 1} — and this one keeps on going and going like a power ballad bridge that never ends, supercalifragilisticexpialidocious ♪` : `♪ Test lyric line ${i + 1} — sing it loud ♪` }));
        source = 'mock';
      } else {
        const { artist, title } = parseArtistTitle(item.title);
        const dur = Number(item.duration) || 0;
        let hit = null;
        if (artist && title) {
          const u = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}${dur ? `&duration=${Math.round(dur)}` : ''}`;
          hit = await getJSON(u).catch(() => null);
          if (hit && !hit.syncedLyrics) hit = null;
        }
        if (!hit) {
          const list = await getJSON(`https://lrclib.net/api/search?q=${encodeURIComponent(`${artist} ${title}`.trim())}`) || [];
          // prefer synced lyrics with a length close to the video's
          hit = list.filter(x => x.syncedLyrics && !x.instrumental)
            .sort((a, b) => (dur ? Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur) : 0))[0] || null;
          if (hit && dur && hit.duration && Math.abs(hit.duration - dur) > 20) hit = null; // probably a different cut of the song
        }
        if (hit) { lines = parseLrc(hit.syncedLyrics); source = `${hit.artistName} — ${hit.trackName}`; }
      }
    } catch (e) { console.error(`lyrics for ${id}: ${e.message}`); }
    const ok = lines && lines.filter(l => l.text).length >= 4;
    if (ok) fs.writeFileSync(this.fileFor(id), JSON.stringify({ source, lines }));
    const st = ok ? 'ready' : 'none';
    this.st.set(id, st); this.emit('update', id, st);
    return st;
  }
}

module.exports = { Lyrics, parseLrc };
