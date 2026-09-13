#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packagingDirectory = path.dirname(fileURLToPath(import.meta.url));
const lock = JSON.parse(readFileSync(path.join(packagingDirectory, "live-iso-lock.json"), "utf8"));
const REQUIRED_CANDIDATE_FILES = Object.freeze([
  "ACCEPTANCE-SUPPORT-SHA256SUMS",
  "ACCEPTANCE.txt",
  "SHA256SUMS",
  "acceptance-vm.sh",
  "fault-affinity-live-linux-x64.tar.gz",
  "fault-affinity-live-linux-x64.tar.gz.sha256",
  "fault-affinity-sbom.spdx.json",
  "fault-affinity-sbom.spdx.json.sha256",
  "safe-extract.py",
]);
const ISO_HASH_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;

export class LiveIsoAcceptanceError extends Error {
  constructor(message, code = "LIVE_ISO_ACCEPTANCE_FAILED") {
    super(message);
    this.name = "LiveIsoAcceptanceError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new LiveIsoAcceptanceError(message, code);
}

function usage() {
  return `Usage: node packaging/live-iso-acceptance.mjs \\
  --iso /path/to/${lock.filename} \\
  --candidate-dir /path/to/unpacked/actions-artifact \\
  --output-dir /new/result/directory [options]\n\n` +
  "Options:\n" +
  "  --cpus N             virtual CPUs, at least 4 (default: 4)\n" +
  "  --memory-mib N       guest memory, 4096-32768 (default: 4096)\n" +
  "  --timeout-seconds N  total boot/test timeout, 300-3600 (default: 900)\n" +
  "  --help               print this help without starting QEMU\n\n" +
  "The guest performs checksum, extraction, runtime/help, and dry-run checks only.\n" +
  "It never supplies live confirmation or starts the diagnostic workload.\n";
}

function integer(text, label, minimum, maximum) {
  if (!/^(0|[1-9][0-9]*)$/.test(text ?? "")) fail(`${label} must be an integer`);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be from ${minimum} through ${maximum}`);
  }
  return value;
}

export function parseLiveIsoAcceptanceArguments(args) {
  const options = {
    iso: null,
    candidateDirectory: null,
    outputDirectory: null,
    cpus: 4,
    memoryMiB: 4096,
    timeoutSeconds: 900,
    help: false,
  };
  const values = new Map([
    ["--iso", "iso"],
    ["--candidate-dir", "candidateDirectory"],
    ["--output-dir", "outputDirectory"],
    ["--cpus", "cpus"],
    ["--memory-mib", "memoryMiB"],
    ["--timeout-seconds", "timeoutSeconds"],
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") {
      if (seen.has(argument)) fail("--help may be supplied only once");
      seen.add(argument);
      options.help = true;
      continue;
    }
    const property = values.get(argument);
    if (!property || seen.has(argument) || args[index + 1] === undefined) {
      fail(`invalid or repeated argument: ${argument ?? ""}`);
    }
    seen.add(argument);
    options[property] = args[index + 1];
    index += 1;
  }
  if (options.help) return Object.freeze(options);
  if (!options.iso || !options.candidateDirectory || !options.outputDirectory) {
    fail("--iso, --candidate-dir, and --output-dir are required");
  }
  options.cpus = integer(String(options.cpus), "--cpus", 4, 64);
  options.memoryMiB = integer(String(options.memoryMiB), "--memory-mib", 4096, 32_768);
  options.timeoutSeconds = integer(String(options.timeoutSeconds),
    "--timeout-seconds", 300, 3600);
  for (const property of ["iso", "candidateDirectory", "outputDirectory"]) {
    options[property] = path.resolve(options[property]);
    if (options[property].includes(",")) fail(`${property} path must not contain a comma`);
  }
  return Object.freeze(options);
}

function requireRegularFile(file, label, maximumBytes = Number.MAX_SAFE_INTEGER) {
  let status;
  try {
    status = lstatSync(file);
  } catch {
    fail(`${label} is missing: ${file}`);
  }
  if (!status.isFile() || status.size <= 0 || status.size > maximumBytes) {
    fail(`${label} must be a bounded regular file: ${file}`);
  }
  return status;
}

function validateCandidateDirectory(directory) {
  let status;
  try {
    status = lstatSync(directory);
  } catch {
    fail(`candidate directory is missing: ${directory}`);
  }
  if (!status.isDirectory()) fail("candidate path must be a real directory");
  const entries = readdirSync(directory).sort();
  if (JSON.stringify(entries) !== JSON.stringify(REQUIRED_CANDIDATE_FILES)) {
    fail("candidate directory does not contain the exact acceptance artifact file set");
  }
  let total = 0;
  for (const name of entries) {
    total += requireRegularFile(path.join(directory, name), `candidate file ${name}`,
      512 * 1024 * 1024).size;
  }
  if (total > 768 * 1024 * 1024) fail("candidate files exceed the acceptance size limit");
}

function runChecked(program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    cwd: options.cwd,
  });
  if (result.error) fail(`cannot run ${program}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = options.capture ? `: ${(result.stderr || result.stdout).trim()}` : "";
    fail(`${program} exited with status ${result.status}${detail}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

async function sha256(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const input = createReadStream(file);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", resolve);
  });
  return hash.digest("hex");
}

function canUseKvm() {
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function buildQemuArguments({
  iso,
  candidateIso,
  resultsDisk,
  kernel,
  initrd,
  cpus,
  memoryMiB,
  acceleration,
}) {
  if (!new Set(["kvm", "tcg"]).has(acceleration)) fail("invalid QEMU acceleration");
  return Object.freeze([
    "-name", "fault-affinity-live-acceptance",
    "-machine", `q35,accel=${acceleration}`,
    "-cpu", acceleration === "kvm" ? "host" : "max",
    "-smp", String(cpus),
    "-m", String(memoryMiB),
    "-kernel", kernel,
    "-initrd", initrd,
    "-append", "boot=casper console=ttyS0,115200n8 systemd.unit=multi-user.target noprompt noeject ---",
    "-drive", `file=${iso},media=cdrom,readonly=on,format=raw`,
    "-drive", `file=${candidateIso},media=cdrom,readonly=on,format=raw`,
    "-drive", `file=${resultsDisk},if=virtio,format=raw`,
    "-display", "none",
    "-monitor", "none",
    "-serial", "stdio",
    "-nic", "user,model=virtio-net-pci",
    "-no-reboot",
  ]);
}

export function buildQemuLaunch(qemuArguments) {
  if (!Array.isArray(qemuArguments) ||
    qemuArguments.some((argument) => typeof argument !== "string")) {
    fail("QEMU arguments must be an array of strings");
  }
  return Object.freeze({
    program: "prlimit",
    arguments: Object.freeze([
      "--memlock=0:0",
      "--",
      "qemu-system-x86_64",
      ...qemuArguments,
    ]),
  });
}

export function buildGuestStartCommand() {
  return "set -e; " +
    "trap 's=$?; echo FAULT_AFFINITY_VM_STATUS=$s; sudo /usr/sbin/poweroff' EXIT; " +
    "sudo mkdir -p /mnt/fault-affinity-candidate; " +
    "sudo mount -o ro /dev/disk/by-label/FA_CANDIDATE /mnt/fault-affinity-candidate; " +
    "/bin/sh /mnt/fault-affinity-candidate/acceptance-vm.sh " +
    "/mnt/fault-affinity-candidate\n";
}

function runVirtualMachine(program, args, logFile, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logFile, { flags: "wx", mode: 0o600 });
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
    let tail = "";
    let loginSent = false;
    let commandSent = false;
    let timedOut = false;
    let guestStatus = null;
    let releaseVersion = null;
    let sourceCommit = null;
    let accepted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutSeconds * 1000);

    const consume = (chunk) => {
      log.write(chunk);
      tail = (tail + chunk.toString("utf8")).slice(-128 * 1024);
      if (!loginSent && tail.includes("ubuntu login:")) {
        loginSent = true;
        process.stdout.write("Live login reached; entering the stock ubuntu user.\n");
        child.stdin.write("ubuntu\n");
      }
      if (loginSent && !commandSent && tail.includes("ubuntu@ubuntu:~$")) {
        commandSent = true;
        process.stdout.write("Live shell reached; starting harmless candidate acceptance.\n");
        child.stdin.write(buildGuestStartCommand());
      }
      const statusMatch = tail.match(/FAULT_AFFINITY_VM_STATUS=([0-9]+)/g)?.at(-1);
      if (statusMatch) guestStatus = Number(statusMatch.split("=")[1]);
      const versionMatch = tail.match(/FAULT_AFFINITY_VM_RELEASE=([^\r\n]+)/g)?.at(-1);
      if (versionMatch) releaseVersion = versionMatch.split("=")[1].trim();
      const commitMatch = tail.match(/FAULT_AFFINITY_VM_COMMIT=([0-9a-f]{40})/g)?.at(-1);
      if (commitMatch) sourceCommit = commitMatch.split("=")[1];
      if (tail.includes("FAULT_AFFINITY_VM_ACCEPTANCE_OK")) accepted = true;
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", (error) => {
      clearTimeout(timer);
      log.end();
      reject(new LiveIsoAcceptanceError(`cannot start QEMU: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      log.end();
      if (timedOut) {
        reject(new LiveIsoAcceptanceError(`QEMU acceptance exceeded ${timeoutSeconds} seconds`));
      } else if (code !== 0 || signal !== null) {
        reject(new LiveIsoAcceptanceError(`QEMU exited code=${code} signal=${signal}`));
      } else if (!accepted || guestStatus !== 0 || !VERSION_RE.test(releaseVersion ?? "") ||
        !COMMIT_RE.test(sourceCommit ?? "")) {
        reject(new LiveIsoAcceptanceError("guest did not publish a complete successful acceptance"));
      } else {
        resolve(Object.freeze({ guestStatus, releaseVersion, sourceCommit }));
      }
    });
  });
}

