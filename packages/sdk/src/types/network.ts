import type { LeanOracleDeployment } from "./deployment.js";
import { LeanOracleSdkError } from "../errors.js";

/**
 * Logical network discriminator for presets (`testnet`, `mainnet`, `devnet`).
 *
 * @public
 */
export type LeanOracleNetworkName = "testnet" | "mainnet" | "devnet";

/**
 * RPC and Hermes endpoints shared by available and unavailable networks.
 *
 * @public
 */
export interface LeanOracleNetworkEndpoints {
  name: LeanOracleNetworkName;
  hermesBaseUrl: string;
  ckbJsonRpcUrl: string;
}

/** Network configuration backed by a real Lean Oracle chain deployment. */
export interface LeanOracleNetworkConfig extends LeanOracleNetworkEndpoints {
  deploymentStatus?: "available";
  /** Deployment constants bundled with the SDK (or overridden by caller). */
  deployment: LeanOracleDeployment;
}

/** Endpoint metadata for a network where Lean Oracle is not deployed. */
export interface LeanOracleUnavailableNetworkConfig
  extends LeanOracleNetworkEndpoints {
  deploymentStatus: "unavailable";
  deploymentUnavailableReason: string;
  deployment?: never;
}

/** Any bundled or caller-provided Lean Oracle network configuration. */
export type LeanOracleNetwork =
  | LeanOracleNetworkConfig
  | LeanOracleUnavailableNetworkConfig;

/** Require real deployment metadata before attempting a CKB-backed operation. */
export function requireLeanOracleNetworkConfig(
  network: LeanOracleNetwork,
): LeanOracleNetworkConfig {
  if (network.deploymentStatus === "unavailable") {
    throw new LeanOracleSdkError(
      `Lean Oracle deployment unavailable for network "${network.name}": ${network.deploymentUnavailableReason}`,
    );
  }
  return network;
}
