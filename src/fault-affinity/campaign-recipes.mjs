export const DEFAULT_CAMPAIGN_RECIPE = "wasm-churn-diagnose";

const RECIPES = Object.freeze({
  "wasm-churn-diagnose": Object.freeze({
    id: "wasm-churn-diagnose",
    label: "WebAssembly churn diagnose campaign",
    description: "Recommended dependency-free topology screen and focused yes-load A/B/A campaign.",
    measuredWorkload: "wasm-churn-suite",
    conditionWorkload: "yes-load",
    defaultProfile: "quick",
    recommended: true,
  }),
  "node-pglite-diagnose": Object.freeze({
    id: "node-pglite-diagnose",
    label: "Historical Node/PGlite diagnose campaign",
    description: "Historical heavyweight topology screen and focused yes-load A/B/A campaign.",
    measuredWorkload: "node-pglite-suite",
    conditionWorkload: "yes-load",
    defaultProfile: "quick",
    recommended: false,
  }),
});

export class CampaignRecipeError extends Error {
  constructor(message, code = "INVALID_CAMPAIGN_RECIPE") {
    super(message);
    this.name = "CampaignRecipeError";
    this.code = code;
  }
}

export function listCampaignRecipes() {
  return Object.freeze(Object.values(RECIPES));
}

export function resolveCampaignRecipe(id = DEFAULT_CAMPAIGN_RECIPE) {
  const recipe = RECIPES[id];
  if (recipe === undefined) {
    throw new CampaignRecipeError(
      `unknown campaign recipe '${id}'; choose: ${Object.keys(RECIPES).join(", ")}`,
    );
  }
  return recipe;
}
