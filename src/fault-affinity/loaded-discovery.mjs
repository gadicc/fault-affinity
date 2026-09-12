import { createHash } from "node:crypto";
import path from "node:path";

import { canonicalProtocolJson } from "../../diagnose-lib/pinned-protocol.mjs";
import {
  CONTROLLED_LOAD_WORKER_SET_MAX_WORKERS,
} from "../../diagnose-lib/controlled-load-workers.mjs";
import { MAX_CPU_ID, MAX_SEED, compressCpuList } from "../../diagnose-lib/pinned-runner.mjs";
import { CAMPAIGN_PROFILES } from "./campaign-topology.mjs";

export const LOADED_DISCOVERY_PLAN_VERSION = 1;
export const LOADED_DISCOVERY_REPORT_VERSION = 1;
export const LOADED_DISCOVERY_PROTOCOL = "loaded-target-screen-v1";
export const LOADED_DISCOVERY_PLAN_FILE = "loaded-discovery.json";
export const LOADED_DISCOVERY_REPORT_JSON_FILE = "loaded-discovery-report.json";
export const LOADED_DISCOVERY_REPORT_MARKDOWN_FILE = "loaded-discovery-report.md";
export const LOADED_DISCOVERY_RECIPE = "wasm-churn-aba";

const ORDER_ALGORITHM = "sha256-seeded-target-order-v1";
const TARGET_CATEGORIES = new Set(["target-fault", "corruption"]);

export class LoadedDiscoveryError extends Error {
  constructor(message, code = "INVALID_LOADED_DISCOVERY") {
    super(message);
    this.name = "LoadedDiscoveryError";
    this.code = code;
  }
}

