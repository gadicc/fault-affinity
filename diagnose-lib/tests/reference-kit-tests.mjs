import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  REFERENCE_FORMAT_VERSION,
  REFERENCE_PROFILE,
  REFERENCE_TARGET_OUTCOMES,
  ReferenceControllerError,
  assertSafeAmbientEnvironment,
  collectMachineMetadata,
  executeReference,
  executableIdentity,
  inspectOutputStorage,
  parseCpuList,
  parseReferenceArgs,
  reviewedLaunchEnvironment,
  renderDryRunPlan,
  renderReferenceSummary,
  treeIdentity,
  validateCpuSelection,
  validateReleaseIdentity,
  validateReferenceHost,
} from "../../src/reference-kit/controller.mjs";
import {
  PrepareResultsError,
  RESULT_FILES,
  prepareResults,
  prepareResultsUsage,
} from "../../src/reference-kit/prepare-results.mjs";
import { withBundleExecutionLease } from "../bundle-execution-lease.mjs";
import { canonicalProtocolJson } from "../pinned-protocol.mjs";
import {
  classifyWorkloadAttempt,
  resolvePersistedWorkloadDescriptor,
  resolveWorkloadSpec,
  workloadLaunchEnvironment,
} from "../workload-spec.mjs";
import {
  buildControlledLoadSessionEnvelope,
  buildControlledLoadSessionManifest,
  runControlledLoadSession,
} from "../controlled-load-session.mjs";

const LAUNCHER = fileURLToPath(new URL("../../src/reference-kit/run-reference", import.meta.url));
const DISCOVERY_LAUNCHER = fileURLToPath(
  new URL("../../src/reference-kit/discover-reference", import.meta.url),
);

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(prefix) {
  const result = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(result);
  return result;
}

function options(root, overrides = []) {
  return parseReferenceArgs([
    "--results-root", root,
    "--output-name", "reference-20260910T120000Z-test",
    ...overrides,
  ]);
}

function releaseFixture() {
  return {
    schemaVersion: 1,
    release: {
      version: "0.1.0",
      tag: "v0.1.0",
      sourceCommit: "a".repeat(40),
      builtAt: "2026-09-10T12:00:00.000Z",
      platform: "linux-x64",
    },
    profile: { id: "load-aba-reference", version: 1, pgliteVersion: "0.5.4" },
    runtimes: {
      controller: { version: "v24.21.0", sha256: "b".repeat(64) },
      reference: { version: "v25.2.1", sha256: "c".repeat(64) },
    },
    components: {
      pgliteTreeSha256: "d".repeat(64),
      appTreeSha256: "e".repeat(64),
    },
  };
}

function harmlessDependencies(overrides = {}) {
  return {
    host: { platform: "linux", architecture: "x64", uid: 1000 },
    environment: { HOME: "/home/test", LANG: "C.UTF-8" },
    allowVolatileRoot: true,
    inspectStorage: () => ({
      availableBytes: String(1024 * 1024 * 1024),
      minimumRequiredBytes: String(64 * 1024 * 1024),
      mountPoint: "/media/ubuntu/RESULTS",
      filesystemType: "ext4",
      source: "/dev/test",
      classification: "likely-persistent",
      warning: null,
    }),
    readOnlineCpus: () => [0, 1, 2, 3, 4],
    readAllowedCpus: () => [0, 1, 2, 3, 4],
    readControllerCpus: () => [4],
    resolveLayout: () => ({ taskset: "/usr/bin/taskset", flock: "/usr/bin/flock" }),
    collectIdentity: () => ({ release: releaseFixture(), fixture: true }),
    collectMachineMetadata: (selection) => ({ schemaVersion: 1, fixture: true, selection }),
    waitInterval: async () => true,
    randomBytes: (size) => Buffer.alloc(size, 0x12),
    resolveWorkloads: () => ({
      measured: { version: 1, id: "reference-pglite-target", digest: "1".repeat(64) },
      auxiliary: { version: 1, id: "reference-load-worker", digest: "2".repeat(64) },
    }),
    buildManifest: (_measured, _auxiliary, value) => ({ fixture: true, ...value }),
    ...overrides,
  };
}

test("reference arguments are dry-run by default and retain exact A1/B/A2 case-study defaults", () => {
  const parsed = parseReferenceArgs([
    "--results-root", "/media/ubuntu/RESULTS",
    "--output-name", "reference-20260910T120000Z",
  ]);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.yes, false);
  assert.equal(parsed.targetCpu, 19);
  assert.deepEqual(parsed.loadCpus, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(parsed.attemptsPerLeg, 20);
  assert.throws(() => parseReferenceArgs(["--yes"]), /--results-root DIR is required/);
  assert.throws(() => parseReferenceArgs(["--results-root", "/x", "--yes", "--dry-run"]), /choose --yes/);
});

test("CPU selection is canonical, disjoint, online, and allowed", () => {
  assert.deepEqual(parseCpuList("0-2,4"), [0, 1, 2, 4]);
  assert.throws(() => parseCpuList("0,0"), ReferenceControllerError);
  assert.throws(() => parseReferenceArgs([
    "--results-root", "/x", "--output-name", "reference-20260910T120000Z",
    "--target-cpu", "1", "--load-cpus", "0-2",
  ]), /outside/);
  assert.throws(() => validateCpuSelection({ targetCpu: 3, loadCpus: [0] }, {
    onlineCpus: [0, 1], allowedCpus: [0, 1],
  }), /not online/);
  assert.equal(validateCpuSelection({ targetCpu: 3, loadCpus: [0, 1, 2], controllerCpu: "auto" }, {
    onlineCpus: [0, 1, 2, 3, 4], allowedCpus: [0, 1, 2, 3, 4],
  }).controllerCpu, 4);
  assert.throws(() => validateCpuSelection({ targetCpu: 3, loadCpus: [0, 1, 2], controllerCpu: 2 }, {
    onlineCpus: [0, 1, 2, 3, 4], allowedCpus: [0, 1, 2, 3, 4],
  }), /outside target and load/);
});

