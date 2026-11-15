'use strict';
// Everyone who's sung or been queued: their look (a preset avatar or a selfie) and which phones are theirs.
// Kept across nights so returning friends can just tap their name. Selfies are deleted at the start of a
// new night unless that person ticked "keep my photo".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRESETS = ['🦊', '🐙', '🦄', '🐸', '🐼', '🦁', '🐯', '🐨', '🐵', '🐧', '🐱', '🐶', '🦉', '🐝', '👽', '🤖', '👻', '🦖', '🎸', '🎤', '🍕', '🌮', '🌈', '⭐'];
const norm = s => String(s || '').trim().toLowerCase();

class People {
  constructor({ dir }) {
    this.file = path.join(dir, 'people.json');
    this.avatarDir = path.join(dir, 'avatars');
    fs.mkdirSync(this.avatarDir, { recursive: true });
    this.p = {};
    try { this.p = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { }
  }

  _save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      try { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.p)); fs.renameSync(this.file + '.tmp', this.file); } catch (e) { console.error('people save failed:', e.message); }
    }, 300);
  }

  get(name) { return this.p[norm(name)] || null; }

  // Make sure a person exists (e.g. someone queued a song for them). clientId = their phone, if it's them.
  touch(name, clientId) {
    const k = norm(name);
    if (!k) return null;
    const e = this.p[k] || (this.p[k] = { name: String(name).trim().slice(0, 40), preset: null, photo: null, keep: false, clientIds: [] });
    e.lastSeen = Date.now();
    if (clientId && !e.clientIds.includes(clientId)) { e.clientIds.unshift(clientId); e.clientIds.length = Math.min(e.clientIds.length, 6); }
    this._save();
    return e;
  }

  setPreset(name, emoji, clientId) {
    if (emoji && !PRESETS.includes(emoji)) return false;
    const e = this.touch(name, clientId);
    e.preset = emoji || null;
    this._dropPhoto(e);
    this._save();
    return true;
  }

  setPhoto(name, buffer, clientId) {
    const e = this.touch(name, clientId);
    this._dropPhoto(e);
    const file = `${crypto.randomBytes(8).toString('hex')}.jpg`;
    fs.writeFileSync(path.join(this.avatarDir, file), buffer);
    e.photo = `/avatars/${file}`;
    this._save();
  }

  removePhoto(name) { const e = this.get(name); if (e) { this._dropPhoto(e); this._save(); } }

  setKeep(name, keep) { const e = this.get(name); if (e) { e.keep = !!keep; this._save(); } }

  _dropPhoto(e) {
    if (!e.photo) return;
    try { fs.unlinkSync(path.join(this.avatarDir, path.basename(e.photo))); } catch { }
    e.photo = null;
  }

  // New night: selfies go unless kept.
  newNight() {
    for (const e of Object.values(this.p)) if (e.photo && !e.keep) this._dropPhoto(e);
    this._save();
  }

  clientsOf(name) { return (this.get(name) || {}).clientIds || []; }
  nameOf(clientId) { const e = Object.values(this.p).find(x => (x.clientIds || []).includes(clientId)); return e ? e.name : null; }

  // What phones and the TV get: no phone IDs, just names and looks (most recent first, capped).
  public(hostClients = []) {
    const out = {};
    Object.entries(this.p)
      .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))
      .slice(0, 80)
      .forEach(([k, e]) => { out[k] = { name: e.name, preset: e.preset, photo: e.photo, keep: !!e.keep, host: (e.clientIds || []).some(c => hostClients.includes(c)) }; });
    return out;
  }
}

module.exports = { People, PRESETS };
