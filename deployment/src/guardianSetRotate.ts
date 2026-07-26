import fs from "node:fs";
import path from "node:path";

import { ccc } from "@ckb-ccc/core";

import { createCccClient, createPrivateKeySigner } from "./ccc.js";
import { waitForCommittedTransaction } from "./chainFinality.js";
import {
  encodeGuardianSetDataBytes,
  loadGuardianSetTypeVersion,
} from "./guardianSetDeploy.js";
import type { DeploymentContext, GuardianSetConfig } from "./types.js";

/** 1 CKB in shannons; occupied capacity is 1 CKB per data byte. */
const SHANNONS_PER_CKB = 100_000_000n;

// ── Canonical Wormhole governance identity (Core / GuardianSetUpgrade) ─────────
const GOV_EMITTER_CHAIN = 1;
const GOV_EMITTER_ADDRESS =
  "0000000000000000000000000000000000000000000000000000000000000004";
const GOV_MODULE_CORE =
  "00000000000000000000000000000000000000000000000000000000436f7265";
const GOV_ACTION_GUARDIAN_SET_UPGRADE = 2;
const GOV_TARGET_CHAIN_ALL = 0;

function wormholeQuorum(n: number): number {
  return Math.floor((n * 2) / 3) + 1;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("odd-length hex");
  if (!/^[0-9a-fA-F]*$/u.test(h)) throw new Error("invalid hex characters");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

interface DecodedGuardianSet {
  setIndex: number;
  quorum: number;
  guardianAddresses: string[];
}

function decodeGuardianSetData(raw: Uint8Array): DecodedGuardianSet {
  if (raw.length < 12) throw new Error("guardian set data too short");
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const setIndex = dv.getUint32(0, true);
  const quorum = dv.getUint32(4, true);
  const count = dv.getUint32(8, true);
  if (raw.length !== 12 + count * 20) throw new Error("guardian set data wrong length");
  const guardianAddresses: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = 12 + i * 20;
    guardianAddresses.push(bytesToHex(raw.subarray(start, start + 20)));
  }
  return { setIndex, quorum, guardianAddresses };
}

interface ParsedUpgrade {
  signingSetIndex: number;
  newIndex: number;
  addresses: string[];
}

/**
 * Parse a Wormhole guardian-set-upgrade governance VAA, mirroring the on-chain
 * `contracts/common/src/governance.rs` checks (signature verification aside).
 */
function parseGuardianSetUpgradeVaa(vaa: Uint8Array): ParsedUpgrade {
  const dv = new DataView(vaa.buffer, vaa.byteOffset, vaa.byteLength);
  const need = (off: number, len: number) => {
    if (off + len > vaa.length) throw new Error("governance VAA truncated");
  };

  need(0, 6);
  if (vaa[0] !== 1) throw new Error(`unsupported VAA version ${vaa[0]}`);
  const signingSetIndex = dv.getUint32(1, false);
  const sigCount = vaa[5];
  const bodyOffset = 6 + sigCount * 66;

  need(bodyOffset, 51);
  const emitterChain = dv.getUint16(bodyOffset + 8, false);
  const emitterAddress = bytesToHex(vaa.subarray(bodyOffset + 10, bodyOffset + 42)).slice(2);
  if (emitterChain !== GOV_EMITTER_CHAIN || emitterAddress.toLowerCase() !== GOV_EMITTER_ADDRESS) {
    throw new Error(`governance emitter mismatch: chain ${emitterChain} addr 0x${emitterAddress}`);
  }
  const payloadOffset = bodyOffset + 51;

  need(payloadOffset, 40);
  const module = bytesToHex(vaa.subarray(payloadOffset, payloadOffset + 32)).slice(2);
  if (module.toLowerCase() !== GOV_MODULE_CORE) throw new Error("governance module is not Core");
  const action = vaa[payloadOffset + 32];
  if (action !== GOV_ACTION_GUARDIAN_SET_UPGRADE) throw new Error(`action ${action} is not GuardianSetUpgrade`);
  const targetChain = dv.getUint16(payloadOffset + 33, false);
  if (targetChain !== GOV_TARGET_CHAIN_ALL) throw new Error(`target chain ${targetChain} is not global`);
  const newIndex = dv.getUint32(payloadOffset + 35, false);
  const num = vaa[payloadOffset + 39];
  if (num === 0) throw new Error("governance VAA declares empty set");

  const addressesOffset = payloadOffset + 40;
  need(addressesOffset, num * 20);
  if (addressesOffset + num * 20 !== vaa.length) throw new Error("governance VAA has trailing bytes");
  const addresses: string[] = [];
  for (let i = 0; i < num; i++) {
    const start = addressesOffset + i * 20;
    addresses.push(bytesToHex(vaa.subarray(start, start + 20)));
  }
  return { signingSetIndex, newIndex, addresses };
}

