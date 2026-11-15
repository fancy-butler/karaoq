// Real-time pitch shifter (key change without changing tempo).
// Classic two-tap delay-line shifter: two read heads sweep through a short delay buffer at a
// rate set by the pitch ratio, crossfaded with equal-power windows so the seams don't click.
// At 0 semitones it's a straight passthrough — zero latency, zero colouring.
class KeyShift extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'semitones', defaultValue: 0, minValue: -12, maxValue: 12, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.W = Math.round(sampleRate * 0.07);   // 70 ms grain: smooth on music, small A/V offset
    this.L = this.W * 2 + 256;
    this.bufs = [];
    this.w = 0;
    this.phase = 0;
  }

  read(buf, pos) {
    const L = this.L;
    pos = ((pos % L) + L) % L;
    const i = Math.floor(pos), f = pos - i;
    return buf[i] * (1 - f) + buf[(i + 1) % L] * f;
  }

  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const ch = Math.min(inp.length, out.length);
    while (this.bufs.length < ch) this.bufs.push(new Float32Array(this.L));
    const n = inp[0].length;
    const semis = params.semitones[0];
    const r = Math.pow(2, semis / 12);
    const step = (1 - r) / this.W;
    const W = this.W, L = this.L;
    let w = this.w, phase = this.phase;

    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) this.bufs[c][w] = inp[c][i];
      if (Math.abs(semis) < 0.01) {
        for (let c = 0; c < ch; c++) out[c][i] = inp[c][i];
      } else {
        const pA = phase, pB = (phase + 0.5) % 1;
        const gA = Math.sin(Math.PI * pA), gB = Math.sin(Math.PI * pB); // gA² + gB² = 1
        for (let c = 0; c < ch; c++) {
          const b = this.bufs[c];
          out[c][i] = gA * this.read(b, w - 1 - pA * W) + gB * this.read(b, w - 1 - pB * W);
        }
        phase += step;
        phase -= Math.floor(phase); // wrap into [0,1)
      }
      w = (w + 1) % L;
    }
    // mono source into stereo out: duplicate
    for (let c = ch; c < out.length; c++) out[c].set(out[0]);
    this.w = w; this.phase = phase;
    return true;
  }
}
registerProcessor('key-shift', KeyShift);
