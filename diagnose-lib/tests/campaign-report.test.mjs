import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  buildCampaignReport,
  renderCampaignReportMarkdown,
  renderCampaignCandidateSummary,
  selectStrongestCampaignCandidate,
  summarizeCampaignCandidates,
} from "../../src/fault-affinity/campaign-report.mjs";
import {
  publishCampaignReport,
  readPublishedCampaignReport,
} from "../../src/fault-affinity/campaign-report-store.mjs";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function identity(id, digestCharacter) {
  return {
    version: 1,
    id,
    label: `${id} label`,
    risk: "standard",
    digest: digestCharacter.repeat(64),
  };
}

function evidence(category = "pass", label = "exit-zero") {
  return { outcome: { validOutcome: true, category, label } };
}

function bound(category = "pass") {
  return { attempt: { evidence: evidence(category, category) } };
}

function waveProgress(count) {
  return {
    status: "complete",
    complete: true,
    committedWaves: count,
    totalWaves: count,
    committedAttempts: count,
    totalAttempts: count,
  };
}

function bundle() {
  const pass = evidence();
  const target = evidence("target-fault", "sigsegv");
  const controlledLeg = (leg, condition, evidences) => ({
    leg,
    condition,
    attempts: evidences.map((entry) => ({ evidence: entry })),
  });
  return {
    manifest: {
      version: 7,
      bundleGeneration: "c".repeat(32),
      workload: identity("measured", "a"),
      auxiliaryWorkload: identity("condition", "b"),
    },
    manifestBinding: { sha256: "d".repeat(64), bytes: 100 },
    baseline: {
      manifest: {},
      envelopes: [
        { attempts: [bound("target-fault")] },
        { attempts: [bound()] },
      ],
      progress: waveProgress(2),
    },
    groups: {
      manifest: { topology: { contexts: [{
        id: "all", kind: "uniform", cpus: [0, 1], childrenPerWave: 1,
      }] } },
      envelopes: [
        { wave: { contextId: "all" }, attempts: [bound("target-fault")] },
        { wave: { contextId: "all" }, attempts: [bound()] },
      ],
      progress: waveProgress(2),
    },
    pinnedConcurrent: {
      manifest: { topology: { contexts: [{
        id: "active", kind: "subset", cpus: [0, 1], cluster: "-", controllerCpu: 2,
      }] } },
      envelopes: [
        {
          wave: { contextId: "active" },
          attempts: [
            { slot: { cpu: 0 }, attempt: { evidence: target } },
            { slot: { cpu: 1 }, attempt: { evidence: pass } },
          ],
        },
      ],
      progress: {
        ...waveProgress(1),
        committedAttempts: 2,
        totalAttempts: 2,
      },
    },
    exactCpu: {
      manifest: { schedule: { cpus: [0, 1] } },
      envelopes: [
        { slot: { cpu: 0 }, attempt: { evidence: target } },
        { slot: { cpu: 0 }, attempt: { evidence: pass } },
        { slot: { cpu: 1 }, attempt: { evidence: pass } },
        { slot: { cpu: 1 }, attempt: { evidence: pass } },
      ],
      progress: {
        status: "complete",
        complete: true,
        committedAttempts: 4,
        totalAttempts: 4,
      },
    },
    controlledLoad: {
      manifest: {
        execution: { targetCpu: 0, workerCpus: [1, 2] },
        schedule: {
          legs: [
            { leg: "a1", condition: "without-load" },
            { leg: "b", condition: "with-load" },
            { leg: "a2", condition: "after-recovery" },
          ],
          attemptsPerLeg: 5,
          warmupMs: 0,
          recoveryMs: 5_000,
        },
      },
      envelope: {
        legs: [
          controlledLeg("a1", "without-load", Array(5).fill(pass)),
          controlledLeg("b", "with-load", Array(5).fill(target)),
          controlledLeg("a2", "after-recovery", Array(5).fill(pass)),
        ],
      },
      progress: {
        status: "complete",
        complete: true,
        committedSessions: 1,
        totalSessions: 1,
      },
    },
  };
}

function attempts(target, resolved, other = 0) {
  return {
    target,
    pass: resolved - target,
    other,
    resolved,
    rate: resolved === 0 ? null : target / resolved,
  };
}

function candidateReport({
  exact,
  pinned = [],
  groups = [],
  workload = "wasm-churn-suite",
  conditionWorkload = "yes-load",
  controlledLoad,
}) {
  return {
    workload: { id: workload },
    conditionWorkload: { id: conditionWorkload },
    phases: {
      exactCpu: { cpus: exact.map(([cpu, value]) => ({ cpu, attempts: value })) },
      pinnedConcurrent: { contexts: pinned },
      groups: { contexts: groups },
      ...(controlledLoad === undefined ? {} : { controlledLoad }),
    },
  };
}

