#!/usr/bin/env node
const { spawn } = require("node:child_process");

const DEFAULT_PORT = "43173";

function resolvePort() {
  const raw = (process.env.RENDERER_PORT || "").trim();
  if (!raw) {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_PORT;
  }
  return String(parsed);
}

const rendererPort = resolvePort();
const electronRendererUrl =
  (process.env.ELECTRON_RENDERER_URL || "").trim() || `http://127.0.0.1:${rendererPort}`;

const env = {
  ...process.env,
  RENDERER_PORT: rendererPort,
  ELECTRON_RENDERER_URL: electronRendererUrl,
};

const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(pnpmCmd, ["--filter", "@gptdataexport/desktop", "dev"], {
  stdio: "inherit",
  env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
