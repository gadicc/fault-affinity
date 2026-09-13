import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  assertBundleExecutionLeaseHeld,
  withBundleExecutionLease,
} from "../../diagnose-lib/bundle-execution-lease.mjs";
import { buildControlledLoadSessionManifest } from "../../diagnose-lib/controlled-load-session.mjs";
import { buildExactCpuPhaseManifest } from "../../diagnose-lib/exact-cpu-phase.mjs";
import {
  PinnedProtocolStateError,
  createFileStateAdapter,
} from "../../diagnose-lib/pinned-protocol.mjs";
import {
  SCHEMA3_BUNDLE_FILE,
  SCHEMA3_BUNDLE_FILE_MAX_BYTES,
  buildSchema3BundleManifestV5,
  canonicalSchema3BundleManifestLine,
  initializeSchema3Bundle,
  newSchema3BundleGeneration,
  parseSchema3BundleManifest,
} from "../../diagnose-lib/schema3-bundle.mjs";
import {
  canonicalReferenceDiscoveryPlanLine,
  parseReferenceDiscoveryPlan,
} from "./discovery-protocol.mjs";

export const REFERENCE_DISCOVERY_PLAN_FILE = "reference-discovery-plan.json";

const PLAN_MAX_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class ReferenceDiscoveryStoreError extends Error {
  constructor(message, code = "INVALID_REFERENCE_DISCOVERY_STORE") {
    super(message);
    this.name = "ReferenceDiscoveryStoreError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ReferenceDiscoveryStoreError(message, code);
}

function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY |
    (constants.O_DIRECTORY === undefined ? 0 : constants.O_DIRECTORY) |
    (constants.O_NOFOLLOW === undefined ? 0 : constants.O_NOFOLLOW));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function validateDirectory(directory, label, { privateDirectory = true } = {}) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0") ||
      Buffer.byteLength(directory) > 16 * 1024) {
    fail(`${label} must be a bounded absolute NUL-free path`);
  }
  let canonical;
  let stats;
  try {
    canonical = realpathSync(directory);
    stats = lstatSync(directory, { bigint: true });
  } catch {
    fail(`${label} is missing or could not be inspected`);
  }
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (canonical !== directory || !stats.isDirectory() ||
      (privateDirectory && ((uid !== null && stats.uid !== uid) || (stats.mode & 0o077n) !== 0n))) {
    fail(`${label} must be a canonical${privateDirectory ? " private, owned" : ""} directory`);
  }
  return canonical;
}

function adapterFor(directory) {
  return createFileStateAdapter(validateDirectory(directory, "reference discovery collection"));
}

async function readRequired(adapter, name, maximum, label, lease) {
  try {
    const bytes = await adapter.read(name, maximum);
    if (lease !== undefined) assertBundleExecutionLeaseHeld(lease);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum) {
      fail(`${label} is empty or oversized`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof ReferenceDiscoveryStoreError) throw error;
    if (error instanceof PinnedProtocolStateError) fail(`${label} could not be read safely`);
    throw error;
  }
}

async function commitOrVerify(adapter, directory, name, bytes, maximum, label, lease) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum) {
    fail(`${label} is empty or oversized`);
  }
  try {
    await adapter.commit(name, bytes);
    if (lease !== undefined) assertBundleExecutionLeaseHeld(lease);
    return;
  } catch (error) {
    if (lease !== undefined) assertBundleExecutionLeaseHeld(lease);
    if (!(error instanceof PinnedProtocolStateError) ||
        error.message !== `${name} already exists; state commits never overwrite`) {
      fail(`${label} was not committed durably`, "REFERENCE_DISCOVERY_COMMIT_FAILED");
    }
  }
  const stored = await readRequired(adapter, name, maximum, label, lease);
  if (!stored.equals(bytes)) fail(`${label} already exists with different content`);
  syncDirectory(directory);
}

