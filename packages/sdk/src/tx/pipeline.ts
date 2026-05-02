import { attachOraclePullUpdate } from "./pullUpdate.js";
import { attachOracleReadDeps } from "./readDeps.js";
import { rebalanceTransactionFeeAfterOracleMutation } from "./rebalanceFees.js";
import type { AttachOracleReadDepsParams, AttachOracleReadDepsResult } from "./readDeps.js";
import type {
  LeanOracleFeeRebalanceContext,
  LeanOracleFeeRebalanceResult,
} from "./rebalanceFees.js";
import type { OraclePullUpdateParams, OraclePullUpdateResult } from "./pullUpdate.js";

export interface CombinedReadDepsAndFeesParams extends AttachOracleReadDepsParams {
  fee: LeanOracleFeeRebalanceContext;
}

export interface CombinedPullUpdateAndFeesParams extends OraclePullUpdateParams {
  fee: LeanOracleFeeRebalanceContext;
}

/**
 * Opinionated shorthand — **read-deps first**, fee second.
 *
 * @public
 */
export async function composeReadDepsWithFeeRebalance(
  params: CombinedReadDepsAndFeesParams,
): Promise<{ oracle: AttachOracleReadDepsResult; fee: LeanOracleFeeRebalanceResult }> {
  const oracle = await attachOracleReadDeps(params);
  const fee = await rebalanceTransactionFeeAfterOracleMutation(oracle.mutated, params.fee);
  return { oracle, fee };
}

/**
 * Opinionated shorthand — Hermes-assisted update scaffolding + fee balancer.
 *
 * @public
 */
export async function composePullUpdateWithFeeRebalance(
  params: CombinedPullUpdateAndFeesParams,
): Promise<{ oracle: OraclePullUpdateResult; fee: LeanOracleFeeRebalanceResult }> {
  const oracle = await attachOraclePullUpdate(params);
  const fee = await rebalanceTransactionFeeAfterOracleMutation(oracle.mutated, params.fee);
  return { oracle, fee };
}