interface GuardianStateArtifact {
  kind?: string;
  mode?: string;
  network?: string;
  identityVersion?: number;
  fullTypeHash?: string;
  guardianSetType?: Record<string, unknown>;
  guardianSetLock?: {
    depType?: "code" | "depGroup";
    outPoint?: { txHash: string; index: number };
    script?: { codeHash: string; hashType: string; args: string };
  };
  guardianSet?: GuardianSetConfig;
  deployed?: {
    txHash: string;
    index: number;
    typeIdArgs?: string;
    capacity: string | bigint;
  };
  [key: string]: unknown;
}

function readGuardianStateArtifact(
  deploymentRoot: string,
  network: string,
): GuardianStateArtifact | undefined {
  const p = path.join(deploymentRoot, "artifacts", `${network}.deploy-guardian-set.json`);
  if (!fs.existsSync(p)) return undefined;
  const env = JSON.parse(fs.readFileSync(p, "utf8")) as {
    deployment?: GuardianStateArtifact;
  };
  return env.deployment;
}

export function buildRotatedGuardianCanonicalState(params: {
  priorState?: GuardianStateArtifact;
  nextSet: GuardianSetConfig;
  deployed: {
    txHash: string;
    index: number;
    typeIdArgs: string;
    capacity: string | bigint;
  };
  fallback?: GuardianStateArtifact;
}): GuardianStateArtifact {
  const base = params.priorState ?? params.fallback;
  if (!base) {
    throw new Error("Cannot project guardian rotation without canonical metadata");
  }
  return {
    ...base,
    kind: "deploy:guardian-set",
    mode: "broadcast",
    guardianSet: params.nextSet,
    deployed: params.deployed,
  };
}

/**
 * Trustlessly rotate the on-chain guardian-set cell to its Wormhole successor.
 *
 * Consumes the current guardian-set cell and produces the next one, attaching a
 * guardian-set-upgrade governance VAA (env `GUARDIAN_UPGRADE_VAA`) in the group
 * input witness. The `guardian_set_script` verifies that VAA against the current
 * on-chain set, so successor authenticity is authorized by cryptography. The
 * The canonical testnet identity uses OwnedTypeBindLock, so any fee payer can
 * submit a continuity-preserving transaction. This deployment command still
 * uses the configured operator signer as its fee payer.
 */
