// electron-builder skips editing the exe when signAndEditExecutable is false (winCodeSign needs symlinks),
// so stamp the AgenticOps icon and names with rcedit ourselves.
const path = require("node:path");
const { execFileSync } = require("node:child_process");

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== "win32") return;
  const name = ctx.packager.appInfo.productFilename;
  const exe = path.join(ctx.appOutDir, `${name}.exe`);
  const rcedit = path.join(__dirname, "..", "node_modules", "electron-winstaller", "vendor", "rcedit.exe");
  const s = (k, v) => ["--set-version-string", k, v];
  execFileSync(rcedit, [
    exe,
    "--set-icon", path.join(__dirname, "..", "build", "icon.ico"),
    ...s("ProductName", "AgenticOps Desk"),
    ...s("FileDescription", "AgenticOps Desk"),
    ...s("InternalName", "AgenticOps Desk"),
    ...s("OriginalFilename", `${name}.exe`),
    ...s("CompanyName", "AgenticOp-io"),
    ...s("LegalCopyright", "AgenticOp-io"),
  ]);
};
