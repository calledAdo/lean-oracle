/**
 * @packageDocumentation
 *
 * **Curated public surface** for `lean-oracle-sdk`.
 *
 * The package root intentionally exposes only the stable, consumer-facing API:
 * client classes, network presets, public errors and core (non-transport)
 * types, basic decode helpers, and oracle-cell discovery.
 *
 * Hermes fetch helpers and Hermes-specific types live under the dedicated
 * `./hermes` subpath. Lower-level helpers (transaction-mutation primitives,
 * fee/fuel rebalancing, guardian-dep resolution, output construction, and
 * witness encoders) live behind their own explicit subpaths — see
 * {@link ./tx}, {@link ./fuel}, {@link ./hermes}, {@link ./presets},
 * {@link ./ckb}, and {@link ./advanced}. Witness encoders are reachable via
 * `./advanced`.
 */

// ── Client ───────────────────────────────────────────────────────────────────
export { LeanOracleClient } from "./client/LeanOracleClient.js";
export type {
  LeanOracleCellStateResult,
  LeanOracleClientOptions,
} from "./client/LeanOracleClient.js";
export {
  LeanOracleMainnetClient,
  LeanOracleTestnetClient,
} from "./client/presets.js";
export type { LeanOraclePresetClientOverrides } from "./client/presets.js";

// ── Network presets ──────────────────────────────────────────────────────────
export {
  leanOracleCccAlwaysSuccessCodeDepOutPointMainnet,
  leanOracleCccAlwaysSuccessCodeDepOutPointTestnet,
  leanOracleCccAlwaysSuccessLockPreset,
} from "./presets/alwaysSuccessCcc.js";
export { leanOracleMainnetPreset } from "./presets/mainnet.js";
export { leanOracleTestnetPreset } from "./presets/testnet.js";

// ── Errors (core public; Hermes-specific errors live under `./hermes`) ───────
export {
  LeanOracleSdkError,
  LeanOracleWitnessEncodingError,
  LeanOracleCellDataDecodeError,
  LeanOracleGuardianSetDataDecodeError,
  LeanOracleGuardianSetResolveError,
  LeanOracleOracleDataEncodeError,
  LeanOracleInsufficientBalanceError,
} from "./errors.js";

// ── Public types ─────────────────────────────────────────────────────────────
export type * from "./types/index.js";

// Hermes fetch helpers and Hermes-specific types are intentionally **not**
// re-exported at the root. Import them from
// `lean-oracle-sdk/hermes`.

// ── Basic read / decode helpers ──────────────────────────────────────────────
export {
  ORACLE_CELL_DATA_BYTE_LENGTH,
  decodeLeanOracleCellDataHex,
  decodeOracleCellDataBytes,
} from "./ckb/decodeOracleData.js";
export {
  GUARDIAN_SET_HEADER_BYTE_LENGTH,
  decodeGuardianSetCellDataBytes,
  decodeGuardianSetCellDataHex,
} from "./ckb/decodeGuardianSetData.js";

// ── Oracle-cell discovery ────────────────────────────────────────────────────
export { findLatestOracleLiveCellForFeed } from "./ckb/findOracleCells.js";
export type { FindOracleLiveCellsForFeedOptions } from "./ckb/findOracleCells.js";
