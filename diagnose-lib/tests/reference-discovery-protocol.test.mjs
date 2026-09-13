import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runWorkloadAttempt } from "../attempt-runner.mjs";
import { buildControlledLoadSessionManifest } from "../controlled-load-session.mjs";
import { buildExactCpuPhaseManifest } from "../exact-cpu-phase.mjs";
import {
  buildSchema3BundleManifestV5,
  initializeSchema3Bundle,
  runOneSchema3ControlledLoadSession,
} from "../schema3-bundle.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";
import {
  REFERENCE_DISCOVERY_MAX_TARGETS,
  REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES,
  REFERENCE_DISCOVERY_MINIMUM_RESULTS_BYTES,
  REFERENCE_DISCOVERY_PROFILE,
  buildReferenceDiscoveryPlan,
  buildReferenceDiscoveryReport,
  canonicalReferenceDiscoveryPlanLine,
  canonicalReferenceDiscoveryReportLine,
  parseReferenceDiscoveryHistory,
  parseReferenceDiscoveryPlan,
  parseReferenceDiscoveryTopology,
  readReferenceDiscoveryChild,
  referenceDiscoveryConfirmationSourceBinding,
  referenceDiscoveryPreviewBinding,
  referenceDiscoveryWorstCaseMs,
} from "../../src/reference-kit/discovery-protocol.mjs";
import {
  publishReferenceDiscoveryHistoryStart,
  publishReferenceDiscoveryHistoryTerminal,
  readReferenceDiscoveryHistory,
  withReferenceDiscoveryHistoryStore,
} from "../../src/reference-kit/discovery-history-store.mjs";
import { canonicalProtocolJson } from "../pinned-protocol.mjs";

const HASHES = Object.freeze({
  boot: "a".repeat(64),
  machine: "b".repeat(64),
  os: "c".repeat(64),
  power: "d".repeat(64),
  release: "e".repeat(64),
  app: "f".repeat(64),
  pglite: "0".repeat(64),
  controller: "1".repeat(64),
  target: "2".repeat(64),
  measured: "3".repeat(64),
  condition: "4".repeat(64),
  taskset: "5".repeat(64),
  yes: "6".repeat(64),
  manifest: "7".repeat(64),
  envelope: "8".repeat(64),
});

function file(path, sha256, extra = {}) {
  return { path, sha256, bytes: "123", mode: 0o755, ...extra };
}

function identity(root = "/opt/fault affinity") {
  return {
    kitRoot: root,
    releaseFile: file(`${root}/RELEASE.json`, HASHES.release, { mode: 0o644 }),
    appTreeSha256: HASHES.app,
    pgliteTreeSha256: HASHES.pglite,
    controllerRuntime: file(`${root}/runtime/controller/bin/node`, HASHES.controller,
      { version: "v24.21.0" }),
    targetRuntime: file(`${root}/runtime/reference/bin/node`, HASHES.target,
      { version: "v25.2.1" }),
    measuredWorkloadDigest: HASHES.measured,
    conditionWorkloadDigest: HASHES.condition,
    taskset: file("/usr/bin/taskset", HASHES.taskset),
    yes: file("/usr/bin/yes", HASHES.yes),
  };
}

function hybridTopology() {
  return {
    onlineCpus: [0, 1, 2, 3, 4, 5],
    allowedCpus: [0, 1, 2, 3, 4, 5],
    usableCpus: [0, 1, 2, 3, 4, 5],
    classes: {
      source: "sysfs-hybrid",
      performanceCpus: [0, 1],
      efficientCpus: [2, 3, 4, 5],
    },
    cores: [
      { packageId: "0", coreId: "0", cpus: [0, 1] },
      { packageId: "0", coreId: "1", cpus: [2] },
      { packageId: "0", coreId: "2", cpus: [3] },
      { packageId: "0", coreId: "3", cpus: [4] },
      { packageId: "0", coreId: "4", cpus: [5] },
    ],
  };
}

function host(topology = hybridTopology()) {
  return {
    bootIdSha256: HASHES.boot,
    machineSha256: HASHES.machine,
    kernelRelease: "6.17.0-fixture",
    osReleaseSha256: HASHES.os,
    powerPolicySha256: HASHES.power,
    microcode: topology.usableCpus.map((cpu) => ({ cpu, value: "0x123" })),
  };
}

