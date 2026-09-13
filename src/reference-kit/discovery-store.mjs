import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  assertBundleExecutionLeaseHeld,
  bundleExecutionLeaseAttemptRetention,
  bundleExecutionLeaseEvidence,
  withBundleExecutionLease,
} from "../../diagnose-lib/bundle-execution-lease.mjs";
import { buildControlledLoadSessionManifest } from "../../diagnose-lib/controlled-load-session.mjs";
import { buildExactCpuPhaseManifest } from "../../diagnose-lib/exact-cpu-phase.mjs";
import {
  canonicalProtocolJson,
  PinnedProtocolStateError,
  createFileStateAdapter,
  createReadOnlyFileStateAdapter,
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
  canonicalReferenceDiscoveryReportLine,
  canonicalReferenceDiscoveryPlanLine,
  parseReferenceDiscoveryPlan,
  referenceDiscoveryPlanBinding,
  renderReferenceDiscoveryReportMarkdown,
} from "./discovery-protocol.mjs";

export const REFERENCE_DISCOVERY_PLAN_FILE = "reference-discovery-plan.json";
export const REFERENCE_DISCOVERY_COORDINATION_FILE = "reference-discovery-coordination.json";
export const REFERENCE_DISCOVERY_COORDINATION_DIRECTORY = "coordination";
export const REFERENCE_DISCOVERY_REPORT_JSON_FILE = "reference-discovery-report.json";
export const REFERENCE_DISCOVERY_REPORT_MARKDOWN_FILE = "reference-discovery-report.md";
export const REFERENCE_DISCOVERY_REPORT_COMPLETION_FILE = "reference-discovery-report.complete";

const PLAN_MAX_BYTES = 1024 * 1024;
const COORDINATION_MAX_BYTES = 16 * 1024;
const REPORT_MAX_BYTES = 16 * 1024 * 1024;
const REPORT_MARKDOWN_MAX_BYTES = 1024 * 1024;
const REPORT_COMPLETION_MAX_BYTES = 4 * 1024;
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

function adapterFor(directory, { readOnly = false } = {}) {
  const validated = validateDirectory(directory, "reference discovery collection");
  return readOnly
    ? createReadOnlyFileStateAdapter(validated)
    : createFileStateAdapter(validated);
}

function ensurePrivateSubdirectory(parent, name, label) {
  const directory = path.join(parent, name);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      fail(`${label} could not be created: ${error?.code ?? "unknown error"}`);
    }
  }
  const validated = validateDirectory(directory, label);
  try { syncDirectory(parent); } catch {
    fail(`${label} directory was not committed durably`,
      "REFERENCE_DISCOVERY_DIRECTORY_SYNC_FAILED");
  }
  return validated;
}

function directoryIdentity(stats) {
  return { device: stats.dev.toString(), inode: stats.ino.toString() };
}

function sameDirectoryIdentity(stats, identity) {
  return stats.isDirectory() && stats.dev.toString() === identity.device &&
    stats.ino.toString() === identity.inode;
}

function coordinationBindingBytesForIdentities(plan, collection, coordination) {
  return Buffer.from(`${canonicalProtocolJson({
    version: 1,
    plan: referenceDiscoveryPlanBinding(plan),
    collection,
    coordination,
  })}\n`, "utf8");
}

async function ensureCoordinationWithLease(plan, collection, adapter, lease) {
  const directory = ensurePrivateSubdirectory(collection,
    REFERENCE_DISCOVERY_COORDINATION_DIRECTORY, "reference discovery coordination");
  assertBundleExecutionLeaseHeld(lease);
  const binding = {
    collection: directoryIdentity(lstatSync(collection, { bigint: true })),
    coordination: directoryIdentity(lstatSync(directory, { bigint: true })),
  };
  await commitOrVerify(adapter, collection, REFERENCE_DISCOVERY_COORDINATION_FILE,
    coordinationBindingBytesForIdentities(plan, binding.collection, binding.coordination),
    COORDINATION_MAX_BYTES,
    "reference discovery coordination binding", lease);
  assertBundleExecutionLeaseHeld(lease);
  if (!sameDirectoryIdentity(lstatSync(collection, { bigint: true }), binding.collection) ||
      !sameDirectoryIdentity(lstatSync(directory, { bigint: true }), binding.coordination)) {
    fail("reference discovery collection or coordination directory changed during binding",
      "REFERENCE_DISCOVERY_COORDINATION_MISMATCH");
  }
  return directory;
}

