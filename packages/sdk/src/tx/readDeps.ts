import type { CellDepLike, Client, ScriptLike, Transaction } from "@ckb-ccc/core";
import { Script } from "@ckb-ccc/core";
import type { FeedIdHex } from "../types/hex.js";
import type { LeanOracleNetworkConfig } from "../types/network.js";
import { LeanOracleSdkError } from "../errors.js";
import { findLatestOracleLiveCellForFeed } from "../ckb/findOracleCells.js";

export interface AttachOracleReadDepsParams {
  network: LeanOracleNetworkConfig;
  cccClient: Client;
  tx: Transaction;
  feedId: FeedIdHex;
  /**
   * Optional freshness floor.
   *
   * When provided, the SDK skips oracle cells whose decoded `publish_time` is older than this value
   * (**unix seconds**, same semantics as `LeanOracleDecodedCellData.publishTimeUnix`).
   */
  minPublishTimeUnix?: bigint;
  /**
   * Optional lock-script override when resolving “latest”.
   *
   * When omitted, `findLatestOracleLiveCellForFeed` defaults to the deployment’s public lock
   * (typically AlwaysSuccess).
   */
  oracleLockScript?: ScriptLike;
}

export interface AttachOracleReadDepsResult {
  mutated: Transaction;
}

/**
 * Ensures oracle **state cell** (+ optional **code deps**) are present strictly for downstream scripts to read [`OracleData`].
 *
 * @public
 */
export async function attachOracleReadDeps(
  params: AttachOracleReadDepsParams,
): Promise<AttachOracleReadDepsResult> {
  const deployment = params.network.deployment;
  const client = params.cccClient;

  const chosen = await findLatestOracleLiveCellForFeed(client, params.feedId, {
    deployment,
    oracleLockScript: params.oracleLockScript
      ? Script.from(params.oracleLockScript)
      : undefined,
    signal: undefined,
    minPublishTimeUnix: params.minPublishTimeUnix,
  });

  if (!chosen) {
    throw new LeanOracleSdkError(
      `No oracle live cell found for feed ${params.feedId} matching read-deps criteria`,
    );
  }

  /*
   * The oracle “read deps” path requires the oracle cell to be referenced as a `CellDep`
   * so downstream scripts can load and parse its `cell_data` (`OracleData`).
   *
   * We model it as a plain dependency (depType `"code"` is conventional in tooling even for data cells).
   */
  const oracleCellDep: CellDepLike = {
    outPoint: {
      txHash: chosen.outPoint.txHash,
      index: chosen.outPoint.index,
    },
    depType: "code",
  };

  // Attach oracle type-script code dep when provided.
  params.tx.addCellDeps({
    outPoint: deployment.oracleTypeScriptCodeDepOutPoint,
    depType: "code",
  });

  params.tx.addCellDeps(oracleCellDep);
  return { mutated: params.tx };
}
