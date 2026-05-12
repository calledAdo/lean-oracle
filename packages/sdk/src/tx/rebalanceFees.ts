import type { Client, ScriptLike, Transaction } from "@ckb-ccc/core";
import { Script } from "@ckb-ccc/core";
import type { LeanOracleCellOutPoint } from "../types/deployment.js";
import { LeanOracleSdkError } from "../errors.js";

/**
 * Minimum capacity for a “simple” change cell (no type script, no data), in shannons.
 *
 * This matches the constant used in your existing fuel balancer code.
 *
 * @public
 */
export const MIN_CELL_CAPACITY_SHANNONS = 61n * 100_000_000n;

/** Fuel CKB inputs (live cells) a fee balancer may attach for capacity top-up. */
export interface LeanOracleFuelCellCandidate {
  outPoint: LeanOracleCellOutPoint;
  /** Total cell capacity minus already-committed occupying amounts (scaffold simplifies to full capacity later). */
  capacityShannons: bigint;
  /** Presence for future sighash-type nuances; scaffold placeholder. */
  lockScriptHashPlaceholder?: bigint;
}

/**
 * Collect spendable “plain” CKB cells for fee payment.
 *
 * A “plain” cell here means:
 * - `type` script is **absent**
 * - `outputData` is exactly `"0x"`
 *
 * This matches the common “capacity-only” fee inputs pattern.
 *
 * Returned candidates are sorted **descending** by capacity (largest first), which the greedy
 * rebalancer expects.
 *
 * @public
 */
export async function collectPlainFuelCellsByLock(
  client: Client,
  lockScript: ScriptLike,
  options?: { signal?: AbortSignal; limit?: number },
): Promise<LeanOracleFuelCellCandidate[]> {
  const lock = Script.from(lockScript);
  const limit = options?.limit ?? 10_000;

  const out: LeanOracleFuelCellCandidate[] = [];

  for await (const cell of client.findCellsByLock(lock, null, true, "desc", 256)) {
    if (options?.signal?.aborted) {
      throw new LeanOracleSdkError("collectPlainFuelCellsByLock aborted", {
        cause: options.signal.reason,
      });
    }
    if (out.length >= limit) break;
    if (cell.cellOutput.type) continue;
    if (cell.outputData !== "0x") continue;

    out.push({
      outPoint: { txHash: cell.outPoint.txHash, index: cell.outPoint.index },
      capacityShannons: cell.cellOutput.capacity,
    });
  }

  out.sort((a, b) => (a.capacityShannons > b.capacityShannons ? -1 : 1));
  return out;
}

/**
 * Compute the current “net capacity available” for paying fees:
 *
 * \[
 *   \\text{net} = \\sum \\text{inputs.capacity} - \\sum \\text{outputs.capacity}
 * \]
 *
 * This mirrors the `initialCummulativeTxNet` notion from other balancers.
 *
 * @public
 */
export async function computeCumulativeNetCapacityShannons(
  tx: Transaction,
  client: Client,
): Promise<bigint> {
  const inputCap = await tx.getInputsCapacity(client);
  const outputCap = tx.getOutputsCapacity();
  return inputCap - outputCap;
}

/**
 * Convenience wrapper: collect plain fuel cells, compute net capacity, then run the greedy rebalancer.
 *
 * This is the “batteries included” entrypoint for non-oracle txs too.
 *
 * @public
 */
export async function rebalanceFuel(
  tx: Transaction,
  params: {
    cccClient: Client;
    /**
     * The initiator’s lock script.
     *
     * By default this SDK assumes:
     * - fuel inputs come from plain cells locked by this script
     * - the change output (if emitted) is locked by this script
     */
    lockScript: ScriptLike;
    /**
     * Optional override: use a different lock for the change output than the one used
     * to source fuel inputs.
     */
    changeLockScriptOverride?: ScriptLike;
    minimumChangeCellCapacity?: bigint;
    force?: boolean;
    feeRateShannonsPerKbOverride?: bigint;
    signal?: AbortSignal;
    fuelLimit?: number;
  },
): Promise<LeanOracleFeeRebalanceResult> {
  const fuel = await collectPlainFuelCellsByLock(
    params.cccClient,
    params.lockScript,
    { signal: params.signal, limit: params.fuelLimit },
  );
  const net = await computeCumulativeNetCapacityShannons(tx, params.cccClient);
  return rebalanceTransactionFeeAfterOracleMutation(tx, {
    cccClient: params.cccClient,
    cumulativeNetCapacityShannons: net,
    sortedFuelCandidates: fuel,
    changeLockScript: params.changeLockScriptOverride ?? params.lockScript,
    minimumChangeCellCapacity: params.minimumChangeCellCapacity,
    force: params.force,
    feeRateShannonsPerKbOverride: params.feeRateShannonsPerKbOverride,
  });
}

/** @public */
export interface LeanOracleFeeRebalanceContext {
  /** CCC client used for fee-rate lookups and cell hydration. */
  cccClient: Client;

  /**
   * Current net capacity already available for paying fees, expressed in shannons.
   *
   * This is typically: `sum(signer_inputs.capacity) - sum(outputs.capacity)` **before**
   * this function adds extra “fuel” inputs and a change output.
   */
  cumulativeNetCapacityShannons: bigint;