async function readCoordinationContext(collectionDir, flockPath, { readOnly = false } = {}) {
  return withBundleExecutionLease({ bundleDir: collectionDir, flockPath }, async (lease) => {
    assertBundleExecutionLeaseHeld(lease);
    const collection = validateDirectory(collectionDir, "reference discovery collection");
    const adapter = adapterFor(collection, { readOnly });
    await adapter.list();
    assertBundleExecutionLeaseHeld(lease);
    const plan = await readPlanFromAdapter(adapter, lease);
    if (plan.storage.collectionDir !== collection) {
      fail("reference discovery plan was moved from its bound collection path");
    }
    const coordination = validateDirectory(
      path.join(collection, REFERENCE_DISCOVERY_COORDINATION_DIRECTORY),
      "reference discovery coordination",
    );
    const binding = Object.freeze({
      collection: Object.freeze(directoryIdentity(lstatSync(collection, { bigint: true }))),
      coordination: Object.freeze(directoryIdentity(lstatSync(coordination, { bigint: true }))),
    });
    const expected = coordinationBindingBytesForIdentities(
      plan,
      binding.collection,
      binding.coordination,
    );
    const stored = await readRequired(adapter, REFERENCE_DISCOVERY_COORDINATION_FILE,
      COORDINATION_MAX_BYTES, "reference discovery coordination binding", lease);
    const currentCollection = lstatSync(collection, { bigint: true });
    const currentCoordination = lstatSync(coordination, { bigint: true });
    if (!stored.equals(expected) || !sameDirectoryIdentity(currentCollection, binding.collection) ||
        !sameDirectoryIdentity(currentCoordination, binding.coordination)) {
      fail("reference discovery collection or coordination directory identity changed",
        "REFERENCE_DISCOVERY_COORDINATION_MISMATCH");
    }
    return Object.freeze({
      collection,
      coordination,
      binding,
    });
  });
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
  requireFresh = false,
  syncParent = syncDirectory,
} = {}) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  if (typeof syncParent !== "function" || typeof requireFresh !== "boolean") {
    fail("reference discovery collection options are invalid");
  }
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
    const names = await adapter.list();
    assertBundleExecutionLeaseHeld(lease);
    if (requireFresh && names.length > 0) {
      fail("reference discovery collection already has state; use explicit resume",
        "REFERENCE_DISCOVERY_COLLECTION_EXISTS");
    }
    await commitOrVerify(adapter, collection, REFERENCE_DISCOVERY_PLAN_FILE,
      canonicalReferenceDiscoveryPlanLine(plan), PLAN_MAX_BYTES, "reference discovery plan", lease);
    assertBundleExecutionLeaseHeld(lease);
    await ensureCoordinationWithLease(plan, collection, adapter, lease);
    assertBundleExecutionLeaseHeld(lease);
  });
  return collection;
}

