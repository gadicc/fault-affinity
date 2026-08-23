import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  buildCampaignReport,
  renderCampaignReportMarkdown,
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
