import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { readLinuxAllowedCpuList } from "../../diagnose-lib/attempt-runner.mjs";
import {
  MAX_SEED,
  compressCpuList,
  expandCpuList,
} from "../../diagnose-lib/pinned-runner.mjs";
import { parseCampaignPlan } from "./campaign-plan.mjs";

const MAX_SYSFS_TEXT_BYTES = 64 * 1024;

export const CAMPAIGN_PROFILES = Object.freeze({
  quick: Object.freeze({
    baselineChildren: 4,
    baselineWaves: 3,
    groupRounds: 3,
    pinnedRounds: 3,
    exactRounds: 3,
    attemptsPerLeg: 3,
    warmupMs: 0,
    recoveryMs: 5_000,
  }),
  standard: Object.freeze({
    baselineChildren: 8,
    baselineWaves: 10,
    groupRounds: 10,
    pinnedRounds: 10,
    exactRounds: 10,
    attemptsPerLeg: 10,
    warmupMs: 0,
    recoveryMs: 15_000,
  }),
  full: Object.freeze({
    baselineChildren: 16,
    baselineWaves: 50,
    groupRounds: 50,
    pinnedRounds: 200,
    exactRounds: 200,
    attemptsPerLeg: 20,
    warmupMs: 0,
    recoveryMs: 30_000,
  }),
});

export class CampaignTopologyError extends Error {
  constructor(message, code = "INVALID_CAMPAIGN_TOPOLOGY") {
    super(message);
    this.name = "CampaignTopologyError";
    this.code = code;
  }
}

function fail(message) {
  throw new CampaignTopologyError(message);
}