function resources({ available = 4n * 1024n ** 3n, current = 1024n ** 3n,
  maximum = 8n * 1024n ** 3n,
  status = maximum === null ? "resolved-unlimited" : "resolved-limited" } = {}) {
  const cgroupHeadroom = status === "resolved-limited"
    ? maximum > current ? maximum - current : 0n
    : status === "resolved-unlimited" ? available : 0n;
  const effective = available < cgroupHeadroom ? available : cgroupHeadroom;
  return {
    memAvailableBytes: available.toString(),
    cgroupStatus: status,
    cgroupCurrentBytes: status === "resolved-limited" ? current.toString() : null,
    cgroupMaxBytes: status === "resolved-limited" ? maximum.toString() : null,
    effectiveHeadroomBytes: effective.toString(),
    minimumHeadroomBytes: REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES.toString(),
    meetsMinimum: effective >= REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES,
  };
}

function storage(root = "/var/lib/fault-affinity") {
  return {
    resultsRoot: root,
    collectionDir: `${root}/reference-discovery-20260913T000000Z`,
    availableBytes: (8n * 1024n ** 3n).toString(),
    minimumRequiredBytes: REFERENCE_DISCOVERY_MINIMUM_RESULTS_BYTES.toString(),
    meetsMinimum: true,
    mountPoint: "/var",
    filesystemType: "ext4",
    source: "/dev/vda2",
    classification: "likely-persistent",
    supportsActiveState: true,
    warning: null,
  };
}

function plan(topology = hybridTopology(), options = {}) {
  return buildReferenceDiscoveryPlan(topology, {
    identity: identity(),
    host: host(topology),
    resources: resources(),
    storage: storage(),
    ...options,
  });
}

function evidence(category = "pass", validOutcome = true) {
  return { outcome: { category, validOutcome } };
}

function leg({ target = 0, other = 0, invalid = 0 } = {}) {
  return [
    ...Array.from({ length: target }, () => evidence("target-fault")),
    ...Array.from({ length: other }, () => evidence("workload-error")),
    ...Array.from({ length: invalid }, () => evidence("operational-invalid", false)),
    ...Array.from({
      length: REFERENCE_DISCOVERY_PROFILE.attemptsPerLeg - target - other - invalid,
    }, () => evidence()),
  ];
}

function child(session, legs = {}) {
  return {
    targetCpu: session.targetCpu,
    controllerCpu: session.controllerCpu,
    complete: legs.complete ?? true,
    manifest: { sha256: HASHES.manifest, bytes: "100" },
    envelope: legs.complete === false ? null : { sha256: HASHES.envelope, bytes: "200" },
    legs: legs.complete === false ? { a1: [], b: [], a2: [] } : {
      a1: leg(legs.a1),
      b: leg(legs.b),
      a2: leg(legs.a2),
    },
  };
}

function firstAllowedCpu() {
  const list = readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  assert.equal(typeof list, "string");
  return Number(list.split(",", 1)[0].split("-", 1)[0]);
}

function resolvedFixture(root, controlFile) {
  const measured = resolveWorkloadSpec({
    version: 1,
    id: "reference-discovery-measured-fixture",
    label: "Reference discovery measured fixture",
    description: "Harmless finite process used to validate discovery artifact binding.",
    risk: "standard",
    command: {
      executable: process.execPath,
      args: ["-e", `process.exit(Number(require("node:fs").readFileSync(${JSON.stringify(
        controlFile,
      )}, "utf8")))`],
      cwd: root,
    },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 120_000, termGraceMs: 1_000, killGraceMs: 2_000 },
    outcomes: {
      targetSignals: [],
      mappedExits: [{ code: 42, category: "target-fault", label: "fixture-target" }],
    },
    capabilities: { isolated: true },
    provenance: { completeness: "complete", files: [] },
  });
  const auxiliary = resolveWorkloadSpec({
    version: 1,
    id: "reference-discovery-condition-fixture",
    label: "Reference discovery condition fixture",
    description: "Harmless waiting process used to validate discovery artifact binding.",
    risk: "standard",
    command: {
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
    },
    environment: {},
    attempt: {
      mode: "survive-window",
      timeoutMs: 120_000,
      termGraceMs: 1_000,
      killGraceMs: 2_000,
    },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: {},
    provenance: { completeness: "complete", files: [] },
  });
  return { measured, auxiliary };
}

