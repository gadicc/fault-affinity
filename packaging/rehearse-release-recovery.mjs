#!/usr/bin/env node

import { createReadStream } from "node:fs";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  COMMIT_RE,
  requireCondition,
  sha256File,
  writeCanonicalJson,
} from "./lib/common.mjs";
import { classifyRecoveryState, RECOVERY_ASSET_NAMES } from "./lib/recovery.mjs";

const packagingDirectory = path.dirname(fileURLToPath(import.meta.url));
const rehearsalScript = fileURLToPath(import.meta.url);
const recoverScript = path.join(packagingDirectory, "recover-release.mjs");
const finalizeScript = path.join(packagingDirectory, "finalize-release.mjs");
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/fault-affinity-release-rehearsal-[a-z0-9-]+$/;
const RUN_ID_RE = /^[0-9]{14}[0-9a-f]{8}$/;
const SOURCE_DATE_RE = /^(0|[1-9][0-9]{0,15})$/;

function usage() {
  return `Usage: node packaging/rehearse-release-recovery.mjs \\
  --repository OWNER/fault-affinity-release-rehearsal-NAME \\
  --confirm-disposable-repository OWNER/fault-affinity-release-rehearsal-NAME \\
  --commit 40_HEX --implementation-commit 40_HEX --stage /path/to/version-neutral-stage.tar.gz \\
  --source-date-epoch SECONDS --output-directory /new/evidence/path \\
  [--archive-repository]\n\n` +
  "Requires GH_TOKEN. The repository must be private, unarchived, and contain no tags or releases.\n" +
  "The script creates rehearsal-only prerelease tags/releases and never touches the source repository.\n";
}

export function makeRehearsalRunId(now = new Date(), entropy = randomBytes(4).toString("hex")) {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  requireCondition(/^[0-9]{14}$/.test(stamp) && /^[0-9a-f]{8}$/.test(entropy),
    "could not construct a canonical rehearsal run id", "INVALID_REHEARSAL_ID");
  return `${stamp}${entropy}`;
}

export function rehearsalVersion(runId, scenario) {
  requireCondition(RUN_ID_RE.test(runId) &&
    new Set(["complete", "partial", "conflict", "incomplete"]).has(scenario),
  "invalid rehearsal version inputs", "INVALID_REHEARSAL_ID");
  return `0.0.0-rehearsal.${runId}.${scenario}`;
}

export function parseRecoveryRehearsalArguments(args) {
  const result = {
    repository: null,
    confirmation: null,
    commit: null,
    implementationCommit: null,
    stage: null,
    sourceDateEpoch: null,
    outputDirectory: null,
    archiveRepository: false,
    runId: makeRehearsalRunId(),
    help: false,
  };
  const values = new Map([
    ["--repository", "repository"],
    ["--confirm-disposable-repository", "confirmation"],
    ["--commit", "commit"],
    ["--implementation-commit", "implementationCommit"],
    ["--stage", "stage"],
    ["--source-date-epoch", "sourceDateEpoch"],
    ["--output-directory", "outputDirectory"],
    ["--run-id", "runId"],
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "--archive-repository") {
      requireCondition(!seen.has(argument), `repeated argument ${argument}`, "INVALID_ARGUMENT");
      seen.add(argument);
      if (argument === "--help") result.help = true;
      else result.archiveRepository = true;
      continue;
    }
    const property = values.get(argument);
    requireCondition(property && !seen.has(argument) && args[index + 1] !== undefined,
      `invalid or repeated argument ${argument ?? ""}`, "INVALID_ARGUMENT");
    seen.add(argument);
    result[property] = args[index + 1];
    index += 1;
  }
  if (result.help) return Object.freeze(result);
  requireCondition(REPOSITORY_RE.test(result.repository ?? "") &&
    result.confirmation === result.repository,
  "the private disposable repository name must match the required rehearsal pattern twice",
  "INVALID_REHEARSAL_REPOSITORY");
  requireCondition(COMMIT_RE.test(result.commit ?? "") &&
    COMMIT_RE.test(result.implementationCommit ?? "") &&
    SOURCE_DATE_RE.test(result.sourceDateEpoch ?? "") &&
    Number.isSafeInteger(Number(result.sourceDateEpoch)) &&
    result.stage && result.outputDirectory && RUN_ID_RE.test(result.runId),
  "commits, stage, source date, output directory, and run id are invalid", "INVALID_ARGUMENT");
  result.stage = path.resolve(result.stage);
  result.outputDirectory = path.resolve(result.outputDirectory);
  requireCondition(result.stage !== result.outputDirectory &&
    !result.stage.includes("\0") && !result.outputDirectory.includes("\0"),
  "stage and output paths are invalid", "INVALID_ARGUMENT");
  return Object.freeze(result);
}

