#!/usr/bin/env bash
# KARAO-Q launcher — Linux & macOS.
# Starts the server and opens the TV screen fullscreen. Close that window (Alt+F4 / Cmd+Q) and everything shuts down.
# The first run also adds KARAO-Q to your app menu (Linux) or Applications folder (macOS), so after that it's one click.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")"
APP_DIR="$PWD"
PORT="${PORT:-8080}"
export PORT
mkdir -p data
IS_MAC=0; [[ "$(uname)" == "Darwin" ]] && IS_MAC=1

# Launched from the app menu (no terminal)? Log to a file and report problems as desktop notifications.
TTY=0; [ -t 1 ] && TTY=1
if [ "$TTY" = 0 ]; then exec >>"data/karaoq.log" 2>&1; echo "---- $(date) ----"; fi
say() {
  echo "$1"
  if [ "$TTY" = 0 ]; then
    if [ "$IS_MAC" = 1 ]; then osascript -e "display notification \"${1//\"/\\\"}\" with title \"KARAO-Q\"" >/dev/null 2>&1 || true
    else notify-send -i "$APP_DIR/assets/icon.png" "KARAO-Q" "$1" >/dev/null 2>&1 || true; fi
  fi
}

# ---------- requirements ----------
MISSING=""
need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ Missing: $1 — $2"; MISSING="$MISSING $1"; }; }
need node   "Node 18+ (Arch: sudo pacman -S nodejs npm · macOS: brew install node · https://nodejs.org)"
need yt-dlp "Arch: sudo pacman -S yt-dlp · macOS: brew install yt-dlp · others: pipx install yt-dlp"
need ffmpeg "Arch: sudo pacman -S ffmpeg · macOS: brew install ffmpeg"
command -v deno >/dev/null 2>&1 || echo "! deno not found — recent yt-dlp needs it for YouTube: curl -fsSL https://deno.land/install.sh | sh"
command -v cloudflared >/dev/null 2>&1 || echo "· Optional: install cloudflared for the \"Can't connect?\" internet QR"
if [ -n "$MISSING" ]; then say "Can't start — missing:$MISSING. Run ~/karaoq/start.sh in a terminal for install tips."; exit 1; fi

