#!/usr/bin/env node
const path = require("node:path");
const { spawn } = require("node:child_process");

const desktopDir = path.resolve(__dirname, "..");
const electronBin = path.join(
  desktopDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron",
);

const child = spawn(
  electronBin,
  [".", "--no-sandbox", "--disable-setuid-sandbox"],
  {
    cwd: desktopDir,
    stdio: "inherit",
    env: process.env,
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
