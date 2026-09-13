import path from "node:path";

import {
  revalidateReferenceDiscoveryReadContext,
  revalidateReferenceDiscoveryExecution,
} from "./discovery-controller.mjs";
import {
  REFERENCE_DISCOVERY_HISTORY_VERSION,
  buildReferenceDiscoveryReport,
  canonicalReferenceDiscoveryPlanLine,
  parseReferenceDiscoveryPlan,
  readReferenceDiscoveryChild,
  referenceDiscoveryPreviewBinding,
} from "./discovery-protocol.mjs";
import {
  publishReferenceDiscoveryHistoryStart,
  publishReferenceDiscoveryHistoryTerminal,
  readReferenceDiscoveryHistory,
  withReferenceDiscoveryHistoryReader,
  withReferenceDiscoveryHistoryStore,
} from "./discovery-history-store.mjs";
import { runReferenceDiscoverySessionProcess } from "./discovery-session-client.mjs";
import {
  createReferenceDiscoveryCollection,
  ensureReferenceDiscoveryCoordinationDirectory,
  initializeReferenceDiscoveryChild,
  publishReferenceDiscoveryReport,
  readReferenceDiscoveryPlan,
  verifyReferenceDiscoveryReportPublication,
  withReferenceDiscoveryCoordinator,
} from "./discovery-store.mjs";

const SHA256_RE = /^[a-f0-9]{64}$/;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;

export class ReferenceDiscoveryCampaignError extends Error {
  constructor(message, code = "REFERENCE_DISCOVERY_CAMPAIGN_INVALID") {
    super(message);
    this.name = "ReferenceDiscoveryCampaignError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new ReferenceDiscoveryCampaignError(message, code);
}

function nowMilliseconds(source) {
  const value = source();
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("reference discovery clock returned an invalid timestamp");
  }
  return value;
}

function safeErrorCode(error) {
  return typeof error?.code === "string" && ERROR_CODE_RE.test(error.code)
    ? error.code : "REFERENCE_DISCOVERY_OWNER_ERROR";
}

function checkpoint(coordinator) {
  if (typeof coordinator?.assertHeld !== "function" || coordinator.assertHeld() !== true) {
    fail("reference discovery coordinator checkpoint is unavailable",
      "REFERENCE_DISCOVERY_COORDINATION_MISMATCH");
  }
}

async function historySnapshot(collectionDir, plan, dependencies, { readOnly = false } = {}) {
  const withHistory = readOnly
    ? dependencies.withHistoryReader ?? dependencies.withHistoryStore ??
      withReferenceDiscoveryHistoryReader
    : dependencies.withHistoryStore ?? withReferenceDiscoveryHistoryStore;
  const readHistory = dependencies.readHistory ?? readReferenceDiscoveryHistory;
  return withHistory({
    collectionDir,
    ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
  }, (store) => readHistory(store, plan));
}

async function publishStart(collectionDir, plan, record, dependencies) {
  const withHistory = dependencies.withHistoryStore ?? withReferenceDiscoveryHistoryStore;
  const publish = dependencies.publishHistoryStart ?? publishReferenceDiscoveryHistoryStart;
  return withHistory({
    collectionDir,
    ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
  }, (store) => publish(store, plan, record));
}

async function publishTerminal(collectionDir, plan, record, dependencies) {
  const withHistory = dependencies.withHistoryStore ?? withReferenceDiscoveryHistoryStore;
  const publish = dependencies.publishHistoryTerminal ?? publishReferenceDiscoveryHistoryTerminal;
  return withHistory({
    collectionDir,
    ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
  }, (store) => publish(store, plan, record));
}

function historyStart(plan, history, session, coordinator, unixMs) {
  return {
    version: REFERENCE_DISCOVERY_HISTORY_VERSION,
    type: "start",
    generation: history.nextGeneration,
    sessionOrdinal: session.ordinal,
    targetCpu: session.targetCpu,
    bootIdSha256: plan.host.bootIdSha256,
    unixMs,
    coordinatorPid: coordinator.pid,
    coordinatorStartTicks: coordinator.startTicks,
  };
}

function historyTerminal(plan, start, result, unixMs) {
  const record = result?.record;
  const synthetic = record === undefined;
  return {
    version: REFERENCE_DISCOVERY_HISTORY_VERSION,
    type: "terminal",
    generation: start.generation,
    sessionOrdinal: start.sessionOrdinal,
    targetCpu: start.targetCpu,
    bootIdSha256: plan.host.bootIdSha256,
    unixMs: Math.max(start.unixMs, unixMs),
    committed: synthetic ? false : record.committed,
    reason: synthetic ? "owner-error" : record.reason,
    stage: synthetic ? null : record.stage,
    errorCode: synthetic ? safeErrorCode(result?.error) : record.errorCode,
    controllerCpu: synthetic ? null : record.controllerCpu,
    controllerAllowedCpuList: synthetic ? null : record.controllerAllowedCpuList,
  };
}

