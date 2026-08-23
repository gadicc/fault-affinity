import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseFaultAffinityArgs,
  runFaultAffinityCli,
} from "../../fault-affinity.mjs";
import { readLinuxAllowedCpuList } from "../attempt-runner.mjs";
import { runDebuggerAttempt } from "../debugger-attempt-runner.mjs";
import {
  buildSchema3BundleManifestV6,
  initializeSchema3Bundle,
  runOneSchema3DebuggerAttempt,
} from "../schema3-bundle.mjs";
import { buildDebuggerPhaseManifest } from "../debugger-phase.mjs";
import { buildExactCpuPhaseManifest } from "../exact-cpu-phase.mjs";
import { BundleExecutionLeaseError } from "../bundle-execution-lease.mjs";
import { expandCpuList } from "../pinned-runner.mjs";
import {
  customWorkloadEnvironmentBindingKey,
  resolveCustomWorkloadFile,
} from "../../workloads/catalog.mjs";

const FAKE_DEBUGGER = fileURLToPath(
  new URL("./fixtures/fake-debugger-fixture.mjs", import.meta.url),
);

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "debugger-cli-"));
  directories.push(directory);
  return directory;
}

function allowedCpu() {
  const spec = readLinuxAllowedCpuList(process.pid, { strict: true });
  return expandCpuList(spec)[0];
}