function fail(message) {
  throw new LoadedDiscoveryError(message);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
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

function cpuList(value, label, maximum = MAX_CPU_ID + 1) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be nonempty`);
  if (value.length > maximum) fail(`${label} may contain at most ${maximum} CPUs`);
  const cpus = value.map((cpu, index) => integer(cpu, `${label}[${index}]`, 0, MAX_CPU_ID));
  if (cpus.some((cpu, index) => index > 0 && cpu <= cpus[index - 1])) {
    fail(`${label} must be strictly increasing`);
  }
  return cpus;
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

function selectedCpus(topology, requested, fallback, label) {
  const selected = sortedUnique(requested ?? fallback);
  if (selected.length === 0) fail(`${label} is empty`);
  const usable = new Set(topology.usable);
  const invalid = selected.filter((cpu) => !usable.has(cpu));
  if (invalid.length > 0) fail(`${label} contains unusable CPUs: ${invalid.join(",")}`);
  return selected;
}

function targetOrder(targets, seed) {
  return [...targets].sort((left, right) => {
    const digest = (cpu) => createHash("sha256")
      .update(`${ORDER_ALGORITHM}\n${seed}\n${cpu}\n`)
      .digest("hex");
    const leftDigest = digest(left);
    const rightDigest = digest(right);
    return leftDigest.localeCompare(rightDigest) || left - right;
  });
}

function sessionDirectory(cpu) {
  return `cpu-${String(cpu).padStart(5, "0")}`;
}

export function buildLoadedDiscoveryPlanFromTopology(topology, {
  recipe = LOADED_DISCOVERY_RECIPE,
  profile: profileName = "quick",
  targetCpus,
  loadCpus,
  seed = 17,
  tasksetPath = "/usr/bin/taskset",
} = {}) {
  if (topology === null || typeof topology !== "object" ||
      !Array.isArray(topology.usable) || topology.usable.length < 3 ||
      topology.classes === null || typeof topology.classes !== "object") {
    fail("loaded discovery requires a valid topology with at least three usable CPUs");
  }
  if (recipe !== LOADED_DISCOVERY_RECIPE) {
    fail(`loaded discovery recipe must be ${LOADED_DISCOVERY_RECIPE}`);
  }
  if (typeof tasksetPath !== "string" || !path.isAbsolute(tasksetPath) ||
      tasksetPath.includes("\0")) {
    fail("loaded discovery taskset path must be absolute and NUL-free");
  }
  const profile = CAMPAIGN_PROFILES[profileName];
  if (profile === undefined) fail("profile must be quick, standard, or full");
  integer(seed, "loaded discovery seed", 0, MAX_SEED);

  const automatic = targetCpus === undefined && loadCpus === undefined;
  if ((targetCpus === undefined) !== (loadCpus === undefined)) {
    fail("target CPUs and load CPUs must be supplied together");
  }
  if (automatic && topology.classes.source !== "sysfs-hybrid") {
    fail("automatic loaded discovery requires complete Linux P-core/E-core topology; " +
      "supply both target CPUs and load CPUs explicitly on this system");
  }
  const targets = selectedCpus(topology, targetCpus, topology.classes.efficient,
    "loaded discovery target CPUs");
  const workers = selectedCpus(topology, loadCpus, topology.classes.performance,
    "loaded discovery load CPUs");
  if (workers.length > CONTROLLED_LOAD_WORKER_SET_MAX_WORKERS) {
    fail(`loaded discovery load CPUs may contain at most ` +
      `${CONTROLLED_LOAD_WORKER_SET_MAX_WORKERS} CPUs`);
  }
  const overlap = targets.filter((cpu) => workers.includes(cpu));
  if (overlap.length > 0) {
    fail(`loaded discovery target and load CPUs overlap: ${overlap.join(",")}`);
  }
  const ordered = targetOrder(targets, seed);
  const sessions = ordered.map((targetCpu, index) => {
    const availableControllers = topology.usable.filter((cpu) =>
      cpu !== targetCpu && !workers.includes(cpu));
    if (availableControllers.length === 0) {
      fail(`target CPU ${targetCpu} leaves no controller CPU outside the target and load sets`);
    }
    return {
      ordinal: index + 1,
      targetCpu,
      controllerCpu: availableControllers[index % availableControllers.length],
      directory: sessionDirectory(targetCpu),
    };
  });
  return parseLoadedDiscoveryPlan({
    version: LOADED_DISCOVERY_PLAN_VERSION,
    protocol: LOADED_DISCOVERY_PROTOCOL,
    recipe,
    profile: profileName,
    execution: { tasksetPath },
    topology: {
      source: topology.classes.source,
      usableCpus: [...topology.usable],
      targetCpus: targets,
      loadCpus: workers,
    },
    schedule: {
      algorithm: ORDER_ALGORITHM,
      seed,
      attemptsPerLeg: profile.attemptsPerLeg,
      warmupMs: profile.warmupMs,
      recoveryMs: profile.recoveryMs,
      sessions,
    },
  });
}

export function parseLoadedDiscoveryPlan(value) {
  exactKeys(value, [
    "version", "protocol", "recipe", "profile", "execution", "topology", "schedule",
  ],
    "loaded discovery plan");
  if (value.version !== LOADED_DISCOVERY_PLAN_VERSION ||
      value.protocol !== LOADED_DISCOVERY_PROTOCOL) {
    fail("loaded discovery plan version or protocol is unsupported");
  }
  if (value.recipe !== LOADED_DISCOVERY_RECIPE ||
      CAMPAIGN_PROFILES[value.profile] === undefined) {
    fail("loaded discovery recipe or profile is invalid");
  }
  exactKeys(value.execution, ["tasksetPath"], "loaded discovery execution");
  if (typeof value.execution.tasksetPath !== "string" ||
      !path.isAbsolute(value.execution.tasksetPath) || value.execution.tasksetPath.includes("\0")) {
    fail("loaded discovery taskset path must be absolute and NUL-free");
  }
  exactKeys(value.topology, ["source", "usableCpus", "targetCpus", "loadCpus"],
    "loaded discovery topology");
  if (!new Set(["sysfs-hybrid", "uniform"]).has(value.topology.source)) {
    fail("loaded discovery topology source is invalid");
  }
  const usableCpus = cpuList(value.topology.usableCpus, "loaded discovery usable CPUs");
  const targetCpus = cpuList(value.topology.targetCpus, "loaded discovery target CPUs");
  const loadCpus = cpuList(value.topology.loadCpus, "loaded discovery load CPUs",
    CONTROLLED_LOAD_WORKER_SET_MAX_WORKERS);
  if ([...targetCpus, ...loadCpus].some((cpu) => !usableCpus.includes(cpu)) ||
      targetCpus.some((cpu) => loadCpus.includes(cpu))) {
    fail("loaded discovery target/load CPU sets do not fit the usable CPU set");
  }

  exactKeys(value.schedule, [
    "algorithm", "seed", "attemptsPerLeg", "warmupMs", "recoveryMs", "sessions",
  ], "loaded discovery schedule");
  if (value.schedule.algorithm !== ORDER_ALGORITHM) {
    fail("loaded discovery ordering algorithm is unsupported");
  }
  const seed = integer(value.schedule.seed, "loaded discovery seed", 0, MAX_SEED);
  const profile = CAMPAIGN_PROFILES[value.profile];
  for (const [key, maximum] of [
    ["attemptsPerLeg", 1_000_000], ["warmupMs", 3_600_000], ["recoveryMs", 3_600_000],
  ]) integer(value.schedule[key], `loaded discovery ${key}`, 0, maximum);
  if (value.schedule.attemptsPerLeg < 1 ||
      value.schedule.attemptsPerLeg !== profile.attemptsPerLeg ||
      value.schedule.warmupMs !== profile.warmupMs ||
      value.schedule.recoveryMs !== profile.recoveryMs) {
    fail("loaded discovery schedule does not match its named profile");
  }
  if (!Array.isArray(value.schedule.sessions) ||
      value.schedule.sessions.length !== targetCpus.length) {
    fail("loaded discovery sessions must cover every target CPU exactly once");
  }
  const expectedOrder = targetOrder(targetCpus, seed);
  const sessions = value.schedule.sessions.map((session, index) => {
    exactKeys(session, ["ordinal", "targetCpu", "controllerCpu", "directory"],
      `loaded discovery session ${index + 1}`);
    const ordinal = integer(session.ordinal, "loaded discovery session ordinal", 1,
      targetCpus.length);
    const targetCpu = integer(session.targetCpu, "loaded discovery session target", 0,
      MAX_CPU_ID);
    const controllerCpu = integer(session.controllerCpu, "loaded discovery session controller", 0,
      MAX_CPU_ID);
    if (ordinal !== index + 1 || targetCpu !== expectedOrder[index] ||
        !usableCpus.includes(controllerCpu) || controllerCpu === targetCpu ||
        loadCpus.includes(controllerCpu) || session.directory !== sessionDirectory(targetCpu)) {
      fail(`loaded discovery session ${index + 1} does not match its bound schedule`);
    }
    return { ordinal, targetCpu, controllerCpu, directory: session.directory };
  });
  if (!sameList(sortedUnique(sessions.map(({ targetCpu }) => targetCpu)), targetCpus)) {
    fail("loaded discovery sessions duplicate or omit target CPUs");
  }
  return deepFreeze({
    version: value.version,
    protocol: value.protocol,
    recipe: value.recipe,
    profile: value.profile,
    execution: { tasksetPath: value.execution.tasksetPath },
    topology: { source: value.topology.source, usableCpus, targetCpus, loadCpus },
    schedule: {
      algorithm: value.schedule.algorithm,
      seed,
      attemptsPerLeg: value.schedule.attemptsPerLeg,
      warmupMs: value.schedule.warmupMs,
      recoveryMs: value.schedule.recoveryMs,
      sessions,
    },
  });
}

export function canonicalLoadedDiscoveryPlanLine(plan) {
  return Buffer.from(`${canonicalProtocolJson(parseLoadedDiscoveryPlan(plan))}\n`, "utf8");
}

export function loadedDiscoveryPlanBinding(plan) {
  const bytes = canonicalLoadedDiscoveryPlanLine(plan);
  return Object.freeze({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
}

function outcomeStats(evidences) {
  let target = 0;
  let pass = 0;
  let other = 0;
  for (const evidence of evidences) {
    const category = evidence?.outcome?.category;
    if (TARGET_CATEGORIES.has(category)) target += 1;
    else if (category === "pass") pass += 1;
    else other += 1;
  }
  const resolved = target + pass;
  return { target, pass, other, resolved, rate: resolved === 0 ? null : target / resolved };
}

function compareLoadedRows(left, right) {
  if (left.withLoad.rate === null) return right.withLoad.rate === null ? left.cpu - right.cpu : 1;
  if (right.withLoad.rate === null) return -1;
  const leftProduct = BigInt(left.withLoad.target) * BigInt(right.withLoad.resolved);
  const rightProduct = BigInt(right.withLoad.target) * BigInt(left.withLoad.resolved);
  if (leftProduct !== rightProduct) return leftProduct > rightProduct ? -1 : 1;
  return right.withLoad.target - left.withLoad.target ||
    right.withLoad.resolved - left.withLoad.resolved || left.cpu - right.cpu;
}

export function buildLoadedDiscoveryReport(planValue, bundles) {
  const plan = parseLoadedDiscoveryPlan(planValue);
  if (!Array.isArray(bundles) || bundles.length !== plan.schedule.sessions.length) {
    fail("loaded discovery report requires one bundle per planned session");
  }
  const rows = plan.schedule.sessions.map((session, index) => {
    const phase = bundles[index]?.controlledLoad;
    if (phase === undefined || phase.manifest?.execution?.targetCpu !== session.targetCpu ||
        !sameList(phase.manifest.execution.workerCpus, plan.topology.loadCpus) ||
        phase.manifest.schedule.attemptsPerLeg !== plan.schedule.attemptsPerLeg ||
        phase.manifest.schedule.warmupMs !== plan.schedule.warmupMs ||
        phase.manifest.schedule.recoveryMs !== plan.schedule.recoveryMs) {
      fail(`loaded discovery bundle for CPU ${session.targetCpu} does not match the plan`);
    }
    const legs = new Map((phase.envelope?.legs ?? []).map((leg) => [leg.leg, leg]));
    return {
      cpu: session.targetCpu,
      controllerCpu: session.controllerCpu,
      complete: phase.progress.complete,
      withoutLoad: outcomeStats((legs.get("a1")?.attempts ?? []).map(({ evidence }) => evidence)),
      withLoad: outcomeStats((legs.get("b")?.attempts ?? []).map(({ evidence }) => evidence)),
      afterRecovery: outcomeStats((legs.get("a2")?.attempts ?? []).map(({ evidence }) => evidence)),
      bundle: session.directory,
    };
  });
  const complete = rows.every((row) => row.complete);
  const affected = rows.filter((row) => row.withLoad.target > 0).sort(compareLoadedRows);
  return deepFreeze({
    version: LOADED_DISCOVERY_REPORT_VERSION,
    status: complete ? "complete" : "incomplete",
    complete,
    plan: loadedDiscoveryPlanBinding(plan),
    protocol: plan.protocol,
    recipe: plan.recipe,
    profile: plan.profile,
    targetCpus: [...plan.topology.targetCpus],
    loadCpus: [...plan.topology.loadCpus],
    rows,
    affectedCpus: affected.map(({ cpu }) => cpu),
    strongestCandidate: complete && affected.length > 0 ? affected[0].cpu : null,
    interpretation: {
      ranking: "with-load target rate, then target count, resolved count, then lower CPU id",
      boundary: "Discovery ranks only the separate with-load leg for each CPU; it does not pool A1, B, and A2.",
      confirmation: "Use a fresh A1/B/A2 bundle for the proposed candidate; do not pool discovery and confirmation samples.",
    },
  });
}

function percentage(value) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function shortStats(stats) {
  return stats.resolved === 0
    ? `0/0 resolved; other ${stats.other}`
    : `${stats.target}/${stats.resolved} (${percentage(stats.rate)})` +
      (stats.other === 0 ? "" : `; other ${stats.other}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function renderLoadedDiscoveryReportMarkdown(report) {
  if (report?.version !== LOADED_DISCOVERY_REPORT_VERSION) {
    fail("loaded discovery report version is unsupported");
  }
  const lines = [
    "# Fault Affinity loaded discovery report",
    "",
    `Status: **${report.status}**`,
    "",
    `Targets: ${compressCpuList(report.targetCpus)}. Verified load workers: ` +
      `${compressCpuList(report.loadCpus)}.`,
    "",
  ];
  if (!report.complete) {
    lines.push("The planned screen is incomplete. Resume it before selecting a candidate.", "");
  } else if (report.strongestCandidate === null) {
    lines.push("**No target fault was observed on any screened CPU during its with-load leg.**", "");
  } else {
    lines.push(`**Strongest loaded candidate: CPU ${report.strongestCandidate}.**`, "",
      `Affected CPUs: ${report.affectedCpus.join(", ")}.`, "");
  }
  lines.push(
    "| CPU | A1 without load | B with load | A2 after recovery | Controller | Bundle |",
    "| ---: | --- | --- | --- | ---: | --- |",
  );
  for (const row of [...report.rows].sort((left, right) => left.cpu - right.cpu)) {
    lines.push(`| ${row.cpu} | ${shortStats(row.withoutLoad)} | ${shortStats(row.withLoad)} | ` +
      `${shortStats(row.afterRecovery)} | ${row.controllerCpu} | \`${row.bundle}\` |`);
  }
  lines.push("", "## Interpretation", "",
    `- ${report.interpretation.boundary}`,
    `- Ranking rule: ${report.interpretation.ranking}.`,
    `- ${report.interpretation.confirmation}`,
    "- An observed CPU affinity is a localization result, not proof that the logical CPU is the root cause.",
    "- Each child bundle is the authoritative schema-3 evidence for that CPU; this report is a collection-level view.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

export function renderLoadedDiscoveryConsoleSummary(report, outputDirectory) {
  if (report?.version !== LOADED_DISCOVERY_REPORT_VERSION) {
    fail("loaded discovery report version is unsupported");
  }
  const lines = ["", "Loaded discovery result:"];
  const affected = report.rows.filter((row) => row.withLoad.target > 0)
    .sort(compareLoadedRows);
  if (affected.length === 0) {
    lines.push("  affected CPUs under load: none observed");
    lines.push("  strongest candidate: none");
    return `${lines.join("\n")}\n`;
  }
  lines.push("  affected CPUs under load:");
  for (const row of affected) {
    lines.push(`    CPU ${row.cpu}: ${shortStats(row.withLoad)}`);
  }
  const cpu = report.strongestCandidate;
  const confirmDir = `${outputDirectory}-confirm-cpu${cpu}`;
  lines.push(`  strongest candidate: CPU ${cpu}`);
  lines.push("", "Confirm it in a fresh A1/B/A2 bundle:",
    "  node fault-affinity.mjs controlled-load --recipe wasm-churn-aba \\",
    `    --target-cpu ${cpu} --load-cpus ${compressCpuList(report.loadCpus)} \\`,
    `    --out-dir ${shellQuote(confirmDir)} --dry-run`,
    "  Then review the plan and replace --dry-run with --yes.");
  return `${lines.join("\n")}\n`;
}
