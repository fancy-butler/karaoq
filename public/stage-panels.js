'use strict';
// TV-screen panels and extras that sit on top of the player (stage.js):
// "Restart to update", 📝 synced lyrics, ✅ pre-party check, 🎤 microphones, 💾 karaoke library.
(() => {
  const { $, app, vid, toast } = KQStage;
  const unlockAudio = () => KQStage.unlockAudio();

  // ---------- "Restart to update" (desktop app only: the app tells us when a new version has downloaded) ----------
  let updVer = null;
  window.KQUpdateReady = v => {
    updVer = v;
    $('#updBtn').hidden = false; $('#updBtn').textContent = `⬆ Restart to update (v${v})`;
    $('#updPill span').textContent = `v${v}`;
    syncUpdPill();
  };
  // only offered between songs, never mid-song
  function syncUpdPill() { $('#updPill').hidden = !(updVer && KQ.state && KQ.state.phase === 'idle'); }
  function restartToUpdate() {
    if (!updVer) return;
    const busy = KQ.state && KQ.state.phase !== 'idle';
    if (!confirm(`Install KARAO-Q v${updVer} now? It takes a few seconds and reopens by itself.${busy ? '\n\nThe current song will stop — the queue is saved.' : ''}`)) return;
    toast('Updating… back in a few seconds');
    window.open('karaoq:update');
  }
  $('#updPill').onclick = restartToUpdate;
  KQ.on('state', syncUpdPill);

  // ---------- 📝 synced lyrics (LRCLIB) for songs that aren't karaoke videos ----------
  let lyr = null, lyrFor = null, lyrOffset = 0;
  function syncLyrics(st) {
    const c = st.current;
    const want = c && c.lyr === 'ready' && !c.lyrHide && (st.phase === 'playing' || st.phase === 'paused') ? c.videoId : null;
    if (want !== lyrFor) {
      lyrFor = want; lyr = null; lyrOffset = 0; $('#lyrics').hidden = true;
      if (want) fetch(`/media/${want}.lrc.json`).then(r => r.ok ? r.json() : null).then(j => { if (j && lyrFor === want) { lyr = j; $('#lyrics .src').textContent = `Lyrics: LRCLIB · ${j.source || ''} · , and . to nudge timing`; $('#lyrics').hidden = false; } }).catch(() => { });
    }
  }
  KQ.on('state', syncLyrics);
  (function lyrLoop() {
    requestAnimationFrame(lyrLoop);
    if (!lyr || $('#lyrics').hidden) return;
    const t = vid.currentTime + lyrOffset, L = lyr.lines;
    let i = -1; for (let k = 0; k < L.length; k++) { if (L[k].t <= t) i = k; else break; }
    const cur = i >= 0 ? L[i] : null, nxt = L[i + 1];
    let curText = cur ? cur.text : '';
    // long instrumental gap: show a countdown bar to the next line instead of a stale line
    if ((!curText || (nxt && nxt.t - t > 6 && t - (cur ? cur.t : 0) > 8)) && nxt) {
      const from = cur ? cur.t : 0, pct = Math.max(0, Math.min(100, 100 * (t - from) / Math.max(1, nxt.t - from)));
      if (nxt.t - t < 8) curText = `<span class="bar"><i style="width:${pct.toFixed(1)}%"></i></span>`; else curText = '♪';
    } else curText = KQ.esc(curText);
    const set = (sel, html) => { const el = $(`#lyrics ${sel}`); if (el._h !== html) { el._h = html; el.innerHTML = html; } };
    set('.prev', i > 0 ? KQ.esc(L[i - 1].text) : '');
    set('.cur', curText);
    set('.next', nxt ? KQ.esc(nxt.text) : '');
  })();

  // ---------- ✅ pre-party check ----------
  let pf = null, pfBusy = false, toneHeard = null;
  async function runPreflight() {
    if (pfBusy) return; pfBusy = true;
    $('#pfList').innerHTML = '<div class="c wait"><span class="i">⏳</span><b>Checking… (YouTube takes up to a minute)</b></div>';
    try { pf = await (await fetch('/api/preflight')).json(); } catch (e) { pf = { checks: [{ id: 'server', ok: false, title: 'KARAO-Q server', detail: e.message, fix: 'Restart KARAO-Q.' }] }; }
    pfBusy = false; renderPreflight();
  }
  function renderPreflight() {
    if (!pf || !app.classList.contains('pf')) return;
    const st = KQ.state || {}, split = st.phoneSplit || { wifi: 0, net: 0 };
    const rows = pf.checks.map(c => {
      let ok = c.ok, detail = c.detail;
      if (c.id === 'wifi' && split.wifi > 0) { ok = true; detail = `${split.wifi} phone${split.wifi > 1 ? 's' : ''} joined over Wi-Fi ✓`; }
      if (c.id === 'net' && c.ok === true && split.net > 0) detail += ` · ${split.net} phone${split.net > 1 ? 's' : ''} using it`;
      return { ...c, ok, detail };
    });
    // things only the TV can check
    const out = KQMic.cfg.out ? 'chosen speakers' : 'system default speakers';
    rows.push({ id: 'speakers', ok: toneHeard === null ? 'wait' : toneHeard, title: 'Speakers', detail: toneHeard === null ? `Press "🔊 Test the speakers" — you should hear a chord from the ${out}` : toneHeard ? 'Heard ✓' : 'Not heard', fix: toneHeard === false ? 'Check the cable/volume, or pick the right output in ☰ → 🎤 Microphones → Speakers.' : '' });
    const m = (st.settings || {}).mic || {};
    if (m.on) rows.push({ id: 'mics', ok: 'wait', title: 'Microphones', detail: 'On — press "🎤 Check the mics" to see their levels', fix: '' });
    const icon = ok => ok === true ? '✅' : ok === 'skip' ? '➖' : ok === 'wait' ? '👉' : '❌';
    const cls = ok => ok === true ? 'ok' : ok === 'wait' ? 'wait' : ok === 'skip' ? '' : 'bad';
    $('#pfList').innerHTML = rows.map(c => `<div class="c ${cls(c.ok)}"><span class="i">${icon(c.ok)}</span><b>${KQ.esc(c.title)}</b><span class="d">${KQ.esc(c.detail || '')}</span>${c.fix && (c.ok === false || c.ok === 'wait') ? `<span class="f">${KQ.esc(c.fix)}</span>` : ''}</div>`).join('');
  }
  KQ.on('state', renderPreflight);
  $('#pfRun').onclick = runPreflight;
  $('#pfMics').onclick = () => { app.classList.remove('pf'); app.classList.add('mics'); micRefresh(); };
  $('#pfTone').onclick = async () => {
    unlockAudio();
    const audioCtx = KQStage.audioCtx;
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + 0.05;
    for (const f of [261.6, 329.6, 392, 523.3]) { // C major chord, 1.5 s
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
      o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 1.6);
    }
    setTimeout(() => { toneHeard = confirm('Did you hear the chord from the speakers?\n\nOK = yes, Cancel = no'); renderPreflight(); }, 1800);
  };
  $('#pfPanel').onclick = e => { if (e.target.closest('[data-pfx]')) app.classList.remove('pf'); };

  // ---------- 🎤 microphones (see mic.js) ----------
  const micS = () => ({ on: false, vol: [0.8, 0.8], reverb: 0.25, echo: 0.1, master: 0.9, ...((KQ.state && KQ.state.settings.mic) || {}) });
  let micErr = ['', ''];
  KQMic.onError = (i, e) => { micErr[i] = e.name === 'NotAllowedError' ? 'not allowed to use the mic' : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'device not found — unplugged?' : (e.message || e.name); micNoteUpdate(); };
  const sendMic = (() => { let t = null, pend = {}; return p => { pend = { ...pend, ...p }; clearTimeout(t); t = setTimeout(() => { KQ.act('settings', { settings: { mic: pend } }); pend = {}; }, 120); }; })();
  KQ.on('state', st => { if (st.settings && st.settings.mic) KQMic.setParams(st.settings.mic); syncMicControls(); });
  function syncMicControls() {
    if (!app.classList.contains('mics')) return;
    const m = micS();
    $('#micOn').checked = m.on;
    for (const [id, v] of [['vol0', m.vol[0]], ['vol1', m.vol[1]], ['micRev', m.reverb], ['micEcho', m.echo], ['micMaster', m.master]]) if (document.activeElement !== $('#' + id)) $('#' + id).value = v;
  }
  function micNoteUpdate() {
    const lat = KQMic.latencyMs();
    $('#micNote').textContent = !KQMic.supported() ? 'Mics only work in the KARAO-Q app on this computer (browsers only allow microphones on secure pages).'
      : [micErr[0] && `Mic 1: ${micErr[0]}`, micErr[1] && `Mic 2: ${micErr[1]}`, lat != null && micS().on ? `Delay through the computer: about ${lat} ms${lat > 30 ? ' — noticeable; use direct monitoring for the dry voice' : ''}` : ''].filter(Boolean).join(' · ');
  }
  async function micRefresh() {
    syncMicControls(); micNoteUpdate();
    if (!KQMic.supported()) return;
    const { inputs, outputs } = await KQMic.devices();
    const c = KQMic.cfg;
    const opts = (list, sel, first) => first + list.map(d => `<option value="${KQ.esc(d.deviceId)}" ${d.deviceId === sel ? 'selected' : ''}>${KQ.esc(d.label || 'Unnamed device')}</option>`).join('');
    $('#mic1').innerHTML = opts(inputs.filter(d => d.deviceId !== 'communications'), c.slots[0].id, `<option value="" ${!c.slots[0].id ? 'selected' : ''}>Default input</option>`);
    $('#mic2').innerHTML = opts(inputs.filter(d => d.deviceId !== 'communications' && d.deviceId !== 'default'), c.slots[1].id, `<option value="" ${!c.slots[1].id ? 'selected' : ''}>— off —</option>`);
    $('#mic1ch').value = c.slots[0].ch || 'both'; $('#mic2ch').value = c.slots[1].ch || 'both';
    $('#micOut').innerHTML = opts(outputs.filter(d => d.deviceId !== 'communications'), c.out, `<option value="" ${!c.out ? 'selected' : ''}>System default</option>`);
  }
  (function meterLoop() {
    requestAnimationFrame(meterLoop);
    if (!app.classList.contains('mics')) return;
    KQMic.levels().forEach((v, i) => { const el = $('#lv' + i); if (el) el.style.width = `${Math.round((v || 0) * 100)}%`; });
  })();
  $('#micOn').onchange = e => sendMic({ on: e.target.checked });
  $('#vol0').oninput = e => sendMic({ vol: [Number(e.target.value), micS().vol[1]] });
  $('#vol1').oninput = e => sendMic({ vol: [micS().vol[0], Number(e.target.value)] });
  $('#micRev').oninput = e => sendMic({ reverb: Number(e.target.value) });
  $('#micEcho').oninput = e => sendMic({ echo: Number(e.target.value) });
  $('#micMaster').oninput = e => sendMic({ master: Number(e.target.value) });
  $('#mic1').onchange = e => { micErr[0] = ''; KQMic.setSlot(0, { id: e.target.value }).then(micNoteUpdate); };
  $('#mic2').onchange = e => { micErr[1] = ''; KQMic.setSlot(1, { id: e.target.value }).then(micNoteUpdate); };
  $('#mic1ch').onchange = e => KQMic.setSlot(0, { ch: e.target.value });
  $('#mic2ch').onchange = e => KQMic.setSlot(1, { ch: e.target.value });
  // speakers: everything (song, key change, mics, chime) goes to the chosen output
  const outTargets = () => [vid, KQStage.keyCtx, KQStage.audioCtx].filter(Boolean);
  $('#micOut').onchange = e => KQMic.setOutput(e.target.value, outTargets());
  if (KQMic.cfg.out) setTimeout(() => KQMic.setOutput(KQMic.cfg.out, outTargets()), 500);
  $('#micPanel').onclick = e => { if (e.target.closest('[data-micx]')) app.classList.remove('mics'); };

  // ---------- 💾 karaoke library (folders on this computer) ----------
  const inApp = /Electron/.test(navigator.userAgent);
  let libTimer = null;
  async function libRefresh() {
    let info; try { info = await (await fetch('/api/library')).json(); } catch { return; }
    $('#libDirs').innerHTML = info.dirs.length ? info.dirs.map(d => `<div class="d ${d.ok ? '' : 'bad'}"><span class="p">${KQ.esc(d.dir)}</span><span class="n">${d.ok ? `${d.songs.toLocaleString()} songs` : 'not found — drive unplugged?'}</span><button data-librm="${KQ.esc(d.dir)}" title="Stop using this folder (files aren't touched)">Remove</button></div>`).join('')
      : '<p class="fine">No folders yet.</p>';
    $('#libNote').textContent = info.scanning ? 'Scanning… songs appear in search as soon as it finishes.' : info.total ? `${info.total.toLocaleString()} songs ready to search.` : '';
    $('#libAdd').hidden = !inApp;
    if (!inApp) $('#libNote').textContent += ' To add folders here, open KARAO-Q on this computer — or for Docker/NAS, mount the folder and set KQ_LIBRARY (see README).';
    clearTimeout(libTimer); if (info.scanning && app.classList.contains('lib')) libTimer = setTimeout(libRefresh, 1500);
  }
  window.KQLibraryChanged = libRefresh; // the desktop app calls this after a folder is picked
  $('#libAdd').onclick = () => window.open('karaoq:pickfolder');
  $('#libScan').onclick = () => fetch('/api/library/rescan', { method: 'POST' }).then(() => setTimeout(libRefresh, 300));
  $('#libPanel').onclick = e => {
    if (e.target.closest('[data-libx]')) return app.classList.remove('lib');
    const rm = e.target.closest('[data-librm]'); if (!rm) return;
    if (!confirm(`Stop using ${rm.dataset.librm}? Your files aren't touched.`)) return;
    fetch('/api/library/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: rm.dataset.librm }) }).then(libRefresh);
  };


  // opened from the ☰ menu (stage.js asks; true = handled)
  KQStage.panels = {
    open(m) {
      if (m === 'update') { restartToUpdate(); return true; }
      if (m === 'library') { app.classList.add('lib'); libRefresh(); return true; }
      if (m === 'mics') { app.classList.add('mics'); micRefresh(); return true; }
      if (m === 'preflight') { app.classList.add('pf'); runPreflight(); return true; }
      return false;
    },
    onKey(k) {
      if ((k === ',' || k === '.') && lyr) { lyrOffset += k === '.' ? 0.5 : -0.5; toast(`Lyrics timing ${lyrOffset > 0 ? '+' : ''}${lyrOffset.toFixed(1)} s`); return true; }
      return false;
    },
  };
})();
