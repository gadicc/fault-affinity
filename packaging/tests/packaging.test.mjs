import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  sha256File,
  treeDigest,
  verifyModeManifest,
  writeCanonicalJson,
  writeModeManifest,
} from "../lib/common.mjs";
import { acquireRuntimeArchive, loadRuntimeLock } from "../lib/runtime-lock.mjs";
import { classifyRecoveryState } from "../lib/recovery.mjs";
import { verifyRelease } from "../semantic-release-plan-guard.mjs";
import { calculateReleasePlan } from "../release-plan.mjs";
import { publishPlannedRelease } from "../publish-release.mjs";
import { readReleaseReadiness } from "../release-readiness.mjs";
import { validateRecoveryRunProvenance } from "../validate-recovery-run.mjs";
import {
  buildGuestStartCommand,
  buildQemuArguments,
  parseLiveIsoAcceptanceArguments,
} from "../live-iso-acceptance.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function temporaryDirectory(name) {
  return mkdtempSync(path.join(tmpdir(), `${name}-`));
}

test("the reviewed runtime lock contains exact platform roles", () => {
  const lock = loadRuntimeLock(path.join(repositoryRoot, "packaging/runtime-lock.json"));
  assert.equal(lock.platforms["linux-x64"].controller.version, "v24.21.0");
  assert.equal(lock.platforms["linux-x64"].reference.version, "v25.2.1");
  assert.equal(lock.platforms["windows-x64"].controller.sha256,
    "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541");
});

test("the live ISO lock pins the accepted Ubuntu Desktop image", () => {
  const iso = JSON.parse(readFileSync(path.join(repositoryRoot,
    "packaging/live-iso-lock.json"), "utf8"));
  assert.deepEqual(iso, {
    schemaVersion: 1,
    filename: "ubuntu-26.04.1-desktop-amd64.iso",
    bytes: 6482409472,
    sha256: "601e30fbf5d97759367c632e2c33630665039b7e2158fd068403da3ccf1bda1f",
    volumeId: "Ubuntu 26.04.1 LTS amd64",
    releasePage: "https://releases.ubuntu.com/26.04.1/",
  });
});

test("public publication remains blocked until every named acceptance gate is true", () => {
  const readiness = readReleaseReadiness(path.join(repositoryRoot,
    "packaging/release-readiness.json"));
  assert.equal(readiness.publicReleaseEnabled, false);
  assert.deepEqual(readiness.gates, {
    resultPreparationLeaseVerified: true,
    ubuntu2604LiveAcceptance: false,
    releaseRecoveryRehearsal: false,
    remoteProtectionsConfirmed: false,
  });
});

