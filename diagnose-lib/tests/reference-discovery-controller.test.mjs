import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { treeIdentity } from "../../src/reference-kit/controller.mjs";
import {
  REFERENCE_DISCOVERY_CONDITION_ID,
  ReferenceDiscoveryControllerError,
  collectReferenceDiscoveryHost,
  collectReferenceDiscoveryIdentity,
  collectReferenceDiscoveryResources,
  collectReferenceDiscoveryStorage,
  collectReferenceDiscoveryTopology,
  planReferenceDiscovery,
  referenceDiscoveryEnvironmentBindingKey,
  renderReferenceDiscoveryDryRun,
  resolveReferenceDiscoveryWorkloads,
} from "../../src/reference-kit/discovery-controller.mjs";
import {
  REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES,
  REFERENCE_DISCOVERY_MINIMUM_RESULTS_BYTES,
} from "../../src/reference-kit/discovery-protocol.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function directory(prefix) {
  const result = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(result);
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryReleaseDeclaration() {
  return {
    capabilities: { referenceDiscovery: 1, referenceConfirmation: 1 },
    profiles: {
      referenceDiscovery: {
        id: "reference-loaded-discovery",
        version: 1,
        protocol: "reference-loaded-discovery-v1",
        pgliteVersion: "0.5.4",
      },
      referenceConfirmation: {
        id: "load-aba-discovered-confirmation",
        version: 1,
        pgliteVersion: "0.5.4",
      },
    },
  };
}

function topologyFiles({
  online = "0-7",
  cgroup = "0-7",
  performance = "0-3",
  efficient = "4-7",
  missingPerformance = false,
  missingEfficient = false,
  topology = new Map([
    [0, [0, 0]], [1, [0, 0]], [2, [0, 1]], [3, [0, 1]],
    [4, [0, 2]], [5, [0, 3]], [6, [0, 4]], [7, [0, 5]],
  ]),
} = {}) {
  const files = new Map([
    ["/fixture/cpu/online", `${online}\n`],
    ["/sys/fs/cgroup/cpuset.cpus.effective", cgroup === null ? null : `${cgroup}\n`],
    ["/fixture/devices/cpu_core/cpus", missingPerformance ? null : `${performance}\n`],
    ["/fixture/devices/cpu_atom/cpus", missingEfficient ? null : `${efficient}\n`],
  ]);
  for (const [cpu, [packageId, coreId]] of topology) {
    files.set(`/fixture/cpu/cpu${cpu}/topology/physical_package_id`, `${packageId}\n`);
    files.set(`/fixture/cpu/cpu${cpu}/topology/core_id`, `${coreId}\n`);
  }
  return (filename, { optional = false } = {}) => {
    if (files.has(filename) && files.get(filename) !== null) return files.get(filename);
    if (optional) return null;
    throw new Error(`unexpected fixture read: ${filename}`);
  };
}

function collectTopology(options = {}, processAllowedCpuSpec = "0-7") {
  return collectReferenceDiscoveryTopology({
    readSystemFile: topologyFiles(options),
    processAllowedCpuSpec,
    cpuRoot: "/fixture/cpu",
    deviceRoot: "/fixture/devices",
  });
}

function fixtureHost(topology) {
  return {
    bootIdSha256: "1".repeat(64),
    machineSha256: "2".repeat(64),
    kernelRelease: "6.17.0-fixture",
    osReleaseSha256: "3".repeat(64),
    powerPolicySha256: null,
    microcode: topology.usableCpus.map((cpu) => ({ cpu, value: "0x123" })),
  };
}

function fixtureResources(effective = 4n * 1024n ** 3n) {
  return {
    memAvailableBytes: effective.toString(),
    cgroupStatus: "resolved-unlimited",
    cgroupCurrentBytes: null,
    cgroupMaxBytes: null,
    effectiveHeadroomBytes: effective.toString(),
    minimumHeadroomBytes: REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES.toString(),
    meetsMinimum: effective >= REFERENCE_DISCOVERY_MINIMUM_HEADROOM_BYTES,
  };
}

