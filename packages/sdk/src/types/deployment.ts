import type { HexString } from "./hex.js";

/**
 * CKB **hash types** usable in **`Script.hashType`** literals (mirrors `@ckb-ccc/core`).
 *
 * @public
 */
export type LeanOracleScriptHashType = "type" | "data" | "data1" | "data2";

/**
 * Explicit **Lock** script bytes for repeatable builds / environments without **`KnownScript`** tables.
 *
 * Used for **`defaultPublicOracleLockScript`** (**always-success** public oracles typically use **`args`: `0x`**).
 *
 * @public
 */
export interface LeanOracleExplicitLockPreset {
  codeHash: HexString;
  hashType: LeanOracleScriptHashType;
  /** Lock args (**`undefined`/`0x`** = empty-args always-success installs). */
  args?: HexString;
}

/**
 * Canonical testnet/mainnet oracle + guardian artefacts once contracts are pinned.
 *
 * @public
 */
export interface LeanOracleDeployment {
  /**
   * Pyth oracle **`type`** script **code hash** (**required for indexer-backed discovery**
   * once contracts are published — **omit only** when you enumerate cells manually).
   */
  oracleTypeScriptCodeHash: HexString;
  /**
   * How **`oracleTypeScriptCodeHash`** resolves (**`type`** identity vs **`data*`** blobs).
   * Defaults to **`type`** once you pass **`oracleTypeScriptCodeHash`**.
   */
  oracleTypeScriptHashType: LeanOracleScriptHashType;
  /**
   * Code cell outpoint for the oracle **type script** implementation.
   *
   * Required for executing transactions that **spend** oracle cells (updates), since CKB loads script bytecode from `CellDep`.
   * For now this can be a placeholder in presets; consumers should supply the real outpoint for their deployment.
   */
  oracleTypeScriptCodeDepOutPoint: LeanOracleCellOutPoint;

  /** Guardian-set type script identity (CellDep scanning / validation helpers). */
  guardianSetTypeScriptCodeHash: HexString;
  guardianSetTypeScriptHashType: LeanOracleScriptHashType;
  /**
   * Type script args for the guardian-set cell, if the deployment uses args.
   * Defaults to `"0x"` when omitted.
   */
  guardianSetTypeScriptArgs: HexString;
  /**
   * Code cell outpoint for the guardian-set **type script** implementation (if any).
   *
   * Required when a transaction executes a script that depends on the guardian-set script bytecode.
   */
  guardianSetTypeScriptCodeDepOutPoint: LeanOracleCellOutPoint;

  /**
   * Code cell outpoint for the AlwaysSuccess lock script.
   *
   * Required when you spend an oracle cell locked by AlwaysSuccess.
   */
  alwaysSuccessLockCodeDepOutPoint: LeanOracleCellOutPoint;

  /**
   * **Public / permissionless** oracle installs: indexer query uses this **`Script`** unless the caller overrides
   * **`oracleLockScript`** when calling **`findLatestOracleLiveCellForFeed`**.
   *
   * For **personal** oracle cells (your own **`secp256k1`/proxy** lock), callers pass **`oracleLockScript`**
   * explicitly — no deployment knob required.
   */
  defaultPublicOracleLockScript: LeanOracleExplicitLockPreset;
}

/** CKB [`OutPoint`](https://docs.nervos.org) for a consumed or referenced cell. */
export interface LeanOracleCellOutPoint {
  txHash: HexString;
  index: bigint;
}
