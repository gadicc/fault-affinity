import { fstatSync, lstatSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readLinuxAllowedCpuList } from "../../diagnose-lib/attempt-runner.mjs";
import { runOneSchema3ControlledLoadSession } from "../../diagnose-lib/schema3-bundle.mjs";
import {
  assertReferenceDiscoveryChildBundle,
  referenceDiscoveryPlanBinding,
} from "./discovery-protocol.mjs";
import { revalidateReferenceDiscoveryOwnerExecution } from "./discovery-controller.mjs";
import {
  REFERENCE_DISCOVERY_COORDINATION_DIRECTORY,
  readReferenceDiscoveryPlan,
} from "./discovery-store.mjs";

const OWNER_RECORD_VERSION = 1;
const MAX_CPU = 65_535;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const OWNER_REASONS = new Set([
  "committed", "complete", "operational-invalid", "external-cancel", "owner-error",
  "runner-error", "evidence-invalid", "condition-invalid", "envelope-invalid",
]);

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 7 ||
      argv.some((value) => typeof value !== "string" || value.length === 0 ||
        value.includes("\0"))) {
    throw new TypeError("reference discovery owner requires collection, session, plan, and directory bindings");
  }
  const [collectionDir, ordinalText, expectedPlanSha256,
    collectionDevice, collectionInode, coordinationDevice, coordinationInode] = argv;
  if (!path.isAbsolute(collectionDir) ||
      !/^[1-9][0-9]*$/.test(ordinalText) || !SHA256_RE.test(expectedPlanSha256) ||
      ![collectionDevice, collectionInode, coordinationDevice, coordinationInode]
        .every((value) => value.length <= 24 && UINT_RE.test(value))) {
    throw new TypeError("reference discovery owner arguments are invalid");
  }
  const sessionOrdinal = Number(ordinalText);
  if (!Number.isSafeInteger(sessionOrdinal) || sessionOrdinal > MAX_CPU) {
    throw new TypeError("reference discovery owner session ordinal is invalid");
  }
  return {
    collectionDir,
    sessionOrdinal,
    expectedPlanSha256,
    collection: { device: collectionDevice, inode: collectionInode },
    coordination: { device: coordinationDevice, inode: coordinationInode },
  };
}

function sameDirectory(stats, identity) {
  return stats.isDirectory() && stats.dev.toString() === identity.device &&
    stats.ino.toString() === identity.inode;
}

function validateRetainedDirectories(parsed) {
  const coordinationDir = path.join(
    parsed.collectionDir,
    REFERENCE_DISCOVERY_COORDINATION_DIRECTORY,
  );
  let collectionDescriptor;
  let coordinationDescriptor;
  let collectionPath;
  let coordinationPath;
  let canonicalCollection;
  let canonicalCoordination;
  try {
    coordinationDescriptor = fstatSync(4, { bigint: true });
    collectionDescriptor = fstatSync(5, { bigint: true });
    collectionPath = lstatSync(parsed.collectionDir, { bigint: true });
    coordinationPath = lstatSync(coordinationDir, { bigint: true });
    canonicalCollection = realpathSync(parsed.collectionDir);
    canonicalCoordination = realpathSync(coordinationDir);
  } catch {
    throw Object.assign(new Error("retained discovery directory binding is unavailable"), {
      code: "REFERENCE_DISCOVERY_COORDINATION_MISMATCH",
    });
  }
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  const privateAndOwned = (stats) => (uid === null || stats.uid === uid) &&
    (stats.mode & 0o077n) === 0n;
  if (canonicalCollection !== parsed.collectionDir || canonicalCoordination !== coordinationDir ||
      !sameDirectory(collectionDescriptor, parsed.collection) ||
      !sameDirectory(collectionPath, parsed.collection) ||
      !sameDirectory(coordinationDescriptor, parsed.coordination) ||
      !sameDirectory(coordinationPath, parsed.coordination) ||
      !privateAndOwned(collectionPath) || !privateAndOwned(coordinationPath)) {
    throw Object.assign(new Error("retained discovery directory binding changed"), {
      code: "REFERENCE_DISCOVERY_COORDINATION_MISMATCH",
    });
  }
  return true;
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
}

function invalidDetail(result) {
  for (const leg of ["a1", "b", "a2"]) {
    for (const attempt of result?.attempts?.[leg] ?? []) {
      const outcome = attempt?.evidence?.outcome;
      if (outcome?.validOutcome === false) {
        return `${leg}: ${outcome.invalidReason ?? outcome.label ?? "invalid outcome"}`;
      }
    }
  }
  return result?.stage === undefined ? null : `${result.stage}: ${result.reason}`;
}

