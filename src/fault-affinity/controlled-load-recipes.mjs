import {
  MAX_CONTROLLED_LOAD_ATTEMPTS_PER_LEG,
} from "../../diagnose-lib/controlled-load-session.mjs";
import {
  MAX_CPU_ID,
  MAX_SCHEDULE_ENTRIES,
  MAX_SEED,
  compressCpuList,
} from "../../diagnose-lib/pinned-runner.mjs";
import { parseControlledLoadPlan } from "./controlled-load-plan.mjs";

export const DEFAULT_CONTROLLED_LOAD_CONDITION = "yes-load";

const RECIPES = Object.freeze({
  "wasm-churn-aba": Object.freeze({
    id: "wasm-churn-aba",
    label: "WebAssembly churn under controlled load",
    description: "Recommended reduced WebAssembly A1/B/A2 comparison with pinned yes workers.",
    measuredWorkload: "wasm-churn",
    conditionWorkload: DEFAULT_CONTROLLED_LOAD_CONDITION,
    defaults: Object.freeze({
      attemptsPerLeg: 10,
      warmupMs: 0,
      recoveryMs: 15_000,
      exactRounds: 10,
      seed: 17,
    }),
  }),
});

export class ControlledLoadRecipeError extends Error {
  constructor(message, code = "INVALID_CONTROLLED_LOAD_RECIPE") {
    super(message);
    this.name = "ControlledLoadRecipeError";
    this.code = code;
  }
}

function fail(message) {
  throw new ControlledLoadRecipeError(message);
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

export function listControlledLoadRecipes() {
  return Object.freeze(Object.values(RECIPES).map((recipe) => Object.freeze({
    id: recipe.id,
    label: recipe.label,
    description: recipe.description,
    measuredWorkload: recipe.measuredWorkload,
    conditionWorkload: recipe.conditionWorkload,
    required: Object.freeze(["targetCpu", "loadCpus"]),
    defaults: recipe.defaults,
  })));
}

export function resolveControlledLoadRecipe(id) {
  const recipe = RECIPES[id];
  if (recipe === undefined) {
    fail(`unknown controlled-load recipe '${id}'; choose: ${Object.keys(RECIPES).join(", ")}`);
  }
  return recipe;
}

export function buildControlledLoadRecipePlan(id, options) {
  const recipe = resolveControlledLoadRecipe(id);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    fail("controlled-load recipe options must be an object");
  }
  const expected = [
    "targetCpu", "loadCpus", "attemptsPerLeg", "warmupMs", "recoveryMs",
    "exactCpus", "exactRounds", "seed",
  ];
  const unexpected = Object.keys(options).filter((key) => !expected.includes(key));
  if (unexpected.length > 0) {
    fail(`controlled-load recipe options contain unknown field '${unexpected.sort()[0]}'`);
  }
  const targetCpu = integer(options.targetCpu, "recipe target CPU", 0, MAX_CPU_ID);
  if (!Array.isArray(options.loadCpus) || options.loadCpus.length === 0) {
    fail("recipe load CPUs must be a nonempty array");
  }
  const loadCpuSpec = compressCpuList(options.loadCpus);
  const exactCpus = options.exactCpus ?? [targetCpu];
  const plan = parseControlledLoadPlan({
    version: 1,
    controlledLoad: {
      targetCpu,
      workerCpus: loadCpuSpec,
      attemptsPerLeg: integer(
        options.attemptsPerLeg ?? recipe.defaults.attemptsPerLeg,
        "recipe attempts per leg",
        1,
        MAX_CONTROLLED_LOAD_ATTEMPTS_PER_LEG,
      ),
      warmupMs: integer(options.warmupMs ?? recipe.defaults.warmupMs,
        "recipe warm-up", 0, 3_600_000),
      recoveryMs: integer(options.recoveryMs ?? recipe.defaults.recoveryMs,
        "recipe recovery", 0, 3_600_000),
    },
    exact: {
      cpus: compressCpuList(exactCpus),
      rounds: integer(options.exactRounds ?? recipe.defaults.exactRounds,
        "recipe exact rounds", 1, MAX_SCHEDULE_ENTRIES),
      seed: integer(options.seed ?? recipe.defaults.seed, "recipe seed", 0, MAX_SEED),
    },
  });
  return Object.freeze({ recipe, plan });
}