function reportTopology(workerCpu, targetCount) {
  const candidateIds = [59_998, 59_999, 60_000, 60_001, 60_002]
    .filter((cpu) => cpu !== workerCpu);
  const targetCpus = candidateIds.slice(0, targetCount);
  const controllerCpu = candidateIds[targetCount];
  const usableCpus = [workerCpu, ...targetCpus, controllerCpu]
    .sort((left, right) => left - right);
  return {
    targetCpus,
    topology: {
      onlineCpus: usableCpus,
      allowedCpus: usableCpus,
      usableCpus,
      classes: { source: "unavailable", performanceCpus: [], efficientCpus: [] },
      cores: usableCpus.map((cpu, index) => ({
        packageId: "0",
        coreId: String(index),
        cpus: [cpu],
      })),
    },
  };
}

function outcomeCodes(legs = {}) {
  const codesForLeg = ({ target = 0, other = 0 } = {}) => [
    ...Array.from({ length: target }, () => 42),
    ...Array.from({ length: other }, () => 7),
    ...Array.from({
      length: REFERENCE_DISCOVERY_PROFILE.attemptsPerLeg - target - other,
    }, () => 0),
  ];
  return [codesForLeg(legs.a1), codesForLeg(legs.b), codesForLeg(legs.a2)].flat();
}

function createReportFixture(targetCount = 1) {
  const root = mkdtempSync(path.join(tmpdir(), "reference-discovery-report-"));
  const controlFile = path.join(root, "exit-code");
  writeFileSync(controlFile, "0", { mode: 0o600 });
  const { measured, auxiliary } = resolvedFixture(root, controlFile);
  const workerCpu = firstAllowedCpu();
  const { topology, targetCpus } = reportTopology(workerCpu, targetCount);
  const fixtureIdentity = identity();
  fixtureIdentity.measuredWorkloadDigest = measured.digest;
  fixtureIdentity.conditionWorkloadDigest = auxiliary.digest;
  const value = plan(topology, {
    targetCpus,
    loadCpus: [workerCpu],
    identity: fixtureIdentity,
  });
  let bundleIndex = 0;
  return {
    root,
    plan: value,
    async child(session, legs = {}) {
      bundleIndex += 1;
      const parent = path.join(root, `bundle-${bundleIndex}`);
      const bundleDir = path.join(parent, session.directory);
      mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
      const generation = bundleIndex.toString(16).padStart(32, "0");
      const controlledLoadManifest = buildControlledLoadSessionManifest(measured, auxiliary, {
        generation,
        attemptsPerLeg: REFERENCE_DISCOVERY_PROFILE.attemptsPerLeg,
        targetCpu: session.targetCpu,
        workerCpus: [workerCpu],
        tasksetPath: "/usr/bin/taskset",
        warmupMs: REFERENCE_DISCOVERY_PROFILE.warmupMs,
        recoveryMs: REFERENCE_DISCOVERY_PROFILE.recoveryMs,
      });
      const exactCpuManifest = buildExactCpuPhaseManifest(measured, {
        generation,
        cpus: [session.targetCpu],
        rounds: 1,
        seed: REFERENCE_DISCOVERY_PROFILE.seed,
        tasksetPath: "/usr/bin/taskset",
      });
      const manifest = buildSchema3BundleManifestV5(measured, auxiliary, {
        bundleGeneration: generation,
        controlledLoadManifest,
        exactCpuManifest,
      });
      await initializeSchema3Bundle({ resolved: measured, auxiliary, manifest, bundleDir });
      if (legs.complete !== false) {
        const codes = outcomeCodes(legs);
        let attemptIndex = 0;
        const execution = await runOneSchema3ControlledLoadSession({
          resolved: measured,
          auxiliary,
          bundleDir,
          runAttempt: async (resolved) => {
            const currentAttempt = attemptIndex++;
            writeFileSync(controlFile, String(codes[currentAttempt]), { mode: 0o600 });
            const result = structuredClone(await runWorkloadAttempt(resolved));
            if (currentAttempt >= 2 * REFERENCE_DISCOVERY_PROFILE.attemptsPerLeg) {
              const recoveryOffsetNs = BigInt(REFERENCE_DISCOVERY_PROFILE.recoveryMs + 100) *
                1_000_000n;
              for (const key of [
                "attemptStartedMonotonicNs",
                "workloadStartedMonotonicNs",
                "terminalChosenMonotonicNs",
                "cleanupFinishedMonotonicNs",
              ]) {
                result.boundary[key] = (BigInt(result.boundary[key]) + recoveryOffsetNs).toString();
              }
            }
            result.execution = {
              cpuAffinity: {
                requestedCpu: session.targetCpu,
                supervisorAllowedCpuList: String(session.targetCpu),
                workloadAllowedCpuList: String(session.targetCpu),
              },
            };
            return result;
          },
          waitInterval: async () => true,
        });
        assert.equal(execution.result.committed, true,
          `${execution.result.reason}:${execution.result.errorCode ?? "-"}`);
      }
      return readReferenceDiscoveryChild({
        plan: value,
        sessionOrdinal: session.ordinal,
        resolved: measured,
        auxiliary,
        bundleDir,
      });
    },
  };
}

