#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const stageDir = path.join(rootDir, ".electron-app");

const copiedPackages = new Set();
const copiedPackageVersions = new Map();

function packageNameToPathSegments(name) {
  return name.split("/");
}

function isWorkspacePackage(name) {
  return name === "@gptdataexport/shared" || name === "@gptdataexport/pipeline";
}

function workspacePackageDir(name) {
  if (name === "@gptdataexport/shared") {
    return path.join(rootDir, "packages", "shared");
  }
  if (name === "@gptdataexport/pipeline") {
    return path.join(rootDir, "packages", "pipeline");
  }
  return "";
}

function keepPath(relativePath) {
  if (!relativePath || relativePath === ".") {
    return true;
  }
  const parts = relativePath.split(path.sep);
  if (parts[0] === "node_modules") {
    return false;
  }
  if (parts[0] === "src" || parts[0] === "test" || parts[0] === "__tests__" || parts[0] === ".turbo") {
    return false;
  }
  if (relativePath.endsWith(".tsbuildinfo")) {
    return false;
  }
  return true;
}

async function copyDirFiltered(sourceDir, destDir) {
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  await fs.cp(sourceDir, destDir, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => {
      const relative = path.relative(sourceDir, sourcePath);
      return keepPath(relative);
    },
  });
}

function resolvePackageDir(name, searchPaths) {
  if (isWorkspacePackage(name)) {
    return workspacePackageDir(name);
  }
  const paths = Array.isArray(searchPaths) && searchPaths.length > 0
    ? searchPaths
    : [rootDir];
  const pkgJsonPath = require.resolve(`${name}/package.json`, { paths });
  return path.dirname(pkgJsonPath);
}

async function copyRuntimePackage(name, searchPaths = [rootDir]) {
  if (copiedPackages.has(name)) {
    return;
  }
  copiedPackages.add(name);

  const sourceDir = resolvePackageDir(name, searchPaths);
  const packageJsonPath = path.join(sourceDir, "package.json");
  const packageRaw = await fs.readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageRaw);
  const version = typeof packageJson.version === "string" && packageJson.version.trim().length > 0
    ? packageJson.version.trim()
    : "0.0.0";
  copiedPackageVersions.set(name, version);

  const destDir = path.join(
    stageDir,
    "node_modules",
    ...packageNameToPathSegments(name),
  );
  await copyDirFiltered(sourceDir, destDir);

  const dependencies = Object.keys(packageJson.dependencies || {});
  for (const dependency of dependencies) {
    await copyRuntimePackage(dependency, [sourceDir, rootDir]);
  }
}

async function writeStagePackageJson() {
  const rootPkgRaw = await fs.readFile(path.join(rootDir, "package.json"), "utf8");
  const rootPkg = JSON.parse(rootPkgRaw);

  const dependencies = {};
  for (const name of Array.from(copiedPackages).sort((a, b) => a.localeCompare(b))) {
    dependencies[name] = copiedPackageVersions.get(name) || "0.0.0";
  }

  const stagePkg = {
    name: "gptdataexport-desktop-app",
    version: rootPkg.version || "0.1.0",
    description: "GPTDataExport Desktop",
    author: "GPTDataExport",
    main: "apps/desktop/dist/main.js",
    private: true,
    dependencies,
  };

  await fs.writeFile(
    path.join(stageDir, "package.json"),
    `${JSON.stringify(stagePkg, null, 2)}\n`,
    "utf8",
  );
}

async function main() {
  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(stageDir, { recursive: true });

  await copyDirFiltered(
    path.join(rootDir, "apps", "desktop", "dist"),
    path.join(stageDir, "apps", "desktop", "dist"),
  );
  await copyDirFiltered(
    path.join(rootDir, "apps", "renderer", "dist"),
    path.join(stageDir, "apps", "renderer", "dist"),
  );

  await copyRuntimePackage("@gptdataexport/shared");
  await copyRuntimePackage("@gptdataexport/pipeline");
  await writeStagePackageJson();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
