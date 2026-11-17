(() => {
  const { act, esc, fmt, clean, thumb, dlLabel, toast, ls, now, who, keyLabel, genreChip, mixHtml, GENRES, avatar, avatars, PRESETS } = KQ;
  const isFave = (singer, videoId) => !!((KQ.state?.faves || {})[String(singer || '').trim().toLowerCase()]?.songs || []).find(f => f.videoId === videoId);
  const $ = s => document.querySelector(s);
  if (new URLSearchParams(location.search).has('embed')) document.body.classList.add('embed');

  let myName = ls.get('kq.name') || '';
  let recent = JSON.parse(ls.get('kq.recentNames') || '[]');
  let progress = null; // { itemId, t, d, at }
  let lastResults = [];

  // ---------- name ----------
  function setName(n) {
    myName = n; ls.set('kq.name', n); renderMe();
    remember(n);
  }
  function renderMe() {
    const host = KQ.you && KQ.you.isHost && KQ.you.hostMode === 'hosted';
    $('#meBtn').innerHTML = myName ? `${avatar(myName, 's')}<b id="meName">${esc(myName)}</b>${host ? ' 👑' : ''}` : 'Singing as <b id="meName">set name</b>';
  }
  function remember(n) {
    if (!n) return;
    recent = [n, ...recent.filter(x => x.toLowerCase() !== n.toLowerCase())].slice(0, 8);
    ls.set('kq.recentNames', JSON.stringify(recent));
  }
  function askName(title, prefill, withPartner) {
    return new Promise(res => {
      const dlg = $('#nameDlg');
      $('#nameTitle').textContent = title;
      $('#nameInput').value = prefill || '';
      $('#partnerInput').value = '';
      $('#partnerInput').hidden = !withPartner;
      // Suggest names already in the queue + ones this phone used before
      const st = KQ.state;
      const pool = [...recent, ...(st ? [...st.queue, ...st.held].map(i => i.singer) : [])];
      const uniq = [...new Map(pool.map(n => [n.toLowerCase(), n])).values()].slice(0, 10);
      $('#nameChips').innerHTML = uniq.map(n => `<button type="button" data-n="${esc(n)}">${esc(n)}</button>`).join('');
      // tap a chip: fills the name, or the duet partner if the name is already filled
      $('#nameChips').onclick = e => { const n = e.target.dataset.n; if (!n) return; if (withPartner && $('#nameInput').value.trim() && $('#nameInput').value.trim() !== n) $('#partnerInput').value = n; else $('#nameInput').value = n; };
      dlg.onclose = () => {
        const name = dlg.returnValue === 'ok' ? $('#nameInput').value.trim() : null;
        res(withPartner ? (name ? { name, partner: $('#partnerInput').value.trim() } : null) : name);
      };
      dlg.showModal();
      setTimeout(() => $('#nameInput').focus(), 50);
    });
  }
  $('#meBtn').onclick = () => showJoin();
  $('#nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#nameDlg').close('ok'); } });
  setName(myName);

  // ---------- tabs ----------
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  function showTab(t) {
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    document.querySelectorAll('.tab').forEach(el => el.classList.toggle('on', el.id === 'tab-' + t));
  }

  // add with a friendly "already queued / just sung — add anyway?" check
  // "No lyrics" check: a video whose title doesn't look like karaoke / lyrics / instrumental probably has the
  // original vocals and nothing on screen to sing from. Ask once per video (host can turn this off).
  const KARAOKE_RE = /karaoke|instrumental|lyrics?|backing track|minus ?one|off ?vocal|sing ?a?long|videoke|piano version|no vocals?/i;
  const looksSingable = v => v.local || String(v.videoId || "").startsWith("lc_") || KARAOKE_RE.test(`${v.title || ''} ${v.channel || ''}`);
  const okVids = new Set(JSON.parse(ls.get('kq.okVids') || '[]'));
  // 🎤✂ vocal remover helpers
  let vocalEngine = 'quick';
  fetch('/api/about').then(r => r.json()).then(j => { if (j.vocals) vocalEngine = j.vocals.engine; }).catch(() => { });
  const vocalHint = () => vocalEngine === 'demucs' ? '(AI — takes about as long as the song)' : '(quick — a few seconds)';
  const novoxState = nv => nv.state === 'ready' ? 'ready' : nv.state === 'error' ? 'failed — plays original' : nv.state === 'downloading' ? `${nv.pct || 0}%` : 'waiting';
  const novoxLabel = c => !c.novox ? '🎤✂ Remove' : c.nv && c.nv.state === 'ready' ? '✂ Removed — undo' : `✂ ${novoxState(c.nv || {})}`;
  // "doesn't look like karaoke" → Add anyway / Add with vocals removed / Cancel
  const askNoLyrics = v => new Promise(res => sheet(`<h3>Not a karaoke video?</h3><p class="hint">“${esc(v.title)}” doesn't look like a karaoke version — it probably has the original singer's vocals${lyricsOn() ? ' (KARAO-Q will try to show lyrics on screen)' : ' and no lyrics on screen'}.</p>
      <button data-a="novox" class="gold">🎤✂ Add it with the vocals removed</button><button data-a="plain">Add it as it is</button><button data-a="no" class="ghost">Cancel</button>`, a => res(a || 'no')) || $('#sheet').addEventListener('close', () => res('no'), { once: true }));
  const lyricsOn = () => KQ.state && KQ.state.settings.autoLyrics !== false;
  async function addSong(data) {
    const v = data.video || {};
    if (KQ.state && KQ.state.settings.lyricsWarn !== false && !data.trusted && v.videoId && !okVids.has(v.videoId) && v.title && !looksSingable(v)) {
      const how = await askNoLyrics(v);
      if (how === 'no' || how === 'close') return { ok: false, cancelled: true };
      if (how === 'novox') data = { ...data, novox: true };
      else { okVids.add(v.videoId); ls.set('kq.okVids', JSON.stringify([...okVids].slice(-200))); }
    }
    let r = await act('add', data);
    if (!r.ok && r.dup && confirm(`${r.error}.\n\nAdd it anyway?`)) r = await act('add', { ...data, force: true });
    return r;
  }

  // ---------- search suggestions: recent searches, party classics, 🎲 roulette ----------
  let recentQ = JSON.parse(ls.get('kq.recentQ') || '[]');
  let classics = [];
  const searchFor = q => { $('#q').value = q; $('#searchForm').requestSubmit ? $('#searchForm').requestSubmit() : $('#searchForm').onsubmit(new Event('submit')); };
  // House favourites: most-sung on this machine across all nights. Tapping one adds that exact video.
  let house = [];
  function loadHouse() {
    fetch('/api/house').then(r => r.json()).then(list => {
      house = list.filter(h => h.n >= 2 || list.length >= 5).slice(0, 10);
      $('#houseBox').hidden = !house.length;
      $('#house').innerHTML = house.map((h, i) => `<div class="item hf" style="--g:${KQ.gColor(h.genre)}"><img loading="lazy" src="${esc(thumb(h))}" alt=""><div class="meta"><div class="t">${esc(clean(h.title))}</div><div class="s">${h.genre ? KQ.genreChip(h) : ''}sung ${h.n}× · by ${h.singers} ${h.singers === 1 ? 'person' : 'people'}</div></div><div class="acts"><button class="ghost" data-hfor="${i}" title="Add for someone else">👤</button><button data-hadd="${i}" title="Add">＋</button></div></div>`).join('');
    }).catch(() => { });
  }
  $('#house').onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const h = house[b.dataset.hadd ?? b.dataset.hfor]; if (!h) return;
    let singer = myName, partner = '';
    if (b.dataset.hfor !== undefined) { const r = await askName('Who is singing this one?', '', true); if (!r) return; singer = r.name; partner = r.partner; }
    else if (!singer) return showJoin();
    const r = await addSong({ video: { videoId: h.videoId, title: h.title }, singer, with: partner, trusted: true });
    r.ok ? toast(`Added for ${partner ? singer + ' & ' + partner : singer} — #${r.position} in line`) : toast(r.error, 'bad');
  };

  // 🎯 For you: suggestions for whoever this phone is, from what they've sung here + what's queued.
  // Pool picks search YouTube when tapped; "sung alongside" picks are exact videos and add in one tap.
  let fy = null, fySig = '';
  function loadForYou() {
    if (!myName) { $('#fyBox').hidden = true; return; }
    fetch('/api/foryou?name=' + encodeURIComponent(myName)).then(r => r.json()).then(r => {
      fy = r;
      $('#fyBox').hidden = !!r.empty || (!r.picks.length && !r.alongside.length);
      if (r.empty) return;
      $('#fyHead').textContent = `🎯 For you, ${myName.split(' ')[0]}`;
      const G = r.basis.genres.map(g => (KQ.GENRES[g] || [g])[0]);
      const bits = [G.join(' & '), r.basis.decades.join('')].filter(Boolean);
      $('#fyBasis').textContent = bits.length ? `Because you've been singing ${bits.join(' from the ')}` : 'Based on what you sing';
      $('#fyPicks').innerHTML = r.picks.map(c => `<button data-q="${esc(c.artist + ' ' + c.title)}" style="--g:${KQ.gColor(c.g)}" class="cl" title="${esc(c.why)}">${esc(c.title)} <small>${esc(c.artist)}${c.y ? ` · ’${String(c.y).slice(2)}` : ''}</small></button>`).join('');
      $('#fyAlong').innerHTML = r.alongside.length ? `<h5>Sung by people who sing what you sing</h5>` + r.alongside.map((h, i) => `<div class="item hf" style="--g:${KQ.gColor(h.genre)}"><img loading="lazy" src="${esc(thumb(h))}" alt=""><div class="meta"><div class="t">${esc(clean(h.title))}</div><div class="s">${h.genre ? KQ.genreChip(h) : ''}${esc(h.why)}</div></div><div class="acts"><button data-fyadd="${i}" title="Add">＋</button></div></div>`).join('') : '';
    }).catch(() => { });
  }
  $('#fyAlong').onclick = async e => {
    const b = e.target.closest('[data-fyadd]'); if (!b || !fy) return;
    const h = fy.alongside[b.dataset.fyadd]; if (!h) return;
    if (!myName) return showJoin();
    const r = await addSong({ video: { videoId: h.videoId, title: h.title }, singer: myName, trusted: true });
    r.ok ? toast(`Added — #${r.position} in line`) : toast(r.error, 'bad');
  };
  // refresh when this singer's songs change (queued, sung, removed)
  KQ.on('state', st => {
    const me = String(myName || '').trim().toLowerCase(); if (!me) return;
    const mineQ = [st.current, ...st.queue].filter(Boolean).filter(i => [i.singer, i.with].some(n => String(n || '').toLowerCase() === me)).map(i => i.videoId + (i.genre || ''));
    const sung = (st.stats || []).find(x => x.singer.toLowerCase() === me);
    const sig = mineQ.join() + '|' + (sung ? sung.sung : 0);
    if (sig !== fySig) { fySig = sig; if (!$('#suggest').hidden) loadForYou(); }
  });

  function showSuggest() {
    $('#suggest').hidden = false; $('#results').innerHTML = ''; lastResults = [];
    loadHouse(); loadForYou();
    $('#recentBox').hidden = !recentQ.length;
    $('#recent').innerHTML = recentQ.map(q => `<button data-q="${esc(q)}">${esc(q)}</button>`).join('');
    renderClassics();
  }
  function renderClassics() {
    const pick = classics.filter(c => !c.rank).sort(() => Math.random() - 0.5).slice(0, 10);
    $('#classics').innerHTML = pick.map(c => `<button data-q="${esc(c.artist + ' ' + c.title)}" style="--g:${KQ.gColor(c.g)}" class="cl">${esc(c.title)} <small>${esc(c.artist)}</small></button>`).join('');
  }
  // Most-sung chart (real karaoke-app data) + our classics; 🎲 spins over both
  let popular = [], popAll = false;
  const decadeOf = c => (c.y ? Math.floor(c.y / 10) * 10 : null);
  function renderPopular() {
    const g = $('#spinGenre').value, d = $('#spinDecade').value;
    const filtering = !!(g || d);
    // no filter: the chart. With a genre/decade: every matching song, chart songs first, then the rest by year
    const pool = filtering
      ? classics.filter(c => (!g || c.g === g) && (!d || decadeOf(c) === Number(d))).sort((a, b) => (a.rank || 999) - (b.rank || 999) || (a.y || 0) - (b.y || 0))
      : popular;
    const list = popAll || filtering ? pool : pool.slice(0, 15);
    const label = [g && (GENRES[g] || [g])[0], d && `${d}s`].filter(Boolean).join(' · ');
    $('#popHead').textContent = filtering ? `🎵 ${label} — ${pool.length} song${pool.length === 1 ? '' : 's'}` : '🔥 Most sung karaoke songs';
    $('#popMore').hidden = filtering;
    // filtered lists always end with a live YouTube search, so there's never a dead end
    const ytQuery = [d && `${d}s`, g && (GENRES[g] || [g])[0].replace(' / ', ' '), 'karaoke'].filter(Boolean).join(' ');
    $('#popYT').hidden = !filtering;
    $('#popYT').textContent = `🔎 More ${label} karaoke on YouTube`;
    $('#popYT').dataset.q = ytQuery;
    if (!list.length) { $('#popular').innerHTML = '<li class="empty">Nothing in our lists for that combo — try YouTube below.</li>'; return; }
    $('#popular').innerHTML = list.map(c => `<li><button data-q="${esc(c.artist + ' ' + c.title)}" style="--g:${KQ.gColor(c.g)}"><em>${c.rank || (c.y ? `’${String(c.y).slice(2)}` : '•')}</em><span>${esc(c.title)}<small>${esc(c.artist)}</small></span></button></li>`).join('');
    $('#popMore').textContent = popAll ? 'Show fewer' : `Show all ${popular.length}`;
  }
  $('#spinGenre').onchange = $('#spinDecade').onchange = () => renderPopular();
  $('#popYT').onclick = e => { e.stopPropagation(); $('#karaoke').checked = false; searchFor(e.target.dataset.q); };
  $('#popMore').onclick = e => { e.stopPropagation(); popAll = !popAll; renderPopular(); };
  const songKey = c => c.title.toLowerCase().replace(/[^a-z0-9]/g, '') + '|' + c.artist.toLowerCase().replace(/^the /, '').split(' ')[0].replace(/[^a-z0-9]/g, '');
  Promise.all([fetch('/api/popular').then(r => r.json()), fetch('/api/more').then(r => r.json()), fetch('/api/classics').then(r => r.json())]).then(([pop, more, list]) => {
    popular = pop.songs;
    const srcs = [{ name: pop.source, url: pop.url }, ...Object.values(more.sources)];
    $('#popCredit').innerHTML = 'Song lists: ' + srcs.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>`).join(' · ');
    renderPopular();
    // browse/spin pool = chart (ranked) + more real lists + our classics, de-duplicated by title + artist
    const seen = new Set(); classics = [];
    for (const c of [...popular, ...more.songs, ...list]) { const k = songKey(c); if (!seen.has(k)) { seen.add(k); classics.push(c); } }
    renderPopular();
    const gs = [...new Set(classics.map(c => c.g))].filter(Boolean);
    $('#spinGenre').innerHTML += gs.map(g => `<option value="${g}">${esc((GENRES[g] || [g])[0])}</option>`).join('');
    const ds = [...new Set(classics.filter(c => c.y).map(c => Math.floor(c.y / 10) * 10))].sort();
    $('#spinDecade').innerHTML += ds.map(d => `<option value="${d}">${d}s</option>`).join('');
    renderClassics();
  }).catch(() => { });
  $('#suggest').onclick = e => { const q = e.target.closest('[data-q]')?.dataset.q; if (q) searchFor(q); };
  $('#reshuffle').onclick = e => { e.stopPropagation(); renderClassics(); };
  $('#spinBtn').onclick = () => {
    const g = $('#spinGenre').value, d = $('#spinDecade').value;
    const pool = classics.filter(c => (!g || c.g === g) && (!d || (c.y && Math.floor(c.y / 10) * 10 === Number(d))));  // songs with no known year skip the decade filter
    if (!pool.length) return toast('Nothing in that combo — try another', 'bad');
    const c = pool[Math.floor(Math.random() * pool.length)];
    toast(`🎲 The wheel says: ${c.title} — ${c.artist}`);
    searchFor(`${c.artist} ${c.title}`);
  };
  $('#q').addEventListener('input', () => { if (!$('#q').value.trim()) showSuggest(); });
  showSuggest();

  // ---------- search ----------
  $('#karaoke').checked = ls.get('kq.karaoke') !== '0';
  $('#karaoke').onchange = () => ls.set('kq.karaoke', $('#karaoke').checked ? '1' : '0');
  $('#searchForm').onsubmit = async e => {
    e.preventDefault();
    const q = $('#q').value.trim();
    if (!q) { showSuggest(); return; }
    $('#q').blur();
    if (!/youtu\.?be/.test(q)) { recentQ = [q, ...recentQ.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 10); ls.set('kq.recentQ', JSON.stringify(recentQ)); }
    $('#suggest').hidden = true;
    const box = $('#results');
    box.innerHTML = '<p class="hint">Searching…</p>';
    try {
      const isLink = /youtu\.?be/.test(q);
      const url = isLink ? `/api/lookup?url=${encodeURIComponent(q)}` : `/api/search?q=${encodeURIComponent(q)}&karaoke=${$('#karaoke').checked ? 1 : 0}`;
      const r = await fetch(url); const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Search failed');
      lastResults = isLink ? [j] : j;
      renderResults();
    } catch (err) { box.innerHTML = `<p class="hint">😬 ${esc(err.message)}</p>`; }
  };
  function renderResults() {
    const box = $('#results');
    if (!lastResults.length) { box.innerHTML = '<p class="hint">Nothing found. Try the artist name too.</p>'; return; }
    const queued = new Set((KQ.state ? [...KQ.state.queue, ...KQ.state.held] : []).map(i => i.videoId));
    box.innerHTML = lastResults.map((v, i) => `
      <div class="item ${queued.has(v.videoId) ? 'added' : ''}">
        <img loading="lazy" src="${esc(thumb(v))}" alt="">
        <div class="meta"><div class="t">${esc(v.title)}</div><div class="s">${esc(v.channel)}${v.duration ? ' · ' + fmt(v.duration) : ''}${queued.has(v.videoId) ? ' · <span class="dl ok">in queue</span>' : ''}${looksSingable(v) ? '' : ' · <span class="dl warn" title="Title doesn\'t say karaoke or lyrics — may have vocals and no lyrics">⚠ maybe no lyrics</span>'}</div></div>
        <div class="acts"><button class="ghost" data-for="${i}" title="Add for someone else">👤</button><button data-add="${i}" title="Add">＋</button></div>
      </div>`).join('');
  }
  $('#results').onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const v = lastResults[b.dataset.add ?? b.dataset.for];
    if (!v) return;
    let singer = myName, partner = '';
    if (b.dataset.for !== undefined) {
      const r = await askName('Who is singing this one?', '', true); if (!r) return;
      singer = r.name; partner = r.partner; remember(singer); if (partner) remember(partner);
    } else if (!singer) { singer = await askName("What's your name?", ''); if (!singer) return; setName(singer); }
    const r = await addSong({ video: v, singer, with: partner });
    if (r.ok) toast(`Added for ${partner ? singer + ' & ' + partner : singer} — #${r.position} in line`);
    else toast(r.error, 'bad');
  };

  // ---------- 🎤 mics (host): live volume / reverb / echo for mics plugged into the TV computer ----------
  $('#micBtn').onclick = () => {
    const m = { on: false, reverb: 0.25, echo: 0.1, master: 0.9, ...(KQ.state.settings.mic || {}) };
    const vols = [0, 1, 2, 3].map(i => (m.vol || [])[i] ?? 0.8);
    const sl = (id, label, v, max = 1.5) => `<label class="mic-sl"><span>${label}</span><input type="range" id="${id}" min="0" max="${max}" step="0.05" value="${v}"></label>`;
    sheet(`<h3>🎤 Mics</h3>
      <label class="toggle"><input type="checkbox" id="pmOn" ${m.on ? 'checked' : ''}> Mics on (through the party computer's speakers)</label>
      <label class="toggle"><input type="checkbox" id="pmFx" ${m.fxOnly ? 'checked' : ''}> Effects only (voice comes from the interface's direct monitor — no delay)</label>
      ${vols.map((v, i) => sl('pmV' + i, 'Mic ' + (i + 1), v, 3)).join('')}${sl('pmRev', 'Reverb', m.reverb, 1)}${sl('pmEcho', 'Echo', m.echo, 1)}${sl('pmAll', 'All mics', m.master)}
      <p class="hint">Which sound card / input is Mic 1 and Mic 2 is picked on the party computer: ☰ Menu → 🎤 Microphones.</p>`, () => { });
    let t = null, pend = {};
    const send = p => { pend = { ...pend, ...p }; clearTimeout(t); t = setTimeout(() => { act('settings', { settings: { mic: pend } }); pend = {}; }, 120); };
    const v = id => Number($('#' + id).value);
    $('#pmOn').onchange = e => send({ on: e.target.checked });
    $('#pmFx').onchange = e => send({ fxOnly: e.target.checked });
    for (let i = 0; i < 4; i++) $('#pmV' + i).oninput = () => send({ vol: [0, 1, 2, 3].map(k => v('pmV' + k)) });
    $('#pmRev').oninput = () => send({ reverb: v('pmRev') });
    $('#pmEcho').oninput = () => send({ echo: v('pmEcho') });
    $('#pmAll').oninput = () => send({ master: v('pmAll') });
  };

  // ---------- night recap card ----------
  $('#recapBtn').onclick = async () => {
    const b = $('#recapBtn'); b.disabled = true; b.textContent = '🎨 Drawing…';
    try {
      const r = await KQRecap.share(KQ.state);
      if (r && r.url) sheet(`<h3>Night recap</h3><img src="${r.url}" alt="Night recap" style="width:100%;border-radius:12px"><a class="btnlink" href="${r.url}" download="${esc(r.name)}">⬇ Save image</a><p class="hint">Or press and hold the picture to save or share it.</p>`, () => { });
    } catch (e) { console.error(e); toast("Couldn't make the card", 'bad'); }
    b.disabled = false; b.textContent = '📸 Make a night recap card';
  };

  // ---------- item action sheet ----------
  function sheet(html, onPick) {
    const dlg = $('#sheet');
    $('#sheetBody').innerHTML = html + '<button class="close" data-a="close">Close</button>';
    $('#sheetBody').onclick = e => { const a = e.target.closest('button')?.dataset.a; if (!a) return; dlg.close(); if (a !== 'close') onPick(a); };
    dlg.showModal();
  }
  dialogDismiss($('#sheet'));
  function dialogDismiss(dlg) { dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); }); }

  async function run(action, data, okMsg) {
    const r = await act(action, data);
    if (!r.ok) toast(r.error, 'bad'); else if (r.note) toast(r.note); else if (okMsg) toast(okMsg);
    return r;
  }

  function pickGenre(it, isCurrent) {
    const cur = it.genre;
    sheet(`<div class="h"><b>Genre for</b><div>${esc(clean(it.title))}</div></div>` +
      Object.entries(GENRES).map(([k, [label, col]]) => `<button data-a="g:${k}" class="gpick ${k === cur ? 'on' : ''}" style="--g:${col}">${esc(label)}</button>`).join('') +
      `<button data-a="g:">🤷 Not sure (clear)</button>`,
      a => run('genre', { id: isCurrent ? undefined : it.id, genre: a.slice(2) || null }, 'Genre updated'));
  }

  // Wrong version (no lyrics, bad audio): show other karaoke versions; picking one keeps their spot
  async function swapVersion(it) {
    toast('Finding other versions…');
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(clean(it.title))}&karaoke=1`); const list = (await r.json()).filter(v => v.videoId !== it.videoId).slice(0, 8);
      if (!list.length) return toast('No other versions found', 'bad');
      sheet(`<div class="h"><b>Other versions</b><div>${esc(who(it))} keeps their spot in line.</div></div>` +
        list.map((v, i) => `<button data-a="${i}" class="verbtn"><img src="${esc(thumb(v))}" alt=""><span>${esc(v.title)}<small>${esc(v.channel)}${v.duration ? ' · ' + fmt(v.duration) : ''}</small></span></button>`).join(''),
        a => run('swap', { id: it.id, video: list[Number(a)] }));
    } catch { toast('Search failed', 'bad'); }
  }

  function itemMenu(it, where) {
    const st = KQ.state, host = KQ.you.isHost, mine = it.clientId === KQ.clientId;
    const can = host || mine;
    const idx = st.queue.findIndex(x => x.id === it.id);
    let b = `<div class="h"><b>${esc(who(it))}</b><div>${esc(clean(it.title))}${it.key ? ` · key ${keyLabel(it.key)}` : ''}</div></div>`;
    if (where === 'queue') {
      if (host && idx > 0) b += `<button data-a="playNext">⏫ Sing next</button>`;
      if (host && idx > 0) b += `<button data-a="up">▲ Move up one</button>`;
      if (host && idx < st.queue.length - 1) b += `<button data-a="down">▼ Move down one</button>`;
      if (can && idx < st.queue.length - 1) b += `<button data-a="defer">🙋 Not here — let the next person go</button>`;
      if (can) b += `<button data-a="hold">🚪 Stepped out — keep song, pull from rotation</button>`;
    } else if (can) b += `<button data-a="back">↩ They're back — put them up next</button>`;
    if (can) b += `<button data-a="keyDown">🎚 Key down (now ${keyLabel(it.key) || '0'})</button><button data-a="keyUp">🎚 Key up (now ${keyLabel(it.key) || '0'})</button>`;
    if (can) b += `<button data-a="novox">${it.novox ? '🎤 Put the vocals back' : '🎤✂ Remove the vocals'}${it.novox && it.nv ? ` <small>(${novoxState(it.nv)})</small>` : ''}</button>`;
    if (can) b += it.lyr === 'ready' && !it.lyrHide ? `<button data-a="lyrOff">📝 Hide the on-screen lyrics</button>`
      : it.lyr === 'looking' ? `<button data-a="noop" disabled>📝 Looking for lyrics…</button>`
      : `<button data-a="lyrOn">📝 ${it.lyr === 'none' ? 'No lyrics found — look again' : 'Show lyrics on screen'}</button>`;
    if (can) b += `<button data-a="genre">🎨 Genre: ${it.genre && GENRES[it.genre] ? esc(GENRES[it.genre][0]) : 'unknown'} — change</button>`;
    if (can) b += `<button data-a="duet">👥 ${it.with ? 'Change / remove duet partner' : 'Make it a duet'}</button>`;
    b += `<button data-a="fave">${isFave(it.singer, it.videoId) ? '★ Remove from' : '⭐ Save to'} ${esc(it.singer)}'s favourites</button>`;
    if (can) b += `<button data-a="swapv">🔁 Wrong version? Pick another</button>`;
    if (it.dl?.state === 'error') b += `<button data-a="retry">🔁 Retry download</button>`;
    if (can) b += `<button data-a="remove" class="warn">🗑 Remove song</button>`;
    if (!can) b += `<div class="h"><div>Only ${esc(it.singer)}'s phone or the host can change this one.</div></div>`;
    sheet(b, async a => {
      if (a === 'keyDown' || a === 'keyUp') return run('key', { id: it.id, delta: a === 'keyUp' ? 1 : -1 });
      if (a === 'genre') return setTimeout(() => pickGenre(it, false), 50);
      if (a === 'lyrOn' || a === 'lyrOff') return run('lyrics', { id: it.id, on: a === 'lyrOn' }, a === 'lyrOn' ? '📝 Looking for lyrics…' : 'Lyrics hidden');
      if (a === 'noop') return;
      if (a === 'novox') return run('novox', { id: it.id, on: !it.novox }, it.novox ? 'Vocals back on' : `Removing vocals ${vocalHint()}`);
      if (a === 'swapv') return setTimeout(() => swapVersion(it), 50);
      if (a === 'fave') return run('fave', { singer: it.singer, video: { ...it } }, isFave(it.singer, it.videoId) ? 'Removed from favourites' : `⭐ Saved to ${it.singer}'s favourites`);
      if (a === 'duet') { const p = prompt(`Who's singing with ${it.singer}? (leave empty for solo)`, it.with || ''); if (p === null) return; return run('duet', { id: it.id, with: p }, p.trim() ? `Duet: ${it.singer} & ${p.trim()}` : 'Back to solo'); }
      if (a === 'up') return run('move', { id: it.id, to: idx - 1 });
      if (a === 'down') return run('move', { id: it.id, to: idx + 1 });
      const w = who(it); const msgs = { defer: `${w} swapped back one spot`, hold: `${w} stepped out — song saved`, back: `${w} up next`, remove: 'Removed', playNext: `${w} up next` };
      run(a, { id: it.id }, msgs[a]);
    });
  }
  $('#queueList').onclick = e => { const el = e.target.closest('[data-id]'); if (!el) return; const it = KQ.state.queue.find(x => x.id === el.dataset.id); if (it) itemMenu(it, 'queue'); };
  $('#heldList').onclick = e => {
    const el = e.target.closest('[data-id]'); if (!el) return;
    const it = KQ.state.held.find(x => x.id === el.dataset.id); if (!it) return;
    if (e.target.closest('.back')) run('back', { id: it.id }, `${who(it)} up next`); else itemMenu(it, 'held');
  };

  // ---------- now card ----------
  $('#now').onclick = e => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return;
    const st = KQ.state;
    if (a === 'skip') { if (!confirm(`Skip ${who(st.current)}'s song?`)) return; }
    if (a.startsWith('react:')) { KQ.send({ type: 'react', emoji: a.slice(6) }); const b = e.target.closest('button'); b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); return; }
    if (a === 'moreReacts') { moreReacts = !moreReacts; return renderNow(st); }
    if (a === 'keyUp' || a === 'keyDown') return run('key', { delta: a === 'keyUp' ? 1 : -1 });
    if (a === 'keyZero') return run('key', { value: 0 }, 'Original key');
    if (a === 'novoxNow') return run('novox', { id: st.current.id, on: !st.current.novox }, st.current.novox ? 'Vocals back on' : `Removing vocals… ${vocalHint()}`);
    if (a === 'genreNow') return pickGenre(st.current, true);
    if (a === 'fave') { const c = st.current; return run('fave', { singer: c.singer, video: { ...c } }, isFave(c.singer, c.videoId) ? 'Removed from favourites' : `⭐ Saved to ${c.singer}'s favourites`); }
    const msgs = { defer: 'Swapped — next person is up', hold: 'Moved to Stepped out' };
    run(a, {}, msgs[a]);
  };

  const REACTS = ['🔥', '👏', '😂', '❤️', '🎉', '🤘', '😍', '😭', '🤯', '🙌', '💃', '🕺', '🎤', '⭐', '💯', '🍻', '🥂', '👑', '🦄', '💀'];
  let moreReacts = false;
  function renderNow(st) {
    const el = $('#now'), host = KQ.you.isHost;
    el.className = '';
    if ((st.phase === 'playing' || st.phase === 'paused') && st.current) {
      const c = st.current, mine = c.clientId === KQ.clientId;
      el.innerHTML = `
        <div class="label">${st.phase === 'paused' ? '⏸ PAUSED' : '● NOW SINGING'}</div>
        <button class="star ${isFave(c.singer, c.videoId) ? 'on' : ''}" data-a="fave" title="Save to favourites">${isFave(c.singer, c.videoId) ? '★' : '☆'}</button>
        <div class="whorow">${avatars(c, 'l')}<div><div class="who">${esc(who(c))}</div><div class="song">${esc(clean(c.title))}</div></div></div>
        ${host || mine ? `<button class="gbtn" data-a="genreNow">${genreChip(c) || '<span class="gchip unknown">＋ genre</span>'}</button>` : genreChip(c)}
        <div class="bar"><i id="pbar"></i></div><div class="times"><span id="ptime"></span><span id="pdur">${fmt(c.duration)}</span></div>
        <div class="reacts">${REACTS.slice(0, 6).map(e => `<button data-a="react:${e}">${e}</button>`).join('')}<button data-a="moreReacts" class="more ${moreReacts ? 'on' : ''}">${moreReacts ? '−' : '＋'}</button></div>
        ${moreReacts ? `<div class="reacts all">${REACTS.slice(6).map(e => `<button data-a="react:${e}">${e}</button>`).join('')}</div>` : ''}
        ${host || mine ? `<div class="keyrow"><span>Key</span><button data-a="keyDown" class="ghost">−</button><b>${keyLabel(c.key) || '0'}</b><button data-a="keyUp" class="ghost">+</button>${c.key ? '<button data-a="keyZero" class="ghost small">reset</button>' : ''}</div><div class="keyrow"><span>Vocals</span><button data-a="novoxNow" class="ghost ${c.novox ? 'on' : ''}">${novoxLabel(c)}</button></div>` : ''}
        ${host || mine ? `<div class="row">
          ${host ? (st.phase === 'paused' ? '<button data-a="resume" class="cyan">▶ Resume</button>' : '<button data-a="pause" class="ghost">⏸ Pause</button>') : ''}
          ${host ? '<button data-a="restart" class="ghost">⏮ Restart</button>' : ''}
          <button data-a="skip" class="warn">⏭ Skip</button></div>` : ''}`;
      tickProgress();
    } else if (st.phase === 'upnext' && st.queue[0]) {
      const u = st.queue[0], mine = u.clientId === KQ.clientId, can = host || mine;
      el.innerHTML = `
        <span class="count" id="cd"></span>
        <div class="label up">★ UP NEXT</div>
        <div class="whorow">${avatars(u, 'l')}<div><div class="who">${esc(who(u))}</div><div class="song">${esc(clean(u.title))}</div></div></div>${genreChip(u) ? `<div style="margin-top:6px">${genreChip(u)}</div>` : ''}
        <div class="song" id="upStatus"></div>
        ${can ? `<div class="row">
          ${host ? '<button data-a="startNow" class="gold">▶ Start now</button>' : ''}
          ${st.queue.length > 1 ? '<button data-a="defer" class="ghost">🙋 Not here</button>' : ''}
          <button data-a="hold" class="ghost">🚪 Stepped out</button></div>` : ''}`;
      tickCountdown();
    } else {
      el.className = 'idle';
      el.innerHTML = st.held.length ? `Queue's empty — but ${st.held.length} song${st.held.length > 1 ? 's are' : ' is'} waiting in <b>Stepped out</b>.` : "Queue's empty. Search a song and get this party going 🎶";
    }
  }

  function tickCountdown() {
    const st = KQ.state; const cd = $('#cd'), us = $('#upStatus');
    if (!st || st.phase !== 'upnext' || !cd) return;
    const head = st.queue[0];
    const left = st.countdownEndsAt ? Math.ceil((st.countdownEndsAt - now()) / 1000) : null;
    cd.textContent = left !== null && left > 0 ? left : '';
    let msg = '';
    if (head?.dl?.state !== 'ready') msg = head?.dl?.state === 'downloading' ? `Loading video… ${head.dl.pct || 0}%` : head?.dl?.state === 'error' ? '⚠ Download failed — remove or retry it' : 'Waiting to download…';
    else if (st.countdownEndsAt === null && st.resumeHold) msg = 'Welcome back — waiting for the host to start';
    else if (st.countdownEndsAt === null) msg = 'Ready — waiting for the host to start';
    us.textContent = msg;
  }

  function tickProgress() {
    const st = KQ.state; const bar = $('#pbar'); if (!bar || !st?.current) return;
    let t = 0, d = st.current.duration || 0;
    if (progress && progress.itemId === st.current.id) {
      d = progress.d || d;
      t = progress.t + (st.phase === 'playing' ? (Date.now() - progress.at) / 1000 : 0);
    }
    t = Math.min(t, d || t);
    bar.style.width = d ? `${(t / d) * 100}%` : '0';
    $('#ptime').textContent = fmt(t); if (d) $('#pdur').textContent = fmt(d);
  }

  KQ.on('progress', m => { progress = { ...m, at: Date.now() }; });

  // "You're up in N" banner
  // "You're up" goes by WHO IS SINGING (your name, or you as duet partner), not who tapped add.
  // Songs you queued for other people get their own nudge so you can go find them.
  const isMe = it => { const me = String(myName || '').trim().toLowerCase(); return !!me && [it.singer, it.with].some(n => String(n || '').trim().toLowerCase() === me); };
  function etaSecs(st, idx) {
    let secs = 0;
    if (st.current) {
      const d = (progress && progress.itemId === st.current.id ? progress.d : 0) || st.current.duration || 0;
      const t = progress && progress.itemId === st.current.id ? progress.t : 0;
      secs += Math.max(0, d - t);
    }
    for (let i = 0; i < idx; i++) secs += (st.queue[i].duration || 210) + st.settings.countdown;
    return secs;
  }
  function renderEta(st) {
    const el = $('#eta');
    const upnow = st.phase === 'upnext';
    const idx = st.queue.findIndex(isMe);
    if (idx >= 0 && !(idx === 0 && upnow)) {
      const mins = Math.max(1, Math.round(etaSecs(st, idx) / 60));
      el.hidden = false;
      el.className = idx <= 1 ? 'soon' : '';
      el.textContent = idx === 0 ? `🎤 You're next, ${myName}! Get to the mic.` : `🎤 ${myName}: ${idx} song${idx > 1 ? 's' : ''} ahead of you · ~${mins} min`;
      return;
    }
    // a song you added for someone else is about to come up
    const pi = st.queue.findIndex(it => it.clientId === KQ.clientId && !isMe(it));
    if (pi >= 0 && pi <= 1) {
      el.hidden = false;
      el.className = 'proxy';
      el.textContent = pi === 0 ? `📣 Your pick for ${who(st.queue[pi])} is ${upnow ? 'up now' : 'up next'} — go find them!` : `📣 Your pick for ${who(st.queue[pi])} is 2nd in line`;
      return;
    }
    el.hidden = true;
  }

  // ---------- queue / held / done ----------
  const sungBy = (st, name) => ((st.stats || []).find(x => x.singer.toLowerCase() === String(name).trim().toLowerCase()) || {}).sung || 0;

  function qRow(it, i, st) {
    const up = i === 0 && st.phase === 'upnext';
    const mine = it.clientId === KQ.clientId;
    const tint = st.settings.genreRows !== false && it.genre && KQ.GENRES[it.genre];
    return `<div class="item q ${up ? 'up' : ''} ${mine ? 'mine' : ''} ${tint ? 'tinted' : ''}" data-id="${it.id}" ${tint ? `style="--g:${KQ.gColor(it.genre)}"` : ''}>
      <div class="pos">${up ? '★' : i + 1}</div>
      ${avatars(it, 'm')}
      <div class="meta"><div class="singer">${esc(who(it))}${it.key ? `<span class="keyb">${keyLabel(it.key)}</span>` : ''}${isFave(it.singer, it.videoId) ? '<span class="favb">★</span>' : ''}${sungBy(st, it.singer) ? `<span class="sung">🎤${sungBy(st, it.singer)}</span>` : ''}${it.deferred ? `<span class="badge">passed ${it.deferred}×</span>` : ''}</div>
        <div class="t">${esc(clean(it.title))}</div><div class="s">${genreChip(it)}${dlLabel(it.dl)}${it.duration ? ' · ' + fmt(it.duration) : ''}</div></div>
      <div class="acts"><button class="ghost" aria-label="Options">⋯</button></div></div>`;
  }

  function render(st) {
    document.body.dataset.theme = st.settings.theme || 'neon';
    const host = KQ.you.isHost;
    renderNow(st);
    renderEta(st);
    $('#qCount').textContent = st.queue.length || '';
    $('#undoBtn').hidden = !host;
    $('#hostTools').hidden = !host;
    $('#pinBtn').hidden = host || !KQ.you.pinRequired;
    $('#queueList').innerHTML = st.queue.length ? st.queue.map((it, i) => qRow(it, i, st)).join('') : '<div class="empty">Nobody in line yet.</div>';
    $('#heldHead').hidden = !st.held.length;
    $('#heldList').innerHTML = st.held.map(it => `<div class="item q held" data-id="${it.id}">
      <img loading="lazy" src="${esc(thumb(it))}" alt="">
      <div class="meta"><div class="singer">${esc(who(it))}</div><div class="t">${esc(clean(it.title))}</div></div>
      <div class="acts">${host || it.clientId === KQ.clientId ? '<button class="cyan back">↩ Back</button>' : ''}<button class="ghost">⋯</button></div></div>`).join('');
    $('#recapBtn').hidden = !(st.night && st.night.songs);
    $('#nightBox').innerHTML = KQ.nightHtml(st.night);
    $('#mixBox').innerHTML = mixHtml(st.mix);
    const aw = st.awards || [];
    $('#awardsBox').innerHTML = aw.length ? `<div class="awards"><h4>🏆 Tonight's awards${KQ.you.isHost ? ' <button id="awardsTv" class="ghost tiny">Show on big screen</button>' : ''}</h4>${aw.map(x => `<div class="award"><span class="ic">${x.icon}</span>${avatar(x.name.split(' & ')[0], 'm')}<div><b>${esc(x.title)}</b><span>${esc(x.name)} · ${esc(x.why)}</span></div></div>`).join('')}</div>` : '';
    $('#board').innerHTML = (st.stats || []).map((x, i) => `<span class="${i === 0 && x.sung > 1 ? 'top' : ''}">${avatar(x.singer, 's')} ${i === 0 && x.sung > 1 ? '👑 ' : ''}${esc(x.singer)}<i>${x.sung}</i></span>`).join('');
    $('#doneList').innerHTML = st.history.length ? st.history.map((h, i) => `<div class="item done">
      <img loading="lazy" src="${esc(thumb(h))}" alt="">
      <div class="meta"><div class="t">${esc(clean(h.title))}</div><div class="s">${esc(who(h))}${h.skipped ? ' · <span class="skip">skipped</span>' : ''}</div></div>
      <div class="acts"><button data-again="${i}" title="Queue again">＋</button></div></div>`).join('') : '<div class="empty">Nothing sung yet tonight.</div>';
    renderFaves(st);
    const lo = st.leftovers;
    $('#leftovers').hidden = !(lo && KQ.you.isHost);
    if (lo && KQ.you.isHost) $('#leftovers').innerHTML = `<b>${lo.count} song${lo.count > 1 ? 's' : ''} left over from last time</b><div><button data-lo="1" class="cyan">Restore</button><button data-lo="0" class="ghost">Clear</button></div>`;
    // Only redraw search results when what's queued actually changed (not on every download tick)
    const sig = [...st.queue, ...st.held].map(i => i.videoId).sort().join();
    if (sig !== render.sig) { render.sig = sig; if (lastResults.length) renderResults(); }
  }

  $('#doneList').onclick = async e => {
    const i = e.target.closest('[data-again]')?.dataset.again; if (i === undefined) return;
    const h = KQ.state.history[i];
    const singer = await askName('Who is singing this one?', myName); if (!singer) return;
    const r = await addSong({ video: h, singer, trusted: true });
    r.ok ? toast(`Added for ${singer} — #${r.position} in line`) : toast(r.error, 'bad');
  };

  // ---------- favourites ----------
  let favFor = null; // which singer's favourites are showing
  function renderFaves(st) {
    const all = st.faves || {};
    const names = Object.values(all).map(f => f.name);
    if (!favFor || !all[favFor.toLowerCase()]) favFor = (myName && all[myName.toLowerCase()]) ? myName : (names[0] || myName || '');
    const cur = all[String(favFor).toLowerCase()];
    $('#favNames').innerHTML = names.map(n => `<button data-n="${esc(n)}" class="${n.toLowerCase() === String(favFor).toLowerCase() ? 'on' : ''}">${esc(n)}</button>`).join('');
    $('#favList').innerHTML = cur && cur.songs.length ? cur.songs.map((f, i) => `<div class="item">
      <img loading="lazy" src="${esc(thumb(f))}" alt="">
      <div class="meta"><div class="t">${esc(clean(f.title))}</div><div class="s">${f.key ? `key ${keyLabel(f.key)} · ` : ''}${f.duration ? fmt(f.duration) : ''}</div></div>
      <div class="acts"><button class="ghost" data-unfav="${i}" title="Remove">✕</button><button data-q="${i}" title="Queue it">＋</button></div></div>`).join('')
      : `<div class="empty">No favourites yet.<br>Tap ☆ on the song that's playing, or ⋯ → Save on any queued song.</div>`;
    if (cur && cur.songs.length) $('#favList').innerHTML += `<button id="favPrefetch" class="ghost wide">⬇ Download ${cur.name === myName ? 'my' : esc(cur.name) + "'s"} faves now, so they start instantly later</button>`;
  }
  $('#favList').addEventListener('click', async e => {
    if (!e.target.closest('#favPrefetch')) return;
    const cur = (KQ.state.faves || {})[String(favFor).toLowerCase()]; if (!cur) return;
    const r = await act('prefetch', { ids: cur.songs.map(f => f.videoId) });
    if (r.ok) toast(r.queued ? `⬇ Downloading ${r.queued} song${r.queued > 1 ? 's' : ''} in the background${r.ready ? ` (${r.ready} already ready)` : ''}` : 'All of them are already downloaded ✓');
  });
  $('#favNames').onclick = e => { const n = e.target.closest('[data-n]')?.dataset.n; if (n) { favFor = n; renderFaves(KQ.state); } };
  $('#favList').onclick = async e => {
    const cur = (KQ.state.faves || {})[String(favFor).toLowerCase()]; if (!cur) return;
    const q = e.target.closest('[data-q]')?.dataset.q, u = e.target.closest('[data-unfav]')?.dataset.unfav;
    if (q !== undefined) { const f = cur.songs[q]; const r = await addSong({ video: f, singer: cur.name, key: f.key, trusted: true }); r.ok ? toast(`Added for ${cur.name} — #${r.position} in line`) : toast(r.error, 'bad'); }
    if (u !== undefined) run('fave', { singer: cur.name, video: cur.songs[u], on: false }, 'Removed');
  };

  $('#awardsBox').onclick = e => { if (e.target.id === 'awardsTv') run('awards', {}, '🏆 On the big screen now'); };
  $('#leftovers').onclick = e => { const v = e.target.closest('[data-lo]')?.dataset.lo; if (v === undefined) return; run('leftovers', { restore: v === '1' }, v === '1' ? 'Restored' : 'Cleared'); };

  // ---------- about ----------
  async function openStats() {
    if (!myName) return showJoin();
    const st = await (await fetch(`/api/stats?name=${encodeURIComponent(myName)}`)).json().catch(() => ({ songs: 0 }));
    const pills = (arr, f) => arr.map(f).join(' ');
    $('#aboutBody').innerHTML = `<div class="about mystats"><div class="whorow">${avatar(myName, 'l')}<h2>${esc(myName)}</h2></div>` + (st.songs ? `
      <p><b>${st.songs}</b> song${st.songs > 1 ? 's' : ''} over <b>${st.nights}</b> night${st.nights > 1 ? 's' : ''} · <b>${KQ.dur(st.stageSecs || 0)}</b> on stage · singing since ${new Date(st.since).toLocaleDateString()}</p>
      <h3>Most sung</h3><ol>${st.topSongs.map(t => `<li>${esc(clean(t.title))} <i>×${t.n}</i></li>`).join('')}</ol>
      ${st.genres.length ? `<h3>Genres</h3><p>${pills(st.genres, x => `<span class="gchip" style="--g:${KQ.gColor(x.g)}">${esc((GENRES[x.g] || [x.g])[0])} ×${x.n}</span>`)}</p>` : ''}
      ${st.decades.length ? `<h3>Decades</h3><p>${st.decades.map(x => `${x.d} ×${x.n}`).join(' · ')}</p>` : ''}
      ${st.duets.length ? `<h3>Favourite duet partners</h3><p>${st.duets.map(x => `${esc(x.p)} ×${x.n}`).join(' · ')}</p>` : ''}` : '<p>No songs sung yet. Go get one in the queue! 🎤</p>') + '</div>';
    $('#aboutDlg').showModal();
  }
  async function openAbout() { $('#aboutBody').innerHTML = await KQ.aboutHtml(); $('#aboutDlg').showModal(); }
  // ☰ menu: everything that used to be buried at the bottom of the Queue tab
  $('#menuBtn').onclick = () => {
    const host = KQ.you.isHost;
    const hosted = KQ.you.hostMode === 'hosted';
    const hostNames = Object.values(KQ.state.people || {}).filter(p => p.host).map(p => p.name);
    let sub = host ? (hosted ? "👑 You're hosting" : 'Open party: everyone can manage the queue') : `Guest: you can add songs and manage your own${hostNames.length ? ` · 👑 ${hostNames.join(', ')} hosting` : ''}`;
    let b = `<div class="h"><b>KARAO-Q</b><div>${esc(sub)}</div></div>`;
    if (host) b += `<button data-a="settings">⚙ Party settings</button><button data-a="undo">↶ Undo last queue change</button><button data-a="shuffle">🔀 Fair shuffle the queue</button>`;
    if (!hosted && !KQ.you.viaNet && !KQ.you.pinRequired) b += `<button data-a="claim">👑 Be the host <small>(only you + co-hosts manage the queue)</small></button>`;
    if (hosted && host) b += `<button data-a="cohosts">👑 Co-hosts…</button><button data-a="handoff">🤝 Hand off hosting…</button><button data-a="endhost">🔓 End host mode (everyone manages)</button>`;
    if (!host && KQ.you.pinRequired) b += `<button data-a="pin">🔑 Enter host PIN</button>`;
    b += `<button data-a="stats">📊 My stats</button><button data-a="name">🙂 Change my name or look</button><button data-a="about">ⓘ About & credits</button>`;
    sheet(b, a => {
      if (a === 'claim') run('claimHost', {});
      if (a === 'endhost' && confirm('End host mode? Everyone will be able to manage the queue again.')) run('endHosting', {}, 'Open party: everyone can manage');
      if (a === 'cohosts' || a === 'handoff') setTimeout(() => pickPerson(a), 50);
      if (a === 'settings') $('#settingsBtn').onclick();
      if (a === 'undo') $('#undoBtn').onclick();
      if (a === 'shuffle') $('#shuffleBtn').onclick();
      if (a === 'pin') $('#pinBtn').onclick();
      if (a === 'name') $('#meBtn').onclick();
      if (a === 'about') openAbout();
      if (a === 'stats') openStats();
    });
  };
  // choose a person for co-host / hand-off
  function pickPerson(mode) {
    const ppl = Object.values(KQ.state.people || {}).filter(p => p.name.toLowerCase() !== String(myName).toLowerCase());
    if (!ppl.length) return toast('Nobody else has joined yet', 'bad');
    const head = mode === 'handoff' ? 'Hand the crown to…' : 'Tap to make co-host (or remove)';
    sheet(`<div class="h"><b>${head}</b><div>They need to have joined on their own phone.</div></div>` +
      ppl.map(p => `<button data-a="${esc(p.name)}" class="personbtn">${avatar(p.name, 's')} ${esc(p.name)} ${p.host ? '👑' : ''}</button>`).join(''),
      name => {
        const p = ppl.find(x => x.name === name); if (!p) return;
        if (mode === 'handoff') run('handOff', { name }, `👑 ${name} is hosting now`);
        else run('setHost', { name, on: !p.host }, p.host ? `${name} is a guest again` : `👑 ${name} is a co-host`);
      });
  }
  $('#aboutClose').onclick = () => $('#aboutDlg').close();
  dialogDismiss($('#aboutDlg'));

  // ---------- host tools ----------
  $('#undoBtn').onclick = () => run('undo', {}, 'Undone');
  $('#shuffleBtn').onclick = () => run('shuffle', {}, 'Shuffled (still fair)');
  $('#settingsBtn').onclick = () => {
    const s = KQ.state.settings;
    $('#setCountdown').value = String(s.countdown);
    if (!$('#setCountdown').value) { $('#setCountdown').insertAdjacentHTML('beforeend', `<option value="${s.countdown}">${s.countdown} seconds</option>`); $('#setCountdown').value = String(s.countdown); }
    $('#setFair').checked = s.fair;
    $('#setQr').checked = s.showQr !== false;
    $('#setNext').checked = s.showNext !== false;
    $('#setRows').checked = s.genreRows !== false;
    $('#setMax').value = String(s.maxPerPerson || 0);
    $('#setTheme').value = s.theme || 'neon';
    $('#setLevel').checked = s.levelVolume !== false;
    $('#setIntro').checked = s.introCard !== false;
    $('#setOled').checked = s.oledCare !== false;
    $('#setStream').checked = s.streamFirst !== false;
    $('#setLyrics').checked = s.lyricsWarn !== false;
    $('#setAutoLyr').checked = s.autoLyrics !== false;
    $('#setCache').value = String(s.cacheGB || 5);
    if (!$('#setCache').value) { $('#setCache').insertAdjacentHTML('beforeend', `<option value="${s.cacheGB}">${s.cacheGB} GB</option>`); $('#setCache').value = String(s.cacheGB); }
    $('#cacheUse').textContent = `Using ${(KQ.state.cacheBytes / 1e9).toFixed(1)} GB now. Oldest unplayed songs are deleted first; queued songs are never touched.`;
    $('#settingsDlg').onclose = () => { if ($('#settingsDlg').returnValue === 'ok') run('settings', { settings: { countdown: Number($('#setCountdown').value), fair: $('#setFair').checked, showQr: $('#setQr').checked, showNext: $('#setNext').checked, genreRows: $('#setRows').checked, maxPerPerson: Number($('#setMax').value), theme: $('#setTheme').value, levelVolume: $('#setLevel').checked, introCard: $('#setIntro').checked, oledCare: $('#setOled').checked, streamFirst: $('#setStream').checked, lyricsWarn: $('#setLyrics').checked, autoLyrics: $('#setAutoLyr').checked, cacheGB: Number($('#setCache').value) } }, 'Saved'); };
    $('#settingsDlg').showModal();
  };
  $('#newNightBtn').onclick = () => { if (confirm('Start a new night? The queue is cleared (you can restore it from the Queue tab) and song counts reset.')) { $('#settingsDlg').close(); run('newNight', {}, 'New night — counts reset'); } };
  $('#pinBtn').onclick = () => { const p = prompt('Host PIN'); if (p) { ls.set('kq.pin', p); KQ.send({ type: 'pin', pin: p }); } };
  KQ.on('pinResult', m => toast(m.ok ? "You're a host now" : 'Wrong PIN', m.ok ? '' : 'bad'));

  // ---------- join: tap your name, pick a look (avatar or selfie) ----------
  let jName = '', jPreset, jPhoto = null;
  // Taking a selfie opens the phone's camera app. While it's open the browser pauses this page (the
  // connection drops and reconnects) and, on phones short on memory, may even reload it. So: the join
  // screen must never reset itself on a reconnect, and the half-finished join is remembered for a reload.
  const ss = { get: k => { try { return sessionStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { } } };
  const joinOpen = () => !$('#join').hidden;
  function showJoin() {
    ss.set('kq.joining', null);
    $('#join').hidden = false; $('#jName').hidden = false; $('#jLook').hidden = true;
    const ppl = Object.values((KQ.state && KQ.state.people) || {});
    $('#jPeople').innerHTML = ppl.map(p => `<button data-n="${esc(p.name)}">${avatar(p.name, 'l')}<span>${esc(p.name)}</span></button>`).join('');
    $('#jNew').value = '';
  }
  function lookStep(name, photo = null) {
    jName = name; jPhoto = photo;
    ss.set('kq.joining', name);
    $('#join').hidden = false;
    const p = KQ.person(name);
    jPreset = p ? p.preset : undefined;
    $('#jKeep').checked = !!(p && p.keep);
    $('#jName').hidden = true; $('#jLook').hidden = false;
    renderLook();
  }
  function renderLook() {
    const prev = jPhoto ? `<img class="av av-xl" src="${jPhoto}" alt="">` : jPreset ? `<span class="av av-xl emo">${jPreset}</span>` : avatar(jName, 'xl');
    $('#jPreview').innerHTML = `${prev}<span>${esc(jName)}</span>`;
    $('#jPresets').innerHTML = PRESETS.map(e => `<button data-e="${e}" class="${!jPhoto && e === jPreset ? 'on' : ''}">${e}</button>`).join('');
  }
  $('#jPeople').onclick = e => { const n = e.target.closest('[data-n]')?.dataset.n; if (n) lookStep(n); };
  $('#jNewForm').onsubmit = e => { e.preventDefault(); const n = $('#jNew').value.trim(); if (n) lookStep(n); };
  $('#jPresets').onclick = e => { const em = e.target.closest('[data-e]')?.dataset.e; if (em) { jPreset = em; jPhoto = null; renderLook(); } };
  $('#jBack').onclick = () => showJoin();
  // remember where we were before the camera app opens (in case the browser reloads this page meanwhile)
  for (const id of ['#jPhoto', '#jGallery']) $(id).addEventListener('click', () => ss.set('kq.joining', jName));
  $('#jGallery').onchange = () => usePhoto($('#jGallery'));
  $('#jPhoto').onchange = () => usePhoto($('#jPhoto'));
  async function usePhoto(input) {
    const f = input.files[0]; if (!f) return;
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(f); });
      const S = 360, k = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas'); c.width = c.height = S;
      c.getContext('2d').drawImage(img, (img.naturalWidth - k) / 2, (img.naturalHeight - k) / 2, k, k, 0, 0, S, S); // centre square crop
      jPhoto = c.toDataURL('image/jpeg', 0.82);
      ss.set('kq.joinPhoto', jPhoto); // survives a reload until they tap "Let's sing"
      renderLook();
    } catch { toast("Couldn't read that photo", 'bad'); }
    input.value = '';
  }
  $('#jDone').onclick = async () => {
    const keep = $('#jKeep').checked;
    setName(jName);
    ss.set('kq.joining', null); ss.set('kq.joinPhoto', null);
    if (jPhoto) {
      const r = await fetch('/api/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: jName, data: jPhoto, clientId: KQ.clientId, keep }) }).catch(() => null);
      if (!r || !r.ok) toast("Photo didn't upload — try again from ☰", 'bad');
      await act('profile', { name: jName, keep });
    } else await act('profile', { name: jName, keep, ...(jPreset !== undefined ? { preset: jPreset } : {}) });
    $('#join').hidden = true;
    toast(`Hi ${jName}! Search a song to get in line 🎤`);
  };

  KQ.on('state', render);
  // tell the server which person this phone is (for co-hosting); open the join screen on a first visit
  let introduced = false;
  KQ.on('state', () => {
    renderMe();
    if (introduced) return; introduced = true;
    if (myName) act('profile', { name: myName });
    if (joinOpen()) return; // never yank someone out of the join screen (e.g. reconnecting after the camera)
    const pending = ss.get('kq.joining');
    if (pending) { // page was reloaded mid-join (camera app): pick up where they left off
      const photo = ss.get('kq.joinPhoto');
      lookStep(pending, photo);
      if (!photo) toast('Your phone reloaded the page while the camera was open — tap 📸 again, or choose the photo from your gallery');
    }
    else if (!myName && !new URLSearchParams(location.search).has('embed')) showJoin();
  });
  KQ.on('conn', up => { if (up) introduced = false; });
  let openedFromHash = false;
  KQ.on('state', () => {
    if (!openedFromHash && location.hash === '#settings' && KQ.you.isHost) { openedFromHash = true; $('#settingsBtn').onclick(); }
  });
  window.addEventListener('hashchange', () => { if (location.hash === '#settings' && KQ.you.isHost) $('#settingsBtn').onclick(); });
  KQ.on('conn', up => document.body.classList.toggle('offline', !up));
  setInterval(() => { tickCountdown(); tickProgress(); }, 250);
  setInterval(() => { if (KQ.state) renderEta(KQ.state); }, 5000);
  KQ.connect('remote');
})();
