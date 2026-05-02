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
import type { HermesBinaryUpdateEnvelope } from "../types/hermes.js";
import { attachOraclePullUpdate } from "./pullUpdate.js";
import { attachOracleReadDeps } from "./readDeps.js";

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

