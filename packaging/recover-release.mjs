#!/usr/bin/env node
import {
  createReadStream,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyRecoveryState } from "./lib/recovery.mjs";
import {
  COMMIT_RE,
  readJson,
  requireCondition,
  run,
  sha256File,
  verifyModeManifest,
} from "./lib/common.mjs";

const packagingDirectory = path.dirname(fileURLToPath(import.meta.url));

const ASSET_NAMES = new Set([
  "fault-affinity-live-linux-x64.tar.gz",
  "fault-affinity-live-linux-x64.tar.gz.sha256",
  "fault-affinity-sbom.spdx.json",
  "fault-affinity-sbom.spdx.json.sha256",
  "SHA256SUMS",
]);

function parseArguments(args) {
  const result = { repository: null, tag: null, commit: null, assetsDirectory: null, plan: null,
    mode: null, githubOutput: null };
  for (let index = 0; index < args.length; index += 2) {
    const key = ({ "--repository": "repository", "--tag": "tag", "--commit": "commit",
      "--assets-directory": "assetsDirectory", "--plan": "plan" })[args[index]];
    const resolvedKey = key ?? ({ "--mode": "mode", "--github-output": "githubOutput" })[args[index]];
    requireCondition(resolvedKey && args[index + 1], `invalid argument ${args[index] ?? ""}`);
    result[resolvedKey] = args[index + 1];
  }
  requireCondition(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.repository ?? "") &&
    /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/.test(result.tag ?? "") &&
    COMMIT_RE.test(result.commit ?? "") && result.assetsDirectory && result.plan &&
    ["inspect", "publish"].includes(result.mode) &&
    (result.mode !== "inspect" || result.githubOutput),
  "repository, tag, commit, assets directory, retained plan, and recovery mode are required");
  result.assetsDirectory = path.resolve(result.assetsDirectory);
  result.plan = path.resolve(result.plan);
  return result;
}

async function github(requestPath, options = {}) {
  const token = process.env.GH_TOKEN;
  requireCondition(token, "GH_TOKEN is required for release recovery", "MISSING_TOKEN");
  const response = await fetch(`https://api.github.com${requestPath}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...(options.headers ?? {}),
    },
    redirect: "error",
  });
  if (response.status === 404) return null;
  requireCondition(response.ok, `GitHub API ${requestPath} returned ${response.status}`,
    "GITHUB_API_ERROR");
  if (response.status === 204) return {};
  return response.json();
}

async function dereferenceTag(repository, tag) {
  const ref = await github(`/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref === null) return null;
  if (ref.object.type === "commit") return ref.object.sha;
  requireCondition(ref.object.type === "tag", "tag ref has an unsupported object type");
  const annotated = await github(`/repos/${repository}/git/tags/${ref.object.sha}`);
  requireCondition(annotated?.object?.type === "commit", "annotated tag does not point to a commit");
  return annotated.object.sha;
}

function localAssets(directory) {
  const names = readdirSync(directory).sort();
  requireCondition(names.length === ASSET_NAMES.size && names.every((name) => ASSET_NAMES.has(name)),
    "retained artifact directory does not contain the exact release asset set",
    "RECOVERY_ASSET_SET_MISMATCH");
  const sums = readFileSync(path.join(directory, "SHA256SUMS"), "utf8").trimEnd().split("\n");
  const checksums = new Map(sums.map((line) => {
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9_.-]+)$/);
    requireCondition(match, "SHA256SUMS is malformed", "RECOVERY_CHECKSUM_INVALID");
    return [match[2], match[1]];
  }));
  requireCondition(checksums.size === 2,
    "SHA256SUMS must contain exactly the kit and SBOM", "RECOVERY_CHECKSUM_INVALID");
  for (const name of ["fault-affinity-live-linux-x64.tar.gz", "fault-affinity-sbom.spdx.json"]) {
    requireCondition(checksums.get(name) === sha256File(path.join(directory, name)),
      `retained checksum does not match ${name}`, "RECOVERY_CHECKSUM_INVALID");
    requireCondition(readFileSync(path.join(directory, `${name}.sha256`), "utf8") ===
      `${checksums.get(name)}  ${name}\n`,
    `retained checksum sidecar does not match ${name}`, "RECOVERY_CHECKSUM_INVALID");
  }
  return new Map(names.map((name) => {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    requireCondition(stat.isFile() && !stat.isSymbolicLink(), `unsafe retained asset ${name}`);
    return [name, { file, size: Number(stat.size), sha256: sha256File(file) }];
  }));
}