function capture(directory) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
      cwd: directory,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function fixture(directory, { mode = "exited", environment = {} } = {}) {
  const debuggerPath = path.join(directory, "fake-debugger");
  writeFileSync(debuggerPath,
    `#!${process.execPath}\nimport ${JSON.stringify(FAKE_DEBUGGER)};\n`,
    { mode: 0o700 });
  const targetPath = path.join(directory, "target-fixture");
  writeFileSync(targetPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const definition = path.join(directory, "debugger-target.json");
  writeFileSync(definition, `${JSON.stringify({
    version: 1,
    id: "debugger-cli-fixture",
    label: "Debugger CLI fixture",
    description: "Harmless finite process for the public debugger command tests.",
    risk: "standard",
    command: { executable: targetPath, args: [], cwd: directory },
    environment: {
      set: { FAKE_DEBUGGER_MODE: mode, ...environment },
    },
    attempt: { mode: "exit", timeoutMs: 5_000, termGraceMs: 100, killGraceMs: 500 },
    outcomes: { targetSignals: ["SIGSEGV", "SIGUSR2"], mappedExits: [] },
    capabilities: { isolated: true, gdb: true },
    provenance: { completeness: "complete", files: [] },
  })}\n`, { mode: 0o600 });
  return { debuggerPath, targetPath, definition };
}

async function waitForOutput(captured, marker, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (captured.stdout().includes(marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for CLI output: ${marker}`);
}

test("debugger command parsing enforces selection, bounds, and mode conflicts", () => {
  assert.throws(() => parseFaultAffinityArgs(["debugger"]), /select exactly one/);
  assert.throws(() => parseFaultAffinityArgs([
    "debugger", "--workload", "wasm-churn-debugger", "--dry-run",
  ]), /requires --cpu/);
  assert.throws(() => parseFaultAffinityArgs([
    "debugger", "--workload", "wasm-churn-debugger", "--cpu", "0", "--max-runs", "2",
    "--max-captures", "1", "--out-dir", "bundle", "--dry-run",
  ]), /requires --debugger/);
  assert.throws(() => parseFaultAffinityArgs([
    "debugger", "--workload", "wasm-churn-debugger", "--cpu", "0", "--max-runs", "2",
    "--max-captures", "1", "--debugger", "/bin/true", "--out-dir", "bundle",
  ]), /choose exactly one --dry-run or --yes/);
  assert.throws(() => parseFaultAffinityArgs([
    "debugger", "--workload", "wasm-churn-debugger", "--cpu", "0", "--max-runs", "2",
    "--max-captures", "3", "--debugger", "/bin/true", "--out-dir", "bundle", "--yes",
  ]), /--max-captures cannot exceed --max-runs/);
  assert.throws(() => parseFaultAffinityArgs([
    "debugger", "--workload", "wasm-churn-debugger", "--cpu", "01", "--max-runs", "2",
    "--max-captures", "1", "--debugger", "/bin/true", "--out-dir", "bundle", "--yes",
  ]), /canonical decimal integer/);
  assert.throws(() => parseFaultAffinityArgs([
    "debugger", "--workload", "wasm-churn-debugger", "--cpu", "0", "--max-runs", "2",
    "--max-captures", "1", "--debugger", "/bin/true", "--out-dir", "bundle", "--yes",
    "--resume", "other",
  ]), /--resume cannot be combined with fresh debugger options/);
  assert.throws(() => parseFaultAffinityArgs([
    "debugger", "--resume", "bundle", "--workload", "wasm-churn-debugger",
  ]), /debugger resume requires --yes/);
  assert.throws(() => parseFaultAffinityArgs([
    "debugger", "--workload", "wasm-churn-debugger", "--cpu", "0", "--max-runs", "2",
    "--max-captures", "1", "--debugger", "/bin/true", "--out-dir", "bundle", "--yes",
    "--bogus",
  ]), /unknown option/);

  const parsed = parseFaultAffinityArgs([
    "debugger", "--workload", "wasm-churn-debugger", "--cpu", "4", "--max-runs", "6",
    "--max-captures", "3", "--debugger", "/usr/bin/gdb", "--out-dir", "bundle",
    "--dry-run",
  ]);
  assert.deepEqual(parsed, {
    command: "debugger",
    mode: "dry-run",
    workload: "wasm-churn-debugger",
    cpu: 4,
    maxRuns: 6,
    maxCaptures: 3,
    debuggerPath: "/usr/bin/gdb",
    outDir: "bundle",
    tasksetPath: "/usr/bin/taskset",
  });
});

test("the debugger built-in profiles declare gdb capability and stay finite", async () => {
  const directory = temporaryDirectory();
  for (const id of ["wasm-churn-debugger", "node-pglite-debugger"]) {
    const captured = capture(directory);
    assert.equal(await runFaultAffinityCli(["inspect", "--workload", id, "--json"],
      captured.io), 0);
    const summary = JSON.parse(captured.stdout());
    assert.equal(summary.capabilities.gdb, true);
    assert.equal(summary.capabilities.isolated, true);
    assert.equal(summary.attempt.mode, "exit");
    assert.match(summary.liveWarning, /transcripts retain workload output verbatim/);
    assert.match(captured.stdout(), /"gdb": true/);
  }
  const listed = capture(directory);
  assert.equal(await runFaultAffinityCli(["workloads"], listed.io), 0);
  assert.match(listed.stdout(), /wasm-churn-debugger/);
  assert.match(listed.stdout(), /node-pglite-debugger/);
  assert.equal(readdirSync(directory).filter((name) => !name.endsWith(".json")).length, 0);
});

test("a debugger dry run prints the plan and creates nothing", async () => {
  const directory = temporaryDirectory();
  const files = fixture(directory);
  const output = path.join(directory, "planned-debugger-bundle");
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "debugger", "--workload-file", path.basename(files.definition),
    "--cpu", String(allowedCpu()), "--max-runs", "4", "--max-captures", "2",
    "--debugger", files.debuggerPath, "--out-dir", path.basename(output), "--dry-run",
  ], captured.io);

  assert.equal(rc, 0, captured.stderr());
  assert.equal(existsSync(output), false);
  assert.match(captured.stdout(), /debugger CPU \d+; 4 run\(s\); 2 capture\(s\)/);
  assert.match(captured.stdout(), /host allowance:/);
  assert.match(captured.stdout(), /transcripts retain verbatim workload output/);
  assert.match(captured.stdout(), /dry run: no workload executed and no bundle created/);
  assert.equal(captured.stderr(), "");
});

test("a live debugger run commits to the capture cap and summarizes per run", async () => {
  const directory = temporaryDirectory();
  const files = fixture(directory, { mode: "stopped" });
  const bundleDir = path.join(directory, "debugger-bundle");
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "debugger", "--workload-file", path.basename(files.definition),
    "--cpu", String(allowedCpu()), "--max-runs", "4", "--max-captures", "2",
    "--debugger", files.debuggerPath, "--out-dir", path.basename(bundleDir), "--yes",
  ], captured.io);

  assert.equal(rc, 0, captured.stderr());
  assert.match(captured.stdout(), /committed run=1 outcome=captured signal=SIGSEGV/);
  assert.match(captured.stdout(), /committed run=2 outcome=captured signal=SIGSEGV/);
  assert.match(captured.stdout(), /complete: 2\/4 debugger runs \(2\/2 captures\)/);

  const summary = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "summarize", "--bundle-dir", path.basename(bundleDir),
    "--workload-file", path.basename(files.definition),
  ], summary.io), 0);
  assert.match(summary.stdout(), /debugger: complete; 2\/4 runs; captured 2\/2/);
  assert.match(summary.stdout(), /run 1: captured signal=SIGSEGV target=yes/);
  assert.match(summary.stdout(), /run 2: captured signal=SIGSEGV target=yes/);

  const summaryJson = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "summarize", "--bundle-dir", path.basename(bundleDir),
    "--workload-file", path.basename(files.definition), "--json",
  ], summaryJson.io), 0);
  const parsed = JSON.parse(summaryJson.stdout());
  assert.equal(parsed.bundle.manifestVersion, 6);
  assert.deepEqual(parsed.phases.debugger.outcomes, [{ kind: "captured", count: 2 }]);
  assert.equal(parsed.phases.debugger.runs.length, 2);
  assert.equal(parsed.phases.debugger.runs[0].outcome.signal, "SIGSEGV");
  assert.equal(parsed.phases.debugger.runs[0].artifacts.transcript,
    "state/debugger/debugger-attempt-000000001-transcript");
  assert.equal(parsed.phases.debugger.runs[0].artifacts.control,
    "state/debugger/debugger-attempt-000000001-control");
});

test("the run cap completes clean runs and resume is idempotent", async () => {
  const directory = temporaryDirectory();
  const files = fixture(directory, { mode: "exited" });
  const bundleDir = path.join(directory, "debugger-bundle");
  const args = [
    "debugger", "--workload-file", path.basename(files.definition),
    "--cpu", String(allowedCpu()), "--max-runs", "2", "--max-captures", "2",
    "--debugger", files.debuggerPath, "--out-dir", path.basename(bundleDir), "--yes",
  ];
  const first = capture(directory);
  assert.equal(await runFaultAffinityCli(args, first.io), 0, first.stderr());
  assert.match(first.stdout(), /committed run=1 outcome=clean/);
  assert.match(first.stdout(), /committed run=2 outcome=clean/);
  assert.match(first.stdout(), /complete: 2\/2 debugger runs/);

  const resumed = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "debugger", "--resume", path.basename(bundleDir),
    "--workload-file", path.basename(files.definition), "--yes",
  ], resumed.io), 0, resumed.stderr());
  assert.match(resumed.stdout(), /complete: 2\/2 debugger runs/);
});

test("a partial prefix resumes and completes through the public command", async () => {
  const directory = temporaryDirectory();
  const files = fixture(directory, { mode: "exited" });
  const bundleDir = path.join(directory, "debugger-bundle");
  const cpu = allowedCpu();
  const resolved = resolveCustomWorkloadFile(files.definition).resolved;
  const manifest = buildSchema3BundleManifestV6(resolved, {
    bundleGeneration: "abcdef0123456789abcdef0123456789",
    debuggerManifest: buildDebuggerPhaseManifest(resolved, {
      generation: "0123456789abcdef0123456789abcdef",
      cpu,
      maxRuns: 3,
      maxCaptures: 3,
      debuggerPath: files.debuggerPath,
      tasksetPath: "/usr/bin/taskset",
      runTimeoutMs: 30_000,
      termGraceMs: 500,
      killGraceMs: 1_000,
    }),
    exactCpuManifest: buildExactCpuPhaseManifest(resolved, {
      generation: "00112233445566778899aabbccddeeff",
      cpus: [cpu],
      rounds: 1,
      seed: 20260819,
      tasksetPath: "/usr/bin/taskset",
    }),
  });
  mkdirSync(bundleDir, { mode: 0o700 });
  await initializeSchema3Bundle({ resolved, manifest, bundleDir });
  const bindingKey = customWorkloadEnvironmentBindingKey(
    readFileSync(files.definition),
  );
  let first;
  try {
    first = await runOneSchema3DebuggerAttempt({
      resolved,
      bundleDir,
      environmentBindingKey: bindingKey,
    });
  } finally {
    bindingKey.fill(0);
  }
  assert.equal(first.result.reason, "committed");
  assert.equal(first.result.run, 1);

  const resumed = capture(directory);
  const rc = await runFaultAffinityCli([
    "debugger", "--resume", path.basename(bundleDir),
    "--workload-file", path.basename(files.definition), "--yes",
  ], resumed.io);
  assert.equal(rc, 0, resumed.stderr());
  assert.match(resumed.stdout(), /run 2\/3/);
  assert.match(resumed.stdout(), /committed run=2 outcome=clean/);
  assert.match(resumed.stdout(), /committed run=3 outcome=clean/);
  assert.match(resumed.stdout(), /complete: 3\/3 debugger runs/);
});

test("an incomplete attempt stops nonzero without advancing or looping", async () => {
  const directory = temporaryDirectory();
  const files = fixture(directory, { mode: "silent" });
  const bundleDir = path.join(directory, "debugger-bundle");
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "debugger", "--workload-file", path.basename(files.definition),
    "--cpu", String(allowedCpu()), "--max-runs", "2", "--max-captures", "1",
    "--debugger", files.debuggerPath, "--out-dir", path.basename(bundleDir), "--yes",
  ], captured.io);

  assert.equal(rc, 1);
  assert.match(captured.stderr(), /debugger attempt was not committed: operational-invalid/);
  assert.equal((captured.stdout().match(/run 1\//g) ?? []).length, 1);
  assert.deepEqual(readdirSync(path.join(bundleDir, "state", "debugger")),
    ["debugger-phase.json"]);
});

test("SIGINT during a held attempt cancels cleanly without publishing", async () => {
  const directory = temporaryDirectory();
  const files = fixture(directory, { mode: "hold" });
  const bundleDir = path.join(directory, "debugger-bundle");
  const captured = capture(directory);
  const signalSource = new EventEmitter();
  const run = runFaultAffinityCli([
    "debugger", "--workload-file", path.basename(files.definition),
    "--cpu", String(allowedCpu()), "--max-runs", "2", "--max-captures", "1",
    "--debugger", files.debuggerPath, "--out-dir", path.basename(bundleDir), "--yes",
  ], { ...captured.io, signalSource });

  await waitForOutput(captured, "run 1/2");
  signalSource.emit("SIGINT");
  const rc = await run;
  assert.equal(rc, 130);
  assert.deepEqual(readdirSync(path.join(bundleDir, "state", "debugger")),
    ["debugger-phase.json"]);
});

test("a held bundle lease makes the public resume exit 75", async () => {
  const directory = temporaryDirectory();
  const files = fixture(directory, { mode: "exited" });
  const bundleDir = path.join(directory, "debugger-bundle");
  const resolved = resolveCustomWorkloadFile(files.definition).resolved;
  const cpu = allowedCpu();
  const manifest = buildSchema3BundleManifestV6(resolved, {
    bundleGeneration: "abcdef0123456789abcdef0123456789",
    debuggerManifest: buildDebuggerPhaseManifest(resolved, {
      generation: "0123456789abcdef0123456789abcdef",
      cpu,
      maxRuns: 2,
      maxCaptures: 2,
      debuggerPath: files.debuggerPath,
      tasksetPath: "/usr/bin/taskset",
      runTimeoutMs: 30_000,
      termGraceMs: 500,
      killGraceMs: 1_000,
    }),
    exactCpuManifest: buildExactCpuPhaseManifest(resolved, {
      generation: "00112233445566778899aabbccddeeff",
      cpus: [cpu],
      rounds: 1,
      seed: 20260819,
      tasksetPath: "/usr/bin/taskset",
    }),
  });
  mkdirSync(bundleDir, { mode: 0o700 });
  await initializeSchema3Bundle({ resolved, manifest, bundleDir });

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const bindingKey = customWorkloadEnvironmentBindingKey(
    readFileSync(files.definition),
  );
  let held;
  try {
    held = runOneSchema3DebuggerAttempt({
      resolved,
      bundleDir,
      environmentBindingKey: bindingKey,
      runAttempt: async (workload, debuggerManifest, context, options) => {
        started();
        await gate;
        return runDebuggerAttempt(workload, debuggerManifest, context, options);
      },
    });
    await startedPromise;

    const resumed = capture(directory);
    const rc = await runFaultAffinityCli([
      "debugger", "--resume", path.basename(bundleDir),
      "--workload-file", path.basename(files.definition), "--yes",
    ], resumed.io);
    assert.equal(rc, 75);

    release();
    const heldResult = await held;
    assert.equal(heldResult.result.reason, "committed");
  } finally {
    release();
    await held?.catch(() => {});
    bindingKey.fill(0);
  }

  const after = capture(directory);
  assert.equal(await runFaultAffinityCli([
    "debugger", "--resume", path.basename(bundleDir),
    "--workload-file", path.basename(files.definition), "--yes",
  ], after.io), 0, after.stderr());
  assert.match(after.stdout(), /complete: 2\/2 debugger runs/);
});

test("an HMAC-bound custom workload runs through the public command", async () => {
  const directory = temporaryDirectory();
  const secret = "cli-secret-value-5a6b7c8d";
  const files = fixture(directory, {
    mode: "exited",
    environment: { CUSTOM_SECRET_VALUE: secret },
  });
  const bundleDir = path.join(directory, "debugger-bundle");
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "debugger", "--workload-file", path.basename(files.definition),
    "--cpu", String(allowedCpu()), "--max-runs", "1", "--max-captures", "1",
    "--debugger", files.debuggerPath, "--out-dir", path.basename(bundleDir), "--yes",
  ], captured.io);

  assert.equal(rc, 0, captured.stderr());
  assert.match(captured.stdout(), /complete: 1\/1 debugger runs/);
  // Neither the private value nor any binding authority persists into the
  // bundle files the CLI wrote.
  const walk = (directoryWalk) => readdirSync(directoryWalk, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? walk(path.join(directoryWalk, entry.name))
      : [path.join(directoryWalk, entry.name)]);
  for (const file of walk(bundleDir)) {
    assert.ok(!readFileSync(file, "utf8").includes(secret), file);
  }
});

test("a debugger run refuses a workload without gdb capability", async () => {
  const directory = temporaryDirectory();
  const files = fixture(directory);
  const definition = path.join(directory, "no-gdb.json");
  const value = JSON.parse(readFileSync(files.definition, "utf8"));
  value.id = "debugger-cli-no-gdb";
  value.capabilities = { isolated: true, gdb: false };
  writeFileSync(definition, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const captured = capture(directory);
  const rc = await runFaultAffinityCli([
    "debugger", "--workload-file", path.basename(definition),
    "--cpu", String(allowedCpu()), "--max-runs", "1", "--max-captures", "1",
    "--debugger", files.debuggerPath, "--out-dir", "unused", "--yes",
  ], captured.io);
  assert.equal(rc, 2);
  assert.match(captured.stderr(), /does not declare required debugger capabilities: gdb/);
  assert.equal(existsSync(path.join(directory, "unused")), false);
});
