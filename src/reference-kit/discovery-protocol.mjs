import { createHash } from "node:crypto";
import path from "node:path";

import {
  controlledLoadSessionEnvelopeBinding,
} from "../../diagnose-lib/controlled-load-session.mjs";
import { canonicalProtocolJson } from "../../diagnose-lib/pinned-protocol.mjs";
import { MAX_CPU_ID, MAX_SEED } from "../../diagnose-lib/pinned-runner.mjs";
import {
  readSchema3Bundle,
  schema3BundleManifestBinding,
} from "../../diagnose-lib/schema3-bundle.mjs";
import { verifyWorkloadProvenance } from "../../diagnose-lib/workload-spec.mjs";

export const REFERENCE_DISCOVERY_PLAN_VERSION = 1;
export const REFERENCE_DISCOVERY_REPORT_VERSION = 1;
export const REFERENCE_DISCOVERY_HISTORY_VERSION = 1;
export const REFERENCE_DISCOVERY_PROTOCOL = "reference-loaded-discovery-v1";
export const REFERENCE_DISCOVERY_INTERPRETATION_VERSION = 1;
export const REFERENCE_DISCOVERY_MAX_TARGETS = 32;
export const REFERENCE_DISCOVERY_MAX_WORKERS = 64;
export const REFERENCE_DISCOVERY_MAX_HISTORY_GENERATIONS = 64;
export const REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES = 2n * 1024n * 1024n * 1024n;

export const REFERENCE_DISCOVERY_PROFILE = Object.freeze({
  id: "reference-loaded-discovery",
  version: 1,
  schedule: "quick",
  attemptsPerLeg: 3,
  warmupMs: 0,
  recoveryMs: 5_000,
  attemptTimeoutMs: 120_000,
  termGraceMs: 1_000,
  killGraceMs: 2_000,
  seed: 17,
});

const TARGET_ORDER_ALGORITHM = "sha256-seeded-target-order-v1";
const CONTROLLER_ORDER_ALGORITHM = "sha256-seeded-reference-controller-order-v1";
const DIGEST_RE = /^[0-9a-f]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const CORE_ID_RE = /^(0|[1-9][0-9]{0,9})$/;
const TARGET_CATEGORIES = new Set(["target-fault", "corruption"]);
const CLASS_SOURCES = new Set(["sysfs-hybrid", "unavailable", "partial"]);
const HISTORY_REASONS = new Set([
  "committed", "complete", "operational-invalid", "external-cancel", "owner-error",
  "runner-error", "evidence-invalid", "condition-invalid", "envelope-invalid",
  "reconciled-interruption",
]);
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const AUTHORITATIVE_CHILDREN = new WeakMap();
const GENERATED_REPORTS = new WeakSet();

