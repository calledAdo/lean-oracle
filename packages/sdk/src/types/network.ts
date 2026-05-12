import type { LeanOracleDeployment } from "./deployment.js";

/**
 * Logical network discriminator for presets (`testnet`, `mainnet`, `devnet`).
 *
 * @public
 */
export type LeanOracleNetworkName = "testnet" | "mainnet" | "devnet";

/**
 * All RPC/Hermes/deployment knobs for one environment.
 *
 * @public
 */
export interface LeanOracleNetworkConfig {
  name: LeanOracleNetworkName;
  hermesBaseUrl: string;
  ckbJsonRpcUrl: string;
  /** Deployment constants bundled with the SDK (or overridden by caller). */
  deployment: LeanOracleDeployment;
}
