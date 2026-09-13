#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";

import { REFERENCE_FORMAT_VERSION, REFERENCE_PROFILE } from "./controller.mjs";
import { canonicalProtocolJson } from "../../diagnose-lib/pinned-protocol.mjs";
import { parseAttemptEvidence } from "../../diagnose-lib/attempt-evidence.mjs";
import { resolvePersistedWorkloadDescriptor } from "../../diagnose-lib/workload-spec.mjs";
import { parseControlledLoadSessionEnvelope } from "../../diagnose-lib/controlled-load-session.mjs";
import {
  assertBundleExecutionLeaseHeld,
  BundleExecutionLeaseError,
  withBundleExecutionLease,
} from "../../diagnose-lib/bundle-execution-lease.mjs";
import {
  withReferenceDiscoveryPreservationSnapshot,
  withReferenceDiscoveryReportSnapshot,
} from "./discovery-campaign.mjs";
import { REFERENCE_CONFIRMATION_PROFILE } from "./discovery-controller.mjs";
import { referenceDiscoveryConfirmationSourceBinding } from "./discovery-protocol.mjs";
import {
  REFERENCE_DISCOVERY_COORDINATION_DIRECTORY,
  REFERENCE_DISCOVERY_COORDINATION_FILE,
  REFERENCE_DISCOVERY_PLAN_FILE,
  REFERENCE_DISCOVERY_REPORT_COMPLETION_FILE,
  REFERENCE_DISCOVERY_REPORT_JSON_FILE,
  REFERENCE_DISCOVERY_REPORT_MARKDOWN_FILE,
} from "./discovery-store.mjs";

export const RESULT_ARCHIVE_FORMAT_VERSION = 1;
export const RESULT_FILES = Object.freeze([
  "progress.jsonl", "reference.jsonl", "release.json", "result-state.json", "summary.md",
]);
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const FILE_LIMITS = Object.freeze({
  "reference.jsonl": 64 * 1024 * 1024,
  "progress.jsonl": 64 * 1024 * 1024,
  "release.json": 128 * 1024,
  "result-state.json": 4 * 1024,
  "summary.md": 1024 * 1024,
});
const DISCOVERY_MAX_FILES = 4_096;
const DISCOVERY_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const DISCOVERY_HISTORY_FILE_RE =
  /^history\/reference-discovery-history-[0-9]{5}-(?:start|terminal)\.json$/;

export class PrepareResultsError extends Error {
  constructor(message, code = "RESULT_PREPARATION_INVALID") {
    super(message);
    this.name = "PrepareResultsError";
    this.code = code;
  }
}

function fail(message, code) { throw new PrepareResultsError(message, code); }

function canonicalBelow(rootValue, childValue, label) {
  const root = realpathSync(rootValue);
  const requested = path.resolve(childValue);
  if (lstatSync(requested).isSymbolicLink()) fail(`${label} argument must not be a symbolic link`);
  const child = realpathSync(requested);
  if (child === root || !child.startsWith(`${root}${path.sep}`)) fail(`${label} must be below results root`);
  return { root, child };
}

function parseRelease(source) {
  let value;
  try { value = JSON.parse(readFileSync(path.join(source, "release.json"), "utf8")); }
  catch { fail("release.json is invalid JSON"); }
  const release = value?.release;
  const profile = value?.profile;
  const runtimes = value?.runtimes;
  const components = value?.components;
  if (value?.schemaVersion !== 1 || release === null || typeof release !== "object" ||
      profile === null || typeof profile !== "object" || runtimes === null || typeof runtimes !== "object") {
    fail("release.json has an unsupported minimum schema");
  }
  if (typeof release.version !== "string" || !VERSION_RE.test(release.version) ||
      release.tag !== `v${release.version}` || !COMMIT_RE.test(release.sourceCommit ?? "") ||
      release.platform !== "linux-x64") {
    fail("release.json release identity is invalid");
  }
  if (profile.version !== 1 || profile.pgliteVersion !== "0.5.4" ||
      profile.id !== "load-aba-reference") {
    fail("release.json reference profile is invalid");
  }
  for (const [role, expectedVersion] of [["controller", "v24.21.0"], ["reference", "v25.2.1"]]) {
    const identity = runtimes[role];
    if (identity?.version !== expectedVersion || !SHA256_RE.test(identity?.sha256 ?? "")) {
      fail(`release.json ${role} runtime identity is invalid`);
    }
  }
  if (components === null || typeof components !== "object" ||
      !SHA256_RE.test(components.pgliteTreeSha256 ?? "") ||
      !SHA256_RE.test(components.appTreeSha256 ?? "")) {
    fail("release.json component identities are invalid");
  }
  return value;
}

function validateEventBase(value, index, formatVersion = REFERENCE_FORMAT_VERSION) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      value.formatVersion !== formatVersion ||
      !Number.isSafeInteger(value.unixMs) || value.unixMs < 0 ||
      typeof value.monotonicNs !== "string" || !/^(0|[1-9][0-9]{0,31})$/.test(value.monotonicNs)) {
    fail(`reference.jsonl line ${index + 1} has an unsupported event envelope`);
  }
}

