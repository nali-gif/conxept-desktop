# ConXept Time Tracker — desktop app

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
