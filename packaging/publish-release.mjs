#!/usr/bin/env node
import semanticRelease from "semantic-release";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMIT_RE, requireCondition, VERSION_RE } from "./lib/common.mjs";

export async function publishPlannedRelease({
  cwd = process.cwd(),
  expectedVersion,
  expectedCommit,
  actualCommit = expectedCommit,
  semantic = semanticRelease,
}) {
  requireCondition(VERSION_RE.test(expectedVersion ?? "") && COMMIT_RE.test(expectedCommit ?? ""),
    "publish requires a planned semantic version and 40-hex commit", "INVALID_RELEASE_PLAN");
  const result = await semantic({ ci: true }, { cwd, env: process.env });
  requireCondition(result !== false,
    "semantic-release returned no release after a release was planned", "RELEASE_PLAN_MISMATCH");
  requireCondition(result.nextRelease?.version === expectedVersion &&
    result.nextRelease?.gitHead === expectedCommit &&
    actualCommit === expectedCommit,
  "published release does not match the retained plan", "RELEASE_PLAN_MISMATCH");
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    await publishPlannedRelease({
      expectedVersion: process.env.EXPECTED_RELEASE_VERSION,
      expectedCommit: process.env.EXPECTED_RELEASE_COMMIT,
      actualCommit: process.env.GITHUB_SHA,
    });
  } catch (error) {
    process.stderr.write(`publish-release: ${error.message}\n`);
    process.exitCode = 1;
  }
}
