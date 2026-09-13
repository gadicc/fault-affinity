#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  rmSync,
  statfsSync,
  statSync,
  fsyncSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildControlledLoadSessionManifest,
  runControlledLoadSession,
} from "../../diagnose-lib/controlled-load-session.mjs";
import { startControlledLoadWorkerSet } from "../../diagnose-lib/controlled-load-workers.mjs";
import { runWorkloadAttempt } from "../../diagnose-lib/attempt-runner.mjs";
import { buildAttemptEvidence } from "../../diagnose-lib/attempt-evidence.mjs";
import {
  bundleExecutionLeaseAttemptRetention,
  withBundleExecutionLease,
} from "../../diagnose-lib/bundle-execution-lease.mjs";
import { resolveWorkloadSpec } from "../../diagnose-lib/workload-spec.mjs";
import { canonicalProtocolJson } from "../../diagnose-lib/pinned-protocol.mjs";

export const REFERENCE_FORMAT_VERSION = 1;
export const REFERENCE_TARGET_OUTCOMES = Object.freeze({
  targetSignals: Object.freeze(["SIGSEGV"]),
  mappedExits: Object.freeze([]),
});
export const REFERENCE_PROFILE = Object.freeze({
  id: "load-aba-reference",
  version: 1,
  targetCpu: 19,
  loadCpus: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]),
  attemptsPerLeg: 20,
  initialSettleMs: 15_000,
  loadWarmupMs: 0,
  recoveryMs: 15_000,
  attemptTimeoutMs: 120_000,
  termGraceMs: 1_000,
  killGraceMs: 2_000,
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(HERE, "../../..");
const MAX_RUNS = 1_000;
const MAX_CPU = 65_535;
const MIN_RESULTS_BYTES = 64n * 1024n * 1024n;
const SAFE_NAME_RE = /^reference-[0-9]{8}T[0-9]{6}Z(?:-[a-z0-9][a-z0-9-]{0,31})?$/;
const INJECTION_ENV = Object.freeze([
  "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_DEBUG",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "PGLITE_LOAD_ABA_NODE_BIN",
  "PGLITE_LOAD_ABA_CONTROLLER", "PGLITE_LOAD_ABA_OUT_DIR", "PGLITE_LOAD_ABA_ALLOWED_CPUS",
]);

export class ReferenceControllerError extends Error {
  constructor(message, code = "REFERENCE_INPUT_INVALID") {
    super(message);
    this.name = "ReferenceControllerError";
    this.code = code;
  }
}