function historyPair(session, generation, terminal = {}) {
  const start = {
    version: 1,
    type: "start",
    generation,
    sessionOrdinal: session.ordinal,
    targetCpu: session.targetCpu,
    bootIdSha256: HASHES.boot,
    unixMs: 1_000 + generation * 10,
  };
  return [start, {
    version: 1,
    type: "terminal",
    generation,
    sessionOrdinal: session.ordinal,
    targetCpu: session.targetCpu,
    bootIdSha256: HASHES.boot,
    unixMs: start.unixMs + 5,
    committed: terminal.committed ?? true,
    reason: terminal.reason ?? "committed",
    stage: terminal.stage ?? null,
    errorCode: terminal.errorCode ?? null,
    controllerCpu: terminal.controllerCpu ?? session.controllerCpu,
    controllerAllowedCpuList: terminal.controllerAllowedCpuList ?? String(session.controllerCpu),
  }];
}

function completedHistory(value) {
  return value.schedule.sessions.flatMap((session, index) => historyPair(session, index + 1));
}

test("automatic reference discovery plans every E-core under one fixed P-core load", () => {
  const value = plan();
  assert.equal(value.selection.mode, "automatic-hybrid");
  assert.deepEqual(value.selection.targetCpus, [2, 3, 4, 5]);
  assert.deepEqual(value.selection.loadCpus, [0, 1]);
  assert.deepEqual(value.schedule.sessions.map(({ targetCpu }) => targetCpu), [2, 4, 5, 3]);
  assert.equal(value.schedule.sessions.length, 4);
  for (const session of value.schedule.sessions) {
    assert.notEqual(session.controllerCpu, session.targetCpu);
    assert.equal(value.selection.loadCpus.includes(session.controllerCpu), false);
    assert.equal(value.selection.targetCpus.includes(session.controllerCpu), true);
  }
  assert.deepEqual(parseReferenceDiscoveryPlan(JSON.parse(
    canonicalReferenceDiscoveryPlanLine(value).toString("utf8"))), value);
  assert.equal(referenceDiscoveryWorstCaseMs(value),
    4 * (3 * 3 * (120_000 + 1_000 + 2_000) + 5_000));
});

test("class-unavailable and partial systems require explicit CPU roles", () => {
  for (const classes of [
    { source: "unavailable", performanceCpus: [], efficientCpus: [] },
    { source: "partial", performanceCpus: [0, 1], efficientCpus: [] },
  ]) {
    const topology = { ...hybridTopology(), classes };
    assert.throws(() => plan(topology), /requires complete sysfs hybrid classes/);
    const explicit = plan(topology, { targetCpus: [4], loadCpus: [0, 1] });
    assert.equal(explicit.selection.mode, "explicit");
    assert.deepEqual(explicit.selection.targetCpus, [4]);
    assert.equal([2, 3, 5].includes(explicit.schedule.sessions[0].controllerCpu), true);
  }

  const pOnlyFullMask = hybridTopology();
  pOnlyFullMask.classes = {
    source: "partial",
    performanceCpus: [...pOnlyFullMask.usableCpus],
    efficientCpus: [],
  };
  const explicit = plan(pOnlyFullMask, { targetCpus: [4], loadCpus: [0, 1] });
  assert.equal(explicit.selection.mode, "explicit");

  const observedButUnclassified = hybridTopology();
  observedButUnclassified.classes = {
    source: "partial",
    performanceCpus: [],
    efficientCpus: [],
  };
  assert.equal(plan(observedButUnclassified, {
    targetCpus: [4],
    loadCpus: [0, 1],
  }).selection.mode, "explicit");
});

