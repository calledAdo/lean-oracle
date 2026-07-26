/**
 * @packageDocumentation
 *
 * **Trustless guardian-set rotation** transaction builder.
 *
 * When Wormhole rotates its guardian set, the on-chain guardian-set cell falls
 * behind and oracle updates begin to fail (Hermes signs fresh prices with the
 * new set). This module consumes the current guardian-set cell and produces the
 * next one, attaching the Wormhole guardian-set-upgrade governance VAA in the
 * group input's witness. The `guardian_set_script` verifies that VAA against the
 * **current** on-chain set, so governance authorization is permissionless.
 * Transaction submission still has to satisfy the guardian cell's lock. See
 * `contracts/common/src/governance.rs`; deployments using an operator lock
 * remain operator-submitted.
 */

import type { Cell, Client, Transaction } from "@ckb-ccc/core";
import { Script, WitnessArgs, hexFrom } from "@ckb-ccc/core";
import type { LeanOracleNetworkConfig } from "../types/network.js";
import type { LeanOracleGuardianSetData } from "../types/guardianSet.js";
import type { HexString } from "../types/hex.js";
import { LeanOracleSdkError } from "../errors.js";
import { decodeGuardianSetCellDataHex } from "../ckb/decodeGuardianSetData.js";
import { encodeGuardianSetCellDataBytes } from "../ckb/encodeGuardianSetData.js";
import {
  parseGuardianSetUpgradeVaa,
  type ParseGuardianSetUpgradeOptions,
} from "../wormhole/parseGuardianSetUpgrade.js";

/** 1 CKB in shannons; occupied capacity is 1 CKB per data byte. */
const SHANNONS_PER_CKB = 100_000_000n;

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new LeanOracleSdkError("Guardian-set rotation aborted", {
      cause: signal.reason,
    });
  }
}

export interface GuardianSetRotationParams {
  network: LeanOracleNetworkConfig;
  cccClient: Client;
  tx: Transaction;
  /**
   * The Wormhole guardian-set-upgrade governance VAA authorizing this rotation,
   * signed by the **current** on-chain set. Hex or raw bytes.
   */
  governanceVaa: HexString | Uint8Array;
  /** Emitter/module validation overrides (defaults enforce canonical Wormhole). */
  parseOptions?: ParseGuardianSetUpgradeOptions;
  signal?: AbortSignal;
}

export interface GuardianSetRotationResult {
  mutated: Transaction;
  /** The set decoded from the consumed on-chain cell. */
  currentSet: LeanOracleGuardianSetData;
  /** The set written to the produced cell. */
  nextSet: LeanOracleGuardianSetData;
}

/**
 * Resolve the unique live guardian-set cell for the deployment's guardian type
 * script. Mirrors the contract's "exactly one authoritative set" requirement.
 */
async function resolveLiveGuardianSetCell(
  cccClient: Client,
  network: LeanOracleNetworkConfig,
  signal?: AbortSignal,
): Promise<Cell> {
  assertNotAborted(signal);
  const identity = network.deployment.guardianSetType;
  const guardianTypeScript = Script.from({
    codeHash: identity.codeHash,
    hashType: identity.hashType,
    args: identity.args,
  });

  let matched: Cell | undefined;
  for await (const cell of cccClient.findCellsByType(guardianTypeScript, true)) {
    if (signal?.aborted) {
      throw new LeanOracleSdkError("Guardian-set rotation aborted", {
        cause: signal.reason,
      });
    }
    if (matched) {
      throw new LeanOracleSdkError(
        "Ambiguous guardian-set resolution: more than one live guardian-set cell. The contract requires exactly one authoritative trust root.",
      );
    }
    matched = cell;
  }
  if (!matched) {
    throw new LeanOracleSdkError(
      "No live guardian-set cell found for the configured guardian type script",
    );
  }
  assertNotAborted(signal);
  return matched;
}

/**
 * Consume the current guardian-set cell and produce its successor, authorized by
 * a Wormhole guardian-set-upgrade governance VAA.
 *
 * The caller is responsible for completing inputs/fees and signing. When the new
 * set is larger than the current one, the output cell needs more capacity; this
 * builder raises the output capacity by exactly the extra occupied bytes so a
 * subsequent `completeInputsByCapacity` funds the difference.
 *
 * @public
 */
export async function attachGuardianSetRotation(
  params: GuardianSetRotationParams,
): Promise<GuardianSetRotationResult> {
  const cell = await resolveLiveGuardianSetCell(
    params.cccClient,
    params.network,
    params.signal,
  );
  const currentSet = decodeGuardianSetCellDataHex(cell.outputData);
  return attachResolvedGuardianSetRotation(params, cell, currentSet);
}

