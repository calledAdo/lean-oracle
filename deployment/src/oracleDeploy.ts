import { ccc } from "@ckb-ccc/core";
import fs from "node:fs";
import path from "node:path";

import { createCccClient, createPrivateKeySigner } from "./ccc.js";
import { readCodeDeploymentArtifact } from "./artifacts.js";
import type {
  CodeDeploymentArtifact,
  CodeDeploymentVersionRecord,
  DeploymentContext,
  DeploymentNetwork,
  ScriptHashType,
} from "./types.js";

function assertHexBytes(name: string, value: string, byteLen: number) {
  if (!value.startsWith("0x")) throw new Error(`${name} must start with 0x`);
  const hex = value.slice(2);
  if (hex.length !== byteLen * 2) {
    throw new Error(`${name} must be ${byteLen} bytes (0x + ${byteLen * 2} hex chars)`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`${name} must be hex`);
}

function parseU32(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
    throw new Error(`${name} must be a u32 integer`);
  }
  return n;
}

function selectLatestCanonicalVersion(
  versions: Record<number, CodeDeploymentVersionRecord>,
): CodeDeploymentVersionRecord {
  const keys = Object.keys(versions)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (keys.length === 0) throw new Error("No canonical versions present");
  const max = Math.max(...keys);
  const record = versions[max];
  if (!record) throw new Error("Failed to resolve selected canonical version record");
  return record;
}

function loadOracleTypeVersion(params: {
  deploymentRoot: string;
  network: DeploymentNetwork;
}): CodeDeploymentVersionRecord {
  const env = readCodeDeploymentArtifact({
    deploymentRoot: params.deploymentRoot,
    network: params.network,
    scriptFamily: "oracle-type",
  });
  const deployment = env?.deployment;
  if (!deployment || typeof deployment !== "object") {
    throw new Error(`Missing oracle-type code deployment artifact for ${params.network}`);
  }
  const artifact = deployment as CodeDeploymentArtifact;
  return selectLatestCanonicalVersion(artifact.versions as Record<number, CodeDeploymentVersionRecord>);
}

type GuardianSetStateArtifact = {
  kind: "deploy:guardian-set";
  mode: "dry-run" | "broadcast";
  network: DeploymentNetwork;
  guardianSetType: { version: number; codeHash: string; hashType: string; depType: "code" };
  deployed?: { txHash: string; index: number; typeIdArgs: string };
};

function loadGuardianSetStateArtifact(params: {
  deploymentRoot: string;
  network: DeploymentNetwork;
}): GuardianSetStateArtifact {
  const p = path.join(params.deploymentRoot, "artifacts", `${params.network}.deploy-guardian-set.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing guardian-set state artifact: ${p}`);
  }
  const env = JSON.parse(fs.readFileSync(p, "utf8")) as { deployment?: unknown };
  const deployment = env.deployment;
  if (!deployment || typeof deployment !== "object") {
    throw new Error("Malformed guardian-set state artifact (missing deployment payload)");
  }
  return deployment as GuardianSetStateArtifact;
}

function encodeOracleData(params: {
  feedIdHex: string;
  guardianSetTypeHashHex: string;
  emitterChain: number;
  emitterAddressHex: string;
}): Uint8Array {
  assertHexBytes("ORACLE_FEED_ID", params.feedIdHex, 32);
  assertHexBytes("guardian_set_type_hash", params.guardianSetTypeHashHex, 32);
  assertHexBytes("ORACLE_EMITTER_ADDRESS", params.emitterAddressHex, 32);

  const out = new Uint8Array(152);
  out.set(ccc.bytesFrom(params.feedIdHex), 0);
  out.set(ccc.bytesFrom(params.guardianSetTypeHashHex), 32);

  // price-related fields are intentionally zeroed on creation (unauthenticated).
  // price i64 (64..72), conf u64 (72..80), expo i32 (80..84), publish_time u64 (84..92),
  // prev_publish_time u64 (92..100), ema_price i64 (100..108), ema_conf u64 (108..116).
  // emitter_chain u32 LE (116..120)
  new DataView(out.buffer).setUint32(116, params.emitterChain >>> 0, true);

  out.set(ccc.bytesFrom(params.emitterAddressHex), 120);
  return out;
}