export class ReferenceDiscoveryProtocolError extends Error {
  constructor(message, code = "INVALID_REFERENCE_DISCOVERY_PROTOCOL") {
    super(message);
    this.name = "ReferenceDiscoveryProtocolError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ReferenceDiscoveryProtocolError(message, code);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length ||
      actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function boundedString(value, label, maximum = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      Buffer.byteLength(value) > maximum) {
    fail(`${label} must be a nonempty bounded NUL-free string`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function uintString(value, label) {
  if (typeof value !== "string" || !UINT_RE.test(value) || value.length > 24) {
    fail(`${label} must be a canonical bounded unsigned integer string`);
  }
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function union(...lists) {
  return sortedUnique(lists.flat());
}

function intersection(left, right) {
  const wanted = new Set(right);
  return left.filter((value) => wanted.has(value));
}

function cpuList(value, label, { maximum = MAX_CPU_ID + 1, empty = false } = {}) {
  if (!Array.isArray(value) || (!empty && value.length === 0) || value.length > maximum) {
    fail(`${label} must contain ${empty ? "zero through" : "one through"} ${maximum} CPUs`);
  }
  const result = value.map((cpu, index) => integer(cpu, `${label}[${index}]`, 0, MAX_CPU_ID));
  if (result.some((cpu, index) => index > 0 && cpu <= result[index - 1])) {
    fail(`${label} must be strictly increasing`);
  }
  return result;
}

function parseFileIdentity(value, label, { version = false } = {}) {
  exactKeys(value, version ? ["path", "sha256", "bytes", "mode", "version"] :
    ["path", "sha256", "bytes", "mode"], label);
  const filePath = boundedString(value.path, `${label}.path`);
  if (!path.isAbsolute(filePath)) fail(`${label}.path must be absolute`);
  digest(value.sha256, `${label}.sha256`);
  uintString(value.bytes, `${label}.bytes`);
  integer(value.mode, `${label}.mode`, 0, 0o777);
  if (version) boundedString(value.version, `${label}.version`, 64);
  return {
    path: filePath,
    sha256: value.sha256,
    bytes: value.bytes,
    mode: value.mode,
    ...(version ? { version: value.version } : {}),
  };
}

export function parseReferenceDiscoveryTopology(value) {
  exactKeys(value, ["onlineCpus", "allowedCpus", "usableCpus", "classes", "cores"],
    "reference discovery topology");
  const onlineCpus = cpuList(value.onlineCpus, "reference discovery online CPUs");
  const allowedCpus = cpuList(value.allowedCpus, "reference discovery allowed CPUs");
  const usableCpus = cpuList(value.usableCpus, "reference discovery usable CPUs");
  const expectedUsable = intersection(onlineCpus, allowedCpus);
  if (!sameList(usableCpus, expectedUsable)) {
    fail("reference discovery usable CPUs must equal online/allowed intersection");
  }

  exactKeys(value.classes, ["source", "performanceCpus", "efficientCpus"],
    "reference discovery classes");
  if (!CLASS_SOURCES.has(value.classes.source)) {
    fail("reference discovery class source is unsupported");
  }
  const performanceCpus = cpuList(value.classes.performanceCpus,
    "reference discovery performance CPUs", { empty: true });
  const efficientCpus = cpuList(value.classes.efficientCpus,
    "reference discovery efficient CPUs", { empty: true });
  if (performanceCpus.some((cpu) => efficientCpus.includes(cpu)) ||
      union(performanceCpus, efficientCpus).some((cpu) => !usableCpus.includes(cpu))) {
    fail("reference discovery class masks overlap or contain unusable CPUs");
  }
  const classified = union(performanceCpus, efficientCpus);
  if (value.classes.source === "sysfs-hybrid" &&
      (performanceCpus.length === 0 || efficientCpus.length === 0 ||
        !sameList(classified, usableCpus))) {
    fail("sysfs-hybrid classes must be nonempty and cover every usable CPU");
  }
  if (value.classes.source === "unavailable" && classified.length !== 0) {
    fail("unavailable classes must have empty CPU masks");
  }
  if (value.classes.source === "partial" && performanceCpus.length > 0 &&
      efficientCpus.length > 0 && sameList(classified, usableCpus)) {
    fail("partial classes must preserve observations that do not establish both complete classes");
  }

  if (!Array.isArray(value.cores) || value.cores.length === 0 ||
      value.cores.length > usableCpus.length) {
    fail("reference discovery cores must be a bounded nonempty array");
  }
  const coreKeys = new Set();
  const covered = [];
  let priorRepresentative = -1;
  const cores = value.cores.map((core, index) => {
    exactKeys(core, ["packageId", "coreId", "cpus"],
      `reference discovery core ${index + 1}`);
    if (typeof core.packageId !== "string" || !CORE_ID_RE.test(core.packageId) ||
        typeof core.coreId !== "string" || !CORE_ID_RE.test(core.coreId)) {
      fail(`reference discovery core ${index + 1} identifiers are invalid`);
    }
    const cpus = cpuList(core.cpus, `reference discovery core ${index + 1} CPUs`);
    if (cpus.some((cpu) => !usableCpus.includes(cpu)) || cpus[0] <= priorRepresentative) {
      fail("reference discovery cores must contain usable CPUs in representative order");
    }
    priorRepresentative = cpus[0];
    const key = `${core.packageId}:${core.coreId}`;
    if (coreKeys.has(key)) fail("reference discovery physical core is duplicated");
    coreKeys.add(key);
    covered.push(...cpus);
    return { packageId: core.packageId, coreId: core.coreId, cpus };
  });
  if (!sameList(sortedUnique(covered), usableCpus) || covered.length !== usableCpus.length) {
    fail("reference discovery physical cores must cover each usable CPU exactly once");
  }
  if (value.classes.source === "sysfs-hybrid" && cores.some((core) =>
    core.cpus.some((cpu) => performanceCpus.includes(cpu)) &&
    core.cpus.some((cpu) => efficientCpus.includes(cpu)))) {
    fail("reference discovery physical cores cannot mix P-core and E-core classes");
  }
  return deepFreeze({
    onlineCpus,
    allowedCpus,
    usableCpus,
    classes: { source: value.classes.source, performanceCpus, efficientCpus },
    cores,
  });
}

function parseIdentity(value) {
  exactKeys(value, [
    "kitRoot", "releaseFile", "appTreeSha256", "pgliteTreeSha256",
    "controllerRuntime", "targetRuntime", "measuredWorkloadDigest",
    "conditionWorkloadDigest", "taskset", "yes",
  ], "reference discovery identity");
  const kitRoot = boundedString(value.kitRoot, "reference discovery identity.kitRoot");
  if (!path.isAbsolute(kitRoot)) fail("reference discovery kit root must be absolute");
  const releaseFile = parseFileIdentity(value.releaseFile,
    "reference discovery release file");
  const controllerRuntime = parseFileIdentity(value.controllerRuntime,
    "reference discovery controller runtime", { version: true });
  const targetRuntime = parseFileIdentity(value.targetRuntime,
    "reference discovery target runtime", { version: true });
  const taskset = parseFileIdentity(value.taskset, "reference discovery taskset");
  const yes = parseFileIdentity(value.yes, "reference discovery yes");
  if (controllerRuntime.version !== "v24.21.0" || targetRuntime.version !== "v25.2.1") {
    fail("reference discovery runtime versions do not match the frozen profile");
  }
  if (taskset.path !== "/usr/bin/taskset" || yes.path !== "/usr/bin/yes") {
    fail("reference discovery system executable paths do not match the protocol");
  }
  for (const [record, label] of [
    [controllerRuntime, "controller runtime"], [targetRuntime, "target runtime"],
    [taskset, "taskset"], [yes, "yes"],
  ]) {
    if ((record.mode & 0o111) === 0) fail(`reference discovery ${label} is not executable`);
  }
  for (const [record, label] of [
    [releaseFile, "release file"],
    [controllerRuntime, "controller runtime"],
    [targetRuntime, "target runtime"],
  ]) {
    const relative = path.relative(kitRoot, record.path);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      fail(`reference discovery ${label} must be below the kit root`);
    }
  }
  return deepFreeze({
    kitRoot,
    releaseFile,
    appTreeSha256: digest(value.appTreeSha256, "reference discovery app tree"),
    pgliteTreeSha256: digest(value.pgliteTreeSha256, "reference discovery PGlite tree"),
    controllerRuntime,
    targetRuntime,
    measuredWorkloadDigest: digest(value.measuredWorkloadDigest,
      "reference discovery measured workload"),
    conditionWorkloadDigest: digest(value.conditionWorkloadDigest,
      "reference discovery condition workload"),
    taskset,
    yes,
  });
}

function parseHost(value, usableCpus) {
  exactKeys(value, [
    "bootIdSha256", "machineSha256", "kernelRelease", "osReleaseSha256",
    "powerPolicySha256", "microcode",
  ], "reference discovery host");
  digest(value.bootIdSha256, "reference discovery boot ID");
  digest(value.machineSha256, "reference discovery machine identity");
  boundedString(value.kernelRelease, "reference discovery kernel release", 256);
  digest(value.osReleaseSha256, "reference discovery OS release");
  if (value.powerPolicySha256 !== null) {
    digest(value.powerPolicySha256, "reference discovery power policy");
  }
  if (!Array.isArray(value.microcode) || value.microcode.length !== usableCpus.length) {
    fail("reference discovery microcode must cover every usable CPU");
  }
  const microcode = value.microcode.map((record, index) => {
    exactKeys(record, ["cpu", "value"], `reference discovery microcode ${index + 1}`);
    if (record.cpu !== usableCpus[index] ||
        !(record.value === null || (typeof record.value === "string" &&
          record.value.length > 0 && record.value.length <= 64 && !record.value.includes("\0")))) {
      fail("reference discovery microcode records are invalid or out of order");
    }
    return { cpu: record.cpu, value: record.value };
  });
  return deepFreeze({
    bootIdSha256: value.bootIdSha256,
    machineSha256: value.machineSha256,
    kernelRelease: value.kernelRelease,
    osReleaseSha256: value.osReleaseSha256,
    powerPolicySha256: value.powerPolicySha256,
    microcode,
  });
}

function parseResources(value) {
  exactKeys(value, [
    "memAvailableBytes", "cgroupCurrentBytes", "cgroupMaxBytes",
    "effectiveHeadroomBytes", "minimumHeadroomBytes", "meetsMinimum",
  ], "reference discovery resources");
  const memAvailable = BigInt(uintString(value.memAvailableBytes,
    "reference discovery MemAvailable"));
  const current = value.cgroupCurrentBytes === null ? null :
    BigInt(uintString(value.cgroupCurrentBytes, "reference discovery cgroup current"));
  const maximum = value.cgroupMaxBytes === null ? null :
    BigInt(uintString(value.cgroupMaxBytes, "reference discovery cgroup maximum"));
  if ((maximum !== null && current === null) ||
      (current !== null && maximum !== null && current > maximum)) {
    fail("reference discovery cgroup memory observation is inconsistent");
  }
  const expectedHeadroom = maximum === null ? memAvailable :
    (memAvailable < maximum - current ? memAvailable : maximum - current);
  const effective = BigInt(uintString(value.effectiveHeadroomBytes,
    "reference discovery effective headroom"));
  const minimum = BigInt(uintString(value.minimumHeadroomBytes,
    "reference discovery minimum headroom"));
  if (effective !== expectedHeadroom || minimum !== REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES ||
      typeof value.meetsMinimum !== "boolean" ||
      value.meetsMinimum !== (effective >= minimum)) {
    fail("reference discovery effective memory headroom is inconsistent");
  }
  return deepFreeze({
    memAvailableBytes: memAvailable.toString(),
    cgroupCurrentBytes: current?.toString() ?? null,
    cgroupMaxBytes: maximum?.toString() ?? null,
    effectiveHeadroomBytes: effective.toString(),
    minimumHeadroomBytes: minimum.toString(),
    meetsMinimum: value.meetsMinimum,
  });
}

function orderBySeed(values, seed, algorithm, domain = null) {
  return [...values].sort((left, right) => {
    const valueDigest = (cpu) => createHash("sha256")
      .update(domain === null
        ? `${algorithm}\n${seed}\n${cpu}\n`
        : `${algorithm}\n${domain}\n${seed}\n${cpu}\n`)
      .digest("hex");
    return valueDigest(left).localeCompare(valueDigest(right)) || left - right;
  });
}

function coreByCpu(topology) {
  return new Map(topology.cores.flatMap((core) => core.cpus.map((cpu) => [cpu, core])));
}

function sessionDirectory(cpu) {
  return `cpu-${String(cpu).padStart(5, "0")}`;
}

function buildSessions(topology, targets, workers, seed, automatic) {
  const byCpu = coreByCpu(topology);
  const workerCoreKeys = new Set(workers.map((cpu) => {
    const core = byCpu.get(cpu);
    return `${core.packageId}:${core.coreId}`;
  }));
  const orderedTargets = orderBySeed(targets, seed, TARGET_ORDER_ALGORITHM);
  return orderedTargets.map((targetCpu, index) => {
    const targetCore = byCpu.get(targetCpu);
    const targetKey = `${targetCore.packageId}:${targetCore.coreId}`;
    if (workerCoreKeys.has(targetKey)) {
      fail(`target CPU ${targetCpu} shares a physical core with the load set`);
    }
    const representatives = topology.cores.filter((core) => {
      const key = `${core.packageId}:${core.coreId}`;
      if (key === targetKey || workerCoreKeys.has(key)) return false;
      return !automatic || core.cpus.some((cpu) => topology.classes.efficientCpus.includes(cpu));
    }).map((core) => core.cpus[0]);
    if (representatives.length === 0) {
      fail(`target CPU ${targetCpu} leaves no independent controller physical core`);
    }
    const controllers = orderBySeed(representatives, seed,
      CONTROLLER_ORDER_ALGORITHM, "controller");
    return {
      ordinal: index + 1,
      targetCpu,
      controllerCpu: controllers[index % controllers.length],
      directory: sessionDirectory(targetCpu),
    };
  });
}

function parseProfile(value) {
  exactKeys(value, Object.keys(REFERENCE_DISCOVERY_PROFILE), "reference discovery profile");
  if (canonicalProtocolJson(value) !== canonicalProtocolJson(REFERENCE_DISCOVERY_PROFILE)) {
    fail("reference discovery profile does not match the immutable quick schedule");
  }
  return { ...REFERENCE_DISCOVERY_PROFILE };
}

function parsePlanSelection(value, topology) {
  exactKeys(value, ["mode", "targetCpus", "loadCpus"], "reference discovery selection");
  if (!new Set(["automatic-hybrid", "explicit"]).has(value.mode)) {
    fail("reference discovery selection mode is unsupported");
  }
  const targetCpus = cpuList(value.targetCpus, "reference discovery target CPUs", {
    maximum: REFERENCE_DISCOVERY_MAX_TARGETS,
  });
  const loadCpus = cpuList(value.loadCpus, "reference discovery load CPUs", {
    maximum: REFERENCE_DISCOVERY_MAX_WORKERS,
  });
  if ([...targetCpus, ...loadCpus].some((cpu) => !topology.usableCpus.includes(cpu)) ||
      targetCpus.some((cpu) => loadCpus.includes(cpu))) {
    fail("reference discovery target/load CPUs overlap or contain unusable CPUs");
  }
  if (value.mode === "automatic-hybrid" &&
      (topology.classes.source !== "sysfs-hybrid" ||
        !sameList(targetCpus, topology.classes.efficientCpus) ||
        !sameList(loadCpus, topology.classes.performanceCpus))) {
    fail("automatic reference discovery must use every E-core target and P-core worker");
  }
  return { mode: value.mode, targetCpus, loadCpus };
}

export function buildReferenceDiscoveryPlan(topologyValue, {
  targetCpus,
  loadCpus,
  identity,
  host,
  resources,
} = {}) {
  const topology = parseReferenceDiscoveryTopology(topologyValue);
  const automatic = targetCpus === undefined && loadCpus === undefined;
  if ((targetCpus === undefined) !== (loadCpus === undefined)) {
    fail("reference discovery target and load CPUs must be supplied together");
  }
  if (automatic && topology.classes.source !== "sysfs-hybrid") {
    fail("automatic reference discovery requires complete sysfs hybrid classes");
  }
  const targets = cpuList(sortedUnique(targetCpus ?? topology.classes.efficientCpus),
    "reference discovery target CPUs", { maximum: REFERENCE_DISCOVERY_MAX_TARGETS });
  const workers = cpuList(sortedUnique(loadCpus ?? topology.classes.performanceCpus),
    "reference discovery load CPUs", { maximum: REFERENCE_DISCOVERY_MAX_WORKERS });
  if ([...targets, ...workers].some((cpu) => !topology.usableCpus.includes(cpu)) ||
      targets.some((cpu) => workers.includes(cpu))) {
    fail("reference discovery target/load CPUs overlap or contain unusable CPUs");
  }
  const selection = {
    mode: automatic ? "automatic-hybrid" : "explicit",
    targetCpus: targets,
    loadCpus: workers,
  };
  const sessions = buildSessions(topology, targets, workers,
    REFERENCE_DISCOVERY_PROFILE.seed, automatic);
  return parseReferenceDiscoveryPlan({
    version: REFERENCE_DISCOVERY_PLAN_VERSION,
    protocol: REFERENCE_DISCOVERY_PROTOCOL,
    interpretationVersion: REFERENCE_DISCOVERY_INTERPRETATION_VERSION,
    profile: { ...REFERENCE_DISCOVERY_PROFILE },
    identity,
    host,
    resources,
    topology,
    selection,
    schedule: {
      targetOrderAlgorithm: TARGET_ORDER_ALGORITHM,
      controllerOrderAlgorithm: CONTROLLER_ORDER_ALGORITHM,
      sessions,
    },
  });
}

export function parseReferenceDiscoveryPlan(value) {
  exactKeys(value, [
    "version", "protocol", "interpretationVersion", "profile", "identity", "host",
    "resources", "topology", "selection", "schedule",
  ], "reference discovery plan");
  if (value.version !== REFERENCE_DISCOVERY_PLAN_VERSION ||
      value.protocol !== REFERENCE_DISCOVERY_PROTOCOL ||
      value.interpretationVersion !== REFERENCE_DISCOVERY_INTERPRETATION_VERSION) {
    fail("reference discovery plan version or protocol is unsupported");
  }
  const profile = parseProfile(value.profile);
  const identity = parseIdentity(value.identity);
  const topology = parseReferenceDiscoveryTopology(value.topology);
  const host = parseHost(value.host, topology.usableCpus);
  const resources = parseResources(value.resources);
  const selection = parsePlanSelection(value.selection, topology);
  exactKeys(value.schedule, [
    "targetOrderAlgorithm", "controllerOrderAlgorithm", "sessions",
  ], "reference discovery schedule");
  if (value.schedule.targetOrderAlgorithm !== TARGET_ORDER_ALGORITHM ||
      value.schedule.controllerOrderAlgorithm !== CONTROLLER_ORDER_ALGORITHM) {
    fail("reference discovery ordering algorithm is unsupported");
  }
  if (!Array.isArray(value.schedule.sessions) ||
      value.schedule.sessions.length !== selection.targetCpus.length) {
    fail("reference discovery sessions must cover every target exactly once");
  }
  const expected = buildSessions(topology, selection.targetCpus, selection.loadCpus,
    profile.seed, selection.mode === "automatic-hybrid");
  const sessions = value.schedule.sessions.map((session, index) => {
    exactKeys(session, ["ordinal", "targetCpu", "controllerCpu", "directory"],
      `reference discovery session ${index + 1}`);
    if (canonicalProtocolJson(session) !== canonicalProtocolJson(expected[index])) {
      fail(`reference discovery session ${index + 1} does not match its deterministic plan`);
    }
    return { ...expected[index] };
  });
  return deepFreeze({
    version: value.version,
    protocol: value.protocol,
    interpretationVersion: value.interpretationVersion,
    profile,
    identity,
    host,
    resources,
    topology,
    selection,
    schedule: {
      targetOrderAlgorithm: value.schedule.targetOrderAlgorithm,
      controllerOrderAlgorithm: value.schedule.controllerOrderAlgorithm,
      sessions,
    },
  });
}

export function canonicalReferenceDiscoveryPlanLine(plan) {
  return Buffer.from(`${canonicalProtocolJson(parseReferenceDiscoveryPlan(plan))}\n`, "utf8");
}

export function referenceDiscoveryPlanBinding(plan) {
  const bytes = canonicalReferenceDiscoveryPlanLine(plan);
  return deepFreeze({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length.toString(),
  });
}

export function referenceDiscoveryWorstCaseMs(planValue) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  const attemptWindow = plan.profile.attemptTimeoutMs + plan.profile.termGraceMs +
    plan.profile.killGraceMs;
  return plan.schedule.sessions.length *
    (3 * plan.profile.attemptsPerLeg * attemptWindow + plan.profile.warmupMs +
      plan.profile.recoveryMs);
}

function parseHistoryRecord(value, index) {
  const label = `reference discovery history record ${index + 1}`;
  plainObject(value, label);
  if (value.type === "start") {
    exactKeys(value, [
      "version", "type", "generation", "sessionOrdinal", "targetCpu",
      "bootIdSha256", "unixMs",
    ], label);
  } else if (value.type === "terminal") {
    exactKeys(value, [
      "version", "type", "generation", "sessionOrdinal", "targetCpu",
      "bootIdSha256", "unixMs", "committed", "reason", "stage", "errorCode",
      "controllerCpu", "controllerAllowedCpuList",
    ], label);
  } else {
    fail(`${label} type is unsupported`);
  }
  if (value.version !== REFERENCE_DISCOVERY_HISTORY_VERSION) {
    fail(`${label} version is unsupported`);
  }
  integer(value.generation, `${label}.generation`, 1,
    REFERENCE_DISCOVERY_MAX_HISTORY_GENERATIONS);
  integer(value.sessionOrdinal, `${label}.sessionOrdinal`, 1,
    REFERENCE_DISCOVERY_MAX_TARGETS);
  integer(value.targetCpu, `${label}.targetCpu`, 0, MAX_CPU_ID);
  digest(value.bootIdSha256, `${label}.bootIdSha256`);
  integer(value.unixMs, `${label}.unixMs`, 0, Number.MAX_SAFE_INTEGER);
  if (value.type === "terminal") {
    const controllerAffinityValid =
      (value.controllerCpu === null && value.controllerAllowedCpuList === null) ||
      (Number.isSafeInteger(value.controllerCpu) && value.controllerCpu >= 0 &&
        value.controllerCpu <= MAX_CPU_ID &&
        value.controllerAllowedCpuList === String(value.controllerCpu));
    if (typeof value.committed !== "boolean" || !HISTORY_REASONS.has(value.reason) ||
        value.committed !== (value.reason === "committed") ||
        !(value.stage === null || (typeof value.stage === "string" &&
          value.stage.length > 0 && value.stage.length <= 64)) ||
        !(value.errorCode === null || (typeof value.errorCode === "string" &&
          ERROR_CODE_RE.test(value.errorCode))) ||
        !controllerAffinityValid) {
      fail(`${label} terminal fields are invalid`);
    }
    if (value.committed && value.controllerCpu === null) {
      fail(`${label} committed owner affinity is invalid`);
    }
  }
  return { ...value };
}

export function parseReferenceDiscoveryHistory(planValue, value) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  if (!Array.isArray(value) || value.length > 2 * REFERENCE_DISCOVERY_MAX_HISTORY_GENERATIONS) {
    fail("reference discovery history must be a bounded array");
  }
  const records = value.map(parseHistoryRecord);
  const sessions = new Map(plan.schedule.sessions.map((session) => [session.ordinal, session]));
  let expectedGeneration = 1;
  let open = null;
  let contaminated = false;
  let currentSessionOrdinal = 0;
  const committedSessions = new Set();
  const generations = [];
  for (const record of records) {
    const session = sessions.get(record.sessionOrdinal);
    if (session === undefined || session.targetCpu !== record.targetCpu ||
        record.bootIdSha256 !== plan.host.bootIdSha256) {
      fail("reference discovery history record does not match its plan or boot");
    }
    if (record.type === "terminal" && record.controllerCpu !== null &&
        record.controllerCpu !== session.controllerCpu) {
      fail("reference discovery owner affinity does not match its planned controller");
    }
    if (record.type === "start") {
      if (open !== null || record.generation !== expectedGeneration) {
        fail("reference discovery history starts a noncanonical generation");
      }
      if (record.sessionOrdinal < currentSessionOrdinal ||
          record.sessionOrdinal > currentSessionOrdinal + 1 ||
          committedSessions.has(record.sessionOrdinal)) {
        fail("reference discovery history does not follow the planned session order");
      }
      currentSessionOrdinal = record.sessionOrdinal;
      open = record;
    } else {
      if (open === null || record.generation !== open.generation ||
          record.sessionOrdinal !== open.sessionOrdinal || record.targetCpu !== open.targetCpu ||
          record.unixMs < open.unixMs) {
        fail("reference discovery history terminal does not close its start record");
      }
      generations.push({ start: open, terminal: record });
      if (!record.committed) contaminated = true;
      else committedSessions.add(record.sessionOrdinal);
      open = null;
      expectedGeneration += 1;
    }
  }
  if (open !== null) {
    generations.push({ start: open, terminal: null });
    contaminated = true;
  }
  return deepFreeze({
    records,
    generations,
    contaminated,
    committedSessionOrdinals: [...committedSessions].sort((left, right) => left - right),
    nextGeneration: expectedGeneration + (open === null ? 0 : 1),
    exhausted: expectedGeneration + (open === null ? 0 : 1) >
      REFERENCE_DISCOVERY_MAX_HISTORY_GENERATIONS,
  });
}

function referenceDiscoveryHistoryBinding(records) {
  const bytes = Buffer.from(records.map((record) => `${canonicalProtocolJson(record)}\n`).join(""),
    "utf8");
  return deepFreeze({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length.toString(),
  });
}

function parseArtifactBinding(value, label) {
  exactKeys(value, ["sha256", "bytes"], label);
  digest(value.sha256, `${label}.sha256`);
  uintString(value.bytes, `${label}.bytes`);
  return { sha256: value.sha256, bytes: value.bytes };
}

function outcomeStats(evidences, attemptsPerLeg) {
  if (!Array.isArray(evidences) || evidences.length > attemptsPerLeg) {
    fail("reference discovery leg evidence is invalid or oversized");
  }
  const result = { target: 0, pass: 0, other: 0, invalid: 0, usable: 0, total: evidences.length };
  for (const evidence of evidences) {
    const outcome = evidence?.outcome;
    if (outcome?.validOutcome !== true) result.invalid += 1;
    else if (TARGET_CATEGORIES.has(outcome.category)) result.target += 1;
    else if (outcome.category === "pass") result.pass += 1;
    else result.other += 1;
  }
  result.usable = result.target + result.pass;
  const eligible = result.total === attemptsPerLeg && result.usable === attemptsPerLeg &&
    result.other === 0 && result.invalid === 0;
  return { ...result, rate: result.usable === 0 ? null : result.target / result.usable, eligible };
}

function artifactBindingStrings(value) {
  return {
    sha256: value.sha256,
    bytes: String(value.bytes),
  };
}

function assertReferenceDiscoveryChildBundle(plan, session, bundle) {
  const controlled = bundle.controlledLoad;
  const exact = bundle.exactCpu;
  if (bundle.manifest.version !== 5 || controlled === undefined || exact === undefined ||
      controlled.manifest.execution.targetCpu !== session.targetCpu ||
      !sameList(controlled.manifest.execution.workerCpus, plan.selection.loadCpus) ||
      controlled.manifest.execution.tasksetPath !== plan.identity.taskset.path ||
      controlled.manifest.schedule.attemptsPerLeg !== plan.profile.attemptsPerLeg ||
      controlled.manifest.schedule.warmupMs !== plan.profile.warmupMs ||
      controlled.manifest.schedule.recoveryMs !== plan.profile.recoveryMs ||
      !sameList(exact.manifest.schedule.cpus, [session.targetCpu]) ||
      exact.manifest.schedule.rounds !== 1 ||
      exact.manifest.schedule.seed !== plan.profile.seed ||
      exact.manifest.execution.tasksetPath !== plan.identity.taskset.path ||
      exact.progress.status !== "empty" || exact.progress.committedAttempts !== 0) {
    fail(`reference discovery child for CPU ${session.targetCpu} does not match its plan`);
  }
}

export async function readReferenceDiscoveryChild({
  plan: planValue,
  sessionOrdinal,
  resolved,
  auxiliary,
  bundleDir,
  flockPath,
}) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  const ordinal = integer(sessionOrdinal, "reference discovery child session ordinal", 1,
    plan.schedule.sessions.length);
  const session = plan.schedule.sessions[ordinal - 1];
  if (resolved?.digest !== plan.identity.measuredWorkloadDigest ||
      auxiliary?.digest !== plan.identity.conditionWorkloadDigest) {
    fail("reference discovery child workloads do not match the plan");
  }
  verifyWorkloadProvenance(resolved);
  verifyWorkloadProvenance(auxiliary);
  if (typeof bundleDir !== "string" || !path.isAbsolute(bundleDir) ||
      path.basename(path.normalize(bundleDir)) !== session.directory) {
    fail("reference discovery child directory does not match the planned session");
  }
  const bundle = await readSchema3Bundle({
    resolved,
    auxiliary,
    bundleDir,
    ...(flockPath === undefined ? {} : { flockPath }),
  });
  assertReferenceDiscoveryChildBundle(plan, session, bundle);
  const complete = bundle.controlledLoad.progress.complete;
  if (complete !== (bundle.controlledLoad.envelope !== null)) {
    fail(`reference discovery child for CPU ${session.targetCpu} has inconsistent completion`);
  }
  const envelope = bundle.controlledLoad.envelope;
  const child = deepFreeze({
    targetCpu: session.targetCpu,
    controllerCpu: session.controllerCpu,
    complete,
    manifest: artifactBindingStrings(schema3BundleManifestBinding(
      resolved,
      bundle.manifest,
      auxiliary,
    )),
    envelope: envelope === null ? null : artifactBindingStrings(
      controlledLoadSessionEnvelopeBinding(
        resolved,
        auxiliary,
        bundle.controlledLoad.manifest,
        envelope,
      ),
    ),
    legs: envelope === null ? { a1: [], b: [], a2: [] } : Object.fromEntries(
      envelope.legs.map((leg) => [leg.leg, leg.attempts.map((attempt) => attempt.evidence)]),
    ),
  });
  AUTHORITATIVE_CHILDREN.set(child, Object.freeze({
    plan: canonicalProtocolJson(plan),
    sessionOrdinal: ordinal,
  }));
  return child;
}

function parseReportChild(plan, value, session, index) {
  const label = `reference discovery report child ${index + 1}`;
  const authority = AUTHORITATIVE_CHILDREN.get(value);
  if (authority?.plan !== canonicalProtocolJson(plan) ||
      authority?.sessionOrdinal !== session.ordinal) {
    fail(`${label} was not derived from an authoritative child bundle`);
  }
  exactKeys(value, [
    "targetCpu", "controllerCpu", "complete", "manifest", "envelope", "legs",
  ], label);
  if (value.targetCpu !== session.targetCpu || value.controllerCpu !== session.controllerCpu ||
      typeof value.complete !== "boolean") {
    fail(`${label} does not match its planned session`);
  }
  const manifest = parseArtifactBinding(value.manifest, `${label}.manifest`);
  const envelope = value.envelope === null ? null :
    parseArtifactBinding(value.envelope, `${label}.envelope`);
  if (value.complete !== (envelope !== null)) {
    fail(`${label} completion does not match its envelope binding`);
  }
  exactKeys(value.legs, ["a1", "b", "a2"], `${label}.legs`);
  if (!value.complete && [value.legs.a1, value.legs.b, value.legs.a2]
    .some((leg) => !Array.isArray(leg) || leg.length !== 0)) {
    fail(`${label} cannot expose uncommitted leg evidence`);
  }
  const withoutLoad = outcomeStats(value.legs.a1, plan.profile.attemptsPerLeg);
  const withLoad = outcomeStats(value.legs.b, plan.profile.attemptsPerLeg);
  const afterRecovery = outcomeStats(value.legs.a2, plan.profile.attemptsPerLeg);
  return {
    cpu: session.targetCpu,
    controllerCpu: session.controllerCpu,
    complete: value.complete,
    eligible: value.complete && withoutLoad.eligible && withLoad.eligible && afterRecovery.eligible,
    withoutLoad,
    withLoad,
    afterRecovery,
    bundle: session.directory,
    binding: { manifest, envelope },
  };
}

export function buildReferenceDiscoveryReport(planValue, children, historyValue) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  const history = parseReferenceDiscoveryHistory(plan, historyValue);
  if (!Array.isArray(children) || children.length !== plan.schedule.sessions.length) {
    fail("reference discovery report requires one child descriptor per session");
  }
  const rows = children.map((child, index) =>
    parseReportChild(plan, child, plan.schedule.sessions[index], index));
  const committed = new Set(history.committedSessionOrdinals);
  for (const session of plan.schedule.sessions) {
    if (rows[session.ordinal - 1].complete !== committed.has(session.ordinal)) {
      fail(`reference discovery child for CPU ${session.targetCpu} disagrees with execution history`);
    }
  }
  const complete = rows.every((row) => row.complete);
  const selectionEligible = complete && !history.contaminated && rows.every((row) => row.eligible);
  const affected = selectionEligible
    ? rows.filter((row) => row.withLoad.target > 0)
      .sort((left, right) => right.withLoad.target - left.withLoad.target || left.cpu - right.cpu)
    : [];
  const candidate = affected[0]?.cpu ?? null;
  const status = !complete ? "incomplete"
    : !selectionEligible ? "complete-ineligible"
      : candidate === null ? "complete-no-candidate" : "complete-candidate";
  const report = deepFreeze({
    version: REFERENCE_DISCOVERY_REPORT_VERSION,
    protocol: plan.protocol,
    interpretationVersion: plan.interpretationVersion,
    status,
    complete,
    selectionEligible,
    plan: referenceDiscoveryPlanBinding(plan),
    source: {
      history: referenceDiscoveryHistoryBinding(history.records),
      historyContaminated: history.contaminated,
      historyGenerations: history.generations.length,
      children: rows.map((row) => ({ cpu: row.cpu, ...row.binding })),
    },
    targetCpus: [...plan.selection.targetCpus],
    loadCpus: [...plan.selection.loadCpus],
    rows: rows.map(({ binding: _binding, ...row }) => row),
    affectedCpus: affected.map((row) => row.cpu),
    highestObservedFaultRateCandidate: candidate,
    interpretation: {
      ranking: "equal-denominator B-leg target count, then lower logical CPU number",
      boundary: "A1, B, and A2 remain separate; discovery samples are not confirmation samples.",
      claim: "The candidate has the highest observed B-leg fault rate in this eligible " +
        "screen; it is not a declaration of a bad CPU or a causal conclusion.",
    },
  });
  GENERATED_REPORTS.add(report);
  return report;
}

