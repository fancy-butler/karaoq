'use strict';
// Downloads the helper programs KARAO-Q bundles into the desktop app, for the platform this runs on:
// yt-dlp (YouTube), deno (yt-dlp's JS runtime), cloudflared (the "Can't connect?" link) and ffmpeg.
// Used by the GitHub Actions build; you can also run it locally before `npm run app`.
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const plat = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
// --arch arm64 / --arch x64 bundles for another CPU than this machine's (e.g. Apple Silicon on an Intel Mac)
const ai = process.argv.indexOf('--arch');
const arch = ai > 0 ? process.argv[ai + 1] : process.arch;
const arm = arch === 'arm64';
const out = path.join(__dirname, '..', 'bin', `${plat}-${arch}`);
fs.mkdirSync(out, { recursive: true });
const exe = n => (plat === 'win' ? `${n}.exe` : n);
const gh = (repo, file) => `https://github.com/${repo}/releases/latest/download/${file}`;

const files = {
  linux: {
    ytdlp: arm ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux',
    deno: arm ? 'deno-aarch64-unknown-linux-gnu.zip' : 'deno-x86_64-unknown-linux-gnu.zip',
    cf: arm ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64',
  },
  win: { ytdlp: 'yt-dlp.exe', deno: 'deno-x86_64-pc-windows-msvc.zip', cf: 'cloudflared-windows-amd64.exe' },
  mac: {
    ytdlp: 'yt-dlp_macos',
    deno: arm ? 'deno-aarch64-apple-darwin.zip' : 'deno-x86_64-apple-darwin.zip',
    cf: arm ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz',
  },
}[plat];

function download(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'karaoq-build' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 10) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, dest, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} → HTTP ${res.statusCode}`)); }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
      f.on('error', reject);
    }).on('error', reject);
  });
}

function extract(archive, dir) {
  if (archive.endsWith('.zip')) {
    if (plat === 'linux') execFileSync('unzip', ['-o', archive, '-d', dir], { stdio: 'inherit' });
    else execFileSync('tar', ['-xf', archive, '-C', dir], { stdio: 'inherit' }); // bsdtar on Windows/macOS reads zips
  } else execFileSync('tar', ['-xzf', archive, '-C', dir], { stdio: 'inherit' });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoq-bin-'));

  console.log('yt-dlp…');
  await download(gh('yt-dlp/yt-dlp', files.ytdlp), path.join(out, exe('yt-dlp')));

  console.log('deno…');
  const denoZip = path.join(tmp, 'deno.zip');
  await download(gh('denoland/deno', files.deno), denoZip);
  extract(denoZip, out);

  console.log('cloudflared…');
  if (files.cf.endsWith('.tgz')) {
    const t = path.join(tmp, 'cf.tgz');
    await download(gh('cloudflare/cloudflared', files.cf), t);
    extract(t, out);
  } else await download(gh('cloudflare/cloudflared', files.cf), path.join(out, exe('cloudflared')));

  console.log('ffmpeg…');
  let ff = require('ffmpeg-static'); // devDependency: fetched for this OS/CPU at npm install time
  if (arch !== process.arch) {
    // fetch ffmpeg-static's build for the other CPU: run its installer from a copy, with npm_config_arch set
    const src = path.dirname(require.resolve('ffmpeg-static/package.json'));
    const copy = path.join(src, '..', `ffmpeg-static-${arch}`);
    fs.rmSync(copy, { recursive: true, force: true });
    fs.cpSync(src, copy, { recursive: true });
    for (const f of ['ffmpeg', 'ffmpeg.exe']) fs.rmSync(path.join(copy, f), { force: true });
    execFileSync(process.execPath, ['install.js'], { cwd: copy, stdio: 'inherit', env: { ...process.env, npm_config_arch: arch } });
    ff = path.join(copy, exe('ffmpeg'));
  }
  if (!ff || !fs.existsSync(ff)) throw new Error('ffmpeg-static binary missing — run npm ci first');
  fs.copyFileSync(ff, path.join(out, exe('ffmpeg')));

  for (const f of fs.readdirSync(out)) fs.chmodSync(path.join(out, f), 0o755);
  console.log(`Bundled into ${out}:`, fs.readdirSync(out).join(', '));
})().catch(e => { console.error(e); process.exit(1); });