function decodePlan(bytes) {
  let text;
  try { text = UTF8_DECODER.decode(bytes); } catch { fail("reference discovery plan is not UTF-8"); }
  if (!text.endsWith("\n") || text.includes("\0") || text.includes("\r") ||
      text.slice(0, -1).includes("\n")) {
    fail("reference discovery plan is not one canonical JSON line");
  }
  let value;
  try { value = JSON.parse(text.slice(0, -1)); } catch {
    fail("reference discovery plan is not valid JSON");
  }
  const plan = parseReferenceDiscoveryPlan(value);
  if (!bytes.equals(canonicalReferenceDiscoveryPlanLine(plan))) {
    fail("reference discovery plan is not canonical");
  }
  return plan;
}

async function readPlanFromAdapter(adapter, lease) {
  const plan = decodePlan(await readRequired(adapter, REFERENCE_DISCOVERY_PLAN_FILE, PLAN_MAX_BYTES,
    "reference discovery plan", lease));
  assertBundleExecutionLeaseHeld(lease);
  return plan;
}

export async function createReferenceDiscoveryCollection(planValue, {
  flockPath,
  syncParent = syncDirectory,
} = {}) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  if (typeof syncParent !== "function") fail("reference discovery parent sync is invalid");
  const root = validateDirectory(plan.storage.resultsRoot, "reference discovery results root", {
    privateDirectory: false,
  });
  const collection = path.join(root, path.basename(plan.storage.collectionDir));
  if (collection !== plan.storage.collectionDir || path.dirname(collection) !== root) {
    fail("reference discovery collection path does not match its results root");
  }
  try {
    mkdirSync(collection, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      fail(`reference discovery collection could not be created: ${error?.code ?? "unknown error"}`);
    }
  }
  validateDirectory(collection, "reference discovery collection");
  try { syncParent(root); } catch {
    fail("reference discovery collection directory was not committed durably",
      "REFERENCE_DISCOVERY_DIRECTORY_SYNC_FAILED");
  }
  await withBundleExecutionLease({ bundleDir: collection, flockPath }, async (lease) => {
    assertBundleExecutionLeaseHeld(lease);
    const adapter = adapterFor(collection);
    await adapter.list();
    assertBundleExecutionLeaseHeld(lease);
    await commitOrVerify(adapter, collection, REFERENCE_DISCOVERY_PLAN_FILE,
      canonicalReferenceDiscoveryPlanLine(plan), PLAN_MAX_BYTES, "reference discovery plan", lease);
    assertBundleExecutionLeaseHeld(lease);
  });
  return collection;
}

export async function readReferenceDiscoveryPlan(collectionDir, { flockPath } = {}) {
  return withBundleExecutionLease({ bundleDir: collectionDir, flockPath }, async (lease) => {
    assertBundleExecutionLeaseHeld(lease);
    const adapter = adapterFor(collectionDir);
    await adapter.list();
    assertBundleExecutionLeaseHeld(lease);
    const plan = await readPlanFromAdapter(adapter, lease);
    if (plan.storage.collectionDir !== collectionDir) {
      fail("reference discovery plan was moved from its bound collection path");
    }
    assertBundleExecutionLeaseHeld(lease);
    return plan;
  });
}

function requireSession(plan, sessionOrdinal) {
  if (!Number.isSafeInteger(sessionOrdinal) || sessionOrdinal < 1 ||
      sessionOrdinal > plan.schedule.sessions.length) {
    fail("reference discovery session ordinal is outside its plan");
  }
  return plan.schedule.sessions[sessionOrdinal - 1];
}

function requireWorkloads(plan, resolved, auxiliary) {
  if (resolved?.digest !== plan.identity.measuredWorkloadDigest ||
      auxiliary?.digest !== plan.identity.conditionWorkloadDigest) {
    fail("reference discovery workloads do not match the stored plan");
  }
}

export function buildReferenceDiscoveryChildManifest({
  plan: planValue,
  sessionOrdinal,
  resolved,
  auxiliary,
  newGeneration = newSchema3BundleGeneration,
}) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  const session = requireSession(plan, sessionOrdinal);
  requireWorkloads(plan, resolved, auxiliary);
  if (typeof newGeneration !== "function") fail("reference discovery generation source is invalid");
  return buildSchema3BundleManifestV5(resolved, auxiliary, {
    bundleGeneration: newGeneration(),
    controlledLoadManifest: buildControlledLoadSessionManifest(resolved, auxiliary, {
      generation: newGeneration(),
      attemptsPerLeg: plan.profile.attemptsPerLeg,
      targetCpu: session.targetCpu,
      workerCpus: plan.selection.loadCpus,
      tasksetPath: plan.identity.taskset.path,
      warmupMs: plan.profile.warmupMs,
      recoveryMs: plan.profile.recoveryMs,
    }),
    exactCpuManifest: buildExactCpuPhaseManifest(resolved, {
      generation: newGeneration(),
      cpus: [session.targetCpu],
      rounds: 1,
      seed: plan.profile.seed,
      tasksetPath: plan.identity.taskset.path,
    }),
  });
}