test("topology parsing requires exact usable intersection and complete physical cores", () => {
  const wrongIntersection = hybridTopology();
  wrongIntersection.allowedCpus = [0, 1, 2, 3, 4];
  assert.throws(() => parseReferenceDiscoveryTopology(wrongIntersection),
    /must equal online\/allowed intersection/);

  const missingCore = hybridTopology();
  missingCore.cores = missingCore.cores.slice(0, -1);
  assert.throws(() => parseReferenceDiscoveryTopology(missingCore),
    /must cover each usable CPU exactly once/);

  const mixedCore = hybridTopology();
  mixedCore.cores = [
    { packageId: "0", coreId: "0", cpus: [0, 2] },
    { packageId: "0", coreId: "1", cpus: [1] },
    { packageId: "0", coreId: "2", cpus: [3] },
    { packageId: "0", coreId: "3", cpus: [4] },
    { packageId: "0", coreId: "4", cpus: [5] },
  ];
  assert.throws(() => parseReferenceDiscoveryTopology(mixedCore), /cannot mix P-core and E-core/);

  const unknownPackage = hybridTopology();
  unknownPackage.cores = unknownPackage.cores.map((core) => ({ ...core, packageId: "-1" }));
  assert.throws(() => parseReferenceDiscoveryTopology(unknownPackage), /identifiers are invalid/);

  const unknownCore = hybridTopology();
  unknownCore.cores = unknownCore.cores.map((core) => ({ ...core, coreId: "-1" }));
  assert.throws(() => parseReferenceDiscoveryTopology(unknownCore), /identifiers are invalid/);
});

test("every plan enforces target limits, disjoint physical roles, and a spare controller core", () => {
  const cpuCount = REFERENCE_DISCOVERY_MAX_TARGETS + 3;
  const large = {
    onlineCpus: Array.from({ length: cpuCount }, (_, cpu) => cpu),
    allowedCpus: Array.from({ length: cpuCount }, (_, cpu) => cpu),
    usableCpus: Array.from({ length: cpuCount }, (_, cpu) => cpu),
    classes: { source: "unavailable", performanceCpus: [], efficientCpus: [] },
    cores: Array.from({ length: cpuCount }, (_, cpu) => ({
      packageId: "0", coreId: String(cpu), cpus: [cpu],
    })),
  };
  assert.throws(() => plan(large, {
    targetCpus: Array.from({ length: REFERENCE_DISCOVERY_MAX_TARGETS + 1 },
      (_, index) => index + 2),
    loadCpus: [0],
  }), /one through 32 CPUs/);

  assert.throws(() => plan(hybridTopology(), { targetCpus: [1], loadCpus: [0] }),
    /shares a physical core/);
  assert.throws(() => plan(hybridTopology(), {
    targetCpus: [2], loadCpus: [0, 1, 3, 4, 5],
  }), /no independent controller physical core/);
});

test("identity and resource bindings reject runtime substitution and inconsistent headroom", () => {
  const wrongRuntime = identity();
  wrongRuntime.targetRuntime.version = "v25.3.0";
  assert.throws(() => buildReferenceDiscoveryPlan(hybridTopology(), {
    identity: wrongRuntime, host: host(), resources: resources(),
  }), /runtime versions/);

  const low = plan(hybridTopology(), {
    resources: resources({ available: 1024n ** 3n, current: null, maximum: null }),
  });
  assert.equal(low.resources.meetsMinimum, false);

  const unlimited = plan(hybridTopology(), {
    resources: resources({ current: 1024n, maximum: null }),
  });
  assert.equal(unlimited.resources.cgroupStatus, "resolved-unlimited");
  assert.equal(unlimited.resources.cgroupCurrentBytes, null);
  assert.equal(unlimited.resources.cgroupMaxBytes, null);

  const unavailable = plan(hybridTopology(), {
    resources: resources({ status: "unavailable" }),
  });
  assert.equal(unavailable.resources.effectiveHeadroomBytes, "0");
  assert.equal(unavailable.resources.meetsMinimum, false);

  const inconsistent = resources();
  inconsistent.effectiveHeadroomBytes = "1";
  assert.throws(() => plan(hybridTopology(), { resources: inconsistent }),
    /headroom is inconsistent/);

  const fat = storage();
  fat.filesystemType = "vfat";
  fat.supportsActiveState = false;
  assert.equal(plan(hybridTopology(), { storage: fat }).storage.supportsActiveState, false);
  fat.supportsActiveState = true;
  assert.throws(() => plan(hybridTopology(), { storage: fat }),
    /storage classification is inconsistent/);

  const forgedPersistent = storage();
  forgedPersistent.mountPoint = "/home/ubuntu";
  forgedPersistent.source = "overlay";
  assert.throws(() => plan(hybridTopology(), { storage: forgedPersistent }),
    /storage classification is inconsistent/);

  const loopBacked = storage();
  loopBacked.source = "/dev/loop7";
  loopBacked.classification = "unknown";
  loopBacked.warning = "WARNING: results storage persistence could not be established. Confirm this path is on mounted persistent media before running.";
  assert.equal(plan(hybridTopology(), { storage: loopBacked }).storage.classification,
    "unknown");

  const unknownType = storage();
  unknownType.filesystemType = null;
  unknownType.mountPoint = "/home/ubuntu";
  unknownType.source = null;
  unknownType.classification = "unknown";
  unknownType.supportsActiveState = false;
  unknownType.warning = "WARNING: results storage persistence could not be established. Confirm this path is on mounted persistent media before running.";
  assert.equal(plan(hybridTopology(), { storage: unknownType }).storage.supportsActiveState, false);
});

