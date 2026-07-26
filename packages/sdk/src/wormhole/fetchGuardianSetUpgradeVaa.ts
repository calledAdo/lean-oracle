/**
 * @packageDocumentation
 *
 * Best-effort fetch of a **guardian-set-upgrade governance VAA** from a
 * Wormholescan-compatible gateway.
 *
 * Guardian rotations are rare and always preceded by a public governance VAA
 * from the canonical governance emitter. This helper pages that emitter's VAAs
 * and returns the one that advances a given set index by one. It is a
 * convenience for keepers; the trust-critical checks happen on-chain, so a wrong
 * or stale VAA is simply rejected by the `guardian_set_script`.
 */

import { LeanOracleSdkError } from "../errors.js";
import type { HexString } from "../types/hex.js";
import { bytesToHex } from "../internal/hex.js";
import {
  WORMHOLE_GOVERNANCE_EMITTER_ADDRESS,
  WORMHOLE_GOVERNANCE_EMITTER_CHAIN,
  parseGuardianSetUpgradeVaa,
} from "./parseGuardianSetUpgrade.js";

/** Public Wormholescan REST base. */
export const DEFAULT_WORMHOLESCAN_BASE_URL = "https://api.wormholescan.io";
/** Wormhole's maintained canonical guardian-set VAA registry. */
export const DEFAULT_WORMHOLE_GUARDIAN_SET_REGISTRY_URL =
  "https://raw.githubusercontent.com/wormhole-foundation/wormhole/main/guardianset/mainnetv2/canonical_sets/guardianSetVAAs.csv";

export interface FetchGuardianSetUpgradeVaaOptions {
  /** Wormholescan-compatible base URL. */
  baseUrl?: string;
  /** Governance emitter chain (default: Solana / 1). */
  emitterChain?: number;
  /** Governance emitter address, 32-byte hex (default: canonical `0x…04`). */
  emitterAddress?: HexString;
  /** Max VAAs to scan across pages before giving up. Default 200. */
  maxScan?: number;
  /** Page size passed to the gateway. Default 50. */
  pageSize?: number;
  /** Canonical guardian-set VAA registry used when explorer history is incomplete. */
  canonicalRegistryUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

function decodeBase64ToBytes(input: string): Uint8Array {
  if (typeof globalThis.atob === "function") {
    const bin = globalThis.atob(input);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buf = (globalThis as any).Buffer?.from?.(input, "base64") as
    | Uint8Array
    | undefined;
  if (buf) return new Uint8Array(buf);
  throw new LeanOracleSdkError(
    "Base64 decoding unavailable in this runtime (no atob/Buffer)",
  );
}

interface WormholescanVaaRow {
  vaa?: string;
}

/**
 * Return a `fetchUpgradeVaa(currentIndex)` function suitable for
 * {@link buildGuardianSetRotationIfBehind}, backed by a Wormholescan gateway.
 *
 * The returned function resolves to the VAA (as hex) that advances
 * `currentIndex` → `currentIndex + 1`, or `null` if none is published yet.
 *
 * @public
 */
export function wormholescanUpgradeVaaFetcher(
  options?: FetchGuardianSetUpgradeVaaOptions,
): (currentIndex: number) => Promise<HexString | null> {
  return (currentIndex: number) =>
    fetchGuardianSetUpgradeVaa(currentIndex + 1, options);
}

/**
 * Fetch the governance VAA whose guardian-set upgrade targets `targetNewIndex`.
 *
 * @public
 */
export async function fetchGuardianSetUpgradeVaa(
  targetNewIndex: number,
  options?: FetchGuardianSetUpgradeVaaOptions,
): Promise<HexString | null> {
  const baseUrl = (options?.baseUrl ?? DEFAULT_WORMHOLESCAN_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const chain = options?.emitterChain ?? WORMHOLE_GOVERNANCE_EMITTER_CHAIN;
  const emitter = (options?.emitterAddress ?? WORMHOLE_GOVERNANCE_EMITTER_ADDRESS)
    .replace(/^0x/, "")
    .toLowerCase();
  const pageSize = options?.pageSize ?? 50;
  const maxScan = options?.maxScan ?? 200;
  const doFetch = options?.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new LeanOracleSdkError("No fetch implementation available");
  }

  let historyError: unknown;
  try {
    let scanned = 0;
    for (let page = 0; scanned < maxScan; page++) {
      const url = `${baseUrl}/api/v1/vaas/${String(chain)}/${emitter}?page=${String(page)}&pageSize=${String(pageSize)}`;
      const res = await doFetch(url, { signal: options?.signal });
      if (!res.ok) {
        throw new LeanOracleSdkError(
          `Wormholescan request failed: ${String(res.status)} ${res.statusText}`,
        );
      }
      const body = (await res.json()) as { data?: WormholescanVaaRow[] };
      const rows = body.data ?? [];
      if (rows.length === 0) break;

      for (const row of rows) {
        scanned++;
        if (!row.vaa) continue;
        let bytes: Uint8Array;
        try {
          bytes = decodeBase64ToBytes(row.vaa);
        } catch {
          continue;
        }
        try {
          const upgrade = parseGuardianSetUpgradeVaa(bytes);
          if (upgrade.newIndex === targetNewIndex) {
            return bytesToHex(bytes);
          }
        } catch {
          // Not a guardian-set upgrade (or from a different emitter) — skip.
        }
      }
      if (rows.length < pageSize) break;
    }
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    historyError = error;
  }

  const registryUrl =
    options?.canonicalRegistryUrl ??
    DEFAULT_WORMHOLE_GUARDIAN_SET_REGISTRY_URL;
  try {
    const res = await doFetch(registryUrl, { signal: options?.signal });
    if (!res.ok) {
      throw new LeanOracleSdkError(
        `Wormhole guardian-set registry request failed: ${String(res.status)} ${res.statusText}`,
      );
    }
    const csv = await res.text();
    for (const rawLine of csv.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line) continue;
      const comma = line.indexOf(",");
      if (comma < 1) continue;
      const encoded = line.slice(comma + 1).trim();
      if (!/^[0-9a-fA-F]+$/u.test(encoded) || encoded.length % 2 !== 0) {
        continue;
      }
      try {
        const vaa = `0x${encoded}` as HexString;
        if (parseGuardianSetUpgradeVaa(vaa).newIndex === targetNewIndex) {
          return vaa.toLowerCase() as HexString;
        }
      } catch {
        // Ignore non-upgrade and malformed registry rows.
      }
    }
    return null;
  } catch (registryError) {
    if (options?.signal?.aborted) throw registryError;
    const historyDetail =
      historyError instanceof Error ? `; history also failed: ${historyError.message}` : "";
    throw new LeanOracleSdkError(
      `Unable to resolve guardian-set upgrade VAA from canonical registry${historyDetail}`,
      { cause: registryError },
    );
  }
}
