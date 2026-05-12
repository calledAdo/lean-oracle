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
    defaultPublicOracleLock: {
      script: leanOracleCccAlwaysSuccessLockPreset,
      codeDep: {
        outPoint: leanOracleCccAlwaysSuccessCodeDepOutPointMainnet,
        depType: "code",
      },
    },
    oracleType: {
      codeHash: `0x${"00".repeat(32)}`,
      hashType: "type",
      codeDep: {
        outPoint: {
          txHash: `0x${"00".repeat(32)}`,
          index: 0n,
        },
        depType: "code",
      },
    },
    pythEmitter: {
      chain: 26,
      address:
        "0xe101faedac5851e32b9b23b5f9411a8c2bac4aae3ed4dd7b811dd1a72ea4aa71",
    },
    guardianSetType: {
      codeHash: `0x${"00".repeat(32)}`,
      hashType: "type",
      args: "0x",
      codeDep: {
        outPoint: {
          txHash: `0x${"00".repeat(32)}`,
          index: 0n,
        },
        depType: "code",
      },
    },
  },
};