function reconciledHistoryTerminal(plan, start, unixMs) {
  return {
    version: REFERENCE_DISCOVERY_HISTORY_VERSION,
    type: "terminal",
    generation: start.generation,
    sessionOrdinal: start.sessionOrdinal,
    targetCpu: start.targetCpu,
    bootIdSha256: plan.host.bootIdSha256,
    unixMs: Math.max(start.unixMs, unixMs),
    committed: false,
    reason: "reconciled-interruption",
    stage: null,
    errorCode: "REFERENCE_DISCOVERY_RECONCILED_INTERRUPTION",
    controllerCpu: null,
    controllerAllowedCpuList: null,
  };
}

async function readChild(plan, session, workloads, collectionDir, dependencies, {
  readOnly = false,
} = {}) {
  const reader = dependencies.readChild ?? readReferenceDiscoveryChild;
  return reader({
    plan,
    sessionOrdinal: session.ordinal,
    resolved: workloads.measured,
    auxiliary: workloads.auxiliary,
    bundleDir: path.join(collectionDir, session.directory),
    ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
    readOnly,
  });
}

async function deriveReportInsideCoordinator(plan, collectionDir, coordinator, dependencies, {
  publishWhenFinal = false,
  readOnly = false,
} = {}) {
  const revalidate = dependencies.revalidateReadContext ?? dependencies.revalidateContext ??
    revalidateReferenceDiscoveryReadContext;
  const context = await revalidate(plan, dependencies.revalidationDependencies ?? {});
  checkpoint(coordinator);
  const history = await historySnapshot(collectionDir, plan, dependencies, { readOnly });
  checkpoint(coordinator);
  const children = [];
  for (const session of plan.schedule.sessions) {
    children.push(await readChild(plan, session, context.workloads, collectionDir, dependencies, {
      readOnly,
    }));
    checkpoint(coordinator);
  }
  const buildReport = dependencies.buildReport ?? buildReferenceDiscoveryReport;
  const report = buildReport(plan, children, history.records);
  const terminalOrdinals = new Set(history.generations
    .filter((generation) => generation.terminal !== null)
    .map((generation) => generation.start.sessionOrdinal));
  let publication = null;
  if (publishWhenFinal && terminalOrdinals.size === plan.schedule.sessions.length) {
    const publish = dependencies.publishReport ?? publishReferenceDiscoveryReport;
    checkpoint(coordinator);
    publication = await publish({
      collectionDir,
      report,
      ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
    });
    checkpoint(coordinator);
  } else {
    const verifyPublication = dependencies.verifyReportPublication ??
      verifyReferenceDiscoveryReportPublication;
    publication = await verifyPublication({
      collectionDir,
      report,
      ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
      readOnly,
    });
    checkpoint(coordinator);
  }
  return Object.freeze({ report, history, publication });
}

async function initializeChildren(plan, collectionDir, workloads, coordinator, dependencies) {
  const initialize = dependencies.initializeChild ?? initializeReferenceDiscoveryChild;
  for (const session of plan.schedule.sessions) {
    await initialize({
      collectionDir,
      sessionOrdinal: session.ordinal,
      resolved: workloads.measured,
      auxiliary: workloads.auxiliary,
      ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
    });
    checkpoint(coordinator);
  }
}

