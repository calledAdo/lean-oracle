/**
 * @packageDocumentation
 *
 * Preset-based clients so consumers don’t manually thread network constants.
 *
 * Most SDK users should start with {@link LeanOracleTestnetClient} or
 * {@link LeanOracleMainnetClient} and only override URLs / deployment fields when needed.
 */

// Preset clients intentionally do not accept CCC client injection.

import {
  leanOracleMainnetPreset,
  leanOracleTestnetPreset,
} from "../networks/index.js";
import type { LeanOracleNetworkConfig } from "../types/network.js";
import { LeanOracleClient } from "./LeanOracleClient.js";

/** @public */
export interface LeanOraclePresetClientOverrides {
  /**
   * Override Hermes base URL (e.g. private relay).
   */
  hermesBaseUrl?: string;
  /**
   * Override CKB JSON-RPC URL for your environment.
   */
  ckbJsonRpcUrl?: string;
}

function mergeNetwork(
  base: LeanOracleNetworkConfig,
  overrides?: LeanOraclePresetClientOverrides,
): LeanOracleNetworkConfig {
  return {
    ...base,
    hermesBaseUrl: overrides?.hermesBaseUrl ?? base.hermesBaseUrl,
    ckbJsonRpcUrl: overrides?.ckbJsonRpcUrl ?? base.ckbJsonRpcUrl,
    deployment: base.deployment,
  };
}

/**
 * Preset client for CKB testnet + Hermes beta.
 *
 * @public
 */
export class LeanOracleTestnetClient extends LeanOracleClient {
  constructor(options?: {
    overrides?: LeanOraclePresetClientOverrides;
  }) {
    super({
      network: mergeNetwork(
        leanOracleTestnetPreset,
        options?.overrides,
      ),
    });
  }
}

/**
 * Preset client for CKB mainnet + Hermes.
 *
 * @public
 */
export class LeanOracleMainnetClient extends LeanOracleClient {
  constructor(options?: {
    overrides?: LeanOraclePresetClientOverrides;
  }) {
    super({
      network: mergeNetwork(
        leanOracleMainnetPreset,
        options?.overrides,
      ),
    });
  }
}
