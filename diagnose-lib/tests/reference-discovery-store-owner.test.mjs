import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { afterEach } from "node:test";

import { readSchema3Bundle, runOneSchema3ControlledLoadSession } from "../schema3-bundle.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";
import {
  REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES,
  REFERENCE_DISCOVERY_MINIMUM_RESULTS_BYTES,
  buildReferenceDiscoveryPlan,
  canonicalReferenceDiscoveryPlanLine,
  referenceDiscoveryPreviewBinding,
  referenceDiscoveryPlanBinding,
} from "../../src/reference-kit/discovery-protocol.mjs";
import {
  collectReferenceDiscoveryTopology,
  revalidateReferenceDiscoveryContext,
  revalidateReferenceDiscoveryExecution,
  revalidateReferenceDiscoveryOwnerExecution,
} from "../../src/reference-kit/discovery-controller.mjs";
import { runReferenceDiscoverySessionProcess } from
  "../../src/reference-kit/discovery-session-client.mjs";
import { runReferenceDiscoverySessionOwner } from
  "../../src/reference-kit/discovery-session-owner.mjs";
import {
  resumeReferenceDiscoveryCampaign,
  startReferenceDiscoveryCampaign,
} from "../../src/reference-kit/discovery-campaign.mjs";
import {
  publishReferenceDiscoveryHistoryStart,
  readReferenceDiscoveryHistory,
  withReferenceDiscoveryHistoryStore,
} from "../../src/reference-kit/discovery-history-store.mjs";
import {
  REFERENCE_DISCOVERY_PLAN_FILE,
  REFERENCE_DISCOVERY_COORDINATION_DIRECTORY,
  REFERENCE_DISCOVERY_COORDINATION_FILE,
  buildReferenceDiscoveryChildManifest,
  createReferenceDiscoveryCollection,
  initializeReferenceDiscoveryChild,
  readReferenceDiscoveryPlan,
  withReferenceDiscoveryCoordinator,
} from "../../src/reference-kit/discovery-store.mjs";

const directories = [];
const descriptors = [];
afterEach(() => {
  for (const descriptor of descriptors.splice(0)) closeSync(descriptor);
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function retainedCoordinator(directory) {
  const fd = openSync(directory, "r");
  descriptors.push(fd);
  const stat = fstatSync(fd, { bigint: true });
  return { fd, device: stat.dev.toString(), inode: stat.ino.toString() };
}

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "reference-discovery-store-"));
  directories.push(directory);
  return directory;
}