function canonicalBinding(value) {
  const bytes = Buffer.from(`${canonicalProtocolJson(value)}\n`, "utf8");
  return { algorithm: "canonical-json-line-sha256-v1", bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

function same(left, right) { return canonicalProtocolJson(left) === canonicalProtocolJson(right); }

function requireBinding(value, subject, label) {
  const expected = canonicalBinding(subject);
  const supported = value?.algorithm === undefined
    ? value?.bytes === expected.bytes && value?.sha256 === expected.sha256
    : same(value, expected);
  if (!supported) fail(`${label} binding is invalid`);
}

function validateAttemptEvidence(evidence, resolved, label) {
  try { parseAttemptEvidence(resolved, evidence); }
  catch (error) { fail(`${label} is invalid: ${error.message}`); }
}

function sameExecutableIdentity(actual, expected, { version = false } = {}) {
  return actual?.path === expected?.path && actual?.sha256 === expected?.sha256 &&
    String(actual?.bytes) === String(expected?.bytes) &&
    (!version || actual?.version === expected?.version);
}

function validateConfirmationLaunchBinding(startPlan, record, manifest) {
  const sourcePlan = startPlan.confirmation?.discoveryPlan;
  const sourceIdentity = sourcePlan?.identity;
  const resultIdentity = startPlan.identity;
  const release = resultIdentity?.release;
  const measured = record.workloads?.measured;
  const auxiliary = record.workloads?.auxiliary;
  const selectedSession = sourcePlan?.schedule?.sessions?.find((session) =>
    session.targetCpu === startPlan.selection?.targetCpu);
  const expectedChild = path.join(sourceIdentity?.kitRoot ?? "", "app/child.mjs");
  const expectedApp = path.join(sourceIdentity?.kitRoot ?? "", "app");
  if (selectedSession?.controllerCpu !== startPlan.selection?.controllerCpu ||
      !sameExecutableIdentity(resultIdentity?.executables?.controller,
        sourceIdentity?.controllerRuntime, { version: true }) ||
      !sameExecutableIdentity(resultIdentity?.executables?.target,
        sourceIdentity?.targetRuntime, { version: true }) ||
      !sameExecutableIdentity(resultIdentity?.executables?.taskset, sourceIdentity?.taskset) ||
      !sameExecutableIdentity(resultIdentity?.executables?.yes, sourceIdentity?.yes) ||
      release?.runtimes?.controller?.version !== sourceIdentity?.controllerRuntime?.version ||
      release?.runtimes?.controller?.sha256 !== sourceIdentity?.controllerRuntime?.sha256 ||
      release?.runtimes?.reference?.version !== sourceIdentity?.targetRuntime?.version ||
      release?.runtimes?.reference?.sha256 !== sourceIdentity?.targetRuntime?.sha256 ||
      release?.components?.appTreeSha256 !== sourceIdentity?.appTreeSha256 ||
      release?.components?.pgliteTreeSha256 !== sourceIdentity?.pgliteTreeSha256 ||
      resultIdentity?.app?.sha256 !== sourceIdentity?.appTreeSha256 ||
      resultIdentity?.pglite?.sha256 !== sourceIdentity?.pgliteTreeSha256 ||
      measured?.digest !== sourceIdentity?.measuredWorkloadDigest ||
      auxiliary?.digest !== sourceIdentity?.conditionWorkloadDigest ||
      manifest?.execution?.tasksetPath !== sourceIdentity?.taskset?.path ||
      resultIdentity?.child?.path !== expectedChild ||
      measured?.descriptor?.command?.cwd !== expectedApp ||
      !same(measured?.descriptor?.command?.args, [expectedChild]) ||
      measured?.descriptor?.provenance?.files?.[0]?.path !== expectedChild ||
      auxiliary?.descriptor?.command?.cwd !== sourceIdentity?.kitRoot ||
      !same(auxiliary?.descriptor?.command?.args, [])) {
    fail("confirmation runtime or launch recipe does not match its discovery source",
      "RESULT_CONFIRMATION_SOURCE_MISMATCH");
  }
}

function validateManifest(record, startPlan, profile = REFERENCE_PROFILE) {
  requireBinding(record.manifestBinding, record.manifest, "session manifest");
  const manifest = record.manifest;
  const schedule = manifest?.schedule;
  const execution = manifest?.execution;
  const binding = (workload) => ({ contractVersion: workload?.contractVersion,
    id: workload?.id, digest: workload?.digest });
  const validateWorkload = (workload, expectedId, label) => {
    const descriptor = workload?.descriptor;
    let resolved;
    try { resolved = resolvePersistedWorkloadDescriptor(descriptor, workload?.digest); }
    catch (error) { fail(`${label} persisted workload is invalid: ${error.message}`); }
    if (workload?.contractVersion !== 1 || workload.id !== expectedId ||
        descriptor?.version !== 1 || descriptor.id !== expectedId ||
        createHash("sha256").update(canonicalProtocolJson(descriptor)).digest("hex") !== workload.digest ||
        resolved.digest !== workload.digest) {
      fail(`${label} workload descriptor or digest is invalid`);
    }
    return resolved;
  };
  const confirmation = profile.id === REFERENCE_CONFIRMATION_PROFILE.id;
  const measuredResolved = validateWorkload(record.workloads?.measured,
    confirmation ? "reference-pglite-target-discovery" : "reference-pglite-target", "measured");
  const auxiliaryResolved = validateWorkload(record.workloads?.auxiliary,
    confirmation ? "reference-guided-yes-load" : "reference-load-worker", "auxiliary");
  if (manifest?.version !== 1 || manifest.phase !== "controlled-load-aba" ||
      !/^[a-f0-9]{32}$/.test(manifest.generation ?? "") ||
      !same(manifest.measuredWorkload, binding(record.workloads?.measured)) ||
      !same(manifest.auxiliaryWorkload, binding(record.workloads?.auxiliary)) ||
      schedule?.version !== 1 || schedule.algorithm !== "fixed-single-workload-aba-v1" ||
      schedule.attemptsPerLeg !== startPlan.selection.attemptsPerLeg ||
      schedule.attemptCount !== schedule.attemptsPerLeg * 3 ||
      schedule.warmupMs !== profile.loadWarmupMs ||
      schedule.recoveryMs !== profile.recoveryMs ||
      !same(schedule.legs, [{ leg: "a1", condition: "without-load" },
        { leg: "b", condition: "with-load" }, { leg: "a2", condition: "after-recovery" }]) ||
      execution?.targetCpu !== startPlan.selection.targetCpu ||
      !same(execution.workerCpus, startPlan.selection.loadCpus) ||
      execution.targetAffinityMode !== "inherited-singleton-v1" ||
      execution.workerOutputMode !== "discard") {
    fail("session manifest does not match the fixed reference plan");
  }
  const measured = record.workloads.measured.descriptor;
  const auxiliary = record.workloads.auxiliary.descriptor;
  if (confirmation) validateConfirmationLaunchBinding(startPlan, record, manifest);
  if (!same(measured.outcomes, { mappedExits: [], targetSignals: ["SIGSEGV"] }) ||
      measured.attempt?.mode !== "exit" ||
      measured.attempt.timeoutMs !== profile.attemptTimeoutMs ||
      measured.attempt.termGraceMs !== profile.termGraceMs ||
      measured.attempt.killGraceMs !== profile.killGraceMs ||
      auxiliary.attempt?.mode !== "survive-window" ||
      auxiliary.attempt.termGraceMs !== profile.termGraceMs ||
      auxiliary.attempt.killGraceMs !== profile.killGraceMs ||
      auxiliary.attempt.timeoutMs !== (confirmation ? 60 * 60 * 1_000 :
        7 * 24 * 60 * 60 * 1_000) ||
      startPlan.identity?.release?.runtimes?.reference?.sha256 !== measured.command?.executable?.sha256 ||
      startPlan.identity?.executables?.yes?.sha256 !== auxiliary.command?.executable?.sha256 ||
      startPlan.identity?.child?.sha256 !== measured.provenance?.files?.[0]?.sha256) {
    fail("session workloads do not match the frozen release/profile identities");
  }
  const { digest, ...identity } = schedule;
  const expectedDigest = createHash("sha256")
    .update(Buffer.from(`${canonicalProtocolJson(identity)}\n`, "utf8")).digest("hex");
  if (digest !== expectedDigest) fail("session schedule digest is invalid");
  return { manifest, measuredResolved, auxiliaryResolved };
}

function validateSessionEvidence(session, manifest, measuredResolved, auxiliaryResolved, completed) {
  if (session === null || typeof session !== "object" || !Array.isArray(session?.attempts?.a1) ||
      !Array.isArray(session?.attempts?.b) || !Array.isArray(session?.attempts?.a2)) {
    fail("reference session has an invalid attempt envelope");
  }
  const sessionSlots = ["a1", "b", "a2"].flatMap((leg, legIndex) =>
    session.attempts[leg].map((attempt, index) => ({ attempt, leg, position: index + 1,
      ordinal: legIndex * manifest.schedule.attemptsPerLeg + index + 1 })));
  const flat = sessionSlots.map(({ attempt }) => attempt);
  if (flat.length !== completed.length || sessionSlots.some((slot, index) =>
    completed[index].ordinal !== slot.ordinal || completed[index].leg !== slot.leg ||
    completed[index].position !== slot.position ||
    !same(slot.attempt?.evidence, completed[index].evidence))) {
    fail("reference session attempts do not match the durable journal");
  }
  for (const [index, attempt] of flat.entries()) {
    validateAttemptEvidence(attempt.evidence, measuredResolved,
      `reference attempt ${index + 1}`);
    const affinity = attempt.affinity;
    if (attempt.evidence.outcome.validOutcome === true &&
        (affinity?.mode !== "inherited-singleton-v1" ||
         affinity.requestedCpu !== manifest.execution.targetCpu ||
         affinity.supervisorAllowedCpuList !== String(manifest.execution.targetCpu) ||
         affinity.workloadAllowedCpuList !== String(manifest.execution.targetCpu))) {
      fail(`reference attempt ${index + 1} lacks its target singleton-affinity witness`);
    }
  }
  if (session.committed !== true) {
    if (session.envelope !== null) fail("partial reference session must not contain a committed envelope");
    return;
  }
  const envelope = session.envelope;
  try {
    parseControlledLoadSessionEnvelope(measuredResolved, auxiliaryResolved, manifest, envelope);
  } catch (error) {
    fail(`committed session envelope is invalid: ${error.message}`);
  }
  if (flat.length !== manifest.schedule.attemptCount || envelope?.version !== 1 ||
      envelope.phase !== manifest.phase || envelope.generation !== manifest.generation ||
      envelope.scheduleDigest !== manifest.schedule.digest ||
      !same(envelope.measuredWorkload, manifest.measuredWorkload) ||
      !same(envelope.auxiliaryWorkload, manifest.auxiliaryWorkload) ||
      !Array.isArray(envelope.legs) || envelope.legs.length !== 3 ||
      envelope.condition === null || typeof envelope.condition !== "object" ||
      Object.keys(envelope.condition).sort().join(",") !==
        "afterB,beforeB,workerSetStart,workerSetStop") {
    fail("committed session envelope is invalid");
  }
  let ordinal = 0;
  for (const [legIndex, legName] of ["a1", "b", "a2"].entries()) {
    const leg = envelope.legs[legIndex];
    if (leg?.leg !== legName || !Array.isArray(leg.attempts) ||
        leg.attempts.length !== manifest.schedule.attemptsPerLeg) fail("committed leg counts are invalid");
    for (const [position, bound] of leg.attempts.entries()) {
      ordinal += 1;
      if (!same(bound?.slot, { ordinal, leg: legName, position: position + 1 }) ||
          !same(bound?.evidence, flat[ordinal - 1].evidence) ||
          !same(bound?.affinity, flat[ordinal - 1].affinity)) fail("committed attempt slot is invalid");
      requireBinding(bound.binding, bound.evidence, `committed attempt ${ordinal}`);
    }
  }
}

function validateProgressJournal(source, state, referenceRecords, profile = REFERENCE_PROFILE) {
  const lines = readFileSync(path.join(source, "progress.jsonl"), "utf8").split("\n");
  if (lines.at(-1) !== "") fail("progress.jsonl ends with an incomplete line");
  const records = lines.slice(0, -1).map((line, index) => {
    let value;
    try { value = JSON.parse(line); } catch { fail(`progress.jsonl line ${index + 1} is invalid JSON`); }
    if (value?.formatVersion !== state.formatVersion ||
        !["progress-start", "session-manifest", "attempt-complete", "attempt-error", "progress-end"].includes(value.type)) {
      fail(`progress.jsonl line ${index + 1} has an unsupported record`);
    }
    return value;
  });
  const start = records[0];
  const end = records.at(-1);
  if (records.length < 2 || start.type !== "progress-start" || end.type !== "progress-end" ||
      start.profileId !== profile.id || start.profileVersion !== profile.version ||
      !Number.isSafeInteger(start.attemptsPerLeg) ||
      start.attemptsPerLeg < 1 || start.plannedAttempts !== start.attemptsPerLeg * 3 ||
      end.status !== state.status) {
    fail("progress.jsonl has an invalid start/end envelope");
  }
  requireBinding(start.planBinding, referenceRecords[0].plan, "reference plan");
  if (!same(start.plan, referenceRecords[0].plan)) {
    fail("durable progress plan does not match reference.jsonl");
  }
  const manifestRecords = records.filter((record) => record.type === "session-manifest");
  if (manifestRecords.length !== 1 || records[1] !== manifestRecords[0]) {
    fail("progress.jsonl must bind exactly one session manifest before attempts");
  }
  const { manifest, measuredResolved, auxiliaryResolved } =
    validateManifest(manifestRecords[0], referenceRecords[0].plan, profile);
  if (start.attemptsPerLeg !== referenceRecords[0].plan.selection.attemptsPerLeg ||
      start.attemptsPerLeg !== manifest.schedule.attemptsPerLeg ||
      start.plannedAttempts !== manifest.schedule.attemptCount) {
    fail("progress.jsonl schedule counts do not match the plan and manifest");
  }
  const attempts = records.slice(2, -1);
  if (attempts.length > start.plannedAttempts) fail("progress.jsonl exceeds its planned attempt count");
  if (attempts.some((record, index) => {
    const ordinal = index + 1;
    const legIndex = Math.floor(index / start.attemptsPerLeg);
    return !["attempt-complete", "attempt-error"].includes(record.type) ||
      record.ordinal !== ordinal || record.leg !== ["a1", "b", "a2"][legIndex] ||
      record.position !== (index % start.attemptsPerLeg) + 1 ||
      (record.type === "attempt-error" &&
        (typeof record.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(record.code)));
  }) || attempts.filter((record) => record.type === "attempt-error").length > 1 ||
      attempts.some((record, index) => record.type === "attempt-error" && index !== attempts.length - 1)) {
    fail("progress.jsonl attempt slots are invalid");
  }
  const completed = attempts.filter((record) => record.type === "attempt-complete");
  for (const [index, record] of completed.entries()) {
    requireBinding(record.evidenceBinding, record.evidence, `journal attempt ${index + 1}`);
    validateAttemptEvidence(record.evidence, measuredResolved, `journal attempt ${index + 1}`);
  }
  if (end.completedAttempts !== completed.length) fail("progress.jsonl completed count is invalid");
  if (referenceRecords[1].type === "reference-session") {
    const expected = ["a1", "b", "a2"].flatMap((leg) =>
      (referenceRecords[1].session?.attempts?.[leg] ?? []).map((attempt) => attempt.evidence));
    if (expected.length !== completed.length || completed.some((record, index) =>
      JSON.stringify(record.evidence) !== JSON.stringify(expected[index]))) {
      fail("progress.jsonl does not match the final session evidence");
    }
    validateSessionEvidence(referenceRecords[1].session, manifest, measuredResolved,
      auxiliaryResolved, completed);
  }
}

function inspectBundle(resultsRoot, bundle) {
  const { child: source } = canonicalBelow(resultsRoot, bundle, "bundle");
  if (!statSync(source).isDirectory()) fail("bundle must be a directory");
  try { lstatSync(path.join(source, ".reference-active")); fail("bundle is still active", "RESULT_BUNDLE_ACTIVE"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }

  const names = readdirSync(source).sort();
  if (names.length !== RESULT_FILES.length ||
      names.some((name, index) => name !== [...RESULT_FILES].sort()[index])) {
    fail("bundle files do not match the exact reference result allowlist");
  }

  const inventory = RESULT_FILES.map((name) => {
    const file = path.join(source, name);
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.isSymbolicLink()) fail(`bundle member '${name}' must be a regular file`);
    if (stats.size > FILE_LIMITS[name]) fail(`bundle member '${name}' exceeds its size limit`);
    const bytes = readFileSync(file);
    return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });

  const state = JSON.parse(readFileSync(path.join(source, "result-state.json"), "utf8"));
  const confirmation = state?.formatVersion === 2;
  const profile = confirmation ? REFERENCE_CONFIRMATION_PROFILE : REFERENCE_PROFILE;
  if (![REFERENCE_FORMAT_VERSION, 2].includes(state?.formatVersion) ||
      !["complete", "interrupted", "operational-incomplete"].includes(state.status) ||
      Object.keys(state).sort().join(",") !== "formatVersion,status") {
    fail("result-state.json is not an exact supported reference result state");
  }
  const release = parseRelease(source);
  if (confirmation && (release.capabilities?.referenceConfirmation !== 1 ||
      release.profiles?.referenceConfirmation?.id !== REFERENCE_CONFIRMATION_PROFILE.id ||
      release.profiles?.referenceConfirmation?.version !== REFERENCE_CONFIRMATION_PROFILE.version ||
      release.profiles?.referenceConfirmation?.pgliteVersion !==
        REFERENCE_CONFIRMATION_PROFILE.pgliteVersion)) {
    fail("release.json confirmation profile or capability is invalid");
  }
  const lines = readFileSync(path.join(source, "reference.jsonl"), "utf8").split("\n");
  if (lines.at(-1) !== "") fail("reference.jsonl ends with an incomplete line");
  const records = lines.slice(0, -1).map((line, index) => {
    if (line.length === 0) fail(`reference.jsonl line ${index + 1} is empty`);
    let value;
    try { value = JSON.parse(line); } catch { fail(`reference.jsonl line ${index + 1} is invalid JSON`); }
    validateEventBase(value, index, state.formatVersion);
    return value;
  });
  if (records.length !== 3 || records[0].type !== "reference-start" ||
      !["reference-session", "reference-operational-error"].includes(records[1].type) ||
      records[2].type !== "reference-end" || records[2].status !== state.status) {
    fail("reference.jsonl does not have an allowed start/result/end sequence");
  }
  if (records.some((record, index) => index > 0 &&
      BigInt(record.monotonicNs) < BigInt(records[index - 1].monotonicNs))) {
    fail("reference.jsonl event times are not monotonic");
  }
  const plannedRelease = records[0].plan?.identity?.release;
  if (records[0].plan?.formatVersion !== state.formatVersion ||
      JSON.stringify(plannedRelease) !== JSON.stringify(release)) {
    fail("reference.jsonl plan does not match release.json");
  }
  const declaredProfile = confirmation ? release.profiles.referenceConfirmation : release.profile;
  if (records[0].plan?.profile?.id !== declaredProfile.id ||
      records[0].plan?.profile?.version !== declaredProfile.version ||
      !same(records[0].plan.profile, profile === REFERENCE_PROFILE
        ? { ...REFERENCE_PROFILE, loadCpus: [...REFERENCE_PROFILE.loadCpus] }
        : REFERENCE_CONFIRMATION_PROFILE)) {
    fail("reference.jsonl plan does not match the release profile");
  }
  const confirmationContext = records[0].plan.confirmation;
  if (confirmation && (confirmationContext === null ||
      typeof confirmationContext !== "object" || Array.isArray(confirmationContext) ||
      confirmationContext.version !== 1 ||
      confirmationContext.protocol !== "reference-discovery-confirmation-v1" ||
      typeof confirmationContext.collectionDir !== "string" ||
      !path.isAbsolute(confirmationContext.collectionDir) ||
      confirmationContext.discoveryPlan?.storage?.collectionDir !==
        confirmationContext.collectionDir ||
      confirmationContext.discoveryReport?.complete !== true ||
      confirmationContext.discoveryReport?.selectionEligible !== true ||
      confirmationContext.discoveryReport?.highestObservedFaultRateCandidate !==
        records[0].plan.selection?.targetCpu ||
      !same(confirmationContext.discoveryPlan?.selection?.loadCpus,
        records[0].plan.selection?.loadCpus) ||
      records[0].plan.selection?.attemptsPerLeg !==
        REFERENCE_CONFIRMATION_PROFILE.attemptsPerLeg)) {
    fail("confirmation result has an invalid discovery source context");
  }
  if (!confirmation && confirmationContext !== undefined) {
    fail("fixed reference result cannot contain a confirmation source");
  }
  if (state.status === "complete") {
    if (records[1].type !== "reference-session" || records[1].status !== "complete" ||
        records[1].session?.committed !== true) {
      fail("complete result state lacks a committed reference session");
    }
  } else if (records[1].type === "reference-session") {
    if (records[1].status !== state.status || records[1].session?.committed !== false) {
      fail(`${state.status} result has an inconsistent session record`);
    }
  } else if (typeof records[1].code !== "string" || records[1].code.length === 0 ||
      (state.status === "interrupted" && records[1].code !== "REFERENCE_EXTERNAL_CANCEL")) {
    fail(`${state.status} result has an invalid operational record`);
  }
  validateProgressJournal(source, state, records, profile);
  return Object.freeze({
    source,
    status: state.status,
    kind: confirmation ? "reference-confirmation-v1" : "reference-fixed-v1",
    inventory: Object.freeze(inventory),
    ...(confirmation ? { plan: records[0].plan } : {}),
  });
}

function discoveryInventoryContract(plan, { preservation }) {
  const allowedDirectories = new Set([REFERENCE_DISCOVERY_COORDINATION_DIRECTORY, "history"]);
  const requiredDirectories = new Set([REFERENCE_DISCOVERY_COORDINATION_DIRECTORY]);
  const allowedFiles = new Set([
    REFERENCE_DISCOVERY_PLAN_FILE,
    REFERENCE_DISCOVERY_COORDINATION_FILE,
    REFERENCE_DISCOVERY_REPORT_JSON_FILE,
    REFERENCE_DISCOVERY_REPORT_MARKDOWN_FILE,
    REFERENCE_DISCOVERY_REPORT_COMPLETION_FILE,
  ]);
  const requiredFiles = new Set([
    REFERENCE_DISCOVERY_PLAN_FILE,
    REFERENCE_DISCOVERY_COORDINATION_FILE,
  ]);
  for (const session of plan.schedule.sessions) {
    const root = session.directory;
    const state = `${root}/state`;
    const controlled = `${state}/controlled-load`;
    const exact = `${state}/exact-cpu`;
    for (const directory of [root, state, controlled, exact]) {
      allowedDirectories.add(directory);
      if (!preservation) requiredDirectories.add(directory);
    }
    for (const name of [
      `${root}/fault-affinity-bundle.json`,
      `${controlled}/controlled-load-phase.json`,
      `${exact}/exact-cpu-phase.json`,
    ]) {
      allowedFiles.add(name);
      if (!preservation) requiredFiles.add(name);
    }
    allowedFiles.add(`${root}/attempt-armed.json`);
    allowedFiles.add(`${controlled}/controlled-load-session.json`);
  }
  return { allowedDirectories, requiredDirectories, allowedFiles, requiredFiles };
}

function interruptedCommitIdentity(relative, allowedFiles) {
  const basename = path.posix.basename(relative);
  const match = basename.match(/^\.(.+)\.([1-9][0-9]*)\.([a-f0-9]{16})\.(writing|ready)\.tmp$/);
  if (match === null) return null;
  const parent = path.posix.dirname(relative);
  const final = parent === "." ? match[1] : `${parent}/${match[1]}`;
  return allowedFiles.has(final) || DISCOVERY_HISTORY_FILE_RE.test(final)
    ? { final, stage: match[4] }
    : null;
}

function sameFileIdentity(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.nlink === right.nlink && left.uid === right.uid &&
    left.mode === right.mode && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;
}

function readBoundedStableFile(file, before, relative) {
  let descriptor;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(before, opened)) {
      fail(`discovery member '${relative}' changed while it was opened`,
        "RESULT_BUNDLE_CHANGED");
    }
    const expectedBytes = Number(opened.size);
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 ||
        expectedBytes > 256 * 1024 * 1024) {
      fail(`discovery member '${relative}' exceeds its file-size limit`);
    }
    const bytes = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const count = readSync(descriptor, bytes, offset, expectedBytes - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    const extraBytes = readSync(descriptor, extra, 0, 1, offset);
    const afterDescriptor = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(file, { bigint: true });
    if (offset !== expectedBytes || extraBytes !== 0 ||
        !sameFileIdentity(opened, afterDescriptor) ||
        !sameFileIdentity(afterDescriptor, afterPath)) {
      fail(`discovery member '${relative}' changed while it was read`,
        "RESULT_BUNDLE_CHANGED");
    }
    return bytes;
  } catch (error) {
    if (error instanceof PrepareResultsError) throw error;
    fail(`discovery member '${relative}' could not be read safely`,
      "RESULT_BUNDLE_CHANGED");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function retainedReadyLinkForFinal(source, relative, stats, allowedFiles) {
  const parent = path.posix.dirname(relative);
  const directory = parent === "." ? source : path.join(source, ...parent.split("/"));
  const matches = [];
  for (const name of readdirSync(directory)) {
    const candidate = parent === "." ? name : `${parent}/${name}`;
    const interrupted = interruptedCommitIdentity(candidate, allowedFiles);
    if (interrupted?.final !== relative || interrupted.stage !== "ready") continue;
    const candidateStats = lstatSync(path.join(directory, name), { bigint: true });
    if (candidateStats.nlink === 2n && sameFileIdentity(stats, candidateStats)) {
      matches.push(candidate);
    }
  }
  return matches.length === 1;
}

function inspectDiscoveryCollection(source, plan, report) {
  const preservation = report === null;
  if (plan.storage.collectionDir !== source) {
    fail("discovery plan was moved from its bound collection path");
  }
  const rootStat = lstatSync(source, { bigint: true });
  const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  if (!rootStat.isDirectory() || (uid !== null && rootStat.uid !== uid) ||
      (rootStat.mode & 0o077n) !== 0n) {
    fail("discovery collection must be a private directory owned by the current user");
  }
  const contract = discoveryInventoryContract(plan, { preservation });
  const observedDirectories = new Set();
  const observedFiles = new Set();
  const inventory = [];
  let totalBytes = 0;

  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      if (name.length === 0 || Buffer.byteLength(name) > 255 || name === "." || name === ".." ||
          [...name].some((character) => character.codePointAt(0) < 32 ||
            character.codePointAt(0) === 127)) {
        fail("discovery collection contains an unsafe path component");
      }
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const file = path.join(directory, name);
      const stats = lstatSync(file, { bigint: true });
      if ((uid !== null && stats.uid !== uid) || (stats.mode & 0o077n) !== 0n) {
        fail(`discovery member '${relative}' is not private and owned`);
      }
      if (stats.isDirectory()) {
        if (!contract.allowedDirectories.has(relative)) {
          fail(`discovery collection contains unknown directory '${relative}'`);
        }
        observedDirectories.add(relative);
        walk(file, relative);
        continue;
      }
      const interrupted = interruptedCommitIdentity(relative, contract.allowedFiles);
      const recognizedFinal = contract.allowedFiles.has(relative) ||
        DISCOVERY_HISTORY_FILE_RE.test(relative);
      if (!stats.isFile() || stats.size > 256n * 1024n * 1024n ||
          (stats.nlink !== 1n && stats.nlink !== 2n)) {
        fail(`discovery member '${relative}' is not a safe bounded state file`);
      }
      if (stats.nlink === 2n) {
        if (!preservation) {
          fail(`discovery member '${relative}' is not a safe bounded state file`);
        }
        if (interrupted !== null) {
          let final;
          try { final = lstatSync(path.join(source, ...interrupted.final.split("/")), {
            bigint: true,
          }); } catch {
            fail(`interrupted discovery member '${relative}' has an unsafe retained link`);
          }
          if (interrupted.stage !== "ready" || !sameFileIdentity(stats, final) ||
              final.nlink !== 2n) {
            fail(`interrupted discovery member '${relative}' has an unsafe retained link`);
          }
        } else if (!recognizedFinal ||
            !retainedReadyLinkForFinal(source, relative, stats, contract.allowedFiles)) {
          fail(`discovery member '${relative}' has an unsafe extra link`);
        }
      }
      if (!contract.allowedFiles.has(relative) && !DISCOVERY_HISTORY_FILE_RE.test(relative) &&
          !(preservation && interrupted !== null)) {
        fail(`discovery collection contains unknown file '${relative}'`);
      }
      if (observedFiles.size >= DISCOVERY_MAX_FILES) {
        fail("discovery collection exceeds its file-count limit");
      }
      totalBytes += Number(stats.size);
      if (totalBytes > DISCOVERY_MAX_TOTAL_BYTES) {
        fail("discovery collection exceeds its total byte limit");
      }
      const bytes = readBoundedStableFile(file, stats, relative);
      observedFiles.add(relative);
      inventory.push({
        name: relative,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  walk(source);

  for (const directory of contract.requiredDirectories) {
    if (!observedDirectories.has(directory)) {
      fail(`discovery collection is missing directory '${directory}'`);
    }
  }
  for (const file of contract.requiredFiles) {
    if (!observedFiles.has(file)) fail(`discovery collection is missing file '${file}'`);
  }
  const reportFiles = [
    REFERENCE_DISCOVERY_REPORT_JSON_FILE,
    REFERENCE_DISCOVERY_REPORT_MARKDOWN_FILE,
    REFERENCE_DISCOVERY_REPORT_COMPLETION_FILE,
  ].filter((name) => observedFiles.has(name));
  if (!preservation && reportFiles.length !== 0 && reportFiles.length !== 3) {
    fail("discovery report publication is incomplete");
  }
  const historyFiles = [...observedFiles].filter((name) =>
    DISCOVERY_HISTORY_FILE_RE.test(name));
  if (historyFiles.length > 128) fail("discovery history exceeds its record limit");
  const archiveEntries = [...new Set([
    ...observedDirectories,
    ...observedFiles,
  ].map((name) => name.split("/")[0]))].sort();
  return Object.freeze({
    source,
    kind: "reference-discovery-v1",
    status: report?.complete === true ? report.status : "incomplete-non-selection-evidence",
    inventory: Object.freeze(inventory),
    directories: Object.freeze([...observedDirectories].sort()),
    archiveEntries: Object.freeze(archiveEntries),
  });
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function archiveWithTar(source, output, spawnProcess = spawn, entries = RESULT_FILES) {
  const stream = createWriteStream(output, { flags: "wx", mode: 0o600 });
  const child = spawnProcess("/bin/tar", [
    "--create", "--gzip", "--format=ustar", "--numeric-owner", "--owner=0", "--group=0",
    "--mtime=UTC 1970-01-01", "--sort=name", "--directory", source, ...entries,
  ], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length); });
  child.stdout.pipe(stream);
  const [status] = await Promise.all([
    new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); }),
    once(stream, "close"),
  ]);
  if (status.code !== 0 || status.signal !== null) fail(`tar failed: code=${status.code} signal=${status.signal} ${stderr.trim()}`);
}