export async function withReferenceDiscoveryCoordinator({
  collectionDir,
  flockPath,
  waitMs = 0,
  readOnly = false,
}, operation) {
  if (typeof operation !== "function") fail("reference discovery coordinator operation is required");
  if (typeof readOnly !== "boolean") fail("reference discovery read-only selection is invalid");
  const context = await readCoordinationContext(collectionDir, flockPath, { readOnly });
  let collectionFd;
  try {
    collectionFd = openSync(context.collection, constants.O_RDONLY |
      (constants.O_DIRECTORY === undefined ? 0 : constants.O_DIRECTORY) |
      (constants.O_NOFOLLOW === undefined ? 0 : constants.O_NOFOLLOW));
    const opened = fstatSync(collectionFd, { bigint: true });
    if (!sameDirectoryIdentity(opened, context.binding.collection)) {
      fail("reference discovery collection changed before coordination was acquired",
        "REFERENCE_DISCOVERY_COORDINATION_MISMATCH");
    }
    return await withBundleExecutionLease({
      bundleDir: context.coordination,
      flockPath,
      waitMs,
    }, async (lease) => {
      const assertHeld = () => {
        assertBundleExecutionLeaseHeld(lease);
        let collectionPath;
        let collectionDescriptor;
        let coordinationPath;
        try {
          collectionPath = lstatSync(context.collection, { bigint: true });
          collectionDescriptor = fstatSync(collectionFd, { bigint: true });
          coordinationPath = lstatSync(context.coordination, { bigint: true });
        } catch {
          fail("reference discovery coordinated directory identity is unavailable",
            "REFERENCE_DISCOVERY_COORDINATION_MISMATCH");
        }
        if (!sameDirectoryIdentity(collectionPath, context.binding.collection) ||
            !sameDirectoryIdentity(collectionDescriptor, context.binding.collection) ||
            !sameDirectoryIdentity(coordinationPath, context.binding.coordination)) {
          fail("reference discovery collection or coordination directory changed while active",
            "REFERENCE_DISCOVERY_COORDINATION_MISMATCH");
        }
        return true;
      };
      assertHeld();
      const retainedCoordinator = bundleExecutionLeaseAttemptRetention(lease);
      const retainedCollection = Object.freeze({
        fd: collectionFd,
        ...context.binding.collection,
      });
      const owner = bundleExecutionLeaseEvidence(lease).owner;
      const result = await operation(Object.freeze({
        lease,
        retainedCoordinator,
        retainedCollection,
        owner,
        assertHeld,
      }));
      assertHeld();
      return result;
    });
  } finally {
    if (collectionFd !== undefined) closeSync(collectionFd);
  }
}

export async function ensureReferenceDiscoveryCoordinationDirectory(collectionDir, {
  flockPath,
} = {}) {
  return withBundleExecutionLease({ bundleDir: collectionDir, flockPath }, async (lease) => {
    assertBundleExecutionLeaseHeld(lease);
    const collection = validateDirectory(collectionDir, "reference discovery collection");
    const plan = await readPlanFromAdapter(adapterFor(collection), lease);
    if (plan.storage.collectionDir !== collection) {
      fail("reference discovery plan was moved from its bound collection path");
    }
    const directory = await ensureCoordinationWithLease(plan, collection,
      adapterFor(collection), lease);
    assertBundleExecutionLeaseHeld(lease);
    return directory;
  });
}

function reportBinding(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length.toString(),
  };
}

function reportCompletionBytes(reportBytes, markdownBytes) {
  return Buffer.from(`${canonicalProtocolJson({
    version: 1,
    report: reportBinding(reportBytes),
    markdown: reportBinding(markdownBytes),
  })}\n`, "utf8");
}

export async function publishReferenceDiscoveryReport({
  collectionDir,
  report,
  flockPath,
}) {
  const reportBytes = canonicalReferenceDiscoveryReportLine(report);
  const markdownBytes = renderReferenceDiscoveryReportMarkdown(report);
  const completionBytes = reportCompletionBytes(reportBytes, markdownBytes);
  return withBundleExecutionLease({ bundleDir: collectionDir, flockPath }, async (lease) => {
    assertBundleExecutionLeaseHeld(lease);
    const collection = validateDirectory(collectionDir, "reference discovery collection");
    const adapter = adapterFor(collection);
    await adapter.list();
    assertBundleExecutionLeaseHeld(lease);
    const plan = await readPlanFromAdapter(adapter, lease);
    if (plan.storage.collectionDir !== collectionDir ||
        canonicalProtocolJson(referenceDiscoveryPlanBinding(plan)) !==
        canonicalProtocolJson(report.plan)) {
      fail("reference discovery report belongs to a different collection plan");
    }
    await commitOrVerify(adapter, collection, REFERENCE_DISCOVERY_REPORT_JSON_FILE,
      reportBytes, REPORT_MAX_BYTES, "reference discovery JSON report", lease);
    await commitOrVerify(adapter, collection, REFERENCE_DISCOVERY_REPORT_MARKDOWN_FILE,
      markdownBytes, REPORT_MARKDOWN_MAX_BYTES, "reference discovery Markdown report", lease);
    await commitOrVerify(adapter, collection, REFERENCE_DISCOVERY_REPORT_COMPLETION_FILE,
      completionBytes, REPORT_COMPLETION_MAX_BYTES,
      "reference discovery report completion marker", lease);
    assertBundleExecutionLeaseHeld(lease);
    return Object.freeze({
      report: reportBinding(reportBytes),
      markdown: reportBinding(markdownBytes),
      completion: reportBinding(completionBytes),
    });
  });
}

