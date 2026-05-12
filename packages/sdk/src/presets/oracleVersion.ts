import { LeanOracleSdkError } from "../errors.js";
import type { LeanOracleNetworkConfig } from "../types/network.js";

/**
 * Return a copy of `config` whose `deployment.oracleType` is swapped for the
 * historical entry at `version` from `deployment.oracleTypeVersions`.
 *
 * CKB type scripts are immutable per cell, so after an `oracle_type` code
 * upgrade, cells created under an older `codeHash` are not reachable via the
 * default (latest) preset. Use this to build a config pinned to the version
 * those cells were created under, then read / update / burn them normally:
 *
 * ```ts
 * import {
 *   leanOracleTestnetPreset,
 *   leanOraclePresetForOracleVersion,
 * } from "lean-oracle-sdk/presets";
 * import { LeanOracleClient } from "lean-oracle-sdk";
 *
 * const oracle = new LeanOracleClient({
 *   network: leanOraclePresetForOracleVersion(leanOracleTestnetPreset, 1),
 * });
 * ```
 *
 * Throws {@link LeanOracleSdkError} if the config carries no version history
 * or the requested version is absent.
 *
 * @public
 */
export function leanOraclePresetForOracleVersion(
  config: LeanOracleNetworkConfig,
  version: number,
): LeanOracleNetworkConfig {
  const versions = config.deployment.oracleTypeVersions;
  if (!versions) {
    throw new LeanOracleSdkError(
      `Network config "${config.name}" has no oracleTypeVersions; cannot pin to version ${String(version)}`,
    );
  }
  const ref = versions[version];
  if (!ref) {
    const available = Object.keys(versions).join(", ") || "<none>";
    throw new LeanOracleSdkError(
      `oracle_type version ${String(version)} not found in network config "${config.name}" (available: ${available})`,
    );
  }
  return {
    ...config,
    deployment: {
      ...config.deployment,
      oracleType: ref,
    },
  };
}

/**
 * The highest version key present in `deployment.oracleTypeVersions`, or
 * `undefined` when the config carries no version history. Useful for asserting
 * that the canonical `oracleType` and the latest history entry agree.
 *
 * @public
 */
export function leanOracleLatestOracleVersion(
  config: LeanOracleNetworkConfig,
): number | undefined {
  const versions = config.deployment.oracleTypeVersions;
  if (!versions) return undefined;
  const keys = Object.keys(versions)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n));
  return keys.length === 0 ? undefined : Math.max(...keys);
}
