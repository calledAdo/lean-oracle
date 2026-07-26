import { ccc } from "@ckb-ccc/core";

import { createCccClient, createPrivateKeySigner } from "./ccc.js";
import { loadLatestCanonicalCodeVersion } from "./codeVersions.js";
import { waitForCommittedTransaction } from "./chainFinality.js";
import type {
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

export function encodeGuardianSetDataBytes(cfg: GuardianSetConfig): Uint8Array {
  return encodeGuardianSetData(cfg);
}

export function loadGuardianSetTypeVersion(params: {
  deploymentRoot: string;
  network: DeploymentNetwork;
}): CodeDeploymentVersionRecord {
  return loadLatestCanonicalCodeVersion({
    deploymentRoot: params.deploymentRoot,
    network: params.network,
    scriptFamily: "guardian-set-type",
  });
}

export function buildGuardianSetCandidateTemplate(params: {
  identityVersion: number;
  guardianCode: CodeDeploymentVersionRecord;
  bindLockCode: CodeDeploymentVersionRecord;
  deployerLock: ccc.Script;
  guardianSet: GuardianSetConfig;
}) {
  const guardianHashType = params.guardianCode.hashType;
  const bindLockHashType = params.bindLockCode.hashType;
  if (!params.guardianCode.txHash || params.guardianCode.index === undefined) {
    throw new Error("Guardian code version is missing its code-dependency outpoint");
  }
  if (!params.bindLockCode.txHash || params.bindLockCode.index === undefined) {
    throw new Error("OwnedTypeBindLock version is missing its code-dependency outpoint");
  }

  const guardianType = ccc.Script.from({
    codeHash: params.guardianCode.codeHash,
    hashType: guardianHashType,
    args: `0x${"00".repeat(32)}`,
  });
  const guardianLock = ccc.Script.from({
    codeHash: params.bindLockCode.codeHash,
    hashType: bindLockHashType,
    args: ccc.hashCkb(params.deployerLock.toBytes()),
  });

  return {
    identityVersion: params.identityVersion,
    guardianSetType: {
      codeVersion: params.guardianCode.version,
      codeHash: params.guardianCode.codeHash,
      hashType: guardianHashType,
      depType: params.guardianCode.depType,
      codeDep: {
        outPoint: {
          txHash: params.guardianCode.txHash,
          index: params.guardianCode.index,
        },
        depType: params.guardianCode.depType,
      },
      script: guardianType,
    },
    guardianSetLock: {
      codeVersion: params.bindLockCode.version,
      codeHash: params.bindLockCode.codeHash,
      hashType: bindLockHashType,
      depType: params.bindLockCode.depType,
      codeDep: {
        outPoint: {
          txHash: params.bindLockCode.txHash,
          index: params.bindLockCode.index,
        },
        depType: params.bindLockCode.depType,
      },
      script: guardianLock,
    },
    guardianSet: params.guardianSet,
    guardianSetData: encodeGuardianSetData(params.guardianSet),
  };
}

export function assertGuardianSetCandidateReadback(params: {
  expected: {
    cellOutput: { capacity: bigint; lock: ccc.Script; type?: ccc.Script };
    outputData: ccc.Hex;
  };
  liveCell: {
    cellOutput: { capacity: bigint; lock: ccc.Script; type?: ccc.Script };
    outputData: ccc.Hex;
  };
}): void {
  const { expected, liveCell } = params;
  if (!liveCell.cellOutput.lock.eq(expected.cellOutput.lock)) {
    throw new Error("Guardian candidate readback lock mismatch");
  }
  if (
    !liveCell.cellOutput.type ||
    !expected.cellOutput.type ||
    !liveCell.cellOutput.type.eq(expected.cellOutput.type)
  ) {
    throw new Error("Guardian candidate readback type mismatch");
  }
  if (liveCell.cellOutput.capacity !== expected.cellOutput.capacity) {
    throw new Error("Guardian candidate readback capacity mismatch");
  }
  if (ccc.hexFrom(liveCell.outputData) !== ccc.hexFrom(expected.outputData)) {
    throw new Error("Guardian candidate readback data mismatch");
  }
}

export async function deployGuardianSetStateCell(params: {
  ctx: Pick<DeploymentContext, "network" | "config" | "env" | "paths">;
  candidate?: boolean;
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
  const identityVersion = params.candidate
    ? ctx.config.guardianSetIdentityVersion
    : gsTypeVersion.version;
  if (params.candidate && (!Number.isInteger(identityVersion) || Number(identityVersion) <= 0)) {
    throw new Error("Guardian candidate requires a positive guardianSetIdentityVersion");
  }
  const bindLockVersion = params.candidate
    ? loadLatestCanonicalCodeVersion({
        deploymentRoot: ctx.paths.deploymentRoot,
        network: ctx.network,
        scriptFamily: "owned-type-bind-lock",
      })
    : undefined;
  if (params.candidate && ctx.config.guardianSetLock !== "owned-type-bind") {
    throw new Error("Guardian candidate requires guardianSetLock=owned-type-bind");
  }

  // If dry-run, do not require a live RPC endpoint.
  if (dryRun) {
    return {
      kind: params.candidate
        ? "deploy:guardian-set-candidate"
        : "deploy:guardian-set",
      mode: "dry-run",
      network: ctx.network,
      identityVersion,
      guardianSetType: {
        version: gsTypeVersion.version,
        codeVersion: gsTypeVersion.version,
        codeHash: gsTypeVersion.codeHash,
        hashType: gsTypeHashType,
        depType: gsTypeVersion.depType,
      },
      guardianSetLock: bindLockVersion
        ? {
            codeVersion: bindLockVersion.version,
            codeHash: bindLockVersion.codeHash,
            hashType: bindLockVersion.hashType,
            depType: bindLockVersion.depType,
          }
        : { kind: "deployer" },
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

  const { script: deployerLock } = await signer.getRecommendedAddressObj();
  const template = bindLockVersion
    ? buildGuardianSetCandidateTemplate({
        identityVersion: Number(identityVersion),
        guardianCode: gsTypeVersion,
        bindLockCode: bindLockVersion,
        deployerLock,
        guardianSet: ctx.config.guardianSet,
      })
    : undefined;
  const lock = template?.guardianSetLock.script ?? deployerLock;
  const type = template?.guardianSetType.script ?? ccc.Script.from({
    codeHash: gsTypeVersion.codeHash,
    hashType: gsTypeHashType,
    args: `0x${"00".repeat(32)}`,
  });

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
  const committed = await waitForCommittedTransaction(client, txHash, {
    operation: params.candidate ? "guardian candidate" : "guardian deployment",
  });
  const liveCell = await client.getCellLive({ txHash, index: 0n }, true, true);
  if (!liveCell) {
    throw new Error("Guardian deployment committed without a live output at index 0");
  }
  assertGuardianSetCandidateReadback({
    expected: {
      cellOutput: tx.outputs[0],
      outputData: tx.outputsData[0],
    },
    liveCell,
  });

  const typeIdArgs = tx.outputs[0].type!.args;
  const fullTypeHash = ccc.hashCkb(tx.outputs[0].type!.toBytes());

  return {
    kind: params.candidate
      ? "deploy:guardian-set-candidate"
      : "deploy:guardian-set",
    mode: "broadcast",
    network: ctx.network,
    identityVersion,
    fullTypeHash,
    verifiedAtBlock: committed.blockNumber?.toString(),
    guardianSetType: {
      version: gsTypeVersion.version,
      codeVersion: gsTypeVersion.version,
      codeHash: gsTypeVersion.codeHash,
      hashType: gsTypeHashType,
      depType: gsTypeVersion.depType,
      outPoint: { txHash: gsTypeVersion.txHash, index: gsTypeVersion.index },
      args: typeIdArgs,
    },
    guardianSetLock: bindLockVersion
      ? {
          codeVersion: bindLockVersion.version,
          codeHash: bindLockVersion.codeHash,
          hashType: bindLockVersion.hashType,
          depType: bindLockVersion.depType,
          outPoint: {
            txHash: bindLockVersion.txHash,
            index: bindLockVersion.index,
          },
          script: {
            codeHash: lock.codeHash,
            hashType: lock.hashType,
            args: lock.args,
          },
        }
      : {
          kind: "deployer",
          script: {
            codeHash: lock.codeHash,
            hashType: lock.hashType,
            args: lock.args,
          },
        },
    guardianSet: ctx.config.guardianSet,
    deployed: {
      txHash,
      index: 0,
      typeIdArgs,
      capacity: tx.outputs[0].capacity,
    },
  };
}