export async function rotateGuardianSetStateCell(params: {
  ctx: Pick<DeploymentContext, "network" | "config" | "env" | "paths">;
  /** Test seam for exact dry-run planning without a public RPC. */
  cccClient?: ccc.Client;
}): Promise<unknown> {
  const { ctx } = params;
  const dryRun = ctx.env.dryRun !== "false";

  if (!ctx.env.guardianUpgradeVaa) {
    throw new Error("rotate:guardian-set requires GUARDIAN_UPGRADE_VAA (hex governance VAA)");
  }
  const vaaBytes = hexToBytes(ctx.env.guardianUpgradeVaa);
  const upgrade = parseGuardianSetUpgradeVaa(vaaBytes);

  const gsTypeVersion = loadGuardianSetTypeVersion({
    deploymentRoot: ctx.paths.deploymentRoot,
    network: ctx.network,
  });
  const hashType = (gsTypeVersion as unknown as { hashType?: string }).hashType;
  if (!hashType) throw new Error("guardian-set-type version missing hashType");

  const guardianState = readGuardianStateArtifact(
    ctx.paths.deploymentRoot,
    ctx.network,
  );
  const typeIdArgs =
    ctx.env.guardianSetTypeIdArgs ||
    guardianState?.deployed?.typeIdArgs;
  if (!typeIdArgs) {
    throw new Error(
      "Cannot resolve guardian-set Type ID args from the canonical state artifact. Set GUARDIAN_SET_TYPE_ID_ARGS.",
    );
  }

  const nextSet: GuardianSetConfig = {
    setIndex: upgrade.newIndex,
    quorum: wormholeQuorum(upgrade.addresses.length),
    guardianAddresses: upgrade.addresses,
  };

  if (!gsTypeVersion.txHash || gsTypeVersion.index === undefined) {
    throw new Error("guardian-set-type version missing txHash/index; cannot rotate");
  }

  const client =
    params.cccClient ?? createCccClient(ctx.network, ctx.env.rpcUrl, ctx.env);

  const guardianType = ccc.Script.from({
    codeHash: gsTypeVersion.codeHash,
    hashType: hashType as ccc.HashTypeLike,
    args: typeIdArgs,
  });

  // Resolve the unique live guardian-set cell.
  let liveCell: ccc.Cell | undefined;
  for await (const cell of client.findCellsByType(guardianType, true)) {
    if (liveCell) throw new Error("Ambiguous guardian-set: more than one live cell for the type script");
    liveCell = cell;
  }
  if (!liveCell) throw new Error("No live guardian-set cell found for the configured type script");

  const configuredLock = guardianState?.guardianSetLock;
  let lockCodeDep:
    | {
        outPoint: { txHash: string; index: bigint };
        depType: "code" | "depGroup";
      }
    | undefined;
  if (configuredLock?.script) {
    const expectedLock = ccc.Script.from({
      codeHash: configuredLock.script.codeHash,
      hashType: configuredLock.script.hashType as ccc.HashTypeLike,
      args: configuredLock.script.args,
    });
    if (!liveCell.cellOutput.lock.eq(expectedLock)) {
      throw new Error("Guardian-set live lock does not match canonical guardianSetLock metadata");
    }
    if (configuredLock.outPoint) {
      lockCodeDep = {
        outPoint: {
          txHash: configuredLock.outPoint.txHash,
          index: BigInt(configuredLock.outPoint.index),
        },
        depType: configuredLock.depType ?? "code",
      };
    }
  }

  const currentSet = decodeGuardianSetData(hexToBytes(ccc.hexFrom(liveCell.outputData)));
  if (upgrade.signingSetIndex !== currentSet.setIndex) {
    throw new Error(
      `Governance VAA signed by set ${upgrade.signingSetIndex} but on-chain set is ${currentSet.setIndex}`,
    );
  }
  if (upgrade.newIndex !== currentSet.setIndex + 1) {
    throw new Error(
      `Governance VAA advances to ${upgrade.newIndex}; next expected index is ${currentSet.setIndex + 1}`,
    );
  }

  const nextDataBytes = encodeGuardianSetDataBytes(nextSet);
  const oldDataLen = BigInt(hexToBytes(ccc.hexFrom(liveCell.outputData)).length);
  const newDataLen = BigInt(nextDataBytes.length);
  const growth = newDataLen > oldDataLen ? newDataLen - oldDataLen : 0n;
  const outputCapacity = liveCell.cellOutput.capacity + growth * SHANNONS_PER_CKB;

  const tx = ccc.Transaction.from({
    inputs: [{ previousOutput: liveCell.outPoint }],
    outputs: [
      {
        lock: liveCell.cellOutput.lock,
        type: liveCell.cellOutput.type,
        capacity: outputCapacity,
      },
    ],
    outputsData: [ccc.hexFrom(nextDataBytes)],
    cellDeps: [
      {
        outPoint: { txHash: gsTypeVersion.txHash, index: BigInt(gsTypeVersion.index) },
        depType: "code" as const,
      },
      ...(lockCodeDep ? [lockCodeDep] : []),
    ],
  });

  // Attach the governance VAA in the group input's witness input_type (index 0).
  const witnessArgs = ccc.WitnessArgs.from({ inputType: ccc.hexFrom(vaaBytes) });
  tx.setWitnessArgsAt(0, witnessArgs);

  if (dryRun) {
    return {
      kind: "rotate:guardian-set",
      mode: "dry-run",
      network: ctx.network,
      governanceVaa: {
        signingSetIndex: upgrade.signingSetIndex,
        newIndex: upgrade.newIndex,
      },
      currentSet,
      nextSet,
      planned: {
        currentOutPoint: {
          txHash: liveCell.outPoint.txHash,
          index: Number(liveCell.outPoint.index),
        },
        typeIdArgs,
        outputCapacity,
        codeDep: {
          outPoint: {
            txHash: gsTypeVersion.txHash,
            index: gsTypeVersion.index,
          },
          depType: gsTypeVersion.depType,
        },
        lockCodeDep: lockCodeDep
          ? {
              outPoint: {
                txHash: lockCodeDep.outPoint.txHash,
                index: Number(lockCodeDep.outPoint.index),
              },
              depType: lockCodeDep.depType,
            }
          : undefined,
        unsignedTransition: ccc.hexFrom(tx.toBytes()),
      },
    };
  }

  const signer = createPrivateKeySigner(client, ctx.env.deployerPrivateKey);

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, ctx.network === "devnet" ? 1000n : undefined);

  const txHash = await signer.sendTransaction(tx);
  const committed = await waitForCommittedTransaction(client, txHash, {
    operation: "guardian rotation",
  });

  const predecessor = await client.getCellLive(liveCell.outPoint, true, true);
  if (predecessor) {
    throw new Error("Guardian rotation committed but predecessor is still live");
  }
  const committedCell = await client.getCellLive(
    { txHash, index: 0n },
    true,
    true,
  );
  if (!committedCell) {
    throw new Error("Guardian rotation committed without a live output at index 0");
  }
  if (
    !committedCell.cellOutput.type?.eq(guardianType) ||
    !committedCell.cellOutput.lock.eq(liveCell.cellOutput.lock) ||
    committedCell.cellOutput.capacity !== outputCapacity ||
    ccc.hexFrom(committedCell.outputData) !== ccc.hexFrom(nextDataBytes)
  ) {
    throw new Error("Committed guardian rotation output failed exact readback verification");
  }

  return {
    kind: "rotate:guardian-set",
    mode: "broadcast",
    network: ctx.network,
    rotated: { from: currentSet.setIndex, to: nextSet.setIndex },
    verifiedAtBlock: committed.blockNumber?.toString(),
    nextSet,
    deployed: { txHash, index: 0, capacity: tx.outputs[0].capacity },
    canonicalState: buildRotatedGuardianCanonicalState({
      priorState: guardianState,
      nextSet,
      deployed: {
        txHash,
        index: 0,
        typeIdArgs,
        capacity: tx.outputs[0].capacity,
      },
      fallback: {
        kind: "deploy:guardian-set",
        mode: "broadcast",
        network: ctx.network,
        guardianSetType: {
          version: gsTypeVersion.version,
          codeHash: gsTypeVersion.codeHash,
          hashType,
          depType: gsTypeVersion.depType,
          outPoint: {
            txHash: gsTypeVersion.txHash,
            index: gsTypeVersion.index,
          },
        },
      },
    }),
  };
}
