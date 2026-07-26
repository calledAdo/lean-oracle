import type { LeanOracleUnavailableNetworkConfig } from "../types/network.js";

/**
 * Mainnet endpoints without fake on-chain deployment metadata.
 *
 * @public
 */
export const leanOracleMainnetPreset: LeanOracleUnavailableNetworkConfig = {
  name: "mainnet",
  hermesBaseUrl: "https://hermes.pyth.network",
  ckbJsonRpcUrl: "https://mainnet.ckb.dev",
  deploymentStatus: "unavailable",
  deploymentUnavailableReason: "Lean Oracle is not deployed on CKB mainnet",
};