function readStableSnapshotFile(source, item) {
  const file = path.join(source, ...item.name.split("/"));
  try {
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile() || (before.nlink !== 1n && before.nlink !== 2n) ||
        before.size !== BigInt(item.bytes)) {
      fail(`discovery member '${item.name}' changed before snapshot copy`,
        "RESULT_BUNDLE_CHANGED");
    }
    const bytes = readBoundedStableFile(file, before, item.name);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== item.bytes || digest !== item.sha256) {
      fail(`discovery member '${item.name}' changed while it was copied`,
        "RESULT_BUNDLE_CHANGED");
    }
    return bytes;
  } catch (error) {
    if (error instanceof PrepareResultsError) throw error;
    fail(`discovery member '${item.name}' could not be copied safely`,
      "RESULT_BUNDLE_CHANGED");
  }
}

function materializeDiscoverySnapshot(inspected) {
  const scratch = mkdtempSync(path.join(tmpdir(), "fault-affinity-discovery-export-"));
  try {
    for (const directory of inspected.directories
      .slice().sort((left, right) => left.split("/").length - right.split("/").length ||
        left.localeCompare(right))) {
      mkdirSync(path.join(scratch, ...directory.split("/")), { mode: 0o700 });
    }
    for (const item of inspected.inventory) {
      const destination = path.join(scratch, ...item.name.split("/"));
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, readStableSnapshotFile(inspected.source, item), {
        flag: "wx",
        mode: 0o600,
      });
    }
    return scratch;
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(file);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function requireMissing(file, label) {
  try { lstatSync(file); fail(`${label} already exists`, "RESULT_OUTPUT_EXISTS"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function publishArchive(temporary, finalArchive, dependencies) {
  try {
    (dependencies.linkFile ?? linkSync)(temporary, finalArchive);
    return "atomic-hard-link-v1";
  } catch (error) {
    if (!["EXDEV", "EOPNOTSUPP", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
  }
  (dependencies.copyFile ?? copyFileSync)(temporary, finalArchive, fsConstants.COPYFILE_EXCL);
  return "exclusive-copy-checksum-commit-v1";
}

async function withDiscoveryChildLeases(
  source,
  plan,
  dependencies,
  operation,
  index = 0,
  checkpoints = [],
) {
  if (index >= plan.schedule.sessions.length) {
    const assertChildrenHeld = () => {
      for (const checkpoint of checkpoints) checkpoint();
      return true;
    };
    assertChildrenHeld();
    const result = await operation(assertChildrenHeld);
    assertChildrenHeld();
    return result;
  }
  const child = path.join(source, plan.schedule.sessions[index].directory);
  try {
    const stats = lstatSync(child, { bigint: true });
    if (!stats.isDirectory()) fail("discovery child path is not a directory");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return withDiscoveryChildLeases(
        source, plan, dependencies, operation, index + 1, checkpoints);
    }
    throw error;
  }
  const runWithLease = dependencies.withBundleExecutionLease ?? withBundleExecutionLease;
  return runWithLease({
    bundleDir: child,
    flockPath: dependencies.flockPath ?? "/usr/bin/flock",
    waitMs: 0,
  }, async (lease) => {
    const checkpoint = () => assertBundleExecutionLeaseHeld(lease);
    checkpoint();
    const result = await withDiscoveryChildLeases(
      source,
      plan,
      dependencies,
      operation,
      index + 1,
      [...checkpoints, checkpoint],
    );
    checkpoint();
    return result;
  });
}

export async function prepareResults(rawOptions, dependencies = {}) {
  if (rawOptions === null || typeof rawOptions !== "object" || Array.isArray(rawOptions)) fail("options must be an object");
  const expected = ["resultsRoot", "bundle", "destination"];
  if (Object.keys(rawOptions).sort().join(",") !== expected.sort().join(",")) fail(`options must contain exactly: ${expected.sort().join(", ")}`);
  const source = canonicalBelow(rawOptions.resultsRoot, rawOptions.bundle, "bundle").child;
  const sourceNames = readdirSync(source);
  if (sourceNames.includes(REFERENCE_DISCOVERY_PLAN_FILE)) {
    return prepareDiscoveryResults(rawOptions, source, dependencies);
  }
  const runWithLease = dependencies.withBundleExecutionLease ?? withBundleExecutionLease;
  try {
    return await runWithLease({
      bundleDir: source,
      flockPath: dependencies.flockPath ?? "/usr/bin/flock",
      waitMs: 0,
    }, async () => prepareResultsWithLease(rawOptions, dependencies));
  } catch (error) {
    if (error instanceof BundleExecutionLeaseError && error.code === "BUNDLE_EXECUTION_LEASE_BUSY") {
      fail("result bundle is busy; wait for its controller or another preparer to finish",
        "RESULT_BUNDLE_BUSY");
    }
    throw error;
  }
}

async function prepareResultsWithLease(rawOptions, dependencies) {
  const inspected = inspectBundle(rawOptions.resultsRoot, rawOptions.bundle);
  if (inspected.kind === "reference-confirmation-v1") {
    return prepareConfirmationResultsWithLease(inspected, rawOptions, dependencies);
  }
  return publishPreparedResults(inspected, rawOptions, dependencies,
    () => inspectBundle(rawOptions.resultsRoot, rawOptions.bundle));
}

function validateConfirmationSource(inspected, snapshot, dependencies) {
  const confirmation = inspected.plan.confirmation;
  if (snapshot.collectionDir !== confirmation.collectionDir ||
      !same(snapshot.plan, confirmation.discoveryPlan) ||
      !same(snapshot.report, confirmation.discoveryReport)) {
    fail("confirmation discovery source no longer matches its authoritative collection",
      "RESULT_CONFIRMATION_SOURCE_MISMATCH");
  }
  const sourceRelease = snapshot.plan.identity.releaseFile;
  let before;
  try { before = lstatSync(sourceRelease.path, { bigint: true }); }
  catch {
    fail("confirmation source release declaration is unavailable",
      "RESULT_CONFIRMATION_SOURCE_MISMATCH");
  }
  if (!before.isFile() || before.nlink !== 1n || before.size > 128n * 1024n ||
      before.size.toString() !== sourceRelease.bytes ||
      Number(before.mode & 0o777n) !== sourceRelease.mode) {
    fail("confirmation source release declaration identity changed",
      "RESULT_CONFIRMATION_SOURCE_MISMATCH");
  }
  const releaseBytes = readBoundedStableFile(sourceRelease.path, before, "source RELEASE.json");
  if (createHash("sha256").update(releaseBytes).digest("hex") !== sourceRelease.sha256) {
    fail("confirmation source release declaration digest changed",
      "RESULT_CONFIRMATION_SOURCE_MISMATCH");
  }
  let releaseDeclaration;
  try { releaseDeclaration = JSON.parse(releaseBytes.toString("utf8")); }
  catch {
    fail("confirmation source release declaration is invalid JSON",
      "RESULT_CONFIRMATION_SOURCE_MISMATCH");
  }
  if (!same(releaseDeclaration, inspected.plan.identity.release)) {
    fail("confirmation release declaration does not match its discovery source",
      "RESULT_CONFIRMATION_SOURCE_MISMATCH");
  }
  let binding;
  try {
    binding = (dependencies.referenceDiscoveryConfirmationSourceBinding ??
      referenceDiscoveryConfirmationSourceBinding)(snapshot.plan, snapshot.report);
  } catch (error) {
    fail(`confirmation discovery source is ineligible: ${error.message}`,
      "RESULT_CONFIRMATION_SOURCE_MISMATCH");
  }
  if (!same(binding, confirmation.source) ||
      binding.targetCpu !== inspected.plan.selection.targetCpu ||
      !same(binding.loadCpus, inspected.plan.selection.loadCpus)) {
    fail("confirmation result binding does not match its authoritative discovery source",
      "RESULT_CONFIRMATION_SOURCE_MISMATCH");
  }
}

async function prepareConfirmationResultsWithLease(inspected, rawOptions, dependencies) {
  const withSnapshot = dependencies.withReferenceDiscoveryReportSnapshot ??
    withReferenceDiscoveryReportSnapshot;
  try {
    return await withSnapshot(inspected.plan.confirmation.collectionDir,
      async (snapshot, coordinator) => {
        coordinator.assertHeld();
        validateConfirmationSource(inspected, snapshot, dependencies);
        coordinator.assertHeld();
        return publishPreparedResults(
          inspected,
          rawOptions,
          dependencies,
          () => {
            const after = inspectBundle(rawOptions.resultsRoot, rawOptions.bundle);
            validateConfirmationSource(after, snapshot, dependencies);
            return after;
          },
          () => coordinator.assertHeld(),
        );
      }, dependencies.discoveryDependencies ?? {});
  } catch (error) {
    if (error?.code === "BUNDLE_EXECUTION_LEASE_BUSY") {
      fail("confirmation source is busy; wait for its controller or another preparer to finish",
        "RESULT_BUNDLE_BUSY");
    }
    throw error;
  }
}

async function prepareDiscoveryResults(rawOptions, source, dependencies) {
  const withSnapshot = dependencies.withReferenceDiscoveryPreservationSnapshot ??
    withReferenceDiscoveryPreservationSnapshot;
  try {
    return await withSnapshot(source, async ({ plan, report, derivationError }, coordinator) => {
      const resultsRoot = realpathSync(rawOptions.resultsRoot);
      if (plan.storage.resultsRoot !== resultsRoot) {
        fail("discovery collection does not belong to the supplied results root");
      }
      return withDiscoveryChildLeases(source, plan, dependencies, async (assertChildrenHeld) => {
        const assertSnapshot = () => {
          coordinator.assertHeld();
          assertChildrenHeld();
          return true;
        };
        assertSnapshot();
        const inspected = inspectDiscoveryCollection(source, plan, report);
        const result = await publishPreparedResults(
          inspected,
          rawOptions,
          dependencies,
          () => inspectDiscoveryCollection(source, plan, report),
          assertSnapshot,
        );
        assertSnapshot();
        return Object.freeze({ ...result, derivationError });
      });
    }, dependencies.discoveryDependencies ?? {});
  } catch (error) {
    if (error?.code === "BUNDLE_EXECUTION_LEASE_BUSY") {
      fail("discovery collection is busy; wait for its controller or another preparer to finish",
        "RESULT_BUNDLE_BUSY");
    }
    throw error;
  }
}

async function publishPreparedResults(
  inspected,
  rawOptions,
  dependencies,
  reinspect,
  assertSnapshot = () => true,
) {
  assertSnapshot();
  const destination = realpathSync(rawOptions.destination);
  if (!statSync(destination).isDirectory()) fail("destination must be an existing directory");
  if (destination === inspected.source || destination.startsWith(`${inspected.source}${path.sep}`)) {
    fail("destination must be outside the source bundle");
  }
  const prefix = inspected.kind === "reference-discovery-v1"
    ? `fault-affinity-discovery-${inspected.status}`
    : inspected.kind === "reference-confirmation-v1"
      ? `fault-affinity-confirmation-${inspected.status}`
      : "fault-affinity-results";
  const base = `${prefix}-${stamp((dependencies.now ?? (() => new Date()))())}.tar.gz`;
  const finalArchive = path.join(destination, base);
  const checksumFile = `${finalArchive}.sha256`;
  const temporary = path.join(destination, `.${base}.${process.pid}.writing`);
  requireMissing(finalArchive, "result archive");
  requireMissing(checksumFile, "result checksum");
  requireMissing(temporary, "temporary result archive");
  let finalCreated = false;
  let checksumCreated = false;
  let publicationMode = null;
  let snapshotDirectory = null;
  try {
    if (inspected.kind === "reference-discovery-v1") {
      snapshotDirectory = materializeDiscoverySnapshot(inspected);
      assertSnapshot();
    }
    await (dependencies.archive ?? archiveWithTar)(
      snapshotDirectory ?? inspected.source,
      temporary,
      dependencies.spawnProcess,
      inspected.archiveEntries ?? RESULT_FILES,
    );
    assertSnapshot();
    const after = reinspect();
    assertSnapshot();
    if (JSON.stringify(after.inventory) !== JSON.stringify(inspected.inventory) || after.status !== inspected.status) {
      fail("source bundle changed while it was being archived", "RESULT_BUNDLE_CHANGED");
    }
    const digest = await fileSha256(temporary);
    assertSnapshot();
    publicationMode = publishArchive(temporary, finalArchive, dependencies);
    finalCreated = true;
    assertSnapshot();
    rmSync(temporary);
    const checksumFd = openSync(checksumFile, "wx", 0o600);
    checksumCreated = true;
    try { writeFileSync(checksumFd, `${digest}  ${base}\n`); } finally { closeSync(checksumFd); }
    assertSnapshot();
    return Object.freeze({
      formatVersion: RESULT_ARCHIVE_FORMAT_VERSION,
      status: inspected.status,
      source: inspected.source,
      archive: finalArchive,
      checksumFile,
      sha256: digest,
      bytes: statSync(finalArchive).size,
      publicationMode,
      inventory: inspected.inventory,
      privacyWarning: "Review paths, arguments, process output, and error text before sharing; this inventory is not a privacy guarantee.",
    });
  } catch (error) {
    if (checksumCreated) rmSync(checksumFile, { force: true });
    if (finalCreated) rmSync(finalArchive, { force: true });
    try { rmSync(temporary); } catch (cleanup) { if (cleanup?.code !== "ENOENT") throw cleanup; }
    throw error;
  } finally {
    if (snapshotDirectory !== null) {
      rmSync(snapshotDirectory, { recursive: true, force: true });
    }
  }
}

export function prepareResultsUsage() {
  return "Usage: prepare-results --results-root ROOT --bundle ROOT/BUNDLE --destination DEST\n\n" +
    "Accepts a fixed reference result, adaptive confirmation, or guided-discovery collection.\n" +
    "Incomplete discovery exports are labelled incomplete-non-selection-evidence.\n" +
    "The bundle must be below ROOT and DEST must be an existing directory outside it.\n" +
    "Creates a new tar.gz and adjacent .sha256 without modifying the source bundle; DEST may be FAT/exFAT.\n" +
    "An exclusive bundle lease prevents preparation while a controller or another preparer owns it.";
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return null;
  const value = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--results-root", "--bundle", "--destination"].includes(key) || value[key] !== undefined) {
      fail(`unknown or duplicate argument '${key}'`);
    }
    const argument = argv[++index];
    if (argument === undefined) fail(`${key} requires a value`);
    value[key] = path.resolve(argument);
  }
  if (Object.keys(value).length !== 3) fail("--results-root, --bundle, and --destination are required");
  return { resultsRoot: value["--results-root"], bundle: value["--bundle"], destination: value["--destination"] };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options === null) {
      console.log(prepareResultsUsage());
      return 0;
    }
    const result = await prepareResults(options);
    console.log(`Created ${result.archive}`);
    console.log(`Status ${result.status}`);
    if (result.derivationError !== undefined && result.derivationError !== null) {
      console.log(`Preservation note ${result.derivationError.code}: ` +
        result.derivationError.message);
    }
    console.log(`SHA-256 ${result.sha256}`);
    for (const item of result.inventory) console.log(`${item.sha256}  ${item.bytes}  ${item.name}`);
    console.log(result.privacyWarning);
    return 0;
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main();