test("preview binding fixes identities, topology, roles, controllers, and storage location", () => {
  const original = plan();
  const sameSelectionWithNewCapacity = plan(hybridTopology(), {
    resources: resources({ available: 3n * 1024n ** 3n }),
    storage: { ...storage(), availableBytes: (7n * 1024n ** 3n).toString() },
  });
  assert.deepEqual(referenceDiscoveryPreviewBinding(original),
    referenceDiscoveryPreviewBinding(sameSelectionWithNewCapacity));

  const changedRoles = plan(hybridTopology(), { targetCpus: [4, 5], loadCpus: [0, 1] });
  assert.notDeepEqual(referenceDiscoveryPreviewBinding(original),
    referenceDiscoveryPreviewBinding(changedRoles));
  const changedDestination = plan(hybridTopology(), {
    storage: storage("/mnt/other-results"),
  });
  assert.notDeepEqual(referenceDiscoveryPreviewBinding(original),
    referenceDiscoveryPreviewBinding(changedDestination));
});

test("history is plan-ordered, boot-bound, bounded, and contamination is permanent", () => {
  const value = plan();
  const first = value.schedule.sessions[0];
  const second = value.schedule.sessions[1];
  const failedThenSuccessful = [
    ...historyPair(first, 1, {
      committed: false,
      reason: "owner-error",
      stage: "b",
      errorCode: "FIXTURE_FAILURE",
    }),
    ...historyPair(first, 2),
    ...historyPair(second, 3),
  ];
  const parsed = parseReferenceDiscoveryHistory(value, failedThenSuccessful);
  assert.equal(parsed.contaminated, true);
  assert.deepEqual(parsed.committedSessionOrdinals, [1, 2]);

  const open = parseReferenceDiscoveryHistory(value, [historyPair(first, 1)[0]]);
  assert.equal(open.contaminated, true);
  assert.equal(open.generations[0].terminal, null);

  const skipped = historyPair(second, 1);
  assert.throws(() => parseReferenceDiscoveryHistory(value, skipped), /planned session order/);

  const wrongBoot = historyPair(first, 1);
  wrongBoot[0].bootIdSha256 = "9".repeat(64);
  assert.throws(() => parseReferenceDiscoveryHistory(value, wrongBoot), /plan or boot/);

  const wrongController = historyPair(first, 1);
  wrongController[1].controllerCpu = second.controllerCpu;
  wrongController[1].controllerAllowedCpuList = String(second.controllerCpu);
  assert.throws(() => parseReferenceDiscoveryHistory(value, wrongController),
    /owner affinity does not match/);

  const splitController = historyPair(first, 1);
  splitController[1].controllerAllowedCpuList = null;
  assert.throws(() => parseReferenceDiscoveryHistory(value, splitController),
    /terminal fields are invalid/);
});

