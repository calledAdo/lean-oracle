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

function resolveBinaryPath(
  scriptFamily: CodeDeploymentScriptFamily,
  ctx: Pick<DeploymentContext, "config" | "paths">,
): string {
  const repoRoot = path.resolve(ctx.paths.deploymentRoot, "..");
  const rel =
    scriptFamily === "oracle-type"
      ? ctx.config.build.oracleBinaryPath
      : ctx.config.build.guardianSetBinaryPath;
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

  if (dryRun) {
    return {
      mode: "dry-run",
      codeHash,
      hashType: "data2",
      depType: "code",
    };
  }

  const client = createCccClient(ctx.network, ctx.env.rpcUrl, ctx.env);
  const signer = createPrivateKeySigner(client, ctx.env.deployerPrivateKey);

  const { script: lock } = await signer.getRecommendedAddressObj();

  const tx = ccc.Transaction.from({
    outputs: [{ lock }],
    outputsData: [ccc.hexFrom(bytes)],
  });

  await tx.completeInputsByCapacity(signer);
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
  };
}