  /**
   * Candidate plain-capacity cells that can be added as fee-paying inputs.
   *
   * Must be sorted **descending** by `capacityShannons` (largest first).
   */
  sortedFuelCandidates: LeanOracleFuelCellCandidate[];

  /** Lock script for the change output that receives remaining capacity after fees. */
  changeLockScript: ScriptLike;

  /**
   * Minimum capacity of the change cell.
   *
   * Defaults to {@link MIN_CELL_CAPACITY_SHANNONS}.
   */
  minimumChangeCellCapacity?: bigint;

  /**
   * When true, allow spending fuel without emitting change if we can at least cover the fee.
   * (Useful for “burn remaining capacity as fee” flows.)
   */
  force?: boolean;

  /** Optional explicit fee-rate override in shannons per KB. When omitted, uses `cccClient.getFeeRate()`. */
  feeRateShannonsPerKbOverride?: bigint;
}

export interface LeanOracleFeeRebalanceSuccess {
  status: "ok";
  mutated: Transaction;
  feePaidShannons: bigint;
  fuelInputsAdded: number;
  changeOutputAdded: boolean;
}

export interface LeanOracleFeeRebalanceShortfall {
  status: "insufficient";
  mutated: Transaction;
  feeNeededShannons: bigint;
  extraCapacityNeededShannons: bigint;
  fuelInputsAdded: number;
  changeOutputAdded: boolean;
}

export type LeanOracleFeeRebalanceResult =
  | LeanOracleFeeRebalanceSuccess
  | LeanOracleFeeRebalanceShortfall;

/**
 * Invoke after mutating **`cell_deps` / witnesses / outputs** — recomputes fee via iterative byte growth.
 *
 * @public
 */
export async function rebalanceTransactionFeeAfterOracleMutation(
  tx: Transaction,
  ctx: LeanOracleFeeRebalanceContext,
): Promise<LeanOracleFeeRebalanceResult> {
  /**
   * Greedy fee balancing algorithm:
   * - add largest capacity “fuel” inputs until we can pay `fee + min_change`
   * - add/change one change output (last output) to return remaining capacity
   * - recompute fee after each structural mutation because tx byte size changes
   */
  const available = ctx.sortedFuelCandidates;

  const feeRate =
    ctx.feeRateShannonsPerKbOverride ?? (await ctx.cccClient.getFeeRate());

  let initialTxNet = ctx.cumulativeNetCapacityShannons;
  let changeOutputAdded = false;
  let fuelInputsAdded = 0;

  const estimateBytes = () => BigInt(tx.toBytes().length);
  const computeFee = () => (estimateBytes() * feeRate + 999n) / 1000n;

  let fee = computeFee();

  const changeLock = Script.from(ctx.changeLockScript);
  const minChange = ctx.minimumChangeCellCapacity ?? MIN_CELL_CAPACITY_SHANNONS;

  for (let i = 0; i < available.length; i++) {
    const added = available[i]!;
    /**
     * CCC `addInput` returns the **new inputs length**, not the index.
     * The added input’s index is therefore `len - 1`.
     */
    const inputIndex = tx.addInput({
      previousOutput: {
        txHash: added.outPoint.txHash,
        index: added.outPoint.index,
      },
      since: "0x0",
    }) - 1;
    // Keep witnesses aligned with inputs for downstream signers.
    tx.setWitnessAt(inputIndex, "0x");

    fuelInputsAdded += 1;
    initialTxNet += added.capacityShannons;

    fee = computeFee();

    if (initialTxNet >= fee + minChange) {
      const change = initialTxNet - fee;
      if (changeOutputAdded) {
        tx.outputs[tx.outputs.length - 1]!.capacity = change;
        return {
          status: "ok",
          mutated: tx,
          feePaidShannons: fee,
          fuelInputsAdded,
          changeOutputAdded,
        };
      }

      tx.addOutput(
        {
          cellOutput: {
            capacity: change,
            lock: changeLock,
            type: null,
          },
          outputData: "0x",
        },
      );
      changeOutputAdded = true;

      fee = computeFee();
      if (initialTxNet >= fee + minChange) {
        tx.outputs[tx.outputs.length - 1]!.capacity = initialTxNet - fee;
        return {
          status: "ok",
          mutated: tx,
          feePaidShannons: fee,
          fuelInputsAdded,
          changeOutputAdded,
        };
      }
    }

    if (ctx.force === true && initialTxNet >= fee) {
      if (changeOutputAdded) {
        tx.outputs.pop();
        tx.outputsData.pop();
        changeOutputAdded = false;
        fee = computeFee();
      }
      return {
        status: "ok",
        mutated: tx,
        // when force-burning change, “fee paid” equals all net capacity we kept
        feePaidShannons: initialTxNet,
        fuelInputsAdded,
        changeOutputAdded,
      };
    }
  }

  const needed = ctx.force === true ? fee : fee + minChange;
  return {
    status: "insufficient",
    mutated: tx,
    feeNeededShannons: fee,
    extraCapacityNeededShannons: needed - initialTxNet,
    fuelInputsAdded,
    changeOutputAdded,
  };
}
