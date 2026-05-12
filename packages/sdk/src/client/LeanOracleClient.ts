import type { Client, ScriptLike } from "@ckb-ccc/core";
import { ClientPublicMainnet, ClientPublicTestnet } from "@ckb-ccc/core";
import { decodeLeanOracleCellDataHex } from "../ckb/decodeOracleData.js";
import { findLatestOracleLiveCellForFeed } from "../ckb/findOracleCells.js";
import { fetchHermesLatestPriceUpdates } from "../hermes/client.js";
import type { FetchHermesLatestOptions } from "../hermes/client.js";
import type {
  LeanOracleCellDataHex,
  LeanOracleDecodedCellData,
} from "../types/cells.js";
import type { LeanOracleCellOutPoint } from "../types/deployment.js";
import type { FeedIdHex } from "../types/hex.js";
import type {
  HermesBinaryUpdateEnvelope,
  OracleUpdateOutputSource,
} from "../types/hermes.js";
import type { LeanOracleNetworkConfig } from "../types/network.js";
import {
  initiateOracleUpdateTx,
  initiateReadOracleTx,
} from "../tx/workflows.js";

/**
 * Result of {@link LeanOracleClient.getOracleCellState}: outpoint + raw hex
 * (handy for cell-dep wiring) plus the decoded `OracleData` view.
 *
 * @public
 */
export interface LeanOracleCellStateResult {
  outPoint: LeanOracleCellOutPoint;
  oracleDataHex: LeanOracleCellDataHex;
  data: LeanOracleDecodedCellData;
}

/** @public */
export interface LeanOracleClientOptions {
  network: LeanOracleNetworkConfig;
  /**
   * Optional preconfigured CCC `Client`. When omitted, the SDK constructs a
   * public client from `network.ckbJsonRpcUrl` (`ClientPublicMainnet` for
   * `network.name === "mainnet"`, `ClientPublicTestnet` otherwise).
   *
   * Pass a custom client when you need to:
   * - reuse a single CCC client across services (connection pooling, caching),
   * - point at a private / authenticated CKB endpoint with custom transports,
   * - inject a fake/mock client in tests.
   */
  cccClient?: Client;
}

/**
 * Product-level façade over the Lean Oracle SDK.
 *
 * Exposes only high-level operations: Hermes fetches and ready-to-sign
 * transaction drafts. Lower-level helpers (read-deps attachment, pull-update
 * mutation, fee rebalancing, compose pipelines) are available via the
 * `lean-oracle-sdk/tx` and `lean-oracle-sdk/advanced`
 * subpath imports.
 *
 * @public
 */
export class LeanOracleClient {
  readonly network: LeanOracleNetworkConfig;
  readonly cccClient: Client;

  constructor(options: LeanOracleClientOptions) {
    this.network = options.network;
    this.cccClient =
      options.cccClient ??
      (options.network.name === "mainnet"
        ? new ClientPublicMainnet({ url: options.network.ckbJsonRpcUrl })
        : new ClientPublicTestnet({ url: options.network.ckbJsonRpcUrl }));
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
   * Locate and decode the latest live oracle cell for `feedId`.
   *
   * Returns the chosen out-point, the raw `cell_data` hex, and the decoded
   * `OracleData` view in a single result. Returns `undefined` when no matching
   * cell exists (e.g. wrong network, no oracle deployed yet, or every candidate
   * fails the optional `minPublishTimeUnix` floor).
   *
   * Read-only: performs only the discovery RPC already issued by
   * `findLatestOracleLiveCellForFeed`.
   *
   * @public
   */
  async getOracleCellState(params: {
    feedId: FeedIdHex;
    oracleLockScript?: ScriptLike;
    minPublishTimeUnix?: bigint;
  }): Promise<LeanOracleCellStateResult | undefined> {
    const live = await findLatestOracleLiveCellForFeed(
      this.cccClient,
      params.feedId,
      {
        deployment: this.network.deployment,
        oracleLockScript: params.oracleLockScript,
        minPublishTimeUnix: params.minPublishTimeUnix,
      },
    );
    if (!live) return undefined;

    return {
      outPoint: live.outPoint,
      oracleDataHex: live.oracleDataHex,
      data: decodeLeanOracleCellDataHex(live.oracleDataHex),
    };
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
   * Minimal surface: users usually provide only `feedId` (and optionally a
   * lock override, a pre-fetched Hermes envelope, or an `outputSource`).
   *
   * Pass `outputSource: "binary"` to derive output-cell fields by parsing
   * `binary.data[0]` client-side instead of trusting Hermes `parsed`. The
   * default (`"hermes-parsed"`) preserves the existing fast path. Either way
   * the contract verifies `binary` on-chain.
   *
   * @public
   */
  draftOracleUpdateTx(params: {
    feedId: FeedIdHex;
    oracleLockScript?: ScriptLike;
    hermesEnvelope?: HermesBinaryUpdateEnvelope;
    outputSource?: OracleUpdateOutputSource;
  }) {
    return initiateOracleUpdateTx({
      network: this.network,
      cccClient: this.cccClient,
      feedId: params.feedId,
      oracleLockScript: params.oracleLockScript,
      hermesEnvelope: params.hermesEnvelope,
      outputSource: params.outputSource,
    });
  }
}
