'use strict';
// Works out a song's genre and decade from its YouTube title, using MusicBrainz (free, no account).
// Karaoke titles almost always name the artist: "Artist - Song (Karaoke Version)" or
// "Song (in the style of Artist)". Results are cached on disk; a manual pick on a phone always wins.
const https = require('https');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// The buckets shown in the app, in priority order when a raw genre matches several.
const BUCKETS = [
  ['musical', /musical|show ?tune|broadway|soundtrack|disney|cabaret/],
  ['kpop', /k-?pop|j-?pop|korean|c-?pop/],
  ['metal', /metal|grindcore|metalcore/],
  ['punk', /punk|emo|hardcore|grunge/],
  ['hiphop', /hip ?hop|rap|trap|grime|drill/],
  ['rnb', /r&b|rnb|rhythm and blues|soul|motown|gospel|neo soul|new jack/],
  ['disco', /disco|funk|boogie/],
  ['country', /country|bluegrass|americana|honky|nashville/],
  ['electronic', /electro|dance|house|techno|edm|synth|trance|eurodance|dubstep|new wave|hi-nrg/],
  ['latin', /latin|reggaeton|salsa|bachata|cumbia|bossa|samba|merengue|flamenco/],
  ['jazz', /jazz|blues|swing|big band|crooner|lounge|standards/],
  ['folk', /folk|singer-songwriter|acoustic|celtic/],
  ['rock', /rock|alternative|indie|britpop|psychedelic|power ballad|aor/],
  ['pop', /pop|ballad|adult contemporary|teen/],
];

function parseArtistTitle(rawTitle) {
  let t = String(rawTitle || '')
    .replace(/[\[(][^\])]*(karaoke|instrumental|lyrics?|version|official|video|backing|hd|4k|no vocals?)[^\])]*[\])]/gi, '')
    .replace(/\|.*$/, '')
    .replace(/\b(karaoke|instrumental|with lyrics|lyrics)\b/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
  const style = String(rawTitle || '').match(/in the style of\s+([^)\]|]+)/i);
  if (style) return { artist: style[1].trim(), title: t.replace(/in the style of.*/i, '').replace(/[\s(\[\-–]+$/, '').trim() };
  const parts = t.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: t };
}

function bucketFor(names) {
  for (const n of names) {
    const s = String(n).toLowerCase();
    const hit = BUCKETS.find(([, re]) => re.test(s));
    if (hit) return hit[0];
  }
  return null;
}

