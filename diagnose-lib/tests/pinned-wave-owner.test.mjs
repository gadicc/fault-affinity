import assert from "node:assert/strict";
import test from "node:test";

import { formatPinnedWaveFailureDetail } from
  "../../src/fault-affinity/pinned-wave-owner.mjs";

test("pinned owner failure detail identifies the first invalid CPU and cause", () => {
  assert.equal(formatPinnedWaveFailureDetail({
    committed: false,
    reason: "operational-invalid",
    invalidReason: "child affinity did not match",
    errorCode: "PINNED_WAVE_INVALID",
    attempts: [{
      status: "operational-invalid",
      record: { cpu: 8 },
      evidence: {
        outcome: { invalidReason: "child affinity did not match" },
      },
    }],
  }), "cpu=8; child affinity did not match; PINNED_WAVE_INVALID");
});

test("pinned owner failure detail remains absent for successful results", () => {
  assert.equal(formatPinnedWaveFailureDetail({
    committed: true,
    reason: "committed",
    attempts: [{ status: "valid", record: { cpu: 8 } }],
  }), null);
});
