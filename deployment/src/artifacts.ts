import fs from "node:fs";
import path from "node:path";

import type {
  CodeDeploymentArtifact,
  CodeDeploymentScriptFamily,
  DeploymentAction,
  DeploymentArtifactEnvelope,
  DeploymentNetwork,
} from "./types.js";

function isCodeDeploymentArtifact(deployment: unknown): deployment is CodeDeploymentArtifact {
  if (!deployment || typeof deployment !== "object") return false;
  const d = deployment as { scriptFamily?: unknown; versions?: unknown };
  return typeof d.scriptFamily === "string" && !!d.versions && typeof d.versions === "object";
}

export function codeArtifactPath(
  deploymentRoot: string,
  network: DeploymentNetwork,
  scriptFamily: CodeDeploymentScriptFamily,
) {
  return path.join(deploymentRoot, "artifacts", `${network}.${scriptFamily}.json`);
}

export function readCodeDeploymentArtifact(params: {
  deploymentRoot: string;
  network: DeploymentNetwork;
  scriptFamily: CodeDeploymentScriptFamily;
}): DeploymentArtifactEnvelope | null {
  const artifactPath = codeArtifactPath(
    params.deploymentRoot,
    params.network,
    params.scriptFamily,
  );
  if (!fs.existsSync(artifactPath)) return null;
  const raw = fs.readFileSync(artifactPath, "utf8");
  return JSON.parse(raw) as DeploymentArtifactEnvelope;
}

export function writeDeploymentArtifact(
  deploymentRoot: string,
  network: DeploymentNetwork,
  action: DeploymentAction,
  deployment: unknown,
): { artifactPath: string; envelope: DeploymentArtifactEnvelope } {
  const artifactDir = path.join(deploymentRoot, "artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });

  // Code-deployment artifacts are keyed by (network, script family) to support:
  // - a stable `versions` map (canonical numeric versions)
  // - a separate `latestCandidate` record
  const filename = isCodeDeploymentArtifact(deployment)
    ? `${network}.${deployment.scriptFamily}.json`
    : `${network}.${action.replaceAll(":", "-")}.json`;
  const artifactPath = path.join(artifactDir, filename);

  const mergedDeployment = (() => {
    if (!isCodeDeploymentArtifact(deployment)) return deployment;
    if (!fs.existsSync(artifactPath)) return deployment;
    try {
      const prev = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
        deployment?: unknown;
      };
      const prevDep = prev.deployment;
      if (!isCodeDeploymentArtifact(prevDep)) return deployment;
      // Preserve canonical versions unless the caller explicitly provides them.
      const next = deployment as CodeDeploymentArtifact;
      return {
        ...next,
        versions:
          Object.keys(next.versions).length > 0 ? next.versions : prevDep.versions,
      } satisfies CodeDeploymentArtifact;
    } catch {
      return deployment;
    }
  })();

  const envelope: DeploymentArtifactEnvelope = {
    network,
    action,
    generatedAt: new Date().toISOString(),
    deployment: mergedDeployment,
  };

  fs.writeFileSync(
    artifactPath,
    JSON.stringify(
      envelope,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
  );
  return { artifactPath, envelope };
}

/**
 * Write an action receipt and any canonical state projection it advances.
 * Guardian rotation keeps its audit receipt while replacing the live-state
 * pointer consumed by later deployment actions.
 */
export function writeDeploymentActionArtifacts(
  deploymentRoot: string,
  network: DeploymentNetwork,
  action: DeploymentAction,
  deployment: unknown,
): {
  artifactPath: string;
  artifactPaths: string[];
  envelope: DeploymentArtifactEnvelope;
} {
  const primary = writeDeploymentArtifact(
    deploymentRoot,
    network,
    action,
    deployment,
  );
  const artifactPaths = [primary.artifactPath];

  if (action === "rotate:guardian-set" && deployment && typeof deployment === "object") {
    const canonicalState = (deployment as { canonicalState?: unknown }).canonicalState;
    if (canonicalState !== undefined) {
      const canonical = writeDeploymentArtifact(
        deploymentRoot,
        network,
        "deploy:guardian-set",
        canonicalState,
      );
      artifactPaths.push(canonical.artifactPath);
    }
  }

  return { ...primary, artifactPaths };
}
