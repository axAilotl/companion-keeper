#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const rootPackagePath = path.join(rootDir, "package.json");
const desktopPackagePath = path.join(rootDir, "apps", "desktop", "package.json");

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version).trim());
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function nextPatchVersion(version) {
  const parsed = parseVersion(version);
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const rootPackage = await readJson(rootPackagePath);
  const desktopPackage = await readJson(desktopPackagePath);

  const currentVersion = typeof rootPackage.version === "string" && rootPackage.version.trim().length > 0
    ? rootPackage.version.trim()
    : "0.1.0";
  const nextVersion = nextPatchVersion(currentVersion);

  rootPackage.version = nextVersion;
  desktopPackage.version = nextVersion;

  await writeJson(rootPackagePath, rootPackage);
  await writeJson(desktopPackagePath, desktopPackage);

  process.stdout.write(`Version bumped: ${currentVersion} -> ${nextVersion}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
