import fs from "node:fs";
import path from "node:path";

import { ccc } from "@ckb-ccc/core";

import { createCccClient, createPrivateKeySigner } from "./ccc.js";
import type {
  CodeDeploymentCandidate,
  CodeDeploymentScriptFamily,
  DeploymentContext,
} from "./types.js";

export interface DeployCodeScriptParams {
  ctx: Pick<DeploymentContext, "network" | "config" | "env" | "paths">;
  scriptFamily: CodeDeploymentScriptFamily;
}

/** Consensus-native Type ID script used to keep deployed code cells typed. */
export const TYPE_ID_CODE_HASH =
  "0x00000000000000000000000000000000000000000000000000545950455f4944";

/**
 * Build the single-output code deployment before funding determines Type ID
 * args. Typed code cells are excluded by normal plain-capacity collection,
 * which prevents later deployment transactions from consuming their deps.
 */
export function buildCodeDeploymentTransaction(params: {
  lock: ccc.ScriptLike;
  codeDataHex: string;
}): ccc.Transaction {
  const codeBytes = ccc.bytesFrom(params.codeDataHex);
  const output = ccc.CellOutput.from({
    lock: params.lock,
    type: {
      codeHash: TYPE_ID_CODE_HASH,
      hashType: "type",
      args: `0x${"00".repeat(32)}`,
    },
    capacity: 0,
  });
  output.capacity = ccc.fixedPointFrom(output.occupiedSize + codeBytes.length);
  return ccc.Transaction.from({
    outputs: [output],
    outputsData: [params.codeDataHex],
  });
}

function resolveBinaryPath(
  scriptFamily: CodeDeploymentScriptFamily,
  ctx: Pick<DeploymentContext, "config" | "paths">,
): string {
  const repoRoot = path.resolve(ctx.paths.deploymentRoot, "..");
  const rel = (() => {
    switch (scriptFamily) {
      case "oracle-type":
        return ctx.config.build.oracleBinaryPath;
      case "guardian-set-type":
        return ctx.config.build.guardianSetBinaryPath;
      case "owned-type-bind-lock":
        return ctx.config.build.ownedTypeBindLockBinaryPath;
    }
  })();
  return path.resolve(repoRoot, rel);
}

export async function deployCodeScript(
  params: DeployCodeScriptParams,
): Promise<CodeDeploymentCandidate> {
  const { ctx, scriptFamily } = params;
  const dryRun = ctx.env.dryRun !== "false";

  // Deployment policy: we deploy binaries as raw code blobs and reference them
  // by data hash under `hashType: "data2"`, which selects CKB-VM v2 — the VM
  // version targeted by the `ckb-std` 1.x toolchain that builds these contracts.
  // (`hashType: "data"` would pin execution to CKB-VM v0, whose memory model
  // does not match modern ckb-std binaries and triggers `MemWriteOnExecutablePage`.)
  // This is recorded explicitly in deployment artifacts so downstream state deployment
  // does not guess script identity.
  const absBinaryPath = resolveBinaryPath(scriptFamily, ctx);
  const bytes = fs.readFileSync(absBinaryPath);
  if (bytes.length === 0) {
    throw new Error(`Binary is empty: ${absBinaryPath}`);
  }

  const codeHash = ccc.hashCkb(bytes);
  const codeDataHex = ccc.hexFrom(bytes);

  if (dryRun) {
    const planned = buildCodeDeploymentTransaction({
      lock: {
        codeHash: "0x" + "00".repeat(32),
        hashType: "data",
        args: "0x",
      },
      codeDataHex,
    });
    return {
      mode: "dry-run",
      codeHash,
      hashType: "data2",
      depType: "code",
      capacity: planned.outputs[0]!.capacity,
    };
  }

  const client = createCccClient(ctx.network, ctx.env.rpcUrl, ctx.env);
  const signer = createPrivateKeySigner(client, ctx.env.deployerPrivateKey);

  const { script: lock } = await signer.getRecommendedAddressObj();

  const tx = buildCodeDeploymentTransaction({ lock, codeDataHex });
  const capacity = tx.outputs[0]!.capacity;

  await tx.completeInputsByCapacity(signer);
  const typeIdArgs = ccc.hashTypeId(tx.inputs[0]!, 0);
  tx.outputs[0]!.type!.args = typeIdArgs;
  // offckb devnet may return null fee-rate statistics; provide a deterministic fallback.
  await tx.completeFeeBy(signer, ctx.network === "devnet" ? 1000n : undefined);

  const txHash = await signer.sendTransaction(tx);

  return {
    mode: "broadcast",
    codeHash,
    hashType: "data2",
    depType: "code",
    txHash,
    index: 0,
    capacity,
    typeIdArgs,
  };
}
