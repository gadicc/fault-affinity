import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { parseCampaignPlan } from "../../src/fault-affinity/campaign-plan.mjs";
import {
  buildCampaignPlanFromTopology,
  discoverCampaignTopology,
} from "../../src/fault-affinity/campaign-topology.mjs";
import {
  DEFAULT_CAMPAIGN_RECIPE,
  listCampaignRecipes,
  resolveCampaignRecipe,
} from "../../src/fault-affinity/campaign-recipes.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixture(online = "0-7") {
  const root = mkdtempSync(path.join(tmpdir(), "campaign-topology-"));
  directories.push(root);
  const cpuRoot = path.join(root, "system", "cpu");
  const deviceRoot = path.join(root, "devices");
  mkdirSync(cpuRoot, { recursive: true });
  mkdirSync(deviceRoot, { recursive: true });
  writeFileSync(path.join(cpuRoot, "online"), `${online}\n`);
  return { root, cpuRoot, deviceRoot };
}

function writeCpu({ cpuRoot }, cpu, { packageId = 0, coreId = cpu, clusterId, l2 } = {}) {
  const topology = path.join(cpuRoot, `cpu${cpu}`, "topology");
  mkdirSync(topology, { recursive: true });
  writeFileSync(path.join(topology, "physical_package_id"), `${packageId}\n`);
  writeFileSync(path.join(topology, "core_id"), `${coreId}\n`);
  if (clusterId !== undefined) writeFileSync(path.join(topology, "cluster_id"), `${clusterId}\n`);
  if (l2 !== undefined) {
    const cache = path.join(cpuRoot, `cpu${cpu}`, "cache", "index2");
    mkdirSync(cache, { recursive: true });
    writeFileSync(path.join(cache, "shared_cpu_list"), `${l2}\n`);
  }
}

function writeClass({ deviceRoot }, name, cpus) {
  const directory = path.join(deviceRoot, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "cpus"), `${cpus}\n`);
}

test("uniform topology is partitioned into controller-safe pinned contexts", () => {
  const sysfs = fixture("0-3");
  writeCpu(sysfs, 0, { coreId: 0 });
  writeCpu(sysfs, 1, { coreId: 0 });
  writeCpu(sysfs, 2, { coreId: 1 });
  writeCpu(sysfs, 3, { coreId: 1 });

  const topology = discoverCampaignTopology({
    ...sysfs,
    allowedCpuSpec: "1-3",
  });
  assert.deepEqual(topology.usable, [1, 2, 3]);
  assert.equal(topology.classes.source, "uniform");
  assert.deepEqual(topology.groups, [{
    id: "all-cpus", kind: "uniform", cpus: [1, 2, 3],
  }]);
  assert.equal(topology.pinnedConcurrent.length, 2);
  for (const context of topology.pinnedConcurrent) {
    assert.equal(context.cpus.includes(context.controllerCpu), false);
    assert.ok(topology.usable.includes(context.controllerCpu));
  }
});

test("hybrid topology retains class and efficient-core cluster contexts", () => {
  const sysfs = fixture();
  writeClass(sysfs, "cpu_core", "0-3");
  writeClass(sysfs, "cpu_atom", "4-7");
  for (let cpu = 0; cpu < 8; cpu += 1) {
    writeCpu(sysfs, cpu, {
      coreId: cpu,
      ...(cpu >= 4 ? { clusterId: cpu < 6 ? 64 : 65 } : {}),
    });
  }
  const topology = discoverCampaignTopology({ ...sysfs, allowedCpuSpec: "0-7" });
  assert.equal(topology.classes.source, "sysfs-hybrid");
  assert.deepEqual(topology.classes.performance, [0, 1, 2, 3]);
  assert.deepEqual(topology.classes.efficient, [4, 5, 6, 7]);
  assert.deepEqual(topology.groups.map(({ kind }) => kind),
    ["pcore", "ecore", "ecluster", "ecluster"]);
  assert.deepEqual(topology.groups.slice(2).map(({ cpus }) => cpus), [[4, 5], [6, 7]]);
  assert.equal(topology.pinnedConcurrent.length, 4);
  assert.ok(topology.pinnedConcurrent.every(({ cpus, controllerCpu }) =>
    !cpus.includes(controllerCpu)));
});

