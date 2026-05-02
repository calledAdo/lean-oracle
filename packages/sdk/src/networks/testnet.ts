import type { LeanOracleNetworkConfig } from "../types/network.js";
import {
  leanOracleCccAlwaysSuccessCodeDepOutPointTestnet,
  leanOracleCccAlwaysSuccessLockPreset,
} from "./alwaysSuccessCcc.js";

/**
 * Opinionated presets — fill `deployment.*` hashes/outpoints once contracts publish.
 *
 * @public
 */
export const leanOracleTestnetPreset: LeanOracleNetworkConfig = {
  name: "testnet",
  hermesBaseUrl: "https://hermes-beta.pyth.network",
  ckbJsonRpcUrl: "https://testnet.ckb.dev",
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
    alwaysSuccessLockCodeDepOutPoint: leanOracleCccAlwaysSuccessCodeDepOutPointTestnet,
    defaultPublicOracleLockScript: leanOracleCccAlwaysSuccessLockPreset,
  },
};
