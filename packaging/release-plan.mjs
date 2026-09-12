#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semanticRelease from "semantic-release";

import { COMMIT_RE, requireCondition, writeCanonicalJson } from "./lib/common.mjs";

function parseArguments(args) {
  const result = { output: null, githubOutput: null, commit: process.env.GITHUB_SHA ?? null };
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    requireCondition(value !== undefined, `missing value for ${args[index]}`);
    if (args[index] === "--output") result.output = path.resolve(value);
    else if (args[index] === "--github-output") result.githubOutput = path.resolve(value);
    else if (args[index] === "--commit") result.commit = value;
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  requireCondition(result.output && COMMIT_RE.test(result.commit ?? ""),
    "--output and a 40-hex --commit (or GITHUB_SHA) are required");
  return result;
}

export async function calculateReleasePlan({ cwd = process.cwd(), commit, semantic = semanticRelease }) {
  requireCondition(COMMIT_RE.test(commit), "release-plan commit must be 40-hex");
  const result = await semantic({ dryRun: true, ci: true }, { cwd, env: process.env });
  if (result === false) return { schemaVersion: 1, status: "no-release", commit };
  requireCondition(result.lastRelease && result.nextRelease,
    "semantic-release returned an incomplete plan", "INVALID_RELEASE_PLAN");
  requireCondition(result.nextRelease.gitHead === commit,
    "semantic-release planned a different git head", "INVALID_RELEASE_PLAN");
  return {
    schemaVersion: 1,
    status: "release",
    commit,
    lastRelease: {
      version: result.lastRelease.version,
      gitTag: result.lastRelease.gitTag,
      gitHead: result.lastRelease.gitHead,
    },
    nextRelease: {
      type: result.nextRelease.type,
      version: result.nextRelease.version,
      gitTag: result.nextRelease.gitTag,
      gitHead: result.nextRelease.gitHead,
      notes: result.nextRelease.notes,
    },
  };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const options = parseArguments(process.argv.slice(2));
  try {
    const plan = await calculateReleasePlan({ commit: options.commit });
    writeCanonicalJson(options.output, plan);
    if (options.githubOutput) {
      writeFileSync(options.githubOutput,
        `status=${plan.status}\nversion=${plan.nextRelease?.version ?? ""}\n` +
        `tag=${plan.nextRelease?.gitTag ?? ""}\ncommit=${plan.commit}\n`, { flag: "a" });
    }
  } catch (error) {
    process.stderr.write(`release-plan: ${error.message}\n`);
    process.exitCode = 1;
  }
}