export function validateReferenceHost({
  platform = process.platform,
  architecture = process.arch,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (platform !== "linux") fail("reference kit requires Linux", "REFERENCE_HOST_UNSUPPORTED");
  if (architecture !== "x64") {
    fail("reference kit requires x86-64", "REFERENCE_HOST_UNSUPPORTED");
  }
  if (!Number.isSafeInteger(uid) || uid < 0) {
    fail("reference kit cannot determine the invoking user", "REFERENCE_HOST_UNSUPPORTED");
  }
  if (uid === 0) fail("reference kit must not run as root", "REFERENCE_ROOT_REFUSED");
  return Object.freeze({ platform, architecture, uid });
}

function fail(message, code) {
  throw new ReferenceControllerError(message, code);
}

function integer(text, label, minimum, maximum) {
  if (typeof text !== "string" || !/^(0|[1-9][0-9]*)$/.test(text)) {
    fail(`${label} must be a canonical non-negative integer`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be from ${minimum} through ${maximum}`);
  }
  return value;
}

export function parseCpuList(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 16_384) {
    fail("CPU list must be a bounded non-empty list");
  }
  const values = [];
  for (const field of text.split(",")) {
    const match = field.match(/^(0|[1-9][0-9]*)(?:-(0|[1-9][0-9]*))?$/);
    if (!match) fail(`invalid CPU-list field '${field}'`);
    const first = integer(match[1], "CPU", 0, MAX_CPU);
    const last = match[2] === undefined ? first : integer(match[2], "CPU", first, MAX_CPU);
    if (last - first > 4_096) fail("CPU-list range is too large");
    for (let cpu = first; cpu <= last; cpu += 1) values.push(cpu);
  }
  const unique = [...new Set(values)].sort((left, right) => left - right);
  if (unique.length !== values.length || unique.length === 0 || unique.length > 256) {
    fail("CPU list must contain 1 through 256 unique CPUs");
  }
  return unique;
}

function defaultOutputName(now = new Date()) {
  return `reference-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

export function parseReferenceArgs(argv, { now = () => new Date() } = {}) {
  const options = {
    dryRun: true,
    yes: false,
    help: false,
    resultsRoot: null,
    outputName: null,
    targetCpu: REFERENCE_PROFILE.targetCpu,
    controllerCpu: "auto",
    loadCpus: [...REFERENCE_PROFILE.loadCpus],
    attemptsPerLeg: REFERENCE_PROFILE.attemptsPerLeg,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes") {
      if (seen.has("--dry-run")) fail("choose --yes or --dry-run, not both");
      options.yes = true;
      options.dryRun = false;
      seen.add(arg);
    } else if (arg === "--dry-run") {
      if (seen.has("--yes")) fail("choose --yes or --dry-run, not both");
      options.dryRun = true;
      seen.add(arg);
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (["--results-root", "--output-name", "--target-cpu", "--controller-cpu", "--load-cpus", "--runs"].includes(arg)) {
      if (seen.has(arg)) fail(`${arg} may be supplied only once`);
      seen.add(arg);
      const value = argv[++index];
      if (value === undefined) fail(`${arg} requires a value`);
      if (arg === "--results-root") options.resultsRoot = path.resolve(value);
      else if (arg === "--output-name") options.outputName = value;
      else if (arg === "--target-cpu") options.targetCpu = integer(value, arg, 0, MAX_CPU);
      else if (arg === "--controller-cpu") options.controllerCpu = value === "auto"
        ? "auto" : integer(value, arg, 0, MAX_CPU);
      else if (arg === "--load-cpus") options.loadCpus = parseCpuList(value);
      else options.attemptsPerLeg = integer(value, arg, 1, MAX_RUNS);
    } else {
      fail(`unknown argument '${arg}'`);
    }
  }
  if (!options.help && options.resultsRoot === null) fail("--results-root DIR is required");
  options.outputName ??= defaultOutputName(now());
  if (!SAFE_NAME_RE.test(options.outputName)) {
    fail("--output-name must be reference-YYYYMMDDTHHMMSSZ with an optional lowercase suffix");
  }
  if (options.loadCpus.includes(options.targetCpu)) fail("target CPU must be outside --load-cpus");
  return Object.freeze({ ...options, loadCpus: Object.freeze(options.loadCpus) });
}

export function assertSafeAmbientEnvironment(environment = process.env) {
  const present = INJECTION_ENV.filter((name) => Object.hasOwn(environment, name));
  if (present.length > 0) {
    fail(`refusing injection-capable environment variable(s): ${present.join(", ")}`,
      "REFERENCE_ENVIRONMENT_REJECTED");
  }
}

export function reviewedLaunchEnvironment(environment = process.env) {
  const home = environment.HOME;
  if (typeof home !== "string" || !path.isAbsolute(home) || home.includes("\0")) {
    fail("HOME must be an absolute NUL-free path", "REFERENCE_ENVIRONMENT_REJECTED");
  }
  const result = { HOME: home, PATH: "/usr/bin:/bin" };
  for (const name of ["LANG", "LC_ALL", "TZ", "TMPDIR"]) {
    const value = environment[name];
    if (value !== undefined) {
      if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 4096) {
        fail(`${name} is invalid`, "REFERENCE_ENVIRONMENT_REJECTED");
      }
      result[name] = value;
    }
  }
  return Object.freeze(result);
}

function readCpuSet(file) {
  return parseCpuList(readFileSync(file, "utf8").trim());
}

function allowedCpuSet() {
  const value = readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  if (value === undefined) fail("cannot read allowed CPUs", "REFERENCE_CPU_DISCOVERY_FAILED");
  return parseCpuList(value);
}

function schedulableCpuSet() {
  try {
    const effective = readFileSync("/sys/fs/cgroup/cpuset.cpus.effective", "utf8").trim();
    if (effective !== "") return parseCpuList(effective);
  } catch {
    // A v1 or delegated cgroup may not expose the unified effective-set file.
  }
  return allowedCpuSet();
}

export function validateCpuSelection(options, { onlineCpus, allowedCpus }) {
  const online = new Set(onlineCpus);
  const allowed = new Set(allowedCpus);
  for (const cpu of [options.targetCpu, ...options.loadCpus]) {
    if (!online.has(cpu)) fail(`CPU ${cpu} is not online`, "REFERENCE_CPU_UNAVAILABLE");
    if (!allowed.has(cpu)) fail(`CPU ${cpu} is not allowed to this process`, "REFERENCE_CPU_UNAVAILABLE");
  }
  const unused = [...allowedCpus].filter((cpu) => online.has(cpu) &&
    cpu !== options.targetCpu && !options.loadCpus.includes(cpu)).sort((a, b) => a - b);
  const controllerCpu = options.controllerCpu === "auto" ? unused[0] : options.controllerCpu;
  if (!Number.isSafeInteger(controllerCpu) || !online.has(controllerCpu) || !allowed.has(controllerCpu)) {
    fail("controller CPU is not online and allowed", "REFERENCE_CPU_UNAVAILABLE");
  }
  if (controllerCpu === options.targetCpu || options.loadCpus.includes(controllerCpu)) {
    fail("controller CPU must be outside target and load CPUs", "REFERENCE_CPU_UNAVAILABLE");
  }
  return Object.freeze({ onlineCpus: [...onlineCpus], allowedCpus: [...allowedCpus], controllerCpu });
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function executableIdentity(file, versionArgs = ["--version"], expected = null,
  dependencies = {}) {
  const canonical = realpathSync(file);
  const stats = statSync(canonical);
  if (!stats.isFile() || (stats.mode & 0o111) === 0) fail(`${file} is not an executable file`);
  const sha256 = sha256File(canonical);
  if (expected !== null && sha256 !== expected.sha256) {
    fail("executable hash does not match RELEASE.json before version inspection",
      "REFERENCE_RELEASE_IDENTITY_MISMATCH");
  }
  const execute = dependencies.execFile ?? execFileSync;
  const version = execute(canonical, versionArgs, {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 5_000,
  }).trim().split("\n")[0];
  if (expected !== null && version !== expected.version) {
    fail("executable version does not match RELEASE.json",
      "REFERENCE_RELEASE_IDENTITY_MISMATCH");
  }
  return Object.freeze({
    path: canonical,
    bytes: stats.size,
    sha256,
    version,
  });
}

export function treeIdentity(root) {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const relative = path.posix.join(prefix, name);
      const stats = lstatSync(file);
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
        fail(`PGlite payload contains unsupported member '${relative}'`);
      }
      if (stats.isDirectory()) walk(file, relative);
      else {
        const content = readFileSync(file);
        hash.update(relative).update("\0").update(String(stats.mode & 0o777)).update("\0")
          .update(String(content.length)).update("\0").update(content);
        files += 1;
        bytes += content.length;
      }
    }
  };
  walk(root);
  return Object.freeze({
    algorithm: "path-mode-size-content-sha256-v1",
    files,
    bytes,
    sha256: hash.digest("hex"),
  });
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

export function validateReleaseIdentity(value, observed) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      value.schemaVersion !== 1) fail("RELEASE.json has an unsupported schema");
  const release = value.release;
  const profile = value.profile;
  const runtimes = value.runtimes;
  const components = value.components;
  if (release === null || typeof release !== "object" ||
      typeof release.version !== "string" || !VERSION_RE.test(release.version) ||
      release.tag !== `v${release.version}` || !COMMIT_RE.test(release.sourceCommit ?? "") ||
      release.platform !== "linux-x64") {
    fail("RELEASE.json release identity is invalid");
  }
  if (profile?.id !== REFERENCE_PROFILE.id || profile?.version !== REFERENCE_PROFILE.version ||
      profile?.pgliteVersion !== "0.5.4") {
    fail("RELEASE.json reference profile is invalid");
  }
  if (runtimes === null || typeof runtimes !== "object" ||
      components === null || typeof components !== "object") {
    fail("RELEASE.json is missing runtime or component identities");
  }
  for (const [role, expectedVersion] of [["controller", "v24.21.0"], ["reference", "v25.2.1"]]) {
    const declared = runtimes[role];
    const actual = observed[role];
    if (declared?.version !== expectedVersion || !SHA256_RE.test(declared?.sha256 ?? "") ||
        actual?.version !== expectedVersion || actual?.sha256 !== declared.sha256) {
      fail(`RELEASE.json ${role} runtime does not match the extracted executable`,
        "REFERENCE_RELEASE_IDENTITY_MISMATCH");
    }
  }
  if (!SHA256_RE.test(components.pgliteTreeSha256 ?? "") ||
      components.pgliteTreeSha256 !== observed.pglite.sha256 ||
      observed.pglite.version !== profile.pgliteVersion) {
    fail("RELEASE.json PGlite identity does not match the extracted app",
      "REFERENCE_RELEASE_IDENTITY_MISMATCH");
  }
  if (!SHA256_RE.test(components.appTreeSha256 ?? "") ||
      components.appTreeSha256 !== observed.app.sha256) {
    fail("RELEASE.json app identity does not match the extracted app tree",
      "REFERENCE_RELEASE_IDENTITY_MISMATCH");
  }
  return value;
}

