const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, nativeImage, shell, desktopCapturer, screen, systemPreferences, Notification, net } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Server address. First launch writes server-url.txt in the app's data folder;
// edit that file (or set TIMETRACKER_URL) to point installs at a different host.
const DEFAULT_URL = "https://timer.conxept.co";
// Installs from before the move to Hostinger saved the office iMac's address; they are moved to the live site.
const OLD_OFFICE_URLS = ["http://192.168.1.11:3000", "https://192.168.1.11:3443"];
const ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAaUlEQVR4nGNgqLjCQBHGIcEJxMFAXAXFwVAxogwAafgCxP/R8BeoHF4DFmHRiI4X4TKgigjNMFyFbgAnDmfjwl/gYQI1IJgEzTAcjGwAKc5H9Qa1DKDYCxQHIsXRSJWERJWkTJXMRBIGADiu0EjqcbnNAAAAAElFTkSuQmCC";
const IS_MAC = process.platform === "darwin";

function serverUrl() {
  if (process.env.TIMETRACKER_URL) return process.env.TIMETRACKER_URL;
  try {
    const p = path.join(app.getPath("userData"), "server-url.txt");
    if (fs.existsSync(p)) {
      const v = fs.readFileSync(p, "utf8").trim();
      if (OLD_OFFICE_URLS.includes(v.replace(/\/+$/, ""))) {
        fs.writeFileSync(p, DEFAULT_URL);
        return DEFAULT_URL;
      }
      if (v) return v;
    } else {
      fs.writeFileSync(p, DEFAULT_URL);
    }
  } catch {}
  return DEFAULT_URL;
}

let win = null;
let tray = null;
let quitting = false;

// ---- 1.3.0: start with the computer, quietly in the tray ----
// Packaged builds add themselves to the OS login items. Windows passes LOGIN_ARG on those starts; macOS 13+ no longer
// says whether an app was opened at login, so there a start within a few minutes of boot counts as one. A login start
// keeps the window hidden (the tray icon is there); opening the app again shows it.
const LOGIN_ARG = "--hidden";
function setupLoginItem() {
  if (!app.isPackaged || (process.platform !== "win32" && !IS_MAC)) return;
  try {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: [LOGIN_ARG] });
  } catch {}
}
function openedAtLogin() {
  if (process.argv.includes(LOGIN_ARG)) return true;
  if (!app.isPackaged || !IS_MAC) return false;
  try {
    const s = app.getLoginItemSettings();
    if (s.wasOpenedAtLogin || s.wasOpenedAsHidden) return true;
  } catch {}
  return os.uptime() < 180;
}

// Power log for the web app's timer: it pauses the running timer when the machine sleeps, locks or
// shuts down, and uses these timestamps to tell a real sleep apart from a merely slow tab.
const power = { startedAt: Date.now(), lastSuspendAt: 0, lastResumeAt: 0 };
function sendPower(kind) {
  const at = Date.now();
  if (kind === "suspend" || kind === "lock-screen" || kind === "shutdown") power.lastSuspendAt = at;
  if (kind === "resume" || kind === "unlock-screen") power.lastResumeAt = at;
  if (win && !win.isDestroyed()) win.webContents.send("power:event", { kind, at });
}

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(hidden = false) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "ConXept Time Tracker",
    show: !hidden, // a login start stays in the tray
    // keep the timer ticking while the window is hidden in the tray
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
  });
  win.loadURL(serverUrl());
  // at login the network is often not up yet: try the page again every 30 s until it loads
  let retry = null;
  win.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || retry) return; // -3 = aborted by a newer navigation
    retry = setTimeout(() => {
      retry = null;
      if (win && !win.isDestroyed()) win.loadURL(serverUrl()).catch(() => {});
    }, 30_000);
  });
  // Links to other sites (Figma, staging, docs on the Board) open in the normal browser — never inside the
  // app window, which carries the preload bridge (idle / power data).
  const appOrigin = (() => { try { return new URL(serverUrl()).origin; } catch { return ""; } })();
  const isExternal = (url) => { try { return new URL(url).origin !== appOrigin; } catch { return true; } };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (isExternal(url)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  // powerMonitor's "shutdown" only fires on macOS / Linux; on Windows a shutdown, restart or sign-out ends the
  // session instead — pause the timer the same way (best effort; a stale heartbeat still catches it after boot)
  win.on("session-end", () => sendPower("shutdown"));
  // closing the window hides to tray; the timer keeps running
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

// ---- screenshots (round 8): every display, full resolution capped at 2560 px wide; the page combines and uploads them ----
function screenPermission() {
  if (!IS_MAC) return "granted";
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    return "unknown";
  }
}

async function requestScreenAccess() {
  if (!IS_MAC || screenPermission() === "granted") return screenPermission();
  try { await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }); } catch {}
  return screenPermission();
}