export function canonicalReferenceDiscoveryReportLine(report) {
  if (!GENERATED_REPORTS.has(report) || report?.version !== REFERENCE_DISCOVERY_REPORT_VERSION ||
      report?.protocol !== REFERENCE_DISCOVERY_PROTOCOL) {
    fail("reference discovery report was not derived from authoritative inputs");
  }
  return Buffer.from(`${canonicalProtocolJson(report)}\n`, "utf8");
}

export function referenceDiscoveryConfirmationSourceBinding(planValue, reportValue) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  const recomputedPlanBinding = referenceDiscoveryPlanBinding(plan);
  if (reportValue?.complete !== true || reportValue?.selectionEligible !== true ||
      !Number.isSafeInteger(reportValue?.highestObservedFaultRateCandidate) ||
      canonicalProtocolJson(reportValue?.plan) !== canonicalProtocolJson(recomputedPlanBinding)) {
    fail("reference discovery report cannot authorize confirmation");
  }
  const planBytes = canonicalReferenceDiscoveryPlanLine(plan);
  const reportBytes = canonicalReferenceDiscoveryReportLine(reportValue);
  const digestValue = createHash("sha256")
    .update("reference-discovery-confirmation-source-v1\0")
    .update(planBytes)
    .update(reportBytes)
    .digest("hex");
  return deepFreeze({
    version: 1,
    protocol: "reference-discovery-confirmation-source-v1",
    sha256: digestValue,
    plan: recomputedPlanBinding,
    report: {
      sha256: createHash("sha256").update(reportBytes).digest("hex"),
      bytes: reportBytes.length.toString(),
    },
    targetCpu: reportValue.highestObservedFaultRateCandidate,
    loadCpus: [...plan.selection.loadCpus],
    bootIdSha256: plan.host.bootIdSha256,
    machineSha256: plan.host.machineSha256,
  });
}