function validateReleaseDeclaration(value) {
  const placeholder = {
    controller: value?.runtimes?.controller,
    reference: value?.runtimes?.reference,
    pglite: { version: value?.profile?.pgliteVersion, sha256: value?.components?.pgliteTreeSha256 },
    app: { sha256: value?.components?.appTreeSha256 },
  };
  return validateReleaseIdentity(value, placeholder);
}

export function resolveKitLayout(kitRoot = KIT_ROOT) {
  const root = realpathSync(kitRoot);
  return Object.freeze({
    root,
    releaseFile: path.join(root, "RELEASE.json"),
    controllerNode: path.join(root, "runtime/controller/bin/node"),
    targetNode: path.join(root, "runtime/reference/bin/node"),
    child: path.join(root, "app/child.mjs"),
    pglite: path.join(root, "app/node_modules/@electric-sql/pglite"),
    taskset: "/usr/bin/taskset",
    yes: "/usr/bin/yes",
    flock: "/usr/bin/flock",
    app: path.join(root, "app"),
  });
}

export function collectReferenceKitIdentity(layout) {
  const release = JSON.parse(readFileSync(layout.releaseFile, "utf8"));
  validateReleaseDeclaration(release);
  const controller = executableIdentity(layout.controllerNode, ["--version"], release.runtimes.controller);
  const target = executableIdentity(layout.targetNode, ["--version"], release.runtimes.reference);
  if (realpathSync(process.execPath) !== controller.path) {
    fail("controller is not running under the bundled controller runtime");
  }
  if (controller.version !== "v24.21.0") fail(`controller runtime is ${controller.version}, expected v24.21.0`);
  if (target.version !== "v25.2.1") fail(`reference runtime is ${target.version}, expected v25.2.1`);
  const pglitePackage = JSON.parse(readFileSync(path.join(layout.pglite, "package.json"), "utf8"));
  if (pglitePackage.version !== "0.5.4") fail(`PGlite is ${pglitePackage.version}, expected 0.5.4`);
  const pglite = { version: pglitePackage.version, ...treeIdentity(realpathSync(layout.pglite)) };
  const app = treeIdentity(realpathSync(layout.app));
  validateReleaseIdentity(release, { controller, reference: target, pglite, app });
  return Object.freeze({
    release,
    platform: { linux: os.release(), architecture: os.arch(), ubuntu: readFileSync("/etc/os-release", "utf8") },
    executables: {
      controller,
      target,
      taskset: executableIdentity(layout.taskset),
      yes: executableIdentity(layout.yes),
      flock: executableIdentity(layout.flock),
    },
    child: { path: realpathSync(layout.child), sha256: sha256File(realpathSync(layout.child)) },
    pglite,
    app,
  });
}

function boundedSystemText(file, maximum = 4096) {
  try {
    const value = readFileSync(file, "utf8");
    return value.slice(0, maximum).trim() || null;
  } catch {
    return null;
  }
}

function osReleaseFields(text) {
  const allowed = new Set(["ID", "VERSION_ID", "PRETTY_NAME"]);
  const result = {};
  for (const line of (text ?? "").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match || !allowed.has(match[1])) continue;
    result[match[1]] = match[2].replace(/^"|"$/g, "").slice(0, 256);
  }
  return result;
}

