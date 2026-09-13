#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { BUNDLE_EXECUTION_LEASE_BUSY_EXIT } from "../../diagnose-lib/bundle-execution-lease.mjs";
import { parseCpuList, validateReferenceHost } from "./controller.mjs";
import {
  planReferenceDiscovery,
  renderReferenceDiscoveryDryRun,
} from "./discovery-controller.mjs";
import {
  deriveReferenceDiscoveryReport,
  resumeReferenceDiscoveryCampaign,
  startReferenceDiscoveryCampaign,
} from "./discovery-campaign.mjs";
import { renderReferenceDiscoveryReportMarkdown } from "./discovery-protocol.mjs";

const SHA256_RE = /^[a-f0-9]{64}$/;

export class ReferenceDiscoveryCliError extends Error {
  constructor(message, code = "REFERENCE_DISCOVERY_ARGUMENTS_INVALID") {
    super(message);
    this.name = "ReferenceDiscoveryCliError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ReferenceDiscoveryCliError(message, code);
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${option} requires a value`);
  return value;
}

function absolutePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      Buffer.byteLength(value) > 16 * 1024) {
    fail(`${label} must be a bounded path`);
  }
  return path.resolve(value);
}

export function parseReferenceDiscoveryArgs(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    fail("arguments must be strings");
  }
  const options = {
    mode: "fresh",
    dryRun: true,
    yes: false,
    help: false,
    json: false,
    resultsRoot: null,
    outputName: undefined,
    targetCpus: undefined,
    loadCpus: undefined,
    expectedPreviewSha256: undefined,
    collectionDir: undefined,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (["--yes", "--dry-run", "--help", "-h", "--json"].includes(option)) {
      const key = option === "-h" ? "--help" : option;
      if (seen.has(key)) fail(`${option} may be supplied only once`);
      seen.add(key);
      if (key === "--yes") {
        if (seen.has("--dry-run")) fail("choose --yes or --dry-run, not both");
        options.yes = true;
        options.dryRun = false;
      } else if (key === "--dry-run") {
        if (seen.has("--yes")) fail("choose --yes or --dry-run, not both");
      } else if (key === "--help") options.help = true;
      else options.json = true;
      continue;
    }
    const valueOptions = new Map([
      ["--results-root", "resultsRoot"],
      ["--output-name", "outputName"],
      ["--target-cpus", "targetCpus"],
      ["--load-cpus", "loadCpus"],
      ["--expect-preview", "expectedPreviewSha256"],
      ["--resume", "resume"],
      ["--report", "report"],
    ]);
    const key = valueOptions.get(option);
    if (key === undefined) fail(`unknown argument '${option}'`);
    if (seen.has(option)) fail(`${option} may be supplied only once`);
    seen.add(option);
    const value = takeValue(argv, index, option);
    index += 1;
    if (key === "resultsRoot") options.resultsRoot = absolutePath(value, option);
    else if (key === "targetCpus" || key === "loadCpus") {
      try { options[key] = parseCpuList(value); } catch (error) { fail(error.message); }
    } else if (key === "resume" || key === "report") {
      if (options.mode !== "fresh") fail("choose only one --resume or --report mode");
      options.mode = key;
      options.collectionDir = absolutePath(value, option);
    } else options[key] = value;
  }
  if (options.help) return Object.freeze(options);

  if (options.mode === "report") {
    const forbidden = ["--yes", "--dry-run", "--results-root", "--output-name",
      "--target-cpus", "--load-cpus", "--expect-preview"].filter((key) => seen.has(key));
    if (forbidden.length > 0) fail(`--report cannot be combined with ${forbidden.join(", ")}`);
    return Object.freeze(options);
  }

  if (options.json) fail("--json is available only with --report");
  if (options.mode === "resume") {
    const forbidden = ["--results-root", "--output-name", "--target-cpus", "--load-cpus",
      "--expect-preview"].filter((key) => seen.has(key));
    if (forbidden.length > 0) fail(`--resume cannot be combined with ${forbidden.join(", ")}`);
    return Object.freeze(options);
  }

  if (options.resultsRoot === null) fail("--results-root DIR is required for a new screen");
  if ((options.targetCpus === undefined) !== (options.loadCpus === undefined)) {
    fail("supply both --target-cpus and --load-cpus for explicit CPU roles");
  }
  if (options.yes) {
    if (!SHA256_RE.test(options.expectedPreviewSha256 ?? "")) {
      fail("--yes requires the exact --expect-preview SHA-256 printed by the dry run");
    }
  } else if (options.expectedPreviewSha256 !== undefined) {
    fail("--expect-preview is valid only with --yes");
  }
  return Object.freeze(options);
}

function usage() {
  return `Usage: discover-reference --results-root DIR [options]\n` +
    `       discover-reference --resume DIR [--dry-run | --yes]\n` +
    `       discover-reference --report DIR [--json]\n\n` +
    `Safely previews a guided CPU screen by default. A workload can start only\n` +
    `with the exact --expect-preview SHA-256 and --yes command printed by that\n` +
    `preview. Resume is limited to the same machine and boot.\n\n` +
    `  --target-cpus LIST  explicit targets (requires --load-cpus)\n` +
    `  --load-cpus LIST    explicit fixed load set (requires --target-cpus)\n` +
    `  --output-name NAME  new reference-discovery-YYYYMMDDTHHMMSSZ leaf\n` +
    `  --dry-run           inspect only (default)\n` +
    `  --yes               start or resume the live workload\n` +
    `  --expect-preview H  exact fresh-plan digest printed by dry run\n` +
    `  --resume DIR        inspect or resume an existing collection\n` +
    `  --report DIR        rederive and print an existing collection report\n` +
    `  --json              JSON output for --report\n`;
}

function renderResumePreview(result, collectionDir, renderReport = renderReferenceDiscoveryReportMarkdown) {
  const report = result.report;
  const launcher = path.join(result.plan.identity.kitRoot, "bin/discover-reference");
  const terminal = report.complete
    ? "This screen is already complete; no resume work is required."
    : `To resume untouched targets on this same boot:\n\n` +
      `'${launcher.replaceAll("'", `'\"'\"'`)}' '--resume' ` +
      `'${collectionDir.replaceAll("'", `'\"'\"'`)}' '--yes'`;
  return `${renderReport(report).toString("utf8")}\n${terminal}\n\n` +
    "Nothing was executed.\n";
}

function printReport(report, json, output = console.log,
  renderReport = renderReferenceDiscoveryReportMarkdown) {
  if (json) output(JSON.stringify(report, null, 2));
  else output(renderReport(report).toString("utf8").trimEnd());
}

export async function runReferenceDiscoveryCli(argv = process.argv.slice(2), dependencies = {}) {
  const ownedAbort = dependencies.signal === undefined ? new AbortController() : null;
  const interrupt = () => ownedAbort.abort(new Error("reference discovery interrupted"));
  const output = dependencies.output ?? console.log;
  const errorOutput = dependencies.errorOutput ?? console.error;
  if (ownedAbort !== null) {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
  }
  try {
    const options = parseReferenceDiscoveryArgs(argv);
    if (options.help) { output(usage()); return 0; }
    (dependencies.validateHost ?? validateReferenceHost)(dependencies.host);
    const signal = dependencies.signal ?? ownedAbort.signal;
    if (options.mode === "report") {
      const result = await (dependencies.deriveReport ?? deriveReferenceDiscoveryReport)(
        options.collectionDir,
      );
      printReport(result.report, options.json, output, dependencies.renderReport);
      return 0;
    }
    if (options.mode === "resume") {
      if (options.dryRun) {
        const result = await (dependencies.deriveReport ?? deriveReferenceDiscoveryReport)(
          options.collectionDir,
        );
        output(renderResumePreview(result, options.collectionDir,
          dependencies.renderReport ?? renderReferenceDiscoveryReportMarkdown));
        return 0;
      }
      const result = await (dependencies.resumeCampaign ?? resumeReferenceDiscoveryCampaign)(
        options.collectionDir,
        { yes: true, signal, environment: dependencies.environment ?? process.env },
      );
      printReport(result.report, false, output, dependencies.renderReport);
      output(`Results: ${result.collectionDir}`);
      return result.report.complete ? 0 : 1;
    }
    const plan = (dependencies.plan ?? planReferenceDiscovery)({
      resultsRoot: options.resultsRoot,
      ...(options.outputName === undefined ? {} : { outputName: options.outputName }),
      ...(options.targetCpus === undefined ? {} : {
        targetCpus: options.targetCpus,
        loadCpus: options.loadCpus,
      }),
    });
    if (options.dryRun) {
      output((dependencies.renderDryRun ?? renderReferenceDiscoveryDryRun)(plan));
      return 0;
    }
    const result = await (dependencies.startCampaign ?? startReferenceDiscoveryCampaign)(plan, {
      yes: true,
      expectedPreviewSha256: options.expectedPreviewSha256,
      signal,
      environment: dependencies.environment ?? process.env,
    });
    printReport(result.report, false, output, dependencies.renderReport);
    output(`Results: ${result.collectionDir}`);
    return result.report.complete ? 0 : 1;
  } catch (error) {
    errorOutput(`error: ${error?.message ?? error}`);
    return error?.code === "BUNDLE_EXECUTION_LEASE_BUSY"
      ? BUNDLE_EXECUTION_LEASE_BUSY_EXIT : 2;
  } finally {
    if (ownedAbort !== null) {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await runReferenceDiscoveryCli();
}
