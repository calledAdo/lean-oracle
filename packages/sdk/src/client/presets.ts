/**
 * @packageDocumentation
 *
 * Preset-based clients so consumers don’t manually thread network constants.
 *
 * Most SDK users should start with {@link LeanOracleTestnetClient} or
 * {@link LeanOracleMainnetClient} and only override URLs / deployment fields when needed.
 */

import type { Client } from "@ckb-ccc/core";
import {
  leanOracleMainnetPreset,
  leanOracleTestnetPreset,
} from "../presets/index.js";
import type { LeanOracleNetwork } from "../types/network.js";
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

function mergeNetwork<T extends LeanOracleNetwork>(
  base: T,
  overrides?: LeanOraclePresetClientOverrides,
): T {
  return {
    ...base,
    hermesBaseUrl: overrides?.hermesBaseUrl ?? base.hermesBaseUrl,
    ckbJsonRpcUrl: overrides?.ckbJsonRpcUrl ?? base.ckbJsonRpcUrl,
  } as T;
}

/**
 * Preset client for CKB testnet + Hermes beta.
 *
 * Pass `cccClient` to inject a preconfigured CCC client (custom transport,
 * shared instance, or test fake); when omitted the SDK builds a default
 * `ClientPublicTestnet` from the (optionally overridden) JSON-RPC URL.
 *
 * @public
 */
export class LeanOracleTestnetClient extends LeanOracleClient {
  constructor(options?: {
    overrides?: LeanOraclePresetClientOverrides;
    cccClient?: Client;
  }) {
    super({
      network: mergeNetwork(
        leanOracleTestnetPreset,
        options?.overrides,
      ),
      cccClient: options?.cccClient,
    });
  }
}

/**
 * Preset client for CKB mainnet + Hermes.
 *
 * Pass `cccClient` to inject a preconfigured CCC client (custom transport,
 * shared instance, or test fake); when omitted the SDK builds a default
 * `ClientPublicMainnet` from the (optionally overridden) JSON-RPC URL.
 *
 * @public
 */
export class LeanOracleMainnetClient extends LeanOracleClient {
  constructor(options?: {
    overrides?: LeanOraclePresetClientOverrides;
    cccClient?: Client;
  }) {
    super({
      network: mergeNetwork(
        leanOracleMainnetPreset,
        options?.overrides,
      ),
      cccClient: options?.cccClient,
    });
  }
}
