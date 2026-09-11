#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMIT_RE, requireCondition } from "./lib/common.mjs";

const TRUSTED_WORKFLOW_PATH = ".github/workflows/release.yml";
const RUN_ID_RE = /^[1-9][0-9]{0,15}$/;
const ARTIFACT_ID_RE = /^[1-9][0-9]{0,15}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function canonicalId(value, pattern, label) {
  const text = String(value);
  requireCondition(pattern.test(text) && Number.isSafeInteger(Number(text)),
    `${label} is not a canonical safe integer`, "RECOVERY_RUN_PROVENANCE_INVALID");
  return text;
}

export function validateRecoveryRunProvenance({
  run,
  workflow,
  artifactsResponse,
  expectedRepository,
  expectedRunId,
  expectedCommit,
  expectedArtifactName,
}) {
  requireCondition(REPOSITORY_RE.test(expectedRepository) && RUN_ID_RE.test(expectedRunId) &&
    COMMIT_RE.test(expectedCommit) && expectedArtifactName === `finalized-release-${expectedCommit}`,
  "expected recovery provenance inputs are invalid", "RECOVERY_RUN_PROVENANCE_INVALID");
  const runId = canonicalId(run?.id, RUN_ID_RE, "workflow run id");
  requireCondition(runId === expectedRunId && run.repository?.full_name === expectedRepository &&
    run.head_repository?.full_name === expectedRepository &&
    Number.isSafeInteger(run.repository?.id) && run.repository.id > 0 &&
    run.head_repository?.id === run.repository.id,
  "workflow run does not belong to the expected repository",
  "RECOVERY_RUN_REPOSITORY_MISMATCH");
  requireCondition(run.workflow_id === workflow?.id && Number.isSafeInteger(workflow?.id) &&
    workflow.id > 0 && workflow.path === TRUSTED_WORKFLOW_PATH && workflow.state === "active" &&
    run.path === TRUSTED_WORKFLOW_PATH,
  "workflow run does not belong to the trusted stable release workflow",
  "RECOVERY_RUN_WORKFLOW_MISMATCH");
  requireCondition(run.head_branch === "main" && run.head_sha === expectedCommit,
    "workflow run does not bind the expected main commit", "RECOVERY_RUN_COMMIT_MISMATCH");
  requireCondition(run.status === "completed" && ["success", "failure"].includes(run.conclusion),
    "workflow run must be completed successfully or with a recoverable failure",
    "RECOVERY_RUN_STATE_INVALID");
  requireCondition(Number.isSafeInteger(run.run_attempt) && run.run_attempt >= 1,
    "workflow run attempt is invalid", "RECOVERY_RUN_STATE_INVALID");
  requireCondition(["push", "workflow_dispatch"].includes(run.event),
  "workflow run event is not a main push or manual release",
  "RECOVERY_RUN_EVENT_INVALID");

  requireCondition(artifactsResponse !== null && typeof artifactsResponse === "object" &&
    Number.isSafeInteger(artifactsResponse.total_count) &&
    artifactsResponse.total_count >= 1 && artifactsResponse.total_count <= 100 &&
    Array.isArray(artifactsResponse.artifacts) &&
    artifactsResponse.artifacts.length === artifactsResponse.total_count,
  "workflow artifact listing is incomplete or invalid", "RECOVERY_RUN_ARTIFACT_INVALID");
  const matches = artifactsResponse.artifacts.filter((artifact) =>
    artifact?.name === expectedArtifactName);
  requireCondition(matches.length === 1, "workflow run must contain one exact finalized artifact",
    "RECOVERY_RUN_ARTIFACT_INVALID");
  const artifact = matches[0];
  const artifactId = canonicalId(artifact.id, ARTIFACT_ID_RE, "artifact id");
  requireCondition(artifact.expired === false && Number.isSafeInteger(artifact.size_in_bytes) &&
    artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 512 * 1024 * 1024 &&
    artifact.workflow_run?.id === run.id &&
    artifact.workflow_run?.head_branch === "main" &&
    artifact.workflow_run?.head_sha === expectedCommit &&
    artifact.workflow_run?.repository_id === run.repository.id &&
    artifact.workflow_run?.head_repository_id === run.head_repository.id,
  "finalized artifact does not bind the trusted workflow run",
  "RECOVERY_RUN_ARTIFACT_INVALID");
  return Object.freeze({
    runId,
    artifactId,
    artifactName: artifact.name,
    commit: expectedCommit,
    workflowId: String(workflow.id),
  });
}

async function github(apiPath, token, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com${apiPath}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
    });
  } catch (error) {
    throw new Error(`GitHub provenance request failed: ${error.message}`);
  }
  requireCondition(response.status === 200,
    `GitHub provenance request returned ${response.status}`,
    "RECOVERY_RUN_PROVENANCE_UNAVAILABLE");
  return response.json();
}

export async function fetchAndValidateRecoveryRun({
  repository,
  runId,
  commit,
  artifactName,
  token,
  fetchImpl = globalThis.fetch,
}) {
  requireCondition(REPOSITORY_RE.test(repository) && RUN_ID_RE.test(runId) &&
    COMMIT_RE.test(commit) && artifactName === `finalized-release-${commit}` && token,
  "recovery provenance query inputs are invalid", "RECOVERY_RUN_PROVENANCE_INVALID");
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  const [run, workflow, artifactsResponse] = await Promise.all([
    github(`/repos/${encodedRepository}/actions/runs/${runId}`, token, fetchImpl),
    github(`/repos/${encodedRepository}/actions/workflows/${encodeURIComponent(TRUSTED_WORKFLOW_PATH)}`,
      token, fetchImpl),
    github(`/repos/${encodedRepository}/actions/runs/${runId}/artifacts?per_page=100`, token,
      fetchImpl),
  ]);
  return validateRecoveryRunProvenance({
    run,
    workflow,
    artifactsResponse,
    expectedRepository: repository,
    expectedRunId: runId,
    expectedCommit: commit,
    expectedArtifactName: artifactName,
  });
}

function parseArguments(args) {
  const result = { repository: null, runId: null, commit: null, artifactName: null,
    githubOutput: null };
  const keys = {
    "--repository": "repository",
    "--run-id": "runId",
    "--commit": "commit",
    "--artifact-name": "artifactName",
    "--github-output": "githubOutput",
  };
  for (let index = 0; index < args.length; index += 2) {
    const key = keys[args[index]];
    requireCondition(key && args[index + 1], `invalid argument ${args[index] ?? ""}`);
    result[key] = args[index + 1];
  }
  requireCondition(Object.values(result).every(Boolean),
    "repository, run id, commit, artifact name, and GitHub output are required");
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const provenance = await fetchAndValidateRecoveryRun({
      repository: options.repository,
      runId: options.runId,
      commit: options.commit,
      artifactName: options.artifactName,
      token: process.env.GH_TOKEN,
    });
    appendFileSync(options.githubOutput,
      `artifact_id=${provenance.artifactId}\nartifact_name=${provenance.artifactName}\n` +
      `source_run_id=${provenance.runId}\nsource_commit=${provenance.commit}\n`);
    process.stdout.write(`validated artifact ${provenance.artifactId} from trusted run ${provenance.runId}\n`);
  } catch (error) {
    process.stderr.write(`validate-recovery-run: ${error.message}\n`);
    process.exitCode = 1;
  }
}
