import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSchema3BundleSummary,
  renderSchema3BundleSummary,
} from "../../src/fault-affinity/schema3-summary.mjs";

function identity(id) {
  return {
    version: 1,
    id,
    label: `${id} label`,
    risk: "standard",
    digest: id === "measured" ? "a".repeat(64) : "b".repeat(64),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function evidence(category = "pass", label = "exit-zero") {
  return { outcome: { validOutcome: true, category, label } };
}

function exactPhase(envelopes, cpus = [2, 3], totalAttempts = 4) {
  const complete = envelopes.length === totalAttempts;
  return {
    manifest: { schedule: { cpus } },
    envelopes,
    progress: {
      status: complete ? "complete"
        : envelopes.length === 0 ? "empty" : "incomplete",
      complete,
      committedAttempts: envelopes.length,
      totalAttempts,
      nextSlot: complete ? null : {
        ordinal: envelopes.length + 1,
        cpu: cpus[envelopes.length % cpus.length],
      },
    },
  };
}

function baseBundle(version) {
  return {
    manifest: {
      version,
      bundleGeneration: "c".repeat(32),
      workload: identity("measured"),
      ...([5, 7].includes(version) ? { auxiliaryWorkload: identity("condition") } : {}),
    },
    manifestBinding: { sha256: "d".repeat(64), bytes: 100 },
  };
}

test("a version-5 summary keeps complete A1/B/A2 and per-CPU outcomes distinct", () => {
  const bundle = {
    ...baseBundle(5),
    controlledLoad: {
      manifest: {
        execution: { targetCpu: 2, workerCpus: [0, 1] },
        schedule: {
          legs: [
            { leg: "a1", condition: "without-load" },
            { leg: "b", condition: "with-load" },
            { leg: "a2", condition: "after-recovery" },
          ],
          attemptsPerLeg: 1,
          warmupMs: 10,
          recoveryMs: 20,
        },
      },
      envelope: {
        legs: [
          { leg: "a1", condition: "without-load", attempts: [{ evidence: evidence() }] },
          { leg: "b", condition: "with-load", attempts: [{
            evidence: evidence("target-fault", "signal-SIGSEGV"),
          }] },
          { leg: "a2", condition: "after-recovery", attempts: [{ evidence: evidence() }] },
        ],
      },
      progress: {
        status: "complete",
        complete: true,
        committedSessions: 1,
        totalSessions: 1,
      },
    },
    exactCpu: exactPhase([
      { slot: { cpu: 2 }, attempt: { evidence: evidence() } },
      { slot: { cpu: 3 }, attempt: {
        evidence: evidence("target-fault", "signal-SIGSEGV"),
      } },
    ]),
  };
  const summary = buildSchema3BundleSummary(bundle);
  assert.equal(summary.bundle.manifestVersion, 5);
  assert.equal(summary.conditionWorkload.id, "condition");
  assert.equal(summary.phases.baseline.status, "not-bound");
  assert.deepEqual(summary.phases.controlledLoad.legs[1].outcomes, [{
    category: "target-fault",
    label: "signal-SIGSEGV",
    count: 1,
  }]);
  assert.equal(summary.phases.exactCpu.status, "incomplete");
  assert.equal(summary.phases.exactCpu.cpus[0].committedAttempts, 1);
  assert.deepEqual(summary.phases.exactCpu.next, { ordinal: 3, cpu: 2 });
  assert.equal(Object.isFrozen(summary.phases.controlledLoad.legs), true);
  assert.match(renderSchema3BundleSummary(summary), /leg b condition=with-load.*target-fault/);
  assert.match(renderSchema3BundleSummary(summary), /exact-CPU:.*next unit=3 cpu=2/);
});

test("summaries disclose an interrupted attempt-armed breadcrumb as non-evidence", () => {
  const bundle = {
    ...baseBundle(1),
    attemptArmed: {
      version: 1,
      bundleGeneration: "c".repeat(32),
      phase: "pinned-concurrent",
      startedAt: "2026-08-23T15:00:00.000Z",
      unit: {
        ordinal: 16,
        contextId: "ecluster-topo-example",
        cpu: null,
        controllerCpu: 0,
        childCount: 4,
      },
      status: "interrupted",
      evidence: false,
    },
    exactCpu: exactPhase([]),
  };
  const summary = buildSchema3BundleSummary(bundle);
  assert.equal(summary.attemptArmed.status, "interrupted");
  assert.equal(summary.attemptArmed.evidence, false);
  assert.match(renderSchema3BundleSummary(summary),
    /attempt armed: interrupted; phase=pinned-concurrent unit=16 .*non-evidence breadcrumb/);
});

test("a version-4 summary groups baseline, topology, and pinned outcomes", () => {
  const pass = evidence();
  const bundle = {
    ...baseBundle(4),
    baseline: {
      manifest: {},
      envelopes: [{ attempts: [{ attempt: { evidence: pass } }] }],
      progress: {
        status: "complete", complete: true,
        committedWaves: 1, totalWaves: 1,
        committedAttempts: 1, totalAttempts: 1,
      },
    },
    groups: {
      manifest: { topology: { contexts: [{
        id: "all", kind: "uniform", cpus: [0, 1], childrenPerWave: 1,
      }] } },
      envelopes: [{
        wave: { contextId: "all" },
        attempts: [{ attempt: { evidence: pass } }],
      }],
      progress: {
        status: "complete", complete: true,
        committedWaves: 1, totalWaves: 1,
        committedAttempts: 1, totalAttempts: 1,
      },
    },
    pinnedConcurrent: {
      manifest: { topology: { contexts: [{
        id: "active", kind: "subset", cpus: [1], cluster: "l2:1", controllerCpu: 0,
      }] } },
      envelopes: [{
        wave: { contextId: "active" },
        attempts: [{ attempt: { evidence: pass } }],
      }],
      progress: {
        status: "complete", complete: true,
        committedWaves: 1, totalWaves: 1,
        committedAttempts: 1, totalAttempts: 1,
      },
    },
    exactCpu: exactPhase([
      { slot: { cpu: 2 }, attempt: { evidence: pass } },
    ], [2], 1),
  };
  const summary = buildSchema3BundleSummary(bundle);
  assert.equal(summary.phases.baseline.committedAttempts, 1);
  assert.equal(summary.phases.groups.contexts[0].id, "all");
  assert.equal(summary.phases.pinnedConcurrent.contexts[0].controllerCpu, 0);
  assert.equal(summary.phases.controlledLoad.status, "not-bound");
  assert.match(renderSchema3BundleSummary(summary), /context active controller=0/);
});

test("summaries reject unsupported manifests and invalid committed outcomes", () => {
  assert.throws(() => buildSchema3BundleSummary({
    ...baseBundle(8),
    exactCpu: exactPhase([]),
  }), /manifest version is unsupported/);
  assert.throws(() => buildSchema3BundleSummary({
    ...baseBundle(1),
    exactCpu: exactPhase([{
      slot: { cpu: 2 },
      attempt: { evidence: { outcome: { validOutcome: false } } },
    }]),
  }), /invalid outcome evidence/);
});

test("a version-7 summary combines topology, exact, and controlled-load evidence", () => {
  const pass = evidence();
  const emptyWaveProgress = {
    status: "empty",
    complete: false,
    committedWaves: 0,
    totalWaves: 1,
    committedAttempts: 0,
    totalAttempts: 1,
  };
  const bundle = {
    ...baseBundle(7),
    baseline: { manifest: {}, envelopes: [], progress: emptyWaveProgress },
    groups: {
      manifest: { topology: { contexts: [{
        id: "all", kind: "uniform", cpus: [0], childrenPerWave: 1,
      }] } },
      envelopes: [],
      progress: emptyWaveProgress,
    },
    pinnedConcurrent: {
      manifest: { topology: { contexts: [{
        id: "active", kind: "uniform", cpus: [0], cluster: "-", controllerCpu: 1,
      }] } },
      envelopes: [],
      progress: emptyWaveProgress,
    },
    controlledLoad: {
      manifest: {
        execution: { targetCpu: 0, workerCpus: [1] },
        schedule: {
          legs: [
            { leg: "a1", condition: "without-load" },
            { leg: "b", condition: "with-load" },
            { leg: "a2", condition: "after-recovery" },
          ],
          attemptsPerLeg: 1,
          warmupMs: 0,
          recoveryMs: 0,
        },
      },
      envelope: null,
      progress: {
        status: "empty", complete: false, committedSessions: 0, totalSessions: 1,
      },
    },
    exactCpu: exactPhase([
      { slot: { cpu: 2 }, attempt: { evidence: pass } },
    ], [2], 1),
  };
  const summary = buildSchema3BundleSummary(bundle);
  assert.equal(summary.bundle.manifestVersion, 7);
  assert.equal(summary.conditionWorkload.id, "condition");
  assert.equal(summary.phases.baseline.status, "empty");
  assert.equal(summary.phases.groups.contexts[0].id, "all");
  assert.equal(summary.phases.pinnedConcurrent.contexts[0].controllerCpu, 1);
  assert.equal(summary.phases.controlledLoad.targetCpu, 0);
  assert.equal(summary.phases.exactCpu.status, "complete");
});

test("a version-6 summary inspects the debugger phase progress", () => {
  const bundle = {
    ...baseBundle(6),
    debugger: {
      attempts: [
        {
          run: 1,
          envelope: {
            run: 1,
            outcome: {
              kind: "captured",
              signal: "SIGSEGV",
              target: true,
              sections: ["stop", "backtrace", "registers", "instructions", "threads",
                "mappings"],
            },
          },
        },
        {
          run: 2,
          envelope: { run: 2, outcome: { kind: "clean" } },
        },
      ],
      progress: {
        status: "incomplete",
        complete: false,
        committedRuns: 2,
        maxRuns: 4,
        capturedRuns: 1,
        maxCaptures: 2,
      },
    },
    exactCpu: exactPhase([]),
  };
  const summary = buildSchema3BundleSummary(bundle);
  assert.equal(summary.phases.debugger.status, "incomplete");
  assert.equal(summary.phases.debugger.committed, 2);
  assert.equal(summary.phases.debugger.scheduled, 4);
  assert.equal(summary.phases.debugger.captured, 1);
  assert.deepEqual(summary.phases.debugger.outcomes,
    [{ kind: "captured", count: 1 }, { kind: "clean", count: 1 }]);
  assert.equal(summary.phases.debugger.runs.length, 2);
  assert.equal(summary.phases.debugger.runs[0].outcome.kind, "captured");
  assert.equal(summary.phases.debugger.runs[1].outcome.kind, "clean");
  assert.equal(summary.phases.debugger.runs[0].artifacts.transcript,
    "state/debugger/debugger-attempt-000000001-transcript");
  assert.equal(summary.conditionWorkload, undefined);
  const text = renderSchema3BundleSummary(summary);
  assert.match(text, /manifest v6/);
  assert.match(text, /debugger: incomplete; 2\/4 runs; captured 1\/2/);
  assert.match(text, /run 1: captured signal=SIGSEGV target=yes/);
  assert.match(text, /run 2: clean/);

  const unreconciled = clone(bundle);
  unreconciled.debugger.progress.capturedRuns = 0;
  assert.throws(() => buildSchema3BundleSummary(unreconciled),
    /do not reconcile with progress/);
});

test("debugger summaries require the v6 phase and reconcile its progress", () => {
  assert.throws(() => buildSchema3BundleSummary({
    ...baseBundle(6),
    exactCpu: exactPhase([]),
  }), /missing its debugger phase/);

  const debuggerBundle = (progress) => ({
    ...baseBundle(6),
    debugger: { progress },
    exactCpu: exactPhase([]),
  });
  assert.throws(() => buildSchema3BundleSummary(debuggerBundle({
    status: "incomplete",
    complete: false,
    committedRuns: 1,
    maxRuns: 4,
    capturedRuns: 2,
    maxCaptures: 2,
  })), /debugger progress is invalid/);
  assert.throws(() => buildSchema3BundleSummary(debuggerBundle({
    status: "incomplete",
    complete: true,
    committedRuns: 2,
    maxRuns: 4,
    capturedRuns: 1,
    maxCaptures: 2,
  })), /does not reconcile/);
  assert.throws(() => buildSchema3BundleSummary(debuggerBundle({
    status: "complete",
    complete: true,
    committedRuns: 2,
    maxRuns: 4,
    capturedRuns: 1,
    maxCaptures: 2,
  })), /does not reconcile/);

  for (const version of [1, 2, 3, 4, 5, 7]) {
    const summary = buildSchema3BundleSummary({
      ...baseBundle(version),
      ...([5, 7].includes(version) ? { controlledLoad: undefined } : {}),
      exactCpu: exactPhase([]),
    });
    assert.equal(summary.phases.debugger.status, "not-bound", `v${version}`);
  }
});
