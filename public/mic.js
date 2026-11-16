'use strict';
// 🎤 Microphones through the party computer's sound card (Mbox, UR44, Audio Kontrol, a USB mic…).
// Up to two mics: two separate devices, or the left/right inputs of one audio interface.
// Each mic → volume → shared vocal bus → gentle compressor → dry + reverb + echo → speakers.
// The party's settings (on/off, volumes, reverb, echo) come from the host's phone; which device is which
// mic is picked on the TV (device IDs only mean something on this computer) and remembered here.
(() => {
  const LS = 'kq.mic';
  const load = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } };
  const save = c => { try { localStorage.setItem(LS, JSON.stringify(c)); } catch { } };
  let cfg = Object.assign({ slots: [{ id: '', ch: 'both' }, { id: '', ch: 'both' }], out: '' }, load());

  let ctx = null, bus = null, master = null, dry = null, revSend = null, echoSend = null, delay = null, fb = null;
  const slots = [null, null]; // { stream, src, gain, analyser }
  const streams = new Map();  // deviceId → MediaStream (one interface can feed both mics)
  let params = { on: false, vol: [0.8, 0.8], reverb: 0.25, echo: 0.1, master: 0.9 };

  function impulse(c, secs = 2.4, decay = 3) {
    const len = Math.floor(c.sampleRate * secs), buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return buf;
  }
  function graph() {
    if (ctx) return;
    ctx = new AudioContext({ latencyHint: 'interactive' });
    bus = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.15;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90; // cut mic handling rumble
    bus.connect(hp).connect(comp);
    master = ctx.createGain(); master.connect(ctx.destination);
    dry = ctx.createGain(); comp.connect(dry).connect(master);
    // reverb
    // reverb: a short pre-delay, the room, then darken the tail a little (sounds less like hiss)
    revSend = ctx.createGain(); const conv = ctx.createConvolver(); conv.buffer = impulse(ctx);
    const pre = ctx.createDelay(0.1); pre.delayTime.value = 0.025;
    const warm = ctx.createBiquadFilter(); warm.type = 'lowpass'; warm.frequency.value = 6500;
    comp.connect(revSend).connect(pre).connect(conv).connect(warm).connect(master);
    // echo (slap-back-ish, darkened each repeat)
    echoSend = ctx.createGain(); delay = ctx.createDelay(2); delay.delayTime.value = 0.32;
    fb = ctx.createGain(); fb.gain.value = 0.35; const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
    comp.connect(echoSend).connect(delay); delay.connect(lp).connect(fb).connect(delay); delay.connect(master);
    if (cfg.out && ctx.setSinkId) ctx.setSinkId(cfg.out).catch(() => { });
    apply();
  }
  function apply() {
    if (!ctx) return;
    const t = ctx.currentTime, on = params.on ? 1 : 0;
    master.gain.setTargetAtTime(on * params.master, t, 0.03);
    revSend.gain.setTargetAtTime(params.reverb * 3.5, t, 0.05); // convolver output is ~13 dB below the dry voice; this makes 25% clearly audible
    echoSend.gain.setTargetAtTime(params.echo * 0.8, t, 0.05);
    dry.gain.setTargetAtTime(1, t, 0.05);
    slots.forEach((s, i) => s && s.gain.gain.setTargetAtTime(params.vol[i] ?? 0.8, t, 0.03));
  }

  async function streamFor(id) {
    if (streams.has(id)) return streams.get(id);
    const s = await navigator.mediaDevices.getUserMedia({ audio: {
      deviceId: id ? { exact: id } : undefined, channelCount: { ideal: 2 },
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0 } });
    streams.set(id, s);
    return s;
  }
  async function connect() {
    graph();
    for (const s of slots) if (s) { try { s.src.disconnect(); s.gain.disconnect(); } catch { } }
    slots.fill(null);
    const used = new Set();
    for (let i = 0; i < 2; i++) {
      const c = cfg.slots[i];
      if (!c || c.id === 'off' || (i === 1 && !c.id)) continue; // mic 2 is off unless chosen
      try {
        const stream = await streamFor(c.id);
        used.add(c.id);
        const src = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain(), analyser = ctx.createAnalyser(); analyser.fftSize = 512;
        let node = src;
        if (c.ch === 'L' || c.ch === 'R') {
          // one input of a 2-in interface: take that channel, centre it
          const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
          src.connect(split); const k = c.ch === 'L' ? 0 : 1;
          split.connect(merge, k, 0); split.connect(merge, k, 1); node = merge;
        }
        node.connect(gain); gain.connect(analyser); analyser.connect(bus); // analyser in-line: a dead-end analyser never gets audio
        slots[i] = { src, gain, analyser, node };
      } catch (e) { console.error('mic', i + 1, e); KQMic.onError && KQMic.onError(i, e); }
    }
    for (const [id, s] of streams) if (!used.has(id)) { s.getTracks().forEach(t => t.stop()); streams.delete(id); }
    apply();
    if (ctx.state !== 'running') await ctx.resume().catch(() => { });
  }
  function disconnectAll() {
    for (const s of slots) if (s) { try { s.src.disconnect(); s.gain.disconnect(); } catch { } }
    slots.fill(null);
    for (const s of streams.values()) s.getTracks().forEach(t => t.stop());
    streams.clear();
  }

  // 0–1 level per mic, for meters
  const buf = new Float32Array(512);
  function levels() {
    return slots.map(s => {
      if (!s) return null;
      s.analyser.getFloatTimeDomainData(buf);
      let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
      return Math.min(1, peak);
    });
  }

  async function devices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return { inputs: [], outputs: [] };
    let all = await navigator.mediaDevices.enumerateDevices();
    if (all.some(d => d.kind === 'audioinput' && !d.label)) { // labels need permission once
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); all = await navigator.mediaDevices.enumerateDevices(); } catch { }
    }
    return { inputs: all.filter(d => d.kind === 'audioinput'), outputs: all.filter(d => d.kind === 'audiooutput') };
  }

  // the party's mic settings changed (from the host's phone)
  async function setParams(p) {
    const was = params.on;
    params = Object.assign({}, params, p || {});
    if (params.on && !was) { try { await connect(); } catch (e) { console.error(e); } }
    else if (!params.on && was) { apply(); setTimeout(() => { if (!params.on) disconnectAll(); }, 300); }
    else apply();
  }
  async function setSlot(i, c) { cfg.slots[i] = Object.assign({}, cfg.slots[i], c); save(cfg); if (params.on) await connect(); }
  async function setOutput(id, others = []) {
    cfg.out = id; save(cfg);
    if (ctx && ctx.setSinkId) await ctx.setSinkId(id).catch(() => { });
    for (const el of others) if (el && el.setSinkId) await el.setSinkId(id).catch(() => { });
  }
  const latencyMs = () => ctx ? Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000) : null;
  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext);

  window.KQMic = { setParams, setSlot, setOutput, devices, levels, latencyMs, supported, get cfg() { return cfg; }, get params() { return params; }, onError: null };
})();