test("host validation rejects root, non-Linux, and non-x64 before execution", () => {
  assert.deepEqual(validateReferenceHost({ platform: "linux", architecture: "x64", uid: 1000 }),
    { platform: "linux", architecture: "x64", uid: 1000 });
  assert.throws(() => validateReferenceHost({ platform: "linux", architecture: "x64", uid: 0 }),
    /must not run as root/);
  assert.throws(() => validateReferenceHost({ platform: "win32", architecture: "x64", uid: null }),
    /requires Linux/);
  assert.throws(() => validateReferenceHost({ platform: "linux", architecture: "arm64", uid: 1000 }),
    /requires x86-64/);
});

test("execution applies the injectable host and output-capacity guards before creating output", async () => {
  const root = directory("reference-kit-guard-");
  const guarded = options(root, ["--target-cpu", "3", "--load-cpus", "0-2"]);
  await assert.rejects(executeReference(guarded, harmlessDependencies({
    host: { platform: "linux", architecture: "x64", uid: 0 },
  })), /must not run as root/);
  await assert.rejects(executeReference(guarded, harmlessDependencies({
    inspectStorage: () => ({ availableBytes: "1" }),
  })), /less than 67108864 available bytes/);
  await assert.rejects(executeReference({ ...guarded, dryRun: false, yes: true }, harmlessDependencies({
    inspectStorage: () => ({ availableBytes: String(1024 * 1024 * 1024), filesystemType: "exfat" }),
  })), /active results require a Unix filesystem/);
});

test("storage inspection records capacity and warns without failing on uncertain persistence", () => {
  const persistent = inspectOutputStorage("/media/ubuntu/USB/results", {
    statfs: () => ({ bavail: 1000n, bsize: 4096n }),
    readMountInfo: () => "36 25 8:1 / /media/ubuntu/USB rw - ext4 /dev/sdb1 rw\n",
  });
  assert.equal(persistent.availableBytes, "4096000");
  assert.equal(persistent.classification, "likely-persistent");
  assert.equal(persistent.warning, null);
  const uncertain = inspectOutputStorage("/home/ubuntu/results", {
    statfs: () => ({ bavail: 1000n, bsize: 4096n }),
    readMountInfo: () => { throw new Error("fixture unavailable"); },
  });
  assert.equal(uncertain.classification, "unknown");
  assert.match(uncertain.warning, /^WARNING:/);
});

test("machine comparison metadata is bounded to non-unique DMI, software, and selected CPU topology", () => {
  const values = new Map([
    ["/proc/cpuinfo", "processor : 3\nmodel name : Fixture CPU\nmicrocode : 0x12\n\nprocessor : 4\nmodel name : Fixture CPU\nmicrocode : 0x12\n"],
    ["/etc/os-release", "ID=ubuntu\nVERSION_ID=24.04\nPRETTY_NAME=Fixture Ubuntu\nSECRET=value\n"],
    ["/sys/class/dmi/id/product_name", "Fixture Product"],
  ]);
  const result = collectMachineMetadata({ controllerCpu: 4, targetCpu: 3, loadCpus: [0] }, {
    readSystemText: (file) => values.get(file) ?? "1",
  });
  assert.equal(result.dmi.productName, "Fixture Product");
  assert.equal(result.software.os.ID, "ubuntu");
  assert.deepEqual(result.cpus.map(({ role, cpu }) => [role, cpu]),
    [["controller", 4], ["target", 3], ["load", 0]]);
  assert.equal(Object.keys(result.dmi).some((key) => /serial|uuid/i.test(key)), false);
  assert.equal(Object.hasOwn(result.software.os, "SECRET"), false);
});

test("framed tree identity matches packaging path/mode/size/content framing", () => {
  const root = directory("reference-tree-");
  mkdirSync(path.join(root, "nested"), { mode: 0o700 });
  writeFileSync(path.join(root, "a.txt"), "alpha", { mode: 0o600 });
  writeFileSync(path.join(root, "nested/b.txt"), "beta", { mode: 0o640 });
  chmodSync(path.join(root, "a.txt"), 0o600);
  chmodSync(path.join(root, "nested/b.txt"), 0o640);
  const hash = createHash("sha256");
  for (const [relative, content] of [["a.txt", "alpha"], ["nested/b.txt", "beta"]]) {
    const mode = lstatSync(path.join(root, relative)).mode & 0o777;
    hash.update(relative).update("\0").update(String(mode)).update("\0")
      .update(String(Buffer.byteLength(content))).update("\0").update(content);
  }
  const identity = treeIdentity(root);
  assert.equal(identity.algorithm, "path-mode-size-content-sha256-v1");
  assert.equal(identity.files, 2);
  assert.equal(identity.bytes, 9);
  assert.equal(identity.sha256, hash.digest("hex"));
});

test("release identity rejects substituted runtimes, PGlite, app trees, and profiles", () => {
  const release = releaseFixture();
  const observed = {
    controller: { version: "v24.21.0", sha256: "b".repeat(64) },
    reference: { version: "v25.2.1", sha256: "c".repeat(64) },
    pglite: { version: "0.5.4", sha256: "d".repeat(64) },
    app: { sha256: "e".repeat(64) },
  };
  assert.equal(validateReleaseIdentity(release, observed), release);
  const cases = [
    (value, actual) => { actual.reference.sha256 = "0".repeat(64); },
    (value) => { value.runtimes.controller.sha256 = "0".repeat(64); },
    (value, actual) => { actual.pglite.sha256 = "0".repeat(64); },
    (value, actual) => { actual.app.sha256 = "0".repeat(64); },
    (value) => { value.profile.id = "different-profile"; },
  ];
  for (const mutate of cases) {
    const value = structuredClone(release);
    const actual = structuredClone(observed);
    mutate(value, actual);
    assert.throws(() => validateReleaseIdentity(value, actual),
      (error) => error instanceof ReferenceControllerError &&
        ["REFERENCE_INPUT_INVALID", "REFERENCE_RELEASE_IDENTITY_MISMATCH"].includes(error.code));
  }
});

