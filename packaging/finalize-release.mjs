#!/usr/bin/env node
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSpdx } from "./generate-sbom.mjs";
import {
  COMMIT_RE,
  makeEmptyDirectory,
  readJson,
  requireCondition,
  run,
  sha256File,
  treeDigest,
  VERSION_RE,
  verifyModeManifest,
  walkRegularTree,
  writeCanonicalJson,
  writeModeManifest,
} from "./lib/common.mjs";

const packagingDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(packagingDirectory, "..");

function parseArguments(args) {
  const result = { stage: null, outputDirectory: null, version: null, commit: null,
    sourceDateEpoch: null };
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    requireCondition(value !== undefined, `missing value for ${args[index]}`, "INVALID_ARGUMENT");
    const key = ({
      "--stage": "stage", "--output-directory": "outputDirectory", "--version": "version",
      "--commit": "commit", "--source-date-epoch": "sourceDateEpoch",
    })[args[index]];
    requireCondition(key !== undefined, `unknown argument: ${args[index]}`, "INVALID_ARGUMENT");
    result[key] = value;
  }
  requireCondition(result.stage && result.outputDirectory && VERSION_RE.test(result.version ?? "") &&
    COMMIT_RE.test(result.commit ?? "") && /^(0|[1-9][0-9]*)$/.test(result.sourceDateEpoch ?? ""),
  "--stage, --output-directory, semantic --version, 40-hex --commit, and --source-date-epoch are required",
  "INVALID_ARGUMENT");
  result.stage = path.resolve(result.stage);
  result.outputDirectory = path.resolve(result.outputDirectory);
  return result;
}

function assertStageTree(root) {
  const entries = walkRegularTree(root);
  requireCondition(entries.length > 0 && entries.length <= 20_000,
    "stage contains an invalid number of regular files", "INVALID_STAGE");
  const total = entries.reduce((sum, entry) => sum + Number(lstatSync(entry.absolute).size), 0);
  requireCondition(total <= 1024 * 1024 * 1024,
    "stage expands beyond the release size limit", "INVALID_STAGE");
  verifyModeManifest(root, path.join(root, "MODE-MANIFEST.json"));
}

function writeChecksumFile(directory, name) {
  const digest = sha256File(path.join(directory, name));
  writeFileSync(path.join(directory, `${name}.sha256`), `${digest}  ${name}\n`, {
    flag: "wx", mode: 0o644,
  });
  return digest;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  requireCondition(lstatSync(options.stage).isFile(), "stage archive is not a regular file",
    "INVALID_STAGE");
  makeEmptyDirectory(options.outputDirectory);
  const scratch = mkdtempSync(path.join(tmpdir(), "fault-affinity-final-"));
  try {
    run("python3", [path.join(packagingDirectory, "safe-extract.py"), options.stage, scratch]);
    const kitRoot = path.join(scratch, "fault-affinity");
    assertStageTree(kitRoot);
    const templateFile = path.join(kitRoot, "RELEASE.template.json");
    const template = readJson(templateFile);
    requireCondition(template.schemaVersion === 1 && template.release?.version === "__VERSION__" &&
      template.release?.tag === "__TAG__" &&
      template.release?.sourceCommit === "__SOURCE_COMMIT__",
    "release template is invalid", "INVALID_RELEASE_TEMPLATE");
    rmSync(templateFile);
    rmSync(path.join(kitRoot, "MODE-MANIFEST.json"));

    const created = new Date(Number(options.sourceDateEpoch) * 1000).toISOString();
    const release = {
      ...template,
      release: {
        ...template.release,
        version: options.version,
        tag: `v${options.version}`,
        sourceCommit: options.commit,
        builtAt: created,
      },
    };
    release.runtimes.controller.sha256 = sha256File(
      path.join(kitRoot, "runtime/controller/bin/node"));
    release.runtimes.reference.sha256 = sha256File(
      path.join(kitRoot, "runtime/reference/bin/node"));
    requireCondition(release.runtimes.controller.sha256 ===
      release.runtimeArchives.controller.binarySha256 &&
      release.runtimes.reference.sha256 === release.runtimeArchives.reference.binarySha256,
    "staged runtime binary identity changed", "RUNTIME_IDENTITY_MISMATCH");
    release.components.pgliteTreeSha256 = treeDigest(
      path.join(kitRoot, "app/node_modules/@electric-sql/pglite"));
    release.components.appTreeSha256 = treeDigest(path.join(kitRoot, "app"));
    writeCanonicalJson(path.join(kitRoot, "RELEASE.json"), release);
    writeModeManifest(kitRoot, path.join(kitRoot, "MODE-MANIFEST.json"));

    const tarFile = path.join(options.outputDirectory, "fault-affinity-live-linux-x64.tar");
    const archive = `${tarFile}.gz`;
    run("tar", [
      "--sort=name", `--mtime=@${options.sourceDateEpoch}`, "--owner=0", "--group=0",
      "--numeric-owner", "--format=ustar", "--create", "--file", tarFile,
      "--directory", scratch, "fault-affinity",
    ]);
    run("gzip", ["--no-name", tarFile]);
    requireCondition(lstatSync(archive).isFile(), "final archive was not created");

    const sbomName = "fault-affinity-sbom.spdx.json";
    const sbom = buildSpdx({
      packageLock: path.join(sourceRoot, "package-lock.json"),
      runtimeLock: path.join(packagingDirectory, "runtime-lock.json"),
      version: options.version,
      commit: options.commit,
      created,
    });
    writeCanonicalJson(path.join(options.outputDirectory, sbomName), sbom);
    const archiveName = path.basename(archive);
    const archiveSha = writeChecksumFile(options.outputDirectory, archiveName);
    const sbomSha = writeChecksumFile(options.outputDirectory, sbomName);
    writeFileSync(path.join(options.outputDirectory, "SHA256SUMS"),
      `${archiveSha}  ${archiveName}\n${sbomSha}  ${sbomName}\n`,
      { flag: "wx", mode: 0o644 });
  } catch (error) {
    rmSync(options.outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`finalize-release: ${error.message}\n`);
  process.exitCode = 1;
}
