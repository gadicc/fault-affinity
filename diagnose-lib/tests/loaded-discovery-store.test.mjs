import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { withBundleExecutionLease } from "../bundle-execution-lease.mjs";
import {
  buildControlledLoadSessionManifest,
  canonicalControlledLoadSessionManifestLine,
} from "../controlled-load-session.mjs";
import {
  buildExactCpuPhaseManifest,
  canonicalExactCpuPhaseManifestLine,
} from "../exact-cpu-phase.mjs";
import { createFileStateAdapter } from "../pinned-protocol.mjs";
import {
  SCHEMA3_BUNDLE_FILE,
  buildSchema3BundleManifestV5,
  canonicalSchema3BundleManifestLine,
  readSchema3Bundle,
} from "../schema3-bundle.mjs";
import { resolveWorkloadSpec } from "../workload-spec.mjs";
import {
  LOADED_DISCOVERY_PLAN_FILE,
  LOADED_DISCOVERY_REPORT_JSON_FILE,
  LOADED_DISCOVERY_REPORT_MARKDOWN_FILE,
  buildLoadedDiscoveryPlanFromTopology,
  buildLoadedDiscoveryReport,
  canonicalLoadedDiscoveryPlanLine,
  renderLoadedDiscoveryReportMarkdown,
} from "../../src/fault-affinity/loaded-discovery.mjs";
import {
  initializeLoadedDiscoveryChild,
  publishLoadedDiscoveryPlan,
  publishLoadedDiscoveryReport,
  readLoadedDiscoveryPlan,
} from "../../src/fault-affinity/loaded-discovery-store.mjs";

const directories = [];
const DEAD_PID = "99999999";
const NONCE = "0123456789abcdef";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "loaded-discovery-store-"));
  directories.push(directory);
  return directory;
}

function temporaryName(name, stage, pid = DEAD_PID, nonce = NONCE) {
  return `.${name}.${pid}.${nonce}.${stage}.tmp`;
}

// Reproduce the filesystem visible after each writer cut. No workload is
// launched: these tests exercise the real filesystem stores and their leases.
function publicationPrefix(directory, name, bytes, stage) {
  const finalPath = path.join(directory, name);
  if (stage === "committed") {
    writeFileSync(finalPath, bytes, { mode: 0o600 });
    return finalPath;
  }
  const temporaryPath = path.join(directory,
    temporaryName(name, stage === "writing" ? "writing" : "ready"));
  writeFileSync(temporaryPath,
    stage === "writing" ? bytes.subarray(0, Math.floor(bytes.length / 2)) : bytes,
    { mode: 0o600 });
  if (stage === "linked") linkSync(temporaryPath, finalPath);
  return temporaryPath;
}

function workload(directory, auxiliary = false) {
  return resolveWorkloadSpec({
    version: 1,
    id: auxiliary ? "loaded-store-auxiliary" : "loaded-store-measured",
    label: "Loaded discovery storage fixture",
    description: "Resolved only; the store tests never execute this command.",
    risk: "standard",
    command: { executable: process.execPath, args: ["-e", ""], cwd: directory },
    environment: {},
    attempt: {
      mode: auxiliary ? "survive-window" : "exit",
      timeoutMs: 100,
      termGraceMs: 50,
      killGraceMs: 500,
    },
    outcomes: { targetSignals: [], mappedExits: [] },
    capabilities: auxiliary ? {} : { isolated: true },
    provenance: { completeness: "complete", files: [] },
  });
}

function childManifest(resolved, auxiliary, fresh = false, overrides = {}, exactOverrides = {}) {
  return buildSchema3BundleManifestV5(resolved, auxiliary, {
    bundleGeneration: (fresh ? "d" : "a").repeat(32),
    controlledLoadManifest: buildControlledLoadSessionManifest(resolved, auxiliary, {
      generation: (fresh ? "e" : "b").repeat(32),
      attemptsPerLeg: 1,
      targetCpu: 2,
      workerCpus: [0],
      tasksetPath: "/usr/bin/taskset",
      warmupMs: 0,
      recoveryMs: 0,
      ...overrides,
    }),
    exactCpuManifest: buildExactCpuPhaseManifest(resolved, {
      generation: (fresh ? "f" : "c").repeat(32),
      cpus: [2],
      rounds: 1,
      seed: 17,
      tasksetPath: "/usr/bin/taskset",
      ...exactOverrides,
    }),
  });
}

