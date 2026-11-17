'use strict';
// KARAO-Q desktop app (Electron). Everything is bundled: Node (Electron's own), yt-dlp, ffmpeg, deno and
// cloudflared. Double-click → the TV screen opens fullscreen with the join QR. Close the window → it all shuts down.
const { app, BrowserWindow, Menu, dialog, shell, Notification, session, systemPreferences, powerSaveBlocker } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
let gotLock = app.requestSingleInstanceLock();

const isWin = process.platform === 'win32';
const exe = name => (isWin ? `${name}.exe` : name);
const appRoot = path.join(__dirname, '..');
const platDir = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform] + '-' + process.arch;
const resBin = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(appRoot, 'bin', platDir);
const userDir = app.getPath('userData');
const dataDir = path.join(userDir, 'data');
const userBin = path.join(userDir, 'bin');
const logFile = path.join(dataDir, 'karaoq.log');

let server = null, win = null, quitting = false;

// yt-dlp lives in a writable copy so it can update itself — YouTube changes break old versions.
function prepareYtdlp() {
  fs.mkdirSync(userBin, { recursive: true });
  const src = path.join(resBin, exe('yt-dlp'));
  const dst = path.join(userBin, exe('yt-dlp'));
  try {
    if (fs.existsSync(src) && (!fs.existsSync(dst) || fs.statSync(src).mtimeMs > fs.statSync(dst).mtimeMs)) {
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
    }
  } catch (e) { log(`yt-dlp copy failed: ${e.message}`); }
  if (fs.existsSync(dst)) return dst; // the server keeps it updated (startup, twice a day, and after failures)
  return 'yt-dlp';
}

function log(line) { try { fs.appendFileSync(logFile, `[app ${new Date().toISOString()}] ${line}\n`); } catch { } }

function freePort(start) {
  return new Promise(resolve => {
    const attempt = p => {
      const s = net.createServer();
      s.once('error', () => attempt(p + 1));
      s.once('listening', () => s.close(() => resolve(p)));
      s.listen(p, '0.0.0.0');
    };
    attempt(start);
  });
}

function waitForServer(port, ms = 25000) {
  const until = Date.now() + ms;
  return new Promise(resolve => {
    const poll = () => {
      if (!server || server.exitCode !== null) return resolve(false);
      const req = http.get({ host: '127.0.0.1', port, path: '/api/join', timeout: 1000 }, res => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => (Date.now() > until ? resolve(false) : setTimeout(poll, 250)));
      req.on('timeout', () => req.destroy());
    };
    poll();
  });
}

// Linux AppImage: AppImages don't install a menu entry or icon by themselves, so docks and launchers
// (Cairo Dock, Plank, the app menu…) show nothing. Add/refresh one on every launch, pointing at wherever
// the AppImage lives now. Removing KARAO-Q = delete the AppImage and these two files.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('class', 'karaoq'); // X11 window class, matched by StartupWMClass below
  try { if (app.setDesktopName) app.setDesktopName('karaoq.desktop'); } catch { } // Wayland app id → same entry
}
function linuxDesktopEntry() {
  if (process.platform !== 'linux' || !process.env.APPIMAGE) return;
  try {
    const os = require('os');
    const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    const iconDir = path.join(data, 'icons', 'hicolor', '256x256', 'apps'); // assets/icon.png is 256×256
    fs.mkdirSync(iconDir, { recursive: true });
    const icon = path.join(iconDir, 'karaoq.png');
    const src = path.join(appRoot, 'assets', 'icon.png');
    if (!fs.existsSync(icon) || fs.statSync(icon).size !== fs.statSync(src).size) fs.copyFileSync(src, icon);
    const q = s => `"${s.replace(/(["`$\\])/g, '\\$1')}"`;
    const entry = ['[Desktop Entry]', 'Type=Application', 'Name=KARAO-Q', 'GenericName=Karaoke party',
      'Comment=Party karaoke with a shared phone queue', `Exec=${q(process.env.APPIMAGE)} %U`, `TryExec=${process.env.APPIMAGE}`,
      `Icon=karaoq`, 'Terminal=false', 'Categories=AudioVideo;Audio;Video;', 'Keywords=karaoke;party;sing;youtube;', 'StartupWMClass=karaoq',
      'X-AppImage-Integrate=false', ''].join('\n');
    const appsDir = path.join(data, 'applications');
    fs.mkdirSync(appsDir, { recursive: true });
    const file = path.join(appsDir, 'karaoq.desktop');
    let old = ''; try { old = fs.readFileSync(file, 'utf8'); } catch { }
    if (old !== entry) {
      fs.writeFileSync(file, entry, { mode: 0o755 });
      log(`menu entry written: ${file} → ${process.env.APPIMAGE}`);
      require('child_process').execFile('update-desktop-database', [appsDir], () => { });
      require('child_process').execFile('gtk-update-icon-cache', ['-f', '-t', path.join(data, 'icons', 'hicolor')], () => { });
    }
  } catch (e) { log(`menu entry: ${e.message}`); }
}

