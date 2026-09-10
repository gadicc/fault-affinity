import { createHash } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

export class PackagingError extends Error {
  constructor(message, code = "PACKAGING_ERROR") {
    super(message);
    this.name = "PackagingError";
    this.code = code;
  }
}

export function fail(message, code) {
  throw new PackagingError(message, code);
}

export function requireCondition(condition, message, code) {
  if (!condition) fail(message, code);
}

export function readJson(file) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`could not parse JSON ${file}: ${error.message}`, "INVALID_JSON");
  }
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value),
    `${file} must contain a JSON object`, "INVALID_JSON");
  return value;
}

export function writeCanonicalJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o644 });
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function regularFile(file, label = file) {
  const stat = lstatSync(file);
  requireCondition(stat.isFile() && !stat.isSymbolicLink(),
    `${label} must be a regular file without symbolic links`, "UNSAFE_FILE");
  return stat;
}

export function copyRegularFile(source, destination, mode) {
  regularFile(source, source);
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
  chmodSync(destination, mode);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  requireCondition(result.error === undefined,
    `${command} could not start: ${result.error?.message ?? "unknown error"}`,
    "COMMAND_START_FAILED");
  requireCondition(result.status === 0,
    `${command} failed (${result.status}): ${(result.stderr ?? "").trim()}`,
    "COMMAND_FAILED");
  return result.stdout ?? "";
}

export function makeEmptyDirectory(directory) {
  try {
    mkdirSync(directory, { mode: 0o755 });
  } catch (error) {
    fail(`destination must be new: ${directory} (${error.code ?? error.message})`,
      "DESTINATION_EXISTS");
  }
}

export function walkRegularTree(root) {
  const entries = [];
  const visit = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const stat = lstatSync(absolute);
      requireCondition(!stat.isSymbolicLink(),
        `tree contains a symbolic link: ${relative}`, "UNSAFE_TREE");
      if (stat.isDirectory()) {
        visit(absolute, relative);
      } else {
        requireCondition(stat.isFile(), `tree contains a special file: ${relative}`,
          "UNSAFE_TREE");
        entries.push({ relative, absolute, mode: stat.mode & 0o777 });
      }
    }
  };
  visit(root, "");
  return entries;
}

export function treeDigest(root) {
  const hash = createHash("sha256");
  for (const entry of walkRegularTree(root)) {
    const content = readFileSync(entry.absolute);
    hash.update(entry.relative);
    hash.update("\0");
    hash.update(String(entry.mode));
    hash.update("\0");
    hash.update(String(content.length));
    hash.update("\0");
    hash.update(content);
  }
  return hash.digest("hex");
}

export function writeModeManifest(root, destination) {
  const files = walkRegularTree(root).map(({ relative, mode }) => ({
    path: relative,
    mode: mode.toString(8).padStart(4, "0"),
  }));
  writeCanonicalJson(destination, { schemaVersion: 1, files });
}

export function verifyModeManifest(root, manifestFile) {
  const manifest = readJson(manifestFile);
  requireCondition(manifest.schemaVersion === 1 && Array.isArray(manifest.files),
    "mode manifest is invalid", "INVALID_MODE_MANIFEST");
  const actual = walkRegularTree(root)
    .filter(({ relative }) => relative !== path.relative(root, manifestFile))
    .map(({ relative, mode }) => ({ path: relative, mode: mode.toString(8).padStart(4, "0") }));
  requireCondition(JSON.stringify(actual) === JSON.stringify(manifest.files),
    "staged file names or modes differ from MODE-MANIFEST.json", "MODE_MANIFEST_MISMATCH");
}

export function atomicReplace(source, destination) {
  rmSync(destination, { force: true });
  renameSync(source, destination);
}

export function assertInside(root, candidate) {
  const canonicalRoot = realpathSync(root);
  const resolved = path.resolve(candidate);
  requireCondition(resolved === canonicalRoot || resolved.startsWith(`${canonicalRoot}${path.sep}`),
    `${candidate} escapes ${root}`, "PATH_ESCAPE");
  return resolved;
}

export function assertArchiveMemberPath(value) {
  requireCondition(typeof value === "string" && value.length > 0 && !value.includes("\0") &&
    !path.posix.isAbsolute(value) && value.split("/").every((part) => part !== ".." && part !== ""),
  `unsafe archive member path: ${value}`, "UNSAFE_ARCHIVE");
}

export function fileSize(file) {
  return Number(statSync(file).size);
}