export async function verifyReferenceDiscoveryReportPublication({
  collectionDir,
  report,
  flockPath,
  readOnly = false,
}) {
  if (typeof readOnly !== "boolean") fail("reference discovery read-only selection is invalid");
  const expected = new Map([
    [REFERENCE_DISCOVERY_REPORT_JSON_FILE, {
      bytes: canonicalReferenceDiscoveryReportLine(report), maximum: REPORT_MAX_BYTES,
      label: "reference discovery JSON report",
    }],
    [REFERENCE_DISCOVERY_REPORT_MARKDOWN_FILE, {
      bytes: renderReferenceDiscoveryReportMarkdown(report), maximum: REPORT_MARKDOWN_MAX_BYTES,
      label: "reference discovery Markdown report",
    }],
  ]);
  expected.set(REFERENCE_DISCOVERY_REPORT_COMPLETION_FILE, {
    bytes: reportCompletionBytes(
      expected.get(REFERENCE_DISCOVERY_REPORT_JSON_FILE).bytes,
      expected.get(REFERENCE_DISCOVERY_REPORT_MARKDOWN_FILE).bytes,
    ),
    maximum: REPORT_COMPLETION_MAX_BYTES,
    label: "reference discovery report completion marker",
  });
  return withBundleExecutionLease({ bundleDir: collectionDir, flockPath }, async (lease) => {
    assertBundleExecutionLeaseHeld(lease);
    const adapter = adapterFor(collectionDir, { readOnly });
    const names = await adapter.list();
    assertBundleExecutionLeaseHeld(lease);
    const plan = await readPlanFromAdapter(adapter, lease);
    if (plan.storage.collectionDir !== collectionDir ||
        canonicalProtocolJson(referenceDiscoveryPlanBinding(plan)) !==
        canonicalProtocolJson(report.plan)) {
      fail("reference discovery report belongs to a different collection plan");
    }
    const present = [...expected.keys()].filter((name) => names.includes(name));
    if (present.length === 0) return null;
    if (present.length !== expected.size) {
      fail("reference discovery report publication is incomplete",
        "REFERENCE_DISCOVERY_REPORT_INCOMPLETE");
    }
    for (const [name, item] of expected) {
      const stored = await readRequired(adapter, name, item.maximum, item.label, lease);
      if (!stored.equals(item.bytes)) {
        fail(`${item.label} does not match the authoritative report`,
          "REFERENCE_DISCOVERY_REPORT_MISMATCH");
      }
    }
    return Object.freeze({
      report: reportBinding(expected.get(REFERENCE_DISCOVERY_REPORT_JSON_FILE).bytes),
      markdown: reportBinding(expected.get(REFERENCE_DISCOVERY_REPORT_MARKDOWN_FILE).bytes),
      completion: reportBinding(expected.get(REFERENCE_DISCOVERY_REPORT_COMPLETION_FILE).bytes),
    });
  });
}

export async function readReferenceDiscoveryPlan(collectionDir, {
  flockPath,
  readOnly = false,
} = {}) {
  if (typeof readOnly !== "boolean") fail("reference discovery read-only selection is invalid");
  return withBundleExecutionLease({ bundleDir: collectionDir, flockPath }, async (lease) => {
    assertBundleExecutionLeaseHeld(lease);
    const adapter = adapterFor(collectionDir, { readOnly });
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
