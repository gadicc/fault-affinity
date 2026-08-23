import { canonicalProtocolJson } from "../../diagnose-lib/pinned-protocol.mjs";
import { parseControlledLoadPlan } from "./controlled-load-plan.mjs";
import { parsePinnedPlan } from "./pinned-plan.mjs";
import { PlanFileError, readPlanJsonFile } from "./plan-file.mjs";

export const CAMPAIGN_PLAN_FILE_VERSION = 1;

export class CampaignPlanError extends Error {
  constructor(message, code = "INVALID_CAMPAIGN_PLAN") {
    super(message);
    this.name = "CampaignPlanError";
    this.code = code;
  }
}

function fail(message, code) {
  throw new CampaignPlanError(message, code);
}

function plainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
}

function exactKeys(value, expected, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length ||
      actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseCampaignPlan(value) {
  exactKeys(value, [
    "version", "baseline", "groups", "pinnedConcurrent", "exact", "controlledLoad",
  ], "campaign plan");
  if (value.version !== CAMPAIGN_PLAN_FILE_VERSION) {
    fail(`campaign plan version must be ${CAMPAIGN_PLAN_FILE_VERSION}`);
  }

  let topology;
  let controlled;
  try {
    topology = parsePinnedPlan({
      version: 1,
      baseline: value.baseline,
      groups: value.groups,
      pinnedConcurrent: value.pinnedConcurrent,
      exact: value.exact,
    });
    controlled = parseControlledLoadPlan({
      version: 1,
      controlledLoad: value.controlledLoad,
      exact: value.exact,
    });
  } catch (error) {
    fail(`campaign phase plan is invalid: ${error.message}`);
  }
  if (canonicalProtocolJson(topology.exact) !== canonicalProtocolJson(controlled.exact)) {
    fail("campaign exact schedules do not reconcile");
  }
  return deepFreeze({
    version: CAMPAIGN_PLAN_FILE_VERSION,
    baseline: topology.baseline,
    groups: topology.groups,
    pinnedConcurrent: topology.pinnedConcurrent,
    exact: topology.exact,
    controlledLoad: controlled.controlledLoad,
  });
}

export function readCampaignPlanFile(filename) {
  try {
    return parseCampaignPlan(readPlanJsonFile(filename));
  } catch (error) {
    if (!(error instanceof PlanFileError)) throw error;
    throw new CampaignPlanError(error.message,
      error.code === "PLAN_FILE_CHANGED"
        ? "CAMPAIGN_PLAN_FILE_CHANGED"
        : error.code === "PLAN_FILE_CONTENT_ERROR"
          ? "INVALID_CAMPAIGN_PLAN"
          : "CAMPAIGN_PLAN_FILE_ERROR");
  }
}
