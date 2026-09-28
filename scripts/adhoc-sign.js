// afterPack hook (macOS builds only). Without an Apple Developer certificate electron-builder skips signing
// (mac.identity = null), but Apple-chip Macs refuse to open an app whose signature is missing or broken ("is damaged").
// An ad-hoc signature ("-") fixes that; the first open is still right-click → Open. Only the final app is signed:
// the per-arch temp builds of a universal app must stay unsigned or they can't be merged.
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (/-temp$/.test(context.appOutDir)) return; // x64 / arm64 halves of a universal build
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--timestamp=none", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
