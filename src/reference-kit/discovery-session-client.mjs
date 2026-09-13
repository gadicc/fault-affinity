import { spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_CPU_ID } from "../../diagnose-lib/pinned-runner.mjs";
import {
  assertSafeAmbientEnvironment,
  reviewedLaunchEnvironment,
} from "./controller.mjs";
import {
  parseReferenceDiscoveryPlan,
  referenceDiscoveryPlanBinding,
  referenceDiscoveryWorstCaseMs,
} from "./discovery-protocol.mjs";

const OWNER_PATH = fileURLToPath(new URL("./discovery-session-owner.mjs", import.meta.url));
const MAX_OWNER_OUTPUT_BYTES = 64 * 1024;
const MINIMUM_OWNER_SHUTDOWN_GRACE_MS = 30_000;
const OWNER_DEADLINE_OVERHEAD_MS = 60_000;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const OWNER_REASONS = new Set([
  "committed", "complete", "operational-invalid", "external-cancel", "owner-error",
  "runner-error", "evidence-invalid", "condition-invalid", "envelope-invalid",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class ReferenceDiscoverySessionProcessError extends Error {
  constructor(message, code = "REFERENCE_DISCOVERY_SESSION_PROCESS_ERROR") {
    super(message);
    this.name = "ReferenceDiscoverySessionProcessError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ReferenceDiscoverySessionProcessError(message, code);
}

function validateRetainedDirectory(value, label) {
  const keys = value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort() : [];
  if (keys.join("\n") !== ["device", "fd", "inode"].sort().join("\n") ||
      !Number.isSafeInteger(value.fd) || value.fd < 0 ||
      !/^(0|[1-9][0-9]*)$/.test(value.device) ||
      !/^(0|[1-9][0-9]*)$/.test(value.inode)) {
    fail(`reference discovery ${label} retention is invalid`);
  }
  let stat;
  try { stat = fstatSync(value.fd, { bigint: true }); } catch {
    fail(`reference discovery ${label} retention descriptor is unavailable`);
  }
  if (!stat.isDirectory() || stat.dev.toString() !== value.device ||
      stat.ino.toString() !== value.inode) {
    fail(`reference discovery ${label} retention descriptor changed`);
  }
  return value;
}

function markReaped(error) {
  const result = error instanceof Error ? error :
    new ReferenceDiscoverySessionProcessError("reference discovery owner failed after exit");
  result.reaped = true;
  return result;
}

function parseOwnerRecord(chunks, expectedControllerCpu) {
  let text;
  try { text = UTF8_DECODER.decode(Buffer.concat(chunks)); } catch {
    fail("reference discovery owner record is not valid UTF-8");
  }
  if (!text.endsWith("\n") || text.includes("\0") || text.includes("\r") ||
      text.slice(0, -1).includes("\n")) {
    fail("reference discovery owner did not emit exactly one record");
  }
  let value;
  try { value = JSON.parse(text.slice(0, -1)); } catch {
    fail("reference discovery owner record is not valid JSON");
  }
  const expected = [
    "version", "committed", "reason", "stage", "errorCode", "detail",
    "controllerCpu", "controllerAllowedCpuList",
  ].sort();
  const controllerAffinityValid =
    (value?.controllerCpu === null && value?.controllerAllowedCpuList === null) ||
    (Number.isSafeInteger(value?.controllerCpu) && value.controllerCpu >= 0 &&
      value.controllerCpu <= MAX_CPU_ID &&
      value.controllerAllowedCpuList === String(value.controllerCpu));
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== expected.join("\n") || value.version !== 1 ||
      typeof value.committed !== "boolean" || !OWNER_REASONS.has(value.reason) ||
      !(value.stage === null || (typeof value.stage === "string" &&
        value.stage.length > 0 && value.stage.length <= 64)) ||
      !(value.errorCode === null ||
        (typeof value.errorCode === "string" && ERROR_CODE_RE.test(value.errorCode))) ||
      !(value.detail === null || (typeof value.detail === "string" &&
        Buffer.byteLength(value.detail) <= 4096)) || !controllerAffinityValid ||
      value.committed !== (value.reason === "committed")) {
    fail("reference discovery owner record has an invalid shape");
  }
  if (value.committed && value.controllerCpu === null) {
    fail("committed reference discovery owner record lacks an affinity witness");
  }
  if (value.controllerCpu !== null && value.controllerCpu !== expectedControllerCpu) {
    fail("reference discovery owner record has the wrong controller affinity");
  }
  return Object.freeze(value);
}

function appendBounded(chunks, state, chunk, label, stopChild) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (state.bytes + bytes.length > MAX_OWNER_OUTPUT_BYTES) {
    stopChild();
    throw new ReferenceDiscoverySessionProcessError(
      `reference discovery owner ${label} exceeded ${MAX_OWNER_OUTPUT_BYTES} bytes`,
      "REFERENCE_DISCOVERY_OWNER_OUTPUT_LIMIT",
    );
  }
  state.bytes += bytes.length;
  chunks.push(bytes);
}

function waitForChild(child, { signal, ownerShutdownGraceMs, deadlineMs, controllerCpu }) {
  return new Promise((resolve, reject) => {
    const control = [];
    const stderr = [];
    const controlState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let settled = false;
    let outputError = null;
    let childError = null;
    let killTimer = null;
    let deadlineTimer = null;
    const stopChild = () => {
      try { child.kill("SIGTERM"); } catch { /* close/error still owns settlement */ }
      if (killTimer === null) {
        killTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* close/error still owns settlement */ }
        }, ownerShutdownGraceMs);
        killTimer.unref?.();
      }
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", stopChild);
      callback(value);
    };
    if (!child?.stdio?.[3] || !child?.stderr) {
      finish(reject, new ReferenceDiscoverySessionProcessError(
        "reference discovery owner pipes are unavailable"));
      return;
    }
    child.stdio[3].on("data", (chunk) => {
      if (outputError !== null) return;
      try { appendBounded(control, controlState, chunk, "control output", stopChild); } catch (error) {
        outputError = error;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (outputError !== null) return;
      try { appendBounded(stderr, stderrState, chunk, "stderr", stopChild); } catch (error) {
        outputError = error;
      }
    });
    child.once("error", (error) => { childError = error; });
    child.once("close", (code, childSignal) => {
      if (outputError !== null) {
        finish(reject, markReaped(outputError));
        return;
      }
      if (childError !== null) {
        finish(reject, markReaped(childError));
        return;
      }
      try {
        const record = parseOwnerRecord(control, controllerCpu);
        if (record.committed && (code !== 0 || childSignal !== null)) {
          fail("committed reference discovery owner record requires a successful owner exit");
        }
        finish(resolve, Object.freeze({
          record,
          code,
          signal: childSignal,
          stderr: Buffer.concat(stderr).toString("utf8"),
          reaped: true,
        }));
      } catch (error) {
        finish(reject, markReaped(error));
      }
    });
    signal?.addEventListener("abort", stopChild, { once: true });
    if (signal?.aborted) stopChild();
    deadlineTimer = setTimeout(() => {
      outputError = new ReferenceDiscoverySessionProcessError(
        "reference discovery owner exceeded its bounded session deadline",
        "REFERENCE_DISCOVERY_OWNER_TIMEOUT",
      );
      stopChild();
    }, deadlineMs);
    deadlineTimer.unref?.();
  });
}

