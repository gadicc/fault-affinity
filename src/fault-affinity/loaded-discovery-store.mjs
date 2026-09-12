import path from "node:path";

import { withBundleExecutionLease } from "../../diagnose-lib/bundle-execution-lease.mjs";
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
  parseSchema3BundleManifest,
} from "../../diagnose-lib/schema3-bundle.mjs";
import {
  LOADED_DISCOVERY_PLAN_FILE,
  LOADED_DISCOVERY_REPORT_JSON_FILE,
  LOADED_DISCOVERY_REPORT_MARKDOWN_FILE,
  LOADED_DISCOVERY_REPORT_VERSION,
  canonicalLoadedDiscoveryPlanLine,
  parseLoadedDiscoveryPlan,
  renderLoadedDiscoveryReportMarkdown,
} from "./loaded-discovery.mjs";

const PLAN_MAX_BYTES = 1024 * 1024;
const REPORT_MAX_BYTES = 16 * 1024 * 1024;

export class LoadedDiscoveryStoreError extends Error {
  constructor(message, code = "INVALID_LOADED_DISCOVERY_STORE") {
    super(message);
    this.name = "LoadedDiscoveryStoreError";
    this.code = code;
  }
}

function fail(message) {
  throw new LoadedDiscoveryStoreError(message);
}

function adapterFor(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0")) {
    fail("loaded discovery directory must be an absolute NUL-free path");
  }
  return createFileStateAdapter(directory);
}

async function withCollectionAdapter(directory, operation) {
  return withBundleExecutionLease({ bundleDir: directory }, async () => {
    const adapter = adapterFor(directory);
    // Recovery can remove a dead writer's verified temporary hard link or
    // finish its ready publication. Keep it inside the collection's lease.
    await adapter.list();
    return operation(adapter);
  });
}

async function readRequired(adapter, name, maximum, label) {
  try {
    const bytes = await adapter.read(name, maximum);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum) {
      fail(`${label} is empty or oversized`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof LoadedDiscoveryStoreError) throw error;
    if (error instanceof PinnedProtocolStateError) fail(`${label} could not be read safely`);
    throw error;
  }
}

async function commitOrVerify(adapter, name, bytes, maximum, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum) {
    fail(`${label} is empty or oversized`);
  }
  try {
    await adapter.commit(name, bytes);
    return;
  } catch (error) {
    if (!(error instanceof PinnedProtocolStateError) && error?.code !== "EEXIST") throw error;
  }
  const stored = await readRequired(adapter, name, maximum, label);
  if (!stored.equals(bytes)) fail(`${label} already exists with different content`);
}

export async function publishLoadedDiscoveryPlan(directory, plan) {
  const bytes = canonicalLoadedDiscoveryPlanLine(plan);
  await withCollectionAdapter(directory, (adapter) =>
    commitOrVerify(adapter, LOADED_DISCOVERY_PLAN_FILE, bytes,
      PLAN_MAX_BYTES, "loaded discovery plan"));
  return LOADED_DISCOVERY_PLAN_FILE;
}

export async function readLoadedDiscoveryPlan(directory) {
  const bytes = await withCollectionAdapter(directory, (adapter) =>
    readRequired(adapter, LOADED_DISCOVERY_PLAN_FILE, PLAN_MAX_BYTES,
      "loaded discovery plan"));
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.includes("\0") || text.includes("\r") ||
      text.slice(0, -1).includes("\n")) {
    fail("loaded discovery plan is not one canonical JSON line");
  }
  let value;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    fail("loaded discovery plan is not valid JSON");
  }
  const plan = parseLoadedDiscoveryPlan(value);
  if (!bytes.equals(canonicalLoadedDiscoveryPlanLine(plan))) {
    fail("loaded discovery plan is not canonical");
  }
  return plan;
}

export async function initializeLoadedDiscoveryChild({
  resolved,
  auxiliary,
  bundleDir,
  manifest: freshManifest,
}) {
  const expected = parseSchema3BundleManifest(resolved, freshManifest, auxiliary);
  if (expected.version !== 5) fail("loaded discovery children require manifest version 5");
  const manifest = await withBundleExecutionLease({ bundleDir }, async () => {
    const adapter = adapterFor(bundleDir);
    const names = await adapter.list();
    if (!names.includes(SCHEMA3_BUNDLE_FILE)) return expected;
    const bytes = await readRequired(adapter, SCHEMA3_BUNDLE_FILE,
      SCHEMA3_BUNDLE_FILE_MAX_BYTES, "loaded discovery child manifest");
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("loaded discovery child manifest is not valid JSON");
    }
    const stored = parseSchema3BundleManifest(resolved, value, auxiliary);
    if (stored.version !== 5) fail("loaded discovery child does not match its planned manifest");
    // Generations are assigned once at publication. Rebuild the expected
    // manifest using those identities so every other bound field must match
    // before initialization is allowed to repair missing phase directories.
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
      fail("loaded discovery child does not match its planned manifest");
    }
    return stored;
  });
  // The initializer reacquires the same lease and checks byte equality with
  // this immutable manifest before repairing any missing initialization state.
  return initializeSchema3Bundle({ resolved, auxiliary, bundleDir, manifest });
}

export async function publishLoadedDiscoveryReport(directory, report) {
  if (report?.version !== LOADED_DISCOVERY_REPORT_VERSION || report.complete !== true) {
    fail("only a complete loaded discovery report can be published");
  }
  const json = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdown = Buffer.from(renderLoadedDiscoveryReportMarkdown(report), "utf8");
  await withCollectionAdapter(directory, async (adapter) => {
    await commitOrVerify(adapter, LOADED_DISCOVERY_REPORT_JSON_FILE, json,
      REPORT_MAX_BYTES, "loaded discovery JSON report");
    await commitOrVerify(adapter, LOADED_DISCOVERY_REPORT_MARKDOWN_FILE, markdown,
      REPORT_MAX_BYTES, "loaded discovery Markdown report");
  });
  return Object.freeze({
    json: LOADED_DISCOVERY_REPORT_JSON_FILE,
    markdown: LOADED_DISCOVERY_REPORT_MARKDOWN_FILE,
  });
}
