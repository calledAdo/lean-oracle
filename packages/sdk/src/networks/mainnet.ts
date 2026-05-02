import type { LeanOracleNetworkConfig } from "../types/network.js";
import {
  leanOracleCccAlwaysSuccessCodeDepOutPointMainnet,
  leanOracleCccAlwaysSuccessLockPreset,
} from "./alwaysSuccessCcc.js";

/**
 * Production defaults — curator must hydrate `deployment` before mainnet txs.
 *
 * @public
 */
export const leanOracleMainnetPreset: LeanOracleNetworkConfig = {
  name: "mainnet",
  hermesBaseUrl: "https://hermes.pyth.network",
  ckbJsonRpcUrl: "https://mainnet.ckb.dev",
  deployment: {
    // Placeholder values until contracts are deployed/pinned.
    oracleTypeScriptCodeHash: `0x${"00".repeat(32)}`,
    oracleTypeScriptHashType: "type",
    oracleTypeScriptCodeDepOutPoint: {
      txHash: `0x${"00".repeat(32)}`,
      index: 0n,
    },
    guardianSetTypeScriptCodeHash: `0x${"00".repeat(32)}`,
    guardianSetTypeScriptHashType: "type",
    guardianSetTypeScriptArgs: "0x",
    guardianSetTypeScriptCodeDepOutPoint: {
      txHash: `0x${"00".repeat(32)}`,
      index: 0n,
    },
    alwaysSuccessLockCodeDepOutPoint: leanOracleCccAlwaysSuccessCodeDepOutPointMainnet,
    defaultPublicOracleLockScript: leanOracleCccAlwaysSuccessLockPreset,
  },
};
