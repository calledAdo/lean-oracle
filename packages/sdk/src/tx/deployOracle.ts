import type { CellOutputLike, Client, ScriptLike, Transaction } from "@ckb-ccc/core";
import { Script, hashCkb, hexFrom } from "@ckb-ccc/core";

import { encodeOracleCellDataBytes } from "../ckb/encodeOracleData.js";
import {
  attachGuardianSetCellDep,
  resolveGuardianSetCellDep,
} from "../ckb/guardianDep.js";
import type { LeanOracleDecodedCellData } from "../types/cells.js";
import type { FeedIdHex, HexString } from "../types/hex.js";
import type { LeanOracleNetworkConfig } from "../types/network.js";

/**
 * Initial dynamic price fields for a freshly created oracle cell.
 *
 * The on-chain `oracle_script` does **not** authenticate price fields on the
 * creation path. Any structurally valid `OracleData` is accepted; the first
 * real update overwrites these. All fields default to zero when omitted.
 *
 * @public
 */
export interface OracleDeployInitialPrice {
  price?: bigint;
  conf?: bigint;
  expo?: number;
  publishTimeUnix?: bigint;
  prevPublishTimeUnix?: bigint;
  emaPrice?: bigint;
  emaConf?: bigint;
}

/**
 * @public
 */
export interface OracleDeployParams {
  network: LeanOracleNetworkConfig;
  cccClient: Client;
  tx: Transaction;
  /**
   * Pyth feed id this oracle cell will track. Used as both the oracle type
   * script `args` and as the `feed_id` field inside `OracleData`. The on-chain
   * create path enforces that the two match.
   */
  feedId: FeedIdHex;
  /**
   * User-supplied lock script for the new oracle cell. This lock governs who
   * can later consume the cell (i.e. who is permitted to submit updates).
   */
  oracleLockScript: ScriptLike;
  /**
   * Type-hash of the guardian-set cell whose lineage this oracle anchors to.
   *
   * Defaults to the type-hash derived from `network.deployment.guardianSetType`
   * (`codeHash + hashType + args`) — the canonical guardian set bundled with
   * the network preset. Override only if anchoring to a non-canonical guardian
   * set.
   */
  guardianSetTypeHash?: HexString;
  /**
   * Initial price-field values. The creation path does not authenticate these,
   * so any structurally valid values are accepted. Defaults to all zeros.
   */
  initialPrice?: OracleDeployInitialPrice;
  /**
   * Capacity (in shannons) to assign to the new oracle output cell. The caller
   * is responsible for choosing a value that covers occupied capacity for the
   * lock + type + 152-byte oracle data. Fee balancing is left to the existing
   * fee-rebalance pipeline.
   */
  capacity: bigint;
}

/**
 * @public
 */
export interface OracleDeployResult {
  mutated: Transaction;
  /** Index of the newly added oracle output cell in `tx.outputs`. */
  oracleOutputIndex: number;
}

/**
 * Attach a personal oracle-cell **creation** to `tx`.
 *
 * Mirrors the on-chain `oracle_script` creation path (0 group inputs,
 * 1 group output): builds the oracle type script with `feedId` as args,
 * encodes an `OracleData` payload whose `guardian_set_type_hash` resolves to
 * exactly one live guardian-set dep, and attaches the required code deps.
 *
 * No witness is added — the creation path is not witness-authenticated. The
 * caller's lock script governs subsequent updates.
 *
 * @public
 */
export async function attachOracleDeploy(
  params: OracleDeployParams,
): Promise<OracleDeployResult> {
  const { network, cccClient, tx } = params;
  const deployment = network.deployment;

  const guardianSetTypeHash =
    params.guardianSetTypeHash ??
    hashCkb(
      Script.from({
        codeHash: deployment.guardianSetType.codeHash,
        hashType: deployment.guardianSetType.hashType,
        args: deployment.guardianSetType.args,
      }).toBytes(),
    );
  const emitterChain = deployment.pythEmitter.chain;
  const emitterAddress = deployment.pythEmitter.address;

  // ── ① Oracle type script bound to this feed id ───────────────────────────
  const oracleTypeScript = Script.from({
    codeHash: deployment.oracleType.codeHash,
    hashType: deployment.oracleType.hashType,
    args: params.feedId,
  });

  // ── ② Encode the initial OracleData payload ──────────────────────────────
  const initial = params.initialPrice ?? {};
  const decoded: LeanOracleDecodedCellData = {
    feedId: params.feedId,
    guardianSetTypeHash,
    emitterChain,
    emitterAddress,
    price: initial.price ?? 0n,
    conf: initial.conf ?? 0n,
    expo: initial.expo ?? 0,
    publishTimeUnix: initial.publishTimeUnix ?? 0n,
    prevPublishTimeUnix: initial.prevPublishTimeUnix ?? 0n,
    emaPrice: initial.emaPrice ?? 0n,
    emaConf: initial.emaConf ?? 0n,
  };
  const oracleDataHex = hexFrom(encodeOracleCellDataBytes(decoded));

  // ── ③ Resolve & attach the guardian-set dep the contract will look up ───
  const guardianDep = await resolveGuardianSetCellDep(cccClient, deployment, {
    expectedGuardianSetTypeHash: guardianSetTypeHash,
  });
  attachGuardianSetCellDep(tx, guardianDep);

  // Oracle type script code dep (needed to execute the script on creation).
  tx.addCellDeps(deployment.oracleType.codeDep);

  // ── ④ Add the new oracle output cell ─────────────────────────────────────
  const cellOutput: CellOutputLike = {
    capacity: params.capacity,
    lock: params.oracleLockScript,
    type: oracleTypeScript,
  };
  const outputsLen = tx.addOutput(
    { cellOutput, outputData: oracleDataHex },
  );
  const oracleOutputIndex = outputsLen - 1;

  return { mutated: tx, oracleOutputIndex };
}
