/**
 * Curated mirrors of **`@ckb-ccc/core`**’s built-in **`KnownScript.AlwaysSuccess`** metadata.
 *
 * **You must re-verify** against your installed **`@ckb-ccc/core`** version before mainnet dependency wiring —
 * these literals track upstream `TESTNET_SCRIPTS` / `MAINNET_SCRIPTS` tables.
 */

import type {
  LeanOracleCellOutPoint,
  LeanOracleExplicitLockPreset,
} from "../types/deployment.js";

/**
 * Lock script triple shared by CKB public testnet + mainnet presets (empty args).
 *
 * Drop into **`LeanOracleDeployment.defaultPublicOracleLockScript`** when your **`Client`**
 * cannot resolve **`getKnownScript(AlwaysSuccess)`**.
 */
export const leanOracleCccAlwaysSuccessLockPreset: LeanOracleExplicitLockPreset = {
  codeHash:
    "0x3b521cc4b552f109d092d8cc468a8048acb53c5952dbe769d2b2f9cf6e47f7f1",
  hashType: "data1",
  args: "0x",
};

/** Code cell dependency OutPoint for **testnet** (`TESTNET_SCRIPTS[AlwaysSuccess].cellDeps[0]`). */
export const leanOracleCccAlwaysSuccessCodeDepOutPointTestnet: LeanOracleCellOutPoint =
  {
    txHash:
      "0xb4f171c9c9caf7401f54a8e56225ae21d95032150a87a4678eac3f66a3137b93",
    index: 0n,
  };

/** Code cell dependency OutPoint for **mainnet** (`MAINNET_SCRIPTS[AlwaysSuccess].cellDeps[0]`). */
export const leanOracleCccAlwaysSuccessCodeDepOutPointMainnet: LeanOracleCellOutPoint =
  {
    txHash:
      "0x10d63a996157d32c01078058000052674ca58d15f921bec7f1dcdac2160eb66b",
    index: 0n,
  };
