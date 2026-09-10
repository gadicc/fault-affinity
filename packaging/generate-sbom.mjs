import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJson, requireCondition, VERSION_RE, writeCanonicalJson } from "./lib/common.mjs";
import { loadRuntimeLock } from "./lib/runtime-lock.mjs";

export function buildSpdx({ packageLock, runtimeLock, version, commit, created }) {
  requireCondition(VERSION_RE.test(version), "SBOM version is invalid", "INVALID_SBOM_INPUT");
  requireCondition(/^[0-9a-f]{40}$/.test(commit), "SBOM commit is invalid", "INVALID_SBOM_INPUT");
  requireCondition(!Number.isNaN(Date.parse(created)), "SBOM creation time is invalid",
    "INVALID_SBOM_INPUT");
  const lock = readJson(packageLock);
  const runtimes = loadRuntimeLock(runtimeLock).platforms["linux-x64"];
  const pglite = lock.packages?.["node_modules/@electric-sql/pglite"];
  requireCondition(pglite?.version === "0.5.4" && typeof pglite.integrity === "string",
    "package lock does not contain the frozen PGlite dependency", "INVALID_SBOM_INPUT");
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `fault-affinity-${version}-linux-x64`,
    documentNamespace: `https://github.com/gadicc/fault-affinity/releases/tag/v${version}#sbom-${commit}`,
    creationInfo: { created, creators: ["Tool: fault-affinity-packaging-1"] },
    packages: [
      {
        name: "fault-affinity",
        SPDXID: "SPDXRef-Package-fault-affinity",
        versionInfo: version,
        downloadLocation: `https://github.com/gadicc/fault-affinity/tree/${commit}`,
        filesAnalyzed: false,
        licenseConcluded: "MIT",
        licenseDeclared: "MIT",
        copyrightText: "NOASSERTION",
      },
      {
        name: "@electric-sql/pglite",
        SPDXID: "SPDXRef-Package-pglite",
        versionInfo: pglite.version,
        downloadLocation: pglite.resolved,
        filesAnalyzed: false,
        licenseConcluded: "Apache-2.0",
        licenseDeclared: "Apache-2.0",
        copyrightText: "NOASSERTION",
        externalRefs: [{
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: `pkg:npm/%40electric-sql/pglite@${pglite.version}`,
        }],
        packageVerificationCode: undefined,
        comment: `npm lock integrity: ${pglite.integrity}`,
      },
      ...Object.entries(runtimes).map(([role, item]) => ({
        name: `Node.js ${role} runtime`,
        SPDXID: `SPDXRef-Package-node-${role}`,
        versionInfo: item.version.slice(1),
        downloadLocation: item.url,
        filesAnalyzed: false,
        licenseConcluded: "MIT",
        licenseDeclared: "MIT",
        copyrightText: "NOASSERTION",
        checksums: [{ algorithm: "SHA256", checksumValue: item.sha256 }],
      })),
    ],
    relationships: [
      { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES",
        relatedSpdxElement: "SPDXRef-Package-fault-affinity" },
      { spdxElementId: "SPDXRef-Package-fault-affinity", relationshipType: "DEPENDS_ON",
        relatedSpdxElement: "SPDXRef-Package-pglite" },
      ...Object.keys(runtimes).map((role) => ({
        spdxElementId: "SPDXRef-Package-fault-affinity",
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: `SPDXRef-Package-node-${role}`,
      })),
    ],
  };
}

const invoked = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [packageLock, runtimeLock, version, commit, created, output] = process.argv.slice(2);
  requireCondition([packageLock, runtimeLock, version, commit, created, output].every(Boolean),
    "usage: generate-sbom PACKAGE_LOCK RUNTIME_LOCK VERSION COMMIT CREATED OUTPUT");
  writeCanonicalJson(output, buildSpdx({ packageLock, runtimeLock, version, commit, created }));
}