function readSysfsLine(filename, label, { optional = false } = {}) {
  let bytes;
  try {
    bytes = readFileSync(filename);
  } catch (error) {
    if (optional && ["ENOENT", "ENOTDIR", "EACCES"].includes(error?.code)) return null;
    fail(`${label} could not be read: ${error?.code ?? "unknown error"}`);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 ||
      bytes.length > MAX_SYSFS_TEXT_BYTES || bytes.includes(0)) {
    fail(`${label} is empty, oversized, or contains NUL bytes`);
  }
  const text = bytes.toString("utf8");
  if (text.includes("\r") || !/^([^\n]+)\n?$/.test(text)) {
    fail(`${label} must contain exactly one LF-terminated text line`);
  }
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function parseCpuSpec(spec, label) {
  try {
    return expandCpuList(spec);
  } catch (error) {
    fail(`${label} is invalid: ${error.message}`);
  }
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}

function intersection(left, right) {
  const wanted = new Set(right);
  return sortedUnique(left.filter((value) => wanted.has(value)));
}

function union(...lists) {
  return sortedUnique(lists.flat());
}

function sameCpuList(left, right) {
  return left.length === right.length && left.every((cpu, index) => cpu === right[index]);
}

function uintText(value, maximum = 65_535) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function shortDigest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function firstOutside(universe, active) {
  const used = new Set(active);
  return universe.find((cpu) => !used.has(cpu));
}

function coreUnitKey(cpuRoot, cpu) {
  const packageText = readSysfsLine(
    path.join(cpuRoot, `cpu${cpu}`, "topology", "physical_package_id"),
    `CPU ${cpu} package id`,
    { optional: true },
  );
  const coreText = readSysfsLine(
    path.join(cpuRoot, `cpu${cpu}`, "topology", "core_id"),
    `CPU ${cpu} core id`,
    { optional: true },
  );
  const packageId = packageText === null || uintText(packageText) === null
    ? "unknown" : packageText;
  const coreId = coreText === null || uintText(coreText) === null ? `cpu${cpu}` : coreText;
  return `${packageId}:${coreId}`;
}

function partitionContext(cpuRoot, universe, context) {
  if (context.cpus.length < 2) fail(`context '${context.id}' leaves no controller CPU`);
  const units = new Map();
  for (const cpu of context.cpus) {
    const key = coreUnitKey(cpuRoot, cpu);
    const members = units.get(key) ?? [];
    members.push(cpu);
    units.set(key, members);
  }
  const left = [];
  const right = [];
  const orderedUnits = [...units.entries()].sort(([leftKey], [rightKey]) =>
    leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0);
  if (orderedUnits.length >= 2) {
    orderedUnits.forEach(([, members], index) => (index % 2 === 0 ? left : right)
      .push(...members));
  } else {
    context.cpus.forEach((cpu, index) => (index % 2 === 0 ? left : right).push(cpu));
  }
  if (left.length === 0 || right.length === 0) {
    fail(`context '${context.id}' could not be partitioned around a controller`);
  }
  return [left, right].map((cpus, index) => ({
    id: `${context.id}-${index === 0 ? "a" : "b"}`,
    kind: `${context.kind}-partition`,
    cpus: sortedUnique(cpus),
    cluster: "-",
    controllerCpu: firstOutside(universe, cpus),
  }));
}

function clusterForCpu(cpuRoot, usable, cpu) {
  const packageText = readSysfsLine(
    path.join(cpuRoot, `cpu${cpu}`, "topology", "physical_package_id"),
    `CPU ${cpu} package id`,
    { optional: true },
  );
  const packageId = packageText === null || uintText(packageText) === null
    ? "unknown" : packageText;
  const clusterText = readSysfsLine(
    path.join(cpuRoot, `cpu${cpu}`, "topology", "cluster_id"),
    `CPU ${cpu} cluster id`,
    { optional: true },
  );
  if (clusterText !== null && uintText(clusterText) !== null) {
    return { key: `${packageId}|${clusterText}`, label: `topo:${packageId}:${clusterText}` };
  }
  const l2Text = readSysfsLine(
    path.join(cpuRoot, `cpu${cpu}`, "cache", "index2", "shared_cpu_list"),
    `CPU ${cpu} shared L2 list`,
    { optional: true },
  );
  if (l2Text !== null) {
    const shared = intersection(parseCpuSpec(l2Text, `CPU ${cpu} shared L2 list`), usable);
    if (shared.length > 0) {
      const label = `l2:${compressCpuList(shared)}`;
      return { key: `${packageId}|${label}`, label };
    }
  }
  return null;
}

export function discoverCampaignTopology({
  cpuRoot = "/sys/devices/system/cpu",
  deviceRoot = "/sys/devices",
  allowedCpuSpec,
} = {}) {
  const onlineSpec = readSysfsLine(path.join(cpuRoot, "online"), "online CPU list");
  const effectiveAllowed = allowedCpuSpec ?? readLinuxAllowedCpuList(process.pid, { strict: true });
  if (effectiveAllowed === null) fail("the invoking process CPU allowance is unavailable");
  const online = parseCpuSpec(onlineSpec, "online CPU list");
  const allowed = parseCpuSpec(effectiveAllowed, "allowed CPU list");
  const usable = intersection(online, allowed);
  if (usable.length < 2) {
    fail("a campaign requires at least two CPUs that are both online and allowed");
  }

  const pText = readSysfsLine(path.join(deviceRoot, "cpu_core", "cpus"),
    "performance-core CPU list", { optional: true });
  const eText = readSysfsLine(path.join(deviceRoot, "cpu_atom", "cpus"),
    "efficient-core CPU list", { optional: true });
  const pCpus = pText === null ? [] : intersection(parseCpuSpec(pText,
    "performance-core CPU list"), usable);
  const eCpus = eText === null ? [] : intersection(parseCpuSpec(eText,
    "efficient-core CPU list"), usable);
  if (pCpus.some((cpu) => eCpus.includes(cpu))) {
    fail("performance-core and efficient-core CPU lists overlap");
  }
  if ((pText !== null || eText !== null) && !sameCpuList(union(pCpus, eCpus), usable)) {
    fail("performance-core and efficient-core CPU lists do not cover every usable CPU");
  }

  const contexts = [];
  if (pCpus.length > 0) {
    contexts.push({ id: "pcores", kind: "pcore", cpus: pCpus });
  }
  if (eCpus.length > 0) {
    contexts.push({ id: "ecores", kind: "ecore", cpus: eCpus });
    const clusters = new Map();
    for (const cpu of eCpus) {
      const cluster = clusterForCpu(cpuRoot, usable, cpu);
      if (cluster === null) continue;
      const current = clusters.get(cluster.key) ?? { label: cluster.label, cpus: [] };
      current.cpus.push(cpu);
      clusters.set(cluster.key, current);
    }
    for (const [, cluster] of [...clusters.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)) {
      const id = `${cluster.label.startsWith("l2:") ? "ecluster-l2" : "ecluster-topo"}` +
        `-${shortDigest(cluster.label)}`;
      contexts.push({ id, kind: "ecluster", cpus: sortedUnique(cluster.cpus),
        cluster: cluster.label });
    }
  }
  if (contexts.length === 0) {
    contexts.push({ id: "all-cpus", kind: "uniform", cpus: usable });
  }

  const pinnedContexts = contexts.flatMap((context) => {
    const controllerCpu = firstOutside(usable, context.cpus);
    if (controllerCpu !== undefined) {
      return [{
        id: context.id,
        kind: context.kind,
        cpus: context.cpus,
        cluster: context.cluster ?? "-",
        controllerCpu,
      }];
    }
    return partitionContext(cpuRoot, usable, context);
  });

  return Object.freeze({
    online: Object.freeze(online),
    allowed: Object.freeze(allowed),
    usable: Object.freeze(usable),
    classes: Object.freeze({
      performance: Object.freeze(pCpus),
      efficient: Object.freeze(eCpus),
      source: pText === null && eText === null ? "uniform" : "sysfs-hybrid",
    }),
    groups: Object.freeze(contexts.map((context) => Object.freeze({
      ...context,
      cpus: Object.freeze([...context.cpus]),
    }))),
    pinnedConcurrent: Object.freeze(pinnedContexts.map((context) => Object.freeze({
      ...context,
      cpus: Object.freeze([...context.cpus]),
    }))),
  });
}

function profileByName(name) {
  const profile = CAMPAIGN_PROFILES[name];
  if (profile === undefined) {
    fail(`unknown campaign profile '${name}'; choose: ${Object.keys(CAMPAIGN_PROFILES).join(", ")}`);
  }
  return profile;
}

function selectedCpus(topology, requested, label) {
  if (requested === undefined) return undefined;
  if (!Array.isArray(requested) || requested.length === 0) fail(`${label} must be nonempty`);
  const selected = sortedUnique(requested);
  const usable = new Set(topology.usable);
  const invalid = selected.filter((cpu) => !usable.has(cpu));
  if (invalid.length > 0) fail(`${label} contains unusable CPUs: ${invalid.join(",")}`);
  return selected;
}

export function buildCampaignPlanFromTopology(topology, {
  profile: profileName = "quick",
  seed = 17,
  targetCpu,
  loadCpus,
} = {}) {
  if (topology === null || typeof topology !== "object" ||
      !Array.isArray(topology.usable) || topology.usable.length < 2 ||
      !Array.isArray(topology.groups) || topology.groups.length < 1 ||
      !Array.isArray(topology.pinnedConcurrent) || topology.pinnedConcurrent.length < 1) {
    fail("campaign topology is invalid");
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) {
    fail(`campaign seed must be an integer from 0 through ${MAX_SEED}`);
  }
  const profile = profileByName(profileName);
  const selectedTarget = targetCpu ?? topology.usable.at(-1);
  if (!topology.usable.includes(selectedTarget)) fail("campaign target CPU is not usable");
  const requestedWorkers = selectedCpus(topology, loadCpus, "campaign load CPUs");
  const workers = requestedWorkers ?? topology.usable.filter((cpu) => cpu !== selectedTarget);
  if (workers.includes(selectedTarget)) fail("campaign target CPU must be outside load CPUs");
  if (workers.length === 0) fail("campaign load CPUs must contain at least one CPU");

  return parseCampaignPlan({
    version: 1,
    baseline: {
      children: Math.min(profile.baselineChildren, topology.usable.length),
      waves: profile.baselineWaves,
    },
    groups: {
      cpuUniverse: compressCpuList(topology.usable),
      contexts: topology.groups.map((context) => ({
        id: context.id,
        kind: context.kind,
        cpus: compressCpuList(context.cpus),
        children: Math.min(context.cpus.length, 16),
      })),
      rounds: profile.groupRounds,
      seed,
    },
    pinnedConcurrent: {
      contexts: topology.pinnedConcurrent.map((context) => ({
        id: context.id,
        kind: context.kind,
        cpus: compressCpuList(context.cpus),
        cluster: context.cluster,
        controllerCpu: context.controllerCpu,
      })),
      rounds: profile.pinnedRounds,
      seed,
    },
    exact: {
      cpus: compressCpuList(topology.usable),
      rounds: profile.exactRounds,
      seed,
    },
    controlledLoad: {
      targetCpu: selectedTarget,
      workerCpus: compressCpuList(workers),
      attemptsPerLeg: profile.attemptsPerLeg,
      warmupMs: profile.warmupMs,
      recoveryMs: profile.recoveryMs,
    },
  });
}
