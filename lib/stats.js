'use strict';
// Numbers about the party: tonight's singers, awards, the night in numbers, tonight's genre mix,
// and all-time stats from the permanent sung log (sung.jsonl). Pure functions: state in, numbers out.
const fs = require('fs');
const norm = s => String(s || '').trim().toLowerCase();

function readSungLog(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}

function tonightBySinger(s) {
  const by = new Map();
  for (const h of s.history) {
    if (h.endedAt < s.nightStartedAt || h.skipped) continue;
    for (const name of [h.singer, h.with].filter(Boolean)) {
      const k = norm(name);
      const e = by.get(k) || { singer: name, sung: 0 };
      e.sung++; by.set(k, e);
    }
  }
  return [...by.values()].sort((a, b) => b.sung - a.sung || a.singer.localeCompare(b.singer));
}

// End-of-night awards from tonight's songs. Each award needs a real winner (ties → first to get there).
function awards(s) {
  const sung = s.history.filter(h => h.endedAt >= s.nightStartedAt && !h.skipped).reverse();
  if (!sung.length) return [];
  const per = {};
  const P = n => (per[norm(n)] ||= { name: n, songs: 0, genres: new Set(), secs: 0, duets: 0, reacts: 0, oldest: 9999, passes: 0 });
  for (const h of sung) {
    for (const n of [h.singer, h.with].filter(Boolean)) {
      const p = P(n);
      p.songs++; if (h.genre) p.genres.add(h.genre);
      p.secs += h.startedAt ? Math.min((h.endedAt - h.startedAt) / 1000, 1200) : (h.duration || 0);
      if (h.with) p.duets++;
      p.reacts += h.reacts || 0;
      if (h.year) p.oldest = Math.min(p.oldest, h.year);
      p.passes += h.deferred || 0;
    }
  }
  const all = Object.values(per);
  const top = (fn, min = 1) => { const w = all.reduce((b, p) => (fn(p) > (b ? fn(b) : -1) ? p : b), null); return w && fn(w) >= min ? w : null; };
  const out = [];
  const add = (icon, title, w, why) => { if (w) out.push({ icon, title, name: w.name, why }); };
  let w;
  w = top(p => p.songs, 2); add('👑', 'Mic Hog', w, w && `${w.songs} songs`);
  w = top(p => p.genres.size, 2); add('🎸', 'Genre Hopper', w, w && `${w.genres.size} different genres`);
  w = top(p => p.reacts, 3); add('🔥', 'Crowd Favourite', w, w && `${w.reacts} reactions`);
  w = top(p => p.secs, 300); add('⏱️', 'Marathon Mic', w, w && `${Math.round(w.secs / 60)} minutes on stage`);
  w = top(p => -p.oldest, -2100); if (w && w.oldest < 9999) add('🕰️', 'Time Traveller', w, `sang a song from ${w.oldest}`);
  w = top(p => p.duets, 2); add('🤝', 'Duet Darling', w, w && `${w.duets} duets`);
  w = top(p => p.passes, 2); add('🙈', 'Fashionably Late', w, w && `passed ${w.passes} times`);
  const firsts = sung[0]; if (firsts) out.push({ icon: '🚀', title: 'Opening Act', name: firsts.with ? `${firsts.singer} & ${firsts.with}` : firsts.singer, why: 'first on stage tonight' });
  return out;
}

