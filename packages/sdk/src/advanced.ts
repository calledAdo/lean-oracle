/**
 * @packageDocumentation
 *
 * **Advanced / low-level barrel** — explicit escape hatch for transaction
 * authors and tooling that need helpers below the curated root API.
 *
 * Items here are intentionally not part of the package root. They are useful
 * but more volatile than the root surface while the SDK is pre-release: names,
 * shapes, and ergonomics may change without a major bump until the package
 * leaves `0.0.0`.
 *
 * For module-specific imports prefer the dedicated subpaths
 * (`./tx`, `./ckb`, `./fuel`, `./hermes`, `./presets`); use this barrel
 * when you want a single advanced grab-bag. Witness encoders are reachable
 * only through this barrel — there is no public `./witness` subpath.
 */

// ── Oracle output construction (off-chain; parsed, binary, and unified) ─────
export {
  buildOracleOutputFromHermesBinary,
  buildOracleOutputFromHermesParsed,
  buildOracleOutputFromHermesUpdate,
  encodeOracleCellDataBytes,
  pickHermesParsedTouchForFeed,
} from "./ckb/encodeOracleData.js";
export type { BuildOracleOutputFromHermesUpdateParams } from "./ckb/encodeOracleData.js";

// ── Guardian-set cell-dep resolution ─────────────────────────────────────────
export {
  DEFAULT_GUARDIAN_SET_DEP_TYPE,
  attachGuardianSetCellDep,
  guardianSetCellDepFromOutPoint,
  resolveGuardianSetCellDep,
  resolveGuardianSetCellDepOutPoint,
} from "./ckb/guardianDep.js";
export type { ResolveGuardianSetCellDepOptions } from "./ckb/guardianDep.js";

// ── Low-level transaction mutation primitives ────────────────────────────────
export { attachOracleReadDeps } from "./tx/readDeps.js";
export type {
  AttachOracleReadDepsParams,
  AttachOracleReadDepsResult,
} from "./tx/readDeps.js";
export { attachOraclePullUpdate } from "./tx/pullUpdate.js";
export type {
  OraclePullUpdateParams,
  OraclePullUpdateResult,
} from "./tx/pullUpdate.js";

// ── Tx pipeline composition ──────────────────────────────────────────────────
export {
  composePullUpdateWithFeeRebalance,
  composeReadDepsWithFeeRebalance,
} from "./tx/pipeline.js";
export type {
  CombinedPullUpdateAndFeesParams,
  CombinedReadDepsAndFeesParams,
} from "./tx/pipeline.js";

// ── Fee / fuel rebalancing ───────────────────────────────────────────────────
export {
  MIN_CELL_CAPACITY_SHANNONS,
  collectPlainFuelCellsByLock,
  computeCumulativeNetCapacityShannons,
  rebalanceFuel,
  rebalanceTransactionFeeAfterOracleMutation,
} from "./tx/rebalanceFees.js";
export type {
  LeanOracleFeeRebalanceContext,
  LeanOracleFeeRebalanceResult,
  LeanOracleFeeRebalanceShortfall,
  LeanOracleFeeRebalanceSuccess,
  LeanOracleFuelCellCandidate,
} from "./tx/rebalanceFees.js";

// ── Witness encoders ─────────────────────────────────────────────────────────
export {
  encodeOracleUpdateWitnessFromAccumulatorBytes,
  encodeOracleUpdateWitnessFromAccumulatorHex,
} from "./witness/encodeUpdateWitness.js";
