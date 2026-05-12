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
    const plannedOutput = ccc.CellOutput.from({
      lock: {
        codeHash: "0x" + "00".repeat(32),
        hashType: "data",
        args: "0x",
      },
      capacity: 0,
    });
    return {
      mode: "dry-run",
      codeHash,
      hashType: "data2",
      depType: "code",
      capacity: ccc.fixedPointFrom(plannedOutput.occupiedSize + bytes.length),
    };
  }

  const client = createCccClient(ctx.network, ctx.env.rpcUrl, ctx.env);
  const signer = createPrivateKeySigner(client, ctx.env.deployerPrivateKey);

  const { script: lock } = await signer.getRecommendedAddressObj();

  const capacity = ccc.fixedPointFrom(
    ccc.CellOutput.from({ lock, capacity: 0 }).occupiedSize + bytes.length,
  );

  const tx = ccc.Transaction.from({
    outputs: [{ lock, capacity }],
    outputsData: [codeDataHex],
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
    capacity,
  };
}