// Linux: most desktop distros with ufw block incoming connections, so phones can't reach us.
// Ask once, with the system's normal password dialog (pkexec). Windows and macOS prompt by themselves.
function linuxFirewall(port) {
  return new Promise(resolve => {
    if (process.platform !== 'linux') return resolve();
    const mark = path.join(dataDir, `.firewall-${port}`);
    const ufw = ['/usr/bin/ufw', '/usr/sbin/ufw', '/bin/ufw'].find(p => fs.existsSync(p));
    if (fs.existsSync(mark) || !ufw) return resolve();
    const p = spawn('pkexec', [ufw, 'allow', `${port}/tcp`, 'comment', 'KARAO-Q'], { stdio: 'ignore' });
    p.on('error', () => resolve());
    p.on('exit', code => { if (code === 0) fs.writeFileSync(mark, ''); resolve(); });
  });
}

function stopServer() {
  if (!server || server.exitCode !== null) return;
  // Windows has no SIGTERM: kill the whole tree so the internet-link helper doesn't linger.
  if (isWin) spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    server.kill('SIGTERM');
    const s = server; setTimeout(() => { if (s.exitCode === null) { log('server ignored SIGTERM — killing'); try { s.kill('SIGKILL'); } catch { } } }, 3000).unref();
  }
}

let port = 8080;
// 🎤 mics: allow the TV page to use audio inputs/outputs; on a Mac, ask macOS for microphone access first
function allowMedia() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (permission !== 'media') return cb(true);
    const wantsAudio = !details || !details.mediaTypes || details.mediaTypes.includes('audio');
    if (process.platform === 'darwin' && wantsAudio) return systemPreferences.askForMediaAccess('microphone').then(cb, () => cb(false));
    cb(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);
}

