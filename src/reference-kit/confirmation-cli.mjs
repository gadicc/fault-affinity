#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BUNDLE_EXECUTION_LEASE_BUSY_EXIT } from "../../diagnose-lib/bundle-execution-lease.mjs";
import {
  executeReferenceProfile,
  inspectOutputStorage,
  parseCpuList,
} from "./controller.mjs";
import {
  deriveReferenceDiscoveryReport,
  withReferenceDiscoveryReportSnapshot,
} from "./discovery-campaign.mjs";
import {
  REFERENCE_CONFIRMATION_PROFILE,
  collectReferenceDiscoveryResources,
  normalizeReferenceDiscoveryStorageObservation,
  revalidateReferenceDiscoveryContext,
  revalidateReferenceDiscoveryOwnerExecution,
  resolveReferenceDiscoveryWorkloads,
} from "./discovery-controller.mjs";
import { referenceDiscoveryConfirmationSourceBinding } from "./discovery-protocol.mjs";

export const REFERENCE_CONFIRMATION_FORMAT_VERSION = 2;
export const REFERENCE_CONFIRMATION_PROTOCOL = "reference-discovery-confirmation-v1";
export const REFERENCE_CONFIRMATION_OUTPUT_PREFIX = "reference-confirmation-";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAFE_OUTPUT_NAME_RE =
  /^reference-confirmation-[0-9]{8}T[0-9]{6}Z(?:-[a-z0-9][a-z0-9-]{0,31})?$/;
const NON_UNIX_FILESYSTEMS = new Set(["vfat", "exfat", "ntfs", "ntfs3", "fuseblk"]);

export class ReferenceConfirmationError extends Error {
  constructor(message, code = "REFERENCE_CONFIRMATION_INPUT_INVALID") {
    super(message);
    this.name = "ReferenceConfirmationError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ReferenceConfirmationError(message, code);
}

function defaultOutputName(now = new Date()) {
  return `${REFERENCE_CONFIRMATION_OUTPUT_PREFIX}` +
    now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined) fail(`${option} requires a value`);
  return value;
}

export function parseReferenceConfirmationArgs(argv, { now = () => new Date() } = {}) {
  const options = {
    help: false,
    dryRun: true,
    yes: false,
    fromDiscovery: null,
    resultsRoot: null,
    outputName: null,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--yes" || arg === "--dry-run") {
      if (seen.has(arg)) fail(`${arg} may be supplied only once`);
      if (seen.has(arg === "--yes" ? "--dry-run" : "--yes")) {
        fail("choose --yes or --dry-run, not both");
      }
      seen.add(arg);
      options.yes = arg === "--yes";
      options.dryRun = arg === "--dry-run";
    } else if (["--from-discovery", "--results-root", "--output-name"].includes(arg)) {
      if (seen.has(arg)) fail(`${arg} may be supplied only once`);
      seen.add(arg);
      const value = takeValue(argv, index, arg);
      index += 1;
      if (arg === "--from-discovery") options.fromDiscovery = path.resolve(value);
      else if (arg === "--results-root") options.resultsRoot = path.resolve(value);
      else options.outputName = value;
    } else fail(`unknown argument '${arg}'`);
  }
  if (options.help) return Object.freeze(options);
  if (options.fromDiscovery === null) fail("--from-discovery DIR is required");
  options.outputName ??= defaultOutputName(now());
  if (!SAFE_OUTPUT_NAME_RE.test(options.outputName)) {
    fail("--output-name must be reference-confirmation-YYYYMMDDTHHMMSSZ with an optional lowercase suffix");
  }
  return Object.freeze(options);
}

export function referenceConfirmationUsage() {
  return `Usage: confirm-reference --from-discovery DIR [options]\n\n` +
    `Rederives the selected CPU from a complete guided screen and previews a\n` +
    `fresh A1/B/A2 confirmation by default. It never reuses discovery samples.\n\n` +
    `  --results-root DIR  persistent Unix destination (default: screen root)\n` +
    `  --output-name NAME  new reference-confirmation-YYYYMMDDTHHMMSSZ leaf\n` +
    `  --dry-run           inspect only (default)\n` +
    `  --yes               perform the separate live confirmation\n`;
}

