import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { expandCpuList } from "../../diagnose-lib/pinned-runner.mjs";
import { resolveWorkloadSpec } from "../../diagnose-lib/workload-spec.mjs";
import { canonicalProtocolJson } from "../../diagnose-lib/pinned-protocol.mjs";
import {
  REFERENCE_PROFILE,
  REFERENCE_TARGET_OUTCOMES,
  assertSafeAmbientEnvironment,
  collectReferenceKitIdentity,
  inspectOutputStorage,
  resolveKitLayout,
  reviewedLaunchEnvironment,
  treeIdentity,
  validateReferenceHost,
} from "./controller.mjs";
import {
  REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES,
  REFERENCE_DISCOVERY_MINIMUM_RESULTS_BYTES,
  REFERENCE_DISCOVERY_PROFILE,
  buildReferenceDiscoveryPlan,
  parseReferenceDiscoveryPlan,
  referenceDiscoveryPreviewBinding,
  referenceDiscoveryWorstCaseMs,
} from "./discovery-protocol.mjs";

export const REFERENCE_DISCOVERY_OUTPUT_PREFIX = "reference-discovery-";
export const REFERENCE_DISCOVERY_CONDITION_ID = "reference-guided-yes-load";

const MAX_SYSTEM_TEXT_BYTES = 1024 * 1024;
const SAFE_OUTPUT_NAME_RE =
  /^reference-discovery-[0-9]{8}T[0-9]{6}Z(?:-[a-z0-9][a-z0-9-]{0,31})?$/;
const NON_UNIX_FILESYSTEMS = new Set(["vfat", "exfat", "ntfs", "ntfs3", "fuseblk"]);
const EPHEMERAL_BLOCK_SOURCE_RE = /^\/dev\/(?:loop|ram|zram)[0-9]+(?:p[0-9]+)?$/;
const UNKNOWN_STORAGE_WARNING =
  "WARNING: results storage persistence could not be established. Confirm this path is on mounted persistent media before running.";