function safeErrorCode(error) {
  return typeof error?.code === "string" && ERROR_CODE_RE.test(error.code)
    ? error.code : "REFERENCE_DISCOVERY_OWNER_ERROR";
}

export async function runReferenceDiscoverySessionOwner(argv, io = {}) {
  const writeRecord = io.record ?? ((value) => writeSync(3, value));
  const stderr = io.stderr ?? ((value) => process.stderr.write(value));
  const signalSource = io.signalSource ?? process;
  const readAllowedCpuList = io.readAllowedCpuList ?? readLinuxAllowedCpuList;
  const readPlan = io.readPlan ?? readReferenceDiscoveryPlan;
  const revalidate = io.revalidate ?? revalidateReferenceDiscoveryOwnerExecution;
  const runSession = io.runSession ?? runOneSchema3ControlledLoadSession;
  const validateDirectories = io.validateRetainedDirectories ?? validateRetainedDirectories;
  const ownerPid = io.pid ?? process.pid;
  const controller = new AbortController();
  let receivedSignal = null;
  let controllerCpu = null;
  let controllerAllowedCpuList = null;
  const handlers = new Map([
    ["SIGINT", () => { receivedSignal ??= "SIGINT"; controller.abort(); }],
    ["SIGTERM", () => { receivedSignal ??= "SIGTERM"; controller.abort(); }],
  ]);
  for (const [signal, handler] of handlers) signalSource.once(signal, handler);
  try {
    const parsed = parseArguments(argv);
    validateDirectories(parsed);
    const plan = await readPlan(parsed.collectionDir);
    validateDirectories(parsed);
    if (referenceDiscoveryPlanBinding(plan).sha256 !== parsed.expectedPlanSha256) {
      throw Object.assign(new Error("stored discovery plan does not match the requested binding"), {
        code: "REFERENCE_DISCOVERY_PLAN_MISMATCH",
      });
    }
    const session = plan.schedule.sessions[parsed.sessionOrdinal - 1];
    if (session === undefined) {
      throw Object.assign(new Error("discovery session is outside the stored plan"), {
        code: "REFERENCE_DISCOVERY_SESSION_INVALID",
      });
    }
    const allowedCpuList = readAllowedCpuList(ownerPid, { strict: true });
    if (allowedCpuList !== String(session.controllerCpu)) {
      throw Object.assign(new Error(
        `controller affinity is ${allowedCpuList ?? "unavailable"}, expected ${session.controllerCpu}`,
      ), { code: "REFERENCE_DISCOVERY_CONTROLLER_INVALID" });
    }
    controllerCpu = session.controllerCpu;
    controllerAllowedCpuList = allowedCpuList;
    const executionContext = await revalidate(plan);
    validateDirectories(parsed);
    const measured = executionContext.workloads.measured;
    const auxiliary = executionContext.workloads.auxiliary;
    const bundleDir = path.join(parsed.collectionDir, session.directory);
    const execution = await runSession({
      resolved: measured,
      auxiliary,
      bundleDir,
      validateBundle: (bundle) => {
        validateDirectories(parsed);
        return assertReferenceDiscoveryChildBundle(plan, session.ordinal, bundle);
      },
      attemptOptions: { signal: controller.signal },
    });
    validateDirectories(parsed);
    if (!OWNER_REASONS.has(execution.result.reason) ||
        execution.result.committed !== (execution.result.reason === "committed")) {
      throw Object.assign(new Error("controlled-load engine returned an invalid owner result"), {
        code: "REFERENCE_DISCOVERY_RESULT_INVALID",
      });
    }
    writeRecord(`${JSON.stringify({
      version: OWNER_RECORD_VERSION,
      committed: execution.result.committed,
      reason: execution.result.reason,
      stage: execution.result.stage ?? null,
      errorCode: execution.result.errorCode ?? null,
      detail: invalidDetail(execution.result),
      controllerCpu,
      controllerAllowedCpuList,
    })}\n`);
    return receivedSignal === null ? 0 : signalExitCode(receivedSignal);
  } catch (error) {
    writeRecord(`${JSON.stringify({
      version: OWNER_RECORD_VERSION,
      committed: false,
      reason: "owner-error",
      stage: null,
      errorCode: safeErrorCode(error),
      detail: typeof error?.message === "string" ? error.message.slice(0, 4096) : "unknown error",
      controllerCpu,
      controllerAllowedCpuList,
    })}\n`);
    stderr(`reference discovery owner: ${error?.message ?? "unknown error"}\n`);
    return receivedSignal === null ? 2 : signalExitCode(receivedSignal);
  } finally {
    for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler);
  }
}

function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await runReferenceDiscoverySessionOwner(process.argv.slice(2));
}