function currentAllowedCpus() {
  const value = readFileSync("/proc/self/status", "utf8")
    .match(/^Cpus_allowed_list:\s*(\S+)\s*$/m)?.[1];
  if (value === undefined) {
    fail("cannot read the confirmation controller CPU allowance",
      "REFERENCE_CONFIRMATION_AFFINITY_INVALID");
  }
  return parseCpuList(value);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function confirmationReexecArgs(options) {
  return [
    "--from-discovery", options.fromDiscovery,
    "--results-root", options.resultsRoot,
    "--output-name", options.outputName,
    "--yes",
  ];
}

export function renderReferenceConfirmationDryRun(plan) {
  const source = plan.confirmation;
  const command = [
    path.join(source.discoveryPlan.identity.kitRoot, "bin/confirm-reference"),
    ...confirmationReexecArgs({
      fromDiscovery: source.collectionDir,
      resultsRoot: plan.outputRoot,
      outputName: path.basename(plan.outputLeaf),
    }),
  ].map(shellQuote).join(" ");
  const safeStorage = plan.storage.classification === "likely-persistent" &&
    !NON_UNIX_FILESYSTEMS.has(plan.storage.filesystemType) &&
    source.resources.meetsMinimum === true;
  return [
    "Fault Affinity selected-CPU confirmation — dry run",
    "",
    `Source screen: ${source.collectionDir}`,
    `Selected target CPU: ${plan.selection.targetCpu}`,
    `Controller CPU: ${plan.selection.controllerCpu}`,
    `Fixed load CPUs: ${plan.selection.loadCpus.join(", ")}`,
    `Fresh schedule: ${plan.selection.attemptsPerLeg} attempts in each A1 / B / A2 leg`,
    `Results: ${plan.outputLeaf}`,
    ...(plan.storage.warning === null ? [] : [plan.storage.warning]),
    "",
    "The screen was rederived from its authoritative artifacts on this machine and boot.",
    "Discovery samples are not included in this confirmation.",
    "Nothing was executed and no result directory was created.",
    ...(safeStorage ? ["", "To run this separate confirmation:", "", command] : [
      "",
      "No --yes command is shown until memory and persistent Unix storage checks pass.",
    ]),
    "",
  ].join("\n");
}

function sameCpuList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function atOrBelow(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function validateConfirmationOutputRoot(requested, snapshot, revalidated, dependencies) {
  let canonical;
  try { canonical = (dependencies.realpath ?? realpathSync)(requested); }
  catch {
    fail("confirmation results root is missing or cannot be resolved",
      "REFERENCE_CONFIRMATION_OUTPUT_INVALID");
  }
  const collection = snapshot.plan.storage.collectionDir;
  const app = revalidated?.layout?.app ?? path.join(snapshot.plan.identity.kitRoot, "app");
  if (atOrBelow(collection, canonical)) {
    fail("confirmation results must not be written inside the discovery source",
      "REFERENCE_CONFIRMATION_OUTPUT_INVALID");
  }
  if (atOrBelow(app, canonical)) {
    fail("confirmation results must not be written inside the verified kit app tree",
      "REFERENCE_CONFIRMATION_OUTPUT_INVALID");
  }
  return canonical;
}

function requireNotAborted(signal) {
  if (signal?.aborted) {
    throw Object.assign(new Error("reference confirmation was cancelled before live execution"), {
      code: "REFERENCE_EXTERNAL_CANCEL",
    });
  }
}

function selectedSession(snapshot) {
  const candidate = snapshot.report?.highestObservedFaultRateCandidate;
  const session = snapshot.plan?.schedule?.sessions?.find((entry) =>
    entry.targetCpu === candidate);
  if (!Number.isSafeInteger(candidate) || session === undefined) {
    fail("guided screen has no candidate that can authorize confirmation",
      "REFERENCE_CONFIRMATION_SOURCE_INELIGIBLE");
  }
  return { candidate, session };
}

function confirmationExecutionDependencies(dependencies) {
  const executionDependencies = {
    ...dependencies,
    ...(dependencies.referenceExecutionDependencies ?? {}),
  };
  const inspectStorage = executionDependencies.inspectStorage ?? inspectOutputStorage;
  return {
    ...executionDependencies,
    inspectStorage: (root) => {
      const observed = inspectStorage(root);
      const normalized = normalizeReferenceDiscoveryStorageObservation(observed);
      return Object.freeze({
        ...observed,
        availableBytes: normalized.available.toString(),
        classification: normalized.classification,
        warning: normalized.warning,
      });
    },
  };
}

function reexecConfirmation(options, controllerCpu, context, dependencies) {
  requireNotAborted(dependencies.signal);
  if (dependencies.reexecConfirmation !== undefined) {
    return dependencies.reexecConfirmation({ options, controllerCpu, context });
  }
  if (typeof process.execve !== "function" || context?.layout === undefined ||
      context?.launchEnvironment === undefined) {
    fail("bundled controller runtime cannot re-exec confirmation with singleton affinity",
      "REFERENCE_CONFIRMATION_AFFINITY_INVALID");
  }
  process.execve(context.layout.taskset, [
    context.layout.taskset,
    "-c",
    String(controllerCpu),
    context.layout.controllerNode,
    path.join(HERE, "confirmation-cli.mjs"),
    ...confirmationReexecArgs(options),
  ], context.launchEnvironment);
  fail("confirmation affinity re-exec unexpectedly returned",
    "REFERENCE_CONFIRMATION_AFFINITY_INVALID");
}

async function executeFromSnapshot(options, snapshot, current, dependencies, coordinator = null) {
  requireNotAborted(dependencies.signal);
  const { candidate, session } = selectedSession(snapshot);
  const ownerBound = sameCpuList(current, [session.controllerCpu]);
  const revalidate = ownerBound
    ? dependencies.revalidateOwnerContext ?? revalidateReferenceDiscoveryOwnerExecution
    : dependencies.revalidateContext ?? revalidateReferenceDiscoveryContext;
  const revalidated = await revalidate(snapshot.plan,
    dependencies.revalidationDependencies ?? {});
  requireNotAborted(dependencies.signal);
  const buildSource = dependencies.buildSourceBinding ??
    referenceDiscoveryConfirmationSourceBinding;
  const sourceBinding = buildSource(snapshot.plan, snapshot.report);
  const resources = (dependencies.collectResources ?? collectReferenceDiscoveryResources)(
    dependencies.revalidationDependencies ?? {},
  );
  if (options.yes && resources.meetsMinimum !== true) {
    fail("confirmation memory headroom is below the live minimum",
      "REFERENCE_CONFIRMATION_RESOURCE_LOW");
  }
  const resultsRoot = validateConfirmationOutputRoot(
    options.resultsRoot ?? snapshot.plan.storage.resultsRoot,
    snapshot,
    revalidated,
    dependencies,
  );
  const executionOptions = Object.freeze({
    dryRun: options.dryRun,
    yes: options.yes,
    fromDiscovery: snapshot.plan.storage.collectionDir,
    resultsRoot,
    outputName: options.outputName,
    targetCpu: candidate,
    controllerCpu: session.controllerCpu,
    loadCpus: Object.freeze([...snapshot.plan.selection.loadCpus]),
    attemptsPerLeg: REFERENCE_CONFIRMATION_PROFILE.attemptsPerLeg,
  });
  if (options.yes && !ownerBound) {
    const delegatedResult = await reexecConfirmation(executionOptions, session.controllerCpu,
      revalidated, dependencies);
    return Object.freeze({ executed: false, delegated: true, delegatedResult });
  }
  if (options.yes && coordinator === null) {
    fail("live confirmation requires retained discovery ownership",
      "REFERENCE_CONFIRMATION_OWNERSHIP_REQUIRED");
  }
  if (options.yes && revalidated?.workloads === undefined) {
    fail("live confirmation revalidation did not retain the source workloads",
      "REFERENCE_CONFIRMATION_SOURCE_MISMATCH");
  }
  const execution = Object.freeze({
    formatVersion: REFERENCE_CONFIRMATION_FORMAT_VERSION,
    profile: REFERENCE_CONFIRMATION_PROFILE,
    controllerModule: path.join(HERE, "confirmation-cli.mjs"),
    reexecArgs: confirmationReexecArgs,
    resolveWorkloads: revalidated?.workloads === undefined
      ? resolveReferenceDiscoveryWorkloads
      : () => revalidated.workloads,
    requirePersistentStorage: true,
    ...(coordinator === null ? {} : {
      assertAuthorizationHeld: coordinator.assertHeld,
      retainedAuthorizationDirectory: coordinator.retainedCoordinator,
    }),
    planExtra: {
      confirmation: {
        version: 1,
        protocol: REFERENCE_CONFIRMATION_PROTOCOL,
        collectionDir: snapshot.plan.storage.collectionDir,
        source: sourceBinding,
        discoveryPlan: snapshot.plan,
        discoveryReport: snapshot.report,
        resources,
      },
    },
  });
  requireNotAborted(dependencies.signal);
  return (dependencies.executeProfile ?? executeReferenceProfile)(executionOptions, execution,
    confirmationExecutionDependencies(dependencies));
}

export async function executeReferenceConfirmation(options, dependencies = {}) {
  const derive = dependencies.deriveReport ?? deriveReferenceDiscoveryReport;
  const initial = await derive(options.fromDiscovery,
    dependencies.discoveryDependencies ?? {});
  requireNotAborted(dependencies.signal);
  const { session } = selectedSession(initial);
  const current = (dependencies.readCurrentAllowedCpus ?? currentAllowedCpus)();
  if (!options.yes) {
    return executeFromSnapshot(options, initial, current, dependencies);
  }
  if (!sameCpuList(current, [session.controllerCpu])) {
    return executeFromSnapshot(options, initial, current, dependencies);
  }
  requireNotAborted(dependencies.signal);
  const withSnapshot = dependencies.withReferenceDiscoveryReportSnapshot ??
    withReferenceDiscoveryReportSnapshot;
  return withSnapshot(initial.plan.storage.collectionDir, async (snapshot, coordinator) => {
    coordinator.assertHeld();
    const selected = selectedSession(snapshot);
    if (selected.session.controllerCpu !== session.controllerCpu) {
      fail("confirmation candidate changed before source ownership was acquired",
        "REFERENCE_CONFIRMATION_SOURCE_MISMATCH");
    }
    const result = await executeFromSnapshot(options, snapshot, current, dependencies, coordinator);
    coordinator.assertHeld();
    return result;
  }, dependencies.discoveryDependencies ?? {});
}

export async function runReferenceConfirmationCli(argv = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output ?? console.log;
  const errorOutput = dependencies.errorOutput ?? console.error;
  const ownedAbort = dependencies.signal === undefined ? new AbortController() : null;
  const interrupt = () => ownedAbort.abort(new Error("reference confirmation interrupted"));
  if (ownedAbort !== null) {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
  }
  try {
    const options = parseReferenceConfirmationArgs(argv, dependencies);
    if (options.help) {
      output(referenceConfirmationUsage());
      return 0;
    }
    const result = await (dependencies.executeConfirmation ?? executeReferenceConfirmation)(
      options,
      {
        ...dependencies,
        ...(ownedAbort === null ? {} : { signal: ownedAbort.signal }),
      },
    );
    if (result.delegated === true) return 0;
    if (!result.executed) output((dependencies.renderDryRun ??
      renderReferenceConfirmationDryRun)(result.plan));
    else {
      output(`Reference confirmation status: ${result.status}`);
      output(`Results: ${result.plan.outputLeaf}`);
    }
    return result.executed && result.status !== "complete" ? 1 : 0;
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
  process.exitCode = await runReferenceConfirmationCli();
}