function childInitializationOperations(resolved, auxiliary, manifest) {
  return [
    { name: SCHEMA3_BUNDLE_FILE,
      bytes: canonicalSchema3BundleManifestLine(resolved, manifest, auxiliary) },
    { name: "state" },
    { name: "state/controlled-load" },
    { name: "state/exact-cpu" },
    { name: "state/controlled-load/controlled-load-phase.json",
      bytes: canonicalControlledLoadSessionManifestLine(
        resolved, auxiliary, manifest.controlledLoad.manifest) },
    { name: "state/exact-cpu/exact-cpu-phase.json",
      bytes: canonicalExactCpuPhaseManifestLine(resolved, manifest.exactCpu.manifest) },
  ];
}

const CHILD_CUTS = [
  { operation: -1, stage: "empty" },
  ...[0, 1, 2, 3, 4, 5].flatMap((operation) =>
    ([0, 4, 5].includes(operation) ? ["writing", "ready", "linked", "committed"]
      : ["directory"]).map((stage) => ({ operation, stage }))),
];

for (const cut of CHILD_CUTS) {
  test(`loaded discovery resumes child initialization at ${cut.operation}/${cut.stage}`,
    async () => {
      const directory = temporaryDirectory();
      const resolved = workload(directory);
      const auxiliary = workload(directory, true);
      const original = childManifest(resolved, auxiliary);
      const fresh = childManifest(resolved, auxiliary, true);
      const operations = childInitializationOperations(resolved, auxiliary, original);
      const preserved = [];
      for (let index = 0; index <= cut.operation; index += 1) {
        const { name, bytes } = operations[index];
        if (bytes === undefined) {
          mkdirSync(path.join(directory, name), { mode: 0o700 });
          continue;
        }
        const stage = index === cut.operation ? cut.stage : "committed";
        publicationPrefix(path.dirname(path.join(directory, name)), path.basename(name),
          bytes, stage);
        if (stage === "linked" || stage === "committed") {
          preserved.push({ name, bytes, ino: statSync(path.join(directory, name)).ino });
        }
      }

      const initialized = await initializeLoadedDiscoveryChild({
        resolved, auxiliary, manifest: fresh, bundleDir: directory,
      });
      const manifestWasPublished = cut.operation > 0 ||
        (cut.operation === 0 && ["linked", "committed"].includes(cut.stage));
      assert.deepEqual(initialized.manifest, manifestWasPublished ? original : fresh);
      assert.equal(initialized.controlledLoad.progress.status, "empty");
      assert.equal(initialized.exactCpu.progress.status, "empty");
      const reread = await readSchema3Bundle({ resolved, auxiliary, bundleDir: directory });
      assert.deepEqual(reread.manifest, initialized.manifest);
      for (const { name, bytes, ino } of preserved) {
        const file = path.join(directory, name);
        assert.deepEqual(readFileSync(file), bytes);
        assert.equal(statSync(file).ino, ino);
        assert.equal(statSync(file).nlink, 1);
      }
      for (const relative of ["", "state/controlled-load", "state/exact-cpu"]) {
        assert.equal(readdirSync(path.join(directory, relative))
          .some((name) => name.endsWith(".tmp")), false);
      }
    });
}

test("loaded discovery validates the immutable child manifest before repairing directories",
  async () => {
    const directory = temporaryDirectory();
    const resolved = workload(directory);
    const auxiliary = workload(directory, true);
    const original = childManifest(resolved, auxiliary);
    const bytes = canonicalSchema3BundleManifestLine(resolved, original, auxiliary);
    publicationPrefix(directory, SCHEMA3_BUNDLE_FILE, bytes, "committed");
    for (const [overrides, exactOverrides] of [
      [{ targetCpu: 3 }], [{ workerCpus: [1] }], [{ attemptsPerLeg: 2 }],
      [{ warmupMs: 1 }], [{ recoveryMs: 1 }], [{ tasksetPath: "/other/taskset" }],
      [{}, { cpus: [3] }], [{}, { rounds: 2 }], [{}, { seed: 18 }],
      [{}, { tasksetPath: "/other/taskset" }],
    ]) {
      const manifest = childManifest(resolved, auxiliary, true, overrides, exactOverrides);
      await assert.rejects(initializeLoadedDiscoveryChild({
        resolved, auxiliary, manifest, bundleDir: directory,
      }), /does not match its planned manifest/);
      assert.deepEqual(readdirSync(directory), [SCHEMA3_BUNDLE_FILE]);
      assert.deepEqual(readFileSync(path.join(directory, SCHEMA3_BUNDLE_FILE)), bytes);
    }
  });

