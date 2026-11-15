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
  async function addSong(data) {
    let r = await act('add', data);
    if (!r.ok && r.dup && confirm(`${r.error}.\n\nAdd it anyway?`)) r = await act('add', { ...data, force: true });
    return r;
  }

  // ---------- search ----------
  $('#karaoke').checked = ls.get('kq.karaoke') !== '0';
  $('#karaoke').onchange = () => ls.set('kq.karaoke', $('#karaoke').checked ? '1' : '0');
  $('#searchForm').onsubmit = async e => {
    e.preventDefault();
    const q = $('#q').value.trim();
    if (!q) return;
    $('#q').blur();
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
        <div class="meta"><div class="t">${esc(v.title)}</div><div class="s">${esc(v.channel)}${v.duration ? ' · ' + fmt(v.duration) : ''}${queued.has(v.videoId) ? ' · <span class="dl ok">in queue</span>' : ''}</div></div>
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
    if (can) b += `<button data-a="genre">🎨 Genre: ${it.genre && GENRES[it.genre] ? esc(GENRES[it.genre][0]) : 'unknown'} — change</button>`;
    if (can) b += `<button data-a="duet">👥 ${it.with ? 'Change / remove duet partner' : 'Make it a duet'}</button>`;
    b += `<button data-a="fave">${isFave(it.singer, it.videoId) ? '★ Remove from' : '⭐ Save to'} ${esc(it.singer)}'s favourites</button>`;
    if (it.dl?.state === 'error') b += `<button data-a="retry">🔁 Retry download</button>`;
    if (can) b += `<button data-a="remove" class="warn">🗑 Remove song</button>`;
    if (!can) b += `<div class="h"><div>Only ${esc(it.singer)}'s phone or the host can change this one.</div></div>`;
    sheet(b, async a => {
      if (a === 'keyDown' || a === 'keyUp') return run('key', { id: it.id, delta: a === 'keyUp' ? 1 : -1 });
      if (a === 'genre') return setTimeout(() => pickGenre(it, false), 50);
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
        ${host || mine ? `<div class="keyrow"><span>Key</span><button data-a="keyDown" class="ghost">−</button><b>${keyLabel(c.key) || '0'}</b><button data-a="keyUp" class="ghost">+</button>${c.key ? '<button data-a="keyZero" class="ghost small">reset</button>' : ''}</div>` : ''}
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
    $('#mixBox').innerHTML = mixHtml(st.mix);
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
    const r = await addSong({ video: h, singer });
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
  }
  $('#favNames').onclick = e => { const n = e.target.closest('[data-n]')?.dataset.n; if (n) { favFor = n; renderFaves(KQ.state); } };
  $('#favList').onclick = async e => {
    const cur = (KQ.state.faves || {})[String(favFor).toLowerCase()]; if (!cur) return;
    const q = e.target.closest('[data-q]')?.dataset.q, u = e.target.closest('[data-unfav]')?.dataset.unfav;
    if (q !== undefined) { const f = cur.songs[q]; const r = await addSong({ video: f, singer: cur.name, key: f.key }); r.ok ? toast(`Added for ${cur.name} — #${r.position} in line`) : toast(r.error, 'bad'); }
    if (u !== undefined) run('fave', { singer: cur.name, video: cur.songs[u], on: false }, 'Removed');
  };

  $('#leftovers').onclick = e => { const v = e.target.closest('[data-lo]')?.dataset.lo; if (v === undefined) return; run('leftovers', { restore: v === '1' }, v === '1' ? 'Restored' : 'Cleared'); };

  // ---------- about ----------
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
    b += `<button data-a="name">🙂 Change my name or look</button><button data-a="about">ⓘ About & credits</button>`;
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
    $('#setCache').value = String(s.cacheGB || 5);
    if (!$('#setCache').value) { $('#setCache').insertAdjacentHTML('beforeend', `<option value="${s.cacheGB}">${s.cacheGB} GB</option>`); $('#setCache').value = String(s.cacheGB); }
    $('#cacheUse').textContent = `Using ${(KQ.state.cacheBytes / 1e9).toFixed(1)} GB now. Oldest unplayed songs are deleted first; queued songs are never touched.`;
    $('#settingsDlg').onclose = () => { if ($('#settingsDlg').returnValue === 'ok') run('settings', { settings: { countdown: Number($('#setCountdown').value), fair: $('#setFair').checked, showQr: $('#setQr').checked, showNext: $('#setNext').checked, genreRows: $('#setRows').checked, maxPerPerson: Number($('#setMax').value), theme: $('#setTheme').value, levelVolume: $('#setLevel').checked, introCard: $('#setIntro').checked, oledCare: $('#setOled').checked, cacheGB: Number($('#setCache').value) } }, 'Saved'); };
    $('#settingsDlg').showModal();
  };
  $('#newNightBtn').onclick = () => { if (confirm('Start a new night? The queue is cleared (you can restore it from the Queue tab) and song counts reset.')) { $('#settingsDlg').close(); run('newNight', {}, 'New night — counts reset'); } };
  $('#pinBtn').onclick = () => { const p = prompt('Host PIN'); if (p) { ls.set('kq.pin', p); KQ.send({ type: 'pin', pin: p }); } };
  KQ.on('pinResult', m => toast(m.ok ? "You're a host now" : 'Wrong PIN', m.ok ? '' : 'bad'));

  // ---------- join: tap your name, pick a look (avatar or selfie) ----------
  let jName = '', jPreset, jPhoto = null;
  function showJoin() {
    $('#join').hidden = false; $('#jName').hidden = false; $('#jLook').hidden = true;
    const ppl = Object.values((KQ.state && KQ.state.people) || {});
    $('#jPeople').innerHTML = ppl.map(p => `<button data-n="${esc(p.name)}">${avatar(p.name, 'l')}<span>${esc(p.name)}</span></button>`).join('');
    $('#jNew').value = '';
  }
  function lookStep(name) {
    jName = name; jPhoto = null;
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
  $('#jPhoto').onchange = async () => {
    const f = $('#jPhoto').files[0]; if (!f) return;
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(f); });
      const S = 360, k = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas'); c.width = c.height = S;
      c.getContext('2d').drawImage(img, (img.naturalWidth - k) / 2, (img.naturalHeight - k) / 2, k, k, 0, 0, S, S); // centre square crop
      jPhoto = c.toDataURL('image/jpeg', 0.82);
      renderLook();
    } catch { toast("Couldn't read that photo", 'bad'); }
    $('#jPhoto').value = '';
  };
  $('#jDone').onclick = async () => {
    const keep = $('#jKeep').checked;
    setName(jName);
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
    else if (!new URLSearchParams(location.search).has('embed')) showJoin();
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