async function initializeChildManifest({ resolved, auxiliary, bundleDir, expected }) {
  const manifest = await withBundleExecutionLease({ bundleDir }, async (lease) => {
    assertBundleExecutionLeaseHeld(lease);
    const adapter = createFileStateAdapter(validateDirectory(bundleDir,
      "reference discovery child directory"));
    const names = await adapter.list();
    assertBundleExecutionLeaseHeld(lease);
    if (!names.includes(SCHEMA3_BUNDLE_FILE)) return expected;
    const bytes = await readRequired(adapter, SCHEMA3_BUNDLE_FILE,
      SCHEMA3_BUNDLE_FILE_MAX_BYTES, "reference discovery child manifest", lease);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch {
      fail("reference discovery child manifest is not valid JSON");
    }
    const stored = parseSchema3BundleManifest(resolved, value, auxiliary);
    if (stored.version !== 5) fail("reference discovery children require manifest version 5");
    const rebound = buildSchema3BundleManifestV5(resolved, auxiliary, {
      bundleGeneration: stored.bundleGeneration,
      controlledLoadManifest: {
        ...expected.controlledLoad.manifest,
        generation: stored.controlledLoad.manifest.generation,
      },
      exactCpuManifest: {
        ...expected.exactCpu.manifest,
        generation: stored.exactCpu.manifest.generation,
      },
    });
    if (!bytes.equals(canonicalSchema3BundleManifestLine(resolved, rebound, auxiliary))) {
      fail("reference discovery child does not match its stored plan");
    }
    assertBundleExecutionLeaseHeld(lease);
    return stored;
  });
  return initializeSchema3Bundle({ resolved, auxiliary, bundleDir, manifest });
}

export async function initializeReferenceDiscoveryChild({
  collectionDir,
  sessionOrdinal,
  resolved,
  auxiliary,
  newGeneration,
  flockPath,
  syncParent = syncDirectory,
}) {
  if (typeof syncParent !== "function") fail("reference discovery parent sync is invalid");
  const plan = await readReferenceDiscoveryPlan(collectionDir, { flockPath });
  const session = requireSession(plan, sessionOrdinal);
  requireWorkloads(plan, resolved, auxiliary);
  const bundleDir = path.join(collectionDir, session.directory);
  await withBundleExecutionLease({ bundleDir: collectionDir, flockPath }, async (lease) => {
    assertBundleExecutionLeaseHeld(lease);
    const reread = await readPlanFromAdapter(adapterFor(collectionDir), lease);
    if (canonicalReferenceDiscoveryPlanLine(reread)
      .equals(canonicalReferenceDiscoveryPlanLine(plan)) === false) {
      fail("reference discovery plan changed during child initialization");
    }
    try {
      mkdirSync(bundleDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        fail(`reference discovery child could not be created: ${error?.code ?? "unknown error"}`);
      }
    }
    validateDirectory(bundleDir, "reference discovery child directory");
    try { syncParent(collectionDir); } catch {
      fail("reference discovery child directory was not committed durably",
        "REFERENCE_DISCOVERY_DIRECTORY_SYNC_FAILED");
    }
    assertBundleExecutionLeaseHeld(lease);
  });
  const expected = buildReferenceDiscoveryChildManifest({
    plan,
    sessionOrdinal,
    resolved,
    auxiliary,
    ...(newGeneration === undefined ? {} : { newGeneration }),
  });
  const bundle = await initializeChildManifest({ resolved, auxiliary, bundleDir, expected });
  return Object.freeze({ plan, session, bundleDir, bundle });
}
