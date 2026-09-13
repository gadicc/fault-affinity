import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  REFERENCE_CONFIRMATION_FORMAT_VERSION,
  REFERENCE_CONFIRMATION_PROTOCOL,
  executeReferenceConfirmation,
  parseReferenceConfirmationArgs,
  renderReferenceConfirmationDryRun,
  runReferenceConfirmationCli,
} from "../../src/reference-kit/confirmation-cli.mjs";

function snapshot(candidate = 7) {
  return {
    plan: {
      interpretationVersion: 1,
      identity: { kitRoot: "/opt/fault affinity" },
      host: { bootIdSha256: "a".repeat(64), machineSha256: "b".repeat(64) },
      topology: { usableCpus: [0, 1, 6, 7] },
      selection: { loadCpus: [0, 1] },
      storage: {
        collectionDir: "/results/reference-discovery-20260913T120000Z",
        resultsRoot: "/tmp",
      },
      schedule: { sessions: [
        { ordinal: 1, targetCpu: 6, controllerCpu: 7 },
        { ordinal: 2, targetCpu: 7, controllerCpu: 6 },
      ] },
    },
    report: {
      complete: true,
      selectionEligible: true,
      highestObservedFaultRateCandidate: candidate,
    },
  };
}

test("confirmation arguments are a dry run and expose no CPU override", () => {
  const parsed = parseReferenceConfirmationArgs([
    "--from-discovery", "relative screen",
  ], { now: () => new Date("2026-09-13T20:00:00Z") });
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.yes, false);
  assert.equal(parsed.fromDiscovery, path.resolve("relative screen"));
  assert.equal(parsed.outputName, "reference-confirmation-20260913T200000Z");
  assert.throws(() => parseReferenceConfirmationArgs([
    "--from-discovery", "/screen", "--target-cpu", "9",
  ]), /unknown argument '--target-cpu'/);
  assert.throws(() => parseReferenceConfirmationArgs(["--yes"]), /--from-discovery/);
  assert.throws(() => parseReferenceConfirmationArgs([
    "--from-discovery", "/screen", "--yes", "--dry-run",
  ]), /choose --yes or --dry-run/);
});

test("confirmation rederives one eligible candidate and builds a fresh bound profile", async () => {
  const value = snapshot();
  const calls = [];
  const result = await executeReferenceConfirmation(parseReferenceConfirmationArgs([
    "--from-discovery", value.plan.storage.collectionDir,
    "--output-name", "reference-confirmation-20260913T200001Z-test",
  ]), {
    deriveReport: async (directory) => {
      calls.push(["derive", directory]);
      return value;
    },
    readCurrentAllowedCpus: () => [0, 1, 6, 7],
    revalidateContext: async (plan) => calls.push(["revalidate", plan]),
    revalidateOwnerContext: async () => { throw new Error("owner path must not run"); },
    buildSourceBinding: (plan, report) => ({
      version: 1,
      protocol: "reference-discovery-confirmation-source-v1",
      sha256: "c".repeat(64),
      targetCpu: report.highestObservedFaultRateCandidate,
      loadCpus: [...plan.selection.loadCpus],
    }),
    collectResources: () => ({ meetsMinimum: true, effectiveHeadroomBytes: "9999999999" }),
    executeProfile: async (options, execution) => {
      calls.push(["execute", options, execution]);
      return {
        executed: false,
        plan: {
          outputRoot: options.resultsRoot,
          outputLeaf: path.join(options.resultsRoot, options.outputName),
          selection: {
            targetCpu: options.targetCpu,
            controllerCpu: options.controllerCpu,
            loadCpus: [...options.loadCpus],
            attemptsPerLeg: options.attemptsPerLeg,
          },
          storage: {
            classification: "likely-persistent",
            filesystemType: "ext4",
            warning: null,
          },
          ...execution.planExtra,
        },
      };
    },
  });
  assert.equal(result.executed, false);
  const executionCall = calls.find(([type]) => type === "execute");
  assert.equal(executionCall[1].targetCpu, 7);
  assert.equal(executionCall[1].controllerCpu, 6);
  assert.deepEqual(executionCall[1].loadCpus, [0, 1]);
  assert.equal(executionCall[1].attemptsPerLeg, 20);
  assert.equal(executionCall[2].formatVersion, REFERENCE_CONFIRMATION_FORMAT_VERSION);
  assert.equal(executionCall[2].profile.id, "load-aba-discovered-confirmation");
  assert.equal(executionCall[2].planExtra.confirmation.protocol,
    REFERENCE_CONFIRMATION_PROTOCOL);
  assert.equal(executionCall[2].planExtra.confirmation.discoveryReport, value.report);
  const rendered = renderReferenceConfirmationDryRun(result.plan);
  assert.match(rendered, /Selected target CPU: 7/);
  assert.match(rendered, /Discovery samples are not included/);
  assert.match(rendered, /'\/opt\/fault affinity\/bin\/confirm-reference'/);
  assert.match(rendered, /'--yes'/);
});