function renderBuiltInCandidateSummary(report, options = {}) {
  return renderCampaignCandidateSummary(report, {
    ...options,
    selectionSources: { measured: "built-in", condition: "built-in" },
  });
}

test("campaign reports keep wave, child, per-CPU, and A/B/A statistics separate", () => {
  const report = buildCampaignReport(bundle());
  assert.equal(report.complete, true);
  assert.equal(report.phases.baseline.waves.target, 1);
  assert.equal(report.phases.baseline.waves.resolved, 2);
  assert.equal(report.phases.baseline.waves.rate, 0.5);
  assert.equal(report.phases.groups.contexts[0].waves.target, 1);
  assert.equal(report.phases.pinnedConcurrent.contexts[0].cpus[0].attempts.target, 1);
  assert.equal(report.phases.exactCpu.cpus[0].attempts.rate, 0.5);
  assert.equal(report.phases.exactCpu.cpus[1].attempts.zeroTargetUpper95 > 0, true);
  assert.equal(report.phases.controlledLoad.legs[1].attempts.rate, 1);
  assert.equal(report.comparisons.controlledLoad.eligible, true);
  assert.equal(report.comparisons.controlledLoad.replicatedAssociation, true);
  assert.equal(report.comparisons.controlledLoad.replicatedP < 0.05, true);
  assert.match(renderCampaignReportMarkdown(report), /Wave-level target observations/);
  assert.match(renderCampaignReportMarkdown(report), /B vs A1/);
});

test("candidate summary prefers and ranks isolated exact-CPU target evidence", () => {
  const report = candidateReport({
    exact: [
      [6, attempts(1, 4)],
      [3, attempts(2, 4)],
      [1, attempts(2, 4)],
      [5, attempts(0, 4)],
    ],
    pinned: [{
      id: "high-pinned-rate",
      activeCpus: [1],
      cpus: [{ cpu: 1, attempts: attempts(1, 1) }],
    }],
    groups: [{ id: "pcores", kind: "pcore", cpus: [4, 5] }],
  });

  const summary = summarizeCampaignCandidates(report);
  assert.deepEqual(summary.exact.map(({ cpu }) => cpu), [1, 3, 6]);
  assert.deepEqual(selectStrongestCampaignCandidate(report), summary.exact[0]);
  assert.match(renderBuiltInCandidateSummary(report, { outDir: "/tmp/follow-up" }),
    /Strongest candidate: CPU 1 from isolated exact CPU evidence; 2\/4 = 50\.0%\./);
  assert.match(renderBuiltInCandidateSummary(report, { outDir: "/tmp/follow-up" }),
    /controlled-load --recipe wasm-churn-suite-aba \\\n    --target-cpu 1 --load-cpus 4,5 \\\n    --out-dir '\/tmp\/follow-up' --dry-run/);
});

test("candidate confirmation preserves the Node/PGlite campaign workload identity", () => {
  const report = candidateReport({
    exact: [[0, attempts(1, 2)], [1, attempts(0, 2)]],
    workload: "node-pglite-suite",
  });
  assert.match(renderBuiltInCandidateSummary(report, { outDir: "confirm" }),
    /controlled-load --recipe node-pglite-suite-aba/);
});

test("candidate confirmation does not substitute a recipe for custom sources using built-in IDs", () => {
  const report = candidateReport({
    exact: [[0, attempts(1, 2)], [1, attempts(0, 2)]],
  });
  const rendered = renderCampaignCandidateSummary(report, {
    outDir: "confirm",
    selectionSources: { measured: "custom-file", condition: "custom-file" },
  });
  assert.match(rendered, /No automatic A\/B\/A command/);
  assert.match(rendered, /wasm-churn-suite.*yes-load/);
  assert.doesNotMatch(rendered, /--recipe/);
});

