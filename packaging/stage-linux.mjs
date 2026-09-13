#!/usr/bin/env node
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  copyRegularFile,
  makeEmptyDirectory,
  readJson,
  requireCondition,
  run,
  sha256File,
  walkRegularTree,
  writeModeManifest,
} from "./lib/common.mjs";
import { acquireRuntimeArchive, loadRuntimeLock } from "./lib/runtime-lock.mjs";

const packagingDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultSourceRoot = path.resolve(packagingDirectory, "..");

function parseArguments(args) {
  const values = {
    sourceRoot: defaultSourceRoot,
    lock: path.join(packagingDirectory, "runtime-lock.json"),
    files: path.join(packagingDirectory, "linux-files.json"),
    outputDirectory: null,
    runtimeCache: null,
  };
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    requireCondition(value !== undefined, `missing value for ${args[index]}`, "INVALID_ARGUMENT");
    switch (args[index]) {
      case "--source-root": values.sourceRoot = path.resolve(value); break;
      case "--lock": values.lock = path.resolve(value); break;
      case "--files": values.files = path.resolve(value); break;
      case "--output-directory": values.outputDirectory = path.resolve(value); break;
      case "--runtime-cache": values.runtimeCache = path.resolve(value); break;
      default: throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  requireCondition(values.outputDirectory !== null && values.runtimeCache !== null,
    "--output-directory and --runtime-cache are required", "INVALID_ARGUMENT");
  return values;
}

function validateFileManifest(file) {
  const value = readJson(file);
  requireCondition(value.schemaVersion === 1 && Array.isArray(value.regularFiles),
    "Linux file manifest schema is unsupported", "INVALID_FILE_MANIFEST");
  const destinations = new Set();
  for (const entry of value.regularFiles) {
    requireCondition(entry !== null && typeof entry === "object" &&
      Object.keys(entry).sort().join(",") === "destination,mode,source" &&
      typeof entry.source === "string" && typeof entry.destination === "string" &&
      !path.isAbsolute(entry.source) && !path.posix.isAbsolute(entry.destination) &&
      !entry.source.split("/").includes("..") && !entry.destination.split("/").includes("..") &&
      ["0644", "0755"].includes(entry.mode) && !destinations.has(entry.destination),
    "Linux file manifest contains an invalid or duplicate entry", "INVALID_FILE_MANIFEST");
    destinations.add(entry.destination);
  }
  return value;
}

function validateDeclaredModuleClosure(sourceRoot, manifest) {
  const declared = new Set(manifest.regularFiles.map((entry) => entry.source));
  const moduleEntries = manifest.regularFiles.filter((entry) => entry.source.endsWith(".mjs"));
  for (const entry of moduleEntries) {
    const source = readFileSync(path.join(sourceRoot, entry.source), "utf8");
    const relativeSpecifiers = [
      ...source.matchAll(/(?:from\s+|import\s*)["'](\.\.?\/[^"']+)["']/g),
      ...source.matchAll(/new URL\(["'](\.\.?\/[^"']+)["'],\s*import\.meta\.url\)/g),
    ].map((match) => match[1]);
    for (const specifier of relativeSpecifiers) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(entry.source),
        specifier));
      requireCondition(declared.has(dependency),
        `${entry.source} has undeclared local dependency ${dependency}`,
        "INCOMPLETE_SOURCE_ALLOWLIST");
    }
  }
}