test("singleton controller revalidation is explicit and ineligible sources never execute", async () => {
  const value = snapshot();
  let ownerChecks = 0;
  await executeReferenceConfirmation(parseReferenceConfirmationArgs([
    "--from-discovery", value.plan.storage.collectionDir,
  ]), {
    deriveReport: async () => value,
    readCurrentAllowedCpus: () => [6],
    revalidateContext: async () => { throw new Error("ordinary path must not run"); },
    revalidateOwnerContext: async () => { ownerChecks += 1; },
    buildSourceBinding: () => ({ sha256: "c".repeat(64) }),
    collectResources: () => ({ meetsMinimum: true }),
    executeProfile: async () => ({ executed: false, plan: {} }),
  });
  assert.equal(ownerChecks, 1);

  let executed = false;
  await assert.rejects(executeReferenceConfirmation(parseReferenceConfirmationArgs([
    "--from-discovery", value.plan.storage.collectionDir,
  ]), {
    deriveReport: async () => snapshot(null),
    executeProfile: async () => { executed = true; },
  }), /no candidate/);
  assert.equal(executed, false);
});

test("live confirmation refuses low memory before reaching the execution controller", async () => {
  const value = snapshot();
  let executed = false;
  await assert.rejects(executeReferenceConfirmation(parseReferenceConfirmationArgs([
    "--from-discovery", value.plan.storage.collectionDir, "--yes",
  ]), {
    deriveReport: async () => value,
    readCurrentAllowedCpus: () => [0, 1, 6, 7],
    revalidateContext: async () => {},
    buildSourceBinding: () => ({ sha256: "c".repeat(64) }),
    collectResources: () => ({ meetsMinimum: false }),
    executeProfile: async () => { executed = true; },
  }), /memory headroom/);
  assert.equal(executed, false);
});

test("live confirmation retains exclusive source ownership through execution", async () => {
  const value = snapshot();
  let locked = false;
  let releaseFirst;
  let enteredFirst;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const retainedCoordinator = { fd: 9, device: "1", inode: "2" };
  const withSnapshot = async (_directory, operation) => {
    if (locked) {
      throw Object.assign(new Error("busy"), { code: "BUNDLE_EXECUTION_LEASE_BUSY" });
    }
    locked = true;
    const coordinator = {
      retainedCoordinator,
      assertHeld: () => {
        if (!locked) throw new Error("source ownership was lost");
        return true;
      },
    };
    try { return await operation(value, coordinator); }
    finally { locked = false; }
  };
  const dependencies = {
    deriveReport: async () => value,
    readCurrentAllowedCpus: () => [6],
    withReferenceDiscoveryReportSnapshot: withSnapshot,
    revalidateOwnerContext: async () => ({ workloads: { measured: {}, auxiliary: {} } }),
    buildSourceBinding: () => ({ sha256: "c".repeat(64) }),
    collectResources: () => ({ meetsMinimum: true }),
    executeProfile: async (_options, execution) => {
      assert.equal(execution.retainedAuthorizationDirectory, retainedCoordinator);
      assert.equal(execution.assertAuthorizationHeld(), true);
      enteredFirst();
      await firstRelease;
      assert.equal(execution.assertAuthorizationHeld(), true);
      return { executed: true, status: "complete", plan: {} };
    },
  };
  const first = executeReferenceConfirmation(parseReferenceConfirmationArgs([
    "--from-discovery", value.plan.storage.collectionDir,
    "--output-name", "reference-confirmation-20260913T200002Z-first", "--yes",
  ]), dependencies);
  await firstEntered;
  await assert.rejects(executeReferenceConfirmation(parseReferenceConfirmationArgs([
    "--from-discovery", value.plan.storage.collectionDir,
    "--output-name", "reference-confirmation-20260913T200003Z-second", "--yes",
  ]), dependencies), (error) => error.code === "BUNDLE_EXECUTION_LEASE_BUSY");
  releaseFirst();
  assert.equal((await first).status, "complete");
});

