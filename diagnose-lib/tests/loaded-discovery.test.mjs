import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  buildLoadedDiscoveryPlanFromTopology,
  buildLoadedDiscoveryReport,
  parseLoadedDiscoveryPlan,
  renderLoadedDiscoveryConsoleSummary,
} from "../../src/fault-affinity/loaded-discovery.mjs";
import {
  publishLoadedDiscoveryPlan,
  readLoadedDiscoveryPlan,
} from "../../src/fault-affinity/loaded-discovery-store.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function hybridTopology() {
  return {
    usable: [0, 1, 2, 3, 4],
    classes: {
      source: "sysfs-hybrid",
      performance: [0, 1],
      efficient: [2, 3, 4],
    },
  };
}

function phaseBundle(plan, session, counts) {
  const attempts = (target, pass, other) => [
    ...Array.from({ length: target }, () => ({
      evidence: { outcome: { category: "target-fault" } },
    })),
    ...Array.from({ length: pass }, () => ({
      evidence: { outcome: { category: "pass" } },
    })),
    ...Array.from({ length: other }, () => ({
      evidence: { outcome: { category: "operational-invalid" } },
    })),
  ];
  return {
    controlledLoad: {
      manifest: {
        execution: {
          targetCpu: session.targetCpu,
          workerCpus: [...plan.topology.loadCpus],
        },
        schedule: {
          attemptsPerLeg: plan.schedule.attemptsPerLeg,
          warmupMs: plan.schedule.warmupMs,
          recoveryMs: plan.schedule.recoveryMs,
        },
      },
      progress: { complete: true },
      envelope: {
        legs: [
          { leg: "a1", attempts: attempts(...counts.a1) },
          { leg: "b", attempts: attempts(...counts.b) },
          { leg: "a2", attempts: attempts(...counts.a2) },
        ],
      },
    },
  };
}

test("automatic loaded discovery screens every E-core under the P-core load set", () => {
  const plan = buildLoadedDiscoveryPlanFromTopology(hybridTopology(), {
    profile: "quick",
    seed: 17,
    tasksetPath: "/usr/bin/taskset",
  });
  assert.deepEqual(plan.topology.targetCpus, [2, 3, 4]);
  assert.deepEqual(plan.topology.loadCpus, [0, 1]);
  assert.equal(plan.schedule.sessions.length, 3);
  assert.deepEqual(
    [...plan.schedule.sessions].map(({ targetCpu }) => targetCpu).sort((a, b) => a - b),
    [2, 3, 4],
  );
  for (const session of plan.schedule.sessions) {
    assert.notEqual(session.controllerCpu, session.targetCpu);
    assert.equal(plan.topology.loadCpus.includes(session.controllerCpu), false);
  }
});

test("uniform topology requires explicit, disjoint target and load sets", () => {
  const topology = {
    usable: [0, 1, 2],
    classes: { source: "uniform", performance: [], efficient: [] },
  };
  assert.throws(() => buildLoadedDiscoveryPlanFromTopology(topology),
    /automatic loaded discovery requires complete Linux P-core\/E-core topology/);
  const explicit = buildLoadedDiscoveryPlanFromTopology(topology, {
    targetCpus: [2],
    loadCpus: [0],
    tasksetPath: "/usr/bin/taskset",
  });
  assert.deepEqual(explicit.topology.targetCpus, [2]);
  assert.deepEqual(explicit.topology.loadCpus, [0]);
  assert.equal(explicit.schedule.sessions[0].controllerCpu, 1);
  assert.throws(() => buildLoadedDiscoveryPlanFromTopology(topology, {
    targetCpus: [1],
    loadCpus: [0, 1],
  }), /overlap/);
});

test("loaded discovery rejects worker sets larger than child execution supports", () => {
  const topology = {
    usable: Array.from({ length: 259 }, (_, cpu) => cpu),
    classes: { source: "uniform", performance: [], efficient: [] },
  };
  assert.throws(() => buildLoadedDiscoveryPlanFromTopology(topology, {
    targetCpus: [258],
    loadCpus: Array.from({ length: 257 }, (_, cpu) => cpu),
  }), /at most 256 CPUs/);

  const valid = buildLoadedDiscoveryPlanFromTopology(topology, {
    targetCpus: [258],
    loadCpus: Array.from({ length: 256 }, (_, cpu) => cpu),
  });
  const stored = structuredClone(valid);
  stored.topology.loadCpus.push(256);
  stored.schedule.sessions[0].controllerCpu = 257;
  assert.throws(() => parseLoadedDiscoveryPlan(stored), /at most 256 CPUs/);
});

