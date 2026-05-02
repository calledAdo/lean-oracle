import type { Client } from "@ckb-ccc/core";
import { ClientPublicMainnet, ClientPublicTestnet } from "@ckb-ccc/core";
import { fetchHermesLatestPriceUpdates } from "../hermes/client.js";
import type { FetchHermesLatestOptions } from "../hermes/client.js";
import {
  composePullUpdateWithFeeRebalance,
  composeReadDepsWithFeeRebalance,
} from "../tx/pipeline.js";
import type {
  CombinedPullUpdateAndFeesParams,
  CombinedReadDepsAndFeesParams,
} from "../tx/pipeline.js";
import { attachOraclePullUpdate } from "../tx/pullUpdate.js";
import type {
  OraclePullUpdateParams,
  OraclePullUpdateResult,
} from "../tx/pullUpdate.js";
import { attachOracleReadDeps } from "../tx/readDeps.js";
import type {
  AttachOracleReadDepsParams,
  AttachOracleReadDepsResult,
} from "../tx/readDeps.js";
import { rebalanceTransactionFeeAfterOracleMutation } from "../tx/rebalanceFees.js";
import type {
  LeanOracleFeeRebalanceContext,
  LeanOracleFeeRebalanceResult,
  LeanOracleFuelCellCandidate,
} from "../tx/rebalanceFees.js";
import type { FeedIdHex } from "../types/hex.js";
import type { HermesBinaryUpdateEnvelope } from "../types/hermes.js";
import type { LeanOracleNetworkConfig } from "../types/network.js";
import type { CccRawTransaction } from "../types/tx.js";
import type { ScriptLike } from "@ckb-ccc/core";
import {
  initiateOracleUpdateTx,
  initiateReadOracleTx,
} from "../tx/workflows.js";

/** @public */
export interface LeanOracleClientOptions {
  network: LeanOracleNetworkConfig;
}

/**
 * Convenience façade over Hermes + CKB transaction helpers (read deps, pull update, fee rebalance).
 *
 * @public
 */
export class LeanOracleClient {
  readonly network: LeanOracleNetworkConfig;
  readonly cccClient: Client;

  constructor(options: LeanOracleClientOptions) {
    this.network = options.network;
    this.cccClient =
      options.network.name === "mainnet"
        ? new ClientPublicMainnet({ url: options.network.ckbJsonRpcUrl })
        : new ClientPublicTestnet({ url: options.network.ckbJsonRpcUrl });
  }

  /**
   * Pull the latest Hermes price-update envelope for the given feed ids (one combined response).
   */
  fetchHermesLatest(
    feedIds: readonly FeedIdHex[],
    options?: FetchHermesLatestOptions,
  ): Promise<HermesBinaryUpdateEnvelope> {
    return fetchHermesLatestPriceUpdates(this.network, feedIds, options);
  }

  /**
   * Draft a **read-deps** transaction with a single oracle `CellDep`.
   *
   * Minimal surface: users usually provide only `feedId` and an optional freshness floor.
   *
   * @public
   */
  draftReadOracleTx(params: {
    feedId: FeedIdHex;
    oracleLockScript?: ScriptLike;
    minPublishTimeUnix?: bigint;
  }) {
    return initiateReadOracleTx({
      network: this.network,
      cccClient: this.cccClient,
      feedId: params.feedId,
      oracleLockScript: params.oracleLockScript,
      minPublishTimeUnix: params.minPublishTimeUnix,
    });
  }

  /**
   * Draft an **oracle update** transaction (consume old oracle cell, create new oracle cell, attach witness + deps).
   *
   * Minimal surface: users usually provide only `feedId` (and optionally a lock override or a pre-fetched Hermes envelope).
   *
   * @public
   */
  draftOracleUpdateTx(params: {
    feedId: FeedIdHex;
    oracleLockScript?: ScriptLike;
    hermesEnvelope?: HermesBinaryUpdateEnvelope;
  }) {
    return initiateOracleUpdateTx({
      network: this.network,
      cccClient: this.cccClient,
      feedId: params.feedId,
      oracleLockScript: params.oracleLockScript,
      hermesEnvelope: params.hermesEnvelope,
    });
  }

  attachReadDeps(
    tx: CccRawTransaction,
    partial: Omit<AttachOracleReadDepsParams, "network" | "cccClient" | "tx">,
  ): Promise<AttachOracleReadDepsResult> {
    return attachOracleReadDeps({
      network: this.network,
      cccClient: this.cccClient,
      ...partial,
      tx,
    });
  }

  attachPullUpdate(
    tx: CccRawTransaction,
    partial: Omit<OraclePullUpdateParams, "network" | "cccClient" | "tx">,
  ): Promise<OraclePullUpdateResult> {
    return attachOraclePullUpdate({
      network: this.network,
      cccClient: this.cccClient,
      ...partial,
      tx,
    });
  }

  rebalanceFees(
    tx: CccRawTransaction,
    ctx: LeanOracleFeeRebalanceContext,
  ): Promise<LeanOracleFeeRebalanceResult> {
    return rebalanceTransactionFeeAfterOracleMutation(tx, ctx);
  }

  composeReadDepsWithFees(
    params: Omit<CombinedReadDepsAndFeesParams, "network"> & {
      tx: CccRawTransaction;
    },
  ) {
    return composeReadDepsWithFeeRebalance({
      network: this.network,
      ...params,
    });
  }

  composePullUpdateWithFees(
    params: Omit<CombinedPullUpdateAndFeesParams, "network"> & {
      tx: CccRawTransaction;
    },
  ) {
    return composePullUpdateWithFeeRebalance({
      network: this.network,
      ...params,
    });
  }
}

export type { LeanOracleFuelCellCandidate };