test("source replacement and cancellation stop confirmation before admission", async () => {
  const value = snapshot();
  let ownershipHeld = true;
  let admitted = false;
  await assert.rejects(executeReferenceConfirmation(parseReferenceConfirmationArgs([
    "--from-discovery", value.plan.storage.collectionDir, "--yes",
  ]), {
    deriveReport: async () => value,
    readCurrentAllowedCpus: () => [6],
    withReferenceDiscoveryReportSnapshot: async (_directory, operation) => operation(value, {
      retainedCoordinator: { fd: 9, device: "1", inode: "2" },
      assertHeld: () => {
        if (!ownershipHeld) {
          throw Object.assign(new Error("source directory was replaced"), {
            code: "BUNDLE_EXECUTION_LEASE_LOST",
          });
        }
        return true;
      },
    }),
    revalidateOwnerContext: async () => ({ workloads: { measured: {}, auxiliary: {} } }),
    buildSourceBinding: () => ({ sha256: "c".repeat(64) }),
    collectResources: () => ({ meetsMinimum: true }),
    executeProfile: async (_options, execution) => {
      ownershipHeld = false;
      execution.assertAuthorizationHeld();
      admitted = true;
    },
  }), (error) => error.code === "BUNDLE_EXECUTION_LEASE_LOST");
  assert.equal(admitted, false);

  for (const abortDuring of ["derive", "revalidate"]) {
    const controller = new AbortController();
    let delegated = false;
    await assert.rejects(executeReferenceConfirmation(parseReferenceConfirmationArgs([
      "--from-discovery", value.plan.storage.collectionDir, "--yes",
    ]), {
      signal: controller.signal,
      deriveReport: async () => {
        if (abortDuring === "derive") controller.abort();
        return value;
      },
      readCurrentAllowedCpus: () => [0, 1, 6, 7],
      revalidateContext: async () => {
        if (abortDuring === "revalidate") controller.abort();
        return { workloads: { measured: {}, auxiliary: {} } };
      },
      reexecConfirmation: () => { delegated = true; },
    }), (error) => error.code === "REFERENCE_EXTERNAL_CANCEL");
    assert.equal(delegated, false);
  }
});

test("changed-boot and copied-host confirmation sources fail before execution", async () => {
  const value = snapshot();
  for (const message of ["boot identity changed", "machine identity changed after copy"]) {
    let executed = false;
    await assert.rejects(executeReferenceConfirmation(parseReferenceConfirmationArgs([
      "--from-discovery", value.plan.storage.collectionDir,
    ]), {
      deriveReport: async () => value,
      readCurrentAllowedCpus: () => [0, 1, 6, 7],
      revalidateContext: async () => {
        throw Object.assign(new Error(message), {
          code: "REFERENCE_DISCOVERY_PREVIEW_MISMATCH",
        });
      },
      executeProfile: async () => { executed = true; },
    }), new RegExp(message));
    assert.equal(executed, false);
  }
});

test("confirmation rejects output inside its source or verified app tree", async () => {
  const value = snapshot();
  const app = path.join(value.plan.identity.kitRoot, "app");
  for (const [resultsRoot, expected] of [
    [value.plan.storage.collectionDir, /inside the discovery source/],
    [path.join(value.plan.storage.collectionDir, "nested"), /inside the discovery source/],
    [app, /inside the verified kit app tree/],
    [path.join(app, "nested"), /inside the verified kit app tree/],
  ]) {
    let executed = false;
    await assert.rejects(executeReferenceConfirmation(parseReferenceConfirmationArgs([
      "--from-discovery", value.plan.storage.collectionDir,
      "--results-root", resultsRoot,
    ]), {
      deriveReport: async () => value,
      readCurrentAllowedCpus: () => [0, 1, 6, 7],
      revalidateContext: async () => ({ layout: { app } }),
      realpath: (entry) => entry,
      buildSourceBinding: () => ({ sha256: "c".repeat(64) }),
      collectResources: () => ({ meetsMinimum: true }),
      executeProfile: async () => { executed = true; },
    }), expected);
    assert.equal(executed, false);
  }
});

test("confirmation CLI stays dry by default and maps busy ownership", async () => {
  const output = [];
  const status = await runReferenceConfirmationCli([
    "--from-discovery", "/results/screen",
  ], {
    executeConfirmation: async (options) => ({
      executed: false,
      plan: { fixture: options.fromDiscovery },
    }),
    renderDryRun: () => "SAFE CONFIRMATION PREVIEW",
    output: (line) => output.push(line),
    errorOutput: (line) => output.push(line),
  });
  assert.equal(status, 0);
  assert.deepEqual(output, ["SAFE CONFIRMATION PREVIEW"]);

  const busy = await runReferenceConfirmationCli([
    "--from-discovery", "/results/screen",
  ], {
    executeConfirmation: async () => {
      throw Object.assign(new Error("busy"), { code: "BUNDLE_EXECUTION_LEASE_BUSY" });
    },
    output: () => {},
    errorOutput: () => {},
  });
  assert.equal(busy, 75);
});
