import { realpathSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { readLinuxAllowedCpuList } from "../../diagnose-lib/attempt-runner.mjs";
import { runOneSchema3ControlledLoadSession } from "../../diagnose-lib/schema3-bundle.mjs";
import { resolveWorkloadSelection } from "../../workloads/catalog.mjs";

const OWNER_RECORD_VERSION = 1;

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 6 ||
      argv.some((value) => typeof value !== "string" || value.length === 0 ||
        value.includes("\0"))) {
    throw new TypeError("loaded discovery owner requires a bundle, controller, and two workload selections");
  }
  const [bundleDir, controllerText, measuredType, measuredValue, auxiliaryType, auxiliaryValue] = argv;
  if (!/^(0|[1-9][0-9]*)$/.test(controllerText) ||
      ![measuredType, auxiliaryType].every((type) =>
        type === "built-in" || type === "custom-file")) {
    throw new TypeError("loaded discovery owner arguments are invalid");
  }
  return {
    bundleDir,
    controllerCpu: Number(controllerText),
    measuredType,
    measuredValue,
    auxiliaryType,
    auxiliaryValue,
  };
}

function resolveSelection(type, value) {
  return resolveWorkloadSelection(type === "built-in"
    ? { workload: value }
    : { workloadFile: value });
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

export async function runLoadedDiscoverySessionOwner(argv, io = {}) {
  const writeRecord = io.record ?? ((value) => writeSync(3, value));
  const stderr = io.stderr ?? ((value) => process.stderr.write(value));
  const signalSource = io.signalSource ?? process;
  const readAllowedCpuList = io.readAllowedCpuList ?? readLinuxAllowedCpuList;
  const resolveOwnerSelection = io.resolveSelection ?? resolveSelection;
  const runSession = io.runSession ?? runOneSchema3ControlledLoadSession;
  const ownerPid = io.pid ?? process.pid;
  const controller = new AbortController();
  let receivedSignal = null;
  const handlers = new Map([
    ["SIGINT", () => { receivedSignal ??= "SIGINT"; controller.abort(); }],
    ["SIGTERM", () => { receivedSignal ??= "SIGTERM"; controller.abort(); }],
  ]);
  for (const [signal, handler] of handlers) signalSource.once(signal, handler);
  try {
    const parsed = parseArguments(argv);
    const allowedCpuList = readAllowedCpuList(ownerPid, { strict: true });
    if (allowedCpuList !== String(parsed.controllerCpu)) {
      throw Object.assign(new Error(
        `controller affinity is ${allowedCpuList ?? "unavailable"}, expected ${parsed.controllerCpu}`,
      ), { code: "LOADED_DISCOVERY_CONTROLLER_INVALID" });
    }
    const measured = resolveOwnerSelection(parsed.measuredType, parsed.measuredValue);
    const auxiliary = resolveOwnerSelection(parsed.auxiliaryType, parsed.auxiliaryValue);
    const execution = await runSession({
      resolved: measured.resolved,
      auxiliary: auxiliary.resolved,
      bundleDir: parsed.bundleDir,
      attemptOptions: { signal: controller.signal },
    });
    writeRecord(`${JSON.stringify({
      version: OWNER_RECORD_VERSION,
      committed: execution.result.committed,
      reason: execution.result.reason,
      stage: execution.result.stage ?? null,
      errorCode: execution.result.errorCode ?? null,
      detail: invalidDetail(execution.result),
      controllerCpu: parsed.controllerCpu,
      controllerAllowedCpuList: allowedCpuList,
    })}\n`);
    return receivedSignal === null ? 0 : signalExitCode(receivedSignal);
  } catch (error) {
    writeRecord(`${JSON.stringify({
      version: OWNER_RECORD_VERSION,
      committed: false,
      reason: "owner-error",
      stage: null,
      errorCode: typeof error?.code === "string"
        ? error.code : "LOADED_DISCOVERY_OWNER_ERROR",
      detail: typeof error?.message === "string" ? error.message.slice(0, 4096) : "unknown error",
      controllerCpu: null,
      controllerAllowedCpuList: null,
    })}\n`);
    stderr(`loaded discovery owner: ${error?.message ?? "unknown error"}\n`);
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
  process.exitCode = await runLoadedDiscoverySessionOwner(process.argv.slice(2));
}
