const { contextBridge, ipcRenderer } = require("electron");

const info = (() => {
  try {
    return ipcRenderer.sendSync("app:info") || {};
  } catch {
    return {};
  }
})();

const listen = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

// The web app's view of the desktop (lib/desktop.ts). 1.2.0 added the monitoring calls (round 8).
contextBridge.exposeInMainWorld("desktop", {
  version: info.version,
  platform: info.platform,
  getIdleSeconds: () => ipcRenderer.invoke("idle:seconds"),
  // { startedAt, lastSuspendAt, lastResumeAt, idleSeconds, now } — epoch ms / seconds
  getPowerState: () => ipcRenderer.invoke("power:state"),
  // cb({ kind: "suspend" | "resume" | "lock-screen" | "unlock-screen" | "shutdown", at })
  onPowerEvent: (cb) => listen("power:event", cb),
  // { status: "ok" | "denied" | "error", screens: [{ data: Uint8Array (JPEG), width, height, x, y }] }
  captureScreens: () => ipcRenderer.invoke("screen:capture"),
  // "granted" | "denied" | "not-determined" | "restricted" | "unknown" (always "granted" on Windows)
  getScreenPermission: () => ipcRenderer.invoke("screen:permission"),
  // macOS: ask for Screen Recording (the app then appears in System Settings); returns the new status (1.2.1+)
  requestScreenPermission: () => ipcRenderer.invoke("screen:request"),
  openScreenPermission: () => ipcRenderer.invoke("screen:open-permission"),
  focusWindow: () => ipcRenderer.invoke("window:focus"),
  // { current, available, downloaded, canAutoInstall, downloadUrl }
  getUpdateInfo: () => ipcRenderer.invoke("update:info"),
  onUpdateInfo: (cb) => listen("update:info", cb),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  // 1.2.2: a system notification { title, body, href?, silent? } → true when shown; cb(href) when one is clicked
  notify: (n) => ipcRenderer.invoke("notify", n),
  onNotifyClick: (cb) => listen("notify:click", cb),
});