function encodedRepository(repository) {
  return repository.split("/").map(encodeURIComponent).join("/");
}

async function github(repository, apiPath, options = {}) {
  requireCondition(process.env.GH_TOKEN, "GH_TOKEN is required", "MISSING_TOKEN");
  const response = await fetch(`https://api.github.com/repos/${encodedRepository(repository)}${apiPath}`, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      ...(options.json ? { "content-type": "application/json" } : {}),
    },
    body: options.json ? JSON.stringify(options.json) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (options.allowNotFound && response.status === 404) return null;
  requireCondition(response.ok,
    `GitHub API ${apiPath} returned ${response.status}`, "REHEARSAL_GITHUB_API_ERROR");
  if (response.status === 204) return {};
  return response.json();
}

async function uploadAsset(release, name, file) {
  const uploadUrl = new URL(release.upload_url.replace("{?name,label}", ""));
  requireCondition(uploadUrl.origin === "https://uploads.github.com",
    "GitHub returned an unexpected upload origin", "REHEARSAL_GITHUB_API_ERROR");
  uploadUrl.searchParams.set("name", name);
  const size = Number(lstatSync(file).size);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "x-github-api-version": "2022-11-28",
    },
    body: createReadStream(file),
    duplex: "half",
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  requireCondition(response.status === 201,
    `GitHub rejected rehearsal asset ${name}: ${response.status}`,
    "REHEARSAL_GITHUB_API_ERROR");
  return response.json();
}

function localAssets(directory) {
  const names = readdirSync(directory).sort();
  requireCondition(JSON.stringify(names) === JSON.stringify([...RECOVERY_ASSET_NAMES].sort()),
    "rehearsal finalization did not create the exact release asset set",
    "REHEARSAL_ASSET_SET_MISMATCH");
  return new Map(names.map((name) => {
    const file = path.join(directory, name);
    const status = lstatSync(file);
    requireCondition(status.isFile() && !status.isSymbolicLink(),
      `unsafe rehearsal asset ${name}`, "REHEARSAL_ASSET_SET_MISMATCH");
    return [name, { file, size: Number(status.size), sha256: sha256File(file) }];
  }));
}