async function executeStoredCampaign(planValue, collectionDir, options, dependencies) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  const withCoordinator = dependencies.withCoordinator ?? withReferenceDiscoveryCoordinator;
  const revalidate = dependencies.revalidateExecution ?? revalidateReferenceDiscoveryExecution;
  const runSession = dependencies.runSession ?? runReferenceDiscoverySessionProcess;
  const readPlan = dependencies.readPlan ?? readReferenceDiscoveryPlan;
  const now = dependencies.now ?? Date.now;
  const ensureCoordination = dependencies.ensureCoordination ??
    ensureReferenceDiscoveryCoordinationDirectory;
  await ensureCoordination(collectionDir, {
    ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
  });
  return withCoordinator({
    collectionDir,
    ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
  }, async (coordinator) => {
    checkpoint(coordinator);
    const stored = await readPlan(collectionDir, {
      ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
    });
    checkpoint(coordinator);
    if (!canonicalReferenceDiscoveryPlanLine(stored)
      .equals(canonicalReferenceDiscoveryPlanLine(plan))) {
      fail("stored reference discovery plan changed before execution",
        "REFERENCE_DISCOVERY_PLAN_MISMATCH");
    }
    let context = await revalidate(plan, dependencies.revalidationDependencies ?? {});
    checkpoint(coordinator);
    await initializeChildren(plan, collectionDir, context.workloads, coordinator, dependencies);

    let history = await historySnapshot(collectionDir, plan, dependencies);
    checkpoint(coordinator);
    const open = history.generations.at(-1);
    if (open?.terminal === null) {
      // Acquiring the coordinator proves that no owner still retains its
      // inherited campaign descriptor. Reading the child additionally proves
      // that no orphaned workload process retains the child-bundle lease.
      await readChild(plan, plan.schedule.sessions[open.start.sessionOrdinal - 1],
        context.workloads, collectionDir, dependencies);
      checkpoint(coordinator);
      checkpoint(coordinator);
      history = await publishTerminal(collectionDir, plan,
        reconciledHistoryTerminal(plan, open.start, nowMilliseconds(now)), dependencies);
      checkpoint(coordinator);
    }

    let stoppedAfterSession = null;
    let interrupted = false;
    for (const session of plan.schedule.sessions) {
      history = await historySnapshot(collectionDir, plan, dependencies);
      checkpoint(coordinator);
      const generations = history.generations.filter((generation) =>
        generation.start.sessionOrdinal === session.ordinal);
      if (generations.some((generation) => generation.terminal !== null)) continue;
      if (options.signal?.aborted) {
        interrupted = true;
        break;
      }
      context = await revalidate(plan, dependencies.revalidationDependencies ?? {});
      checkpoint(coordinator);
      const before = await readChild(plan, session, context.workloads, collectionDir, dependencies);
      checkpoint(coordinator);
      if (before.complete) {
        fail(`reference discovery CPU ${session.targetCpu} completed without execution history`,
          "REFERENCE_DISCOVERY_HISTORY_MISMATCH");
      }
      const start = historyStart(plan, history, session, coordinator.owner,
        nowMilliseconds(now));
      checkpoint(coordinator);
      await publishStart(collectionDir, plan, start, dependencies);
      checkpoint(coordinator);
      let ownerResult;
      try {
        checkpoint(coordinator);
        ownerResult = await runSession({
          plan,
          sessionOrdinal: session.ordinal,
          collectionDir,
          retainedCoordinator: coordinator.retainedCoordinator,
          retainedCollection: coordinator.retainedCollection,
          signal: options.signal,
          environment: options.environment ?? process.env,
        });
      } catch (error) {
        checkpoint(coordinator);
        if (error?.reaped !== true) throw error;
        ownerResult = { error };
      }
      checkpoint(coordinator);
      if (ownerResult.error === undefined && ownerResult.reaped !== true) {
        fail("reference discovery owner result did not establish process reaping",
          "REFERENCE_DISCOVERY_OWNER_REAP_UNCERTAIN");
      }
      checkpoint(coordinator);
      history = await publishTerminal(collectionDir, plan,
        historyTerminal(plan, start, ownerResult, nowMilliseconds(now)), dependencies);
      checkpoint(coordinator);
      const terminal = history.generations.at(-1).terminal;
      const after = await readChild(plan, session, context.workloads, collectionDir, dependencies);
      checkpoint(coordinator);
      if (terminal.committed && !after.complete) {
        fail(`reference discovery CPU ${session.targetCpu} owner committed without a complete child`,
          "REFERENCE_DISCOVERY_CHILD_INCOMPLETE");
      }
      if (!terminal.committed) {
        stoppedAfterSession = session.ordinal;
        interrupted = options.signal?.aborted === true;
        break;
      }
    }

    checkpoint(coordinator);
    const derived = await deriveReportInsideCoordinator(
      plan,
      collectionDir,
      coordinator,
      dependencies,
      { publishWhenFinal: true },
    );
    checkpoint(coordinator);
    return Object.freeze({
      plan,
      collectionDir,
      report: derived.report,
      publication: derived.publication,
      stoppedAfterSession,
      interrupted,
    });
  });
}

