import { COMMIT_RE, requireCondition, VERSION_RE } from "./lib/common.mjs";

export async function verifyRelease(_pluginConfig, context) {
  const expectedVersion = process.env.EXPECTED_RELEASE_VERSION;
  const expectedCommit = process.env.EXPECTED_RELEASE_COMMIT;
  // A dry-run plan deliberately has no expected values. The publish invocation
  // must provide both, making this check run before semantic-release creates a
  // tag or calls the GitHub publisher.
  if (expectedVersion === undefined && expectedCommit === undefined) return;
  requireCondition(VERSION_RE.test(expectedVersion ?? ""),
    "EXPECTED_RELEASE_VERSION must be a semantic version", "RELEASE_PLAN_MISMATCH");
  requireCondition(COMMIT_RE.test(expectedCommit ?? ""),
    "EXPECTED_RELEASE_COMMIT must be a 40-hex commit", "RELEASE_PLAN_MISMATCH");
  requireCondition(context.nextRelease?.version === expectedVersion,
    `semantic-release planned ${context.nextRelease?.version ?? "no version"}, expected ${expectedVersion}`,
    "RELEASE_PLAN_MISMATCH");
  requireCondition(context.nextRelease?.gitHead === expectedCommit,
    `semantic-release git head ${context.nextRelease?.gitHead ?? "unknown"} does not match ${expectedCommit}`,
    "RELEASE_PLAN_MISMATCH");
}