function resolvedWorkloads(root) {
  const measured = resolveWorkloadSpec({
    version: 1,
    id: "reference-discovery-store-measured",
    label: "Reference discovery store measured fixture",
    description: "Resolved only; this harmless fixture is never launched.",
    risk: "standard",
    command: { executable: process.execPath, args: ["-e", ""], cwd: root },
    environment: {},
    attempt: { mode: "exit", timeoutMs: 100, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: { isolated: true },
    provenance: { completeness: "complete", files: [] },
  });
  const auxiliary = resolveWorkloadSpec({
    version: 1,
    id: "reference-discovery-store-auxiliary",
    label: "Reference discovery store auxiliary fixture",
    description: "Resolved only; this harmless fixture is never launched.",
    risk: "standard",
    command: { executable: process.execPath, args: ["-e", ""], cwd: root },
    environment: {},
    attempt: { mode: "survive-window", timeoutMs: 100, termGraceMs: 50, killGraceMs: 500 },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: {},
    provenance: { completeness: "complete", files: [] },
  });
  return { measured, auxiliary };
}

function fixture(root, { targetCpus = [2] } = {}) {
  const workloads = resolvedWorkloads(root);
  const kitRoot = path.join(root, "kit");
  const collectionDir = path.join(root, "reference-discovery-20260913T150000Z-test");
  const identity = {
    kitRoot,
    releaseFile: {
      path: path.join(kitRoot, "RELEASE.json"), sha256: "1".repeat(64), bytes: "100", mode: 0o644,
    },
    appTreeSha256: "2".repeat(64),
    pgliteTreeSha256: "3".repeat(64),
    controllerRuntime: {
      path: path.join(kitRoot, "runtime/controller/bin/node"),
      sha256: "4".repeat(64), bytes: "101", mode: 0o755, version: "v24.21.0",
    },
    targetRuntime: {
      path: path.join(kitRoot, "runtime/reference/bin/node"),
      sha256: "5".repeat(64), bytes: "102", mode: 0o755, version: "v25.2.1",
    },
    measuredWorkloadDigest: workloads.measured.digest,
    conditionWorkloadDigest: workloads.auxiliary.digest,
    taskset: { path: "/usr/bin/taskset", sha256: "6".repeat(64), bytes: "103", mode: 0o755 },
    yes: { path: "/usr/bin/yes", sha256: "7".repeat(64), bytes: "104", mode: 0o755 },
  };
  const usableCpus = [...new Set([0, 1, ...targetCpus])].sort((left, right) => left - right);
  const topology = {
    onlineCpus: usableCpus,
    allowedCpus: usableCpus,
    usableCpus,
    classes: { source: "unavailable", performanceCpus: [], efficientCpus: [] },
    cores: usableCpus.map((cpu) => ({ packageId: "0", coreId: String(cpu), cpus: [cpu] })),
  };
  const plan = buildReferenceDiscoveryPlan(topology, {
    targetCpus,
    loadCpus: [0],
    identity,
    host: {
      bootIdSha256: "8".repeat(64), machineSha256: "9".repeat(64),
      kernelRelease: "6.17.0-fixture", osReleaseSha256: "a".repeat(64),
      powerPolicySha256: null,
      microcode: usableCpus.map((cpu) => ({ cpu, value: "0x123" })),
    },
    resources: {
      memAvailableBytes: (4n * 1024n ** 3n).toString(),
      cgroupStatus: "resolved-unlimited", cgroupCurrentBytes: null, cgroupMaxBytes: null,
      effectiveHeadroomBytes: (4n * 1024n ** 3n).toString(),
      minimumHeadroomBytes: REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES.toString(),
      meetsMinimum: true,
    },
    storage: {
      resultsRoot: root,
      collectionDir,
      availableBytes: (8n * 1024n ** 3n).toString(),
      minimumRequiredBytes: REFERENCE_DISCOVERY_MINIMUM_RESULTS_BYTES.toString(),
      meetsMinimum: true,
      mountPoint: "/media/ubuntu/RESULTS", filesystemType: "ext4", source: "/dev/sdb1",
      classification: "likely-persistent", supportsActiveState: true, warning: null,
    },
  });
  return { ...workloads, plan, collectionDir };
}

function executionDependencies(plan, measured, auxiliary, root) {
  return {
    host: { platform: "linux", architecture: "x64", uid: 1000 },
    environment: { HOME: root },
    collectTopology: () => structuredClone(plan.topology),
    collectHost: () => structuredClone(plan.host),
    resolveLayout: () => ({ root: plan.identity.kitRoot, releaseFile: plan.identity.releaseFile.path }),
    collectReleaseFileIdentity: () => structuredClone(plan.identity.releaseFile),
    collectKitIdentity: () => ({}),
    environmentBindingKey: () => Buffer.alloc(32, 1),
    resolveWorkloads: () => ({ measured, auxiliary }),
    collectIdentity: () => structuredClone(plan.identity),
    collectResources: () => structuredClone(plan.resources),
    inspectStorage: () => ({
      availableBytes: plan.storage.availableBytes,
      mountPoint: plan.storage.mountPoint,
      filesystemType: plan.storage.filesystemType,
      source: plan.storage.source,
      classification: plan.storage.classification,
      warning: plan.storage.warning,
    }),
  };
}

function generationSource(prefix = "a") {
  let ordinal = 0;
  return () => `${prefix}${(ordinal++).toString(16)}`.padEnd(32, prefix).slice(0, 32);
}

test("collection publication is private, canonical, immutable, and resumable", async () => {
  const root = temporaryDirectory();
  const { plan, collectionDir } = fixture(root);
  assert.equal(await createReferenceDiscoveryCollection(plan), collectionDir);
  assert.deepEqual(await readReferenceDiscoveryPlan(collectionDir), plan);
  assert.equal(REFERENCE_DISCOVERY_PLAN_FILE, "reference-discovery-plan.json");
  assert.equal(statSync(path.join(collectionDir,
    REFERENCE_DISCOVERY_COORDINATION_DIRECTORY)).isDirectory(), true);
  assert.equal(statSync(path.join(collectionDir,
    REFERENCE_DISCOVERY_COORDINATION_FILE)).isFile(), true);
  assert.equal(await createReferenceDiscoveryCollection(plan), collectionDir);

  const changed = structuredClone(plan);
  changed.resources.memAvailableBytes = (5n * 1024n ** 3n).toString();
  changed.resources.effectiveHeadroomBytes = changed.resources.memAvailableBytes;
  await assert.rejects(createReferenceDiscoveryCollection(changed), /different content/);
});

for (const stage of ["writing", "ready", "linked"]) {
  test(`collection recovers a dead writer's ${stage} plan publication`, async () => {
    const root = temporaryDirectory();
    const { plan, collectionDir } = fixture(root);
    mkdirSync(collectionDir, { mode: 0o700 });
    const bytes = canonicalReferenceDiscoveryPlanLine(plan);
    const temporary = path.join(collectionDir,
      `.${REFERENCE_DISCOVERY_PLAN_FILE}.99999999.0123456789abcdef.${stage === "writing" ? "writing" : "ready"}.tmp`);
    writeFileSync(temporary,
      stage === "writing" ? bytes.subarray(0, Math.floor(bytes.length / 2)) : bytes,
      { mode: 0o600 });
    if (stage === "linked") linkSync(temporary, path.join(collectionDir, REFERENCE_DISCOVERY_PLAN_FILE));

    await createReferenceDiscoveryCollection(plan);
    assert.deepEqual(await readReferenceDiscoveryPlan(collectionDir), plan);
    assert.equal(readdirSync(collectionDir).some((name) => name.endsWith(".tmp")), false);
    assert.equal(statSync(path.join(collectionDir, REFERENCE_DISCOVERY_PLAN_FILE)).nlink, 1);
  });
}

test("directory-entry durability is retried after collection and child parent-sync failures",
  async () => {
    const root = temporaryDirectory();
    const { plan, collectionDir, measured, auxiliary } = fixture(root);
    await assert.rejects(createReferenceDiscoveryCollection(plan, {
      syncParent: () => { throw Object.assign(new Error("fixture fsync failure"), { code: "EIO" }); },
    }), (error) => error.code === "REFERENCE_DISCOVERY_DIRECTORY_SYNC_FAILED");
    let collectionSyncs = 0;
    await createReferenceDiscoveryCollection(plan, { syncParent: () => { collectionSyncs += 1; } });
    assert.equal(collectionSyncs, 1);

    await assert.rejects(initializeReferenceDiscoveryChild({
      collectionDir, sessionOrdinal: 1, resolved: measured, auxiliary,
      syncParent: () => { throw Object.assign(new Error("fixture fsync failure"), { code: "EIO" }); },
    }), (error) => error.code === "REFERENCE_DISCOVERY_DIRECTORY_SYNC_FAILED");
    let childSyncs = 0;
    const child = await initializeReferenceDiscoveryChild({
      collectionDir, sessionOrdinal: 1, resolved: measured, auxiliary,
      syncParent: () => { childSyncs += 1; }, newGeneration: generationSource("e"),
    });
    assert.equal(childSyncs, 1);
    assert.equal(child.bundle.manifest.version, 5);
  });

test("child initialization binds the frozen A/B/A schedule and preserves generations", async () => {
  const root = temporaryDirectory();
  const { plan, collectionDir, measured, auxiliary } = fixture(root);
  await createReferenceDiscoveryCollection(plan);
  const first = await initializeReferenceDiscoveryChild({
    collectionDir, sessionOrdinal: 1, resolved: measured, auxiliary,
    newGeneration: generationSource("a"),
  });
  assert.equal(first.bundle.manifest.version, 5);
  assert.equal(first.bundle.controlledLoad.manifest.execution.targetCpu, 2);
  assert.deepEqual(first.bundle.controlledLoad.manifest.execution.workerCpus, [0]);
  assert.equal(first.bundle.controlledLoad.manifest.schedule.attemptsPerLeg, 3);
  assert.equal(first.bundle.exactCpu.progress.status, "empty");
  const originalGeneration = first.bundle.manifest.bundleGeneration;

  const resumed = await initializeReferenceDiscoveryChild({
    collectionDir, sessionOrdinal: 1, resolved: measured, auxiliary,
    newGeneration: generationSource("b"),
  });
  assert.equal(resumed.bundle.manifest.bundleGeneration, originalGeneration);
  const reread = await readSchema3Bundle({
    resolved: measured, auxiliary, bundleDir: resumed.bundleDir,
  });
  assert.deepEqual(reread.manifest, resumed.bundle.manifest);
});

test("controlled-load execution validates the reference child inside its execution lease",
  async () => {
    const root = temporaryDirectory();
    const { plan, collectionDir, measured, auxiliary } = fixture(root);
    await createReferenceDiscoveryCollection(plan);
    const child = await initializeReferenceDiscoveryChild({
      collectionDir, sessionOrdinal: 1, resolved: measured, auxiliary,
      newGeneration: generationSource("d"),
    });
    let attemptRan = false;
    await assert.rejects(runOneSchema3ControlledLoadSession({
      resolved: measured,
      auxiliary,
      bundleDir: child.bundleDir,
      validateBundle: () => {
        throw Object.assign(new Error("fixture plan mismatch"), { code: "FIXTURE_PLAN_MISMATCH" });
      },
      runAttempt: async () => { attemptRan = true; throw new Error("must not run"); },
    }), /fixture plan mismatch/);
    assert.equal(attemptRan, false);
  });

test("child manifest and initialization reject workloads outside the stored plan", async () => {
  const root = temporaryDirectory();
  const { plan, collectionDir, measured, auxiliary } = fixture(root);
  const foreign = resolvedWorkloads(temporaryDirectory()).measured;
  assert.throws(() => buildReferenceDiscoveryChildManifest({
    plan, sessionOrdinal: 1, resolved: foreign, auxiliary,
  }), /workloads do not match/);
  await createReferenceDiscoveryCollection(plan);
  await assert.rejects(initializeReferenceDiscoveryChild({
    collectionDir, sessionOrdinal: 1, resolved: foreign, auxiliary,
  }), /workloads do not match/);
  assert.equal(measured.digest, plan.identity.measuredWorkloadDigest);
});

test("execution revalidation binds the previewed topology, host, and kit workloads", () => {
  const root = temporaryDirectory();
  const { plan, measured, auxiliary } = fixture(root);
  const dependencies = executionDependencies(plan, measured, auxiliary, root);
  const context = revalidateReferenceDiscoveryExecution(plan, dependencies);
  assert.equal(context.workloads.measured.digest, plan.identity.measuredWorkloadDigest);

  let ownerAllowance = null;
  revalidateReferenceDiscoveryOwnerExecution(plan, {
    ...dependencies,
    processAllowedCpuSpec: "65535",
    collectTopology: (options) => {
      ownerAllowance = options.processAllowedCpuSpec;
      return structuredClone(plan.topology);
    },
  });
  assert.equal(ownerAllowance, "0,1,2");

  const changed = structuredClone(plan.topology);
  changed.allowedCpus = [0, 1];
  changed.usableCpus = [0, 1];
  changed.cores = changed.cores.slice(0, 2);
  assert.throws(() => revalidateReferenceDiscoveryExecution(plan, {
    ...dependencies,
    collectTopology: () => changed,
  }), (error) => error.code === "REFERENCE_DISCOVERY_PREVIEW_MISMATCH");
});

test("read-only context revalidation does not impose live memory or storage admission", () => {
  const root = temporaryDirectory();
  const { plan, measured, auxiliary } = fixture(root);
  const dependencies = executionDependencies(plan, measured, auxiliary, root);
  dependencies.collectResources = () => { throw new Error("must not inspect live memory"); };
  dependencies.inspectStorage = () => { throw new Error("must not inspect live capacity"); };
  const context = revalidateReferenceDiscoveryContext(plan, dependencies);
  assert.equal(context.workloads.measured.digest, plan.identity.measuredWorkloadDigest);
});

test("pinned-owner topology uses its current nested cgroup rather than the root mask", () => {
  const root = temporaryDirectory();
  const { plan, measured, auxiliary } = fixture(root);
  const files = new Map([
    ["/fixture/cpu/online", "0-2\n"],
    ["/fixture/cgroup/leaf/cpuset.cpus.effective", "0-1\n"],
    ["/fixture/devices/cpu_core/cpus", "0\n"],
    ["/fixture/devices/cpu_atom/cpus", "1-2\n"],
    ...[0, 1].flatMap((cpu) => [
      [`/fixture/cpu/cpu${cpu}/topology/physical_package_id`, "0\n"],
      [`/fixture/cpu/cpu${cpu}/topology/core_id`, `${cpu}\n`],
    ]),
  ]);
  const topology = collectReferenceDiscoveryTopology({
    processAllowedCpuSpec: "0-2",
    requireResolvedCgroupCpuSet: true,
    resolveCgroupV2Paths: () => ({ paths: ["/fixture/cgroup/leaf", "/fixture/cgroup"] }),
    cpuRoot: "/fixture/cpu",
    deviceRoot: "/fixture/devices",
    readSystemFile: (filename, { optional = false } = {}) => {
      if (files.has(filename)) return files.get(filename);
      if (optional) return null;
      throw new Error(`unexpected fixture read: ${filename}`);
    },
  });
  assert.deepEqual(topology.usableCpus, [0, 1]);
  assert.equal(topology.usableCpus.includes(2), false);
  assert.throws(() => revalidateReferenceDiscoveryOwnerExecution(plan, {
    ...executionDependencies(plan, measured, auxiliary, root),
    collectTopology: () => topology,
  }), (error) => error.code === "REFERENCE_DISCOVERY_PREVIEW_MISMATCH");
});

function signalSource() {
  return new EventEmitter();
}

test("session owner re-reads the bound plan and records singleton controller affinity", async () => {
  const root = temporaryDirectory();
  const { plan, collectionDir, measured, auxiliary } = fixture(root);
  await createReferenceDiscoveryCollection(plan);
  await initializeReferenceDiscoveryChild({
    collectionDir, sessionOrdinal: 1, resolved: measured, auxiliary,
    newGeneration: generationSource("c"),
  });
  let sessionRun = false;
  let directoryValidations = 0;
  let record = "";
  const exitCode = await runReferenceDiscoverySessionOwner([
    collectionDir, "1", referenceDiscoveryPlanBinding(plan).sha256, "1", "2", "3", "4",
  ], {
    signalSource: signalSource(),
    readAllowedCpuList: () => "1",
    revalidate: async () => ({ workloads: { measured, auxiliary } }),
    validateRetainedDirectories: () => { directoryValidations += 1; return true; },
    runSession: async ({ attemptOptions, validateBundle, bundleDir }) => {
      sessionRun = true;
      assert.equal(attemptOptions.signal.aborted, false);
      validateBundle(await readSchema3Bundle({ resolved: measured, auxiliary, bundleDir }));
      return { result: { committed: true, reason: "committed", stage: "complete" } };
    },
    record: (value) => { record += value; },
    stderr: () => {},
  });
  assert.equal(exitCode, 0);
  assert.equal(sessionRun, true);
  assert.equal(directoryValidations, 5);
  assert.deepEqual(JSON.parse(record), {
    version: 1, committed: true, reason: "committed", stage: "complete",
    errorCode: null, detail: "complete: committed",
    controllerCpu: 1, controllerAllowedCpuList: "1",
  });
});

test("session owner fails closed before revalidation when its affinity or plan binding is wrong",
  async () => {
    const root = temporaryDirectory();
    const { plan, collectionDir } = fixture(root);
    await createReferenceDiscoveryCollection(plan);
    let revalidated = false;
    for (const [binding, allowed, expectedCode] of [
      ["f".repeat(64), "1", "REFERENCE_DISCOVERY_PLAN_MISMATCH"],
      [referenceDiscoveryPlanBinding(plan).sha256, "0-1", "REFERENCE_DISCOVERY_CONTROLLER_INVALID"],
    ]) {
      let record = "";
      const exitCode = await runReferenceDiscoverySessionOwner([
        collectionDir, "1", binding, "1", "2", "3", "4",
      ], {
        signalSource: signalSource(),
        readAllowedCpuList: () => allowed,
        validateRetainedDirectories: () => true,
        revalidate: async () => { revalidated = true; },
        record: (value) => { record += value; },
        stderr: () => {},
      });
      assert.equal(exitCode, 2);
      assert.equal(JSON.parse(record).errorCode, expectedCode);
    }
    assert.equal(revalidated, false);
  });

function fakeChild(record, { overflow = false, code = 0, signal = null } = {}) {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.stdio = [null, null, child.stderr, new PassThrough()];
  child.kills = [];
  child.kill = (signal) => { child.kills.push(signal); return true; };
  process.nextTick(() => {
    child.stdio[3].write(overflow ? Buffer.alloc(64 * 1024 + 1) : `${JSON.stringify(record)}\n`);
    child.stdio[3].end();
    child.stderr.end();
    child.emit("close", overflow ? null : code, overflow ? "SIGTERM" : signal);
  });
  return child;
}

test("session client launches only the bundled owner under planned singleton taskset affinity",
  async () => {
    const root = temporaryDirectory();
    const { plan, collectionDir } = fixture(root);
    let invocation;
    const record = {
      version: 1, committed: true, reason: "committed", stage: "complete",
      errorCode: null, detail: null, controllerCpu: 1, controllerAllowedCpuList: "1",
    };
    const result = await runReferenceDiscoverySessionProcess({
      plan,
      sessionOrdinal: 1,
      collectionDir,
      retainedCoordinator: retainedCoordinator(root),
      retainedCollection: retainedCoordinator(root),
      environment: { HOME: root, LANG: "C.UTF-8" },
      ownerPath: "/fixture/discovery-session-owner.mjs",
      spawnProcess: (file, args, options) => {
        invocation = { file, args, options };
        return fakeChild(record);
      },
    });
    assert.deepEqual(result.record, record);
    assert.equal(invocation.file, "/usr/bin/taskset");
    assert.deepEqual(invocation.args.slice(0, 4), [
      "-c", "1", plan.identity.controllerRuntime.path,
      "/fixture/discovery-session-owner.mjs",
    ]);
    assert.deepEqual(invocation.args.slice(4, 7), [
      collectionDir, "1", referenceDiscoveryPlanBinding(plan).sha256,
    ]);
    assert.equal(invocation.args.slice(7).every((value) => /^[0-9]+$/.test(value)), true);
    assert.deepEqual(invocation.options.env, { HOME: root, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
    assert.equal(invocation.options.shell, false);
    assert.equal(Number.isSafeInteger(invocation.options.stdio[4]), true);
    assert.equal(Number.isSafeInteger(invocation.options.stdio[5]), true);
  });

test("session client bounds owner output and terminates an overflowing child", async () => {
  const root = temporaryDirectory();
  const { plan, collectionDir } = fixture(root);
  let child;
  await assert.rejects(runReferenceDiscoverySessionProcess({
    plan,
    sessionOrdinal: 1,
    collectionDir,
    retainedCoordinator: retainedCoordinator(root),
    retainedCollection: retainedCoordinator(root),
    environment: { HOME: root },
    ownerPath: "/fixture/discovery-session-owner.mjs",
    spawnProcess: () => { child = fakeChild({}, { overflow: true }); return child; },
  }), (error) => error.code === "REFERENCE_DISCOVERY_OWNER_OUTPUT_LIMIT");
  assert.deepEqual(child.kills, ["SIGTERM"]);
});

test("session client rejects a wrong controller witness and committed nonzero exit", async () => {
  const root = temporaryDirectory();
  const { plan, collectionDir } = fixture(root);
  const committed = {
    version: 1, committed: true, reason: "committed", stage: "complete",
    errorCode: null, detail: null, controllerCpu: 1, controllerAllowedCpuList: "1",
  };
  for (const [record, childOptions, pattern] of [
    [{ ...committed, controllerCpu: 2, controllerAllowedCpuList: "2" }, {},
      /wrong controller affinity/],
    [committed, { code: 2 }, /requires a successful owner exit/],
  ]) {
    await assert.rejects(runReferenceDiscoverySessionProcess({
      plan,
      sessionOrdinal: 1,
      collectionDir,
      retainedCoordinator: retainedCoordinator(root),
      retainedCollection: retainedCoordinator(root),
      environment: { HOME: root },
      ownerPath: "/fixture/discovery-session-owner.mjs",
      spawnProcess: () => fakeChild(record, childOptions),
    }), pattern);
  }
});

function campaignDependencies(plan, measured, auxiliary, state = {}) {
  let clock = 10_000;
  return {
    revalidateExecution: async () => {
      if (state.requireCollectionBeforeRevalidation === true) {
        assert.equal(statSync(plan.storage.collectionDir).isDirectory(), true);
      }
      return { workloads: { measured, auxiliary } };
    },
    revalidateContext: async () => ({ workloads: { measured, auxiliary } }),
    initializeChild: async () => {},
    readChild: async ({ sessionOrdinal }) => ({
      complete: state.completeOrdinals instanceof Set
        ? state.completeOrdinals.has(sessionOrdinal)
        : state.complete === true,
    }),
    buildReport: (_plan, children, history) => Object.freeze({
      version: 1,
      complete: children.every((child) => child.complete),
      historyRecords: history.length,
    }),
    publishReport: async ({ report }) => {
      state.published = report;
      return Object.freeze({ fixture: true });
    },
    verifyReportPublication: async () => null,
    now: () => clock++,
    runSession: state.runSession,
  };
}

async function storedHistory(collectionDir, plan) {
  return withReferenceDiscoveryHistoryStore({ collectionDir },
    (store) => readReferenceDiscoveryHistory(store, plan));
}

test("campaign durably brackets a committed owner and publishes only after the final session",
  async () => {
    const root = temporaryDirectory();
    const { plan, collectionDir, measured, auxiliary } = fixture(root);
    const state = {
      complete: false,
      requireCollectionBeforeRevalidation: true,
      runSession: async ({ retainedCoordinator, sessionOrdinal }) => {
        const stat = fstatSync(retainedCoordinator.fd, { bigint: true });
        assert.equal(stat.dev.toString(), retainedCoordinator.device);
        assert.equal(sessionOrdinal, 1);
        state.complete = true;
        return {
          reaped: true,
          code: 0,
          signal: null,
          stderr: "",
          record: {
            version: 1, committed: true, reason: "committed", stage: "complete",
            errorCode: null, detail: null, controllerCpu: 1,
            controllerAllowedCpuList: "1",
          },
        };
      },
    };
    const result = await startReferenceDiscoveryCampaign(plan, {
      yes: true,
      expectedPreviewSha256: referenceDiscoveryPreviewBinding(plan).sha256,
      environment: { HOME: root },
    }, campaignDependencies(plan, measured, auxiliary, state));
    assert.equal(result.report.complete, true);
    assert.deepEqual(result.publication, { fixture: true });
    const history = await storedHistory(collectionDir, plan);
    assert.equal(history.generations.length, 1);
    assert.equal(history.generations[0].terminal.committed, true);
    assert.equal(history.generations[0].start.coordinatorPid, process.pid);
    assert.match(history.generations[0].start.coordinatorStartTicks, /^[0-9]+$/);
    await assert.rejects(startReferenceDiscoveryCampaign(plan, {
      yes: true,
      expectedPreviewSha256: referenceDiscoveryPreviewBinding(plan).sha256,
      environment: { HOME: root },
    }, campaignDependencies(plan, measured, auxiliary, state)), /use explicit resume/);
  });

test("campaign leaves an open generation when owner reaping is not established", async () => {
  const root = temporaryDirectory();
  const { plan, collectionDir, measured, auxiliary } = fixture(root);
  const state = {
    runSession: async () => {
      throw Object.assign(new Error("fixture transport uncertainty"), {
        code: "FIXTURE_TRANSPORT_UNCERTAIN",
      });
    },
  };
  await assert.rejects(startReferenceDiscoveryCampaign(plan, {
    yes: true,
    expectedPreviewSha256: referenceDiscoveryPreviewBinding(plan).sha256,
    environment: { HOME: root },
  }, campaignDependencies(plan, measured, auxiliary, state)), /transport uncertainty/);
  const history = await storedHistory(collectionDir, plan);
  assert.equal(history.generations.length, 1);
  assert.equal(history.generations[0].terminal, null);
});

test("campaign refuses coordination-directory replacement before history or owner launch",
  async () => {
    const root = temporaryDirectory();
    const { plan, collectionDir, measured, auxiliary } = fixture(root);
    let ownerRan = false;
    const state = {
      runSession: async () => { ownerRan = true; throw new Error("must not run"); },
    };
    const dependencies = campaignDependencies(plan, measured, auxiliary, state);
    dependencies.revalidateExecution = async () => {
      const coordination = path.join(collectionDir, REFERENCE_DISCOVERY_COORDINATION_DIRECTORY);
      renameSync(coordination, `${coordination}-replaced`);
      mkdirSync(coordination, { mode: 0o700 });
      return { workloads: { measured, auxiliary } };
    };
    await assert.rejects(startReferenceDiscoveryCampaign(plan, {
      yes: true,
      expectedPreviewSha256: referenceDiscoveryPreviewBinding(plan).sha256,
      environment: { HOME: root },
    }, dependencies), /coordination|execution lease no longer names/);
    assert.equal(ownerRan, false);
    const historyDir = path.join(collectionDir, "history");
    assert.throws(() => statSync(historyDir), (error) => error.code === "ENOENT");
    await assert.rejects(withReferenceDiscoveryCoordinator({ collectionDir }, async () => {}),
      /identity changed/);
  });

test("resume reconciles an open generation only after acquiring campaign and child leases",
  async () => {
    const root = temporaryDirectory();
    const { plan, collectionDir, measured, auxiliary } = fixture(root);
    await createReferenceDiscoveryCollection(plan);
    await withReferenceDiscoveryHistoryStore({ collectionDir }, async (store) => {
      await publishReferenceDiscoveryHistoryStart(store, plan, {
        version: 1,
        type: "start",
        generation: 1,
        sessionOrdinal: 1,
        targetCpu: 2,
        bootIdSha256: plan.host.bootIdSha256,
        unixMs: 1_000,
        coordinatorPid: 999_999,
        coordinatorStartTicks: "1",
      });
    });
    let ownerRan = false;
    const state = {
      runSession: async () => { ownerRan = true; throw new Error("must not run"); },
    };
    const result = await resumeReferenceDiscoveryCampaign(collectionDir, {
      yes: true,
      environment: { HOME: root },
    }, campaignDependencies(plan, measured, auxiliary, state));
    assert.equal(ownerRan, false);
    assert.equal(result.report.complete, false);
    const history = await storedHistory(collectionDir, plan);
    assert.equal(history.generations[0].terminal.reason, "reconciled-interruption");
    assert.equal(history.generations[0].terminal.committed, false);
  });

test("campaign records a reaped client failure as a terminal owner error", async () => {
  const root = temporaryDirectory();
  const { plan, collectionDir, measured, auxiliary } = fixture(root);
  const state = {
    runSession: async () => {
      throw Object.assign(new Error("fixture owner output invalid"), {
        code: "FIXTURE_OWNER_INVALID",
        reaped: true,
      });
    },
  };
  const result = await startReferenceDiscoveryCampaign(plan, {
    yes: true,
    expectedPreviewSha256: referenceDiscoveryPreviewBinding(plan).sha256,
    environment: { HOME: root },
  }, campaignDependencies(plan, measured, auxiliary, state));
  assert.equal(result.stoppedAfterSession, 1);
  const history = await storedHistory(collectionDir, plan);
  assert.equal(history.generations[0].terminal.reason, "owner-error");
  assert.equal(history.generations[0].terminal.errorCode, "FIXTURE_OWNER_INVALID");
});

test("resume skips a failed session and continues only untouched target sessions", async () => {
  const root = temporaryDirectory();
  const { plan, collectionDir, measured, auxiliary } = fixture(root, {
    targetCpus: [2, 3],
  });
  const calls = [];
  const state = {
    completeOrdinals: new Set(),
    runSession: async ({ sessionOrdinal }) => {
      calls.push(sessionOrdinal);
      return {
        reaped: true,
        code: 2,
        signal: null,
        stderr: "fixture failure",
        record: {
          version: 1, committed: false, reason: "operational-invalid", stage: "b",
          errorCode: "FIXTURE_OPERATIONAL_INVALID", detail: null,
          controllerCpu: null, controllerAllowedCpuList: null,
        },
      };
    },
  };
  const first = await startReferenceDiscoveryCampaign(plan, {
    yes: true,
    expectedPreviewSha256: referenceDiscoveryPreviewBinding(plan).sha256,
    environment: { HOME: root },
  }, campaignDependencies(plan, measured, auxiliary, state));
  assert.equal(first.stoppedAfterSession, 1);
  assert.equal(first.publication, null);

  state.runSession = async ({ sessionOrdinal }) => {
    calls.push(sessionOrdinal);
    state.completeOrdinals.add(sessionOrdinal);
    const session = plan.schedule.sessions[sessionOrdinal - 1];
    return {
      reaped: true,
      code: 0,
      signal: null,
      stderr: "",
      record: {
        version: 1, committed: true, reason: "committed", stage: "complete",
        errorCode: null, detail: null, controllerCpu: session.controllerCpu,
        controllerAllowedCpuList: String(session.controllerCpu),
      },
    };
  };
  const resumed = await resumeReferenceDiscoveryCampaign(collectionDir, {
    yes: true,
    environment: { HOME: root },
  }, campaignDependencies(plan, measured, auxiliary, state));
  assert.deepEqual(calls, [1, 2]);
  assert.equal(resumed.report.complete, false);
  assert.deepEqual(resumed.publication, { fixture: true });
  const history = await storedHistory(collectionDir, plan);
  assert.deepEqual(history.generations.map((generation) => generation.start.sessionOrdinal), [1, 2]);
  assert.deepEqual(history.generations.map((generation) => generation.terminal.committed),
    [false, true]);
});
