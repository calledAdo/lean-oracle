/**
 * @packageDocumentation
 *
 * **`lean-oracle-sdk/presets`** — pre-built network configurations, the CCC
 * `AlwaysSuccess` lock preset wiring, and the oracle-type code-version
 * helpers.
 *
 * This module is both the public façade for the `./presets` subpath and the
 * home of the preset definitions (`testnet`, `mainnet`, the `AlwaysSuccess`
 * lock preset, the version helpers).
 */

export {
  leanOracleCccAlwaysSuccessCodeDepOutPointMainnet,
  leanOracleCccAlwaysSuccessCodeDepOutPointTestnet,
  leanOracleCccAlwaysSuccessLockPreset,
} from "./alwaysSuccessCcc.js";
export { leanOracleMainnetPreset } from "./mainnet.js";
export { leanOracleTestnetPreset } from "./testnet.js";
export {
  leanOraclePresetForOracleVersion,
  leanOracleLatestOracleVersion,
} from "./oracleVersion.js";
export type {
  LeanOracleNetwork,
  LeanOracleNetworkConfig,
  LeanOracleNetworkEndpoints,
  LeanOracleNetworkName,
  LeanOracleUnavailableNetworkConfig,
} from "../types/network.js";
