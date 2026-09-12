import { requireCondition, SHA256_RE } from "./common.mjs";

export const RECOVERY_ASSET_NAMES = Object.freeze([
  "fault-affinity-live-linux-x64.tar.gz",
  "fault-affinity-live-linux-x64.tar.gz.sha256",
  "fault-affinity-sbom.spdx.json",
  "fault-affinity-sbom.spdx.json.sha256",
  "SHA256SUMS",
]);

export function classifyRecoveryState({ tagExists, tagCommit, expectedCommit, release, localAssets }) {
  requireCondition(tagExists, "recovery refuses to create a missing release tag",
    "RECOVERY_TAG_ABSENT");
  requireCondition(tagCommit === expectedCommit, "release tag points to a conflicting commit",
    "RECOVERY_TAG_CONFLICT");
  if (release === null) return { state: "tag-without-release", missing: [...localAssets.keys()] };
  const remote = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const [name, local] of localAssets) {
    const asset = remote.get(name);
    if (asset === undefined) continue;
    requireCondition(asset.size === local.size && asset.digest === `sha256:${local.sha256}`,
    `published asset conflicts with retained bytes: ${name}`, "RECOVERY_ASSET_CONFLICT");
  }
  for (const name of remote.keys()) {
    requireCondition(localAssets.has(name), `release contains unexpected asset: ${name}`,
      "RECOVERY_ASSET_CONFLICT");
  }
  const missing = [...localAssets.keys()].filter((name) => !remote.has(name));
  if (!release.draft) {
    requireCondition(missing.length === 0, "published release is missing retained assets",
      "RECOVERY_PUBLISHED_INCOMPLETE");
    return { state: "published-complete", missing: [] };
  }
  return { state: "matching-draft", missing };
}