test("pinned fallback keeps the finest stable context per CPU without pooling", () => {
  const report = candidateReport({
    exact: [[0, attempts(0, 4)], [1, attempts(0, 4)], [2, attempts(0, 4)], [3, attempts(0, 4)]],
    pinned: [
      {
        id: "broad",
        activeCpus: [0, 3, 4],
        cpus: [{ cpu: 0, attempts: attempts(5, 5) }],
      },
      {
        id: "fine-first",
        activeCpus: [0, 5],
        cpus: [{ cpu: 0, attempts: attempts(1, 2) }],
      },
      {
        id: "fine-later",
        activeCpus: [0, 6],
        cpus: [{ cpu: 0, attempts: attempts(2, 2) }],
      },
      {
        id: "one",
        activeCpus: [1],
        cpus: [{ cpu: 1, attempts: attempts(2, 4) }],
      },
      {
        id: "two",
        activeCpus: [2],
        cpus: [{ cpu: 2, attempts: attempts(2, 4) }],
      },
    ],
    groups: [{ id: "pcores", kind: "pcore", cpus: [1, 2] }],
  });

  const summary = summarizeCampaignCandidates(report);
  const cpuZero = summary.pinned.find(({ cpu }) => cpu === 0);
  assert.equal(cpuZero.context, "fine-first");
  assert.equal(cpuZero.target, 1);
  assert.equal(cpuZero.resolved, 2);
  assert.deepEqual(selectStrongestCampaignCandidate(report), summary.pinned[0]);
  assert.equal(summary.pinned[0].cpu, 1);
  assert.match(renderBuiltInCandidateSummary(report, { outDir: "next-run" }),
    /--target-cpu 1 --load-cpus 0,2,3 \\\n    --out-dir 'next-run' --dry-run/);
});

test("pinned fallback chooses its representative before filtering affected CPUs", () => {
  const report = candidateReport({
    exact: [[0, attempts(0, 4)]],
    pinned: [
      {
        id: "coarse-affected",
        activeCpus: [0, 1, 2],
        cpus: [{ cpu: 0, attempts: attempts(2, 2) }],
      },
      {
        id: "fine-unaffected",
        activeCpus: [0],
        cpus: [{ cpu: 0, attempts: attempts(0, 3) }],
      },
    ],
  });

  assert.deepEqual(summarizeCampaignCandidates(report).pinned, []);
  assert.equal(selectStrongestCampaignCandidate(report), null);
});

test("candidate recommendation shell-quotes every output directory", () => {
  const report = candidateReport({
    exact: [[0, attempts(1, 2)], [1, attempts(0, 2)]],
  });
  for (const outDir of ["with spaces", "apostrophe's$cash", "line\nbreak"]) {
    const rendered = renderBuiltInCandidateSummary(report, { outDir });
    const quoted = `'${outDir.replaceAll("'", "'\"'\"'")}'`;
    assert.ok(rendered.includes(`--out-dir ${quoted} --dry-run`), outDir);
  }
});

test("candidate summary scopes a clean discovery result to its selected evidence strata", () => {
  const report = candidateReport({
    exact: [[0, attempts(0, 4)], [1, attempts(0, 0, 2)]],
    pinned: [{
      id: "unresolved",
      activeCpus: [0],
      cpus: [{ cpu: 0, attempts: attempts(0, 0, 3) }],
    }],
  });
  assert.deepEqual(summarizeCampaignCandidates(report), { exact: [], pinned: [] });
  assert.equal(selectStrongestCampaignCandidate(report), null);
  assert.equal(renderCampaignCandidateSummary(report),
    "No affected CPU candidate from isolated exact-CPU or selected finest " +
      "pinned-concurrent evidence.\n");
});

test("candidate summary retains a positive focused controlled-load observation separately", () => {
  const report = candidateReport({
    exact: [[0, attempts(0, 4)], [1, attempts(0, 4)]],
    controlledLoad: {
      targetCpu: 1,
      legs: [
        { leg: "a1", attempts: attempts(0, 3) },
        { leg: "b", attempts: attempts(3, 3) },
        { leg: "a2", attempts: attempts(0, 3) },
      ],
    },
  });
  const rendered = renderCampaignCandidateSummary(report);
  assert.match(rendered, /No affected CPU candidate from isolated exact-CPU/);
  assert.match(rendered, /CPU 1 B leg 3\/3 = 100\.0%/);
  assert.match(rendered, /not used to infer a from-scratch candidate/);
});

test("complete campaign reports publish idempotently and bind both artifacts", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "campaign-report-store-"));
  directories.push(directory);
  const report = buildCampaignReport(bundle());
  const first = await publishCampaignReport({ bundleDir: directory, report });
  const second = await publishCampaignReport({ bundleDir: directory, report });
  assert.deepEqual(second, first);
  const read = await readPublishedCampaignReport({
    bundleDir: directory,
    manifestBinding: report.bundle.manifestBinding,
  });
  assert.deepEqual(read.report, JSON.parse(readFileSync(path.join(directory, "report.json"))));
  assert.equal(read.markdown, renderCampaignReportMarkdown(report));

  writeFileSync(path.join(directory, "report.md"), "changed\n");
  await assert.rejects(readPublishedCampaignReport({
    bundleDir: directory,
    manifestBinding: report.bundle.manifestBinding,
  }), /does not match its report artifact/);
});