async function start() {
  allowMedia();
  fs.mkdirSync(dataDir, { recursive: true });
  const ytdlp = prepareYtdlp();
  port = await freePort(8080);
  await linuxFirewall(port);

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(port),
    DATA_DIR: dataDir,
    YTDLP: ytdlp,
    CLOUDFLARED: path.join(resBin, exe('cloudflared')),
    PATH: [userBin, resBin, process.env.PATH || ''].join(path.delimiter), // yt-dlp finds ffmpeg + deno here
  };
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  // If the server ever falls over mid-party, bring it straight back (the queue is saved on disk) and reload
  // the TV page. Only give up and say so if it keeps dying.
  const crashes = [];
  const launch = () => {
    server = spawn(process.execPath, [path.join(appRoot, 'server.js')], { env, cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    server.stdout.pipe(out, { end: false }); server.stderr.pipe(out, { end: false });
    server.on('exit', async code => {
      if (quitting) return;
      const now = Date.now();
      crashes.push(now);
      while (crashes.length && now - crashes[0] > 5 * 60 * 1000) crashes.shift();
      log(`server stopped unexpectedly (code ${code}) — restart #${crashes.length}`);
      if (crashes.length > 3) {
        dialog.showErrorBox('KARAO-Q', `KARAO-Q keeps stopping (code ${code}).\n\nDetails are in:\n${logFile}`);
        quitting = true; app.quit(); return;
      }
      await new Promise(r => setTimeout(r, 1000));
      launch();
      if (await waitForServer(port) && win && !win.isDestroyed()) win.reload();
    });
  };
  launch();

  if (!(await waitForServer(port))) {
    dialog.showErrorBox('KARAO-Q', `KARAO-Q couldn't start.\n\nDetails are in:\n${logFile}`);
    quitting = true; stopServer(); app.quit(); return;
  }

  win = new BrowserWindow({
    fullscreen: true,
    backgroundColor: '#07030d',
    title: 'KARAO-Q',
    icon: path.join(appRoot, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
  });
  win.loadURL(`http://localhost:${port}/stage`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('karaoq:update')) installNow();
    else if (url.startsWith('karaoq:pickfolder')) pickLibraryFolder();
    else if (url.startsWith('karaoq:report')) saveReport();
    else if (url.startsWith('karaoq:checkupdate')) checkNow(true);
    else if (url.startsWith('karaoq:check')) tellStage();
    else shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', tellStage);
  // make sure keyboard shortcuts reach the TV straight away (Windows doesn't always focus a new window)
  win.webContents.on('did-finish-load', () => { if (win && !win.isDestroyed()) { win.focus(); win.webContents.focus(); } });
}

// ---------- 🐞 bug report: one file in Downloads with everything needed to diagnose a problem ----------
async function saveReport() {
  const os = require('os');
  const get = async p => { try { return await (await fetch(`http://127.0.0.1:${port}${p}`)).json(); } catch (e) { return { error: e.message }; } };
  let logTail = '';
  try { logTail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-3000).join('\n'); } catch (e) { logTail = `(no log: ${e.message})`; }
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'party.json'), 'utf8')).settings; } catch { }
  const [about, preflight, libraryInfo] = await Promise.all([get('/api/about'), get('/api/preflight'), get('/api/library')]);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = path.join(app.getPath('downloads'), `KARAO-Q-report-${stamp}.txt`);
  const text = [
    `KARAO-Q bug report — ${new Date().toString()}`,
    `App ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform} ${os.release()} ${process.arch} · ${os.cpus()[0]?.model || ''} · ${Math.round(os.totalmem() / 1e9)} GB RAM`,
    `Server: ${JSON.stringify(about)}`,
    '', '== Pre-party check ==', JSON.stringify(preflight, null, 1),
    '', '== Settings ==', JSON.stringify(settings, null, 1),
    '', '== Karaoke library ==', JSON.stringify(libraryInfo, null, 1),
    '', '== Log (last 3000 lines) ==', logTail,
  ].join('\n');
  try {
    fs.writeFileSync(file, text);
    log(`bug report saved: ${file}`);
    shell.showItemInFolder(file);
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript(`window.KQReportSaved && window.KQReportSaved(${JSON.stringify(file)})`).catch(() => { });
  } catch (e) { dialog.showErrorBox('KARAO-Q', `Couldn't save the report: ${e.message}`); }
}

// ---------- 💾 karaoke library folder picker ----------
async function pickLibraryFolder() {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder of karaoke files', properties: ['openDirectory', 'multiSelections'] });
  if (r.canceled) return;
  for (const dir of r.filePaths) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/library/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir }) });
      log(`library folder added: ${dir}`);
    } catch (e) { log(`library add failed: ${e.message}`); }
  }
  if (win && !win.isDestroyed()) win.webContents.executeJavaScript('window.KQLibraryChanged && window.KQLibraryChanged()').catch(() => { });
}