function fixtureIdentity(root, releaseFile = path.join(root, "RELEASE.json")) {
  return {
    kitRoot: root,
    releaseFile: { path: releaseFile, sha256: "4".repeat(64), bytes: "10", mode: 0o644 },
    appTreeSha256: "5".repeat(64),
    pgliteTreeSha256: "6".repeat(64),
    controllerRuntime: {
      path: path.join(root, "runtime/controller/bin/node"),
      sha256: "7".repeat(64), bytes: "20", mode: 0o755, version: "v24.21.0",
    },
    targetRuntime: {
      path: path.join(root, "runtime/reference/bin/node"),
      sha256: "8".repeat(64), bytes: "21", mode: 0o755, version: "v25.2.1",
    },
    measuredWorkloadDigest: "9".repeat(64),
    conditionWorkloadDigest: "a".repeat(64),
    taskset: { path: "/usr/bin/taskset", sha256: "b".repeat(64), bytes: "22", mode: 0o755 },
    yes: { path: "/usr/bin/yes", sha256: "c".repeat(64), bytes: "23", mode: 0o755 },
  };
}

function storageObservation(overrides = {}) {
  return {
    availableBytes: (8n * 1024n ** 3n).toString(),
    mountPoint: "/media/ubuntu/RESULTS",
    filesystemType: "ext4",
    source: "/dev/sdb1",
    classification: "likely-persistent",
    warning: null,
    ...overrides,
  };
}