export function collectMachineMetadata(selection, dependencies = {}) {
  const read = dependencies.readSystemText ?? boundedSystemText;
  const cpuinfo = read("/proc/cpuinfo", 1024 * 1024) ?? "";
  const processors = new Map();
  for (const block of cpuinfo.split(/\n\s*\n/)) {
    const fields = Object.fromEntries(block.split("\n").map((line) => {
      const index = line.indexOf(":");
      return index < 0 ? ["", ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }).filter(([key]) => key !== ""));
    if (/^(0|[1-9][0-9]*)$/.test(fields.processor ?? "")) {
      processors.set(Number(fields.processor), {
        model: (fields["model name"] ?? null)?.slice(0, 256) ?? null,
        microcode: (fields.microcode ?? null)?.slice(0, 64) ?? null,
      });
    }
  }
  const cpu = (number, role) => ({
    role,
    cpu: number,
    ...processors.get(number),
    topology: Object.fromEntries([
      ["physicalPackageId", "physical_package_id"], ["dieId", "die_id"],
      ["clusterId", "cluster_id"], ["coreId", "core_id"],
    ].map(([name, leaf]) => [name,
      read(`/sys/devices/system/cpu/cpu${number}/topology/${leaf}`, 64)])),
  });
  return Object.freeze({
    schemaVersion: 1,
    privacy: "DMI serial numbers, asset tags, and UUIDs are deliberately omitted.",
    dmi: {
      productName: read("/sys/class/dmi/id/product_name"),
      productVersion: read("/sys/class/dmi/id/product_version"),
      boardVendor: read("/sys/class/dmi/id/board_vendor"),
      boardName: read("/sys/class/dmi/id/board_name"),
      boardVersion: read("/sys/class/dmi/id/board_version"),
      biosVendor: read("/sys/class/dmi/id/bios_vendor"),
      biosVersion: read("/sys/class/dmi/id/bios_version"),
      biosDate: read("/sys/class/dmi/id/bios_date"),
    },
    software: { kernel: os.release(), os: osReleaseFields(read("/etc/os-release", 16 * 1024)) },
    cpus: [cpu(selection.controllerCpu, "controller"), cpu(selection.targetCpu, "target"),
      ...selection.loadCpus.map((number) => cpu(number, "load"))],
  });
}

function resolvedWorkloads(layout, launchEnvironment, bindingKey) {
  const common = { environment: { set: launchEnvironment }, capabilities: {} };
  const measured = resolveWorkloadSpec({
    version: 1, id: "reference-pglite-target", label: "Pinned PGlite reference target",
    description: "One bounded PGlite SELECT 1 lifecycle on the frozen reference runtime.", risk: "high-memory",
    command: { executable: layout.targetNode, args: [layout.child], cwd: layout.app },
    ...common,
    provenance: { completeness: "complete", files: [layout.child] },
    attempt: { mode: "exit", timeoutMs: REFERENCE_PROFILE.attemptTimeoutMs,
      termGraceMs: REFERENCE_PROFILE.termGraceMs, killGraceMs: REFERENCE_PROFILE.killGraceMs },
    outcomes: REFERENCE_TARGET_OUTCOMES,
  }, { environment: launchEnvironment, environmentBindingKey: bindingKey });
  const auxiliary = resolveWorkloadSpec({
    version: 1, id: "reference-load-worker", label: "Pinned yes load worker",
    description: "Managed load worker retained only for the bounded loaded leg.", risk: "disruptive",
    command: { executable: layout.yes, args: [], cwd: layout.root },
    ...common,
    provenance: { completeness: "complete", files: [] },
    attempt: { mode: "survive-window", timeoutMs: 7 * 24 * 60 * 60 * 1_000,
      termGraceMs: REFERENCE_PROFILE.termGraceMs, killGraceMs: REFERENCE_PROFILE.killGraceMs },
    outcomes: { targetSignals: [], mappedExits: [] },
  }, { environment: launchEnvironment, environmentBindingKey: bindingKey });
  return Object.freeze({ measured, auxiliary });
}

function outputRoot(options, dependencies = {}) {
  const { allowVolatileRoot = false } = dependencies;
  const root = realpathSync(options.resultsRoot);
  if (!statSync(root).isDirectory()) fail("results root must be an existing directory");
  if (!allowVolatileRoot && (root === "/tmp" || root.startsWith("/tmp/"))) {
    fail("results root must not be below /tmp", "REFERENCE_RESULTS_VOLATILE");
  }
  const leaf = path.join(root, options.outputName);
  if (path.dirname(leaf) !== root) fail("output leaf escaped results root");
  try { lstatSync(leaf); fail("output leaf already exists", "REFERENCE_OUTPUT_EXISTS"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const storage = (dependencies.inspectStorage ?? inspectOutputStorage)(root);
  if (BigInt(storage.availableBytes) < MIN_RESULTS_BYTES) {
    fail(`results root has less than ${MIN_RESULTS_BYTES} available bytes`,
      "REFERENCE_RESULTS_CAPACITY_LOW");
  }
  if (options.yes && new Set(["vfat", "exfat", "ntfs", "ntfs3", "fuseblk"]).has(storage.filesystemType)) {
    fail("active results require a Unix filesystem with advisory locks and permissions; prepare the final archive onto FAT/exFAT later",
      "REFERENCE_RESULTS_FILESYSTEM_UNSUPPORTED");
  }
  return { root, leaf, storage };
}

function decodeMountField(value) {
  return value.replace(/\\(040|011|012|134)/g, (_match, code) => ({
    "040": " ", "011": "\t", "012": "\n", "134": "\\",
  })[code]);
}

export function inspectOutputStorage(root, dependencies = {}) {
  const statfs = dependencies.statfs ?? ((target) => statfsSync(target, { bigint: true }));
  const stats = statfs(root);
  const available = BigInt(stats.bavail) * BigInt(stats.bsize);
  let mountPoint = null;
  let filesystemType = null;
  let source = null;
  try {
    const text = (dependencies.readMountInfo ?? (() => readFileSync("/proc/self/mountinfo", "utf8")))();
    for (const line of text.split("\n")) {
      const [before, after] = line.split(" - ");
      if (after === undefined) continue;
      const fields = before.split(" ");
      const mounted = decodeMountField(fields[4] ?? "");
      if (mounted !== "/" && root !== mounted && !root.startsWith(`${mounted}/`)) continue;
      if (mountPoint !== null && mounted.length <= mountPoint.length) continue;
      const post = after.split(" ");
      mountPoint = mounted;
      filesystemType = post[0] ?? null;
      source = decodeMountField(post[1] ?? "");
    }
  } catch {
    // Capacity remains authoritative; an uncertain mount classification is evidence, not failure.
  }
  const volatileTypes = new Set(["tmpfs", "ramfs", "overlay", "aufs"]);
  const classification = filesystemType !== null && volatileTypes.has(filesystemType)
    ? "volatile-or-live-layer"
    : source?.startsWith("/dev/") || mountPoint?.startsWith("/media/") || mountPoint?.startsWith("/mnt/")
      ? "likely-persistent"
      : "unknown";
  const warning = classification === "likely-persistent"
    ? null
    : classification === "volatile-or-live-layer"
      ? "WARNING: results appear to be on volatile live-session storage and may disappear at shutdown. Choose mounted persistent media."
      : "WARNING: results storage persistence could not be established. Confirm this path is on mounted persistent media before running.";
  return Object.freeze({
    availableBytes: available.toString(),
    minimumRequiredBytes: MIN_RESULTS_BYTES.toString(),
    mountPoint,
    filesystemType,
    source,
    classification,
    warning,
  });
}

function planValue(options, topology, identity, destination, host, machine) {
  return Object.freeze({
    formatVersion: REFERENCE_FORMAT_VERSION,
    profile: { ...REFERENCE_PROFILE, loadCpus: [...REFERENCE_PROFILE.loadCpus] },
    selection: { controllerCpu: topology.controllerCpu, targetCpu: options.targetCpu,
      loadCpus: [...options.loadCpus], attemptsPerLeg: options.attemptsPerLeg },
    schedule: [
      { leg: "A1", condition: "without-load", attempts: options.attemptsPerLeg },
      { leg: "B", condition: "verified-induced-load", attempts: options.attemptsPerLeg },
      { leg: "A2", condition: "after-recovery", attempts: options.attemptsPerLeg },
    ],
    deadlines: {
      attemptMs: REFERENCE_PROFILE.attemptTimeoutMs,
      termGraceMs: REFERENCE_PROFILE.termGraceMs,
      killGraceMs: REFERENCE_PROFILE.killGraceMs,
      loadedWindowMs: REFERENCE_PROFILE.loadWarmupMs + options.attemptsPerLeg *
        (REFERENCE_PROFILE.attemptTimeoutMs + REFERENCE_PROFILE.termGraceMs + REFERENCE_PROFILE.killGraceMs) + 30_000,
    },
    cleanupContract: {
      attempt: "identity-bound-process-group-term-then-kill-v1",
      controllerDeath: "attempt-supervisor-ipc-disconnect-drains-process-group-v1",
      load: "managed-worker-set-abort-and-verified-stop-v1",
    },
    outputRoot: destination.root,
    outputLeaf: destination.leaf,
    storage: destination.storage,
    host,
    machine,
    topology,
    identity,
  });
}

function appendEvent(file, type, payload = {}) {
  appendFileSync(file, `${JSON.stringify({ formatVersion: REFERENCE_FORMAT_VERSION, type,
    unixMs: Date.now(), monotonicNs: process.hrtime.bigint().toString(), ...payload })}\n`, { encoding: "utf8" });
}

function durableJournalRecord(fd, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  fsyncSync(fd);
}

function fsyncPath(target, directory = false) {
  const fd = openSync(target, fsConstants.O_RDONLY |
    (directory && fsConstants.O_DIRECTORY !== undefined ? fsConstants.O_DIRECTORY : 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function canonicalBinding(value) {
  const bytes = Buffer.from(`${canonicalProtocolJson(value)}\n`, "utf8");
  return Object.freeze({ algorithm: "canonical-json-line-sha256-v1", bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") });
}

function workloadDescriptor(resolved) {
  const { digest: _digest, ...descriptor } = resolved;
  return JSON.parse(canonicalProtocolJson(descriptor));
}

function referenceSlot(ordinal, attemptsPerLeg) {
  const legIndex = Math.floor((ordinal - 1) / attemptsPerLeg);
  const legs = ["a1", "b", "a2"];
  if (legIndex < 0 || legIndex >= legs.length) fail("reference attempt exceeded its fixed schedule");
  return { ordinal, leg: legs[legIndex], position: ((ordinal - 1) % attemptsPerLeg) + 1 };
}

function validateJournalAgainstSession(records, session) {
  const completed = records.filter((record) => record.type === "attempt-complete");
  const expected = ["a1", "b", "a2"].flatMap((leg) =>
    (Array.isArray(session?.attempts?.[leg]) ? session.attempts[leg] : [])
      .map((attempt) => attempt.evidence));
  if (completed.length !== expected.length || completed.some((record, index) =>
    record.ordinal !== index + 1 || JSON.stringify(record.evidence) !== JSON.stringify(expected[index]))) {
    fail("durable attempt journal does not match the final controlled-load session",
      "REFERENCE_PROGRESS_MISMATCH");
  }
}

function wait(milliseconds, signal) {
  if (milliseconds === 0) return Promise.resolve(!signal?.aborted);
  return new Promise((resolve) => {
    const finish = (value) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(value); };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

const SUMMARY_OUTCOMES = Object.freeze([
  "pass", "target-fault", "corruption", "other-workload-failure", "operational-invalid",
]);

export function renderReferenceSummary(status, plan, session, operationalError = null) {
  const lines = [
    "# Fault Affinity reference run",
    "",
    `- Operational status: **${status}**`,
    `- Profile: \`${REFERENCE_PROFILE.id}\` version ${REFERENCE_PROFILE.version}`,
    `- Controller CPU: ${plan.selection.controllerCpu}`,
    `- Target CPU: ${plan.selection.targetCpu}`,
    `- Load CPUs: ${plan.selection.loadCpus.join(", ")}`,
    `- Attempts requested per leg: ${plan.selection.attemptsPerLeg}`,
    `- Results storage: ${plan.storage.classification} (${plan.storage.availableBytes} bytes available)`,
  ];
  if (plan.storage.warning !== null) lines.push(`- **${plan.storage.warning}**`);
  if (session?.committed === false) {
    lines.push(`- Incomplete stage: ${session.stage ?? "unknown"}`,
      `- Operational reason: ${session.reason ?? "unknown"}`,
      `- Operational error code: ${session.errorCode ?? "none recorded"}`);
  }
  if (operationalError !== null) {
    lines.push(`- Controller error: ${operationalError.code}`);
  }
  lines.push(
    "",
    "Timeouts, launch failures, cancellation, and incomplete cleanup are operational evidence; they are not counted as target faults.",
    "",
    "| Leg | Recorded | Pass | Target fault | Corruption | Other workload failure | Operational invalid |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const [key, label] of [["a1", "A1"], ["b", "B"], ["a2", "A2"]]) {
    const attempts = Array.isArray(session?.attempts?.[key]) ? session.attempts[key] : [];
    const counts = Object.fromEntries(SUMMARY_OUTCOMES.map((category) => [category, 0]));
    for (const attempt of attempts) {
      const category = attempt?.evidence?.outcome?.category;
      counts[SUMMARY_OUTCOMES.includes(category) ? category : "operational-invalid"] += 1;
    }
    lines.push(`| ${label} | ${attempts.length} | ${counts.pass} | ${counts["target-fault"]} | ` +
      `${counts.corruption} | ${counts["other-workload-failure"]} | ${counts["operational-invalid"]} |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function referenceArgs(options, controllerCpu) {
  return ["--results-root", options.resultsRoot, "--output-name", options.outputName,
    "--controller-cpu", String(controllerCpu), "--target-cpu", String(options.targetCpu),
    "--load-cpus", options.loadCpus.join(","), "--runs", String(options.attemptsPerLeg), "--yes"];
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function renderDryRunPlan(plan) {
  const command = ["./bin/run-reference", "--results-root", plan.outputRoot,
    "--output-name", path.basename(plan.outputLeaf), "--controller-cpu", plan.selection.controllerCpu,
    "--target-cpu", plan.selection.targetCpu, "--load-cpus", plan.selection.loadCpus.join(","),
    "--runs", plan.selection.attemptsPerLeg, "--yes"].map(shellQuote).join(" ");
  const safeStorage = plan.storage.classification === "likely-persistent" &&
    !new Set(["vfat", "exfat", "ntfs", "ntfs3", "fuseblk"]).has(plan.storage.filesystemType);
  const release = plan.identity.release;
  const abbreviated = (value) => typeof value === "string" ? `${value.slice(0, 12)}…` : "unavailable";
  return ["Fault Affinity reference dry run", "",
    `Profile: ${REFERENCE_PROFILE.id} v${REFERENCE_PROFILE.version} (A1 / loaded B / A2)`,
    `Controller CPU: ${plan.selection.controllerCpu}`,
    `Target CPU: ${plan.selection.targetCpu}`,
    `Load CPUs: ${plan.selection.loadCpus.join(", ")}`,
    `Attempts: ${plan.selection.attemptsPerLeg} per leg (${plan.selection.attemptsPerLeg * 3} total)`,
    `Results: ${plan.outputLeaf}`,
    ...(plan.storage.warning === null ? [] : [plan.storage.warning]),
    "", "Details:",
    `  Release: ${release.release.tag} from ${release.release.sourceCommit}`,
    `  Controller runtime: ${release.runtimes.controller.version} (SHA-256 ${abbreviated(release.runtimes.controller.sha256)}, verified)`,
    `  Target runtime: ${release.runtimes.reference.version} (SHA-256 ${abbreviated(release.runtimes.reference.sha256)}, verified)`,
    `  Attempt deadline: ${plan.deadlines.attemptMs / 1000} seconds`,
    `  Loaded-window safety bound: ${plan.deadlines.loadedWindowMs} ms`,
    `  Storage: ${plan.storage.filesystemType ?? "unclassified"}, ${plan.storage.availableBytes} bytes available`,
    "", "Nothing was executed.",
    ...(safeStorage
      ? ["To run this exact plan:", "", command]
      : ["No --yes command is shown because this results root is not confirmed as persistent Unix storage.",
        "Choose a persistent ext4/XFS/Btrfs results root and run the dry run again."]),
    ""].join("\n");
}

async function ensureLiveControllerAffinity(options, topology, layout, launchEnvironment,
  dependencies) {
  const current = (dependencies.readControllerCpus ?? allowedCpuSet)();
  if (current.length === 1 && current[0] === topology.controllerCpu) return null;
  if (dependencies.reexecController !== undefined) {
    return dependencies.reexecController({ cpu: topology.controllerCpu, current, options });
  }
  if (typeof process.execve !== "function") {
    fail("bundled controller runtime cannot re-exec with singleton affinity",
      "REFERENCE_CONTROLLER_AFFINITY_FAILED");
  }
  process.execve(layout.taskset, [layout.taskset, "-c", String(topology.controllerCpu),
    layout.controllerNode, fileURLToPath(import.meta.url), ...referenceArgs(options, topology.controllerCpu)],
  launchEnvironment);
  fail("controller affinity re-exec unexpectedly returned", "REFERENCE_CONTROLLER_AFFINITY_FAILED");
}

export async function executeReference(options, dependencies = {}) {
  const host = validateReferenceHost(dependencies.host);
  assertSafeAmbientEnvironment(dependencies.environment ?? process.env);
  const launchEnvironment = reviewedLaunchEnvironment(dependencies.environment ?? process.env);
  const topology = validateCpuSelection(options, {
    onlineCpus: (dependencies.readOnlineCpus ?? (() => readCpuSet("/sys/devices/system/cpu/online")))(),
    allowedCpus: (dependencies.readAllowedCpus ?? schedulableCpuSet)(),
  });
  const layout = (dependencies.resolveLayout ?? resolveKitLayout)();
  const identity = (dependencies.collectIdentity ?? collectReferenceKitIdentity)(layout);
  const destination = outputRoot(options, dependencies);
  const machine = (dependencies.collectMachineMetadata ?? collectMachineMetadata)({
    controllerCpu: topology.controllerCpu, targetCpu: options.targetCpu, loadCpus: options.loadCpus,
  });
  const plan = planValue(options, topology, identity, destination, host, machine);
  if (!options.yes) return Object.freeze({ executed: false, plan });
  const delegated = await ensureLiveControllerAffinity(options, topology, layout, launchEnvironment,
    dependencies);
  if (delegated !== null) return Object.freeze({ executed: false, delegated: true, plan, delegatedResult: delegated });

  mkdirSync(destination.leaf, { mode: 0o700 });
  const syncDirectory = dependencies.syncDirectory ?? ((target) => fsyncPath(target, true));
  const syncFile = dependencies.syncFile ?? ((target) => fsyncPath(target, false));
  try {
    syncDirectory(destination.leaf);
    syncDirectory(destination.root);
  } catch (error) {
    try { rmdirSync(destination.leaf); } catch { /* preserve the original durability failure */ }
    throw error;
  }
  const runWithLease = dependencies.withBundleExecutionLease ?? withBundleExecutionLease;
  return runWithLease({ bundleDir: destination.leaf, flockPath: layout.flock, waitMs: 0 }, async (lease) => {
  const active = path.join(destination.leaf, ".reference-active");
  const events = path.join(destination.leaf, "reference.jsonl");
  const progress = path.join(destination.leaf, "progress.jsonl");
  const activeFd = openSync(active, "wx", 0o600);
  closeSync(activeFd);
  writeFileSync(events, "", { flag: "wx", mode: 0o600 });
  const progressFd = openSync(progress, "wx", 0o600);
  const progressRecords = [];
  const recordProgress = (value) => {
    const record = { formatVersion: REFERENCE_FORMAT_VERSION, ...value };
    durableJournalRecord(progressFd, record);
    progressRecords.push(record);
  };
  recordProgress({ type: "progress-start", profileId: REFERENCE_PROFILE.id,
    profileVersion: REFERENCE_PROFILE.version, attemptsPerLeg: options.attemptsPerLeg,
    plannedAttempts: options.attemptsPerLeg * 3, plan, planBinding: canonicalBinding(plan) });
  writeFileSync(path.join(destination.leaf, "summary.md"), "# Fault Affinity reference run\n\nRun is active.\n", { flag: "wx", mode: 0o600 });
  writeFileSync(path.join(destination.leaf, "release.json"), `${JSON.stringify(identity.release, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  appendEvent(events, "reference-start", { plan });
  for (const file of [active, events, progress, path.join(destination.leaf, "summary.md"),
    path.join(destination.leaf, "release.json")]) syncFile(file);
  syncDirectory(destination.leaf);

  const abort = new AbortController();
  const external = dependencies.signal;
  let externalInterrupted = false;
  const onExternalAbort = () => {
    externalInterrupted = true;
    abort.abort(external.reason ?? new Error("external cancellation"));
  };
  external?.addEventListener("abort", onExternalAbort, { once: true });
  if (external?.aborted) onExternalAbort();
  const bindKey = (dependencies.randomBytes ?? randomBytes)(32);
  let status = "operational-incomplete";
  let sessionResult = null;
  let operationalError = null;
  let loadedTimer = null;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  const retainedDirectory = (dependencies.bundleExecutionLeaseAttemptRetention ??
    bundleExecutionLeaseAttemptRetention)(lease);
  try {
    const workloads = (dependencies.resolveWorkloads ?? resolvedWorkloads)(layout, launchEnvironment, bindKey);
    const manifest = (dependencies.buildManifest ?? buildControlledLoadSessionManifest)(workloads.measured, workloads.auxiliary, {
      generation: (dependencies.randomBytes ?? randomBytes)(16).toString("hex"),
      attemptsPerLeg: options.attemptsPerLeg,
      targetCpu: options.targetCpu,
      workerCpus: [...options.loadCpus],
      tasksetPath: layout.taskset,
      warmupMs: REFERENCE_PROFILE.loadWarmupMs,
      recoveryMs: REFERENCE_PROFILE.recoveryMs,
    });
    recordProgress({ type: "session-manifest", manifest, manifestBinding: canonicalBinding(manifest),
      workloads: {
        measured: { contractVersion: workloads.measured.version, id: workloads.measured.id,
          digest: workloads.measured.digest, descriptor: workloadDescriptor(workloads.measured) },
        auxiliary: { contractVersion: workloads.auxiliary.version, id: workloads.auxiliary.id,
          digest: workloads.auxiliary.digest, descriptor: workloadDescriptor(workloads.auxiliary) },
      } });
    const initialWait = dependencies.waitInterval ?? wait;
    if (!await initialWait(REFERENCE_PROFILE.initialSettleMs, abort.signal)) {
      throw Object.assign(new Error("cancelled during initial settle"), { code: "REFERENCE_EXTERNAL_CANCEL" });
    }
    const startWorkerSet = dependencies.startWorkerSet ?? startControlledLoadWorkerSet;
    const baseRunAttempt = dependencies.runAttempt ?? runWorkloadAttempt;
    const makeEvidence = dependencies.buildAttemptEvidence ?? buildAttemptEvidence;
    let nextOrdinal = 1;
    const journaledRunAttempt = async (resolved, attemptOptions) => {
      const slot = referenceSlot(nextOrdinal, options.attemptsPerLeg);
      nextOrdinal += 1;
      try {
        const result = await baseRunAttempt(resolved, attemptOptions);
        const evidence = makeEvidence(resolved, result);
        recordProgress({ type: "attempt-complete", ...slot, evidence,
          evidenceBinding: canonicalBinding(evidence) });
        return result;
      } catch (error) {
        recordProgress({ type: "attempt-error", ...slot,
          code: error?.code ?? "REFERENCE_ATTEMPT_RUNNER_ERROR" });
        throw error;
      }
    };
    const boundedStart = async (workerOptions) => {
      loadedTimer = setTimer(() => abort.abort(Object.assign(
        new Error("loaded-window safety deadline"),
        { code: "REFERENCE_LOADED_WINDOW_DEADLINE" },
      )), plan.deadlines.loadedWindowMs);
      let handle;
      try {
        handle = await startWorkerSet(workerOptions);
      } catch (error) {
        clearTimer(loadedTimer);
        loadedTimer = null;
        throw error;
      }
      return Object.freeze({ ...handle, async stop(reason) { clearTimer(loadedTimer); loadedTimer = null; return handle.stop(reason); } });
    };
    sessionResult = await (dependencies.runSession ?? runControlledLoadSession)({
      measured: workloads.measured, auxiliary: workloads.auxiliary, manifest,
      signal: abort.signal, retainedDirectory,
      attemptOptions: { stdoutExcerptBytes: 4096, stderrExcerptBytes: 4096 },
      startWorkerSet: boundedStart,
      runAttempt: journaledRunAttempt,
      ...(dependencies.sessionWaitInterval === undefined ? {} : { waitInterval: dependencies.sessionWaitInterval }),
    });
    status = sessionResult.committed
      ? "complete"
      : externalInterrupted ? "interrupted" : "operational-incomplete";
    validateJournalAgainstSession(progressRecords, sessionResult);
    appendEvent(events, "reference-session", { status, session: sessionResult });
  } catch (error) {
    status = externalInterrupted ? "interrupted" : "operational-incomplete";
    operationalError = {
      code: error?.code ?? "REFERENCE_CONTROLLER_ERROR",
      message: String(error?.message ?? error).slice(0, 4096),
    };
    appendEvent(events, "reference-operational-error", operationalError);
  } finally {
    if (loadedTimer !== null) clearTimer(loadedTimer);
    external?.removeEventListener("abort", onExternalAbort);
    bindKey.fill(0);
  }
  try {
    recordProgress({ type: "progress-end", status,
      completedAttempts: progressRecords.filter((record) => record.type === "attempt-complete").length });
  } finally {
    closeSync(progressFd);
  }
  appendEvent(events, "reference-end", { status });
  syncFile(events);
  writeFileSync(path.join(destination.leaf, "result-state.json"), `${JSON.stringify({ formatVersion: REFERENCE_FORMAT_VERSION, status }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(path.join(destination.leaf, "summary.md"),
    renderReferenceSummary(status, plan, sessionResult, operationalError), { mode: 0o600 });
  syncFile(path.join(destination.leaf, "result-state.json"));
  syncFile(path.join(destination.leaf, "summary.md"));
  syncDirectory(destination.leaf);
  rmSync(active);
  syncDirectory(destination.leaf);
  return Object.freeze({ executed: true, plan, status, session: sessionResult });
  });
}

function usage() {
  return `Usage: run-reference --results-root DIR [options]\n\n` +
    `Prints the frozen A1/B/A2 plan by default. Execution requires --yes.\n\n` +
    `  --target-cpu N     case-study default: 19\n` +
    `  --controller-cpu N controller CPU outside target/load (default: auto)\n` +
    `  --load-cpus LIST   case-study default: 0-7\n` +
    `  --runs N           attempts per leg (default: 20)\n` +
    `  --output-name NAME new reference-YYYYMMDDTHHMMSSZ leaf\n` +
    `  --dry-run           print only (default)\n` +
    `  --yes               perform the live workload\n`;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const ownedAbort = dependencies.signal === undefined ? new AbortController() : null;
  const interrupt = () => ownedAbort.abort(new Error("controller interrupted"));
  if (ownedAbort !== null) {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
  }
  try {
    validateReferenceHost(dependencies.host);
    const options = parseReferenceArgs(argv, dependencies);
    if (options.help) { console.log(usage()); return 0; }
    const result = await executeReference(options, {
      ...dependencies,
      ...(ownedAbort === null ? {} : { signal: ownedAbort.signal }),
    });
    if (!result.executed) console.log(renderDryRunPlan(result.plan));
    else {
      console.log(`Reference run status: ${result.status}`);
      console.log(`Results: ${result.plan.outputLeaf}`);
    }
    return result.executed && result.status !== "complete" ? 1 : 0;
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  } finally {
    if (ownedAbort !== null) {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();