test("eligible reports rank only artifact-derived equal-denominator B legs", {
  timeout: 30_000,
}, async () => {
  const fixture = createReportFixture(2);
  try {
    const value = fixture.plan;
    const children = [];
    for (const [index, session] of value.schedule.sessions.entries()) {
      children.push(await fixture.child(session, {
        a1: { target: index === 1 ? 3 : 0 },
        b: { target: 2 },
      }));
    }
    const report = buildReferenceDiscoveryReport(value, children, completedHistory(value));
    const expected = [...value.selection.targetCpus].sort((left, right) => left - right)[0];
    assert.equal(report.status, "complete-candidate");
    assert.equal(report.selectionEligible, true);
    assert.equal(report.highestObservedFaultRateCandidate, expected);
    assert.equal(report.rows.find((row) => row.cpu === value.schedule.sessions[1].targetCpu)
      .withoutLoad.target, 3);
    assert.ok(canonicalReferenceDiscoveryReportLine(report).length > 0);
    const source = referenceDiscoveryConfirmationSourceBinding(value, report);
    assert.equal(source.targetCpu, expected);
    assert.equal(source.bootIdSha256, HASHES.boot);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("all-pass and retried artifact-derived reports cannot fabricate a candidate", {
  timeout: 20_000,
}, async () => {
  const fixture = createReportFixture();
  try {
    const value = fixture.plan;
    const session = value.schedule.sessions[0];
    const cleanChildren = [await fixture.child(session)];
    const cleanHistory = completedHistory(value);
    const clean = buildReferenceDiscoveryReport(value, cleanChildren, cleanHistory);
    assert.equal(clean.status, "complete-no-candidate");
    assert.equal(clean.highestObservedFaultRateCandidate, null);
    assert.throws(() => referenceDiscoveryConfirmationSourceBinding(value, clean),
      /cannot authorize confirmation/);

    const firstFailure = historyPair(session, 1, {
      committed: false,
      reason: "operational-invalid",
      stage: "a1",
      errorCode: "INVALID",
      controllerCpu: null,
      controllerAllowedCpuList: null,
    });
    const retriedHistory = [...firstFailure, ...historyPair(session, 2)];
    const retried = buildReferenceDiscoveryReport(value, cleanChildren, retriedHistory);
    assert.equal(retried.status, "complete-ineligible");
    assert.equal(retried.source.historyContaminated, true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("other outcomes and incomplete artifact-derived children are selection-ineligible", {
  timeout: 20_000,
}, async () => {
  const fixture = createReportFixture();
  try {
    const value = fixture.plan;
    const session = value.schedule.sessions[0];
    const unusableChild = await fixture.child(session, { b: { other: 1 } });
    const unusable = buildReferenceDiscoveryReport(value, [unusableChild], completedHistory(value));
    assert.equal(unusable.status, "complete-ineligible");
    assert.equal(unusable.highestObservedFaultRateCandidate, null);

    const incompleteChild = await fixture.child(session, { complete: false });
    const incomplete = buildReferenceDiscoveryReport(value, [incompleteChild], []);
    assert.equal(incomplete.status, "incomplete");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("child/history disagreement and user-edited artifacts or reports fail closed", {
  timeout: 20_000,
}, async () => {
  const fixture = createReportFixture();
  try {
    const value = fixture.plan;
    const children = [await fixture.child(value.schedule.sessions[0], { b: { target: 1 } })];
    assert.throws(() => buildReferenceDiscoveryReport(value, children, []),
      /disagrees with execution history/);

    const editedChild = structuredClone(children[0]);
    editedChild.legs.b[0].outcome.category = "pass";
    assert.throws(() => buildReferenceDiscoveryReport(value, [editedChild], completedHistory(value)),
      /not derived from an authoritative child bundle/);

    const report = buildReferenceDiscoveryReport(value, children, completedHistory(value));
    const tampered = structuredClone(report);
    tampered.highestObservedFaultRateCandidate = null;
    assert.throws(() => canonicalReferenceDiscoveryReportLine(tampered),
      /not derived from authoritative inputs/);
    assert.throws(() => referenceDiscoveryConfirmationSourceBinding(value, tampered),
      /cannot authorize confirmation|not derived from authoritative inputs/);

    const rawChild = child(value.schedule.sessions[0], { b: { target: 3 } });
    assert.throws(() => buildReferenceDiscoveryReport(value, [rawChild], completedHistory(value)),
      /not derived from an authoritative child bundle/);

    const substitutedPlan = structuredClone(value);
    substitutedPlan.identity.measuredWorkloadDigest = "9".repeat(64);
    assert.throws(() => buildReferenceDiscoveryReport(
      substitutedPlan,
      children,
      completedHistory(substitutedPlan),
    ), /not derived from an authoritative child bundle/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("history store publishes durable no-clobber pairs and reconciles identical retries", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "reference discovery history "));
  const collection = path.join(root, "collection with spaces");
  mkdirSync(collection, { mode: 0o700 });
  try {
    const value = plan();
    const [start, terminal] = historyPair(value.schedule.sessions[0], 1);
    await withReferenceDiscoveryHistoryStore({ collectionDir: collection }, async (store) => {
      assert.deepEqual((await readReferenceDiscoveryHistory(store, value)).records, []);
      await publishReferenceDiscoveryHistoryStart(store, value, start);
      await publishReferenceDiscoveryHistoryStart(store, value, start);
      const open = await readReferenceDiscoveryHistory(store, value);
      assert.equal(open.contaminated, true);
      assert.equal(open.generations[0].terminal, null);
      await publishReferenceDiscoveryHistoryTerminal(store, value, terminal);
      await publishReferenceDiscoveryHistoryTerminal(store, value, terminal);
      const complete = await readReferenceDiscoveryHistory(store, value);
      assert.equal(complete.contaminated, false);
      assert.deepEqual(complete.committedSessionOrdinals, [1]);
    });
    assert.deepEqual(readdirSync(path.join(collection, "history")).sort(), [
      "reference-discovery-history-00001-start.json",
      "reference-discovery-history-00001-terminal.json",
    ]);
    assert.equal(readFileSync(path.join(collection, "history",
      "reference-discovery-history-00001-start.json"), "utf8").endsWith("\n"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("history store rejects conflicting, out-of-order, and foreign inventory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "reference-discovery-history-"));
  const collection = path.join(root, "collection");
  mkdirSync(collection, { mode: 0o700 });
  try {
    const value = plan();
    const first = value.schedule.sessions[0];
    const second = value.schedule.sessions[1];
    await withReferenceDiscoveryHistoryStore({ collectionDir: collection }, async (store) => {
      const [start] = historyPair(first, 1);
      await publishReferenceDiscoveryHistoryStart(store, value, start);
      const conflicting = { ...start, unixMs: start.unixMs + 1 };
      await assert.rejects(
        publishReferenceDiscoveryHistoryStart(store, value, conflicting), /next generation/);
      const wrongTerminal = historyPair(second, 1)[1];
      await assert.rejects(
        publishReferenceDiscoveryHistoryTerminal(store, value, wrongTerminal),
        /open generation|close its start record/);
    });
    writeFileSync(path.join(collection, "history", "foreign.txt"), "foreign\n", { mode: 0o600 });
    await assert.rejects(withReferenceDiscoveryHistoryStore({ collectionDir: collection },
      (store) => readReferenceDiscoveryHistory(store, value)), /inventory is invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const cut of ["writing", "ready", "linked"]) {
  test(`history store recovers an interrupted ${cut} start publication`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "reference-discovery-cut-"));
    const collection = path.join(root, "collection");
    const historyDirectory = path.join(collection, "history");
    mkdirSync(historyDirectory, { recursive: true, mode: 0o700 });
    try {
      const value = plan();
      const [start] = historyPair(value.schedule.sessions[0], 1);
      const finalName = "reference-discovery-history-00001-start.json";
      const finalPath = path.join(historyDirectory, finalName);
      const bytes = Buffer.from(`${canonicalProtocolJson(start)}\n`, "utf8");
      const temporary = path.join(historyDirectory,
        `.${finalName}.99999999.0123456789abcdef.${cut === "writing" ? "writing" : "ready"}.tmp`);
      writeFileSync(temporary, cut === "writing" ? bytes.subarray(0, 10) : bytes, {
        mode: 0o600,
      });
      if (cut === "linked") linkSync(temporary, finalPath);

      await withReferenceDiscoveryHistoryStore({ collectionDir: collection }, async (store) => {
        const observed = await readReferenceDiscoveryHistory(store, value);
        assert.equal(observed.records.length, cut === "writing" ? 0 : 1);
        assert.equal(observed.contaminated, cut !== "writing");
      });
      assert.equal(readdirSync(historyDirectory).some((name) => name.startsWith(".")), false);
      assert.equal(readdirSync(historyDirectory).includes(finalName), cut !== "writing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
