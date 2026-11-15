# 🎤 KARAO-Q

YouTube karaoke for parties, without passing a keyboard around. One computer drives the TV. Everyone else adds songs from their phone by scanning a QR code, and nobody installs an app.

There are no ads to block. Songs are fetched with **yt-dlp** and played from a local file, so YouTube's player (and its ads, "are you still watching?" prompts and autoplay junk) never comes into it. Each song is downloaded while the one before it plays, so there's no buffering gap between singers.

Works on **Linux, Windows and macOS**.

## ⬇ Download (easiest)
Grab the installer for your computer from the **[latest release](https://github.com/fancy-butler/karaoq/releases/latest)**. Everything is built in, so there's nothing else to install:

| | File | First launch |
|---|---|---|
| **Windows** | `KARAO-Q-…-win-x64.exe` | If a blue "Windows protected your PC" box shows, click **More info → Run anyway**. Allow the firewall prompt so phones can connect. |
| **macOS** | `KARAO-Q-…-mac-arm64.dmg` (M1 or newer) or `KARAO-Q-…-mac-x64.dmg` (Intel; needs macOS 12 Monterey or newer) | Drag to Applications. The app isn't Apple-signed, so macOS blocks the first launch — see **[First launch on a Mac](#first-launch-on-a-mac)** below. |
| **Linux** | `KARAO-Q-…-linux-x86_64.AppImage` | Right-click → Properties → allow executing, then double-click. You may be asked for your password once so phones can get through the firewall. |

### First launch on a Mac
KARAO-Q isn't signed with a paid Apple developer certificate, so macOS is suspicious of it once:

1. Open KARAO-Q from Applications. macOS says it can't be opened → click **Done** (not "Move to Trash").
2. Open **System Settings → Privacy & Security**, scroll down to *"KARAO-Q was blocked…"* and click **Open Anyway**, then confirm with your password or Touch ID.
3. If instead it says **"KARAO-Q is damaged and can't be opened"**, it isn't really damaged: macOS just won't run unsigned downloads. Open **Terminal** and paste:
   ```
   xattr -dr com.apple.quarantine /Applications/KARAO-Q.app
   ```
   then open it again.

After that it opens normally. Not sure which Mac you have? Apple menu → **About This Mac**: "Chip: Apple M…" → arm64, "Processor: …Intel…" → x64.

### First launch on Windows
- **"Windows protected your PC"** (blue box): click **More info → Run anyway**. It shows because the installer isn't signed with a paid certificate.
- **Windows Firewall prompt**: tick **Private networks** and click **Allow** — otherwise phones can't connect over Wi-Fi (the internet "Can't connect?" link still works).

Plug the computer into the TV, open KARAO-Q, and everyone scans the QR code. Close the window to quit.

**Updates:** on Windows and Linux, KARAO-Q downloads new versions in the background. Between songs, the TV shows **⬆ Restart to update**: click it and KARAO-Q updates and reopens by itself in a few seconds (the queue is kept). Or ignore it and the update installs the next time you close KARAO-Q. On a Mac, you'll get a notification with a link to the new version.

Downloaded songs are capped at 5 GB by default (change it in ⚙ Settings on a phone). The oldest unplayed songs get deleted first, and queued songs are never touched. After 6+ hours with nothing happening (whether KARAO-Q was closed or left open), it starts a new night: empty queue, fresh counts, and a Restore/Clear banner for last time's leftovers.

---

## Run from source (for tinkering)

---

## Setup (one time)

You need four things on the party computer:

| | Linux | Windows | macOS |
|---|---|---|---|
| Node 18+ | `sudo apt install nodejs npm` | `winget install OpenJS.NodeJS.LTS` | `brew install node` |
| yt-dlp | `pipx install yt-dlp` | `winget install yt-dlp.yt-dlp` | `brew install yt-dlp` |
| ffmpeg | `sudo apt install ffmpeg` | `winget install Gyan.FFmpeg` | `brew install ffmpeg` |
| deno | `curl -fsSL https://deno.land/install.sh \| sh` | `winget install DenoLand.Deno` | `brew install deno` |

(Recent yt-dlp needs deno to handle YouTube.) You also need any Chromium-type browser: Chrome, Chromium, Brave or Edge.

### Optional: the "Can't connect?" internet QR
Some phones can't reach the party computer over Wi-Fi: guest networks, routers that wall devices off from each other, people on mobile data. Install **cloudflared** and KARAO-Q shows a second QR code that works from any network.

| Linux (Arch/CachyOS) | Windows | macOS |
|---|---|---|
| `sudo pacman -S cloudflared` | `winget install Cloudflare.cloudflared` | `brew install cloudflared` |

What it exposes: **only the phone remote page**. The TV page, the downloaded videos and the rest of your computer are not reachable through it. The address is long, random, and **changes every time you start KARAO-Q**. People who join this way are **guests**: they can add songs and manage their own, but only the party computer (or someone with the host PIN) can skip, reorder or remove other people's songs. The link stops working as soon as you close KARAO-Q. Traffic goes through Cloudflare's free tunnel service. Run with `TUNNEL=0` to switch it off.

## Run it

**The first time**, run the launcher from the folder:
- **Linux / macOS:** `./start.sh`
- **Windows:** double-click `start.bat`

It adds a **KARAO-Q icon** to your app menu (Linux), Applications folder (macOS), or Desktop + Start menu (Windows). **From then on, just click the icon**, with no terminal. On Linux, the one-time firewall step asks for your password in a normal pop-up. If something goes wrong when starting from the icon, you get a notification, and details go to `data/karaoq.log`.

### Older notes

- **Linux / macOS:** `./start.sh`
- **Windows:** double-click `start.bat`

The stage opens fullscreen on the TV. Close the browser (Alt+F4 / Cmd+Q) and the whole thing shuts down. Nothing stays running in the background.

Phones must be on the **same wifi**. They scan the QR code on screen, and that's it.

Options (environment variables):
- `HOST_PIN=1234`: only people who enter the PIN can reorder, skip or remove other people's songs. Guests can still add songs and manage their own. The party computer is always host. Default: no PIN, everyone can do everything.
- `PORT=8080`: change the port.
- `BASE_URL=http://192.168.1.50:8080`: override the address in the QR code if it picks the wrong network adapter.

---

## How the queue works

The queue is **saved to disk on every change**. You can refresh the browser, close the lid, or have the server crash, and when you start it again everyone is still in line. A song that was cut off mid-way goes back to the **front**.

**Fair rotation** (on by default): everyone gets one song before anyone gets a second. If Stan queues 5 songs and Jo queues 1, Jo doesn't wait behind all five.

**When the next singer isn't in the room:**

| Button / key | What it does |
|---|---|
| 🙋 **Not here** (`N`) | Swaps them back **one spot**. The next person goes and they keep their place. Their song shows a "passed 1×" badge so you can see who keeps ducking out. |
| 🚪 **Stepped out** (`H`) | Takes their song out of the rotation and parks it. Nobody waits on them. |
| ↩ **Back** | When they come back, one tap puts them **up next**. |
| 🔀 **Fair shuffle** | Shuffles the line but keeps it fair. |
| ↶ **Undo** (`Z`) | Reverses the last queue change. For when someone fat-fingers it. |

**Between songs** the TV shows a big **UP NEXT: NAME** screen with a countdown (15 s by default, adjustable in ⚙ Settings) and a chime. Set the countdown to "None" if you'd rather the host hit Start every time.

## Look & sound
- **Themes** (⚙ Settings → Look): Neon, **Synthwave '84** (sunset + neon grid), Dive Bar, Retro Arcade, Minimal. Phones follow the TV's theme.
- **Title card:** each song opens with a 3-second card (face, name, song, genre) and a little ta-da.
- **Even volumes:** new downloads are loudness-matched (EBU R128, −14 LUFS), so songs play at the same level.
- **Attract mode:** the idle screen keeps the QR up and rotates through tonight's leaderboard, the genre mix, *Haven't sung yet 👀*, and tips.
- **OLED care:** on-screen cards drift a few pixels every 90 s, and after 5 idle minutes the screen goes dark with a small drifting "scan to sing" card.
- **Reactions:** 20 emoji, with six in the quick row and ＋ for the rest.

## Fun stuff
- **Can't decide what to sing?** The Search tab shows:
  - **🏠 Popular at this party:** the songs sung most on this computer across every night. It builds itself, no accounts needed.
  - **🔥 Most sung karaoke songs:** the top 100 most-sung karaoke songs in Canada from the [Singa karaoke app](https://singa.com/blog/most-popular-karaoke-songs-in-canada/) (2026 ranking).
  - **Browse by genre and decade:** pick e.g. *Country* + *1970s* to see every matching song (~420 songs from Singa's Canada, US, pop and rock lists, StemSplit's country list, and our classics). Every filtered list ends with **🔎 More … on YouTube** for a live search.
  - **🎲 Spin for me:** a random pick from the same pool, using the same genre/decade filters.
  - Your recent searches, plus a shuffle of more party classics.
- **Wrong version?** ⋯ on a queued song → pick another karaoke version. The singer keeps their spot.
- **🏆 Tonight's awards:** Mic Hog, Genre Hopper, Crowd Favourite (most reactions), Marathon Mic, Time Traveller, Duet Darling, Fashionably Late, Opening Act. They're on the phone's Sung tab, and a host can put them on the TV (or ☰ Menu → Awards on the TV).
- **Tonight so far:** party time (ticking live), songs sung, singers, time spent singing, songs per hour, reactions, what's left in line, and the longest song. It's on the Sung tab, in the TV's rotating idle screen, and under the awards.
- **📊 My stats** (☰ on your phone): total time on stage, your songs across every night, your most-sung songs, genres, decades and favourite duet partners.

## Genres & tonight's mix
KARAO-Q reads the artist from the karaoke title and looks up the genre and decade on [MusicBrainz](https://musicbrainz.org), a free public music database. Every song gets a colour chip, the TV glows in the current song's genre colour, and **Tonight's mix** shows the night's split ("40% Pop · 25% Rock…") plus decades. Wrong guess? Tap the chip (or ⋯ → Genre) on a phone to fix it. Your pick is remembered.

## People & hosting
- **Joining:** the first time a phone opens KARAO-Q, it asks *Who's singing?* Tap your name if you've been before, or type a new one. Then pick a look: one of 24 avatars, or **📸 take a selfie**. Faces show up on the TV's UP NEXT screen, the queue, the sidebar and the leaderboard. Selfies are wiped at the start of a new night unless you tick *Keep my photo*. Change it any time from ☰.
- **Open party** (default): every phone can manage the queue.
- **Hosted party:** ☰ → **👑 Be the host**. Now only the host, co-hosts and the party computer can skip, reorder or remove other people's songs. Everyone can still add songs and manage their own. The host can add co-hosts, hand off the crown, or end host mode from ☰.
- **Songs per person:** ⚙ Settings can cap how many songs each person has *waiting in line at once*. It's not a nightly limit: once one is sung they can add another. Hosts aren't limited.
- **Duplicate check:** adding a song that's already queued, or was sung in the last 90 minutes, asks "add anyway?"

## Singing features
- **Key change:** the singer (or host) taps **−/+** on their phone to move the song down or up in semitones without changing the speed. It's shown on the TV as "key −2". Starred songs remember the key you last sang them in.
- **Favourites:** tap ☆ on the song that's playing, or ⋯ → Save on any queued song. The **⭐ Faves** tab lists each person's songs across nights, with one tap to queue (in their key).
- **Duets:** tap 👤 when adding to enter a duet partner, or ⋯ → "Make it a duet" on a queued song. Shows as "Stan & Priya" and counts for both.
- **Reactions:** everyone gets 🔥👏😂❤️🎉🤘 buttons while someone sings. They float up the side of the TV.

## Phone remote
- Search adds "karaoke" automatically and ranks real karaoke channels first. You can also paste a YouTube link.
- **＋** adds a song under your name. **👤** adds one for someone else, which is handy when one phone queues for a few people.
- A banner shows **how many songs until you're up** and roughly how many minutes. It flashes when you're next.
- The **Sung** tab shows tonight's history, with one tap to queue a song again.

## Keyboard on the party computer
`A` or `/` opens the search/queue panel right on the TV, for keyboard + mouse people. `?` shows all keys.

`Enter` start now · `N` not here · `H` stepped out · `Space` pause · `R` restart · `S S` skip (press twice) · `Z` undo · `← →` seek 10 s · `Q` pin queue sidebar · `F` fullscreen

---

## Troubleshooting
- **Downloads failing:** update yt-dlp (`yt-dlp -U`, or update it through your package manager). YouTube changes all the time. The launchers try to update it on every start.
- **Phones can't connect:** they have to be on the same wifi, and the computer's firewall has to allow the port. On Windows, allow Node through the firewall prompt the first time.
- **No sound on the TV:** click once on the stage. Browsers need one click before they'll play audio unless they were launched with the autoplay flag, which the launchers do.
- **Testing without internet:** `MOCK=1 node server.js` fakes search results and generates test videos.

Downloaded songs are cached in `data/cache/`, so repeat requests start instantly. Delete the folder whenever you like.

## Credits
The idea of a QR-joined, phone-fed queue owes a lot to [PiKaraoke](https://github.com/vicwomg/pikaraoke) and [yt-kara](https://github.com/Zeletochoy/yt-kara). The video plumbing is all [yt-dlp](https://github.com/yt-dlp/yt-dlp).

Downloading from YouTube is against YouTube's terms of service. This is meant for private home use.
