import { createHash } from "node:crypto";
import path from "node:path";

import {
  SCHEMA3_CAMPAIGN_REPORT_COMPLETION_FILE,
  SCHEMA3_CAMPAIGN_REPORT_JSON_FILE,
  SCHEMA3_CAMPAIGN_REPORT_MARKDOWN_FILE,
} from "../../diagnose-lib/schema3-bundle.mjs";
import {
  PinnedProtocolStateError,
  canonicalProtocolJson,
  createFileStateAdapter,
} from "../../diagnose-lib/pinned-protocol.mjs";
import {
  CAMPAIGN_REPORT_VERSION,
  renderCampaignReportMarkdown,
} from "./campaign-report.mjs";

export const CAMPAIGN_REPORT_COMPLETION_VERSION = 1;
export const CAMPAIGN_REPORT_JSON_MAX_BYTES = 16 * 1024 * 1024;
export const CAMPAIGN_REPORT_MARKDOWN_MAX_BYTES = 16 * 1024 * 1024;
export const CAMPAIGN_REPORT_COMPLETION_MAX_BYTES = 64 * 1024;

export class CampaignReportStoreError extends Error {
  constructor(message, code = "INVALID_CAMPAIGN_REPORT_STORE") {
    super(message);
    this.name = "CampaignReportStoreError";
    this.code = code;
  }
}

function fail(message) {
  throw new CampaignReportStoreError(message);
}

