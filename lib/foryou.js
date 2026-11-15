'use strict';
// 🎯 "For you" suggestions: per singer (by the name they joined with — no accounts), built from
//   1. what they've sung here (all nights; tonight counts double) + what they've got queued → their genres & decades,
//      matched against our song lists (charts + classics), minus anything they've already done;
//   2. "sung alongside": other singers on this machine who share a song with them, and what else those people sang.
const fs = require('fs');
const path = require('path');

const norm = s => String(s || '').trim().toLowerCase();
const flat = s => norm(s).replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const decade = y => (y ? Math.floor(y / 10) * 10 : null);

let POOL = null;
function pool() {
  if (POOL) return POOL;
  const lib = path.join(__dirname);
  const pop = JSON.parse(fs.readFileSync(path.join(lib, 'popular.json'), 'utf8')).songs;
  const more = JSON.parse(fs.readFileSync(path.join(lib, 'more.json'), 'utf8')).songs;
  const cls = JSON.parse(fs.readFileSync(path.join(lib, 'classics.json'), 'utf8'));
  const seen = new Set(); POOL = [];
  for (const c of [...pop, ...more, ...cls]) {
    const k = flat(c.title) + '|' + flat(String(c.artist).replace(/^the /i, '').split(' ')[0]);
    if (seen.has(k)) continue; seen.add(k);
    POOL.push({ title: c.title, artist: c.artist, g: c.g || null, y: c.y || null, rank: c.rank || null, ft: flat(c.title), fa: flat(String(c.artist).replace(/^the /i, '').split(/[ ,&]/)[0]) });
  }
  return POOL;
}
// Does a YouTube title ("Queen - Bohemian Rhapsody (Karaoke Version)") refer to this pool song?
const matches = (ytTitle, p) => { const f = flat(ytTitle); return p.ft.length >= 3 && f.includes(p.ft) && (!p.fa || f.includes(p.fa)); };

function forYou({ name, lines, nightStartedAt, queued = [], limit = 8 }) {
  const me = norm(name);
  if (!me) return { empty: true };
  const mine = lines.filter(l => norm(l.singer) === me || norm(l.with) === me);
  const q = queued.filter(it => norm(it.singer) === me || norm(it.with) === me);
  if (!mine.length && !q.length) return { empty: true };

  // taste profile
  const gw = {}, dw = {};
  const feed = (g, y, w) => { if (g) gw[g] = (gw[g] || 0) + w; const d = decade(y); if (d) dw[d] = (dw[d] || 0) + w; };
  for (const l of mine) feed(l.genre, l.year, l.at >= nightStartedAt ? 2 : 1);
  for (const it of q) feed(it.genre, it.year, 2);
  const gTot = Object.values(gw).reduce((a, b) => a + b, 0) || 1, dTot = Object.values(dw).reduce((a, b) => a + b, 0) || 1;
  const done = [...mine.map(l => l.title), ...q.map(i => i.title)];
  const doneIds = new Set([...mine.map(l => l.videoId), ...q.map(i => i.videoId)]);

  const scored = pool().filter(p => !done.some(t => matches(t, p))).map(p => {
    const gs = p.g ? (gw[p.g] || 0) / gTot : 0, ds = p.y ? (dw[decade(p.y)] || 0) / dTot : 0;
    const chart = p.rank ? (100 - p.rank) / 400 : 0;
    return { p, s: gs * 3 + ds * 2 + chart + Math.random() * 0.35 }; // a little shuffle so it isn't the same list every time
  }).filter(x => x.s > 0.4).sort((a, b) => b.s - a.s);
  const picks = [], perArtist = {};
  for (const { p } of scored) {
    if ((perArtist[p.fa] = (perArtist[p.fa] || 0) + 1) > 1) continue; // one per artist keeps it varied
    const why = p.g && gw[p.g] && p.y && dw[decade(p.y)] ? 'your genre & decade' : p.g && gw[p.g] ? 'a genre you sing' : 'a decade you sing';
    picks.push({ title: p.title, artist: p.artist, g: p.g, y: p.y, why });
    if (picks.length >= limit) break;
  }

  // sung alongside: people who share a song with me → their other songs (real videos, add in one tap)
  const myIds = new Set(mine.map(l => l.videoId).filter(Boolean));
  const twins = new Map(); // other singer → shared count
  for (const l of lines) if (myIds.has(l.videoId) && norm(l.singer) !== me) twins.set(norm(l.singer), (twins.get(norm(l.singer)) || 0) + 1);
  const also = new Map();
  for (const l of lines) {
    const who = norm(l.singer);
    if (!twins.has(who) || !l.videoId || doneIds.has(l.videoId) || myIds.has(l.videoId)) continue;
    const e = also.get(l.videoId) || { videoId: l.videoId, title: l.title, genre: l.genre, year: l.year, by: new Set(), w: 0 };
    e.by.add(l.singer); e.w += twins.get(who); also.set(l.videoId, e);
  }
  const alongside = [...also.values()].sort((a, b) => b.w - a.w).slice(0, 5)
    .map(e => ({ videoId: e.videoId, title: e.title, genre: e.genre, year: e.year, why: `${[...e.by].slice(0, 2).join(' & ')} sang this too` }));

  const topG = Object.entries(gw).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]);
  const topD = Object.entries(dw).sort((a, b) => b[1] - a[1]).slice(0, 1).map(x => `${String(x[0]).slice(2)}s`);
  return { empty: false, basis: { genres: topG, decades: topD, songs: mine.length + q.length }, picks, alongside };
}

module.exports = { forYou };