test("runtime acquisition rejects content that differs from its lock", async () => {
  const directory = temporaryDirectory("runtime-lock-test");
  try {
    const bytes = Buffer.from("locked runtime fixture");
    const item = {
      archive: "node-v1.2.3-linux-x64.tar.xz",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      url: "https://nodejs.org/dist/v1.2.3/node-v1.2.3-linux-x64.tar.xz",
    };
    const file = await acquireRuntimeArchive(item, directory, async () => {
      const response = new Response(bytes, {
        status: 200,
        headers: { "content-length": bytes.length },
      });
      Object.defineProperty(response, "url", { value: item.url });
      return response;
    });
    assert.equal(readFileSync(file, "utf8"), bytes.toString());
    writeFileSync(file, "changed");
    await assert.rejects(() => acquireRuntimeArchive(item, directory),
      /cached runtime does not match lock/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime acquisition aborts oversized and stalled responses within bounds", async () => {
  const bytes = Buffer.from("locked");
  const item = {
    archive: "node-v1.2.3-linux-x64.tar.xz",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: "https://nodejs.org/dist/v1.2.3/node-v1.2.3-linux-x64.tar.xz",
  };
  const responseWithUrl = (body, init = {}) => {
    const response = new Response(body, init);
    Object.defineProperty(response, "url", { value: item.url });
    return response;
  };

  const oversizedDirectory = temporaryDirectory("runtime-oversized-test");
  try {
    await assert.rejects(() => acquireRuntimeArchive(item, oversizedDirectory, {
      requestTimeoutMs: 100,
      bodyTimeoutMs: 100,
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, "error");
        assert.equal(options.signal.aborted, false);
        return responseWithUrl(Buffer.concat([bytes, Buffer.from("extra")]));
      },
    }), /exceeded locked size/);
    assert.deepEqual(readdirSync(oversizedDirectory), []);
  } finally {
    rmSync(oversizedDirectory, { recursive: true, force: true });
  }

  const requestDirectory = temporaryDirectory("runtime-request-timeout-test");
  try {
    await assert.rejects(() => acquireRuntimeArchive(item, requestDirectory, {
      requestTimeoutMs: 10,
      bodyTimeoutMs: 100,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }), /request deadline exceeded/);
  } finally {
    rmSync(requestDirectory, { recursive: true, force: true });
  }

  const bodyDirectory = temporaryDirectory("runtime-body-timeout-test");
  try {
    await assert.rejects(() => acquireRuntimeArchive(item, bodyDirectory, {
      requestTimeoutMs: 100,
      bodyTimeoutMs: 10,
      fetchImpl: async () => responseWithUrl(new ReadableStream({ start() {} })),
    }), /abort/i);
    assert.deepEqual(readdirSync(bodyDirectory), []);
  } finally {
    rmSync(bodyDirectory, { recursive: true, force: true });
  }

  const redirectDirectory = temporaryDirectory("runtime-redirect-test");
  try {
    await assert.rejects(() => acquireRuntimeArchive(item, redirectDirectory, {
      requestTimeoutMs: 100,
      bodyTimeoutMs: 100,
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, "error");
        return responseWithUrl(null, { status: 302 });
      },
    }), /unexpected response/);
  } finally {
    rmSync(redirectDirectory, { recursive: true, force: true });
  }
});

