#!/usr/bin/env node
'use strict';
// Builds a tiny fake karaoke library for tests: a CD+G pair, the same pair zipped, an .mkv and an .mp4.
//   node scripts/make-test-library.js <dir>
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

// ---- CD+G writer (just enough to draw something): 300 packets/second, 24 bytes each ----
function packet(instr, data = []) {
  const b = Buffer.alloc(24);
  b[0] = 0x09; b[1] = instr & 0x3f;
  for (let i = 0; i < 16; i++) b[4 + i] = (data[i] || 0) & 0x3f;
  return b;
}
const colors = [[0, 0, 0], [15, 3, 9], [2, 14, 15], [15, 13, 4], [15, 15, 15]]; // 4-bit RGB
function colorTable() {
  const d = [];
  for (let i = 0; i < 8; i++) { const [r, g, b] = colors[i] || [0, 0, 0]; d.push((r << 2) | (g >> 2), ((g & 3) << 4) | b); }
  return packet(30, d);
}
function tile(row, col, c0, c1, rows) { return packet(6, [c0, c1, row, col, ...rows]); }
function makeCdg(seconds) {
  const out = [];
  out.push(packet(1, [0]), packet(2, [0]), colorTable());
  const per = 300; // packets per second
  for (let s = 0; s < seconds; s++) {
    const pk = [];
    // a coloured bar that grows across the screen, one column per second — "lyrics" being wiped in
    for (let r = 7; r <= 10; r++) pk.push(tile(r, 2 + (s % 46), 0, 1 + (s % 3), Array(12).fill(0x3f)));
    while (pk.length < per) pk.push(Buffer.alloc(24));
    out.push(...pk);
  }
  return Buffer.concat(out);
}

// ---- stored (uncompressed) zip writer ----
function makeZip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, data] of files) {
    const nb = Buffer.from(name), crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, data); centrals.push(ch, nb); off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

function build(dir, ffmpeg = 'ffmpeg') {
  fs.mkdirSync(path.join(dir, 'Sound Choice', 'SC8123'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Videos'), { recursive: true });
  const sec = 12;
  const cdg = makeCdg(sec);
  const mp3 = path.join(dir, 'Sound Choice', 'SC8123', 'SC8123-05 - Bon Jovi - Livin On A Prayer.mp3');
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${sec}`, '-c:a', 'libmp3lame', '-b:a', '128k', mp3]);
  fs.writeFileSync(mp3.replace(/\.mp3$/, '.cdg'), cdg);
  fs.writeFileSync(path.join(dir, 'Sound Choice', 'SC8123', 'SC8123-06 - Toto - Africa.zip'), makeZip([['SC8123-06 - Toto - Africa.cdg', cdg], ['SC8123-06 - Toto - Africa.mp3', fs.readFileSync(mp3)]]));
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(dir, 'Videos', 'Journey - Faithfully.mp4')]);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=550', '-t', '8', '-c:v', 'mpeg4', '-c:a', 'libmp3lame', path.join(dir, 'Videos', 'Queen - Bohemian Rhapsody (Karaoke).mkv')]);
  return dir;
}

if (require.main === module) { build(process.argv[2] || 'test-library'); console.log('made', process.argv[2] || 'test-library'); }
module.exports = { build };