test("loaded discovery rejects recipes outside its fixed reduced experiment", () => {
  assert.throws(() => buildLoadedDiscoveryPlanFromTopology(hybridTopology(), {
    recipe: "node-pglite-suite-aba",
  }), /recipe must be wasm-churn-aba/);
  const valid = buildLoadedDiscoveryPlanFromTopology(hybridTopology());
  const stored = structuredClone(valid);
  stored.recipe = "node-pglite-suite-aba";
  assert.throws(() => parseLoadedDiscoveryPlan(stored),
    /recipe or profile is invalid/);
});

test("loaded discovery ranks only each target's with-load leg", () => {
  const plan = buildLoadedDiscoveryPlanFromTopology(hybridTopology(), {
    profile: "quick",
    tasksetPath: "/usr/bin/taskset",
  });
  const byCpu = new Map([
    [2, { a1: [3, 0, 0], b: [0, 3, 0], a2: [3, 0, 0] }],
    [3, { a1: [0, 3, 0], b: [1, 2, 0], a2: [0, 3, 0] }],
    [4, { a1: [0, 3, 0], b: [2, 1, 0], a2: [0, 3, 0] }],
  ]);
  const bundles = plan.schedule.sessions.map((session) =>
    phaseBundle(plan, session, byCpu.get(session.targetCpu)));
  const report = buildLoadedDiscoveryReport(plan, bundles);
  assert.equal(report.complete, true);
  assert.deepEqual(report.affectedCpus, [4, 3]);
  assert.equal(report.strongestCandidate, 4);
  assert.equal(report.rows.find(({ cpu }) => cpu === 2).withoutLoad.target, 3);
  assert.equal(report.rows.find(({ cpu }) => cpu === 2).withLoad.target, 0);
  const summary = renderLoadedDiscoveryConsoleSummary(report, "/tmp/discovery");
  assert.match(summary, /CPU 4: 2\/3 \(66\.7%\)/);
  assert.match(summary, /--target-cpu 4 --load-cpus 0-1/);
  assert.match(summary, /--out-dir '\/tmp\/discovery-confirm-cpu4' --dry-run/);
  assert.doesNotMatch(summary, /CPU 2:/);
});

test("loaded discovery safely quotes unusual confirmation paths", () => {
  const plan = buildLoadedDiscoveryPlanFromTopology(hybridTopology(), {
    profile: "quick",
    tasksetPath: "/usr/bin/taskset",
  });
  const bundles = plan.schedule.sessions.map((session) => phaseBundle(plan, session, {
    a1: [0, 3, 0],
    b: session.targetCpu === 2 ? [1, 2, 0] : [0, 3, 0],
    a2: [0, 3, 0],
  }));
  const report = buildLoadedDiscoveryReport(plan, bundles);
  const summary = renderLoadedDiscoveryConsoleSummary(
    report,
    "/tmp/my results/'quoted'/$HOME\nnext",
  );
  assert.match(summary,
    /--out-dir '\/tmp\/my results\/'"'"'quoted'"'"'\/\$HOME\nnext-confirm-cpu2' --dry-run/);
});

test("loaded discovery plans publish canonically and cannot be replaced", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "loaded-discovery-"));
  directories.push(directory);
  const plan = buildLoadedDiscoveryPlanFromTopology(hybridTopology(), {
    tasksetPath: "/usr/bin/taskset",
  });
  await publishLoadedDiscoveryPlan(directory, plan);
  assert.deepEqual(await readLoadedDiscoveryPlan(directory), plan);
  const different = buildLoadedDiscoveryPlanFromTopology(hybridTopology(), {
    seed: 18,
    tasksetPath: "/usr/bin/taskset",
  });
  await assert.rejects(() => publishLoadedDiscoveryPlan(directory, different),
    /already exists with different content/);
});