export class ReferenceDiscoveryControllerError extends Error {
  constructor(message, code = "REFERENCE_DISCOVERY_INPUT_INVALID") {
    super(message);
    this.name = "ReferenceDiscoveryControllerError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ReferenceDiscoveryControllerError(message, code);
}

function digestBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function defaultReadSystemFile(filename, { optional = false, maximum = MAX_SYSTEM_TEXT_BYTES } = {}) {
  let bytes;
  try {
    bytes = readFileSync(filename);
  } catch (error) {
    if (optional && ["ENOENT", "ENOTDIR"].includes(error?.code)) return null;
    fail(`cannot read ${filename}: ${error?.code ?? "unknown error"}`,
      "REFERENCE_DISCOVERY_OBSERVATION_FAILED");
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum || bytes.includes(0)) {
    fail(`${filename} is empty, oversized, or contains NUL bytes`,
      "REFERENCE_DISCOVERY_OBSERVATION_FAILED");
  }
  return bytes.toString("utf8");
}

function oneLine(readSystemFile, filename, label, { optional = false, empty = false } = {}) {
  const text = readSystemFile(filename, { optional, maximum: 64 * 1024 });
  if (text === null) return null;
  const pattern = empty ? /^[^\n]*\n?$/ : /^[^\n]+\n?$/;
  if (text.includes("\r") || !pattern.test(text)) {
    fail(`${label} must contain exactly one text line`,
      "REFERENCE_DISCOVERY_OBSERVATION_FAILED");
  }
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function cpuList(text, label, { empty = false } = {}) {
  if (empty && text === "") return [];
  try {
    const result = expandCpuList(text);
    if (result.length === 0) fail(`${label} is empty`);
    return result;
  } catch (error) {
    if (error instanceof ReferenceDiscoveryControllerError) throw error;
    fail(`${label} is invalid: ${error.message}`, "REFERENCE_DISCOVERY_TOPOLOGY_INVALID");
  }
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function intersection(left, right) {
  const allowed = new Set(right);
  return sortedUnique(left.filter((value) => allowed.has(value)));
}

function union(...lists) {
  return sortedUnique(lists.flat());
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function processAllowedSpec(readSystemFile) {
  const status = readSystemFile("/proc/self/status", { maximum: 1024 * 1024 });
  const value = status.match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  if (value === undefined) {
    fail("cannot read the process CPU allowance", "REFERENCE_DISCOVERY_TOPOLOGY_INVALID");
  }
  return value;
}

function effectiveCgroupCpuSpec(readSystemFile, dependencies) {
  const resolved = (dependencies.resolveCgroupV2Paths ?? resolvedCgroupV2Paths)(readSystemFile);
  if (resolved !== null) {
    const text = oneLine(readSystemFile, path.join(resolved.paths[0], "cpuset.cpus.effective"),
      "effective nested cgroup CPU list", { optional: true });
    if (text !== null && text !== "") return text;
  }
  if (dependencies.requireResolvedCgroupCpuSet === true) {
    fail("cannot resolve the owner's effective cgroup CPU set",
      "REFERENCE_DISCOVERY_TOPOLOGY_INCOMPLETE");
  }
  return oneLine(readSystemFile, "/sys/fs/cgroup/cpuset.cpus.effective",
    "effective cgroup CPU list", { optional: true });
}

function canonicalTopologyId(value, label) {
  if (!/^(0|[1-9][0-9]{0,9})$/.test(value)) {
    fail(`${label} is unavailable or noncanonical`, "REFERENCE_DISCOVERY_TOPOLOGY_INCOMPLETE");
  }
  return value;
}

export function collectReferenceDiscoveryTopology(dependencies = {}) {
  const readSystemFile = dependencies.readSystemFile ?? defaultReadSystemFile;
  const cpuRoot = dependencies.cpuRoot ?? "/sys/devices/system/cpu";
  const deviceRoot = dependencies.deviceRoot ?? "/sys/devices";
  const onlineCpus = cpuList(oneLine(readSystemFile, path.join(cpuRoot, "online"),
    "online CPU list"), "online CPU list");
  const processAllowedCpus = cpuList(
    dependencies.processAllowedCpuSpec ?? processAllowedSpec(readSystemFile),
    "process allowed CPU list",
  );
  const cgroupText = effectiveCgroupCpuSpec(readSystemFile, dependencies);
  const cgroupCpus = cgroupText === null ? processAllowedCpus :
    cpuList(cgroupText, "effective cgroup CPU list");
  const allowedCpus = intersection(processAllowedCpus, cgroupCpus);
  const usableCpus = intersection(onlineCpus, allowedCpus);
  if (usableCpus.length === 0) {
    fail("no CPU is both online and allowed", "REFERENCE_DISCOVERY_TOPOLOGY_INVALID");
  }

  const performanceText = oneLine(readSystemFile, path.join(deviceRoot, "cpu_core", "cpus"),
    "performance-core CPU list", { optional: true, empty: true });
  const efficientText = oneLine(readSystemFile, path.join(deviceRoot, "cpu_atom", "cpus"),
    "efficient-core CPU list", { optional: true, empty: true });
  const performanceCpus = performanceText === null ? [] : intersection(
    cpuList(performanceText, "performance-core CPU list", { empty: true }),
    usableCpus,
  );
  const efficientCpus = efficientText === null ? [] : intersection(
    cpuList(efficientText, "efficient-core CPU list", { empty: true }),
    usableCpus,
  );
  if (performanceCpus.some((cpu) => efficientCpus.includes(cpu))) {
    fail("observed performance-core and efficient-core CPU lists overlap",
      "REFERENCE_DISCOVERY_TOPOLOGY_INVALID");
  }
  const classified = union(performanceCpus, efficientCpus);
  const classSource = performanceText === null && efficientText === null
    ? "unavailable"
    : performanceCpus.length > 0 && efficientCpus.length > 0 &&
        sameList(classified, usableCpus)
      ? "sysfs-hybrid"
      : "partial";

  const physicalCores = new Map();
  for (const cpu of usableCpus) {
    const packageId = canonicalTopologyId(oneLine(readSystemFile,
      path.join(cpuRoot, `cpu${cpu}`, "topology", "physical_package_id"),
      `CPU ${cpu} physical package`, { optional: true }) ?? "-1",
    `CPU ${cpu} physical package`);
    const coreId = canonicalTopologyId(oneLine(readSystemFile,
      path.join(cpuRoot, `cpu${cpu}`, "topology", "core_id"),
      `CPU ${cpu} physical core`, { optional: true }) ?? "-1",
    `CPU ${cpu} physical core`);
    const key = `${packageId}:${coreId}`;
    const core = physicalCores.get(key) ?? { packageId, coreId, cpus: [] };
    core.cpus.push(cpu);
    physicalCores.set(key, core);
  }
  const cores = [...physicalCores.values()]
    .map((core) => ({ ...core, cpus: sortedUnique(core.cpus) }))
    .sort((left, right) => left.cpus[0] - right.cpus[0]);
  return {
    onlineCpus,
    allowedCpus,
    usableCpus,
    classes: { source: classSource, performanceCpus, efficientCpus },
    cores,
  };
}

function microcodeByCpu(cpuinfo) {
  const result = new Map();
  for (const block of cpuinfo.split(/\n\s*\n/)) {
    const fields = Object.fromEntries(block.split("\n").map((line) => {
      const separator = line.indexOf(":");
      return separator < 0 ? ["", ""] :
        [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }).filter(([key]) => key !== ""));
    if (/^(0|[1-9][0-9]*)$/.test(fields.processor ?? "")) {
      result.set(Number(fields.processor), (fields.microcode ?? "").slice(0, 64) || null);
    }
  }
  return result;
}

export function collectReferenceDiscoveryHost(topology, dependencies = {}) {
  const readSystemFile = dependencies.readSystemFile ?? defaultReadSystemFile;
  const bootId = oneLine(readSystemFile, "/proc/sys/kernel/random/boot_id", "boot ID");
  const machineId = oneLine(readSystemFile, "/etc/machine-id", "machine ID", {
    optional: true,
  }) ?? oneLine(readSystemFile, "/var/lib/dbus/machine-id", "machine ID");
  const osRelease = readSystemFile("/etc/os-release", { maximum: 64 * 1024 });
  const cpuinfo = readSystemFile("/proc/cpuinfo", { maximum: MAX_SYSTEM_TEXT_BYTES });
  const microcode = microcodeByCpu(cpuinfo);
  const powerRecords = [];
  for (const filename of [
    "/sys/devices/system/cpu/intel_pstate/no_turbo",
    ...topology.usableCpus.flatMap((cpu) => [
      `/sys/devices/system/cpu/cpu${cpu}/cpufreq/scaling_governor`,
      `/sys/devices/system/cpu/cpu${cpu}/cpufreq/energy_performance_preference`,
    ]),
  ]) {
    const value = oneLine(readSystemFile, filename, filename, { optional: true });
    if (value !== null) powerRecords.push({ path: filename, value });
  }
  return {
    bootIdSha256: digestBytes(bootId),
    machineSha256: digestBytes(machineId),
    kernelRelease: (dependencies.kernelRelease ?? os.release)(),
    osReleaseSha256: digestBytes(osRelease),
    powerPolicySha256: powerRecords.length === 0 ? null :
      digestBytes(JSON.stringify(powerRecords)),
    microcode: topology.usableCpus.map((cpu) => ({
      cpu,
      value: microcode.get(cpu) ?? null,
    })),
  };
}

function decimalBytes(value, label) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    fail(`${label} is not a canonical unsigned integer`,
      "REFERENCE_DISCOVERY_RESOURCE_INVALID");
  }
  return BigInt(value);
}

function decodeMountInfoField(value) {
  return value.replace(/\\(040|011|012|134)/g, (_match, code) => ({
    "040": " ", "011": "\t", "012": "\n", "134": "\\",
  })[code]);
}

function resolvedCgroupV2Paths(readSystemFile) {
  const membershipText = readSystemFile("/proc/self/cgroup", {
    optional: true,
    maximum: 1024 * 1024,
  });
  const mountInfo = readSystemFile("/proc/self/mountinfo", {
    optional: true,
    maximum: MAX_SYSTEM_TEXT_BYTES,
  });
  if (membershipText === null || mountInfo === null) return null;
  const memberships = membershipText.split("\n").filter((line) => line !== "")
    .map((line) => line.match(/^0::(\/[^\0\r\n]*)$/))
    .filter((match) => match !== null);
  if (memberships.length !== 1) return null;
  const membership = path.normalize(memberships[0][1]);
  // A namespace-relative root can hide stricter host ancestors. The bare-metal
  // kit expects a non-root membership in the fully visible host hierarchy.
  if (membership === "/") return null;
  const candidates = [];
  for (const line of mountInfo.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    if (after[0] !== "cgroup2" || before.length < 5) continue;
    const mountRoot = path.normalize(decodeMountInfoField(before[3]));
    const mountPoint = path.normalize(decodeMountInfoField(before[4]));
    if (!path.isAbsolute(mountRoot) || !path.isAbsolute(mountPoint)) continue;
    const relative = path.relative(mountRoot, membership);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    candidates.push({ mountRoot, mountPoint, relative });
  }
  // A subtree bind mount cannot reveal limits imposed by its hidden ancestors.
  // Prefer only a view rooted at the hierarchy root; cgroup namespaces expose
  // their own complete visible hierarchy with the same root spelling.
  const complete = candidates.filter(({ mountRoot }) => mountRoot === "/")
    .sort((left, right) => left.mountPoint.length - right.mountPoint.length);
  const selected = complete[0];
  if (selected === undefined) return null;
  const leaf = path.resolve(selected.mountPoint, selected.relative);
  const relativeLeaf = path.relative(selected.mountPoint, leaf);
  if (relativeLeaf.startsWith("..") || path.isAbsolute(relativeLeaf)) return null;
  const paths = [];
  for (let current = leaf;; current = path.dirname(current)) {
    paths.push(current);
    if (current === selected.mountPoint) break;
    const parent = path.dirname(current);
    if (parent === current || path.relative(selected.mountPoint, parent).startsWith("..")) {
      return null;
    }
  }
  return { paths };
}

export function collectReferenceDiscoveryResources(dependencies = {}) {
  const readSystemFile = dependencies.readSystemFile ?? defaultReadSystemFile;
  const meminfo = readSystemFile("/proc/meminfo", { maximum: 1024 * 1024 });
  const availableKb = meminfo.match(/^MemAvailable:\s+(0|[1-9][0-9]*)\s+kB\s*$/m)?.[1];
  if (availableKb === undefined) {
    fail("MemAvailable is unavailable", "REFERENCE_DISCOVERY_RESOURCE_INVALID");
  }
  const memAvailable = decimalBytes(availableKb, "MemAvailable") * 1024n;
  const cgroup = (dependencies.resolveCgroupV2Paths ?? resolvedCgroupV2Paths)(readSystemFile);
  let cgroupStatus = "unavailable";
  let current = null;
  let maximum = null;
  let cgroupHeadroom = null;
  if (cgroup !== null) {
    cgroupStatus = "resolved-unlimited";
    for (const cgroupPath of cgroup.paths) {
      const maximumText = oneLine(readSystemFile, path.join(cgroupPath, "memory.max"),
        `cgroup memory.max at ${cgroupPath}`, { optional: true });
      const atVisibleRoot = cgroupPath === cgroup.paths.at(-1);
      if (atVisibleRoot && maximumText !== null) {
        // The true cgroup-v2 hierarchy root has no memory.max. Seeing one at
        // the mounted root means a cgroup namespace or subtree hides ancestors.
        cgroupStatus = "unavailable";
        current = null;
        maximum = null;
        cgroupHeadroom = null;
        break;
      }
      if (maximumText === null) {
        if (atVisibleRoot) continue;
        cgroupStatus = "unavailable";
        current = null;
        maximum = null;
        cgroupHeadroom = null;
        break;
      }
      if (maximumText === "max") continue;
      const observedMaximum = decimalBytes(maximumText,
        `cgroup memory.max at ${cgroupPath}`);
      const currentText = oneLine(readSystemFile, path.join(cgroupPath, "memory.current"),
        `cgroup memory.current at ${cgroupPath}`, { optional: true });
      if (currentText === null) {
        cgroupStatus = "unavailable";
        current = null;
        maximum = null;
        cgroupHeadroom = null;
        break;
      }
      const observedCurrent = decimalBytes(currentText,
        `cgroup memory.current at ${cgroupPath}`);
      const observedHeadroom = observedMaximum > observedCurrent
        ? observedMaximum - observedCurrent : 0n;
      if (cgroupHeadroom === null || observedHeadroom < cgroupHeadroom) {
        cgroupStatus = "resolved-limited";
        current = observedCurrent;
        maximum = observedMaximum;
        cgroupHeadroom = observedHeadroom;
      }
    }
  }
  const effective = cgroupStatus === "unavailable" ? 0n :
    cgroupHeadroom === null || memAvailable < cgroupHeadroom ? memAvailable : cgroupHeadroom;
  return {
    memAvailableBytes: memAvailable.toString(),
    cgroupStatus,
    cgroupCurrentBytes: current?.toString() ?? null,
    cgroupMaxBytes: maximum?.toString() ?? null,
    effectiveHeadroomBytes: effective.toString(),
    minimumHeadroomBytes: REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES.toString(),
    meetsMinimum: effective >= REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES,
  };
}

function fileIdentity(filename, source, { version = false } = {}) {
  const canonical = realpathSync(filename);
  const stats = statSync(canonical);
  const current = {
    path: canonical,
    sha256: digestBytes(readFileSync(canonical)),
    bytes: String(stats.size),
    mode: stats.mode & 0o777,
  };
  if (source.path !== current.path || source.sha256 !== current.sha256 ||
      String(source.bytes) !== current.bytes) {
    fail(`observed executable identity changed for ${filename}`,
      "REFERENCE_DISCOVERY_IDENTITY_INVALID");
  }
  const result = {
    ...current,
  };
  return version ? { ...result, version: source.version } : result;
}

export function referenceDiscoveryReleaseFileIdentity(filename) {
  const canonical = realpathSync(filename);
  const bytes = readFileSync(canonical);
  const stats = statSync(canonical);
  return {
    path: canonical,
    sha256: digestBytes(bytes),
    bytes: String(bytes.length),
    mode: stats.mode & 0o777,
  };
}

export function referenceDiscoveryEnvironmentBindingKey(identity, host) {
  return createHash("sha256")
    .update("reference-discovery-environment-binding-v1\0")
    .update(identity.root).update("\0")
    .update(identity.releaseFile.sha256).update("\0")
    .update(host.bootIdSha256).update("\0")
    .update(host.machineSha256)
    .digest();
}

export function resolveReferenceDiscoveryWorkloads(layout, launchEnvironment, bindingKey) {
  const environment = { set: launchEnvironment };
  const resolverOptions = { environment: launchEnvironment, environmentBindingKey: bindingKey };
  const measured = resolveWorkloadSpec({
    version: 1,
    id: "reference-pglite-target-discovery",
    label: "Pinned PGlite reference discovery target",
    description: "One bounded PGlite SELECT 1 lifecycle on the frozen reference runtime.",
    risk: "high-memory",
    command: { executable: layout.targetNode, args: [layout.child], cwd: layout.app },
    environment,
    provenance: { completeness: "complete", files: [layout.child] },
    attempt: {
      mode: "exit",
      timeoutMs: REFERENCE_DISCOVERY_PROFILE.attemptTimeoutMs,
      termGraceMs: REFERENCE_DISCOVERY_PROFILE.termGraceMs,
      killGraceMs: REFERENCE_DISCOVERY_PROFILE.killGraceMs,
    },
    outcomes: REFERENCE_TARGET_OUTCOMES,
    capabilities: { isolated: true },
  }, resolverOptions);
  const auxiliary = resolveWorkloadSpec({
    version: 1,
    id: REFERENCE_DISCOVERY_CONDITION_ID,
    label: "Pinned guided yes load worker",
    description: "One managed yes process per load CPU during the bounded B leg.",
    risk: "disruptive",
    command: { executable: layout.yes, args: [], cwd: layout.root },
    environment,
    provenance: { completeness: "complete", files: [] },
    attempt: {
      mode: "survive-window",
      timeoutMs: 60 * 60 * 1_000,
      termGraceMs: REFERENCE_PROFILE.termGraceMs,
      killGraceMs: REFERENCE_PROFILE.killGraceMs,
    },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: {},
  }, resolverOptions);
  return Object.freeze({ measured, auxiliary });
}

export function collectReferenceDiscoveryIdentity(layout, observed, workloads, releaseFile) {
  const controllerRuntime = fileIdentity(layout.controllerNode, observed.executables.controller, {
    version: true,
  });
  const targetRuntime = fileIdentity(layout.targetNode, observed.executables.target, {
    version: true,
  });
  const taskset = fileIdentity(layout.taskset, observed.executables.taskset);
  const yes = fileIdentity(layout.yes, observed.executables.yes);
  const workloadTarget = workloads.measured.command.executable;
  const workloadYes = workloads.auxiliary.command.executable;
  if (JSON.stringify(targetRuntime, ["path", "sha256", "bytes", "mode"]) !==
      JSON.stringify(workloadTarget, ["path", "sha256", "bytes", "mode"]) ||
      JSON.stringify(yes) !== JSON.stringify(workloadYes)) {
    fail("resolved workload executable identity disagrees with the verified kit",
      "REFERENCE_DISCOVERY_IDENTITY_INVALID");
  }
  const workloadChildren = workloads.measured.provenance.files;
  if (workloadChildren.length !== 1 || workloadChildren[0].path !== observed.child.path ||
      workloadChildren[0].sha256 !== observed.child.sha256) {
    fail("resolved workload child identity disagrees with the verified kit",
      "REFERENCE_DISCOVERY_IDENTITY_INVALID");
  }
  const currentPglite = treeIdentity(realpathSync(layout.pglite));
  const currentApp = treeIdentity(realpathSync(layout.app));
  if (currentPglite.sha256 !== observed.pglite.sha256 ||
      currentApp.sha256 !== observed.app.sha256) {
    fail("packaged application tree changed while workloads were resolved",
      "REFERENCE_DISCOVERY_IDENTITY_INVALID");
  }
  return {
    kitRoot: layout.root,
    releaseFile,
    appTreeSha256: observed.app.sha256,
    pgliteTreeSha256: observed.pglite.sha256,
    controllerRuntime,
    targetRuntime,
    measuredWorkloadDigest: workloads.measured.digest,
    conditionWorkloadDigest: workloads.auxiliary.digest,
    taskset,
    yes,
  };
}

export function collectReferenceDiscoveryStorage(resultsRoot, outputName, dependencies = {}) {
  if (typeof resultsRoot !== "string" || resultsRoot.length === 0 ||
      resultsRoot.includes("\0") || Buffer.byteLength(resultsRoot) > 16 * 1024 ||
      !path.isAbsolute(resultsRoot)) {
    fail("results root must be a bounded absolute path");
  }
  if (typeof outputName !== "string" || !SAFE_OUTPUT_NAME_RE.test(outputName)) {
    fail("output name must be reference-discovery-YYYYMMDDTHHMMSSZ with an optional suffix");
  }
  let canonicalRoot;
  let stats;
  try {
    canonicalRoot = (dependencies.realpath ?? realpathSync)(resultsRoot);
    stats = (dependencies.stat ?? lstatSync)(canonicalRoot);
  } catch (error) {
    fail(`cannot inspect results root: ${error?.code ?? "unknown error"}`,
      "REFERENCE_DISCOVERY_STORAGE_INVALID");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink?.()) {
    fail("results root must be a canonical real directory");
  }
  const collectionDir = path.join(canonicalRoot, outputName);
  try {
    (dependencies.lstat ?? lstatSync)(collectionDir);
    fail("reference discovery collection already exists", "REFERENCE_DISCOVERY_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof ReferenceDiscoveryControllerError || error?.code !== "ENOENT") throw error;
  }
  const observed = (dependencies.inspectStorage ?? inspectOutputStorage)(canonicalRoot);
  const normalized = normalizeReferenceDiscoveryStorageObservation(observed);
  const { available, classification, supportsActiveState, warning } = normalized;
  return {
    resultsRoot: canonicalRoot,
    collectionDir,
    availableBytes: available.toString(),
    minimumRequiredBytes: REFERENCE_DISCOVERY_MINIMUM_RESULTS_BYTES.toString(),
    meetsMinimum: available >= REFERENCE_DISCOVERY_MINIMUM_RESULTS_BYTES,
    mountPoint: observed.mountPoint,
    filesystemType: observed.filesystemType,
    source: observed.source,
    classification,
    supportsActiveState,
    warning,
  };
}

function normalizeReferenceDiscoveryStorageObservation(observed) {
  if (typeof observed.availableBytes !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(observed.availableBytes) ||
      observed.availableBytes.length > 24) {
    fail("results storage returned an invalid capacity observation",
      "REFERENCE_DISCOVERY_STORAGE_INVALID");
  }
  const available = BigInt(observed.availableBytes);
  const classification = typeof observed.source === "string" &&
      EPHEMERAL_BLOCK_SOURCE_RE.test(observed.source)
    ? "unknown" : observed.classification;
  const supportsActiveState = observed.filesystemType !== null &&
    !NON_UNIX_FILESYSTEMS.has(observed.filesystemType);
  return {
    available,
    classification,
    supportsActiveState,
    warning: classification === "unknown" && observed.classification !== "unknown"
      ? UNKNOWN_STORAGE_WARNING : observed.warning,
  };
}

function defaultOutputName(now = new Date()) {
  return `${REFERENCE_DISCOVERY_OUTPUT_PREFIX}` +
    now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function planReferenceDiscovery({
  resultsRoot,
  outputName = defaultOutputName(),
  targetCpus,
  loadCpus,
} = {}, dependencies = {}) {
  validateReferenceHost(dependencies.host);
  const ambient = dependencies.environment ?? process.env;
  assertSafeAmbientEnvironment(ambient);
  const launchEnvironment = reviewedLaunchEnvironment(ambient);
  const topology = (dependencies.collectTopology ?? collectReferenceDiscoveryTopology)(dependencies);
  const host = (dependencies.collectHost ?? collectReferenceDiscoveryHost)(topology, dependencies);
  const layout = (dependencies.resolveLayout ?? resolveKitLayout)();
  const collectReleaseFileIdentity = dependencies.collectReleaseFileIdentity ??
    referenceDiscoveryReleaseFileIdentity;
  const releaseFileBefore = collectReleaseFileIdentity(layout.releaseFile);
  const observedIdentity = (dependencies.collectKitIdentity ?? collectReferenceKitIdentity)(layout);
  const releaseFileAfter = collectReleaseFileIdentity(layout.releaseFile);
  if (JSON.stringify(releaseFileBefore) !== JSON.stringify(releaseFileAfter)) {
    fail("release declaration changed while identity was collected",
      "REFERENCE_DISCOVERY_IDENTITY_INVALID");
  }
  const identityContext = {
    root: layout.root,
    releaseFile: releaseFileAfter,
  };
  const bindingKey = (dependencies.environmentBindingKey ??
    referenceDiscoveryEnvironmentBindingKey)(identityContext, host);
  if (!Buffer.isBuffer(bindingKey) || bindingKey.length < 32) {
    fail("environment binding key is invalid", "REFERENCE_DISCOVERY_IDENTITY_INVALID");
  }
  try {
    const workloads = (dependencies.resolveWorkloads ?? resolveReferenceDiscoveryWorkloads)(
      layout,
      launchEnvironment,
      bindingKey,
    );
    const identity = (dependencies.collectIdentity ?? collectReferenceDiscoveryIdentity)(
      layout,
      observedIdentity,
      workloads,
      releaseFileAfter,
    );
    const resources = (dependencies.collectResources ?? collectReferenceDiscoveryResources)(
      dependencies,
    );
    const storage = (dependencies.collectStorage ?? collectReferenceDiscoveryStorage)(
      resultsRoot,
      outputName,
      dependencies,
    );
    return buildReferenceDiscoveryPlan(topology, {
      ...(targetCpus === undefined ? {} : { targetCpus }),
      ...(loadCpus === undefined ? {} : { loadCpus }),
      identity,
      host,
      resources,
      storage,
    });
  } finally {
    bindingKey.fill(0);
  }
}

export function revalidateReferenceDiscoveryContext(planValue, dependencies = {}) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  validateReferenceHost(dependencies.host);
  const ambient = dependencies.environment ?? process.env;
  assertSafeAmbientEnvironment(ambient);
  const launchEnvironment = reviewedLaunchEnvironment(ambient);
  const topology = (dependencies.collectTopology ?? collectReferenceDiscoveryTopology)(dependencies);
  const host = (dependencies.collectHost ?? collectReferenceDiscoveryHost)(topology, dependencies);
  const layout = (dependencies.resolveLayout ?? resolveKitLayout)();
  const collectReleaseFileIdentity = dependencies.collectReleaseFileIdentity ??
    referenceDiscoveryReleaseFileIdentity;
  const releaseFileBefore = collectReleaseFileIdentity(layout.releaseFile);
  const observedIdentity = (dependencies.collectKitIdentity ?? collectReferenceKitIdentity)(layout);
  const releaseFileAfter = collectReleaseFileIdentity(layout.releaseFile);
  if (canonicalProtocolJson(releaseFileBefore) !== canonicalProtocolJson(releaseFileAfter)) {
    fail("release declaration changed while identity was revalidated",
      "REFERENCE_DISCOVERY_IDENTITY_INVALID");
  }
  const bindingKey = (dependencies.environmentBindingKey ??
    referenceDiscoveryEnvironmentBindingKey)({ root: layout.root, releaseFile: releaseFileAfter }, host);
  if (!Buffer.isBuffer(bindingKey) || bindingKey.length < 32) {
    fail("environment binding key is invalid", "REFERENCE_DISCOVERY_IDENTITY_INVALID");
  }
  try {
    const workloads = (dependencies.resolveWorkloads ?? resolveReferenceDiscoveryWorkloads)(
      layout,
      launchEnvironment,
      bindingKey,
    );
    const identity = (dependencies.collectIdentity ?? collectReferenceDiscoveryIdentity)(
      layout,
      observedIdentity,
      workloads,
      releaseFileAfter,
    );
    for (const [label, current, expected] of [
      ["CPU topology", topology, plan.topology],
      ["host identity", host, plan.host],
      ["kit/workload identity", identity, plan.identity],
    ]) {
      if (canonicalProtocolJson(current) !== canonicalProtocolJson(expected)) {
        fail(`reference discovery ${label} changed after preview`,
          "REFERENCE_DISCOVERY_PREVIEW_MISMATCH");
      }
    }
    return Object.freeze({ plan, layout, launchEnvironment, workloads });
  } finally {
    bindingKey.fill(0);
  }
}

export function revalidateReferenceDiscoveryExecution(planValue, dependencies = {}) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  if (!plan.resources.meetsMinimum || !plan.storage.meetsMinimum ||
      !plan.storage.supportsActiveState || plan.storage.classification !== "likely-persistent") {
    fail("reference discovery preview did not pass live resource and storage admission",
      "REFERENCE_DISCOVERY_ADMISSION_REFUSED");
  }
  const context = revalidateReferenceDiscoveryContext(plan, dependencies);
  const resources = (dependencies.collectResources ?? collectReferenceDiscoveryResources)(
    dependencies,
  );
  if (!resources.meetsMinimum) {
    fail("reference discovery memory headroom fell below the live minimum",
      "REFERENCE_DISCOVERY_RESOURCE_LOW");
  }
  const observedStorage = (dependencies.inspectStorage ?? inspectOutputStorage)(
    plan.storage.collectionDir,
  );
  const currentStorage = normalizeReferenceDiscoveryStorageObservation(observedStorage);
  if (currentStorage.available < REFERENCE_DISCOVERY_MINIMUM_RESULTS_BYTES) {
    fail("reference discovery storage fell below the live minimum",
      "REFERENCE_DISCOVERY_STORAGE_LOW");
  }
  const stableStorage = {
    mountPoint: observedStorage.mountPoint,
    filesystemType: observedStorage.filesystemType,
    source: observedStorage.source,
    classification: currentStorage.classification,
    supportsActiveState: currentStorage.supportsActiveState,
  };
  const plannedStorage = Object.fromEntries(Object.keys(stableStorage)
    .map((key) => [key, plan.storage[key]]));
  if (canonicalProtocolJson(stableStorage) !== canonicalProtocolJson(plannedStorage)) {
    fail("reference discovery results storage changed after preview",
      "REFERENCE_DISCOVERY_PREVIEW_MISMATCH");
  }
  return Object.freeze({ ...context, resources, storage: {
    ...stableStorage,
    availableBytes: currentStorage.available.toString(),
  } });
}

export function revalidateReferenceDiscoveryOwnerExecution(planValue, dependencies = {}) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  return revalidateReferenceDiscoveryExecution(plan, {
    ...dependencies,
    // taskset has deliberately reduced the owner to its controller CPU. Reuse
    // the immutable preview allowance while rereading online/cgroup/sysfs
    // state; the owner separately witnesses its actual singleton affinity.
    processAllowedCpuSpec: plan.topology.allowedCpus.join(","),
    requireResolvedCgroupCpuSet: true,
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function formatDuration(milliseconds) {
  const minutes = Math.ceil(milliseconds / 60_000);
  return minutes < 60 ? `${minutes} minutes` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function renderReferenceDiscoveryDryRun(planValue) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  const targetOrder = plan.schedule.sessions.map(({ targetCpu }) => targetCpu).join(", ");
  const roles = plan.schedule.sessions.map(({ targetCpu, controllerCpu }) =>
    `  target ${targetCpu} (controller ${controllerCpu})`);
  const previewBinding = referenceDiscoveryPreviewBinding(plan);
  const command = [
    "./bin/discover-reference",
    "--results-root", plan.storage.resultsRoot,
    "--output-name", path.basename(plan.storage.collectionDir),
    ...(plan.selection.mode === "explicit" ? [
      "--target-cpus", plan.selection.targetCpus.join(","),
      "--load-cpus", plan.selection.loadCpus.join(","),
    ] : []),
    "--expect-preview", previewBinding.sha256,
    "--yes",
  ].map(shellQuote).join(" ");
  const ready = plan.resources.meetsMinimum && plan.storage.meetsMinimum &&
    plan.storage.supportsActiveState && plan.storage.classification === "likely-persistent";
  return [
    "Fault Affinity guided reference screen — dry run",
    "",
    `Mode: ${plan.selection.mode === "automatic-hybrid" ? "automatic hybrid CPU selection" : "explicit CPU roles"}`,
    `Target order: ${targetOrder}`,
    `Fixed load CPUs: ${plan.selection.loadCpus.join(", ")}`,
    "Measured concurrency: 1 PGlite process at a time",
    `Schedule: ${plan.profile.attemptsPerLeg} attempts in each A1 / B / A2 leg per target`,
    `Worst-case bound: ${formatDuration(referenceDiscoveryWorstCaseMs(plan))}`,
    `Results: ${plan.storage.collectionDir}`,
    `Observed memory headroom: ${plan.resources.effectiveHeadroomBytes} bytes`,
    ...(plan.storage.warning === null ? [] : [plan.storage.warning]),
    "",
    "Planned sessions:",
    ...roles,
    "",
    "Nothing was executed and no result directory was created.",
    ...(ready ? ["", "To run this exact selection (the live check must match this preview):",
      "", command] : [
      "",
      "No --yes command is shown until storage is persistent Unix media and the memory/disk checks pass.",
    ]),
    "",
  ].join("\n");
}
