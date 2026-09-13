import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  parseReferenceDiscoveryArgs,
  runReferenceDiscoveryCli,
} from "../../src/reference-kit/discovery-cli.mjs";

const HASH = "a".repeat(64);

test("discovery arguments are a fresh dry run by default", () => {
  const parsed = parseReferenceDiscoveryArgs(["--results-root", "/var/lib/fault affinity"]);
  assert.equal(parsed.mode, "fresh");
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.yes, false);
  assert.equal(parsed.resultsRoot, "/var/lib/fault affinity");
  assert.equal(parsed.outputName, undefined);
});

test("fresh live discovery requires paired explicit roles and the exact preview shape", () => {
  assert.throws(() => parseReferenceDiscoveryArgs([
    "--results-root", "/results", "--target-cpus", "4-7",
  ]), /supply both/);
  assert.throws(() => parseReferenceDiscoveryArgs([
    "--results-root", "/results", "--yes",
  ]), /requires the exact --expect-preview/);
  assert.throws(() => parseReferenceDiscoveryArgs([
    "--results-root", "/results", "--expect-preview", HASH,
  ]), /valid only with --yes/);
  assert.throws(() => parseReferenceDiscoveryArgs([
    "--results-root", "/results", "--yes", "--dry-run", "--expect-preview", HASH,
  ]), /choose --yes or --dry-run/);
  const parsed = parseReferenceDiscoveryArgs([
    "--results-root", "/results", "--target-cpus", "4-7", "--load-cpus", "0-3",
    "--expect-preview", HASH, "--yes",
  ]);
  assert.deepEqual(parsed.targetCpus, [4, 5, 6, 7]);
  assert.deepEqual(parsed.loadCpus, [0, 1, 2, 3]);
  assert.equal(parsed.dryRun, false);
});

test("resume and report modes reject planning ambiguity", () => {
  const resume = parseReferenceDiscoveryArgs(["--resume", "relative/collection"]);
  assert.equal(resume.collectionDir, path.resolve("relative/collection"));
  assert.equal(resume.dryRun, true);
  assert.throws(() => parseReferenceDiscoveryArgs([
    "--resume", "/collection", "--results-root", "/results",
  ]), /cannot be combined/);
  const report = parseReferenceDiscoveryArgs(["--report", "/collection", "--json"]);
  assert.equal(report.mode, "report");
  assert.equal(report.json, true);
  assert.throws(() => parseReferenceDiscoveryArgs([
    "--report", "/collection", "--yes",
  ]), /cannot be combined/);
  assert.throws(() => parseReferenceDiscoveryArgs([
    "--results-root", "/results", "--json",
  ]), /only with --report/);
});

test("fresh dry run plans and renders without calling either live campaign", async () => {
  const calls = [];
  const output = [];
  const plan = { fixture: "plan" };
  const status = await runReferenceDiscoveryCli(["--results-root", "/results"], {
    validateHost: () => calls.push("host"),
    plan: (options) => { calls.push(["plan", options]); return plan; },
    renderDryRun: (value) => { assert.equal(value, plan); return "SAFE PREVIEW"; },
    startCampaign: () => { throw new Error("must not start"); },
    resumeCampaign: () => { throw new Error("must not resume"); },
    output: (value) => output.push(value),
    errorOutput: (value) => output.push(value),
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, ["host", ["plan", { resultsRoot: "/results" }]]);
  assert.deepEqual(output, ["SAFE PREVIEW"]);
});

test("fresh live invocation forwards only its preview-bound plan", async () => {
  const plan = { fixture: "plan" };
  let received = null;
  const output = [];
  const status = await runReferenceDiscoveryCli([
    "--results-root", "/results", "--expect-preview", HASH, "--yes",
  ], {
    validateHost: () => {},
    environment: { HOME: "/home/fixture" },
    plan: () => plan,
    startCampaign: async (...args) => {
      received = args;
      return { report: { complete: true }, collectionDir: "/results/collection" };
    },
    renderReport: () => Buffer.from("REPORT\n"),
    output: (value) => output.push(value),
    errorOutput: (value) => output.push(value),
  });
  assert.equal(status, 0);
  assert.equal(received[0], plan);
  assert.equal(received[1].yes, true);
  assert.equal(received[1].expectedPreviewSha256, HASH);
  assert.deepEqual(received[1].environment, { HOME: "/home/fixture" });
  assert.deepEqual(output, ["REPORT", "Results: /results/collection"]);
});

test("resume defaults to a read-only preview and requires --yes to execute", async () => {
  const output = [];
  let resumed = false;
  const previewStatus = await runReferenceDiscoveryCli(["--resume", "/results/collection"], {
    validateHost: () => {},
    deriveReport: async () => ({
      plan: { identity: { kitRoot: "/opt/fault affinity" } },
      report: { complete: false },
    }),
    revalidateResume: () => {},
    resumeCampaign: async () => { resumed = true; },
    renderReport: () => Buffer.from("PARTIAL REPORT\n"),
    output: (value) => output.push(value),
    errorOutput: (value) => output.push(value),
  });
  assert.equal(previewStatus, 0);
  assert.equal(resumed, false);
  assert.match(output[0], /To resume untouched targets on this same boot/);
  assert.match(output[0], /'\/opt\/fault affinity\/bin\/discover-reference'/);
  assert.match(output[0], /Nothing was executed/);

  const liveStatus = await runReferenceDiscoveryCli([
    "--resume", "/results/collection", "--yes",
  ], {
    validateHost: () => {},
    resumeCampaign: async (directory, options) => {
      resumed = true;
      assert.equal(directory, "/results/collection");
      assert.equal(options.yes, true);
      return { report: { complete: false }, collectionDir: directory };
    },
    renderReport: () => Buffer.from("PARTIAL REPORT\n"),
    output: () => {},
    errorOutput: () => {},
  });
  assert.equal(resumed, true);
  assert.equal(liveStatus, 1);
});

test("resume preview offers preservation instead of an unusable cross-boot command", async () => {
  const output = [];
  const status = await runReferenceDiscoveryCli(["--resume", "/results/collection"], {
    validateHost: () => {},
    deriveReport: async () => ({
      plan: {
        identity: { kitRoot: "/opt/fault affinity" },
        storage: { resultsRoot: "/results" },
      },
      report: { complete: false },
    }),
    revalidateResume: () => {
      throw Object.assign(new Error("boot changed"), {
        code: "REFERENCE_DISCOVERY_PREVIEW_MISMATCH",
      });
    },
    renderReport: () => Buffer.from("PARTIAL REPORT\n"),
    output: (value) => output.push(value),
    errorOutput: (value) => output.push(value),
  });
  assert.equal(status, 0);
  assert.match(output[0], /cannot resume/);
  assert.match(output[0], /share\/prepare-results/);
  assert.doesNotMatch(output[0], /--resume.*--yes/);
});

test("report mode is read-only, supports JSON, and maps lease contention to 75", async () => {
  const output = [];
  const status = await runReferenceDiscoveryCli(["--report", "/collection", "--json"], {
    validateHost: () => {},
    deriveReport: async () => ({ report: { status: "complete", complete: true } }),
    output: (value) => output.push(value),
    errorOutput: (value) => output.push(value),
  });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(output[0]), { status: "complete", complete: true });

  const busy = await runReferenceDiscoveryCli(["--report", "/collection"], {
    validateHost: () => {},
    deriveReport: async () => { throw Object.assign(new Error("busy"), {
      code: "BUNDLE_EXECUTION_LEASE_BUSY",
    }); },
    output: () => {},
    errorOutput: () => {},
  });
  assert.equal(busy, 75);
});
