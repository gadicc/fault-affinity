import {
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  assertBundleExecutionLeaseHeld,
  withBundleExecutionLease,
} from "../../diagnose-lib/bundle-execution-lease.mjs";
import {
  PinnedProtocolStateError,
  canonicalProtocolJson,
  createFileStateAdapter,
} from "../../diagnose-lib/pinned-protocol.mjs";
import {
  REFERENCE_DISCOVERY_HISTORY_VERSION,
  REFERENCE_DISCOVERY_MAX_HISTORY_GENERATIONS,
  parseReferenceDiscoveryHistory,
  parseReferenceDiscoveryPlan,
} from "./discovery-protocol.mjs";

export const REFERENCE_DISCOVERY_HISTORY_DIRECTORY = "history";

const RECORD_MAX_BYTES = 16 * 1024;
const FINAL_NAME_RE = /^reference-discovery-history-([0-9]{5})-(start|terminal)\.json$/;
const HANDLES = new WeakSet();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class ReferenceDiscoveryHistoryStoreError extends Error {
  constructor(message, code = "INVALID_REFERENCE_DISCOVERY_HISTORY_STORE") {
    super(message);
    this.name = "ReferenceDiscoveryHistoryStoreError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ReferenceDiscoveryHistoryStoreError(message, code);
}

function validatePrivateDirectory(directory, label) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0")) {
    fail(`${label} must be an absolute NUL-free path`);
  }
  let canonical;
  let stat;
  try {
    canonical = realpathSync(directory);
    stat = lstatSync(directory, { bigint: true });
  } catch {
    fail(`${label} is missing or could not be inspected`);
  }
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (canonical !== directory || !stat.isDirectory() ||
      (uid !== null && stat.uid !== uid) || (stat.mode & 0o077n) !== 0n) {
    fail(`${label} must be a canonical private directory owned by the current user`);
  }
  return canonical;
}

function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY |
    (constants.O_DIRECTORY === undefined ? 0 : constants.O_DIRECTORY) |
    (constants.O_NOFOLLOW === undefined ? 0 : constants.O_NOFOLLOW));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensureHistoryDirectory(collection) {
  const directory = path.join(collection, REFERENCE_DISCOVERY_HISTORY_DIRECTORY);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      fail("reference discovery history could not be created: " +
        (error?.code ?? "unknown error"));
    }
  }
  const validated = validatePrivateDirectory(directory, "reference discovery history directory");
  try { syncDirectory(collection); } catch {
    fail("reference discovery history directory was not committed durably",
      "REFERENCE_DISCOVERY_HISTORY_DIRECTORY_SYNC_FAILED");
  }
  return validated;
}

function requireHandle(handle) {
  if (!HANDLES.has(handle)) fail("reference discovery history handle is invalid");
  assertBundleExecutionLeaseHeld(handle.lease);
  return handle;
}

function recordFilename(record) {
  return `reference-discovery-history-${String(record.generation).padStart(5, "0")}-` +
    `${record.type}.json`;
}

function canonicalRecordLine(record) {
  return Buffer.from(`${canonicalProtocolJson(record)}\n`, "utf8");
}

function decodeRecord(bytes, label) {
  let text;
  try { text = UTF8_DECODER.decode(bytes); } catch { fail(`${label} is not valid UTF-8`); }
  if (!text.endsWith("\n") || text.includes("\r") || text.includes("\0") ||
      text.slice(0, -1).includes("\n")) {
    fail(`${label} is not one canonical JSON line`);
  }
  try { return JSON.parse(text.slice(0, -1)); } catch { fail(`${label} is not valid JSON`); }
}

