export { attachOracleReadDeps } from "./readDeps.js";
export type {
  AttachOracleReadDepsParams,
  AttachOracleReadDepsResult,
} from "./readDeps.js";
export { attachOraclePullUpdate } from "./pullUpdate.js";
export type { OraclePullUpdateParams, OraclePullUpdateResult } from "./pullUpdate.js";
export { attachOracleDeploy } from "./deployOracle.js";
export type {
  OracleDeployParams,
  OracleDeployResult,
  OracleDeployInitialPrice,
} from "./deployOracle.js";
export { attachOracleBurn } from "./burnOracle.js";
export type { OracleBurnParams, OracleBurnResult } from "./burnOracle.js";
export {
  attachGuardianSetRotation,
  buildGuardianSetRotationIfBehind,
} from "./rotateGuardianSet.js";
export type {
  GuardianSetRotationParams,
  GuardianSetRotationResult,
  GuardianSetRotationPlan,
  BuildGuardianSetRotationIfBehindParams,
} from "./rotateGuardianSet.js";
export {
  initiateOracleUpdateTx,
  initiateReadOracleTx,
  initiateOracleDeployTx,
  initiateOracleBurnTx,
} from "./workflows.js";
export type {
  InitiateOracleUpdateParams,
  InitiateReadOracleTxParams,
  InitiateOracleDeployTxParams,
  InitiateOracleBurnTxParams,
} from "./workflows.js";
// Oracle workflows that internally rebalance fees. The fee/fuel primitives
// themselves live under `lean-oracle-sdk/fuel`.
export {
  composePullUpdateWithFeeRebalance,
  composeReadDepsWithFeeRebalance,
} from "./pipeline.js";
export type {
  CombinedPullUpdateAndFeesParams,
  CombinedReadDepsAndFeesParams,
} from "./pipeline.js";
