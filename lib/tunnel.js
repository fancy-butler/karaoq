'use strict';
// Optional "join from anywhere" link via a Cloudflare quick tunnel.
// Exposes only this app's port, at a random https://*.trycloudflare.com address that changes every launch.
// Needs the `cloudflared` binary; if it isn't installed, KARAO-Q simply runs Wi-Fi-only.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class Tunnel extends EventEmitter {
  constructor(port, bin = 'cloudflared') {
    super();
    this.port = port; this.bin = bin; this.url = null; this.proc = null; this.tries = 0; this.stopped = false;
  }

  start() {
    if (this.stopped) return;
    let p;
    try {
      p = spawn(this.bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${this.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return this._unavailable(); }
    this.proc = p;
    const onData = d => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && m[0] !== this.url) { this.url = m[0]; this.tries = 0; this.emit('url', this.url); }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', e => { if (e.code === 'ENOENT') this._unavailable(); });
    p.on('close', () => {
      this.proc = null;
      if (this.url) { this.url = null; this.emit('url', null); }
      if (!this.stopped && this.tries++ < 5) setTimeout(() => this.start(), 3000 * this.tries);
    });
  }

  _unavailable() {
    this.stopped = true;
    console.log('      Internet link: off (install cloudflared to let phones join from any network)');
  }

  stop() { this.stopped = true; if (this.proc) this.proc.kill(); }
}

module.exports = { Tunnel };