function finalizeCase(options, scratch, scenario) {
  const version = rehearsalVersion(options.runId, scenario);
  const tag = `v${version}`;
  const directory = path.join(scratch, scenario);
  const assetsDirectory = path.join(directory, "assets");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const finalized = spawnSync(process.execPath, [finalizeScript,
    "--stage", options.stage,
    "--output-directory", assetsDirectory,
    "--version", version,
    "--commit", options.commit,
    "--source-date-epoch", options.sourceDateEpoch,
  ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  requireCondition(finalized.status === 0,
    `release finalization failed: ${finalized.stderr.trim()}`, "REHEARSAL_FINALIZATION_FAILED");
  const planFile = path.join(directory, "release-plan.json");
  writeCanonicalJson(planFile, {
    schemaVersion: 1,
    status: "release",
    commit: options.commit,
    nextRelease: {
      type: "patch",
      version,
      gitTag: tag,
      gitHead: options.commit,
      notes: `Disposable recovery rehearsal ${options.runId}: ${scenario}.`,
    },
  });
  return Object.freeze({ scenario, version, tag, directory, assetsDirectory, planFile,
    assets: localAssets(assetsDirectory) });
}

function recoveryArguments(options, item, mode, githubOutput) {
  const result = [recoverScript,
    "--repository", options.repository,
    "--tag", item.tag,
    "--commit", options.commit,
    "--assets-directory", item.assetsDirectory,
    "--plan", item.planFile,
    "--mode", mode,
  ];
  if (githubOutput) result.push("--github-output", githubOutput);
  return result;
}

function runRecovery(options, item, mode, expectation) {
  const output = mode === "inspect" ? path.join(item.directory,
    `github-output-${expectation.label}`) : null;
  const result = spawnSync(process.execPath,
    recoveryArguments(options, item, mode, output), {
      encoding: "utf8",
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
  if (expectation.success) {
    requireCondition(result.status === 0,
      `${expectation.label} failed: ${result.stderr.trim()}`, "REHEARSAL_RECOVERY_FAILED");
  } else {
    requireCondition(result.status !== 0 && result.stderr.includes(expectation.error),
      `${expectation.label} did not fail closed as expected`, "REHEARSAL_RECOVERY_FAILED");
  }
  let state = null;
  let missing = null;
  if (expectation.success && mode === "inspect") {
    const lines = readFileSync(output, "utf8").trim().split("\n");
    requireCondition(lines.length === 2 && /^state=[a-z-]+$/.test(lines[0]) &&
      /^missing=[0-9]+$/.test(lines[1]),
    `${expectation.label} wrote invalid GitHub output`, "REHEARSAL_RECOVERY_FAILED");
    state = lines[0].slice("state=".length);
    missing = Number(lines[1].slice("missing=".length));
    requireCondition(state === expectation.state && missing === expectation.missing,
      `${expectation.label} reported ${state}/${missing}`, "REHEARSAL_RECOVERY_FAILED");
  }
  return Object.freeze({ label: expectation.label, status: result.status,
    expectedFailure: !expectation.success, state, missing });
}

async function createTag(options, item) {
  return github(options.repository, "/git/refs", {
    method: "POST",
    json: { ref: `refs/tags/${item.tag}`, sha: options.commit },
  });
}

async function createRelease(options, item, draft) {
  return github(options.repository, "/releases", {
    method: "POST",
    json: {
      tag_name: item.tag,
      target_commitish: options.commit,
      name: item.tag,
      body: `Disposable recovery rehearsal ${options.runId}: ${item.scenario}.`,
      draft,
      prerelease: true,
    },
  });
}

async function readRelease(options, item) {
  const published = await github(options.repository,
    `/releases/tags/${encodeURIComponent(item.tag)}`, { allowNotFound: true });
  if (published !== null) return published;
  for (let page = 1; page <= 100; page += 1) {
    const releases = await github(options.repository, `/releases?per_page=100&page=${page}`);
    requireCondition(Array.isArray(releases),
      "GitHub returned an invalid release listing", "REHEARSAL_GITHUB_API_ERROR");
    const matching = releases.filter((release) => release.tag_name === item.tag);
    requireCondition(matching.length <= 1,
      "GitHub returned duplicate releases for one tag", "REHEARSAL_GITHUB_API_ERROR");
    if (matching.length === 1) return matching[0];
    if (releases.length < 100) return null;
  }
  throw new Error("rehearsal release was not found within 10,000 repository releases");
}

async function waitForAsset(options, item, name, expected) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const release = await readRelease(options, item);
    if (release !== null) {
      requireCondition(Array.isArray(release.assets),
        "GitHub returned a release without an asset listing", "REHEARSAL_GITHUB_API_ERROR");
      const asset = release.assets.find((candidate) => candidate.name === name);
      if (asset?.size === expected.size && asset.digest === `sha256:${expected.sha256}`) {
        return release;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`GitHub did not publish a verifiable digest for ${name}`);
}

function summarizeRelease(release) {
  return {
    id: release.id,
    tag: release.tag_name,
    draft: release.draft,
    prerelease: release.prerelease,
    assets: release.assets.map((asset) => ({
      name: asset.name,
      size: asset.size,
      digest: asset.digest,
    })).sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function runRecoveryRehearsal(options) {
  const stageStatus = lstatSync(options.stage);
  requireCondition(stageStatus.isFile() && !stageStatus.isSymbolicLink() && stageStatus.size > 0,
    "stage must be a nonempty regular file", "INVALID_REHEARSAL_STAGE");
  const repository = await github(options.repository, "");
  requireCondition(repository.full_name === options.repository && repository.private === true &&
    repository.archived === false && repository.default_branch === "main",
  "rehearsal repository must be the named private, unarchived repository with default branch main",
  "INVALID_REHEARSAL_REPOSITORY");
  const main = await github(options.repository, "/git/ref/heads/main");
  const tags = await github(options.repository, "/tags?per_page=100");
  const releases = await github(options.repository, "/releases?per_page=100");
  requireCondition(main.object?.type === "commit" && main.object.sha === options.commit &&
    Array.isArray(tags) && tags.length === 0 && Array.isArray(releases) && releases.length === 0,
  "rehearsal repository must point main at the exact commit and contain no tags or releases",
  "INVALID_REHEARSAL_REPOSITORY");

  mkdirSync(options.outputDirectory, { mode: 0o700 });
  const scratch = mkdtempSync(path.join(tmpdir(), "fault-affinity-recovery-rehearsal-"));
  const record = {
    schemaVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    repository: {
      fullName: repository.full_name,
      id: repository.id,
      private: repository.private,
      commit: options.commit,
    },
    inputs: {
      runId: options.runId,
      implementationCommit: options.implementationCommit,
      stageSha256: sha256File(options.stage),
      sourceDateEpoch: Number(options.sourceDateEpoch),
      rehearsalScriptSha256: sha256File(rehearsalScript),
      recoveryScriptSha256: sha256File(recoverScript),
    },
    checks: [],
    releases: [],
  };
  try {
    const complete = finalizeCase(options, scratch, "complete");
    record.checks.push(runRecovery(options, complete, "inspect", {
      label: "missing tag refusal", success: false, error: "refuses to create a missing release tag",
    }));
    await createTag(options, complete);
    record.checks.push(runRecovery(options, complete, "inspect", {
      label: "tag without release inspection", success: true,
      state: "tag-without-release", missing: RECOVERY_ASSET_NAMES.length,
    }));
    record.checks.push(runRecovery(options, complete, "publish", {
      label: "tag without release recovery", success: true,
    }));
    const completedRelease = await readRelease(options, complete);
    const completedState = classifyRecoveryState({ tagExists: true, tagCommit: options.commit,
      expectedCommit: options.commit, release: completedRelease, localAssets: complete.assets });
    requireCondition(completedState.state === "published-complete",
      "recovered release is not complete", "REHEARSAL_RECOVERY_FAILED");
    record.checks.push(runRecovery(options, complete, "inspect", {
      label: "published release inspection", success: true,
      state: "published-complete", missing: 0,
    }));
    record.checks.push(runRecovery(options, complete, "publish", {
      label: "published release idempotence", success: true,
    }));
    record.releases.push(summarizeRelease(await readRelease(options, complete)));

    const partial = finalizeCase(options, scratch, "partial");
    await createTag(options, partial);
    const partialDraft = await createRelease(options, partial, true);
    const [partialName, partialAsset] = partial.assets.entries().next().value;
    await uploadAsset(partialDraft, partialName, partialAsset.file);
    await waitForAsset(options, partial, partialName, partialAsset);
    record.checks.push(runRecovery(options, partial, "inspect", {
      label: "partial draft inspection", success: true,
      state: "matching-draft", missing: RECOVERY_ASSET_NAMES.length - 1,
    }));
    record.checks.push(runRecovery(options, partial, "publish", {
      label: "partial draft recovery", success: true,
    }));
    const partialCompleted = await readRelease(options, partial);
    requireCondition(classifyRecoveryState({ tagExists: true, tagCommit: options.commit,
      expectedCommit: options.commit, release: partialCompleted,
      localAssets: partial.assets }).state === "published-complete",
    "partial draft did not converge", "REHEARSAL_RECOVERY_FAILED");
    record.releases.push(summarizeRelease(partialCompleted));

    const conflict = finalizeCase(options, scratch, "conflict");
    await createTag(options, conflict);
    const conflictDraft = await createRelease(options, conflict, true);
    const [conflictName] = conflict.assets.keys();
    const conflictFile = path.join(scratch, "intentional-conflict.bin");
    writeFileSync(conflictFile, "intentional recovery conflict fixture\n", { mode: 0o600 });
    const uploadedConflict = await uploadAsset(conflictDraft, conflictName, conflictFile);
    await waitForAsset(options, conflict, conflictName, {
      size: Number(lstatSync(conflictFile).size),
      sha256: sha256File(conflictFile),
    });
    requireCondition(uploadedConflict.name === conflictName,
      "conflicting fixture upload changed name", "REHEARSAL_RECOVERY_FAILED");
    record.checks.push(runRecovery(options, conflict, "inspect", {
      label: "conflicting asset refusal", success: false,
      error: "published asset conflicts with retained bytes",
    }));
    const conflictAfter = await readRelease(options, conflict);
    requireCondition(conflictAfter.draft === true && conflictAfter.assets.length === 1,
      "conflict refusal mutated the remote draft", "REHEARSAL_RECOVERY_FAILED");
    record.releases.push(summarizeRelease(conflictAfter));

    const incomplete = finalizeCase(options, scratch, "incomplete");
    await createTag(options, incomplete);
    await createRelease(options, incomplete, false);
    record.checks.push(runRecovery(options, incomplete, "inspect", {
      label: "published incomplete refusal", success: false,
      error: "published release is missing retained assets",
    }));
    const incompleteAfter = await readRelease(options, incomplete);
    requireCondition(incompleteAfter.draft === false && incompleteAfter.assets.length === 0,
      "incomplete-release refusal mutated the remote release", "REHEARSAL_RECOVERY_FAILED");
    record.releases.push(summarizeRelease(incompleteAfter));

    if (options.archiveRepository) {
      const archived = await github(options.repository, "", {
        method: "PATCH",
        json: { archived: true },
      });
      requireCondition(archived.archived === true,
        "GitHub did not archive the rehearsal repository", "REHEARSAL_GITHUB_API_ERROR");
      record.repository.archived = true;
    } else {
      record.repository.archived = false;
    }
    record.status = "passed";
    record.completedAt = new Date().toISOString();
    writeCanonicalJson(path.join(options.outputDirectory, "rehearsal.json"), record);
    process.stdout.write(`release recovery rehearsal passed: ${options.outputDirectory}\n`);
    return Object.freeze(record);
  } catch (error) {
    record.status = "failed";
    record.completedAt = new Date().toISOString();
    record.error = error.message;
    writeCanonicalJson(path.join(options.outputDirectory, "rehearsal.json"), record);
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === rehearsalScript;
if (invoked) {
  try {
    const options = parseRecoveryRehearsalArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(usage());
    else await runRecoveryRehearsal(options);
  } catch (error) {
    process.stderr.write(`rehearse-release-recovery: ${error.message}\n`);
    process.exitCode = 1;
  }
}
