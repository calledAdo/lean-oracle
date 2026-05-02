/**
 * Discover live oracle **`Cell`**s constrained by (**type script ≡ oracle + feed id**, **Lock script**) pair.
 *
 * Anyone may deploy oracle state under any **Lock**. Public curators historically default to
 * **`AlwaysSuccess`** locks so third parties may spend/update without auth-gating the lock —
 * callers override **`oracleLockScript`** when they mint “private” oracles keyed to **`secp256k1`**, etc.
 */

import { Script } from "@ckb-ccc/core";
import type { Client, ScriptLike } from "@ckb-ccc/core";

import { LeanOracleSdkError } from "../errors.js";
import { normalizePythFeedId } from "../hermes/client.js";
import { decodeLeanOracleCellDataHex } from "./decodeOracleData.js";
import type { LeanOracleLiveCellLike } from "../types/cells.js";
import type { LeanOracleDeployment } from "../types/deployment.js";
import type { FeedIdHex } from "../types/hex.js";

/** Default page size for CCC **`findCells`** (indexer paging). */
const DEFAULT_FIND_PAGE_LIMIT = 256;

/**
 * @public
 */
export interface FindOracleLiveCellsForFeedOptions {
  /**
   * Network deployment metadata (**oracle type identity** plus optional **`defaultPublicOracleLockScript`** pinning).
   */
  deployment: LeanOracleDeployment;

  /**
   * **Lock script override** — when **`undefined`**, selects **`deployment.defaultPublicOracleLockScript`**,
   * allowing fully deterministic “public oracle” scans without `KnownScript` tables.
   */
  oracleLockScript?: ScriptLike;

  /** Optional cooperative cancel between RPC pages. */
  signal?: AbortSignal;

  /** Max cells per indexer page (CCC default is small — we raise throughput for curator scans). */
  pageLimit?: number;

  /**
   * Inclusive **`publish_time`** floor after decoding oracle **`cell_data`**
   * (**unix seconds**, same semantics as **`LeanOracleDecodedCellData.publishTimeUnix`**).
   */
  minPublishTimeUnix?: bigint;
}

/**
 * Stream indexer results in `"desc"` order and return the first cell whose decoded publish-time
 * passes the optional freshness floor.
 *
 * This is the “fast path” used by transaction drafters that only need **one** oracle cell (latest),
 * avoiding the drain-then-sort behaviour of “collect all + sort”.
 *
 * @public
 */
export async function findLatestOracleLiveCellForFeed(
  client: Client,
  feedId: FeedIdHex,
  options: FindOracleLiveCellsForFeedOptions,
): Promise<LeanOracleLiveCellLike | undefined> {
  if (options.signal?.aborted) {
    throw new LeanOracleSdkError("findLatestOracleLiveCellForFeed aborted", {
      cause: options.signal.reason,
    });
  }

  const oracleType = buildOracleTypeScript(options.deployment, feedId);
  const oracleLock = resolveOracleLockForQuery(
    options.deployment,
    options.oracleLockScript,
  );
  const pageLimit = options.pageLimit ?? DEFAULT_FIND_PAGE_LIMIT;

  const searchKey = {
    script: oracleLock,
    scriptType: "lock" as const,
    scriptSearchMode: "exact" as const,
    filter: { script: oracleType },
    withData: true as const,
  };

  for await (const cell of client.findCells(searchKey, "desc", pageLimit)) {
    if (options.signal?.aborted) {
      throw new LeanOracleSdkError("findLatestOracleLiveCellForFeed aborted", {
        cause: options.signal.reason,
      });
    }

    const oracleDataHex = cell.outputData;
    const decoded = decodeLeanOracleCellDataHex(oracleDataHex);
    if (
      options.minPublishTimeUnix !== undefined &&
      decoded.publishTimeUnix < options.minPublishTimeUnix
    ) {
      continue;
    }

    return {
      outPoint: { txHash: cell.outPoint.txHash, index: cell.outPoint.index },
      oracleDataHex,
    };
  }

  return undefined;
}

function resolveOracleLockForQuery(
  deployment: LeanOracleDeployment,
  explicit: ScriptLike | undefined,
): Script {
  if (explicit) {
    /** Caller owns bespoke locks — indexer query matches their cells exactly. */
    return Script.from(explicit);
  }

  const preset = deployment.defaultPublicOracleLockScript;
  return Script.from({
    codeHash: preset.codeHash,
    hashType: preset.hashType,
    args: preset.args ?? "0x",
  });
}

/**
 * Compose the oracle **`type`** script CCC’s indexer recognizes for this feed (**32-byte feed id args**).
 */
function buildOracleTypeScript(
  deployment: LeanOracleDeployment,
  feedId: FeedIdHex,
): Script {
  const hash = deployment.oracleTypeScriptCodeHash;
  if (!hash?.trim()) {
    throw new LeanOracleSdkError(
      "`deployment.oracleTypeScriptCodeHash` is required to locate oracle cells via the indexer",
    );
  }

  /*
   * `normalizePythFeedId` keeps indexer args identical to **`hermes`/on-chain literals**
   * (`0x` + lowercase 64 nibbles).
   */
  const argsHex = normalizePythFeedId(feedId);

  return Script.from({
    codeHash: hash,
    /*
     * **Type-scripts** validating **`oracle_script`** cell data are usually deployed as **`hashType: type`**, but curated
     * deployments pinning **`data*`** hashing must flip this field accordingly.
     */
    hashType: deployment.oracleTypeScriptHashType ?? "type",
    args: argsHex,
  });
}