test("loaded discovery refuses a different resolved workload before child repair", async () => {
  const directory = temporaryDirectory();
  const resolved = workload(directory);
  const auxiliary = workload(directory, true);
  const original = childManifest(resolved, auxiliary);
  const bytes = canonicalSchema3BundleManifestLine(resolved, original, auxiliary);
  publicationPrefix(directory, SCHEMA3_BUNDLE_FILE, bytes, "committed");
  for (const [measured, condition] of [
    [workload(temporaryDirectory()), auxiliary],
    [resolved, workload(temporaryDirectory(), true)],
  ]) {
    await assert.rejects(initializeLoadedDiscoveryChild({
      resolved: measured,
      auxiliary: condition,
      manifest: childManifest(measured, condition, true),
      bundleDir: directory,
    }), /does not match/);
    assert.deepEqual(readdirSync(directory), [SCHEMA3_BUNDLE_FILE]);
    assert.deepEqual(readFileSync(path.join(directory, SCHEMA3_BUNDLE_FILE)), bytes);
  }
});

function planAndReport() {
  const plan = buildLoadedDiscoveryPlanFromTopology({
    usable: [0, 1, 2],
    classes: { source: "sysfs-hybrid", performance: [0], efficient: [1, 2] },
  }, { tasksetPath: "/usr/bin/taskset" });
  const report = buildLoadedDiscoveryReport(plan, plan.schedule.sessions.map((session) => ({
    controlledLoad: {
      manifest: {
        execution: { targetCpu: session.targetCpu, workerCpus: plan.topology.loadCpus },
        schedule: plan.schedule,
      },
      progress: { complete: true },
      envelope: {
        legs: ["a1", "b", "a2"].map((leg) => ({
          leg,
          attempts: Array.from({ length: plan.schedule.attemptsPerLeg }, () => ({
            evidence: { outcome: { category: "pass" } },
          })),
        })),
      },
    },
  })));
  return { plan, report };
}

for (const stage of ["writing", "ready", "linked", "committed"]) {
  test(`loaded discovery plan publication recovers the ${stage} cut`, async () => {
    const directory = temporaryDirectory();
    const { plan } = planAndReport();
    const bytes = canonicalLoadedDiscoveryPlanLine(plan);
    const cutPath = publicationPrefix(directory, LOADED_DISCOVERY_PLAN_FILE, bytes, stage);
    const inode = statSync(cutPath).ino;
    if (stage === "writing") {
      await assert.rejects(readLoadedDiscoveryPlan(directory), /could not be read safely/);
      assert.deepEqual(readdirSync(directory), []);
      await publishLoadedDiscoveryPlan(directory, plan);
    }
    assert.deepEqual(await readLoadedDiscoveryPlan(directory), plan);
    assert.deepEqual(readdirSync(directory), [LOADED_DISCOVERY_PLAN_FILE]);
    const finalPath = path.join(directory, LOADED_DISCOVERY_PLAN_FILE);
    assert.deepEqual(readFileSync(finalPath), bytes);
    assert.equal(statSync(finalPath).nlink, 1);
    if (stage !== "writing") assert.equal(statSync(finalPath).ino, inode);
    await publishLoadedDiscoveryPlan(directory, plan);
  });

  for (const interruptedName of [
    LOADED_DISCOVERY_REPORT_JSON_FILE, LOADED_DISCOVERY_REPORT_MARKDOWN_FILE,
  ]) {
    test(`loaded discovery report recovers ${interruptedName} at the ${stage} cut`,
      async () => {
        const directory = temporaryDirectory();
        const { plan, report } = planAndReport();
        await publishLoadedDiscoveryPlan(directory, plan);
        const reports = [
          [LOADED_DISCOVERY_REPORT_JSON_FILE, Buffer.from(`${JSON.stringify(report, null, 2)}\n`)],
          [LOADED_DISCOVERY_REPORT_MARKDOWN_FILE,
            Buffer.from(renderLoadedDiscoveryReportMarkdown(report))],
        ];
        for (const [name, bytes] of reports) {
          publicationPrefix(directory, name, bytes,
            name === interruptedName ? stage : "committed");
          if (name === interruptedName) break;
        }
        await publishLoadedDiscoveryReport(directory, report);
        await publishLoadedDiscoveryReport(directory, report);
        assert.deepEqual(readdirSync(directory).sort(),
          [LOADED_DISCOVERY_PLAN_FILE, ...reports.map(([name]) => name)].sort());
        for (const [name, bytes] of reports) {
          assert.deepEqual(readFileSync(path.join(directory, name)), bytes);
          assert.equal(statSync(path.join(directory, name)).nlink, 1);
        }
      });
  }
}