function extractRuntimeBinary(archive, item, destination) {
  const scratch = mkdtempSync(path.join(tmpdir(), "fault-affinity-runtime-"));
  try {
    run("tar", [
      "--extract", "--xz", "--file", archive, "--directory", scratch,
      "--strip-components=1", "--no-same-owner", "--no-same-permissions",
      `${item.archiveRoot}/bin/node`, `${item.archiveRoot}/LICENSE`,
    ]);
    const binary = path.join(scratch, "bin/node");
    const license = path.join(scratch, "LICENSE");
    copyRegularFile(binary, path.join(destination, "bin/node"), 0o755);
    copyRegularFile(license, path.join(destination, "LICENSE.node.txt"), 0o644);
    return sha256File(binary);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function normalizeProductionTree(source, destination) {
  for (const entry of walkRegularTree(source)) {
    const target = path.join(destination, entry.relative);
    copyRegularFile(entry.absolute, target, 0o644);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sourceStat = lstatSync(options.sourceRoot);
  requireCondition(sourceStat.isDirectory() && !sourceStat.isSymbolicLink(),
    "source root must be a real directory", "INVALID_SOURCE_ROOT");
  const lock = loadRuntimeLock(options.lock);
  const fileManifest = validateFileManifest(options.files);
  validateDeclaredModuleClosure(options.sourceRoot, fileManifest);
  makeEmptyDirectory(options.outputDirectory);
  const kitRoot = path.join(options.outputDirectory, "fault-affinity");
  mkdirSync(kitRoot, { mode: 0o755 });

  try {
    for (const entry of fileManifest.regularFiles) {
      copyRegularFile(path.join(options.sourceRoot, entry.source),
        path.join(kitRoot, entry.destination), Number.parseInt(entry.mode, 8));
    }
    for (const [name, mode] of [
      ["README.txt", 0o644],
      ["UPLOAD-RESULTS.txt", 0o644],
      ["prepare-results", 0o755],
    ]) {
      const destination = name === "README.txt"
        ? path.join(kitRoot, name)
        : path.join(kitRoot, "share", name);
      copyRegularFile(path.join(packagingDirectory, "templates", name), destination, mode);
    }

    const releaseTemplate = JSON.parse(readFileSync(
      path.join(packagingDirectory, "RELEASE.template.json"), "utf8"));
    const runtimeIdentities = {};
    for (const role of ["controller", "reference"]) {
      const item = lock.platforms["linux-x64"][role];
      const archive = await acquireRuntimeArchive(item, options.runtimeCache);
      runtimeIdentities[role] = {
        version: item.version,
        archiveSha256: item.sha256,
        binarySha256: extractRuntimeBinary(archive, item,
          path.join(kitRoot, "runtime", role)),
      };
    }

    const dependencyScratch = mkdtempSync(path.join(tmpdir(), "fault-affinity-npm-"));
    try {
      const app = path.join(dependencyScratch, "app");
      mkdirSync(app, { mode: 0o755 });
      copyRegularFile(path.join(options.sourceRoot, "package.json"),
        path.join(app, "package.json"), 0o644);
      copyRegularFile(path.join(options.sourceRoot, "package-lock.json"),
        path.join(app, "package-lock.json"), 0o644);
      run(process.env.NPM_CLI ?? "npm", [
        "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
        "--prefix", app,
      ], { capture: false });
      const pglite = path.join(app, "node_modules/@electric-sql/pglite");
      requireCondition(lstatSync(pglite).isDirectory(),
        "npm did not install the locked PGlite production dependency", "MISSING_PGLITE");
      normalizeProductionTree(pglite,
        path.join(kitRoot, "app/node_modules/@electric-sql/pglite"));
      copyRegularFile(path.join(pglite, "LICENSE"),
        path.join(kitRoot, "LICENSES/pglite-Apache-2.0.txt"), 0o644);
    } finally {
      rmSync(dependencyScratch, { recursive: true, force: true });
    }

    releaseTemplate.runtimes.controller.sha256 = runtimeIdentities.controller.binarySha256;
    releaseTemplate.runtimes.reference.sha256 = runtimeIdentities.reference.binarySha256;
    releaseTemplate.runtimeArchives = runtimeIdentities;
    const releasePath = path.join(kitRoot, "RELEASE.template.json");
    mkdirSync(path.dirname(releasePath), { recursive: true });
    await import("node:fs").then(({ writeFileSync }) =>
      writeFileSync(releasePath, `${JSON.stringify(releaseTemplate, null, 2)}\n`, {
        flag: "wx", mode: 0o644,
      }));

    chmodSync(path.join(kitRoot, "bin/discover-reference"), 0o755);
    chmodSync(path.join(kitRoot, "bin/run-reference"), 0o755);
    writeModeManifest(kitRoot, path.join(kitRoot, "MODE-MANIFEST.json"));
    const uncompressed = path.join(options.outputDirectory,
      "fault-affinity-live-linux-x64.stage.tar");
    const compressed = `${uncompressed}.gz`;
    run("tar", [
      "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
      "--format=ustar", "--create", "--file", uncompressed,
      "--directory", options.outputDirectory, "fault-affinity",
    ]);
    run("gzip", ["--no-name", uncompressed]);
    requireCondition(lstatSync(compressed).isFile(),
      "staging archive was not created", "ARCHIVE_FAILED");
  } catch (error) {
    rmSync(options.outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  process.stderr.write(`stage-linux: ${error.message}\n`);
  process.exitCode = 1;
});
