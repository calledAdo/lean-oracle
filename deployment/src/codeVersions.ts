import { readCodeDeploymentArtifact } from "./artifacts.js";
import type {
  CodeDeploymentArtifact,
  CodeDeploymentScriptFamily,
  CodeDeploymentVersionRecord,
  DeploymentNetwork,
} from "./types.js";

export function loadLatestCanonicalCodeVersion(params: {
  deploymentRoot: string;
  network: DeploymentNetwork;
  scriptFamily: CodeDeploymentScriptFamily;
}): CodeDeploymentVersionRecord {
  const envelope = readCodeDeploymentArtifact(params);
  const deployment = envelope?.deployment;
  if (!deployment || typeof deployment !== "object") {
    throw new Error(
      `Missing ${params.scriptFamily} code deployment artifact for ${params.network}`,
    );
  }
  const versions = (deployment as CodeDeploymentArtifact).versions;
  const versionNumbers = Object.keys(versions ?? {})
    .map(Number)
    .filter((version) => Number.isInteger(version) && version >= 0);
  if (versionNumbers.length === 0) {
    throw new Error(
      `No canonical ${params.scriptFamily} version for ${params.network}`,
    );
  }
  const latest = versions[Math.max(...versionNumbers)];
  if (!latest) {
    throw new Error(`Failed to resolve canonical ${params.scriptFamily} version`);
  }
  return latest;
}