for (const name of [LOADED_DISCOVERY_PLAN_FILE, LOADED_DISCOVERY_REPORT_JSON_FILE,
  LOADED_DISCOVERY_REPORT_MARKDOWN_FILE]) {
  for (const defect of ["live writer", "symlink", "extra link", "public mode",
    "oversized", "foreign destination", "writing already linked", "duplicate"]) {
    test(`loaded discovery refuses ${defect} recovery for ${name}`, async () => {
      const directory = temporaryDirectory();
      const { plan } = planAndReport();
      const bytes = canonicalLoadedDiscoveryPlanLine(plan);
      const temporaryPath = path.join(directory, temporaryName(name,
        defect === "writing already linked" ? "writing" : "ready",
        defect === "live writer" ? String(process.pid) : DEAD_PID));
      const finalPath = path.join(directory, name);
      writeFileSync(temporaryPath, bytes, { mode: 0o600 });
      if (defect === "symlink") {
        const target = path.join(directory, "unrelated");
        writeFileSync(target, bytes, { mode: 0o600 });
        rmSync(temporaryPath);
        symlinkSync(target, temporaryPath);
      } else if (defect === "extra link") {
        linkSync(temporaryPath, path.join(directory, "unrelated"));
      } else if (defect === "public mode") {
        chmodSync(temporaryPath, 0o644);
      } else if (defect === "oversized") {
        truncateSync(temporaryPath,
          (name === LOADED_DISCOVERY_PLAN_FILE ? 1 : 16) * 1024 * 1024 + 1);
      } else if (defect === "foreign destination") {
        writeFileSync(finalPath, bytes, { mode: 0o600 });
      } else if (defect === "writing already linked") {
        linkSync(temporaryPath, finalPath);
      } else if (defect === "duplicate") {
        writeFileSync(path.join(directory, temporaryName(name, "ready", DEAD_PID,
          "fedcba9876543210")), bytes, { mode: 0o600 });
      }
      const before = readdirSync(directory).sort();
      await assert.rejects(readLoadedDiscoveryPlan(directory),
        /live writer|not safe and private|extra links|inconsistent|multiple commit temporary/);
      assert.deepEqual(readdirSync(directory).sort(), before);
      assert.equal(existsSync(temporaryPath), true);
      if (defect !== "oversized") assert.deepEqual(readFileSync(temporaryPath), bytes);
    });
  }
}

test("loaded discovery recovery leaves unfamiliar temporary files untouched", async () => {
  const directory = temporaryDirectory();
  const { plan } = planAndReport();
  const bytes = canonicalLoadedDiscoveryPlanLine(plan);
  for (const name of [
    ".loaded-discovery-private.json.99999999.0123456789abcdef.ready.tmp",
    ".loaded-discovery-report.txt.99999999.0123456789abcdef.ready.tmp",
    ".loaded-discovery.json.99999999.not-a-nonce.ready.tmp",
  ]) writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
  const original = readdirSync(directory).sort();
  assert.deepEqual((await createFileStateAdapter(directory).list()).sort(), original);
  await publishLoadedDiscoveryPlan(directory, plan);
  assert.deepEqual(await readLoadedDiscoveryPlan(directory), plan);
  for (const name of original) assert.deepEqual(readFileSync(path.join(directory, name)), bytes);
});

test("loaded discovery recovery requires exclusive ownership of the collection", async () => {
  const directory = temporaryDirectory();
  const { plan } = planAndReport();
  const bytes = canonicalLoadedDiscoveryPlanLine(plan);
  const temporaryPath = publicationPrefix(directory, LOADED_DISCOVERY_PLAN_FILE, bytes, "ready");
  await withBundleExecutionLease({ bundleDir: directory }, async () => {
    await assert.rejects(readLoadedDiscoveryPlan(directory),
      (error) => error.code === "BUNDLE_EXECUTION_LEASE_BUSY");
    assert.equal(existsSync(temporaryPath), true);
    assert.equal(existsSync(path.join(directory, LOADED_DISCOVERY_PLAN_FILE)), false);
  });
  assert.deepEqual(await readLoadedDiscoveryPlan(directory), plan);
  assert.equal(existsSync(temporaryPath), false);
});