async function captureScreens() {
  // development runs only: two generated "displays" instead of the real screen (TT_FAKE_SCREENS=1), for testing
  if (!app.isPackaged && process.env.TT_FAKE_SCREENS) {
    const base = nativeImage.createFromDataURL(ICON_DATA_URL);
    return {
      status: "ok",
      screens: [
        { data: base.resize({ width: 1920, height: 1080 }).toJPEG(80), width: 1920, height: 1080, x: 0, y: 0 },
        { data: base.resize({ width: 1280, height: 1024 }).toJPEG(80), width: 1280, height: 1024, x: 1920, y: 0 },
      ],
    };
  }
  if (IS_MAC) {
    const st = screenPermission();
    if (st !== "granted") {
      // the first capture attempt makes macOS ask; without permission a capture only shows the wallpaper, so none is sent
      if (st === "not-determined") {
        try { await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }); } catch {}
      }
      return { status: "denied", screens: [] };
    }
  }
  try {
    const displays = screen.getAllDisplays();
    const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
    const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));
    const k = Math.min(1, 2560 / maxW);
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(maxW * k), height: Math.round(maxH * k) } });
    const screens = sources
      .map((src, i) => {
        const img = src.thumbnail;
        if (!img || img.isEmpty()) return null;
        const d = displays.find((x) => String(x.id) === String(src.display_id)) || displays[i] || displays[0];
        const size = img.getSize();
        return { data: img.toJPEG(80), width: size.width, height: size.height, x: d.bounds.x, y: d.bounds.y };
      })
      .filter(Boolean);
    return { status: screens.length ? "ok" : "error", screens };
  } catch (e) {
    return { status: "error", screens: [], error: String(e && e.message ? e.message : e) };
  }
}

// ---- system idle seconds (mouse + keyboard, any application) ----
// Development runs only (`npm start`, never an installed app) can read a fake value from TT_FAKE_IDLE_FILE, so idle
// behaviour can be tested while someone uses the PC.
function idleSeconds() {
  const fake = !app.isPackaged ? process.env.TT_FAKE_IDLE_FILE : null;
  if (fake) {
    try {
      const v = Number(fs.readFileSync(fake, "utf8").trim());
      if (Number.isFinite(v) && v >= 0) return v;
    } catch {}
  }
  return powerMonitor.getSystemIdleTime();
}
/** Dev-only number from the environment (ignored by installed apps). */
const devNumber = (name, dflt) => {
  const v = !app.isPackaged ? Number(process.env[name]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

// ---- 1.3.0: activity minutes ----
// Runs in the main process, so it doesn't depend on a timer, on the page, or on the window being open. Every 10 s:
// was there any mouse / keyboard input since the last look? If so those seconds count as active (a locked or sleeping
// computer never does). Seconds are summed per minute; finished minutes are sent once a minute with the app's own
// signed-in session. The server keeps only minutes inside the person's working hours. Unsent minutes wait (on disk
// too) for up to a day; nobody signed in = they're dropped. Nothing is shown to the person.
const SAMPLE_MS = devNumber("TT_SAMPLE_MS", 10_000);
const UPLOAD_MS = devNumber("TT_UPLOAD_MS", 60_000);
const KEEP_MS = 26 * 3600_000;
const MINUTE = 60_000;
const minutes = new Map(); // minute start (epoch ms) → active seconds
let lastSampleAt = 0;
let away = false; // screen locked
let sending = false;
let bufferDirty = false;

const bufferFile = () => path.join(app.getPath("userData"), "activity-minutes.json");
function loadBuffer() {
  try {
    const j = JSON.parse(fs.readFileSync(bufferFile(), "utf8"));
    const now = Date.now();
    if (Array.isArray(j)) for (const [t, s] of j) if (Number.isFinite(t) && Number.isFinite(s) && t > now - KEEP_MS && t <= now) minutes.set(t, Math.max(minutes.get(t) || 0, s));
  } catch {}
}
function saveBuffer() {
  if (!bufferDirty) return;
  bufferDirty = false;
  try {
    fs.writeFileSync(bufferFile(), JSON.stringify(Array.from(minutes.entries())));
  } catch {}
}

/** Count [from, to) as active, split across the minutes it touches. */
function credit(from, to) {
  for (let t = from; t < to; ) {
    const m = Math.floor(t / MINUTE) * MINUTE;
    const end = Math.min(to, m + MINUTE);
    minutes.set(m, Math.min(60, (minutes.get(m) || 0) + (end - t) / 1000));
    t = end;
  }
  bufferDirty = true;
}

function sampleActivity() {
  const now = Date.now();
  const prev = lastSampleAt;
  lastSampleAt = now;
  if (!prev) return;
  // a long gap means the computer slept or the app stalled: only the last sample's worth can count
  const from = now - prev > SAMPLE_MS * 3 ? now - SAMPLE_MS : prev;
  let state = "unknown";
  try {
    state = powerMonitor.getSystemIdleState(60);
  } catch {}
  if (state === "locked") {
    away = true;
    return;
  }
  if (away) {
    if (state === "unknown") return; // locked by the event, and the OS can't say otherwise
    away = false; // the OS says it's unlocked (a missed unlock event can't stop the count for good)
  }
  let idle = 0;
  try {
    idle = idleSeconds();
  } catch {
    return;
  }
  if (idle * 1000 < now - from) credit(from, now); // input since the last look
}

async function sendMinutes() {
  if (sending) return;
  const now = Date.now();
  const current = Math.floor(now / MINUTE) * MINUTE;
  const batch = [];
  for (const [t, s] of Array.from(minutes.entries()).sort((a, b) => a[0] - b[0])) {
    if (t >= current) continue; // still filling
    const a = Math.min(60, Math.round(s));
    if (t < now - KEEP_MS || a < 1) {
      minutes.delete(t);
      bufferDirty = true;
    } else if (batch.length < 720) batch.push({ t, a });
  }
  if (!batch.length) return saveBuffer();
  let url;
  try {
    url = new URL("/api/productivity/minutes", serverUrl()).toString();
  } catch {
    return saveBuffer();
  }
  sending = true;
  try {
    const res = await net.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes: batch }),
      credentials: "include", // the app's own sign-in (session cookie)
      cache: "no-store",
    });
    // saved / not recorded for this person (204) / not valid / nobody signed in: done with these. A server error waits.
    if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)) {
      for (const m of batch) minutes.delete(m.t);
      bufferDirty = true;
    }
  } catch {
    // offline: try again next minute
  } finally {
    sending = false;
    saveBuffer();
  }
}