test("topology collection identifies complete hybrid classes and SMT physical cores", () => {
  const topology = collectTopology();
  assert.deepEqual(topology.onlineCpus, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(topology.usableCpus, topology.onlineCpus);
  assert.deepEqual(topology.classes, {
    source: "sysfs-hybrid",
    performanceCpus: [0, 1, 2, 3],
    efficientCpus: [4, 5, 6, 7],
  });
  assert.deepEqual(topology.cores.slice(0, 2).map(({ cpus }) => cpus), [[0, 1], [2, 3]]);
});

test("usable topology intersects online, process-affinity, and cgroup CPU sets", () => {
  const topology = collectTopology({ online: "0-6", cgroup: "2-7" }, "1-7");
  assert.deepEqual(topology.onlineCpus, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(topology.allowedCpus, [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(topology.usableCpus, [2, 3, 4, 5, 6]);
  assert.deepEqual(topology.classes, {
    source: "sysfs-hybrid",
    performanceCpus: [2, 3],
    efficientCpus: [4, 5, 6],
  });
});

test("missing and empty class masks remain unavailable or partial observations", () => {
  const unavailable = collectTopology({ missingPerformance: true, missingEfficient: true });
  assert.deepEqual(unavailable.classes, {
    source: "unavailable", performanceCpus: [], efficientCpus: [],
  });

  const partial = collectTopology({ performance: "", efficient: "4-7" });
  assert.deepEqual(partial.classes, {
    source: "partial", performanceCpus: [], efficientCpus: [4, 5, 6, 7],
  });
  assert.throws(() => collectTopology({ performance: "0-4", efficient: "4-7" }),
    /lists overlap/);
});

test("missing or negative physical topology identifiers fail closed", () => {
  const missing = new Map([[0, [0, 0]], [1, [0, 0]], [2, [0, 1]], [3, [0, 1]],
    [4, [0, 2]], [5, [0, 3]], [6, [0, 4]]]);
  assert.throws(() => collectTopology({ topology: missing }), /CPU 7 physical package/);
  const negative = topologyFiles();
  assert.throws(() => collectReferenceDiscoveryTopology({
    readSystemFile: (filename, options) => filename.endsWith("cpu4/topology/core_id")
      ? "-1\n" : negative(filename, options),
    processAllowedCpuSpec: "0-7",
    cpuRoot: "/fixture/cpu",
    deviceRoot: "/fixture/devices",
  }), /unavailable or noncanonical/);
});

test("host observation hashes machine identifiers and records per-CPU microcode", () => {
  const topology = collectTopology();
  const files = new Map([
    ["/proc/sys/kernel/random/boot_id", "fixture-boot-id\n"],
    ["/etc/machine-id", "fixture-machine-id\n"],
    ["/etc/os-release", "ID=ubuntu\nVERSION_ID=26.04\n"],
    ["/proc/cpuinfo", topology.usableCpus.map((cpu) =>
      `processor : ${cpu}\nmicrocode : 0x${10 + cpu}\n`).join("\n")],
    ["/sys/devices/system/cpu/intel_pstate/no_turbo", "0\n"],
  ]);
  const result = collectReferenceDiscoveryHost(topology, {
    readSystemFile: (filename, { optional = false } = {}) => {
      if (files.has(filename)) return files.get(filename);
      if (optional) return null;
      throw new Error(`unexpected fixture read: ${filename}`);
    },
    kernelRelease: () => "6.17.0-fixture",
  });
  assert.equal(result.bootIdSha256, sha256("fixture-boot-id"));
  assert.equal(result.machineSha256, sha256("fixture-machine-id"));
  assert.equal(result.kernelRelease, "6.17.0-fixture");
  assert.deepEqual(result.microcode.map(({ cpu, value }) => [cpu, value]),
    topology.usableCpus.map((cpu) => [cpu, `0x${10 + cpu}`]));
  assert.match(result.powerPolicySha256, /^[0-9a-f]{64}$/);
});

test("resource observation honors cgroup headroom and unlimited limits", () => {
  const collect = (values) => collectReferenceDiscoveryResources({
    readSystemFile: (filename, { optional = false } = {}) => {
      if (values.has(filename)) return values.get(filename);
      if (optional) return null;
      throw new Error(`unexpected fixture read: ${filename}`);
    },
  });
  const limited = collect(new Map([
    ["/proc/meminfo", "MemTotal: 8388608 kB\nMemAvailable: 4194304 kB\n"],
    ["/proc/self/cgroup", "0::/user.slice/test.scope\n"],
    ["/proc/self/mountinfo", "36 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"],
    ["/sys/fs/cgroup/user.slice/test.scope/memory.max", "max\n"],
    ["/sys/fs/cgroup/user.slice/memory.current", "1073741824\n"],
    ["/sys/fs/cgroup/user.slice/memory.max", "2684354560\n"],
  ]));
  assert.equal(limited.cgroupStatus, "resolved-limited");
  assert.equal(limited.cgroupCurrentBytes, "1073741824");
  assert.equal(limited.cgroupMaxBytes, "2684354560");
  assert.equal(limited.effectiveHeadroomBytes, "1610612736");
  assert.equal(limited.meetsMinimum, false);

  const unlimited = collect(new Map([
    ["/proc/meminfo", "MemAvailable: 4194304 kB\n"],
    ["/proc/self/cgroup", "0::/user.slice/test.scope\n"],
    ["/proc/self/mountinfo", "36 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"],
    ["/sys/fs/cgroup/user.slice/test.scope/memory.max", "max\n"],
    ["/sys/fs/cgroup/user.slice/memory.max", "max\n"],
  ]));
  assert.equal(unlimited.effectiveHeadroomBytes, String(4 * 1024 ** 3));
  assert.equal(unlimited.cgroupStatus, "resolved-unlimited");
  assert.equal(unlimited.cgroupMaxBytes, null);
  assert.equal(unlimited.meetsMinimum, true);

  const unavailable = collect(new Map([
    ["/proc/meminfo", "MemAvailable: 4194304 kB\n"],
  ]));
  assert.equal(unavailable.cgroupStatus, "unavailable");
  assert.equal(unavailable.effectiveHeadroomBytes, "0");
  assert.equal(unavailable.meetsMinimum, false);
});

test("resource observation prefers a full cgroup hierarchy and rejects delegated-only views", () => {
  const collect = (values) => collectReferenceDiscoveryResources({
    readSystemFile: (filename, { optional = false } = {}) => {
      if (values.has(filename)) return values.get(filename);
      if (optional) return null;
      throw new Error(`unexpected fixture read: ${filename}`);
    },
  });
  const common = [
    ["/proc/meminfo", "MemAvailable: 4194304 kB\n"],
    ["/proc/self/cgroup", "0::/user.slice/app.scope/work\n"],
  ];
  const both = collect(new Map([
    ...common,
    ["/proc/self/mountinfo", [
      "36 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw",
      "37 25 0:32 /user.slice/app.scope /mnt/delegated rw - cgroup2 cgroup rw",
      "",
    ].join("\n")],
    ["/sys/fs/cgroup/user.slice/app.scope/work/memory.max", "max\n"],
    ["/sys/fs/cgroup/user.slice/app.scope/memory.max", "max\n"],
    ["/sys/fs/cgroup/user.slice/memory.max", "1073741824\n"],
    ["/sys/fs/cgroup/user.slice/memory.current", "268435456\n"],
  ]));
  assert.equal(both.cgroupStatus, "resolved-limited");
  assert.equal(both.effectiveHeadroomBytes, "805306368");
  assert.equal(both.meetsMinimum, false);

  const delegatedOnly = collect(new Map([
    ...common,
    ["/proc/self/mountinfo",
      "37 25 0:32 /user.slice/app.scope /mnt/delegated rw - cgroup2 cgroup rw\n"],
  ]));
  assert.equal(delegatedOnly.cgroupStatus, "unavailable");
  assert.equal(delegatedOnly.effectiveHeadroomBytes, "0");
  assert.equal(delegatedOnly.meetsMinimum, false);

  const namespaceRoot = collect(new Map([
    ["/proc/meminfo", "MemAvailable: 4194304 kB\n"],
    ["/proc/self/cgroup", "0::/\n"],
    ["/proc/self/mountinfo", "36 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"],
    ["/sys/fs/cgroup/memory.max", "2147483648\n"],
    ["/sys/fs/cgroup/memory.current", "0\n"],
  ]));
  assert.equal(namespaceRoot.cgroupStatus, "unavailable");
  assert.equal(namespaceRoot.meetsMinimum, false);

  const namespaceChild = collect(new Map([
    ["/proc/meminfo", "MemAvailable: 4194304 kB\n"],
    ["/proc/self/cgroup", "0::/work\n"],
    ["/proc/self/mountinfo", "36 25 0:32 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n"],
    ["/sys/fs/cgroup/work/memory.max", "max\n"],
    ["/sys/fs/cgroup/memory.max", "max\n"],
  ]));
  assert.equal(namespaceChild.cgroupStatus, "unavailable");
  assert.equal(namespaceChild.meetsMinimum, false);
});

function executableRecord(filename, version) {
  const bytes = readFileSync(filename);
  return {
    path: filename,
    sha256: sha256(bytes),
    bytes: String(bytes.length),
    mode: statSync(filename).mode & 0o777,
    ...(version === undefined ? {} : { version }),
  };
}

test("discovery workloads keep distinct frozen identities and deterministic environment bindings", () => {
  const root = directory("reference-discovery-workloads-");
  const app = path.join(root, "app");
  const runtime = path.join(root, "runtime");
  const pglite = path.join(root, "pglite");
  mkdirSync(app);
  mkdirSync(runtime);
  mkdirSync(pglite);
  const targetNode = path.join(runtime, "target-node");
  const controllerNode = path.join(runtime, "controller-node");
  const child = path.join(app, "child.mjs");
  for (const filename of [targetNode, controllerNode]) {
    writeFileSync(filename, "#!/bin/sh\nexit 0\n");
    chmodSync(filename, 0o755);
  }
  writeFileSync(child, "process.exit(0);\n");
  writeFileSync(path.join(pglite, "package.json"), "{\"version\":\"0.5.4\"}\n");
  const layout = {
    root, app, child, pglite, targetNode, controllerNode,
    taskset: "/usr/bin/taskset", yes: "/usr/bin/yes",
  };
  const environment = { HOME: root, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  const key = Buffer.alloc(32, 0x12);
  const first = resolveReferenceDiscoveryWorkloads(layout, environment, key);
  const again = resolveReferenceDiscoveryWorkloads(layout, environment, Buffer.from(key));
  const changed = resolveReferenceDiscoveryWorkloads(layout,
    { ...environment, LANG: "C" }, Buffer.from(key));
  assert.equal(first.measured.id, "reference-pglite-target-discovery");
  assert.equal(first.measured.command.executable.path, targetNode);
  assert.equal(first.measured.attempt.timeoutMs, 120_000);
  assert.equal(first.measured.capabilities.isolated, true);
  assert.equal(first.auxiliary.id, REFERENCE_DISCOVERY_CONDITION_ID);
  assert.equal(first.auxiliary.command.executable.path, "/usr/bin/yes");
  assert.equal(first.auxiliary.attempt.timeoutMs, 60 * 60 * 1_000);
  assert.equal(first.measured.digest, again.measured.digest);
  assert.notEqual(first.measured.digest, changed.measured.digest);

  const releaseFile = { path: path.join(root, "RELEASE.json"), sha256: "d".repeat(64),
    bytes: "10", mode: 0o644 };
  const identity = collectReferenceDiscoveryIdentity(layout, {
    release: discoveryReleaseDeclaration(),
    app: treeIdentity(app),
    pglite: treeIdentity(pglite),
    child: { path: child, sha256: sha256(readFileSync(child)) },
    executables: {
      controller: executableRecord(controllerNode, "v24.21.0"),
      target: executableRecord(targetNode, "v25.2.1"),
      taskset: executableRecord("/usr/bin/taskset"),
      yes: executableRecord("/usr/bin/yes"),
    },
  }, first, releaseFile);
  assert.equal(identity.releaseFile, releaseFile);
  assert.equal(identity.measuredWorkloadDigest, first.measured.digest);
  assert.equal(identity.conditionWorkloadDigest, first.auxiliary.digest);

  writeFileSync(targetNode, "#!/bin/sh\nexit 7\n");
  assert.throws(() => collectReferenceDiscoveryIdentity(layout, {
    release: discoveryReleaseDeclaration(),
    app: treeIdentity(app), pglite: treeIdentity(pglite),
    child: { path: child, sha256: sha256(readFileSync(child)) },
    executables: {
      controller: executableRecord(controllerNode, "v24.21.0"),
      target: first.measured.command.executable,
      taskset: executableRecord("/usr/bin/taskset"),
      yes: executableRecord("/usr/bin/yes"),
    },
  }, first, releaseFile), /executable identity changed/);
  writeFileSync(targetNode, "#!/bin/sh\nexit 0\n");
  chmodSync(targetNode, 0o755);
  writeFileSync(path.join(app, "changed-after-verification.txt"), "changed\n");
  assert.throws(() => collectReferenceDiscoveryIdentity(layout, {
    release: discoveryReleaseDeclaration(),
    app: { sha256: identity.appTreeSha256 }, pglite: treeIdentity(pglite),
    child: { path: child, sha256: sha256(readFileSync(child)) },
    executables: {
      controller: executableRecord(controllerNode, "v24.21.0"),
      target: executableRecord(targetNode, "v25.2.1"),
      taskset: executableRecord("/usr/bin/taskset"),
      yes: executableRecord("/usr/bin/yes"),
    },
  }, resolveReferenceDiscoveryWorkloads(layout, environment, Buffer.from(key)), releaseFile),
  /application tree changed/);

  assert.throws(() => collectReferenceDiscoveryIdentity(layout, {
    release: { ...discoveryReleaseDeclaration(), capabilities: {} },
    app: treeIdentity(app), pglite: treeIdentity(pglite),
    child: { path: child, sha256: sha256(readFileSync(child)) },
    executables: {
      controller: executableRecord(controllerNode, "v24.21.0"),
      target: executableRecord(targetNode, "v25.2.1"),
      taskset: executableRecord("/usr/bin/taskset"),
      yes: executableRecord("/usr/bin/yes"),
    },
  }, resolveReferenceDiscoveryWorkloads(layout, environment, Buffer.from(key)), releaseFile),
  /profiles or capability are invalid/);
});

test("environment binding key is stable for one verified kit and boot context", () => {
  const identity = { root: "/opt/fault-affinity", releaseFile: { sha256: "1".repeat(64) } };
  const host = { bootIdSha256: "2".repeat(64), machineSha256: "3".repeat(64) };
  const first = referenceDiscoveryEnvironmentBindingKey(identity, host);
  const second = referenceDiscoveryEnvironmentBindingKey(identity, host);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, referenceDiscoveryEnvironmentBindingKey(identity,
    { ...host, bootIdSha256: "4".repeat(64) }));
});

test("storage observation accepts Windows-readable export media but refuses it for active state", () => {
  const root = directory("reference-discovery-storage-");
  const output = "reference-discovery-20260913T120000Z-test";
  const ext4 = collectReferenceDiscoveryStorage(root, output, {
    inspectStorage: () => storageObservation(),
  });
  assert.equal(ext4.supportsActiveState, true);
  assert.equal(existsSync(ext4.collectionDir), false);
  assert.equal(ext4.minimumRequiredBytes, REFERENCE_DISCOVERY_MINIMUM_RESULTS_BYTES.toString());

  const fat = collectReferenceDiscoveryStorage(root,
    "reference-discovery-20260913T120001Z-test", {
      inspectStorage: () => storageObservation({ filesystemType: "vfat" }),
    });
  assert.equal(fat.classification, "likely-persistent");
  assert.equal(fat.supportsActiveState, false);

  const unknown = collectReferenceDiscoveryStorage(root,
    "reference-discovery-20260913T120003Z-test", {
      inspectStorage: () => storageObservation({
        mountPoint: "/home/ubuntu", filesystemType: null, source: null,
        classification: "unknown",
        warning: "WARNING: results storage persistence could not be established. Confirm this path is on mounted persistent media before running.",
      }),
    });
  assert.equal(unknown.supportsActiveState, false);

  const loopBacked = collectReferenceDiscoveryStorage(root,
    "reference-discovery-20260913T120004Z-test", {
      inspectStorage: () => storageObservation({ source: "/dev/loop7" }),
    });
  assert.equal(loopBacked.classification, "unknown");
  assert.match(loopBacked.warning, /^WARNING:/);

  const volatile = collectReferenceDiscoveryStorage(root,
    "reference-discovery-20260913T120002Z-test", {
      inspectStorage: () => storageObservation({
        mountPoint: "/", filesystemType: "overlay", source: "overlay",
        classification: "volatile-or-live-layer",
        warning: "WARNING: results appear to be on volatile live-session storage and may disappear at shutdown. Choose mounted persistent media.",
      }),
    });
  assert.equal(volatile.classification, "volatile-or-live-layer");
  assert.throws(() => collectReferenceDiscoveryStorage(root, "../escape", {
    inspectStorage: () => storageObservation(),
  }), ReferenceDiscoveryControllerError);
  assert.throws(() => collectReferenceDiscoveryStorage("relative/results", output, {
    inspectStorage: () => storageObservation(),
  }), /bounded absolute path/);
});

test("dry planning creates nothing, zeros its binding key, and prints live command only when ready", () => {
  const kitRoot = directory("reference-discovery-kit-");
  const resultsRoot = directory("reference-discovery-results-");
  const releaseFile = path.join(kitRoot, "RELEASE.json");
  writeFileSync(releaseFile, "{\"fixture\":true}\n");
  const topology = collectTopology();
  const key = Buffer.alloc(32, 0x23);
  const outputName = "reference-discovery-20260913T130000Z-test";
  const dependencies = {
    host: { platform: "linux", architecture: "x64", uid: 1000 },
    environment: { HOME: "/home/fixture", LANG: "C.UTF-8" },
    collectTopology: () => topology,
    collectHost: () => fixtureHost(topology),
    resolveLayout: () => ({ root: kitRoot, releaseFile }),
    collectKitIdentity: () => ({ fixture: true }),
    environmentBindingKey: () => key,
    resolveWorkloads: () => ({
      measured: { digest: "9".repeat(64) },
      auxiliary: { digest: "a".repeat(64) },
    }),
    collectIdentity: () => fixtureIdentity(kitRoot, releaseFile),
    collectResources: () => fixtureResources(),
    inspectStorage: () => storageObservation(),
  };
  const plan = planReferenceDiscovery({ resultsRoot, outputName }, dependencies);
  assert.equal(existsSync(path.join(resultsRoot, outputName)), false);
  assert.deepEqual(key, Buffer.alloc(32));
  const rendered = renderReferenceDiscoveryDryRun(plan);
  assert.match(rendered, /Nothing was executed and no result directory was created/);
  assert.match(rendered, /To run this exact selection/);
  assert.ok(rendered.includes(path.join(kitRoot, "bin/discover-reference")));
  assert.match(rendered, /--expect-preview' '[0-9a-f]{64}/);
  assert.match(rendered, /Measured concurrency: 1 PGlite process at a time/);

  const lowMemory = planReferenceDiscovery({
    resultsRoot,
    outputName: "reference-discovery-20260913T130001Z-test",
  }, { ...dependencies,
    environmentBindingKey: () => Buffer.alloc(32, 0x24),
    collectResources: () => fixtureResources(1024n ** 3n),
  });
  assert.doesNotMatch(renderReferenceDiscoveryDryRun(lowMemory), /To run this exact selection/);
});

test("planning detects a release declaration changed during identity collection", () => {
  const kitRoot = directory("reference-discovery-race-");
  const resultsRoot = directory("reference-discovery-race-results-");
  const releaseFile = path.join(kitRoot, "RELEASE.json");
  writeFileSync(releaseFile, "before\n");
  const topology = collectTopology();
  assert.throws(() => planReferenceDiscovery({
    resultsRoot,
    outputName: "reference-discovery-20260913T140000Z-test",
  }, {
    host: { platform: "linux", architecture: "x64", uid: 1000 },
    environment: { HOME: "/home/fixture" },
    collectTopology: () => topology,
    collectHost: () => fixtureHost(topology),
    resolveLayout: () => ({ root: kitRoot, releaseFile }),
    collectKitIdentity: () => {
      writeFileSync(releaseFile, "after-change\n");
      return { fixture: true };
    },
  }), /release declaration changed/);
  assert.equal(existsSync(path.join(resultsRoot,
    "reference-discovery-20260913T140000Z-test")), false);
});
