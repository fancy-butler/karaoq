'use strict';
// KARAO-Q desktop app (Electron). Everything is bundled: Node (Electron's own), yt-dlp, ffmpeg, deno and
// cloudflared. Double-click → the TV screen opens fullscreen with the join QR. Close the window → it all shuts down.
const { app, BrowserWindow, Menu, dialog, shell, Notification } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

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
  else server.kill('SIGTERM');
}

async function start() {
  fs.mkdirSync(dataDir, { recursive: true });
  const ytdlp = prepareYtdlp();
  const port = await freePort(8080);
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
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// ---------- updates ----------
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
      if (Notification.isSupported()) new Notification({ title: `KARAO-Q ${info.version} downloaded`, body: 'It will install the next time you close KARAO-Q.' }).show();
    });
    autoUpdater.checkForUpdates().catch(e => log(`update check failed: ${e.message}`));
  }
}

// macOS needs an app menu for Cmd+Q / Cmd+F to work; elsewhere no menu bar at all.
Menu.setApplicationMenu(process.platform === 'darwin'
  ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }])
  : null);

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => { start(); setTimeout(checkForUpdates, 15000); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; stopServer(); });
