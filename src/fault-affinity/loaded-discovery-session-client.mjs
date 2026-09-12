import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_CPU_ID } from "../../diagnose-lib/pinned-runner.mjs";

const OWNER_PATH = fileURLToPath(new URL("./loaded-discovery-session-owner.mjs", import.meta.url));
const MAX_OWNER_OUTPUT_BYTES = 64 * 1024;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const OWNER_REASONS = new Set([
  "committed", "complete", "operational-invalid", "external-cancel", "owner-error",
  "runner-error", "evidence-invalid", "condition-invalid", "envelope-invalid",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class LoadedDiscoverySessionProcessError extends Error {
  constructor(message, code = "LOADED_DISCOVERY_SESSION_PROCESS_ERROR") {
    super(message);
    this.name = "LoadedDiscoverySessionProcessError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new LoadedDiscoverySessionProcessError(message, code);
}

function selectionArguments(selection) {
  if (selection?.source === "built-in") return ["built-in", selection.resolved.id];
  if (selection?.source === "custom-file" && typeof selection.metadata?.file === "string") {
    return ["custom-file", selection.metadata.file];
  }
  fail("loaded discovery workload selection is invalid");
}

function appendBounded(chunks, state, chunk, label, child) {
  state.bytes += chunk.length;
  if (state.bytes > MAX_OWNER_OUTPUT_BYTES) {
    child.kill("SIGTERM");
    fail(`loaded discovery owner ${label} exceeded ${MAX_OWNER_OUTPUT_BYTES} bytes`,
      "LOADED_DISCOVERY_OWNER_OUTPUT_LIMIT");
  }
  chunks.push(chunk);
}

function parseOwnerRecord(chunks) {
  let text;
  try {
    text = UTF8_DECODER.decode(Buffer.concat(chunks));
  } catch {
    fail("loaded discovery owner record is not valid UTF-8");
  }
  if (!text.endsWith("\n") || text.includes("\0") || text.includes("\r") ||
      text.slice(0, -1).includes("\n")) {
    fail("loaded discovery owner did not emit exactly one record");
  }
  let value;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    fail("loaded discovery owner record is not valid JSON");
  }
  const expected = [
    "version", "committed", "reason", "stage", "errorCode", "detail",
    "controllerCpu", "controllerAllowedCpuList",
  ].sort();
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== expected.join("\n") || value.version !== 1 ||
      typeof value.committed !== "boolean" || !OWNER_REASONS.has(value.reason) ||
      !(value.stage === null || typeof value.stage === "string") ||
      !(value.errorCode === null ||
        (typeof value.errorCode === "string" && ERROR_CODE_RE.test(value.errorCode))) ||
      !(value.detail === null || typeof value.detail === "string") ||
      !(value.controllerCpu === null ||
        (Number.isSafeInteger(value.controllerCpu) && value.controllerCpu >= 0 &&
          value.controllerCpu <= MAX_CPU_ID)) ||
      !(value.controllerAllowedCpuList === null ||
        typeof value.controllerAllowedCpuList === "string") ||
      value.committed !== (value.reason === "committed")) {
    fail("loaded discovery owner record has an invalid shape");
  }
  return Object.freeze(value);
}

function waitForChild(child, signal) {
  return new Promise((resolve, reject) => {
    const control = [];
    const stderr = [];
    const controlState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let settled = false;
    let outputError = null;
    const onAbort = () => child.kill("SIGTERM");
    child.stdio[3].on("data", (chunk) => {
      if (outputError !== null) return;
      try { appendBounded(control, controlState, chunk, "control output", child); } catch (error) {
        outputError = error;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (outputError !== null) return;
      try { appendBounded(stderr, stderrState, chunk, "stderr", child); } catch (error) {
        outputError = error;
      }
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code, childSignal) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (outputError !== null) {
        reject(outputError);
        return;
      }
      try {
        resolve(Object.freeze({
          record: parseOwnerRecord(control),
          code,
          signal: childSignal,
          stderr: Buffer.concat(stderr).toString("utf8"),
        }));
      } catch (error) {
        reject(error);
      }
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function runLoadedDiscoverySessionProcess({
  measuredSelection,
  auxiliarySelection,
  bundleDir,
  controllerCpu,
  tasksetPath,
  signal,
  spawnProcess = spawn,
}) {
  if (typeof bundleDir !== "string" || !path.isAbsolute(bundleDir) || bundleDir.includes("\0") ||
      !Number.isSafeInteger(controllerCpu) || controllerCpu < 0 || controllerCpu > MAX_CPU_ID ||
      typeof tasksetPath !== "string" || !path.isAbsolute(tasksetPath) ||
      tasksetPath.includes("\0") || typeof spawnProcess !== "function") {
    fail("loaded discovery session process options are invalid");
  }
  const child = spawnProcess(tasksetPath, [
    "-c", String(controllerCpu), process.execPath, OWNER_PATH, bundleDir,
    String(controllerCpu),
    ...selectionArguments(measuredSelection),
    ...selectionArguments(auxiliarySelection),
  ], {
    cwd: "/",
    env: {},
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  return await waitForChild(child, signal);
}
