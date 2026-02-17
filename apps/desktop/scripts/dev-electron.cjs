#!/usr/bin/env node
const path = require("node:path");
const { spawn } = require("node:child_process");
const waitOn = require("wait-on");

const DEFAULT_PORT = 43173;
const desktopDir = path.resolve(__dirname, "..");

function resolvePort() {
  const raw = (process.env.RENDERER_PORT || "").trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_PORT;
  }
  return parsed;
}

function resolveBin(name) {
  return path.join(
    desktopDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name,
  );
}

async function run() {
  const port = resolvePort();
  const resources = [
    path.join(desktopDir, "dist", "main.js"),
    path.join(desktopDir, "dist", "preload.js"),
    path.resolve(desktopDir, "..", "..", "packages", "shared", "dist", "index.js"),
    `http-get://127.0.0.1:${port}`,
  ];

  await waitOn({
    resources,
    delay: 100,
    interval: 250,
    timeout: 180000,
    tcpTimeout: 2000,
    strictSSL: false,
    log: false,
  });

  const nodemonBin = resolveBin("nodemon");
  const child = spawn(
    nodemonBin,
    ["--watch", "dist", "--ext", "js", "--exec", "node ./scripts/launch-electron.cjs"],
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
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
