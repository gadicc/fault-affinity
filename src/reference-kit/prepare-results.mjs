#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";

import { REFERENCE_FORMAT_VERSION, REFERENCE_PROFILE } from "./controller.mjs";
import { canonicalProtocolJson } from "../../diagnose-lib/pinned-protocol.mjs";
import { parseAttemptEvidence } from "../../diagnose-lib/attempt-evidence.mjs";
import { resolvePersistedWorkloadDescriptor } from "../../diagnose-lib/workload-spec.mjs";
import { parseControlledLoadSessionEnvelope } from "../../diagnose-lib/controlled-load-session.mjs";
import {
  BundleExecutionLeaseError,
  withBundleExecutionLease,
} from "../../diagnose-lib/bundle-execution-lease.mjs";

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

function validateEventBase(value, index) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      value.formatVersion !== REFERENCE_FORMAT_VERSION ||
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

function validateManifest(record, startPlan) {
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
  const measuredResolved = validateWorkload(record.workloads?.measured,
    "reference-pglite-target", "measured");
  const auxiliaryResolved = validateWorkload(record.workloads?.auxiliary,
    "reference-load-worker", "auxiliary");
  if (manifest?.version !== 1 || manifest.phase !== "controlled-load-aba" ||
      !/^[a-f0-9]{32}$/.test(manifest.generation ?? "") ||
      !same(manifest.measuredWorkload, binding(record.workloads?.measured)) ||
      !same(manifest.auxiliaryWorkload, binding(record.workloads?.auxiliary)) ||
      schedule?.version !== 1 || schedule.algorithm !== "fixed-single-workload-aba-v1" ||
      schedule.attemptsPerLeg !== startPlan.selection.attemptsPerLeg ||
      schedule.attemptCount !== schedule.attemptsPerLeg * 3 ||
      schedule.warmupMs !== REFERENCE_PROFILE.loadWarmupMs ||
      schedule.recoveryMs !== REFERENCE_PROFILE.recoveryMs ||
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
  if (!same(measured.outcomes, { mappedExits: [], targetSignals: ["SIGSEGV"] }) ||
      measured.attempt?.mode !== "exit" ||
      measured.attempt.timeoutMs !== REFERENCE_PROFILE.attemptTimeoutMs ||
      auxiliary.attempt?.mode !== "survive-window" ||
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

function validateProgressJournal(source, state, referenceRecords) {
  const lines = readFileSync(path.join(source, "progress.jsonl"), "utf8").split("\n");
  if (lines.at(-1) !== "") fail("progress.jsonl ends with an incomplete line");
  const records = lines.slice(0, -1).map((line, index) => {
    let value;
    try { value = JSON.parse(line); } catch { fail(`progress.jsonl line ${index + 1} is invalid JSON`); }
    if (value?.formatVersion !== REFERENCE_FORMAT_VERSION ||
        !["progress-start", "session-manifest", "attempt-complete", "attempt-error", "progress-end"].includes(value.type)) {
      fail(`progress.jsonl line ${index + 1} has an unsupported record`);
    }
    return value;
  });
  const start = records[0];
  const end = records.at(-1);
  if (records.length < 2 || start.type !== "progress-start" || end.type !== "progress-end" ||
      start.profileId !== "load-aba-reference" || start.profileVersion !== 1 ||
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
    validateManifest(manifestRecords[0], referenceRecords[0].plan);
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
  if (state?.formatVersion !== REFERENCE_FORMAT_VERSION ||
      !["complete", "interrupted", "operational-incomplete"].includes(state.status) ||
      Object.keys(state).sort().join(",") !== "formatVersion,status") {
    fail("result-state.json is not an exact supported reference result state");
  }
  const release = parseRelease(source);
  const lines = readFileSync(path.join(source, "reference.jsonl"), "utf8").split("\n");
  if (lines.at(-1) !== "") fail("reference.jsonl ends with an incomplete line");
  const records = lines.slice(0, -1).map((line, index) => {
    if (line.length === 0) fail(`reference.jsonl line ${index + 1} is empty`);
    let value;
    try { value = JSON.parse(line); } catch { fail(`reference.jsonl line ${index + 1} is invalid JSON`); }
    validateEventBase(value, index);
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
  if (records[0].plan?.formatVersion !== REFERENCE_FORMAT_VERSION ||
      JSON.stringify(plannedRelease) !== JSON.stringify(release)) {
    fail("reference.jsonl plan does not match release.json");
  }
  if (records[0].plan?.profile?.id !== release.profile.id ||
      records[0].plan?.profile?.version !== release.profile.version ||
      !same(records[0].plan.profile, { ...REFERENCE_PROFILE, loadCpus: [...REFERENCE_PROFILE.loadCpus] })) {
    fail("reference.jsonl plan does not match the release profile");
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
  validateProgressJournal(source, state, records);
  return Object.freeze({ source, status: state.status, inventory: Object.freeze(inventory) });
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function archiveWithTar(source, output, spawnProcess = spawn) {
  const stream = createWriteStream(output, { flags: "wx", mode: 0o600 });
  const child = spawnProcess("/bin/tar", [
    "--create", "--gzip", "--format=ustar", "--numeric-owner", "--owner=0", "--group=0",
    "--mtime=UTC 1970-01-01", "--sort=name", "--directory", source, ...RESULT_FILES,
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

export async function prepareResults(rawOptions, dependencies = {}) {
  if (rawOptions === null || typeof rawOptions !== "object" || Array.isArray(rawOptions)) fail("options must be an object");
  const expected = ["resultsRoot", "bundle", "destination"];
  if (Object.keys(rawOptions).sort().join(",") !== expected.sort().join(",")) fail(`options must contain exactly: ${expected.sort().join(", ")}`);
  const source = canonicalBelow(rawOptions.resultsRoot, rawOptions.bundle, "bundle").child;
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
  const destination = realpathSync(rawOptions.destination);
  if (!statSync(destination).isDirectory()) fail("destination must be an existing directory");
  if (destination === inspected.source || destination.startsWith(`${inspected.source}${path.sep}`)) {
    fail("destination must be outside the source bundle");
  }
  const base = `fault-affinity-results-${stamp((dependencies.now ?? (() => new Date()))())}.tar.gz`;
  const finalArchive = path.join(destination, base);
  const checksumFile = `${finalArchive}.sha256`;
  const temporary = path.join(destination, `.${base}.${process.pid}.writing`);
  requireMissing(finalArchive, "result archive");
  requireMissing(checksumFile, "result checksum");
  requireMissing(temporary, "temporary result archive");
  let finalCreated = false;
  let checksumCreated = false;
  let publicationMode = null;
  try {
    await (dependencies.archive ?? archiveWithTar)(inspected.source, temporary, dependencies.spawnProcess);
    const after = inspectBundle(rawOptions.resultsRoot, rawOptions.bundle);
    if (JSON.stringify(after.inventory) !== JSON.stringify(inspected.inventory) || after.status !== inspected.status) {
      fail("source bundle changed while it was being archived", "RESULT_BUNDLE_CHANGED");
    }
    const digest = await fileSha256(temporary);
    publicationMode = publishArchive(temporary, finalArchive, dependencies);
    finalCreated = true;
    rmSync(temporary);
    const checksumFd = openSync(checksumFile, "wx", 0o600);
    checksumCreated = true;
    try { writeFileSync(checksumFd, `${digest}  ${base}\n`); } finally { closeSync(checksumFd); }
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
  }
}

export function prepareResultsUsage() {
  return "Usage: prepare-results --results-root ROOT --bundle ROOT/BUNDLE --destination DEST\n\n" +
    "Accepts only a terminal reference-kit v1 bundle with the exact file allowlist.\n" +
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
