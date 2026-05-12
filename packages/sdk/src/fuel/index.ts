/**
 * @packageDocumentation
 *
 * **`lean-oracle-sdk/fuel`** — fee/fuel/capacity primitives.
 *
 * These helpers operate on plain CKB capacity cells ("fuel cells") and on the
 * fee shortfall produced by an oracle update mutation. They are deliberately
 * decoupled from oracle-specific transaction construction (which lives under
 * `lean-oracle-sdk/tx`).
 *
 * The two compose helpers
 * (`composeReadDepsWithFeeRebalance` / `composePullUpdateWithFeeRebalance`)
 * stay under `/tx` — they are oracle workflows that *use* fuel internally.
 *
 * Source modules are unchanged; this barrel is a re-export view.
 */

export {
  MIN_CELL_CAPACITY_SHANNONS,
  collectPlainFuelCellsByLock,
  computeCumulativeNetCapacityShannons,
  rebalanceFuel,
  rebalanceTransactionFeeAfterOracleMutation,
} from "../tx/rebalanceFees.js";
export type {
  LeanOracleFeeRebalanceContext,
  LeanOracleFeeRebalanceResult,
  LeanOracleFeeRebalanceShortfall,
  LeanOracleFeeRebalanceSuccess,
  LeanOracleFuelCellCandidate,
} from "../tx/rebalanceFees.js";
