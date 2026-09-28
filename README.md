# ConXept Time Tracker — desktop app

A small Electron wrapper around the ConXept Time Tracker website (https://timer.conxept.co) for Mac and Windows. It keeps
timers running from the tray / menu bar, pauses them when the computer sleeps or locks, and — from version 1.2 — gives
the site what it needs for activity monitoring: system-wide idle time, screenshots of all displays, and window focus.

The website does all the work (settings, rules, storage); this app contains no keys or secrets.

## Releasing a new version
1. Change `"version"` in `package.json` (for example `1.2.0` → `1.2.1`).
2. On GitHub: **Actions → Build desktop app → Run workflow**.
3. About 15 minutes later the release has `ConXept-Time-Tracker-mac.dmg` (Intel + Apple chips, macOS 11+) and
   `ConXept-Time-Tracker-Setup.exe` (Windows 10/11). Windows installs update themselves; Mac users get a notice.

## Files
- `main.js` — window, tray, idle / power events, screenshots, updates
- `preload.js` — the `window.desktop` bridge the website uses
- `scripts/adhoc-sign.js` — signs the Mac app ad hoc (no Apple Developer account), so Apple-chip Macs open it
- `.github/workflows/release.yml` — the build

## Running it locally
`npm install`, then `npm start`. `TIMETRACKER_URL=http://localhost:3000` points it at a local server.
