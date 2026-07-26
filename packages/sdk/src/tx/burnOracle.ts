import type { Client, ScriptLike, Transaction } from "@ckb-ccc/core";
import { Script } from "@ckb-ccc/core";

import { findLatestOracleLiveCellForFeed } from "../ckb/findOracleCells.js";
import { LeanOracleSdkError } from "../errors.js";
import type { FeedIdHex } from "../types/hex.js";
import type { LeanOracleNetworkConfig } from "../types/network.js";
import type { LeanOracleCellOutPoint } from "../types/deployment.js";

/**
 * @public
 */
export interface OracleBurnParams {
  network: LeanOracleNetworkConfig;
  cccClient: Client;
  tx: Transaction;
  /** Feed keyed by oracle type-script args. */
  feedId: FeedIdHex;
  /**
   * Lock-script override used to discover the oracle cell to burn. Should
   * match the lock under which the personal oracle cell was deployed.
   *
   * When omitted, oracle discovery uses the deployment's default public lock.
   */
  oracleLockScript?: ScriptLike;
  /** Exact oracle input to burn, bypassing latest-cell discovery. */
  oracleOutPoint?: LeanOracleCellOutPoint;
}

/**
 * @public
 */
export interface OracleBurnResult {
  mutated: Transaction;
  /** Index of the consumed oracle cell in `tx.inputs`. */
  oracleInputIndex: number;
}

function scriptsEqual(a: Script, b: Script): boolean {
  return (
    a.codeHash === b.codeHash &&
    a.hashType === b.hashType &&
    (a.args ?? "0x") === (b.args ?? "0x")
  );
}

/**
 * Attach an oracle-cell **burn** to `tx`.
 *
 * Mirrors the on-chain `oracle_script` burn path (1 group input, 0 group
 * outputs): consumes the live oracle cell for `feedId` and attaches the
 * oracle-type code dep. No output is added — the cell's capacity flows into
 * whatever change cell the fee-rebalance pipeline produces, returning the
 * deposit (minus fee) to the spender.
 *
 * Authorization is enforced by the cell's **lock script**, not the type
 * script. Only a transaction that satisfies the lock can burn the cell.
 *
 * @public
 */
export async function attachOracleBurn(
  params: OracleBurnParams,
): Promise<OracleBurnResult> {
  const deployment = params.network.deployment;
  const client = params.cccClient;

  // ── ① Locate the oracle cell to burn ─────────────────────────────────────
  const oracleOutPoint = params.oracleOutPoint ?? (
    await findLatestOracleLiveCellForFeed(client, params.feedId, {
      deployment,
      oracleLockScript: params.oracleLockScript,
    })
  )?.outPoint;
  if (!oracleOutPoint) {
    throw new LeanOracleSdkError(`No oracle live cell found for feed ${params.feedId}`);
  }

  const inputCell = await client.getCell(oracleOutPoint);
  if (!inputCell) {
    throw new LeanOracleSdkError(
      `Oracle input cell not found on-chain at ${oracleOutPoint.txHash}:${oracleOutPoint.index.toString()}`,
    );
  }
  const inputType = inputCell.cellOutput.type;
  if (
    !inputType ||
    inputType.codeHash !== deployment.oracleType.codeHash ||
    inputType.hashType !== deployment.oracleType.hashType ||
    inputType.args !== params.feedId
  ) {
    throw new LeanOracleSdkError(
      `Oracle input ${oracleOutPoint.txHash}:${oracleOutPoint.index.toString()} does not match the configured oracle type and feed`,
    );
  }

  // ── ② Attach oracle type-script code dep (still executes on burn) ───────
  params.tx.addCellDeps(deployment.oracleType.codeDep);

  // If the cell is locked by the default public lock, attach its code dep so
  // the lock can execute. Custom locks are the caller's responsibility.
  {
    const publicLock = Script.from({
      codeHash: deployment.defaultPublicOracleLock.script.codeHash,
      hashType: deployment.defaultPublicOracleLock.script.hashType,
      args: deployment.defaultPublicOracleLock.script.args ?? "0x",
    });
    if (scriptsEqual(Script.from(inputCell.cellOutput.lock), publicLock)) {
      params.tx.addCellDeps(deployment.defaultPublicOracleLock.codeDep);
    }
  }

  // ── ③ Consume the oracle cell as input, no corresponding output ─────────
  const oracleInputIndex =
    params.tx.addInput({ previousOutput: inputCell.outPoint }) - 1;

  return { mutated: params.tx, oracleInputIndex };
}