test("mode manifests detect broadened executable permissions", () => {
  const directory = temporaryDirectory("mode-manifest-test");
  try {
    writeFileSync(path.join(directory, "file"), "x", { mode: 0o644 });
    writeModeManifest(directory, path.join(directory, "MODE-MANIFEST.json"));
    verifyModeManifest(directory, path.join(directory, "MODE-MANIFEST.json"));
    const manifest = JSON.parse(readFileSync(path.join(directory, "MODE-MANIFEST.json")));
    manifest.files[0].mode = "0755";
    writeFileSync(path.join(directory, "MODE-MANIFEST.json"), `${JSON.stringify(manifest)}\n`);
    assert.throws(() => verifyModeManifest(directory,
      path.join(directory, "MODE-MANIFEST.json")), /differ from MODE-MANIFEST/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("result wrapper rejects Node and loader injection before invoking the runtime", () => {
  const result = spawnSync("sh", [path.join(repositoryRoot,
    "packaging/templates/prepare-results"), "--help"], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--trace-warnings" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing injection-capable environment variable NODE_OPTIONS/);
});

test("the structured stage extractor rejects links", () => {
  const fixture = temporaryDirectory("unsafe-stage-test");
  try {
    const root = path.join(fixture, "fault-affinity");
    mkdirSync(root);
    writeFileSync(path.join(root, "file"), "safe");
    symlinkSync("file", path.join(root, "link"));
    const archive = path.join(fixture, "unsafe.tar.gz");
    const packed = spawnSync("tar", ["--owner=0", "--group=0", "--numeric-owner",
      "--format=ustar", "--create", "--gzip", "--file", archive,
      "--directory", fixture, "fault-affinity"]);
    assert.equal(packed.status, 0);
    const destination = path.join(fixture, "destination");
    mkdirSync(destination);
    const result = spawnSync("python3", [path.join(repositoryRoot, "packaging/safe-extract.py"),
      archive, destination], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /link or special member/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("release recovery refuses conflicts and recognizes complete publication", () => {
  const assets = new Map([["kit.tar.gz", { size: 10, sha256: "a".repeat(64) }]]);
  assert.deepEqual(classifyRecoveryState({ tagExists: true, tagCommit: "b".repeat(40),
    expectedCommit: "b".repeat(40), release: null, localAssets: assets }),
  { state: "tag-without-release", missing: ["kit.tar.gz"] });
  assert.throws(() => classifyRecoveryState({ tagExists: true, tagCommit: "b".repeat(40),
    expectedCommit: "c".repeat(40), release: null, localAssets: assets }), /conflicting commit/);
  assert.deepEqual(classifyRecoveryState({ tagExists: true, tagCommit: "b".repeat(40),
    expectedCommit: "b".repeat(40), release: { draft: false, assets: [{
      name: "kit.tar.gz", size: 10, digest: `sha256:${"a".repeat(64)}`,
    }] }, localAssets: assets }), { state: "published-complete", missing: [] });
});

function recoveryProvenanceFixture() {
  const commit = "9".repeat(40);
  const repository = "gadicc/fault-affinity";
  const run = {
    id: 12345,
    workflow_id: 777,
    path: ".github/workflows/release.yml",
    head_branch: "main",
    head_sha: commit,
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    event: "push",
    repository: { id: 42, full_name: repository },
    head_repository: { id: 42, full_name: repository },
  };
  const workflow = {
    id: 777,
    path: ".github/workflows/release.yml",
    state: "active",
  };
  const artifact = {
    id: 54321,
    name: `finalized-release-${commit}`,
    expired: false,
    size_in_bytes: 1024,
    workflow_run: {
      id: 12345,
      head_branch: "main",
      head_sha: commit,
      repository_id: 42,
      head_repository_id: 42,
    },
  };
  return {
    run,
    workflow,
    artifactsResponse: { total_count: 1, artifacts: [artifact] },
    expectedRepository: repository,
    expectedRunId: "12345",
    expectedCommit: commit,
    expectedArtifactName: artifact.name,
  };
}

test("recovery binds one artifact to the trusted completed main release run", () => {
  const fixture = recoveryProvenanceFixture();
  assert.deepEqual(validateRecoveryRunProvenance(fixture), {
    runId: "12345",
    artifactId: "54321",
    artifactName: fixture.expectedArtifactName,
    commit: fixture.expectedCommit,
    workflowId: "777",
  });
  const manual = structuredClone(fixture);
  manual.run.event = "workflow_dispatch";
  assert.equal(validateRecoveryRunProvenance(manual).artifactId, "54321");
});

test("recovery rejects user-selected artifacts without exact server provenance", () => {
  for (const mutate of [
    (value) => { value.run.path = ".github/workflows/package-snapshot.yml"; },
    (value) => { value.run.path = ".github/workflows/release.yml@main"; },
    (value) => { value.run.head_branch = "dev"; },
    (value) => { value.run.repository.full_name = "attacker/fault-affinity"; },
    (value) => { value.run.conclusion = "cancelled"; },
    (value) => { value.run.event = "pull_request"; },
    (value) => { value.artifactsResponse.artifacts[0].expired = true; },
    (value) => { value.artifactsResponse.artifacts[0].workflow_run.head_sha = "8".repeat(40); },
  ]) {
    const fixture = recoveryProvenanceFixture();
    mutate(fixture);
    assert.throws(() => validateRecoveryRunProvenance(fixture));
  }
});

test("release workflow passes expression values through env instead of shell interpolation", () => {
  const workflow = readFileSync(path.join(repositoryRoot,
    ".github/workflows/release.yml"), "utf8");
  const runPrograms = workflow.match(/^\s+run:\s*(?:\|\s*|>-\s*|[^\n]*)(?:\n(?:\s{10,}[^\n]*|\s*))*/gm) ?? [];
  assert.ok(runPrograms.length > 0, "expected workflow shell programs");
  for (const program of runPrograms) {
    assert.doesNotMatch(program, /\$\{\{/,
      "workflow expressions must cross the expression/shell boundary through env");
  }
});

test("dev snapshots upload a finalized non-publishing acceptance candidate", () => {
  const workflow = readFileSync(path.join(repositoryRoot,
    ".github/workflows/package-snapshot.yml"), "utf8");
  assert.match(workflow, /node packaging\/finalize-release\.mjs/);
  assert.match(workflow, /candidate_version="0\.1\.0-dev\.\$\{SOURCE_COMMIT:0:12\}"/);
  assert.match(workflow, /sha256sum --check SHA256SUMS/);
  assert.match(workflow, /python3 "\$RUNNER_TEMP\/acceptance\/safe-extract\.py"/);
  assert.match(workflow, /name: linux-x64-acceptance-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.doesNotMatch(workflow, /gh release|semantic-release|publish-release/);

  const pathsBlock = workflow.match(/^    paths:\n((?:      - [^\n]+\n)+)/m);
  assert.ok(pathsBlock, "snapshot workflow must declare push path filters");
  const triggerPaths = pathsBlock[1].trim().split("\n").map((line) =>
    JSON.parse(line.replace(/^\s*-\s*/, "")));
  const packagedSources = JSON.parse(readFileSync(path.join(repositoryRoot,
    "packaging/linux-files.json"), "utf8")).regularFiles.map((entry) => entry.source);
  for (const source of packagedSources) {
    assert.ok(triggerPaths.some((trigger) => trigger === source ||
      (trigger.endsWith("/**") && source.startsWith(trigger.slice(0, -2)))),
    `snapshot workflow does not cover packaged source ${source}`);
  }
});

test("dev snapshot support is self-contained and remains harmless", () => {
  const workflow = readFileSync(path.join(repositoryRoot,
    ".github/workflows/package-snapshot.yml"), "utf8");
  assert.match(workflow, /acceptance\/safe-extract\.py/);
  assert.match(workflow, /acceptance\/ACCEPTANCE\.txt/);
  assert.match(workflow, /acceptance\/acceptance-vm\.sh/);
  assert.match(workflow, /ACCEPTANCE-SUPPORT-SHA256SUMS/);

  const guest = readFileSync(path.join(repositoryRoot,
    "packaging/templates/acceptance-vm.sh"), "utf8");
  assert.match(guest, /systemd-detect-virt/);
  assert.match(guest, /kvm\|qemu/);
  assert.match(guest, /kvm\|qemu[\s\S]+trap finish EXIT/);
  assert.match(guest, /VERSION_ID:-.*26\.04/);
  assert.match(guest, /sha256sum --check ACCEPTANCE-SUPPORT-SHA256SUMS/);
  assert.match(guest, /sha256sum --check SHA256SUMS/);
  assert.match(guest, /safe-extract\.py/);
  assert.match(guest, /before_inventory[\s\S]+after_inventory/);
  assert.match(guest, /--dry-run/);
  assert.doesNotMatch(guest, /--yes|child\.mjs|yes-load|PGlite/);

  const fixture = temporaryDirectory("rejected-acceptance-helper");
  try {
    const sudoMarker = path.join(fixture, "sudo-was-called");
    writeFileSync(path.join(fixture, "systemd-detect-virt"), "#!/bin/sh\nprintf 'none\\n'\n");
    writeFileSync(path.join(fixture, "sudo"), "#!/bin/sh\n: > \"$SUDO_MARKER\"\n");
    chmodSync(path.join(fixture, "systemd-detect-virt"), 0o755);
    chmodSync(path.join(fixture, "sudo"), 0o755);
    const rejected = spawnSync("/bin/sh", [path.join(repositoryRoot,
      "packaging/templates/acceptance-vm.sh"), fixture], {
      encoding: "utf8",
      env: { PATH: fixture, SUDO_MARKER: sudoMarker },
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /only inside QEMU\/KVM/);
    assert.doesNotMatch(rejected.stdout, /FAULT_AFFINITY_VM_STATUS/);
    assert.equal(existsSync(sudoMarker), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("live ISO acceptance builds a serial-only QEMU dry-run boundary", () => {
  const options = parseLiveIsoAcceptanceArguments([
    "--iso", "/images/ubuntu.iso",
    "--candidate-dir", "/candidate",
    "--output-dir", "/output",
  ]);
  assert.equal(options.cpus, 4);
  assert.equal(options.memoryMiB, 4096);
  assert.equal(options.timeoutSeconds, 900);
  assert.throws(() => parseLiveIsoAcceptanceArguments([
    "--iso", "/images/ubuntu.iso",
    "--candidate-dir", "/candidate",
    "--output-dir", "/output",
    "--cpus", "3",
  ]), /--cpus must be from 4 through 64/);

  const qemu = buildQemuArguments({
    iso: "/images/ubuntu.iso",
    candidateIso: "/scratch/candidate.iso",
    resultsDisk: "/scratch/results.ext4",
    kernel: "/scratch/vmlinuz",
    initrd: "/scratch/initrd",
    cpus: 4,
    memoryMiB: 4096,
    acceleration: "tcg",
  });
  assert.ok(qemu.includes("q35,accel=tcg"));
  assert.ok(qemu.some((argument) => argument.includes("systemd.unit=multi-user.target")));
  assert.ok(qemu.includes("stdio"));
  assert.ok(qemu.some((argument) => argument.includes("candidate.iso") &&
    argument.includes("readonly=on")));
  assert.ok(qemu.some((argument) => argument.includes("results.ext4") &&
    argument.includes("if=virtio")));
  const guestStart = buildGuestStartCommand();
  assert.match(guestStart, /trap .*FAULT_AFFINITY_VM_STATUS/);
  assert.doesNotMatch(guestStart, /trap - EXIT|--yes|child\.mjs|yes-load|PGlite/);
});

test("semantic-release guard enforces planned version and commit before publish", async () => {
  const saved = { version: process.env.EXPECTED_RELEASE_VERSION,
    commit: process.env.EXPECTED_RELEASE_COMMIT, sha: process.env.GITHUB_SHA };
  try {
    process.env.EXPECTED_RELEASE_VERSION = "0.1.0";
    process.env.EXPECTED_RELEASE_COMMIT = "d".repeat(40);
    process.env.GITHUB_SHA = "d".repeat(40);
    await verifyRelease({}, { nextRelease: { version: "0.1.0", gitHead: "d".repeat(40) } });
    await assert.rejects(() => verifyRelease({}, {
      nextRelease: { version: "0.2.0", gitHead: "d".repeat(40) },
    }),
      /expected 0.1.0/);
    await assert.rejects(() => verifyRelease({}, {
      nextRelease: { version: "0.1.0", gitHead: "c".repeat(40) },
    }), /git head/);
  } finally {
    for (const [key, value] of Object.entries({ EXPECTED_RELEASE_VERSION: saved.version,
      EXPECTED_RELEASE_COMMIT: saved.commit, GITHUB_SHA: saved.sha })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("release planning records a version-neutral no-release or exact release decision", async () => {
  const commit = "e".repeat(40);
  assert.deepEqual(await calculateReleasePlan({ commit, semantic: async () => false }), {
    schemaVersion: 1,
    status: "no-release",
    commit,
  });
  const result = await calculateReleasePlan({ commit, semantic: async () => ({
    lastRelease: { version: "0.0.0", gitTag: "v0.0.0", gitHead: "d".repeat(40) },
    nextRelease: { type: "minor", version: "0.1.0", gitTag: "v0.1.0",
      gitHead: commit, notes: "notes" },
  }) });
  assert.deepEqual(result.nextRelease,
    { type: "minor", version: "0.1.0", gitTag: "v0.1.0", gitHead: commit, notes: "notes" });
  await assert.rejects(() => calculateReleasePlan({ commit, semantic: async () => ({
    lastRelease: { version: "0.0.0", gitTag: "v0.0.0", gitHead: "d".repeat(40) },
    nextRelease: { type: "minor", version: "0.1.0", gitTag: "v0.1.0",
      gitHead: "a".repeat(40), notes: "notes" },
  }) }), /different git head/);
});

test("publish wrapper fails if semantic-release no longer reproduces the plan", async () => {
  const commit = "f".repeat(40);
  await assert.rejects(() => publishPlannedRelease({ expectedVersion: "0.1.0",
    expectedCommit: commit, semantic: async () => false }), /returned no release/);
  const result = await publishPlannedRelease({ expectedVersion: "0.1.0",
    expectedCommit: commit, semantic: async () => ({
      nextRelease: { version: "0.1.0", gitHead: commit },
    }) });
  assert.equal(result.nextRelease.version, "0.1.0");
  await assert.rejects(() => publishPlannedRelease({ expectedVersion: "0.1.0",
    expectedCommit: commit, semantic: async () => ({
      nextRelease: { version: "0.1.0", gitHead: "0".repeat(40) },
    }) }), /does not match/);
});

test("release finalization is deterministic and binds final component identities", () => {
  const fixture = temporaryDirectory("finalize-fixture");
  try {
    const root = path.join(fixture, "fault-affinity");
    for (const directory of ["runtime/controller/bin", "runtime/reference/bin",
      "app/node_modules/@electric-sql/pglite", "bin", "share"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    writeFileSync(path.join(root, "runtime/controller/bin/node"), "controller", { mode: 0o755 });
    writeFileSync(path.join(root, "runtime/reference/bin/node"), "reference", { mode: 0o755 });
    writeFileSync(path.join(root, "app/node_modules/@electric-sql/pglite/index.js"), "export {};\n");
    writeFileSync(path.join(root, "app/package.json"), "{}\n");
    const controllerSha = sha256File(path.join(root, "runtime/controller/bin/node"));
    const referenceSha = sha256File(path.join(root, "runtime/reference/bin/node"));
    const template = JSON.parse(readFileSync(path.join(repositoryRoot,
      "packaging/RELEASE.template.json"), "utf8"));
    template.runtimes.controller.sha256 = controllerSha;
    template.runtimes.reference.sha256 = referenceSha;
    template.runtimeArchives = {
      controller: { version: "v24.21.0", archiveSha256: "a".repeat(64),
        binarySha256: controllerSha },
      reference: { version: "v25.2.1", archiveSha256: "b".repeat(64),
        binarySha256: referenceSha },
    };
    writeCanonicalJson(path.join(root, "RELEASE.template.json"), template);
    writeModeManifest(root, path.join(root, "MODE-MANIFEST.json"));
    const stage = path.join(fixture, "stage.tar.gz");
    const packed = spawnSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0",
      "--numeric-owner", "--format=ustar", "--create", "--gzip", "--file", stage,
      "--directory", fixture, "fault-affinity"]);
    assert.equal(packed.status, 0);

    const outputs = [path.join(fixture, "output-one"), path.join(fixture, "output-two")];
    for (const output of outputs) {
      const result = spawnSync(process.execPath, [path.join(repositoryRoot,
        "packaging/finalize-release.mjs"), "--stage", stage, "--output-directory", output,
      "--version", "0.1.0", "--commit", "c".repeat(40), "--source-date-epoch", "1"],
      { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const archiveName = "fault-affinity-live-linux-x64.tar.gz";
    assert.equal(sha256File(path.join(outputs[0], archiveName)),
      sha256File(path.join(outputs[1], archiveName)));
    assert.match(readFileSync(path.join(outputs[0], "SHA256SUMS"), "utf8"),
      /fault-affinity-live-linux-x64\.tar\.gz/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
