import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runLoadedDiscoverySessionProcess } from
  "../../src/fault-affinity/loaded-discovery-session-client.mjs";
import { runLoadedDiscoverySessionOwner } from
  "../../src/fault-affinity/loaded-discovery-session-owner.mjs";

const BUILT_IN = { source: "built-in", resolved: { id: "wasm-churn" } };

function ownerRecord(overrides = {}) {
  return {
    version: 1,
    committed: true,
    reason: "committed",
    stage: "a1",
    errorCode: null,
    detail: null,
    controllerCpu: 7,
    controllerAllowedCpuList: "7",
    ...overrides,
  };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new PassThrough();
  child.stdio = [null, null, child.stderr, new PassThrough()];
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  child.finish = (record, code = 0, signal = null) => {
    if (record !== undefined) child.stdio[3].end(record);
    else child.stdio[3].end();
    child.stderr.end();
    child.emit("close", code, signal);
  };
  return child;
}

test("loaded discovery session client uses an argument-only pinned launch", async () => {
  const child = fakeChild();
  let launch;
  const promise = runLoadedDiscoverySessionProcess({
    measuredSelection: BUILT_IN,
    auxiliarySelection: BUILT_IN,
    bundleDir: "/tmp/discovery/cpu-00019",
    controllerCpu: 7,
    tasksetPath: "/usr/bin/taskset",
    spawnProcess(file, args, options) {
      launch = { file, args, options };
      return child;
    },
  });
  queueMicrotask(() => child.finish(`${JSON.stringify(ownerRecord())}\n`));
  const result = await promise;
  assert.equal(launch.file, "/usr/bin/taskset");
  assert.deepEqual(launch.args.slice(0, 4), ["-c", "7", process.execPath,
    launch.args[3]]);
  assert.match(launch.args[3], /loaded-discovery-session-owner\.mjs$/);
  assert.deepEqual(launch.args.slice(4), [
    "/tmp/discovery/cpu-00019", "7", "built-in", "wasm-churn",
    "built-in", "wasm-churn",
  ]);
  assert.deepEqual(launch.options.env, {});
  assert.equal(launch.options.shell, false);
  assert.equal(result.record.committed, true);
});

test("loaded discovery session client rejects malformed and oversized owner output", async () => {
  for (const output of ["not-json\n", `${JSON.stringify({ version: 1 })}\n`]) {
    const child = fakeChild();
    const promise = runLoadedDiscoverySessionProcess({
      measuredSelection: BUILT_IN,
      auxiliarySelection: BUILT_IN,
      bundleDir: "/tmp/discovery/cpu-00019",
      controllerCpu: 7,
      tasksetPath: "/usr/bin/taskset",
      spawnProcess: () => child,
    });
    queueMicrotask(() => child.finish(output));
    await assert.rejects(promise, /owner record/);
  }

  const child = fakeChild();
  const promise = runLoadedDiscoverySessionProcess({
    measuredSelection: BUILT_IN,
    auxiliarySelection: BUILT_IN,
    bundleDir: "/tmp/discovery/cpu-00019",
    controllerCpu: 7,
    tasksetPath: "/usr/bin/taskset",
    spawnProcess: () => child,
  });
  queueMicrotask(() => {
    child.stdio[3].write(Buffer.alloc(65_537));
    child.finish();
  });
  await assert.rejects(promise, (error) =>
    error.code === "LOADED_DISCOVERY_OWNER_OUTPUT_LIMIT");
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("loaded discovery session client forwards cancellation", async () => {
  const child = fakeChild();
  const controller = new AbortController();
  child.kill = (signal) => {
    child.killCalls.push(signal);
    queueMicrotask(() => child.finish(`${JSON.stringify(ownerRecord({
      committed: false,
      reason: "external-cancel",
      stage: null,
      controllerCpu: 7,
    }))}\n`, 143, "SIGTERM"));
    return true;
  };
  const promise = runLoadedDiscoverySessionProcess({
    measuredSelection: BUILT_IN,
    auxiliarySelection: BUILT_IN,
    bundleDir: "/tmp/discovery/cpu-00019",
    controllerCpu: 7,
    tasksetPath: "/usr/bin/taskset",
    signal: controller.signal,
    spawnProcess: () => child,
  });
  controller.abort();
  const result = await promise;
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  assert.equal(result.record.reason, "external-cancel");
  assert.equal(result.signal, "SIGTERM");
});

test("loaded discovery owner rejects wrong controller affinity and removes handlers", async () => {
  const signalSource = new EventEmitter();
  let record = "";
  let stderr = "";
  const code = await runLoadedDiscoverySessionOwner([
    "/tmp/discovery/cpu-00019", "7", "built-in", "wasm-churn",
    "built-in", "wasm-churn",
  ], {
    record: (value) => { record += value; },
    stderr: (value) => { stderr += value; },
    signalSource,
    pid: 123,
    readAllowedCpuList(pid, options) {
      assert.equal(pid, 123);
      assert.deepEqual(options, { strict: true });
      return "6";
    },
    resolveSelection: () => assert.fail("selection must not resolve"),
    runSession: () => assert.fail("session must not run"),
  });
  assert.equal(code, 2);
  assert.match(stderr, /controller affinity is 6, expected 7/);
  assert.deepEqual(JSON.parse(record), {
    version: 1,
    committed: false,
    reason: "owner-error",
    stage: null,
    errorCode: "LOADED_DISCOVERY_CONTROLLER_INVALID",
    detail: "controller affinity is 6, expected 7",
    controllerCpu: null,
    controllerAllowedCpuList: null,
  });
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("loaded discovery owner reports the first invalid attempt without changing control shape", async () => {
  const signalSource = new EventEmitter();
  let record = "";
  const resolved = { id: "resolved-workload" };
  const code = await runLoadedDiscoverySessionOwner([
    "/tmp/discovery/cpu-00019", "7", "built-in", "wasm-churn",
    "built-in", "wasm-churn",
  ], {
    record: (value) => { record += value; },
    stderr: () => {},
    signalSource,
    readAllowedCpuList: () => "7",
    resolveSelection: () => ({ resolved }),
    async runSession(options) {
      assert.equal(options.resolved, resolved);
      assert.equal(options.auxiliary, resolved);
      assert.equal(options.bundleDir, "/tmp/discovery/cpu-00019");
      assert.equal(options.attemptOptions.signal.aborted, false);
      return {
        result: {
          committed: false,
          reason: "operational-invalid",
          stage: "b",
          errorCode: "EVIDENCE_INVALID",
          attempts: {
            a1: [],
            b: [{ evidence: { outcome: {
              validOutcome: false,
              invalidReason: "unexpected child exit",
            } } }],
            a2: [],
          },
        },
      };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(record), {
    version: 1,
    committed: false,
    reason: "operational-invalid",
    stage: "b",
    errorCode: "EVIDENCE_INVALID",
    detail: "b: unexpected child exit",
    controllerCpu: 7,
    controllerAllowedCpuList: "7",
  });
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});