// Tonight in numbers. partyStart = when the first song of the night started (durations tick live on screens).
function nightStats(s) {
  const tonight = s.history.filter(h => h.endedAt >= s.nightStartedAt);
  const sung = tonight.filter(h => !h.skipped);
  if (!sung.length && !s.current) return null;
  const secsOf = h => (h.startedAt ? Math.min((h.endedAt - h.startedAt) / 1000, 1500) : (h.duration || 0));
  const singers = new Set();
  for (const h of sung) for (const n of [h.singer, h.with].filter(Boolean)) singers.add(norm(n));
  if (s.current) for (const n of [s.current.singer, s.current.with].filter(Boolean)) singers.add(norm(n));
  const starts = [...tonight.map(h => h.startedAt), s.current && s.current.startedAt].filter(Boolean);
  const longest = sung.reduce((b, h) => (secsOf(h) > (b ? secsOf(b) : 0) ? h : b), null);
  return {
    partyStart: starts.length ? Math.min(...starts) : Date.now(),
    songs: sung.length,
    skipped: tonight.length - sung.length,
    singers: singers.size,
    singSecs: Math.round(sung.reduce((a, h) => a + secsOf(h), 0)),
    reacts: sung.reduce((a, h) => a + (h.reacts || 0), 0) + ((s.current && s.current.reacts) || 0),
    longest: longest ? { title: longest.title, who: longest.with ? `${longest.singer} & ${longest.with}` : longest.singer, secs: Math.round(secsOf(longest)) } : null,
    queueSecs: s.queue.reduce((a, it) => a + (it.duration || 210) + (s.settings.countdown || 0), 0),
    queueSongs: s.queue.length,
  };
}

// Most-sung songs on THIS machine across every night (no accounts needed): the house favourites.
function houseFaves(lines, limit = 12) {
  const by = new Map();
  for (const l of lines) {
    const k = l.videoId; if (!k) continue;
    const e = by.get(k) || { videoId: k, title: l.title, genre: l.genre, n: 0, singers: new Set(), last: 0 };
    e.n++; e.singers.add(l.singer); e.last = Math.max(e.last, l.at || 0); by.set(k, e);
  }
  return [...by.values()].sort((a, b) => b.n - a.n || b.last - a.last).slice(0, limit)
    .map(e => ({ videoId: e.videoId, title: e.title, genre: e.genre, n: e.n, singers: e.singers.size }));
}

// Personal stats across all nights, from the permanent sung log.
function personalStats(lines, name) {
  const k = norm(name);
  const mine = lines.filter(l => norm(l.singer) === k || norm(l.with) === k);
  if (!mine.length) return { name, songs: 0 };
  const count = (arr, f) => { const m = {}; for (const x of arr) { const v = f(x); if (v) m[v] = (m[v] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const songs = count(mine, l => l.title);
  return {
    name, songs: mine.length,
    stageSecs: Math.round(mine.reduce((a, l) => a + (l.startedAt ? Math.min((l.at - l.startedAt) / 1000, 1500) : 0), 0)),
    nights: new Set(mine.map(l => l.night)).size,
    since: Math.min(...mine.map(l => l.at)),
    topSongs: songs.slice(0, 5).map(([title, n]) => ({ title, n, videoId: (mine.find(l => l.title === title) || {}).videoId })),
    genres: count(mine, l => l.genre).slice(0, 5).map(([g, n]) => ({ g, n })),
    decades: count(mine, l => l.year && `${Math.floor(l.year / 10) * 10}s`).slice(0, 4).map(([d, n]) => ({ d, n })),
    duets: count(mine.filter(l => l.with), l => norm(l.singer) === k ? l.with : l.singer).slice(0, 3).map(([p, n]) => ({ p, n })),
  };
}

// Tonight's mix: genres and decades of the songs actually sung.
function mix(s) {
  const g = {}, d = {};
  for (const h of s.history) {
    if (h.endedAt < s.nightStartedAt || h.skipped) continue;
    if (h.genre) g[h.genre] = (g[h.genre] || 0) + 1;
    if (h.year) { const dec = `${Math.floor(h.year / 10) * 10}s`; d[dec] = (d[dec] || 0) + 1; }
  }
  const sort = o => Object.entries(o).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n);
  return { genres: sort(g), decades: sort(d) };
}


module.exports = { readSungLog, tonightBySinger, awards, nightStats, houseFaves, personalStats, mix };