export async function startReferenceDiscoveryCampaign(planValue, {
  yes = false,
  expectedPreviewSha256,
  signal,
  environment,
} = {}, dependencies = {}) {
  const plan = parseReferenceDiscoveryPlan(planValue);
  if (yes !== true || typeof expectedPreviewSha256 !== "string" ||
      !SHA256_RE.test(expectedPreviewSha256)) {
    fail("live reference discovery requires --yes and the exact preview binding",
      "REFERENCE_DISCOVERY_CONFIRMATION_REQUIRED");
  }
  if (referenceDiscoveryPreviewBinding(plan).sha256 !== expectedPreviewSha256) {
    fail("reference discovery preview binding changed",
      "REFERENCE_DISCOVERY_PREVIEW_MISMATCH");
  }
  const create = dependencies.createCollection ?? createReferenceDiscoveryCollection;
  const collectionDir = await create(plan, {
    requireFresh: true,
    ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
  });
  return executeStoredCampaign(plan, collectionDir, { signal, environment }, dependencies);
}

export async function resumeReferenceDiscoveryCampaign(collectionDir, {
  yes = false,
  signal,
  environment,
} = {}, dependencies = {}) {
  if (yes !== true || typeof collectionDir !== "string" || !path.isAbsolute(collectionDir)) {
    fail("reference discovery resume requires an absolute collection and --yes",
      "REFERENCE_DISCOVERY_CONFIRMATION_REQUIRED");
  }
  const readPlan = dependencies.readPlan ?? readReferenceDiscoveryPlan;
  const plan = await readPlan(collectionDir, {
    ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
  });
  return executeStoredCampaign(plan, collectionDir, { signal, environment }, dependencies);
}

export async function deriveReferenceDiscoveryReport(collectionDir, dependencies = {}) {
  return withReferenceDiscoveryReportSnapshot(collectionDir,
    (snapshot) => snapshot, dependencies);
}

export async function withReferenceDiscoveryReportSnapshot(
  collectionDir,
  operation,
  dependencies = {},
) {
  if (typeof collectionDir !== "string" || !path.isAbsolute(collectionDir)) {
    fail("reference discovery report requires an absolute collection path");
  }
  if (typeof operation !== "function") {
    fail("reference discovery snapshot operation is required");
  }
  const readPlan = dependencies.readPlan ?? readReferenceDiscoveryPlan;
  const plan = await readPlan(collectionDir, {
    ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
    readOnly: true,
  });
  const withCoordinator = dependencies.withCoordinator ?? withReferenceDiscoveryCoordinator;
  return withCoordinator({
    collectionDir,
    ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
    readOnly: true,
  }, async (coordinator) => {
    checkpoint(coordinator);
    const derived = await deriveReportInsideCoordinator(
      plan,
      collectionDir,
      coordinator,
      dependencies,
      { readOnly: true },
    );
    checkpoint(coordinator);
    const snapshot = Object.freeze({ plan, collectionDir, report: derived.report });
    return operation(snapshot, coordinator);
  });
}

export async function withReferenceDiscoveryPreservationSnapshot(
  collectionDir,
  operation,
  dependencies = {},
) {
  if (typeof collectionDir !== "string" || !path.isAbsolute(collectionDir)) {
    fail("reference discovery preservation requires an absolute collection path");
  }
  if (typeof operation !== "function") {
    fail("reference discovery preservation operation is required");
  }
  const readPlan = dependencies.readPlan ?? readReferenceDiscoveryPlan;
  const plan = await readPlan(collectionDir, {
    ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
    readOnly: true,
  });
  const withCoordinator = dependencies.withCoordinator ?? withReferenceDiscoveryCoordinator;
  return withCoordinator({
    collectionDir,
    ...(dependencies.flockPath === undefined ? {} : { flockPath: dependencies.flockPath }),
    readOnly: true,
  }, async (coordinator) => {
    checkpoint(coordinator);
    const revalidate = dependencies.revalidateReadContext ?? dependencies.revalidateContext ??
      revalidateReferenceDiscoveryReadContext;
    const context = await revalidate(plan, dependencies.revalidationDependencies ?? {});
    checkpoint(coordinator);
    let report = null;
    let derivationError = null;
    try {
      const derived = await deriveReportInsideCoordinator(
        plan,
        collectionDir,
        coordinator,
        {
          ...dependencies,
          revalidateReadContext: async () => context,
        },
        { readOnly: true },
      );
      report = derived.report;
    } catch (error) {
      checkpoint(coordinator);
      derivationError = Object.freeze({
        code: safeErrorCode(error),
        message: String(error?.message ?? "report derivation failed")
          .replace(/[\0\r\n]/g, " ").slice(0, 512),
      });
    }
    checkpoint(coordinator);
    const snapshot = Object.freeze({
      plan,
      collectionDir,
      report,
      derivationError,
    });
    return operation(snapshot, coordinator);
  });
}
