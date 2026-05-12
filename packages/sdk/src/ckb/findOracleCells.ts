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
 * Drain all matching oracle live cells (oracle type + feed id, under the resolved lock)
 * and return the one with the greatest decoded **`publishTimeUnix`**.
 *
 * Indexer ordering (`"desc"` by block / tx index) does **not** track oracle freshness:
 * the authenticated `publish_time` carried in `OracleData` is the only correct ordering
 * key, and update transactions can land out of `publish_time` order. We therefore scan
 * every match and pick by decoded publish time.
 *
 * Tie-break: when multiple cells share the maximum `publishTimeUnix`, the first one
 * yielded by the indexer (`desc` order) wins, keeping selection deterministic.
 *
 * Malformed candidate `cell_data` is treated as deployment/index corruption and surfaces
 * as a `LeanOracleSdkError` whose **message** names the offending out-point and whose
 * **`cause`** carries the original `LeanOracleCellDataDecodeError`, rather than being
 * silently skipped — silently skipping could let a stale-but-valid cell shadow what
 * should be a louder failure mode.
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

  const searchKey = options.oracleLockScript
    ? {
        /*
         * Case A: Explicit lock provided. We search within this owner/lock domain
         * as the primary anchor and filter for the oracle type + feed.
         */
        script: oracleLock,
        scriptType: "lock" as const,
        scriptSearchMode: "exact" as const,
        filter: { script: oracleType },
        withData: true as const,
      }
    : {
        /*
         * Case B: Using default public lock. The oracle type script (with feed id)
         * is the more selective anchor, so we use it as the primary search script
         * and filter by the public lock.
         */
        script: oracleType,
        scriptType: "type" as const,
        scriptSearchMode: "exact" as const,
        filter: { script: oracleLock },
        withData: true as const,
      };

  let best: LeanOracleLiveCellLike | undefined;
  let bestPublishTime: bigint | undefined;

  for await (const cell of client.findCells(searchKey, "desc", pageLimit)) {
    if (options.signal?.aborted) {
      throw new LeanOracleSdkError("findLatestOracleLiveCellForFeed aborted", {
        cause: options.signal.reason,
      });
    }

    const oracleDataHex = cell.outputData;
    let publishTimeUnix: bigint;
    try {
      ({ publishTimeUnix } = decodeLeanOracleCellDataHex(oracleDataHex));
    } catch (cause) {
      throw new LeanOracleSdkError(
        `Malformed oracle cell_data at ${cell.outPoint.txHash}:${cell.outPoint.index.toString()} for feed ${feedId}: ` +
          `cannot determine publish time during latest-cell selection`,
        { cause },
      );
    }

    if (
      options.minPublishTimeUnix !== undefined &&
      publishTimeUnix < options.minPublishTimeUnix
    ) {
      continue;
    }

    /*
     * Strict `>` keeps the first-seen cell on ties; combined with `desc` indexer
     * order this is deterministic across runs against the same chain state.
     */
    if (bestPublishTime === undefined || publishTimeUnix > bestPublishTime) {
      bestPublishTime = publishTimeUnix;
      best = {
        outPoint: { txHash: cell.outPoint.txHash, index: cell.outPoint.index },
        oracleDataHex,
      };
    }
  }

  return best;
}

function resolveOracleLockForQuery(
  deployment: LeanOracleDeployment,
  explicit: ScriptLike | undefined,
): Script {
  if (explicit) {
    /** Caller owns bespoke locks — indexer query matches their cells exactly. */
    return Script.from(explicit);
  }

  const preset = deployment.defaultPublicOracleLock.script;
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
  const identity = deployment.oracleType;
  const hash = identity.codeHash;
  if (!hash?.trim()) {
    throw new LeanOracleSdkError(
      "`deployment.oracleType.codeHash` is required to locate oracle cells via the indexer",
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
    hashType: identity.hashType ?? "type",
    args: argsHex,
  });
}