test("controller and target environments reject injection and launch from an allowlist", () => {
  assert.throws(() => assertSafeAmbientEnvironment({ HOME: "/home/test", NODE_OPTIONS: "--inspect" }),
    /NODE_OPTIONS/);
  assert.throws(() => assertSafeAmbientEnvironment({ HOME: "/home/test", LD_PRELOAD: "" }),
    /LD_PRELOAD/);
  assert.deepEqual(reviewedLaunchEnvironment({
    HOME: "/home/test", LANG: "C.UTF-8", USER: "private-name", PATH: "/host/path",
  }), { HOME: "/home/test", LANG: "C.UTF-8", PATH: "/usr/bin:/bin" });
  const shellGuard = spawnSync(LAUNCHER, ["--help"], {
    encoding: "utf8",
    env: { HOME: "/home/test", PATH: "/usr/bin:/bin", NODE_OPTIONS: "" },
  });
  assert.equal(shellGuard.status, 2);
  assert.match(shellGuard.stderr, /NODE_OPTIONS/);
});

test("discovery launcher fixes PATH before resolving system utilities", () => {
  const fake = directory("reference-discovery-path-");
  const kit = path.join(fake, "kit");
  const marker = path.join(fake, "ambient-path-used");
  const launched = path.join(fake, "bundled-runtime-used");
  mkdirSync(path.join(kit, "bin"), { recursive: true });
  mkdirSync(path.join(kit, "runtime/controller/bin"), { recursive: true });
  mkdirSync(path.join(kit, "app/src/reference-kit"), { recursive: true });
  writeFileSync(path.join(kit, "bin/discover-reference"), readFileSync(DISCOVERY_LAUNCHER));
  chmodSync(path.join(kit, "bin/discover-reference"), 0o755);
  writeFileSync(path.join(kit, "runtime/controller/bin/node"),
    `#!/bin/sh\n/usr/bin/touch '${launched}'\nexit 0\n`);
  chmodSync(path.join(kit, "runtime/controller/bin/node"), 0o755);
  writeFileSync(path.join(kit, "app/src/reference-kit/discovery-cli.mjs"), "// fixture\n");
  for (const utility of ["dirname", "env"]) {
    const executable = path.join(fake, utility);
    writeFileSync(executable, `#!/bin/sh\n/usr/bin/touch '${marker}'\nexit 99\n`);
    chmodSync(executable, 0o755);
  }
  const result = spawnSync("/bin/sh", [path.join(kit, "bin/discover-reference"), "--help"], {
    encoding: "utf8",
    env: { HOME: fake, PATH: fake, LANG: "C.UTF-8" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(launched), true);
  assert.equal(existsSync(marker), false);
});

test("only an actual SIGSEGV is a target fault; exit 139 is an ordinary workload failure", () => {
  const cwd = directory("reference-outcomes-");
  const resolved = resolveWorkloadSpec({
    version: 1, id: "reference-pglite-target", label: "fixture", description: "fixture",
    risk: "high-memory", command: { executable: process.execPath, args: [], cwd },
    environment: { set: { PATH: "/usr/bin:/bin" } }, capabilities: {},
    provenance: { completeness: "complete", files: [] },
    attempt: { mode: "exit", timeoutMs: 1000, termGraceMs: 100, killGraceMs: 100 },
    outcomes: REFERENCE_TARGET_OUTCOMES,
  }, { environment: {}, environmentBindingKey: Buffer.alloc(32, 1) });
  const base = { terminalReason: "natural-exit", cleanupComplete: true, launchErrorCode: null };
  assert.equal(classifyWorkloadAttempt(resolved, { ...base, exitCode: 139, signal: null }).category,
    "other-workload-failure");
  assert.equal(classifyWorkloadAttempt(resolved, { ...base, exitCode: null, signal: "SIGSEGV" }).category,
    "target-fault");
  const { digest, ...descriptor } = resolved;
  const offline = resolvePersistedWorkloadDescriptor(
    JSON.parse(canonicalProtocolJson(descriptor)), digest);
  assert.equal(classifyWorkloadAttempt(offline, { ...base, exitCode: 139, signal: null }).category,
    "other-workload-failure");
  assert.throws(() => workloadLaunchEnvironment(offline), /private launch environment/);
});

test("an executable hash mismatch is rejected before candidate version code can run", () => {
  let invoked = false;
  assert.throws(() => executableIdentity(process.execPath, ["--version"], {
    version: process.version, sha256: "0".repeat(64),
  }, { execFile: () => { invoked = true; return `${process.version}\n`; } }),
  /before version inspection/);
  assert.equal(invoked, false);
});

test("result preparer help is harmless and has no path prerequisites", () => {
  assert.match(prepareResultsUsage(), /--results-root ROOT --bundle ROOT\/BUNDLE --destination DEST/);
  assert.match(prepareResultsUsage(), /exclusive bundle lease/);
});

test("dry run validates identities and CPUs but creates no output leaf or workload", async () => {
  const root = directory("reference-kit-dry-");
  let ran = false;
  const result = await executeReference(options(root, ["--target-cpu", "3", "--load-cpus", "0-2", "--runs", "2"]),
    harmlessDependencies({ runSession: async () => { ran = true; } }));
  assert.equal(result.executed, false);
  assert.equal(ran, false);
  assert.deepEqual(result.plan.schedule.map((entry) => entry.leg), ["A1", "B", "A2"]);
  assert.equal(result.plan.deadlines.attemptMs, REFERENCE_PROFILE.attemptTimeoutMs);
  assert.equal(result.plan.selection.controllerCpu, 4);
  assert.equal(result.plan.machine.fixture, true);
  assert.throws(() => readFileSync(result.plan.outputLeaf), /ENOENT/);
});

test("dry-run guidance shell-quotes an exact safe command and withholds it for uncertain storage", async () => {
  const root = directory("reference-plan-'quote-");
  const result = await executeReference(options(root, [
    "--target-cpu", "3", "--load-cpus", "0-2", "--runs", "2",
  ]), harmlessDependencies());
  const rendered = renderDryRunPlan(result.plan);
  assert.match(rendered, /Nothing was executed\./);
  assert.match(rendered, /Details:/);
  assert.match(rendered, /Release: v0\.1\.0 from a{40}/);
  assert.match(rendered, /Attempt deadline: 120 seconds/);
  assert.match(rendered, /Storage: ext4/);
  assert.match(rendered, /\.\/bin\/run-reference/);
  assert.match(rendered, /'"'"'/);
  assert.match(rendered, /'--controller-cpu' '4'/);
  assert.match(rendered, /'--target-cpu' '3'/);
  assert.match(rendered, /'--load-cpus' '0,1,2'/);
  assert.match(rendered, /'--runs' '2' '--yes'/);
  const unsafe = renderDryRunPlan({ ...result.plan,
    storage: { ...result.plan.storage, classification: "unknown", warning: "WARNING: fixture" } });
  assert.doesNotMatch(unsafe, /'--yes'/);
  assert.match(unsafe, /No --yes command is shown/);
});

test("live execution delegates through singleton controller affinity before creating output", async () => {
  const root = directory("reference-kit-reexec-");
  let observed;
  const result = await executeReference(options(root, [
    "--target-cpu", "3", "--load-cpus", "0-2", "--runs", "1", "--yes",
  ]), harmlessDependencies({
    readControllerCpus: () => [0, 1, 2, 3, 4],
    reexecController: (value) => { observed = value; return { fixture: true }; },
  }));
  assert.equal(result.delegated, true);
  assert.equal(observed.cpu, 4);
  assert.equal(existsSync(result.plan.outputLeaf), false);
});

test("a results-directory fsync failure stops before workload and removes only the empty new leaf", async () => {
  const root = directory("reference-kit-fsync-");
  let ran = false;
  const requested = options(root, [
    "--target-cpu", "3", "--load-cpus", "0-2", "--runs", "1", "--yes",
  ]);
  await assert.rejects(executeReference(requested, harmlessDependencies({
    syncDirectory: () => { throw Object.assign(new Error("fixture fsync"), { code: "EIO" }); },
    runSession: async () => { ran = true; },
  })), /fixture fsync/);
  assert.equal(ran, false);
  assert.equal(existsSync(path.join(root, requested.outputName)), false);
});

test("confirmed execution creates a new private leaf and binds the bounded worker lifecycle", async () => {
  const root = directory("reference-kit-live-fixture-");
  const expectedLeaf = path.join(root, "reference-20260910T120000Z-test");
  const stopped = [];
  const evidenceQueue = ["pass", "target-fault", "corruption"].map((category) =>
    ({ outcome: { category } }));
  const result = await executeReference(options(root, [
    "--target-cpu", "3", "--load-cpus", "0-2", "--runs", "1", "--yes",
  ]), harmlessDependencies({
    runAttempt: async () => ({ fixture: true }),
    buildAttemptEvidence: () => evidenceQueue.shift(),
    startWorkerSet: async () => ({
      startEvidence: { fixture: true },
      verify: () => ({ fixture: true }),
      stop: async (reason) => { stopped.push(reason); return { valid: true }; },
    }),
    runSession: async (value) => {
      assert.equal(value.manifest.attemptsPerLeg, 1);
      assert.equal(value.manifest.targetCpu, 3);
      assert.deepEqual(value.manifest.workerCpus, [0, 1, 2]);
      assert.equal(value.manifest.tasksetPath, "/usr/bin/taskset");
      const retained = fstatSync(value.retainedDirectory.fd, { bigint: true });
      assert.equal(retained.dev.toString(), value.retainedDirectory.device);
      assert.equal(retained.ino.toString(), value.retainedDirectory.inode);
      await assert.rejects(withBundleExecutionLease({ bundleDir: expectedLeaf }, async () => {}),
        (error) => error?.code === "BUNDLE_EXECUTION_LEASE_BUSY");
      const handle = await value.startWorkerSet({ fixture: true });
      await handle.stop("complete");
      const attempts = [];
      for (let index = 0; index < 3; index += 1) {
        await value.runAttempt({ fixture: true }, {});
        attempts.push({ evidence: [{ outcome: { category: "pass" } },
          { outcome: { category: "target-fault" } },
          { outcome: { category: "corruption" } }][index] });
      }
      return {
        committed: true,
        reason: "committed",
        attempts: {
          a1: [attempts[0]],
          b: [attempts[1]],
          a2: [attempts[2]],
        },
      };
    },
  }));
  assert.equal(result.status, "complete");
  assert.deepEqual(stopped, ["complete"]);
  const state = JSON.parse(readFileSync(path.join(result.plan.outputLeaf, "result-state.json"), "utf8"));
  assert.deepEqual(state, { formatVersion: REFERENCE_FORMAT_VERSION, status: "complete" });
  const records = readFileSync(path.join(result.plan.outputLeaf, "reference.jsonl"), "utf8")
    .trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(({ type }) => type), ["reference-start", "reference-session", "reference-end"]);
  const progressText = readFileSync(path.join(result.plan.outputLeaf, "progress.jsonl"), "utf8");
  assert.equal(progressText.includes("environmentBindingKey"), false);
  assert.equal(progressText.includes('"capsule"'), false);
  assert.equal(progressText.includes("/home/test"), false);
  assert.equal(progressText.includes("C.UTF-8"), false);
  const summary = readFileSync(path.join(result.plan.outputLeaf, "summary.md"), "utf8");
  assert.match(summary, /\| A1 \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(summary, /Timeouts, launch failures, cancellation/);
});

test("the internal loaded-window deadline is operational-incomplete, while external abort is interrupted", async () => {
  const internalRoot = directory("reference-kit-deadline-");
  let expire;
  const worker = {
    startEvidence: { fixture: true },
    verify: () => ({ fixture: true }),
    stop: async () => ({ valid: true }),
  };
  const internal = await executeReference(options(internalRoot, [
    "--target-cpu", "3", "--load-cpus", "0-2", "--runs", "1", "--yes",
  ]), harmlessDependencies({
    setTimer: (callback) => { expire = callback; return 7; },
    clearTimer: () => {},
    startWorkerSet: async () => worker,
    runSession: async (value) => {
      const handle = await value.startWorkerSet({ fixture: true });
      expire();
      assert.equal(value.signal.aborted, true);
      await handle.stop("session-invalid");
      return { committed: false, reason: "external-cancel", stage: "b", errorCode: null,
        attempts: { a1: [], b: [], a2: [] } };
    },
  }));
  assert.equal(internal.status, "operational-incomplete");

  const externalRoot = directory("reference-kit-external-");
  const externalAbort = new AbortController();
  const external = await executeReference(options(externalRoot, [
    "--target-cpu", "3", "--load-cpus", "0-2", "--runs", "1", "--yes",
  ]), harmlessDependencies({
    signal: externalAbort.signal,
    runSession: async () => {
      externalAbort.abort(new Error("fixture SIGTERM"));
      return { committed: false, reason: "external-cancel", stage: "a1", errorCode: null,
        attempts: { a1: [], b: [], a2: [] } };
    },
  }));
  assert.equal(external.status, "interrupted");
});

test("summary rendering keeps target faults separate from operational status", () => {
  const summary = renderReferenceSummary("operational-incomplete", {
    selection: { targetCpu: 3, loadCpus: [0, 1, 2], attemptsPerLeg: 2 },
    storage: { classification: "unknown", availableBytes: "100000000", warning: "WARNING: fixture" },
  }, {
    committed: false, stage: "b", reason: "operational-invalid", errorCode: "FIXTURE",
    attempts: { a1: [{ evidence: { outcome: { category: "target-fault" } } }], b: [], a2: [] },
  });
  assert.match(summary, /Operational status: \*\*operational-incomplete\*\*/);
  assert.match(summary, /\| A1 \| 1 \| 0 \| 1 \|/);
  assert.match(summary, /not counted as target faults/);
});

function fixtureBinding(value, includeAlgorithm = true) {
  const bytes = Buffer.from(`${canonicalProtocolJson(value)}\n`, "utf8");
  const binding = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  return includeAlgorithm ? { algorithm: "canonical-json-line-sha256-v1", ...binding } : binding;
}

async function resultBundle(root, name = "reference-20260910T120000Z-test", status = "complete") {
  const bundle = path.join(root, name);
  mkdirSync(bundle, { mode: 0o700 });
  const release = releaseFixture();
  const event = (type, value = {}) => ({
    formatVersion: REFERENCE_FORMAT_VERSION,
    type,
    unixMs: 1_789_041_600_000,
    monotonicNs: "1000000",
    ...value,
  });
  const child = path.join(root, `${name}-child.mjs`);
  writeFileSync(child, "process.exit(0);\n");
  const cpuText = readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  const cpus = parseCpuList(cpuText);
  assert.ok(cpus.length >= 2, "reference result fixtures require two schedulable CPUs");
  const targetCpu = cpus[0];
  const loadCpus = [cpus[1]];
  const measuredResolved = resolveWorkloadSpec({
    version: 1, id: "reference-pglite-target", label: "fixture measured",
    description: "Harmless finite reference result fixture.", risk: "high-memory",
    command: { executable: process.execPath, args: [child], cwd: root }, environment: {},
    attempt: { mode: "exit", timeoutMs: REFERENCE_PROFILE.attemptTimeoutMs,
      termGraceMs: REFERENCE_PROFILE.termGraceMs, killGraceMs: REFERENCE_PROFILE.killGraceMs },
    outcomes: { mappedExits: [], targetSignals: ["SIGSEGV"] }, capabilities: {},
    provenance: { completeness: "complete", files: [child] },
  });
  const auxiliaryResolved = resolveWorkloadSpec({
    version: 1, id: "reference-load-worker", label: "fixture auxiliary",
    description: "Harmless waiting reference result fixture.", risk: "disruptive",
    command: { executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: root },
    environment: {}, attempt: { mode: "survive-window", timeoutMs: 60_000,
      termGraceMs: REFERENCE_PROFILE.termGraceMs, killGraceMs: REFERENCE_PROFILE.killGraceMs },
    outcomes: { mappedExits: [], targetSignals: [] }, capabilities: {},
    provenance: { completeness: "complete", files: [] },
  });
  release.runtimes.reference.sha256 = measuredResolved.command.executable.sha256;
  const measured = { contractVersion: 1, id: measuredResolved.id, digest: measuredResolved.digest };
  const auxiliary = { contractVersion: 1, id: auxiliaryResolved.id, digest: auxiliaryResolved.digest };
  const fixtureManifest = buildControlledLoadSessionManifest(measuredResolved, auxiliaryResolved, {
    generation: "12".repeat(16), attemptsPerLeg: 1, targetCpu, workerCpus: loadCpus,
    tasksetPath: "/usr/bin/taskset", warmupMs: REFERENCE_PROFILE.loadWarmupMs,
    recoveryMs: 0,
  });
  const fullSession = await runControlledLoadSession({ measured: measuredResolved,
    auxiliary: auxiliaryResolved, manifest: fixtureManifest, waitInterval: async () => true });
  assert.equal(fullSession.committed, true, JSON.stringify(fullSession));
  const manifest = buildControlledLoadSessionManifest(measuredResolved, auxiliaryResolved, {
    generation: "12".repeat(16), attemptsPerLeg: 1, targetCpu, workerCpus: loadCpus,
    tasksetPath: "/usr/bin/taskset", warmupMs: REFERENCE_PROFILE.loadWarmupMs,
    recoveryMs: REFERENCE_PROFILE.recoveryMs,
  });
  const shiftedA2 = structuredClone(fullSession.attempts.a2[0]);
  for (const key of Object.keys(shiftedA2.evidence.boundary)) {
    if (shiftedA2.evidence.boundary[key] !== null) {
      shiftedA2.evidence.boundary[key] = (BigInt(shiftedA2.evidence.boundary[key]) +
        BigInt(REFERENCE_PROFILE.recoveryMs) * 1_000_000n).toString();
    }
  }
  const completeAttempts = { a1: fullSession.attempts.a1, b: fullSession.attempts.b,
    a2: [shiftedA2] };
  const completeEnvelope = buildControlledLoadSessionEnvelope(measuredResolved, auxiliaryResolved,
    manifest, { legs: [completeAttempts.a1, completeAttempts.b, completeAttempts.a2],
      workerSetStart: fullSession.condition.workerSetStart, beforeB: fullSession.condition.beforeB,
      afterB: fullSession.condition.afterB, workerSetStop: fullSession.condition.workerSetStop });
  const completeSession = { ...fullSession, attempts: completeAttempts, envelope: completeEnvelope };
  const { digest: _measuredDigest, ...measuredDescriptor } = measuredResolved;
  const { digest: _auxiliaryDigest, ...auxiliaryDescriptor } = auxiliaryResolved;
  const journalSource = status === "complete"
    ? [completeSession.attempts.a1[0], completeSession.attempts.b[0], completeSession.attempts.a2[0]]
    : [fullSession.attempts.a1[0]];
  const journalAttempts = journalSource.map((attempt, index) => ({ formatVersion: 1,
    type: "attempt-complete", ordinal: index + 1, leg: ["a1", "b", "a2"][index],
    position: 1, evidence: attempt.evidence, evidenceBinding: fixtureBinding(attempt.evidence) }));
  const plan = { formatVersion: REFERENCE_FORMAT_VERSION,
    profile: { ...REFERENCE_PROFILE, loadCpus: [...REFERENCE_PROFILE.loadCpus] },
    selection: { controllerCpu: cpus[1], targetCpu, loadCpus, attemptsPerLeg: 1 },
    identity: { release, executables: { yes: { sha256: auxiliaryResolved.command.executable.sha256 } },
      child: { sha256: measuredResolved.provenance.files[0].sha256 } } };
  const session = status === "complete" ? completeSession : {
    committed: false, reason: "runner-error", stage: "b", errorCode: "FIXTURE",
    envelope: null, attempts: { a1: [fullSession.attempts.a1[0]], b: [], a2: [] },
    condition: { workerSetStart: null, beforeB: null, afterB: null, workerSetStop: null } };
  const records = [event("reference-start", { plan }),
    event("reference-session", { status, session }), event("reference-end", { status })];
  const progress = [{ formatVersion: 1, type: "progress-start", profileId: "load-aba-reference",
    profileVersion: 1, attemptsPerLeg: 1, plannedAttempts: 3, plan,
    planBinding: fixtureBinding(plan) },
  { formatVersion: 1, type: "session-manifest", manifest, manifestBinding: fixtureBinding(manifest),
    workloads: { measured: { ...measured,
      descriptor: JSON.parse(canonicalProtocolJson(measuredDescriptor)) },
    auxiliary: { ...auxiliary,
      descriptor: JSON.parse(canonicalProtocolJson(auxiliaryDescriptor)) } } },
  ...journalAttempts,
  { formatVersion: 1, type: "progress-end", status,
    completedAttempts: journalAttempts.length }];
  writeFileSync(path.join(bundle, "reference.jsonl"), `${records.map(JSON.stringify).join("\n")}\n`);
  writeFileSync(path.join(bundle, "progress.jsonl"), `${progress.map(JSON.stringify).join("\n")}\n`);
  writeFileSync(path.join(bundle, "release.json"), `${JSON.stringify(release)}\n`);
  writeFileSync(path.join(bundle, "result-state.json"), `${JSON.stringify({ formatVersion: REFERENCE_FORMAT_VERSION, status })}\n`);
  writeFileSync(path.join(bundle, "summary.md"), "# fixture\n");
  return bundle;
}

test("result preparation is version-bound, exact-allowlist, non-mutating, and checksummed", async () => {
  const root = directory("reference-results-root-");
  const destination = directory("reference-results-destination-");
  const bundle = await resultBundle(root);
  const before = Object.fromEntries(RESULT_FILES.map((name) => [name, readFileSync(path.join(bundle, name), "utf8")]));
  const result = await prepareResults({ resultsRoot: root, bundle, destination }, {
    now: () => new Date("2026-09-10T12:00:00Z"),
    archive: async (_source, output) => writeFileSync(output, "harmless fixture archive", { flag: "wx" }),
  });
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(result.checksumFile, "utf8"), `${result.sha256}  ${path.basename(result.archive)}\n`);
  assert.deepEqual(Object.fromEntries(RESULT_FILES.map((name) => [name, readFileSync(path.join(bundle, name), "utf8")])), before);
  writeFileSync(path.join(bundle, "unexpected.txt"), "not allowed");
  await assert.rejects(prepareResults({ resultsRoot: root, bundle, destination }, {
    now: () => new Date("2026-09-10T12:00:01Z"),
  }), PrepareResultsError);
});

test("result preparation accepts a structurally consistent operational-incomplete bundle", async () => {
  const root = directory("reference-results-partial-");
  const destination = directory("reference-results-partial-destination-");
  const bundle = await resultBundle(root, "reference-20260910T120008Z-test", "operational-incomplete");
  const result = await prepareResults({ resultsRoot: root, bundle, destination }, {
    now: () => new Date("2026-09-10T12:00:08Z"),
    archive: async (_source, output) => writeFileSync(output, "partial fixture", { flag: "wx" }),
  });
  assert.equal(result.status, "operational-incomplete");
});

test("result preparation rejects journal bindings and committed attempt-count tampering", async () => {
  const root = directory("reference-results-tamper-");
  const destination = directory("reference-results-tamper-destination-");
  const bindingBundle = await resultBundle(root, "reference-20260910T120009Z-test");
  const progressFile = path.join(bindingBundle, "progress.jsonl");
  const progress = readFileSync(progressFile, "utf8").trim().split("\n").map(JSON.parse);
  progress[2].evidence.observation.exitCode = 7;
  writeFileSync(progressFile, `${progress.map(JSON.stringify).join("\n")}\n`);
  await assert.rejects(prepareResults({ resultsRoot: root, bundle: bindingBundle, destination }),
    /binding is invalid/);

  const countBundle = await resultBundle(root, "reference-20260910T120010Z-test");
  const eventFile = path.join(countBundle, "reference.jsonl");
  const events = readFileSync(eventFile, "utf8").trim().split("\n").map(JSON.parse);
  events[1].session.envelope.legs[2].attempts = [];
  writeFileSync(eventFile, `${events.map(JSON.stringify).join("\n")}\n`);
  await assert.rejects(prepareResults({ resultsRoot: root, bundle: countBundle, destination }),
    /leg must contain every scheduled attempt/);

  const scheduleBundle = await resultBundle(root, "reference-20260910T120015Z-test",
    "operational-incomplete");
  const scheduleProgressFile = path.join(scheduleBundle, "progress.jsonl");
  const scheduleProgress = readFileSync(scheduleProgressFile, "utf8")
    .trim().split("\n").map(JSON.parse);
  scheduleProgress[0].attemptsPerLeg = 2;
  scheduleProgress[0].plannedAttempts = 6;
  writeFileSync(scheduleProgressFile, `${scheduleProgress.map(JSON.stringify).join("\n")}\n`);
  await assert.rejects(prepareResults({ resultsRoot: root, bundle: scheduleBundle, destination }),
    /schedule counts do not match/);

  const relabeled = await resultBundle(root, "reference-20260910T120016Z-test",
    "operational-incomplete");
  const relabeledEventFile = path.join(relabeled, "reference.jsonl");
  const relabeledEvents = readFileSync(relabeledEventFile, "utf8")
    .trim().split("\n").map(JSON.parse);
  relabeledEvents[1].session.attempts.b = relabeledEvents[1].session.attempts.a1;
  relabeledEvents[1].session.attempts.a1 = [];
  writeFileSync(relabeledEventFile, `${relabeledEvents.map(JSON.stringify).join("\n")}\n`);
  await assert.rejects(prepareResults({ resultsRoot: root, bundle: relabeled, destination }),
    /session attempts do not match the durable journal/);

  const misplaced = await resultBundle(root, "reference-20260910T120012Z-test",
    "operational-incomplete");
  const misplacedProgressFile = path.join(misplaced, "progress.jsonl");
  const misplacedProgress = readFileSync(misplacedProgressFile, "utf8")
    .trim().split("\n").map(JSON.parse);
  misplacedProgress[2].type = "progress-end";
  misplacedProgress.at(-1).completedAttempts = 0;
  writeFileSync(misplacedProgressFile, `${misplacedProgress.map(JSON.stringify).join("\n")}\n`);
  const misplacedEventFile = path.join(misplaced, "reference.jsonl");
  const misplacedEvents = readFileSync(misplacedEventFile, "utf8")
    .trim().split("\n").map(JSON.parse);
  misplacedEvents[1].session.attempts.a1 = [];
  writeFileSync(misplacedEventFile, `${misplacedEvents.map(JSON.stringify).join("\n")}\n`);
  await assert.rejects(prepareResults({ resultsRoot: root, bundle: misplaced, destination }),
    /attempt slots are invalid/);
});

test("result preparation rejects self-rebound empty nested evidence and condition objects", async () => {
  const root = directory("reference-results-nested-");
  const destination = directory("reference-results-nested-destination-");
  const evidenceBundle = await resultBundle(root, "reference-20260910T120013Z-test");
  const progressFile = path.join(evidenceBundle, "progress.jsonl");
  const progress = readFileSync(progressFile, "utf8").trim().split("\n").map(JSON.parse);
  progress[2].evidence.boundary = {};
  progress[2].evidenceBinding = fixtureBinding(progress[2].evidence);
  writeFileSync(progressFile, `${progress.map(JSON.stringify).join("\n")}\n`);
  const eventFile = path.join(evidenceBundle, "reference.jsonl");
  const events = readFileSync(eventFile, "utf8").trim().split("\n").map(JSON.parse);
  events[1].session.attempts.a1[0].evidence = progress[2].evidence;
  events[1].session.envelope.legs[0].attempts[0].evidence = progress[2].evidence;
  events[1].session.envelope.legs[0].attempts[0].binding =
    fixtureBinding(progress[2].evidence, false);
  writeFileSync(eventFile, `${events.map(JSON.stringify).join("\n")}\n`);
  await assert.rejects(prepareResults({ resultsRoot: root, bundle: evidenceBundle, destination }),
    /attempt boundary/);

  const conditionBundle = await resultBundle(root, "reference-20260910T120014Z-test");
  const conditionFile = path.join(conditionBundle, "reference.jsonl");
  const conditionEvents = readFileSync(conditionFile, "utf8").trim().split("\n").map(JSON.parse);
  conditionEvents[1].session.envelope.condition = {
    workerSetStart: {}, beforeB: {}, afterB: {}, workerSetStop: {},
  };
  writeFileSync(conditionFile, `${conditionEvents.map(JSON.stringify).join("\n")}\n`);
  await assert.rejects(prepareResults({ resultsRoot: root, bundle: conditionBundle, destination }),
    /worker start/);
});

test("result preparation rejects active and truncated evidence", async () => {
  const root = directory("reference-results-reject-");
  const destination = directory("reference-results-reject-destination-");
  const active = await resultBundle(root, "reference-20260910T120001Z-test");
  writeFileSync(path.join(active, ".reference-active"), "");
  await assert.rejects(prepareResults({ resultsRoot: root, bundle: active, destination }), /still active/);
  rmSync(path.join(active, ".reference-active"));
  writeFileSync(path.join(active, "reference.jsonl"), "{\"formatVersion\":1");
  await assert.rejects(prepareResults({ resultsRoot: root, bundle: active, destination }), /incomplete line/);
});

test("result preparation rejects symlink bundle arguments, unknown events, and invalid releases", async () => {
  const root = directory("reference-results-schema-");
  const destination = directory("reference-results-schema-destination-");
  const bundle = await resultBundle(root, "reference-20260910T120003Z-test");
  const link = path.join(root, "reference-20260910T120004Z-link");
  symlinkSync(bundle, link);
  await assert.rejects(prepareResults({ resultsRoot: root, bundle: link, destination }), /must not be a symbolic link/);

  const events = readFileSync(path.join(bundle, "reference.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  events[1].type = "arbitrary-string";
  writeFileSync(path.join(bundle, "reference.jsonl"), `${events.map(JSON.stringify).join("\n")}\n`);
  await assert.rejects(prepareResults({ resultsRoot: root, bundle, destination }), /allowed start\/result\/end/);

  await resultBundle(root, "reference-20260910T120005Z-test");
  const invalid = path.join(root, "reference-20260910T120005Z-test");
  writeFileSync(path.join(invalid, "release.json"), "{}\n");
  await assert.rejects(prepareResults({ resultsRoot: root, bundle: invalid, destination }), /unsupported minimum schema/);
});

test("result preparation maps a held execution lease to a clear busy error", async () => {
  const root = directory("reference-results-busy-");
  const destination = directory("reference-results-busy-destination-");
  const bundle = await resultBundle(root, "reference-20260910T120007Z-test");
  await withBundleExecutionLease({ bundleDir: bundle }, async () => {
    await assert.rejects(prepareResults({ resultsRoot: root, bundle, destination }),
      (error) => error instanceof PrepareResultsError && error.code === "RESULT_BUNDLE_BUSY" &&
        /bundle is busy/.test(error.message));
  });
});

test("archive collisions fail before work and checksum races clean only invocation-owned output", async () => {
  const root = directory("reference-results-collision-");
  const destination = directory("reference-results-collision-destination-");
  const bundle = await resultBundle(root, "reference-20260910T120006Z-test");
  const base = "fault-affinity-results-20260910T120006Z.tar.gz";
  const archive = path.join(destination, base);
  const checksum = `${archive}.sha256`;
  writeFileSync(archive, "existing archive");
  let invoked = false;
  await assert.rejects(prepareResults({ resultsRoot: root, bundle, destination }, {
    now: () => new Date("2026-09-10T12:00:06Z"),
    archive: async () => { invoked = true; },
  }), /result archive already exists/);
  assert.equal(invoked, false);
  assert.equal(readFileSync(archive, "utf8"), "existing archive");
  rmSync(archive);

  await assert.rejects(prepareResults({ resultsRoot: root, bundle, destination }, {
    now: () => new Date("2026-09-10T12:00:06Z"),
    archive: async (_source, output) => {
      writeFileSync(output, "new archive", { flag: "wx" });
      writeFileSync(checksum, "external checksum", { flag: "wx" });
    },
  }), /EEXIST/);
  assert.equal(existsSync(archive), false);
  assert.equal(readFileSync(checksum, "utf8"), "external checksum");
});

test("archive publication falls back to exclusive copy for FAT/exFAT-like destinations", async () => {
  const root = directory("reference-results-copy-");
  const destination = directory("reference-results-copy-destination-");
  const bundle = await resultBundle(root, "reference-20260910T120011Z-test");
  const result = await prepareResults({ resultsRoot: root, bundle, destination }, {
    now: () => new Date("2026-09-10T12:00:11Z"),
    archive: async (_source, output) => writeFileSync(output, "copy fixture", { flag: "wx" }),
    linkFile: () => { throw Object.assign(new Error("links unsupported"), { code: "EOPNOTSUPP" }); },
  });
  assert.equal(result.publicationMode, "exclusive-copy-checksum-commit-v1");
  assert.equal(readFileSync(result.archive, "utf8"), "copy fixture");
  assert.match(readFileSync(result.checksumFile, "utf8"), /^[a-f0-9]{64}  /);
});

test("the real result archiver emits only the fixed regular-file allowlist", async () => {
  const root = directory("reference-results-tar-");
  const destination = directory("reference-results-tar-destination-");
  const bundle = await resultBundle(root);
  const result = await prepareResults({ resultsRoot: root, bundle, destination }, {
    now: () => new Date("2026-09-10T12:00:02Z"),
  });
  const listing = spawnSync("/bin/tar", ["-tzf", result.archive], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split("\n").sort(), [...RESULT_FILES].sort());
});
