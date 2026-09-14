export default {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "./packaging/semantic-release-plan-guard.mjs",
    [
      "@semantic-release/github",
      {
        assets: [
          { path: "dist/release/fault-affinity-live-linux-x64.tar.gz",
            label: "Linux x64 live-session reference kit" },
          { path: "dist/release/fault-affinity-live-linux-x64.tar.gz.sha256",
            label: "Linux x64 kit SHA-256" },
          { path: "dist/release/fault-affinity-sbom.spdx.json",
            label: "SPDX software bill of materials" },
          { path: "dist/release/fault-affinity-sbom.spdx.json.sha256",
            label: "SBOM SHA-256" },
          { path: "dist/release/SHA256SUMS", label: "Release SHA-256 manifest" },
        ],
        failCommentCondition: false,
        releasedLabels: ["released"],
      },
    ],
  ],
};