class Genres extends EventEmitter {
  constructor({ file, mock = false }) {
    super();
    this.file = file;
    this.mock = mock;
    this.db = { artists: {}, songs: {}, manual: {} }; // artist → {bucket}, videoId → {bucket, year}, videoId → bucket
    try { Object.assign(this.db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { }
    this.jobs = [];
    this.busy = false;
    this.lastReq = 0;
  }

  _save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.db)); } catch { }
    }, 500);
  }

  // What we know right now for a video (manual pick beats lookup). Null fields = unknown / pending.
  get(videoId) {
    const s = this.db.songs[videoId] || {};
    return { genre: this.db.manual[videoId] || s.bucket || null, year: s.year || null };
  }

  setManual(videoId, bucket) {
    if (bucket) this.db.manual[videoId] = bucket; else delete this.db.manual[videoId];
    this._save();
    this.emit('update', videoId, this.get(videoId));
  }

  // Ask for a lookup; emits 'update' when done. Cheap to call repeatedly.
  lookup(item) {
    if (!item || !item.videoId || this.db.songs[item.videoId] || this.jobs.some(j => j.videoId === item.videoId)) return;
    this.jobs.push({ videoId: item.videoId, title: item.title });
    this._next();
  }

  async _next() {
    if (this.busy) return;
    const job = this.jobs.shift();
    if (!job) return;
    this.busy = true;
    try {
      const res = this.mock ? await new Promise(r => setTimeout(() => r(this._mockResult(job)), 50)) : await this._resolve(job);
      this.db.songs[job.videoId] = res;
      this._save();
      this.emit('update', job.videoId, this.get(job.videoId));
    } catch (e) {
      // Network trouble: don't cache a miss forever, just give up for this session.
      this.db.songs[job.videoId] = this.db.songs[job.videoId] || undefined;
    }
    this.busy = false;
    this._next();
  }

  _mockResult(job) {
    const keys = BUCKETS.map(b => b[0]);
    let h = 0; for (const c of job.title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return { bucket: keys[h % keys.length], year: 1965 + (h % 6) * 10 };
  }

  // MusicBrainz asks for ≤1 request/second and a descriptive User-Agent.
  _get(url) {
    return new Promise((resolve, reject) => {
      const wait = Math.max(0, this.lastReq + 1100 - Date.now());
      setTimeout(() => {
        this.lastReq = Date.now();
        https.get(url, { headers: { 'User-Agent': 'KARAO-Q/0.3 ( https://github.com/fancy-butler/karaoq )', Accept: 'application/json' }, timeout: 10000 }, res => {
          let body = '';
          res.on('data', d => { body += d; });
          res.on('end', () => {
            if (res.statusCode === 503) return reject(new Error('rate limited'));
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
        }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
      }, wait);
    });
  }

  async _resolve(job) {
    const { artist, title } = parseArtistTitle(job.title);
    const q = s => encodeURIComponent(String(s).replace(/["\\]/g, ''));
    const out = { bucket: null, year: null, artist, song: title };
    const MB = 'https://musicbrainz.org/ws/2';

    // 1) the recording: gives the real artist (even if the title was "Song - Artist") and the year
    let artistId = null;
    if (title) {
      const query = artist ? `recording:"${q(title)}" AND artist:"${q(artist)}"` : `recording:"${q(title)}"`;
      const r = await this._get(`${MB}/recording/?query=${query}&fmt=json&limit=10`);
      let recs = (r.recordings || []).filter(x => (x.score || 0) >= 80);
      // titles are sometimes "Song - Artist": try swapped
      if (!recs.length && artist) {
        const r2 = await this._get(`${MB}/recording/?query=recording:"${q(artist)}" AND artist:"${q(title)}"&fmt=json&limit=10`);
        recs = (r2.recordings || []).filter(x => (x.score || 0) >= 80);
      }
      const years = recs.map(x => parseInt(String(x['first-release-date'] || '').slice(0, 4), 10)).filter(y => y > 1900 && y < 2100);
      if (years.length) out.year = Math.min(...years);
      const credit = recs[0] && recs[0]['artist-credit'] && recs[0]['artist-credit'][0];
      if (credit && credit.artist) { artistId = credit.artist.id; out.artist = credit.artist.name; }
    }

    // 2) the artist's genres/tags → one bucket (cached per artist)
    const akey = String(out.artist || artist).toLowerCase();
    if (akey && this.db.artists[akey]) out.bucket = this.db.artists[akey].bucket;
    else if (akey) {
      if (!artistId) {
        const a = await this._get(`${MB}/artist/?query=artist:"${q(out.artist || artist)}"&fmt=json&limit=1`);
        const top = (a.artists || [])[0];
        if (top && (top.score || 0) >= 85) artistId = top.id;
      }
      if (artistId) {
        const d = await this._get(`${MB}/artist/${artistId}?inc=genres+tags&fmt=json`);
        const ranked = [...(d.genres || []), ...(d.tags || [])].sort((x, y) => (y.count || 0) - (x.count || 0)).map(g => g.name);
        out.bucket = bucketFor(ranked);
        this.db.artists[akey] = { bucket: out.bucket };
      }
    }
    return out;
  }
}

module.exports = { Genres, parseArtistTitle, bucketFor, BUCKET_KEYS: BUCKETS.map(b => b[0]) };
