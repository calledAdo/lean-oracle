/**
 * @packageDocumentation
 *
 * High-level “draft tx” helpers.
 *
 * These functions build a structurally correct CCC `Transaction` but intentionally do **not**
 * add fee-paying inputs or change outputs. Consumers can run the fee helper afterward
 * (e.g. `rebalanceTransactionFeeAfterOracleMutation`) and then sign.
 */

import type { Client as CccClient } from "@ckb-ccc/core";
import { Transaction } from "@ckb-ccc/core";
import type { ScriptLike } from "@ckb-ccc/core";

import type { FeedIdHex } from "../types/hex.js";
import type { LeanOracleNetworkConfig } from "../types/network.js";
import type {
  HermesBinaryUpdateEnvelope,
  OracleUpdateOutputSource,
} from "../types/hermes.js";
import { attachOraclePullUpdate } from "./pullUpdate.js";
import { attachOracleReadDeps } from "./readDeps.js";
import {
  attachOracleDeploy,
  type OracleDeployInitialPrice,
} from "./deployOracle.js";
import { attachOracleBurn } from "./burnOracle.js";
import type { HexString } from "../types/hex.js";

/**
 * @public
 */
export interface InitiateOracleUpdateParams {
  network: LeanOracleNetworkConfig;
  cccClient: CccClient;
  feedId: FeedIdHex;
  oracleLockScript?: ScriptLike;
  /**
   * Optional Hermes update envelope.
   *
   * If omitted, the SDK fetches from Hermes during drafting.
   */
  hermesEnvelope?: HermesBinaryUpdateEnvelope;

  /**
   * Selects how the SDK derives **dynamic price fields** for the new oracle
   * output cell. Defaults to `"hermes-parsed"`. See
   * {@link OracleUpdateOutputSource}.
   */
  outputSource?: OracleUpdateOutputSource;
}

/**
 * Draft an oracle **update** transaction (no fee inputs/outputs).
 *
 * @public
 */
export async function initiateOracleUpdateTx(
  params: InitiateOracleUpdateParams,
): Promise<Transaction> {
  const tx = Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs: [],
    outputs: [],
    outputsData: [],
    witnesses: [],
  });

  const res = await attachOraclePullUpdate({
    network: params.network,
    cccClient: params.cccClient,
    tx,
    feedId: params.feedId,
    oracleLockScript: params.oracleLockScript,
    hermesEnvelope: params.hermesEnvelope,
    outputSource: params.outputSource,
  });

  return res.mutated;
}

/**
 * @public
 */
export interface InitiateReadOracleTxParams {
  network: LeanOracleNetworkConfig;
  cccClient: CccClient;
  feedId: FeedIdHex;
  oracleLockScript?: ScriptLike;
  minPublishTimeUnix?: bigint;
}

/**
 * Draft an oracle **read-deps** transaction (no fee inputs/outputs).
 *
 * This attaches the freshest oracle cell (within `minPublishTimeUnix`) as a `CellDep`.
 *
 * @public
 */
export async function initiateReadOracleTx(
  params: InitiateReadOracleTxParams,
): Promise<Transaction> {
  const tx = Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs: [],
    outputs: [],
    outputsData: [],
    witnesses: [],
  });

  const res = await attachOracleReadDeps({
    network: params.network,
    cccClient: params.cccClient,
    tx,
    feedId: params.feedId,
    oracleLockScript: params.oracleLockScript,
    minPublishTimeUnix: params.minPublishTimeUnix,
  });

  return res.mutated;
}

/**
 * @public
 */
export interface InitiateOracleDeployTxParams {
  network: LeanOracleNetworkConfig;
  cccClient: CccClient;
  feedId: FeedIdHex;
  /** User-supplied lock for the new oracle cell (governs subsequent updates). */
  oracleLockScript: ScriptLike;
  /** Capacity (shannons) for the new oracle cell. */
  capacity: bigint;
  /** Override the guardian-set type hash; defaults to the network preset. */
  guardianSetTypeHash?: HexString;
  /** Initial price-field values; defaults to all zeros. */
  initialPrice?: OracleDeployInitialPrice;
}

/**
 * Draft an oracle **deploy** transaction that creates a new personal oracle
 * cell under a caller-supplied lock (no fee inputs/outputs).
 *
 * @public
 */
export async function initiateOracleDeployTx(
  params: InitiateOracleDeployTxParams,
): Promise<Transaction> {
  const tx = Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs: [],
    outputs: [],
    outputsData: [],
    witnesses: [],
  });

  const res = await attachOracleDeploy({
    network: params.network,
    cccClient: params.cccClient,
    tx,
    feedId: params.feedId,
    oracleLockScript: params.oracleLockScript,
    capacity: params.capacity,
    guardianSetTypeHash: params.guardianSetTypeHash,
    initialPrice: params.initialPrice,
  });

  return res.mutated;
}

/**
 * @public
 */
export interface InitiateOracleBurnTxParams {
  network: LeanOracleNetworkConfig;
  cccClient: CccClient;
  feedId: FeedIdHex;
  /** Lock under which the oracle cell to burn was deployed. */
  oracleLockScript?: ScriptLike;
}

/**
 * Draft an oracle **burn** transaction that destroys a personal oracle cell
 * (no fee inputs/outputs). The consumed cell's capacity returns to the spender
 * via the fee-rebalance pipeline's change output.
 *
 * @public
 */
export async function initiateOracleBurnTx(
  params: InitiateOracleBurnTxParams,
): Promise<Transaction> {
  const tx = Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs: [],
    outputs: [],
    outputsData: [],
    witnesses: [],
  });

  const res = await attachOracleBurn({
    network: params.network,
    cccClient: params.cccClient,
    tx,
    feedId: params.feedId,
    oracleLockScript: params.oracleLockScript,
  });

  return res.mutated;
}

