#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJson, requireCondition } from "./lib/common.mjs";

export function readReleaseReadiness(file) {
  const value = readJson(file);
  const requiredGates = [
    "releaseRecoveryRehearsal",
    "remoteProtectionsConfirmed",
    "resultPreparationLeaseVerified",
    "ubuntu2604LiveAcceptance",
  ];
  requireCondition(value.schemaVersion === 1 && typeof value.publicReleaseEnabled === "boolean" &&
    value.gates !== null && typeof value.gates === "object" && !Array.isArray(value.gates) &&
    Object.keys(value.gates).sort().join(",") === requiredGates.join(",") &&
    Object.values(value.gates).every((gate) => typeof gate === "boolean"),
  "release readiness manifest is invalid", "INVALID_RELEASE_READINESS");
  requireCondition(value.publicReleaseEnabled === Object.values(value.gates).every(Boolean),
    "release readiness flag and named gates disagree", "INVALID_RELEASE_READINESS");
  return value;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const [file, githubOutput] = process.argv.slice(2);
    requireCondition(file && githubOutput,
      "usage: release-readiness.mjs MANIFEST GITHUB_OUTPUT");
    const readiness = readReleaseReadiness(file);
    appendFileSync(githubOutput, `enabled=${readiness.publicReleaseEnabled}\n`);
    if (!readiness.publicReleaseEnabled) {
      process.stdout.write(`Public release remains disabled by:\n${Object.entries(readiness.gates)
        .filter(([, enabled]) => !enabled).map(([name]) => `- ${name}`).join("\n")}\n`);
    }
  } catch (error) {
    process.stderr.write(`release-readiness: ${error.message}\n`);
    process.exitCode = 1;
  }
}
