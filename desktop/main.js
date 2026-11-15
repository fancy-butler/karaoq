'use strict';
// KARAO-Q desktop app (Electron). Everything is bundled: Node (Electron's own), yt-dlp, ffmpeg, deno and
// cloudflared. Double-click → the TV screen opens fullscreen with the join QR. Close the window → it all shuts down.
const { app, BrowserWindow, Menu, dialog, shell, Notification, session, systemPreferences } = require('electron');
const { spawn, execFile } = require('child_process');
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
  server = spawn(process.execPath, [path.join(appRoot, 'server.js')], { env, cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const out = fs.createWriteStream(logFile, { flags: 'a' });
  server.stdout.pipe(out); server.stderr.pipe(out);
  server.on('exit', code => {
    if (quitting) return;
    dialog.showErrorBox('KARAO-Q', `KARAO-Q stopped unexpectedly (code ${code}).\n\nDetails are in:\n${logFile}`);
    app.quit();
  });

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
    else if (url.startsWith('karaoq:check')) tellStage();
    else shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', tellStage);
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
let updateReady = null, updaterRef = null;
// Show the "Restart to update" button on the TV (the stage page asks via window.open('karaoq:…')).
function tellStage() {
  if (updateReady && win && !win.isDestroyed()) win.webContents.executeJavaScript(`window.KQUpdateReady && window.KQUpdateReady(${JSON.stringify(updateReady)})`).catch(() => { });
}
function installNow() {
  if (!updaterRef || !updateReady) return;
  log(`restart to update → ${updateReady}`);
  quitting = true;
  try { fs.writeFileSync(path.join(dataDir, '.closing'), String(Date.now())); } catch { }
  stopServer();
  setTimeout(() => updaterRef.quitAndInstall(true, true), 800); // silent install, then reopen KARAO-Q
}
// Windows + Linux: download quietly, install when the app is closed (never mid-song).
// macOS: unsigned apps can't self-update, so just say a new version is out and link to it.
function checkForUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return log(`updater unavailable: ${e.message}`); }
  autoUpdater.logger = { info: log, warn: log, error: log, debug() { } };
  if (process.platform === 'darwin') {
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', info => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: `KARAO-Q ${info.version} is out`, body: 'Click to download the new version.' });
      n.on('click', () => shell.openExternal('https://github.com/fancy-butler/karaoq/releases/latest'));
      n.show();
    });
    autoUpdater.checkForUpdates().catch(e => log(`update check failed: ${e.message}`));
  } else {
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', info => {
      updateReady = info.version;
      tellStage();
      if (Notification.isSupported()) new Notification({ title: `KARAO-Q ${info.version} is ready`, body: 'Use "Restart to update" on the TV screen, or it installs next time you close KARAO-Q.' }).show();
    });
    updaterRef = autoUpdater;
    autoUpdater.checkForUpdates().catch(e => log(`update check failed: ${e.message}`));
  }
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
  start(); setTimeout(checkForUpdates, 15000);
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (!gotLock) return;
  quitting = true;
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(path.join(dataDir, '.closing'), String(Date.now())); } catch { }
  stopServer();
});
