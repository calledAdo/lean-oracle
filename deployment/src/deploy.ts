import type {
  CodeDeploymentArtifact,
  CodeDeploymentScriptFamily,
  DeploymentAction,
  DeploymentContext,
} from "./types.js";
import {
  deployCodeScript,
  verifyCodeDeploymentCandidate,
} from "./codeDeploy.js";
import { readCodeDeploymentArtifact } from "./artifacts.js";
import { deployGuardianSetStateCell } from "./guardianSetDeploy.js";
import { rotateGuardianSetStateCell } from "./guardianSetRotate.js";
import { deployOracleStateCell } from "./oracleDeploy.js";

const CHAIN_MUTATING_ACTIONS = new Set<DeploymentAction>([
  "deploy:guardian-set-type",
  "deploy:oracle-type",
  "deploy:owned-type-bind-lock",
  "deploy:guardian-set",
  "deploy:guardian-set-candidate",
  "rotate:guardian-set",
  "deploy:oracle",
]);

export function assertChainBroadcastAuthorized(ctx: {
  action: DeploymentAction;
  env: Pick<DeploymentContext["env"], "dryRun" | "broadcast">;
}): void {
  if (
    CHAIN_MUTATING_ACTIONS.has(ctx.action) &&
    ctx.env.dryRun === "false" &&
    ctx.env.broadcast !== "true"
  ) {
    throw new Error(
      "Refusing chain broadcast: set both DRY_RUN=false and BROADCAST=true",
    );
  }
}

function requireOracleOverride(ctx: {
  env: {
    oracleFeedId: string;
    oracleEmitterChain: string;
    oracleEmitterAddress: string;
  };
}) {
  if (
    !ctx.env.oracleFeedId ||
    !ctx.env.oracleEmitterChain ||
    !ctx.env.oracleEmitterAddress
  ) {
    throw new Error(
      "deploy:oracle requires ORACLE_FEED_ID, ORACLE_EMITTER_CHAIN, ORACLE_EMITTER_ADDRESS",
    );
  }
}

export async function runDeploymentAction(
  ctx: Pick<
    DeploymentContext,
    "action" | "network" | "config" | "env" | "paths"
  >,
): Promise<unknown> {
  assertChainBroadcastAuthorized(ctx);
  const mode = ctx.env.dryRun !== "false" ? "dry-run" : "broadcast-pending";

  function codeDeploymentPayload(
    scriptFamily: CodeDeploymentScriptFamily,
  ): CodeDeploymentArtifact & { mode: string; network: string } {
    return {
      mode,
      network: ctx.network,
      scriptFamily,
      latestCandidate: undefined,
      versions: {},
    };
  }

  switch (ctx.action as DeploymentAction) {
    case "deploy:guardian-set-type":
      return {
        ...codeDeploymentPayload("guardian-set-type"),
        latestCandidate: await deployCodeScript({
          ctx,
          scriptFamily: "guardian-set-type",
        }),
      };
    case "deploy:oracle-type":
      return {
        ...codeDeploymentPayload("oracle-type"),
        latestCandidate: await deployCodeScript({
          ctx,
          scriptFamily: "oracle-type",
        }),
      };
    case "deploy:owned-type-bind-lock":
      return {
        ...codeDeploymentPayload("owned-type-bind-lock"),
        latestCandidate: await deployCodeScript({
          ctx,
          scriptFamily: "owned-type-bind-lock",
        }),
      };
    case "promote:guardian-set-type":
      return promoteCodeDeployment(ctx, "guardian-set-type");
    case "promote:oracle-type":
      return promoteCodeDeployment(ctx, "oracle-type");
    case "promote:owned-type-bind-lock":
      return promoteCodeDeployment(ctx, "owned-type-bind-lock");
    case "deploy:guardian-set":
      return deployGuardianSetStateCell({ ctx });
    case "deploy:guardian-set-candidate":
      return deployGuardianSetStateCell({ ctx, candidate: true });
    case "rotate:guardian-set":
      return rotateGuardianSetStateCell({ ctx });
    case "deploy:oracle":
      requireOracleOverride(ctx);
      return deployOracleStateCell({ ctx });
  }
}

async function promoteCodeDeployment(
  ctx: Pick<
    DeploymentContext,
    "network" | "config" | "env" | "paths"
  >,
  scriptFamily: CodeDeploymentScriptFamily,
): Promise<CodeDeploymentArtifact> {
  const existing = readCodeDeploymentArtifact({
    deploymentRoot: ctx.paths.deploymentRoot,
    network: ctx.network,
    scriptFamily,
  });
  const deployment = existing?.deployment;
  if (!deployment || typeof deployment !== "object") {
    throw new Error(
      `Missing code deployment artifact for ${ctx.network}.${scriptFamily}`,
    );
  }
  const artifact = deployment as CodeDeploymentArtifact;
  if (!artifact.latestCandidate) {
    throw new Error(
      `No latestCandidate to promote for ${ctx.network}.${scriptFamily}`,
    );
  }

  await verifyCodeDeploymentCandidate({
    ctx,
    scriptFamily,
    candidate: artifact.latestCandidate,
  });

  const versions = artifact.versions ?? {};
  const existingVersions = Object.keys(versions)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const nextVersion =
    (existingVersions.length ? Math.max(...existingVersions) : 0) + 1;

  return {
    scriptFamily,
    latestCandidate: undefined,
    versions: {
      ...versions,
      [nextVersion]: {
        ...artifact.latestCandidate,
        version: nextVersion,
        promotedAt: new Date().toISOString(),
      },
    },
  };
}