[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund

# ---------- one-time setup ----------
install_launcher() {
  if [ "$IS_MAC" = 1 ]; then
    local app="$HOME/Applications/KARAO-Q.app"
    [ -d "$app" ] && return
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    printf '#!/bin/bash\nexec "%s/start.sh"\n' "$APP_DIR" > "$app/Contents/MacOS/KARAO-Q"
    chmod +x "$app/Contents/MacOS/KARAO-Q"
    cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>KARAO-Q</string><key>CFBundleExecutable</key><string>KARAO-Q</string>
<key>CFBundleIdentifier</key><string>app.karaoq</string><key>CFBundleIconFile</key><string>icon</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>
PLIST
    # Build a proper .icns from the PNG with macOS's own tools
    local set; set="$(mktemp -d)/icon.iconset"; mkdir -p "$set"
    for s in 16 32 128 256; do sips -z $s $s assets/icon.png --out "$set/icon_${s}x${s}.png" >/dev/null 2>&1 || true; done
    iconutil -c icns "$set" -o "$app/Contents/Resources/icon.icns" >/dev/null 2>&1 || true
    echo "✓ Added KARAO-Q to ~/Applications"
  else
    local desk="$HOME/.local/share/applications/karaoq.desktop"
    local icon="$HOME/.local/share/icons/hicolor/256x256/apps/karaoq.png"
    mkdir -p "$(dirname "$desk")" "$(dirname "$icon")"
    cp -f assets/icon.png "$icon"
    cat > "$desk" <<DESK
[Desktop Entry]
Type=Application
Name=KARAO-Q
GenericName=Karaoke Party Queue
Comment=YouTube karaoke with a shared queue from everyone's phones
Exec="$APP_DIR/start.sh"
Icon=karaoq
Terminal=false
Categories=AudioVideo;Audio;Video;Player;
Keywords=karaoke;sing;queue;party;youtube;
StartupNotify=true
DESK
    chmod +x "$desk"
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$desk")" >/dev/null 2>&1 || true
    echo "✓ KARAO-Q is in your app menu"
  fi
}
install_launcher || true

# Open the port in the firewall once so phones can connect (ufw: CachyOS/Ubuntu · firewalld: Fedora).
FW_MARK="data/.firewall-$PORT"
if [ "$IS_MAC" = 0 ] && [ ! -f "$FW_MARK" ]; then
  # In a terminal: sudo. From the app menu: pkexec pops up a normal password dialog.
  if [ "$TTY" = 1 ]; then ROOT=(sudo); elif command -v pkexec >/dev/null 2>&1; then ROOT=(pkexec); else ROOT=(); fi
  if [ ${#ROOT[@]} -gt 0 ]; then
    if command -v ufw >/dev/null 2>&1; then
      say "One-time setup: allowing phones through the firewall (port $PORT). Enter your password."
      "${ROOT[@]}" ufw allow "$PORT/tcp" comment 'KARAO-Q' && touch "$FW_MARK" || true
    elif command -v firewall-cmd >/dev/null 2>&1; then
      say "One-time setup: allowing phones through the firewall (port $PORT). Enter your password."
      "${ROOT[@]}" sh -c "firewall-cmd --permanent --add-port=$PORT/tcp && firewall-cmd --reload" && touch "$FW_MARK" || true
    else
      touch "$FW_MARK"
    fi
  fi
fi

# Keep yt-dlp fresh — stale yt-dlp is the #1 cause of failed downloads. (No-op if your package manager owns it.)
yt-dlp -U >/dev/null 2>&1 || true

URL="http://localhost:$PORT/stage"

# ---------- browser ----------
# The TV screen runs in its OWN browser instance (separate profile), so it never lands in a browser you already have open.
chromium_like() {
  "$1" --kiosk --autoplay-policy=no-user-gesture-required --user-data-dir="$APP_DIR/data/chromium-profile" \
    --no-first-run --noerrdialogs --disable-session-crashed-bubble --disable-features=Translate "--app=$URL"
}
firefox_like() {
  local prof="$APP_DIR/data/firefox-profile"
  mkdir -p "$prof"
  cat > "$prof/user.js" <<'PREFS'
user_pref("media.autoplay.default", 0);
user_pref("media.autoplay.blocking_policy", 0);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
PREFS
  "$1" --new-instance --no-remote --profile "$prof" --kiosk "$URL"
}
launch() {
  if [ "$IS_MAC" = 1 ]; then
    for app in "Google Chrome" "Chromium" "Brave Browser" "Microsoft Edge"; do
      BIN="/Applications/$app.app/Contents/MacOS/$app"
      [ -x "$BIN" ] && { chromium_like "$BIN"; return; }
    done
    BIN="/Applications/Firefox.app/Contents/MacOS/firefox"
    [ -x "$BIN" ] && { firefox_like "$BIN"; return; }
  else
    for b in chromium chromium-browser google-chrome google-chrome-stable brave-browser brave microsoft-edge; do
      command -v "$b" >/dev/null 2>&1 && { chromium_like "$b"; return; }
    done
    for b in firefox firefox-esr librewolf; do
      command -v "$b" >/dev/null 2>&1 && { firefox_like "$b"; return; }
    done
  fi
  return 1
}

# Already running (icon clicked twice)? Just reopen the TV screen.
if curl -fs "http://localhost:$PORT/api/join" >/dev/null 2>&1; then
  say "KARAO-Q is already running — opening the TV screen."
  launch >/dev/null 2>&1 & disown
  exit 0
fi

# ---------- server ----------
AUTO_EXIT=1 node server.js &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

READY=0
for _ in $(seq 1 75); do
  kill -0 $SERVER 2>/dev/null || { say "KARAO-Q's server crashed on startup. Details: $APP_DIR/data/karaoq.log"; exit 1; }
  curl -fs "http://localhost:$PORT/api/join" >/dev/null 2>&1 && { READY=1; break; }
  sleep 0.2
done
[ "$READY" = 1 ] || { say "KARAO-Q's server didn't start within 15 s. Details: $APP_DIR/data/karaoq.log"; exit 1; }

# Fire and forget: the server watches the TV screen itself and exits ~10 s after it's closed.
launch >/dev/null 2>&1 &
echo "  TV screen opening at $URL"
echo "  Close it (Alt+F4) and everything shuts down ~10 s later. Ctrl+C here also stops it."
wait $SERVER