async function readRecords(handle, plan) {
  const owned = requireHandle(handle);
  let names;
  try { names = await owned.adapter.list(); } catch (error) {
    if (error instanceof PinnedProtocolStateError) {
      fail("reference discovery history inventory could not be read safely");
    }
    throw error;
  }
  requireHandle(handle);
  if (!Array.isArray(names) || names.length > 2 * REFERENCE_DISCOVERY_MAX_HISTORY_GENERATIONS ||
      names.some((name) => typeof name !== "string" || !FINAL_NAME_RE.test(name))) {
    fail("reference discovery history inventory is invalid");
  }
  const ordered = [...names].sort((left, right) => {
    const leftMatch = left.match(FINAL_NAME_RE);
    const rightMatch = right.match(FINAL_NAME_RE);
    const generationOrder = Number(leftMatch[1]) - Number(rightMatch[1]);
    if (generationOrder !== 0) return generationOrder;
    return leftMatch[2] === rightMatch[2] ? 0 : leftMatch[2] === "start" ? -1 : 1;
  });
  const records = [];
  for (const name of ordered) {
    let bytes;
    try { bytes = await owned.adapter.read(name, RECORD_MAX_BYTES); } catch (error) {
      if (error instanceof PinnedProtocolStateError) {
        fail(`reference discovery history '${name}' could not be read safely`);
      }
      throw error;
    }
    requireHandle(handle);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > RECORD_MAX_BYTES) {
      fail(`reference discovery history '${name}' is empty or oversized`);
    }
    const record = decodeRecord(bytes, `reference discovery history '${name}'`);
    if (recordFilename(record) !== name || !bytes.equals(canonicalRecordLine(record))) {
      fail(`reference discovery history '${name}' is not canonical`);
    }
    records.push(record);
  }
  return parseReferenceDiscoveryHistory(plan, records);
}

async function commitNewRecord(handle, record) {
  const owned = requireHandle(handle);
  const name = recordFilename(record);
  const bytes = canonicalRecordLine(record);
  if (bytes.length > RECORD_MAX_BYTES) fail("reference discovery history record is oversized");
  try {
    await owned.adapter.commit(name, bytes);
    requireHandle(handle);
  } catch (error) {
    requireHandle(handle);
    if (error instanceof PinnedProtocolStateError) {
      fail(`reference discovery history '${name}' was not committed durably`,
        "REFERENCE_DISCOVERY_HISTORY_COMMIT_FAILED");
    }
    throw error;
  }
}

export async function withReferenceDiscoveryHistoryStore({
  collectionDir,
  flockPath,
  waitMs = 0,
}, operation) {
  if (typeof operation !== "function") fail("reference discovery history operation is required");
  return withBundleExecutionLease({ bundleDir: collectionDir, flockPath, waitMs }, async (lease) => {
    assertBundleExecutionLeaseHeld(lease);
    const collection = validatePrivateDirectory(collectionDir, "reference discovery collection");
    assertBundleExecutionLeaseHeld(lease);
    const directory = ensureHistoryDirectory(collection);
    assertBundleExecutionLeaseHeld(lease);
    const handle = { lease, directory, adapter: createFileStateAdapter(directory) };
    HANDLES.add(handle);
    try { return await operation(handle); } finally { HANDLES.delete(handle); }
  });
}

export async function readReferenceDiscoveryHistory(handle, planValue) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  return readRecords(handle, plan);
}

export async function publishReferenceDiscoveryHistoryStart(handle, planValue, record) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  const before = await readRecords(handle, plan);
  const latest = before.generations.at(-1);
  if (latest?.terminal === null &&
      canonicalProtocolJson(latest.start) === canonicalProtocolJson(record)) {
    syncDirectory(requireHandle(handle).directory);
    return before;
  }
  if (before.exhausted || record?.type !== "start" ||
      record?.version !== REFERENCE_DISCOVERY_HISTORY_VERSION ||
      record?.generation !== before.nextGeneration) {
    fail("reference discovery history start does not match the next generation");
  }
  parseReferenceDiscoveryHistory(plan, [...before.records, record]);
  await commitNewRecord(requireHandle(handle), record);
  return readRecords(handle, plan);
}

export async function publishReferenceDiscoveryHistoryTerminal(handle, planValue, record) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  const before = await readRecords(handle, plan);
  const open = before.generations.at(-1);
  if (open?.terminal !== null && open?.terminal !== undefined &&
      canonicalProtocolJson(open.terminal) === canonicalProtocolJson(record)) {
    syncDirectory(requireHandle(handle).directory);
    return before;
  }
  if (record?.type !== "terminal" || open?.terminal !== null ||
      record?.generation !== open.start.generation) {
    fail("reference discovery history terminal does not match the open generation");
  }
  parseReferenceDiscoveryHistory(plan, [...before.records, record]);
  await commitNewRecord(requireHandle(handle), record);
  return readRecords(handle, plan);
}