function startActivityMinutes() {
  loadBuffer();
  powerMonitor.on("lock-screen", () => { away = true; });
  powerMonitor.on("unlock-screen", () => { away = false; lastSampleAt = 0; });
  // asleep: nothing runs; the first look after waking starts the clock again
  for (const kind of ["suspend", "resume"]) powerMonitor.on(kind, () => { lastSampleAt = 0; });
  setInterval(sampleActivity, SAMPLE_MS);
  setInterval(() => { sendMinutes(); }, UPLOAD_MS);
  app.on("before-quit", saveBuffer);
}

// ---- updates (round 8): GitHub Releases. Windows downloads and installs on quit; an unsigned Mac app can't replace
// itself, so it only tells the person a new version is out (tray, notification, banner in the page). ----
let autoUpdater = null;
try {
  autoUpdater = require("electron-updater").autoUpdater;
} catch {}
const update = { current: app.getVersion(), available: null, downloaded: false, canAutoInstall: !IS_MAC, downloadUrl: null };

function releaseRepo() {
  // written by electron-builder from the publish settings the GitHub workflow passes in
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8");
    const owner = /^owner:\s*(\S+)/m.exec(yml)?.[1];
    const repo = /^repo:\s*(\S+)/m.exec(yml)?.[1];
    return owner && repo ? `${owner}/${repo}` : null;
  } catch {
    return null;
  }
}

function sendUpdate() {
  if (win && !win.isDestroyed()) win.webContents.send("update:info", { ...update });
  buildTrayMenu();
}

function notifyNative(title, body, onClick) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    if (onClick) n.on("click", onClick);
    n.show();
  } catch {}
}

function checkForUpdates(manual = false) {
  if (!autoUpdater || !app.isPackaged) {
    if (manual) notifyNative("ConXept Time Tracker", `You have version ${update.current}.`);
    return;
  }
  autoUpdater.checkForUpdates().then((r) => {
    if (manual && (!r || !r.updateInfo || r.updateInfo.version === update.current)) notifyNative("You're up to date", `ConXept Time Tracker ${update.current} is the latest version.`);
  }).catch(() => {
    if (manual) notifyNative("Couldn't check for updates", "Check your internet connection and try again.");
  });
}

function setupUpdates() {
  if (!autoUpdater || !app.isPackaged) return;
  const repo = releaseRepo();
  if (repo) update.downloadUrl = `https://github.com/${repo}/releases/latest/download/ConXept-Time-Tracker-mac.dmg`;
  autoUpdater.autoDownload = !IS_MAC;
  autoUpdater.autoInstallOnAppQuit = !IS_MAC;
  autoUpdater.logger = null;
  autoUpdater.on("update-available", (info) => {
    update.available = info.version;
    sendUpdate();
    if (IS_MAC) notifyNative(`Version ${info.version} is available`, "Click to download it, then drag it into Applications.", () => update.downloadUrl && shell.openExternal(update.downloadUrl));
  });
  autoUpdater.on("update-downloaded", (info) => {
    update.available = info.version;
    update.downloaded = true;
    sendUpdate();
    notifyNative(`Version ${info.version} is ready`, "It installs the next time you quit the app.");
  });
  autoUpdater.on("error", () => {});
  checkForUpdates();
  setInterval(() => checkForUpdates(), 6 * 60 * 60 * 1000).unref?.();
}

