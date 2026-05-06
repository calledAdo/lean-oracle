import { ccc } from "@ckb-ccc/core";

import { createCccClient, createPrivateKeySigner } from "./ccc.js";
import { readCodeDeploymentArtifact } from "./artifacts.js";
import type {
  CodeDeploymentArtifact,
  CodeDeploymentVersionRecord,
  DeploymentContext,
  DeploymentNetwork,
  GuardianSetConfig,
  ScriptHashType,
} from "./types.js";

function assertHexString(name: string, value: string) {
  if (!value.startsWith("0x")) throw new Error(`${name} must start with 0x`);
  const hex = value.slice(2);
  if (hex.length % 2 !== 0) throw new Error(`${name} must have even hex length`);
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`${name} must be hex`);
}

function encodeGuardianSetData(cfg: GuardianSetConfig): Uint8Array {
  const n = cfg.guardianAddresses.length;
  const out = new Uint8Array(12 + n * 20);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, cfg.setIndex >>> 0, true);
  dv.setUint32(4, cfg.quorum >>> 0, true);
  dv.setUint32(8, n >>> 0, true);

  let cursor = 12;
  for (const addr of cfg.guardianAddresses) {
    assertHexString("guardianAddresses[]", addr);
    const hex = addr.slice(2);
    if (hex.length !== 40) {
      throw new Error("guardianAddresses[] must be 20-byte hex (0x + 40 chars)");
    }
    for (let i = 0; i < 20; i++) {
      out[cursor + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    cursor += 20;
  }
  return out;
}

function selectLatestCanonicalVersion(versions: Record<number, CodeDeploymentVersionRecord>): CodeDeploymentVersionRecord {
  const keys = Object.keys(versions)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (keys.length === 0) {
    throw new Error("No canonical versions present in guardian-set-type artifact");
  }
  const max = Math.max(...keys);
  const record = versions[max];
  if (!record) throw new Error("Failed to resolve selected canonical version record");
  return record;
}

function loadGuardianSetTypeVersion(params: {
  deploymentRoot: string;
  network: DeploymentNetwork;
}): CodeDeploymentVersionRecord {
  const env = readCodeDeploymentArtifact({
    deploymentRoot: params.deploymentRoot,
    network: params.network,
    scriptFamily: "guardian-set-type",
  });
  const deployment = env?.deployment;
  if (!deployment || typeof deployment !== "object") {
    throw new Error(`Missing guardian-set-type code deployment artifact for ${params.network}`);
  }
  const artifact = deployment as CodeDeploymentArtifact;
  if (!artifact.versions) {
    throw new Error("guardian-set-type artifact missing versions");
  }
  return selectLatestCanonicalVersion(artifact.versions as Record<number, CodeDeploymentVersionRecord>);
}

export async function deployGuardianSetStateCell(params: {
  ctx: Pick<DeploymentContext, "network" | "config" | "env" | "paths">;
}): Promise<unknown> {
  const { ctx } = params;
  const dryRun = ctx.env.dryRun !== "false";

  // Validate canonical guardian-set-type version exists.
  const gsTypeVersion = loadGuardianSetTypeVersion({
    deploymentRoot: ctx.paths.deploymentRoot,
    network: ctx.network,
  });
  const gsTypeHashType = (gsTypeVersion as unknown as { hashType?: ScriptHashType }).hashType;
  if (!gsTypeHashType) {
    throw new Error(
      "Selected guardian-set-type canonical version is missing hashType; re-deploy and promote guardian-set-type with updated artifact format",
    );
  }

  // Validate guardian set config and encode output data.
  const guardianSetData = encodeGuardianSetData(ctx.config.guardianSet);

  // If dry-run, do not require a live RPC endpoint.
  if (dryRun) {
    return {
      kind: "deploy:guardian-set",
      mode: "dry-run",
      network: ctx.network,
      guardianSetType: {
        version: gsTypeVersion.version,
        codeHash: gsTypeVersion.codeHash,
        hashType: gsTypeHashType,
        depType: gsTypeVersion.depType,
      },
      guardianSet: ctx.config.guardianSet,
      planned: {
        outputDataLen: guardianSetData.length,
        // Capacity depends on the deployer's lock script. Broadcast mode computes
        // exact occupied capacity from the real lock + type + data.
      },
    };
  }

  // Broadcast mode requires chain reference for guardian-set-type code.
  if (!gsTypeVersion.txHash || gsTypeVersion.index === undefined) {
    throw new Error(
      "Selected guardian-set-type canonical version is missing txHash/index; cannot deploy state cell",
    );
  }

  const client = createCccClient(ctx.network, ctx.env.rpcUrl, ctx.env);
  const signer = createPrivateKeySigner(client, ctx.env.deployerPrivateKey);

  const { script: lock } = await signer.getRecommendedAddressObj();

  const type = {
    codeHash: gsTypeVersion.codeHash,
    hashType: gsTypeHashType,
    args: "0x" + "00".repeat(32),
  };

  const tx = ccc.Transaction.from({
    outputs: [
      {
        lock,
        type,
        // Let CCC compute the minimum occupied capacity from (cell output + data).
        // This avoids hardcoding a capacity that becomes insufficient as guardian
        // count grows.
        capacity: 0,
      },
    ],
    outputsData: [ccc.hexFrom(guardianSetData)],
    cellDeps: [
      {
        outPoint: { txHash: gsTypeVersion.txHash, index: BigInt(gsTypeVersion.index) },
        depType: "code" as const,
      },
    ],
  });

  // Need at least one input selected before computing Type ID args.
  await tx.completeInputsByCapacity(signer);
  tx.outputs[0].type!.args = ccc.hashTypeId(tx.inputs[0], 0);

  // Add a small deterministic safety margin above the exact occupied capacity.
  // 8 CKB is enough for local devnet testing and keeps behavior predictable.
  tx.outputs[0].capacity += ccc.fixedPointFrom(8);

  // offckb devnet may return null fee-rate statistics; provide a deterministic fallback.
  await tx.completeFeeBy(signer, ctx.network === "devnet" ? 1000n : undefined);

  const txHash = await signer.sendTransaction(tx);

  return {
    kind: "deploy:guardian-set",
    mode: "broadcast",
    network: ctx.network,
    guardianSetType: {
      version: gsTypeVersion.version,
      codeHash: gsTypeVersion.codeHash,
      hashType: gsTypeHashType,
      depType: gsTypeVersion.depType,
      outPoint: { txHash: gsTypeVersion.txHash, index: gsTypeVersion.index },
    },
    guardianSet: ctx.config.guardianSet,
    deployed: {
      txHash,
      index: 0,
      typeIdArgs: tx.outputs[0].type!.args,
      capacity: tx.outputs[0].capacity,
    },
  };
}
