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
  const prepared = prepareDeploymentArtifact(
    deploymentRoot,
    network,
    action,
    deployment,
  );
  writePreparedArtifactsAtomically([prepared]);
  return prepared;
}

interface PreparedDeploymentArtifact {
  artifactPath: string;
  envelope: DeploymentArtifactEnvelope;
}

function prepareDeploymentArtifact(
  deploymentRoot: string,
  network: DeploymentNetwork,
  action: DeploymentAction,
  deployment: unknown,
): PreparedDeploymentArtifact {
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

  return { artifactPath, envelope };
}

function serializeArtifact(envelope: DeploymentArtifactEnvelope): string {
  return JSON.stringify(
    envelope,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

/**
 * Stage every artifact beside its destination, then atomically rename each
 * completed file. On a synchronous failure, already-renamed destinations are
 * restored from their captured bytes so the action remains all-or-nothing.
 */
function writePreparedArtifactsAtomically(
  prepared: PreparedDeploymentArtifact[],
): void {
  const nonce = `${String(process.pid)}-${Date.now().toString(36)}`;
  const staged = prepared.map((item, index) => ({
    ...item,
    tempPath: `${item.artifactPath}.${nonce}-${String(index)}.tmp`,
    original: fs.existsSync(item.artifactPath)
      ? fs.readFileSync(item.artifactPath)
      : undefined,
  }));
  const renamed: typeof staged = [];

  try {
    for (const item of staged) {
      fs.writeFileSync(item.tempPath, serializeArtifact(item.envelope));
    }
    for (const item of staged) {
      fs.renameSync(item.tempPath, item.artifactPath);
      renamed.push(item);
    }
  } catch (error) {
    for (const item of staged) {
      if (fs.existsSync(item.tempPath)) fs.unlinkSync(item.tempPath);
    }
    for (const item of renamed.reverse()) {
      if (item.original === undefined) {
        if (fs.existsSync(item.artifactPath)) fs.unlinkSync(item.artifactPath);
        continue;
      }
      const restorePath = `${item.artifactPath}.${nonce}.restore.tmp`;
      fs.writeFileSync(restorePath, item.original);
      fs.renameSync(restorePath, item.artifactPath);
    }
    throw error;
  }
}

function isDryRunDeployment(deployment: unknown): boolean {
  return (
    !!deployment &&
    typeof deployment === "object" &&
    (deployment as { mode?: unknown }).mode === "dry-run"
  );
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
  artifactPaths: string[];
  artifactPath?: string;
  envelope?: DeploymentArtifactEnvelope;
} {
  if (isDryRunDeployment(deployment)) {
    return { artifactPaths: [] };
  }

  const primary = prepareDeploymentArtifact(
    deploymentRoot,
    network,
    action,
    deployment,
  );
  const prepared = [primary];

  if (action === "rotate:guardian-set" && deployment && typeof deployment === "object") {
    const canonicalState = (deployment as { canonicalState?: unknown }).canonicalState;
    if (canonicalState !== undefined) {
      const canonical = prepareDeploymentArtifact(
        deploymentRoot,
        network,
        "deploy:guardian-set",
        canonicalState,
      );
      prepared.push(canonical);
    }
  }

  // Advance the canonical pointer before its audit receipt. A process crash
  // between the two atomic renames can then lose only audit freshness; state
  // consumers never observe a newer receipt paired with a stale live pointer.
  const writeOrder =
    prepared.length === 2 ? [prepared[1]!, prepared[0]!] : prepared;
  writePreparedArtifactsAtomically(writeOrder);
  return {
    ...primary,
    artifactPaths: prepared.map((item) => item.artifactPath),
  };
}