function buildTrayMenu() {
  if (!tray) return;
  const items = [
    { label: "Open Time Tracker", click: showWindow },
    {
      label: "Log time",
      click: () => {
        showWindow();
        win.loadURL(serverUrl().replace(/\/$/, "") + "/log");
      },
    },
    { type: "separator" },
    { label: `Version ${update.current}`, enabled: false },
  ];
  if (update.downloaded && update.canAutoInstall) items.push({ label: `Restart to update to ${update.available}`, click: () => { quitting = true; autoUpdater.quitAndInstall(); } });
  else if (update.available && !update.canAutoInstall && update.downloadUrl) items.push({ label: `Download version ${update.available}…`, click: () => shell.openExternal(update.downloadUrl) });
  else items.push({ label: "Check for updates", click: () => checkForUpdates(true) });
  items.push({ type: "separator" }, { label: "Quit", click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// Development runs can use their own data folder (TT_USER_DATA), so they don't hand over to an installed copy that's
// already running (one instance per data folder).
if (!app.isPackaged && process.env.TT_USER_DATA) app.setPath("userData", process.env.TT_USER_DATA);

// Windows shows an app's pop-ups only when this matches the installed shortcut's ID (electron-builder's appId)
if (process.platform === "win32") app.setAppUserModelId("com.conxept.timetracker");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    // what the page needs to know up front (sync: read once by the preload)
    ipcMain.on("app:info", (e) => { e.returnValue = { version: app.getVersion(), platform: process.platform }; });
    // true system-wide idle seconds (mouse + keyboard, any application); see idleSeconds() for the dev-only fake
    ipcMain.handle("idle:seconds", () => idleSeconds());
    ipcMain.handle("power:state", () => ({ ...power, idleSeconds: powerMonitor.getSystemIdleTime(), now: Date.now() }));
    for (const kind of ["suspend", "resume", "lock-screen", "unlock-screen", "shutdown"]) {
      powerMonitor.on(kind, () => sendPower(kind));
    }
    // round 8 — monitoring
    ipcMain.handle("screen:capture", () => captureScreens());
    ipcMain.handle("screen:permission", () => screenPermission());
    // macOS lists an app under Screen Recording only after it has asked once: ask (a tiny capture shows the system
    // prompt the first time), so the switch is there when the person opens the settings page
    ipcMain.handle("screen:request", () => requestScreenAccess());
    ipcMain.handle("screen:open-permission", async () => {
      if (!IS_MAC) return;
      await requestScreenAccess();
      return shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    });
    // "You were inactive": bring the window to the front when the person comes back
    ipcMain.handle("window:focus", () => {
      showWindow();
      if (IS_MAC) app.focus({ steal: true });
      try {
        win.setAlwaysOnTop(true);
        win.focus();
        setTimeout(() => win && !win.isDestroyed() && win.setAlwaysOnTop(false), 1500);
      } catch {}
    });
    // 1.2.2: notifications as real system pop-ups (over other apps). The page's own web notifications go through its
    // service worker, which Electron can't show. A click brings the window up and opens the page the note points to.
    ipcMain.handle("notify", (_e, n) => {
      try {
        if (!Notification.isSupported() || !n || typeof n.title !== "string") return false;
        const note = new Notification({ title: n.title.slice(0, 120), body: typeof n.body === "string" ? n.body.slice(0, 300) : "", silent: !!n.silent });
        note.on("click", () => {
          showWindow();
          if (typeof n.href === "string" && n.href.startsWith("/") && win && !win.isDestroyed()) win.webContents.send("notify:click", n.href);
        });
        note.show();
        return true;
      } catch {
        return false;
      }
    });
    ipcMain.handle("update:info", () => ({ ...update }));
    ipcMain.handle("update:install", () => {
      if (update.downloaded && update.canAutoInstall && autoUpdater) {
        quitting = true;
        autoUpdater.quitAndInstall();
      }
    });
    // handlers first, so the page's preload always finds them
    createWindow(openedAtLogin());
    tray = new Tray(nativeImage.createFromDataURL(ICON_DATA_URL));
    tray.setToolTip("ConXept Time Tracker");
    buildTrayMenu();
    setupUpdates();
    setupLoginItem(); // 1.3.0: start with the computer
    startActivityMinutes(); // 1.3.0: activity minutes, timer or not
  });

  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    /* stay alive in the tray */
  });
  app.on("activate", showWindow);
}
