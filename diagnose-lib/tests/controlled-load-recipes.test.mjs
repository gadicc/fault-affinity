import assert from "node:assert/strict";
import test from "node:test";

import {
  buildControlledLoadRecipePlan,
  ControlledLoadRecipeError,
  listControlledLoadRecipes,
  resolveControlledLoadRecipe,
} from "../../src/fault-affinity/controlled-load-recipes.mjs";

test("the WebAssembly controlled-load recipe publishes explicit identities and bounded defaults", () => {
  const listed = listControlledLoadRecipes();
  assert.deepEqual(listed.map(({ id }) => id), ["wasm-churn-aba"]);
  assert.equal(listed[0].measuredWorkload, "wasm-churn");
  assert.equal(listed[0].conditionWorkload, "yes-load");
  assert.deepEqual(listed[0].required, ["targetCpu", "loadCpus"]);
  assert.equal(Object.isFrozen(listed[0].defaults), true);

  const { recipe, plan } = buildControlledLoadRecipePlan("wasm-churn-aba", {
    targetCpu: 19,
    loadCpus: [0, 1, 2, 3, 4, 5, 6, 7],
  });
  assert.equal(recipe, resolveControlledLoadRecipe("wasm-churn-aba"));
  assert.deepEqual(plan.controlledLoad, {
    targetCpu: 19,
    workerCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    attemptsPerLeg: 10,
    warmupMs: 0,
    recoveryMs: 15_000,
  });
  assert.deepEqual(plan.exact, { cpus: [19], rounds: 10, seed: 17 });
});

test("controlled-load recipe overrides remain validated by the canonical plan boundary", () => {
  const { plan } = buildControlledLoadRecipePlan("wasm-churn-aba", {
    targetCpu: 4,
    loadCpus: [0, 1],
    attemptsPerLeg: 3,
    warmupMs: 25,
    recoveryMs: 50,
    exactCpus: [4, 5],
    exactRounds: 2,
    seed: 99,
  });
  assert.deepEqual(plan.controlledLoad, {
    targetCpu: 4,
    workerCpus: [0, 1],
    attemptsPerLeg: 3,
    warmupMs: 25,
    recoveryMs: 50,
  });
  assert.deepEqual(plan.exact, { cpus: [4, 5], rounds: 2, seed: 99 });

  assert.throws(() => resolveControlledLoadRecipe("missing"),
    (error) => error instanceof ControlledLoadRecipeError && /unknown/.test(error.message));
  assert.throws(() => buildControlledLoadRecipePlan("wasm-churn-aba", {
    targetCpu: 1,
    loadCpus: [1, 2],
  }), /targetCpu must be outside workerCpus/);
  assert.throws(() => buildControlledLoadRecipePlan("wasm-churn-aba", {
    targetCpu: 1,
    loadCpus: [],
  }), /nonempty array/);
});