function readArchiveChecksum(candidateDirectory) {
  const lines = readFileSync(path.join(candidateDirectory, "SHA256SUMS"), "utf8").trim().split("\n");
  const matches = lines.filter((line) =>
    line.endsWith("  fault-affinity-live-linux-x64.tar.gz"));
  if (matches.length !== 1 || !ISO_HASH_RE.test(matches[0].slice(0, 64))) {
    fail("SHA256SUMS does not contain one canonical Linux archive checksum");
  }
  return matches[0].slice(0, 64);
}

async function main() {
  const options = parseLiveIsoAcceptanceArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("live ISO acceptance requires an x86-64 Linux host");
  }
  const isoStatus = requireRegularFile(options.iso, "Ubuntu live ISO", 8 * 1024 * 1024 * 1024);
  if (path.basename(options.iso) !== lock.filename || isoStatus.size !== lock.bytes) {
    fail(`ISO must be the pinned ${lock.filename}`);
  }
  validateCandidateDirectory(options.candidateDirectory);
  runChecked("sha256sum", ["--check", "ACCEPTANCE-SUPPORT-SHA256SUMS"], {
    cwd: options.candidateDirectory,
  });
  runChecked("sha256sum", ["--check", "SHA256SUMS"], { cwd: options.candidateDirectory });
  const archiveSha256 = readArchiveChecksum(options.candidateDirectory);
  const [supportManifestSha256, acceptanceHelperSha256, extractorSha256,
    hostHarnessSha256] = await Promise.all([
    sha256(path.join(options.candidateDirectory, "ACCEPTANCE-SUPPORT-SHA256SUMS")),
    sha256(path.join(options.candidateDirectory, "acceptance-vm.sh")),
    sha256(path.join(options.candidateDirectory, "safe-extract.py")),
    sha256(fileURLToPath(import.meta.url)),
  ]);

  process.stdout.write(`Hashing pinned ${lock.filename}...\n`);
  const isoSha256 = await sha256(options.iso);
  if (isoSha256 !== lock.sha256) fail("Ubuntu live ISO SHA-256 does not match the reviewed lock");

  try {
    mkdirSync(options.outputDirectory, { mode: 0o700 });
  } catch (error) {
    fail(`output directory must be a new creatable path: ${error.message}`);
  }

  const scratch = mkdtempSync(path.join(tmpdir(), "fault-affinity-live-iso-"));
  const startedAt = new Date().toISOString();
  const record = {
    schemaVersion: 1,
    status: "running",
    startedAt,
    iso: {
      filename: lock.filename,
      bytes: lock.bytes,
      sha256: isoSha256,
      volumeId: lock.volumeId,
    },
    candidate: {
      archiveSha256,
      supportManifestSha256,
      acceptanceHelperSha256,
      extractorSha256,
    },
    hostHarness: { sha256: hostHarnessSha256 },
    vm: {
      cpus: options.cpus,
      memoryMiB: options.memoryMiB,
      timeoutSeconds: options.timeoutSeconds,
      acceleration: canUseKvm() ? "kvm" : "tcg",
    },
    serialLog: "serial.log",
  };
  try {
    const qemuVersion = runChecked("qemu-system-x86_64", ["--version"], { capture: true })
      .split("\n")[0];
    const prlimitVersion = runChecked("prlimit", ["--version"], { capture: true })
      .split("\n")[0];
    record.vm.qemuVersion = qemuVersion;
    record.vm.launcher = "prlimit";
    record.vm.qemuProcessMemlockBytes = 0;
    record.vm.prlimitVersion = prlimitVersion;
    const kernel = path.join(scratch, "vmlinuz");
    const initrd = path.join(scratch, "initrd");
    const candidateIso = path.join(scratch, "candidate.iso");
    const resultsDisk = path.join(scratch, "results.ext4");

    process.stdout.write("Extracting the live kernel and initrd from the verified ISO.\n");
    runChecked("xorriso", ["-osirrox", "on", "-indev", options.iso,
      "-extract", "/casper/vmlinuz", kernel,
      "-extract", "/casper/initrd", initrd]);
    process.stdout.write("Building read-only candidate media and temporary ext4 result media.\n");
    runChecked("xorriso", ["-as", "mkisofs", "-quiet", "-r", "-J", "-iso-level", "3",
      "-V", "FA_CANDIDATE", "-o", candidateIso, options.candidateDirectory]);
    const descriptor = openSync(resultsDisk, "wx", 0o600);
    try {
      ftruncateSync(descriptor, 256 * 1024 * 1024);
    } finally {
      closeSync(descriptor);
    }
    runChecked("mkfs.ext4", ["-q", "-F", "-L", "FA_RESULTS", resultsDisk]);

    const qemuArguments = buildQemuArguments({
      iso: options.iso,
      candidateIso,
      resultsDisk,
      kernel,
      initrd,
      cpus: options.cpus,
      memoryMiB: options.memoryMiB,
      acceleration: record.vm.acceleration,
    });
    const qemuLaunch = buildQemuLaunch(qemuArguments);
    process.stdout.write(`Booting the unmodified live filesystem with ${record.vm.acceleration}.\n`);
    const guest = await runVirtualMachine(qemuLaunch.program, qemuLaunch.arguments,
      path.join(options.outputDirectory, "serial.log"), options.timeoutSeconds);
    record.status = "passed";
    record.completedAt = new Date().toISOString();
    record.candidate.releaseVersion = guest.releaseVersion;
    record.candidate.sourceCommit = guest.sourceCommit;
    record.checks = [
      "pinned ISO identity",
      "stock live-image dependencies",
      "read-only candidate support checksums",
      "final release checksums",
      "structured safe extraction",
      "bundled runtime versions",
      "launcher help",
      "result preparer help",
      "ext4-backed dry run",
      "dry run created no result content",
    ];
    writeFileSync(path.join(options.outputDirectory, "acceptance.json"),
      `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`Live ISO acceptance passed: ${options.outputDirectory}\n`);
  } catch (error) {
    record.status = "failed";
    record.completedAt = new Date().toISOString();
    record.error = error.message;
    writeFileSync(path.join(options.outputDirectory, "acceptance.json"),
      `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`live-iso-acceptance: ${error.message}\n`);
    process.exitCode = 1;
  }
}