test("hybrid topology does not invent an efficient cluster without cluster evidence", () => {
  const sysfs = fixture("0-3");
  writeClass(sysfs, "cpu_core", "0-1");
  writeClass(sysfs, "cpu_atom", "2-3");
  for (let cpu = 0; cpu < 4; cpu += 1) writeCpu(sysfs, cpu);

  const topology = discoverCampaignTopology({ ...sysfs, allowedCpuSpec: "0-3" });
  assert.deepEqual(topology.groups.map(({ id }) => id), ["pcores", "ecores"]);
  assert.deepEqual(topology.groups.map(({ cpus }) => cpus), [[0, 1], [2, 3]]);
});

test("hybrid class masks must exactly and unambiguously cover usable CPUs", () => {
  const partial = fixture("0-3");
  writeClass(partial, "cpu_core", "0-1");
  assert.throws(() => discoverCampaignTopology({ ...partial, allowedCpuSpec: "0-3" }),
    /do not cover every usable CPU/);

  const overlap = fixture("0-3");
  writeClass(overlap, "cpu_core", "0-2");
  writeClass(overlap, "cpu_atom", "2-3");
  assert.throws(() => discoverCampaignTopology({ ...overlap, allowedCpuSpec: "0-3" }),
    /overlap/);
});

test("quick campaign defaults cover every CPU and focus load on the highest usable CPU", () => {
  const sysfs = fixture("0-3");
  for (let cpu = 0; cpu < 4; cpu += 1) writeCpu(sysfs, cpu);
  const topology = discoverCampaignTopology({ ...sysfs, allowedCpuSpec: "0-3" });
  const plan = buildCampaignPlanFromTopology(topology);
  assert.equal(plan.baseline.childrenPerWave, 4);
  assert.equal(plan.baseline.waves, 3);
  assert.equal(plan.groups.rounds, 3);
  assert.equal(plan.pinnedConcurrent.rounds, 3);
  assert.deepEqual(plan.exact.cpus, [0, 1, 2, 3]);
  assert.equal(plan.exact.rounds, 3);
  assert.equal(plan.controlledLoad.targetCpu, 3);
  assert.deepEqual(plan.controlledLoad.workerCpus, [0, 1, 2]);
  assert.equal(plan.controlledLoad.attemptsPerLeg, 3);

  const custom = buildCampaignPlanFromTopology(topology, {
    profile: "standard",
    seed: 99,
    targetCpu: 1,
    loadCpus: [2, 3],
  });
  assert.equal(custom.exact.rounds, 10);
  assert.equal(custom.exact.seed, 99);
  assert.equal(custom.controlledLoad.targetCpu, 1);
  assert.deepEqual(custom.controlledLoad.workerCpus, [2, 3]);
});

test("campaign plans reject diverging or incomplete sibling schedules", () => {
  assert.throws(() => parseCampaignPlan({ version: 1 }), /must contain exactly/);
  const sysfs = fixture("0-1");
  writeCpu(sysfs, 0);
  writeCpu(sysfs, 1);
  const topology = discoverCampaignTopology({ ...sysfs, allowedCpuSpec: "0-1" });
  assert.throws(() => buildCampaignPlanFromTopology(topology, {
    targetCpu: 1,
    loadCpus: [1],
  }), /outside load CPUs/);
});

test("campaign recipe catalog defaults to the reduced wasm suite", () => {
  assert.equal(DEFAULT_CAMPAIGN_RECIPE, "wasm-churn-diagnose");
  assert.equal(resolveCampaignRecipe().measuredWorkload, "wasm-churn-suite");
  assert.equal(resolveCampaignRecipe().conditionWorkload, "yes-load");
  assert.deepEqual(listCampaignRecipes().map(({ id }) => id),
    ["wasm-churn-diagnose", "node-pglite-diagnose"]);
  assert.throws(() => resolveCampaignRecipe("unknown"), /unknown campaign recipe/);
});