export async function runReferenceDiscoverySessionProcess({
  plan: planValue,
  sessionOrdinal,
  collectionDir,
  retainedCoordinator,
  retainedCollection,
  signal,
  environment = process.env,
  ownerPath = OWNER_PATH,
  spawnProcess = spawn,
}) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  const session = plan.schedule.sessions[sessionOrdinal - 1];
  if (session === undefined || !Number.isSafeInteger(sessionOrdinal) || sessionOrdinal < 1 ||
      collectionDir !== plan.storage.collectionDir || typeof ownerPath !== "string" ||
      !path.isAbsolute(ownerPath) || ownerPath.includes("\0") || typeof spawnProcess !== "function") {
    fail("reference discovery session process options are invalid");
  }
  const coordinatorRetention = validateRetainedDirectory(retainedCoordinator, "coordinator");
  const collectionRetention = validateRetainedDirectory(retainedCollection, "collection");
  assertSafeAmbientEnvironment(environment);
  const launchEnvironment = reviewedLaunchEnvironment(environment);
  const child = spawnProcess(plan.identity.taskset.path, [
    "-c",
    String(session.controllerCpu),
    plan.identity.controllerRuntime.path,
    ownerPath,
    collectionDir,
    String(sessionOrdinal),
    referenceDiscoveryPlanBinding(plan).sha256,
    collectionRetention.device,
    collectionRetention.inode,
    coordinatorRetention.device,
    coordinatorRetention.inode,
  ], {
    cwd: "/",
    env: launchEnvironment,
    shell: false,
    windowsHide: true,
    // fd 4 keeps the campaign lease alive if the controller exits before the
    // owner. The owner does not read it; close-on-exit is the handoff boundary.
    stdio: [
      "ignore", "ignore", "pipe", "pipe",
      coordinatorRetention.fd,
      collectionRetention.fd,
    ],
  });
  const ownerShutdownGraceMs = Math.max(
    MINIMUM_OWNER_SHUTDOWN_GRACE_MS,
    plan.profile.termGraceMs + plan.profile.killGraceMs + 10_000,
  );
  const deadlineMs = Math.ceil(referenceDiscoveryWorstCaseMs(plan) /
    plan.schedule.sessions.length) + OWNER_DEADLINE_OVERHEAD_MS;
  return await waitForChild(child, {
    signal,
    ownerShutdownGraceMs,
    deadlineMs,
    controllerCpu: session.controllerCpu,
  });
}