function binding(bytes) {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length ||
      actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function validateBinding(value, expected, label) {
  exactKeys(value, ["sha256", "bytes"], label);
  if (value.sha256 !== expected.sha256 || value.bytes !== expected.bytes) {
    fail(`${label} does not match its report artifact`);
  }
}

function canonicalCompletion(report, jsonBytes, markdownBytes) {
  return Buffer.from(`${canonicalProtocolJson({
    version: CAMPAIGN_REPORT_COMPLETION_VERSION,
    reportVersion: CAMPAIGN_REPORT_VERSION,
    bundleManifestBinding: report.bundle.manifestBinding,
    json: binding(jsonBytes),
    markdown: binding(markdownBytes),
  })}\n`, "utf8");
}

async function readRequired(adapter, name, maximum, label) {
  let bytes;
  try {
    bytes = await adapter.read(name, maximum);
  } catch (error) {
    if (error instanceof PinnedProtocolStateError) fail(`${label} could not be read safely`);
    throw error;
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximum) {
    fail(`${label} is empty or oversized`);
  }
  return bytes;
}

async function commitOrVerify(adapter, name, bytes, maximum, label) {
  try {
    await adapter.commit(name, bytes);
    return;
  } catch (error) {
    if (!(error instanceof PinnedProtocolStateError) && error?.code !== "EEXIST") throw error;
  }
  const stored = await readRequired(adapter, name, maximum, label);
  if (!stored.equals(bytes)) fail(`${label} already exists with different content`);
}

function decodeCompletion(bytes) {
  const text = bytes.toString("utf8");
  if (!text.endsWith("\n") || text.includes("\0") || text.includes("\r") ||
      text.slice(0, -1).includes("\n")) {
    fail("campaign report completion marker is not one canonical JSON line");
  }
  let value;
  try {
    value = JSON.parse(text.slice(0, -1));
  } catch {
    fail("campaign report completion marker is not valid JSON");
  }
  return value;
}

export async function publishCampaignReport({ bundleDir, report }) {
  if (typeof bundleDir !== "string" || !path.isAbsolute(bundleDir) ||
      report?.version !== CAMPAIGN_REPORT_VERSION || report.complete !== true ||
      report.bundle?.manifestVersion !== 7) {
    fail("only a complete manifest-v7 campaign report can be published");
  }
  const jsonBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownBytes = Buffer.from(renderCampaignReportMarkdown(report), "utf8");
  const completionBytes = canonicalCompletion(report, jsonBytes, markdownBytes);
  if (jsonBytes.length > CAMPAIGN_REPORT_JSON_MAX_BYTES ||
      markdownBytes.length > CAMPAIGN_REPORT_MARKDOWN_MAX_BYTES ||
      completionBytes.length > CAMPAIGN_REPORT_COMPLETION_MAX_BYTES) {
    fail("campaign report artifacts exceed their byte limits");
  }
  const adapter = createFileStateAdapter(bundleDir);
  await commitOrVerify(adapter, SCHEMA3_CAMPAIGN_REPORT_JSON_FILE, jsonBytes,
    CAMPAIGN_REPORT_JSON_MAX_BYTES, "campaign JSON report");
  await commitOrVerify(adapter, SCHEMA3_CAMPAIGN_REPORT_MARKDOWN_FILE, markdownBytes,
    CAMPAIGN_REPORT_MARKDOWN_MAX_BYTES, "campaign Markdown report");
  await commitOrVerify(adapter, SCHEMA3_CAMPAIGN_REPORT_COMPLETION_FILE, completionBytes,
    CAMPAIGN_REPORT_COMPLETION_MAX_BYTES, "campaign report completion marker");
  return Object.freeze({
    json: SCHEMA3_CAMPAIGN_REPORT_JSON_FILE,
    markdown: SCHEMA3_CAMPAIGN_REPORT_MARKDOWN_FILE,
    completion: SCHEMA3_CAMPAIGN_REPORT_COMPLETION_FILE,
  });
}

export async function readPublishedCampaignReport({ bundleDir, manifestBinding }) {
  if (typeof bundleDir !== "string" || !path.isAbsolute(bundleDir)) {
    fail("campaign report bundle directory must be absolute");
  }
  const adapter = createFileStateAdapter(bundleDir);
  const [jsonBytes, markdownBytes, completionBytes] = await Promise.all([
    readRequired(adapter, SCHEMA3_CAMPAIGN_REPORT_JSON_FILE,
      CAMPAIGN_REPORT_JSON_MAX_BYTES, "campaign JSON report"),
    readRequired(adapter, SCHEMA3_CAMPAIGN_REPORT_MARKDOWN_FILE,
      CAMPAIGN_REPORT_MARKDOWN_MAX_BYTES, "campaign Markdown report"),
    readRequired(adapter, SCHEMA3_CAMPAIGN_REPORT_COMPLETION_FILE,
      CAMPAIGN_REPORT_COMPLETION_MAX_BYTES, "campaign report completion marker"),
  ]);
  const completion = decodeCompletion(completionBytes);
  exactKeys(completion, [
    "version", "reportVersion", "bundleManifestBinding", "json", "markdown",
  ], "campaign report completion marker");
  if (completion.version !== CAMPAIGN_REPORT_COMPLETION_VERSION ||
      completion.reportVersion !== CAMPAIGN_REPORT_VERSION ||
      canonicalProtocolJson(completion.bundleManifestBinding) !==
        canonicalProtocolJson(manifestBinding)) {
    fail("campaign report completion marker belongs to a different bundle");
  }
  validateBinding(completion.json, binding(jsonBytes), "campaign JSON report binding");
  validateBinding(completion.markdown, binding(markdownBytes),
    "campaign Markdown report binding");
  if (!completionBytes.equals(canonicalCompletion({
    bundle: { manifestBinding },
  }, jsonBytes, markdownBytes))) {
    fail("campaign report completion marker is not canonical");
  }
  let report;
  try {
    report = JSON.parse(jsonBytes.toString("utf8"));
  } catch {
    fail("campaign JSON report is not valid JSON");
  }
  if (report?.version !== CAMPAIGN_REPORT_VERSION || report.complete !== true ||
      canonicalProtocolJson(report.bundle?.manifestBinding) !==
        canonicalProtocolJson(manifestBinding) ||
      markdownBytes.toString("utf8") !== renderCampaignReportMarkdown(report)) {
    fail("published campaign report artifacts do not reconcile");
  }
  return Object.freeze({ report, markdown: markdownBytes.toString("utf8"), completion });
}
