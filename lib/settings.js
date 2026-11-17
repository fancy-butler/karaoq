'use strict';
// Party settings: what each one is allowed to be. Anything out of range or junk is clamped or ignored,
// so a bad request from a phone can never put the party into a weird state.
const THEMES = ['neon', 'synthwave', 'divebar', 'arcade', 'minimal', 'amber', 'cabinet', 'desk92', 'desk95', 'aero', 'rhythm', 'graffiti', 'hall', 'laser', 'diner'];
const BOOLS = ['skinFx', 'fair', 'showQr', 'showNext', 'genreRows', 'streamFirst', 'lyricsWarn', 'autoLyrics', 'levelVolume', 'oledCare', 'introCard'];
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

// Returns a new settings object: `cur` with the valid parts of `incoming` applied.
function applySettings(cur, incoming = {}, defaults = {}) {
  const st = incoming && typeof incoming === 'object' ? incoming : {};
  const out = { ...cur };
  if (st.countdown !== undefined) out.countdown = clamp(Number(st.countdown) | 0, 0, 120, cur.countdown);
  for (const k of BOOLS) if (st[k] !== undefined) out[k] = !!st[k];
  if (st.theme !== undefined && THEMES.includes(st.theme)) out.theme = st.theme;
  if (st.maxPerPerson !== undefined) out.maxPerPerson = clamp(Number(st.maxPerPerson) | 0, 0, 10, 0);
  if (st.cacheGB !== undefined) out.cacheGB = clamp(Number(st.cacheGB) || 5, 1, 200, 5);
  if (st.mic && typeof st.mic === 'object') { // 🎤 mics through the TV computer's sound card
    const c = (v, d) => clamp(v, 0, 1.5, d);
    const m = { ...(defaults.mic || {}), ...(cur.mic || {}) }, n = st.mic;
    out.mic = {
      on: n.on !== undefined ? !!n.on : !!m.on,
      fxOnly: n.fxOnly !== undefined ? !!n.fxOnly : !!m.fxOnly,
      // up to 4 mics; each up to 3× (quiet dynamic mics)
      vol: [0, 1, 2, 3].map(i => clamp(n.vol && n.vol[i] !== undefined ? n.vol[i] : (m.vol || [])[i], 0, 3, 0.8)),
      reverb: c(n.reverb ?? m.reverb, 0.25), echo: c(n.echo ?? m.echo, 0.1), master: c(n.master ?? m.master, 0.9),
    };
  }
  return out;
}

module.exports = { applySettings, THEMES };
