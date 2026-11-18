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
  window.KQUpdateStatus = msg => toast(msg);
  function restartToUpdate() {
    if (!updVer) { // nothing downloaded yet: check now (desktop app), or point a browser at the download page
      if (/Electron/.test(navigator.userAgent)) { toast('Checking for updates…'); window.open('karaoq:checkupdate'); }
      else toast('Updates come through the KARAO-Q desktop app — or grab the latest from github.com/fancy-butler/karaoq/releases');
      return;
    }
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
    // a line too long for its space gets a smaller font — never cut off (current line: up to 3 rows, others 2)
    const fit = (el, rows) => {
      el.style.fontSize = '';
      let fs = parseFloat(getComputedStyle(el).fontSize);
      const lh = () => parseFloat(getComputedStyle(el).lineHeight) || fs * 1.25;
      while (fs > 14 && el.scrollHeight > lh() * rows + 2) { fs = Math.floor(fs * 0.9); el.style.fontSize = fs + 'px'; }
    };
    const set = (sel, html) => { const el = $(`#lyrics ${sel}`); if (el._h !== html || el._w !== el.clientWidth) { el._h = html; el._w = el.clientWidth; el.innerHTML = html; fit(el, sel === '.cur' ? 3 : 2); } };
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
  const N = KQMic.N;
  const micS = () => { const m = { on: false, fxOnly: false, reverb: 0.25, echo: 0.1, master: 0.9, ...((KQ.state && KQ.state.settings.mic) || {}) }; m.vol = Array.from({ length: N }, (_, i) => (m.vol || [])[i] ?? 0.8); return m; };
  const micErr = Array(N).fill('');
  KQMic.onError = (i, e) => { micErr[i] = e.name === 'NotAllowedError' ? 'not allowed to use the mic' : e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? 'device not found — unplugged?' : (e.message || e.name); micNoteUpdate(); };
  const sendMic = (() => { let t = null, pend = {}; return p => { pend = { ...pend, ...p }; clearTimeout(t); t = setTimeout(() => { KQ.act('settings', { settings: { mic: pend } }); pend = {}; }, 120); }; })();
  KQ.on('state', st => { if (st.settings && st.settings.mic) KQMic.setParams(st.settings.mic); syncMicControls(); });
  // one row per mic: device · which input · level meter · volume
  $('#micRows').innerHTML = Array.from({ length: N }, (_, i) => `<div class="mrow"><b>Mic ${i + 1}</b><select data-mdev="${i}"></select><select data-mch="${i}"></select><div class="meter"><i id="lv${i}"></i></div><input type="range" data-mvol="${i}" min="0" max="3" step="0.05" title="Volume (up to 3× for quiet mics)"></div>`).join('');
  function syncMicControls() {
    if (!app.classList.contains('mics')) return;
    const m = micS();
    $('#micOn').checked = m.on;
    $('#micFxOnly').checked = !!m.fxOnly;
    document.querySelectorAll('[data-mvol]').forEach(el => { if (document.activeElement !== el) el.value = m.vol[el.dataset.mvol]; });
    for (const [id, v] of [['micRev', m.reverb], ['micEcho', m.echo], ['micMaster', m.master]]) if (document.activeElement !== $('#' + id)) $('#' + id).value = v;
  }
  function micNoteUpdate() {
    const lat = KQMic.latencyMs();
    $('#micNote').textContent = !KQMic.supported() ? 'Mics only work in the KARAO-Q app on this computer (browsers only allow microphones on secure pages).'
      : [...micErr.map((e, i) => e && `Mic ${i + 1}: ${e}`), lat != null && micS().on ? `Delay through the computer: more than ${lat} ms (that's the output side only — the input adds more). If singers notice it, tick Effects only${micS().fxOnly ? ' (effects only — the dry voice comes from your interface)' : ''}` : ''].filter(Boolean).join(' · ');
  }
  const chOpts = (n, sel) => {
    const list = [['both', n > 2 ? 'inputs 1 + 2' : 'both channels'], ...Array.from({ length: n }, (_, k) => [String(k + 1), `input ${k + 1} only`])];
    const cur = sel === 'L' ? '1' : sel === 'R' ? '2' : String(sel || 'both');
    return list.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
  };
  async function fillChannels(i) {
    const c = KQMic.cfg.slots[i], sel = document.querySelector(`[data-mch="${i}"]`);
    if (i > 0 && !c.id) { sel.innerHTML = '<option>—</option>'; sel.disabled = true; return; }
    sel.disabled = false;
    sel.innerHTML = chOpts(2, c.ch);
    const n = await KQMic.probeChannels(c.id);
    sel.innerHTML = chOpts(n, c.ch);
  }
  async function micRefresh() {
    syncMicControls(); micNoteUpdate();
    if (!KQMic.supported()) return;
    const { inputs, outputs } = await KQMic.devices();
    const c = KQMic.cfg;
    const opts = (list, sel, first) => first + list.map(d => `<option value="${KQ.esc(d.deviceId)}" ${d.deviceId === sel ? 'selected' : ''}>${KQ.esc(d.label || 'Unnamed device')}</option>`).join('');
    const ins = inputs.filter(d => d.deviceId !== 'communications');
    document.querySelectorAll('[data-mdev]').forEach(el => {
      const i = Number(el.dataset.mdev), cur = c.slots[i].id;
      el.innerHTML = i === 0 ? opts(ins, cur, `<option value="" ${!cur ? 'selected' : ''}>Default input</option>`)
        : opts(ins.filter(d => d.deviceId !== 'default'), cur, `<option value="" ${!cur ? 'selected' : ''}>— off —</option>`);
    });
    for (let i = 0; i < N; i++) fillChannels(i);
    $('#micOut').innerHTML = opts(outputs.filter(d => d.deviceId !== 'communications'), c.out, `<option value="" ${!c.out ? 'selected' : ''}>System default</option>`);
  }
  (function meterLoop() {
    requestAnimationFrame(meterLoop);
    if (!app.classList.contains('mics')) return;
    KQMic.levels().forEach((v, i) => { const el = $('#lv' + i); if (el) el.style.width = `${Math.round((v || 0) * 100)}%`; });
  })();
  $('#micOn').onchange = e => sendMic({ on: e.target.checked });
  $('#micFxOnly').onchange = e => sendMic({ fxOnly: e.target.checked });
  $('#micRows').addEventListener('input', e => {
    const v = e.target.closest('[data-mvol]'); if (!v) return;
    const vol = micS().vol.slice(); vol[v.dataset.mvol] = Number(v.value); sendMic({ vol });
  });
  $('#micRows').addEventListener('change', e => {
    const d = e.target.closest('[data-mdev]'), ch = e.target.closest('[data-mch]');
    if (d) { const i = Number(d.dataset.mdev); micErr[i] = ''; KQMic.setSlot(i, { id: d.value }).then(() => { fillChannels(i); micNoteUpdate(); }); }
    if (ch) KQMic.setSlot(Number(ch.dataset.mch), { ch: ch.value });
  });
  $('#micRev').oninput = e => sendMic({ reverb: Number(e.target.value) });
  $('#micEcho').oninput = e => sendMic({ echo: Number(e.target.value) });
  $('#micMaster').oninput = e => sendMic({ master: Number(e.target.value) });
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


  window.KQReportSaved = file => toast(`🐞 Saved to Downloads: ${file.split(/[\\/]/).pop()} — send that file to whoever's fixing it`);

  // opened from the ☰ menu (stage.js asks; true = handled)
  KQStage.panels = {
    open(m) {
      if (m === 'update') { restartToUpdate(); return true; }
      if (m === 'report') {
        if (/Electron/.test(navigator.userAgent)) { toast('Saving a bug report…'); window.open('karaoq:report'); }
        else toast('Bug reports are saved from the KARAO-Q app. For Docker: docker logs karaoq > karaoq.log', 'bad');
        return true;
      }
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