export async function deployOracleStateCell(params: {
  ctx: Pick<DeploymentContext, "network" | "config" | "env" | "paths">;
}): Promise<unknown> {
  const { ctx } = params;
  const dryRun = ctx.env.dryRun !== "false";

  // Required one-off oracle identity overrides.
  assertHexBytes("ORACLE_FEED_ID", ctx.env.oracleFeedId, 32);
  const emitterChain = parseU32("ORACLE_EMITTER_CHAIN", ctx.env.oracleEmitterChain);
  assertHexBytes("ORACLE_EMITTER_ADDRESS", ctx.env.oracleEmitterAddress, 32);

  const oracleTypeVersion = loadOracleTypeVersion({
    deploymentRoot: ctx.paths.deploymentRoot,
    network: ctx.network,
  });
  const oracleHashType = (oracleTypeVersion as unknown as { hashType?: ScriptHashType }).hashType;
  if (!oracleHashType) {
    throw new Error(
      "Selected oracle-type canonical version is missing hashType; re-deploy and promote oracle-type with updated artifact format",
    );
  }

  const guardianSetState = loadGuardianSetStateArtifact({
    deploymentRoot: ctx.paths.deploymentRoot,
    network: ctx.network,
  });
  // Compute guardian_set_type_hash from the guardian set cell's type script identity.
  // In broadcast mode this must be derived from the deployed guardian-set state cell's Type ID args.
  // In dry-run mode we allow a placeholder hash to keep planning coherent without requiring a live chain deployment.
  const guardianSetTypeHashHex = (() => {
    if (guardianSetState.mode !== "broadcast" || !guardianSetState.deployed) {
      if (!dryRun) {
        throw new Error(
          `Guardian-set state artifact for ${ctx.network} is not a broadcast deployment; deploy:guardian-set must be broadcast before deploy:oracle`,
        );
      }
      return "0x" + "00".repeat(32);
    }

    const gsType = guardianSetState.guardianSetType;
    const gsTypeScript = ccc.Script.from({
      codeHash: gsType.codeHash,
      hashType: gsType.hashType,
      args: guardianSetState.deployed.typeIdArgs,
    });
    return ccc.hashCkb(gsTypeScript.toBytes());
  })();

  const oracleCellData = encodeOracleData({
    feedIdHex: ctx.env.oracleFeedId,
    guardianSetTypeHashHex,
    emitterChain,
    emitterAddressHex: ctx.env.oracleEmitterAddress,
  });

  if (dryRun) {
    return {
      kind: "deploy:oracle",
      mode: "dry-run",
      network: ctx.network,
      oracleType: {
        version: oracleTypeVersion.version,
        codeHash: oracleTypeVersion.codeHash,
        hashType: oracleHashType,
        depType: oracleTypeVersion.depType,
      },
      guardianSet: {
        outPoint: guardianSetState.deployed ?? null,
        guardianSetTypeHash: guardianSetTypeHashHex,
      },
      oracleConfig: {
        feedId: ctx.env.oracleFeedId,
        emitterChain,
        emitterAddress: ctx.env.oracleEmitterAddress,
      },
      planned: {
        outputDataLen: oracleCellData.length,
      },
    };
  }

  if (!oracleTypeVersion.txHash || oracleTypeVersion.index === undefined) {
    throw new Error(
      "Selected oracle-type canonical version is missing txHash/index; cannot deploy oracle state cell",
    );
  }

  const client = createCccClient(ctx.network, ctx.env.rpcUrl, ctx.env);
  const signer = createPrivateKeySigner(client, ctx.env.deployerPrivateKey);
  const { script: lock } = await signer.getRecommendedAddressObj();

  const guardianSetDeployed = guardianSetState.deployed;
  if (!guardianSetDeployed) {
    throw new Error(
      `Guardian-set state artifact for ${ctx.network} is missing deployed outPoint; deploy:guardian-set must be broadcast before deploy:oracle`,
    );
  }

  const oracleTypeScript = ccc.Script.from({
    codeHash: oracleTypeVersion.codeHash,
    hashType: oracleHashType,
    args: ctx.env.oracleFeedId,
  });

  const tx = ccc.Transaction.from({
    outputs: [
      {
        lock,
        type: oracleTypeScript,
        // Let CCC compute the minimum occupied capacity from (cell output + data).
        // This avoids hardcoding a capacity that becomes insufficient as scripts/data evolve.
        capacity: 0,
      },
    ],
    outputsData: [ccc.hexFrom(oracleCellData)],
    cellDeps: [
      {
        outPoint: { txHash: oracleTypeVersion.txHash, index: BigInt(oracleTypeVersion.index) },
        depType: "code" as const,
      },
      {
        outPoint: { txHash: guardianSetDeployed.txHash, index: BigInt(guardianSetDeployed.index) },
        depType: "code" as const,
      },
    ],
  });

  await tx.completeInputsByCapacity(signer);
  // Add a small deterministic safety margin above the exact occupied capacity.
  // 8 CKB is enough for local devnet testing and keeps behavior predictable.
  tx.outputs[0].capacity += ccc.fixedPointFrom(8);
  // offckb devnet may return null fee-rate statistics; provide a deterministic fallback.
  await tx.completeFeeBy(signer, ctx.network === "devnet" ? 1000n : undefined);
  const txHash = await signer.sendTransaction(tx);

  return {
    kind: "deploy:oracle",
    mode: "broadcast",
    network: ctx.network,
    oracleType: {
      version: oracleTypeVersion.version,
      codeHash: oracleTypeVersion.codeHash,
      hashType: oracleHashType,
      depType: oracleTypeVersion.depType,
      outPoint: { txHash: oracleTypeVersion.txHash, index: oracleTypeVersion.index },
    },
    guardianSet: {
      outPoint: guardianSetState.deployed,
      guardianSetTypeHash: guardianSetTypeHashHex,
    },
    oracleConfig: {
      feedId: ctx.env.oracleFeedId,
      emitterChain,
      emitterAddress: ctx.env.oracleEmitterAddress,
    },
    deployed: {
      txHash,
      index: 0,
    },
  };
}