function verifyRetainedRelease(directory, plan) {
  const scratch = mkdtempSync(path.join(tmpdir(), "fault-affinity-recovery-"));
  try {
    run("python3", [path.join(packagingDirectory, "safe-extract.py"),
      path.join(directory, "fault-affinity-live-linux-x64.tar.gz"), scratch]);
    const root = path.join(scratch, "fault-affinity");
    verifyModeManifest(root, path.join(root, "MODE-MANIFEST.json"));
    const release = readJson(path.join(root, "RELEASE.json"));
    requireCondition(release.schemaVersion === 1 &&
      release.release?.version === plan.nextRelease.version &&
      release.release?.tag === plan.nextRelease.gitTag &&
      release.release?.sourceCommit === plan.commit,
    "retained kit release identity does not match its release plan",
    "RECOVERY_PLAN_MISMATCH");
    const sbom = readJson(path.join(directory, "fault-affinity-sbom.spdx.json"));
    requireCondition(sbom.spdxVersion === "SPDX-2.3" &&
      sbom.name === `fault-affinity-${plan.nextRelease.version}-linux-x64` &&
      sbom.documentNamespace.endsWith(`#sbom-${plan.commit}`),
    "retained SBOM identity does not match its release plan", "RECOVERY_PLAN_MISMATCH");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function uploadAsset(repository, release, name, local) {
  const uploadUrl = new URL(release.upload_url.replace("{?name,label}", ""));
  requireCondition(uploadUrl.origin === "https://uploads.github.com",
    "GitHub returned an unexpected upload origin", "GITHUB_API_ERROR");
  uploadUrl.searchParams.set("name", name);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/octet-stream",
      "content-length": String(local.size),
      "x-github-api-version": "2022-11-28",
    },
    body: createReadStream(local.file),
    duplex: "half",
    redirect: "error",
  });
  requireCondition(response.status === 201, `GitHub rejected asset ${name}: ${response.status}`,
    "GITHUB_API_ERROR");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const assets = localAssets(options.assetsDirectory);
  const plan = JSON.parse(readFileSync(options.plan, "utf8"));
  requireCondition(plan.schemaVersion === 1 && plan.status === "release" &&
    plan.commit === options.commit && plan.nextRelease?.gitTag === options.tag &&
    plan.nextRelease?.gitHead === options.commit &&
    typeof plan.nextRelease.notes === "string",
  "retained release plan does not match recovery inputs", "RECOVERY_PLAN_MISMATCH");
  verifyRetainedRelease(options.assetsDirectory, plan);
  const tagCommit = await dereferenceTag(options.repository, options.tag);
  let release = await github(`/repos/${options.repository}/releases/tags/${encodeURIComponent(options.tag)}`);
  let classification = classifyRecoveryState({ tagExists: tagCommit !== null, tagCommit,
    expectedCommit: options.commit, release, localAssets: assets });
  if (options.mode === "inspect") {
    writeFileSync(options.githubOutput,
      `state=${classification.state}\nmissing=${classification.missing.length}\n`, { flag: "a" });
    process.stdout.write(`recovery state: ${classification.state}\n`);
    return;
  }
  if (classification.state === "published-complete") {
    process.stdout.write("release is already published with the retained asset set\n");
    return;
  }
  if (classification.state === "tag-without-release") {
    release = await github(`/repos/${options.repository}/releases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag_name: options.tag, target_commitish: options.commit,
        name: options.tag, body: plan.nextRelease.notes, draft: true, prerelease: false }),
    });
    requireCondition(release?.draft === true, "GitHub did not create the expected draft release");
    classification = { state: "matching-draft", missing: [...assets.keys()] };
  }
  requireCondition(classification.state === "matching-draft", "unsupported recovery state");
  for (const name of classification.missing) await uploadAsset(options.repository, release, name,
    assets.get(name));
  let refreshed;
  let verified;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    refreshed = await github(`/repos/${options.repository}/releases/tags/${encodeURIComponent(options.tag)}`);
    try {
      verified = classifyRecoveryState({ tagExists: true, tagCommit, expectedCommit: options.commit,
        release: refreshed, localAssets: assets });
      if (verified.missing.length === 0) break;
    } catch (error) {
      if (attempt === 5) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  requireCondition(verified?.state === "matching-draft" && verified.missing.length === 0,
    "draft assets did not become digest-verifiable in time", "RECOVERY_ASSET_UNVERIFIED");
  await github(`/repos/${options.repository}/releases/${refreshed.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft: false }),
  });
  process.stdout.write(`published recovered ${options.tag} without replacing assets\n`);
}

main().catch((error) => {
  process.stderr.write(`recover-release: ${error.message}\n`);
  process.exitCode = 1;
});