// ---------- updates ----------
// Checks at start-up and every 30 minutes, and on demand from the TV menu ("Check for updates").
// Windows + Linux AppImage: download quietly, then offer "Restart to update" between songs (or install on close).
// macOS: unsigned apps can't self-update, so say a new version is out and open the download page.
let updateReady = null, updaterRef = null, updChecking = false, updManual = false;
const RELEASES = 'https://github.com/fancy-butler/karaoq/releases/latest';
function toStage(fn, arg) { if (win && !win.isDestroyed()) win.webContents.executeJavaScript(`window.${fn} && window.${fn}(${JSON.stringify(arg)})`).catch(() => { }); }
function tellStage() { if (updateReady) toStage('KQUpdateReady', updateReady); }
function updStatus(msg) { log(`update: ${msg}`); if (updManual) toStage('KQUpdateStatus', msg); }
function installNow() {
  if (!updaterRef || !updateReady) { checkNow(true); return; }
  log(`restart to update → ${updateReady}`);
  quitting = true;
  try { fs.writeFileSync(path.join(dataDir, '.closing'), String(Date.now())); } catch { }
  stopServer();
  setTimeout(() => updaterRef.quitAndInstall(true, true), 800); // silent install, then reopen KARAO-Q
}
function checkNow(manual) {
  if (manual) updManual = true;
  if (!app.isPackaged) return updStatus(`Updates only work in the installed app (this is v${app.getVersion()} from source)`);
  if (updateReady) return tellStage();
  if (process.platform === 'linux' && !process.env.APPIMAGE) return updStatus(`Auto-update only works when KARAO-Q runs from its .AppImage file — download the new version from GitHub`);
  if (!updaterRef) return updStatus('The update checker is still starting — try again in a few seconds');
  if (updChecking) return updStatus('Still checking…');
  updChecking = true;
  updaterRef.checkForUpdates().catch(e => { updChecking = false; updStatus(`Couldn't check for updates: ${e.message.split('\n')[0]}`); });
}
function checkForUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return log(`updater unavailable: ${e.message}`); }
  autoUpdater.logger = { info: log, warn: log, error: log, debug() { } };
  const mac = process.platform === 'darwin';
  autoUpdater.autoDownload = !mac;
  autoUpdater.autoInstallOnAppQuit = !mac;
  autoUpdater.on('checking-for-update', () => updStatus('Checking for updates…'));
  autoUpdater.on('update-not-available', () => { updChecking = false; updStatus(`You're up to date (v${app.getVersion()})`); updManual = false; });
  autoUpdater.on('update-available', info => {
    updChecking = false;
    if (mac) {
      updStatus(`KARAO-Q ${info.version} is out — opening the download page`);
      if (updManual) shell.openExternal(RELEASES);
      else if (Notification.isSupported()) { const n = new Notification({ title: `KARAO-Q ${info.version} is out`, body: 'Click to download the new version.' }); n.on('click', () => shell.openExternal(RELEASES)); n.show(); }
      updManual = false;
    } else updStatus(`Downloading v${info.version}…`);
  });
  autoUpdater.on('download-progress', p => { if (updManual && p.percent) toStage('KQUpdateStatus', `Downloading… ${Math.round(p.percent)}%`); });
  autoUpdater.on('update-downloaded', info => {
    updateReady = info.version; updManual = false;
    tellStage();
    if (Notification.isSupported()) new Notification({ title: `KARAO-Q ${info.version} is ready`, body: 'Use "Restart to update" on the TV screen, or it installs next time you close KARAO-Q.' }).show();
  });
  autoUpdater.on('error', e => { updChecking = false; updStatus(`Update failed: ${String(e && e.message || e).split('\n')[0]}`); updManual = false; });
  updaterRef = autoUpdater;
  checkNow(false);
  setInterval(() => checkNow(false), 30 * 60 * 1000);
}

// macOS needs an app menu for Cmd+Q / Cmd+F to work; elsewhere no menu bar at all.
Menu.setApplicationMenu(process.platform === 'darwin'
  ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }])
  : null);

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
// Opened again while the last session is still closing (e.g. installing an update)? Wait for it instead of
// silently giving up — that used to leave you clicking the icon with nothing happening.
async function waitForLock() {
  const closing = path.join(dataDir, '.closing');
  let fresh = false;
  try { fresh = Date.now() - fs.statSync(closing).mtimeMs < 60000; } catch { }
  const until = Date.now() + (fresh ? 45000 : 4000);
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 500));
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}

app.whenReady().then(async () => {
  if (!gotLock) {
    gotLock = await waitForLock();
    if (!gotLock) { app.quit(); return; } // a running KARAO-Q got focused instead
  }
  try { fs.unlinkSync(path.join(dataDir, '.closing')); } catch { }
  // Keep the screen awake while KARAO-Q is open — between songs nothing is "playing", so the computer
  // would otherwise dim or sleep the display mid-party. Released the moment KARAO-Q closes.
  try { powerSaveBlocker.start('prevent-display-sleep'); } catch { }
  linuxDesktopEntry();
  start(); setTimeout(checkForUpdates, 15000);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (!gotLock) return;
  quitting = true;
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, '.closing'), String(Date.now())); } catch { }
  stopServer();
});