async function attachResolvedGuardianSetRotation(
  params: GuardianSetRotationParams,
  cell: Cell,
  currentSet: LeanOracleGuardianSetData,
): Promise<GuardianSetRotationResult> {
  const { network, tx } = params;
  assertNotAborted(params.signal);

  // Parse the governance VAA and check it succeeds the current set.
  const upgrade = parseGuardianSetUpgradeVaa(
    params.governanceVaa,
    params.parseOptions,
  );
  if (upgrade.signingSetIndex !== currentSet.setIndex) {
    throw new LeanOracleSdkError(
      `Governance VAA is signed by set ${String(upgrade.signingSetIndex)} but the current on-chain set is ${String(currentSet.setIndex)}. Only the current set can authorize the next rotation.`,
    );
  }
  if (upgrade.newIndex !== currentSet.setIndex + 1) {
    throw new LeanOracleSdkError(
      `Governance VAA advances to set ${String(upgrade.newIndex)} but the next expected index is ${String(currentSet.setIndex + 1)}. Rotations must be applied one step at a time.`,
    );
  }

  const nextSet: LeanOracleGuardianSetData = {
    setIndex: upgrade.newIndex,
    quorum: upgrade.quorum,
    guardianAddresses: upgrade.addresses,
  };
  const nextDataBytes = encodeGuardianSetCellDataBytes(nextSet);

  // Compute output capacity (cover any growth in occupied bytes).
  const oldDataLen = BigInt(hexFrom(cell.outputData).length / 2 - 1);
  const newDataLen = BigInt(nextDataBytes.length);
  const growth = newDataLen > oldDataLen ? newDataLen - oldDataLen : 0n;
  const outputCapacity = cell.cellOutput.capacity + growth * SHANNONS_PER_CKB;

  // Mutate tx: input, output, code dep, witness.
  assertNotAborted(params.signal);
  const inputIndex =
    tx.addInput({ previousOutput: cell.outPoint }) - 1;

  tx.addOutput(
    {
      capacity: outputCapacity,
      lock: cell.cellOutput.lock,
      type: cell.cellOutput.type,
    },
    hexFrom(nextDataBytes),
  );

  // The guardian type script must execute to validate the transition.
  tx.addCellDeps(network.deployment.guardianSetType.codeDep);

  // The script reads the governance VAA from WitnessArgs.input_type at the
  // group input's index (group input 0 == this input).
  const witnessArgs = tx.getWitnessArgsAt(inputIndex) ?? WitnessArgs.from({});
  witnessArgs.inputType = hexFrom(params.governanceVaa);
  tx.setWitnessArgsAt(inputIndex, witnessArgs);

  return { mutated: tx, currentSet, nextSet };
}

export interface GuardianSetRotationPlan {
  /** Whether the on-chain set is behind and a rotation was built. */
  rotated: boolean;
  /** Current on-chain set index. */
  currentIndex: number;
  /** Target index if a rotation was built. */
  nextIndex?: number;
  /** The mutated transaction, present only when `rotated` is true. */
  mutated?: Transaction;
  currentSet?: LeanOracleGuardianSetData;
  nextSet?: LeanOracleGuardianSetData;
}

export interface BuildGuardianSetRotationIfBehindParams {
  network: LeanOracleNetworkConfig;
  cccClient: Client;
  tx: Transaction;
  /**
   * Supplies the guardian-set-upgrade VAA that advances the set at
   * `currentIndex` to `currentIndex + 1`, or `null` if none is available yet
   * (nothing to do). Injecting this keeps the keeper testable and decoupled from
   * any specific Wormhole gateway.
   */
  fetchUpgradeVaa: (
    currentIndex: number,
    signal?: AbortSignal,
  ) => Promise<HexString | Uint8Array | null>;
  parseOptions?: ParseGuardianSetUpgradeOptions;
  signal?: AbortSignal;
}

/**
 * Keeper primitive: check whether the on-chain guardian set is behind Wormhole,
 * and if a successor upgrade VAA is available, build the rotation transaction.
 *
 * This does **not** sign or broadcast — it returns a plan so the caller controls
 * fee completion, signing, and submission. Because the rotation is trustless,
 * *anyone* can run this; it is a liveness convenience, not a trust dependency.
 *
 * @public
 */
export async function buildGuardianSetRotationIfBehind(
  params: BuildGuardianSetRotationIfBehindParams,
): Promise<GuardianSetRotationPlan> {
  assertNotAborted(params.signal);
  const cell = await resolveLiveGuardianSetCell(
    params.cccClient,
    params.network,
    params.signal,
  );
  const currentSet = decodeGuardianSetCellDataHex(cell.outputData);

  assertNotAborted(params.signal);
  const vaa = await params.fetchUpgradeVaa(
    currentSet.setIndex,
    params.signal,
  );
  assertNotAborted(params.signal);
  if (!vaa) {
    return { rotated: false, currentIndex: currentSet.setIndex };
  }

  const { mutated, nextSet } = await attachResolvedGuardianSetRotation({
    network: params.network,
    cccClient: params.cccClient,
    tx: params.tx,
    governanceVaa: vaa,
    parseOptions: params.parseOptions,
    signal: params.signal,
  }, cell, currentSet);

  return {
    rotated: true,
    currentIndex: currentSet.setIndex,
    nextIndex: nextSet.setIndex,
    mutated,
    currentSet,
    nextSet,
  };
}
