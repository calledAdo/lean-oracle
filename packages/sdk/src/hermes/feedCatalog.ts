/**
 * @packageDocumentation
 *
 * Helper for Hermes's catalog endpoint (`GET /v2/price_feeds`), which lists
 * every Pyth price feed currently published by the upstream environment with
 * symbol/asset-type metadata.
 *
 * Use this for discovery — feed-id pickers in dashboards, CLI lookup commands,
 * symbol-to-id resolution — rather than bundling a static catalog with the SDK
 * (which would go stale as Pyth adds and rotates feeds).
 *
 * Returned feed ids come from `hermes.pyth.network` (production Pythnet) on
 * the bundled presets — both CKB testnet and mainnet presets point at the same
 * upstream so price ids are portable across environments.
 */

import {
  LeanOracleHermesError,
  LeanOracleHermesMalformedEnvelopeError,
  LeanOracleSdkError,
} from "../errors.js";
import type { FeedIdHex } from "../types/hex.js";
import type { LeanOracleNetworkEndpoints } from "../types/network.js";
import { normalizePythFeedId } from "./client.js";

/**
 * Asset-type filter accepted by Hermes `/v2/price_feeds?asset_type=...`.
 *
 * Hermes currently surfaces these categories; the list is loose so future
 * additions don't require an SDK release.
 *
 * @public
 */
export type PythAssetType =
  | "crypto"
  | "equity"
  | "fx"
  | "metal"
  | "rates"
  | "crypto_index"
  | "crypto_redemption_rate"
  | "commodities"
  | (string & {});

/**
 * Metadata block Hermes attaches to each catalog entry. Field set evolves
 * upstream — we keep the well-known keys typed and pass the rest through.
 *
 * @public
 */
export interface PythFeedCatalogAttributes {
  symbol?: string;
  asset_type?: PythAssetType;
  base?: string;
  quote_currency?: string;
  description?: string;
  generic_symbol?: string;
  display_symbol?: string;
  [extraKey: string]: unknown;
}

/**
 * A single entry from `GET /v2/price_feeds`.
 *
 * @public
 */
export interface PythFeedCatalogEntry {
  /** Canonical Pyth feed id (`0x` + 64 hex nibbles). */
  id: FeedIdHex;
  attributes: PythFeedCatalogAttributes;
}

/**
 * Options for {@link fetchPythFeedCatalog}.
 *
 * @public
 */
export interface FetchPythFeedCatalogOptions {
  /** Substring filter on symbol/description — passed through to Hermes `query`. */
  query?: string;
  /** Asset-type filter — passed through to Hermes `asset_type`. */
  assetType?: PythAssetType;
  /** Override `network.hermesBaseUrl` for a single call. */
  hermesBaseUrlOverride?: string;
  signal?: AbortSignal;
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function parseCatalog(parsedJson: unknown): PythFeedCatalogEntry[] {
  if (!Array.isArray(parsedJson)) {
    throw new LeanOracleHermesMalformedEnvelopeError(
      "Hermes /v2/price_feeds must return a JSON array",
    );
  }

  const out: PythFeedCatalogEntry[] = [];
  for (let i = 0; i < parsedJson.length; i++) {
    const raw = parsedJson[i];
    if (raw === null || typeof raw !== "object") {
      throw new LeanOracleHermesMalformedEnvelopeError(
        `Hermes /v2/price_feeds entry ${String(i)} must be an object`,
      );
    }
    const rec = raw as Record<string, unknown>;
    const id = rec.id;
    if (typeof id !== "string") {
      throw new LeanOracleHermesMalformedEnvelopeError(
        `Hermes /v2/price_feeds entry ${String(i)} missing string "id"`,
      );
    }

    let normalizedId: FeedIdHex;
    try {
      normalizedId = normalizePythFeedId(id);
    } catch (cause) {
      throw new LeanOracleHermesMalformedEnvelopeError(
        `Hermes /v2/price_feeds entry ${String(i)} has malformed id "${id}"`,
        { cause },
      );
    }

    const attributes =
      rec.attributes && typeof rec.attributes === "object"
        ? (rec.attributes as PythFeedCatalogAttributes)
        : {};

    out.push({ id: normalizedId, attributes });
  }
  return out;
}

/**
 * Fetch Pyth's live feed catalog from Hermes.
 *
 * The catalog reflects the environment behind `network.hermesBaseUrl`. The
 * bundled presets all point at production `hermes.pyth.network` (Pythnet
 * mainnet feeds), so ids returned here are usable against either CKB testnet
 * or mainnet under the default configuration.
 *
 * @public
 */
export async function fetchPythFeedCatalog(
  network: LeanOracleNetworkEndpoints,
  options?: FetchPythFeedCatalogOptions,
): Promise<PythFeedCatalogEntry[]> {
  const baseRaw = options?.hermesBaseUrlOverride ?? network.hermesBaseUrl;
  const base = normalizeBaseUrl(baseRaw);

  const url = new URL("/v2/price_feeds", `${base}/`);
  if (options?.query) url.searchParams.set("query", options.query);
  if (options?.assetType) url.searchParams.set("asset_type", options.assetType);

  const doFetch = globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new LeanOracleSdkError(
      "`fetch` is unavailable in this runtime — use Node ≥18 or provide a fetch polyfill",
    );
  }

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: options?.signal,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LeanOracleHermesError(
      `Hermes catalog request failed before receiving a response: ${message}`,
      {
        status: 0,
        url: url.toString(),
        responseBodySnippet: message,
        cause: err,
      },
    );
  }

  const bodyText = await response.text();
  const clipped =
    bodyText.length > 2048 ? `${bodyText.slice(0, 2048)}…` : bodyText;

  if (!response.ok) {
    throw new LeanOracleHermesError(
      `Hermes /v2/price_feeds responded with HTTP ${String(response.status)}`,
      {
        status: response.status,
        url: url.toString(),
        responseBodySnippet: clipped,
      },
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(bodyText) as unknown;
  } catch (cause) {
    throw new LeanOracleHermesMalformedEnvelopeError(
      "Hermes /v2/price_feeds returned non-JSON body despite HTTP 200",
      { cause },
    );
  }

  return parseCatalog(decoded);
}

/**
 * Look up a single catalog entry by exact symbol.
 *
 * Matches Pyth's full catalog symbol (e.g. `"Crypto.BTC/USD"`) or display
 * symbol (e.g. `"BTC/USD"`), case-insensitively. Plain base symbols like
 * `"BTC"` are intentionally not enough because the catalog can contain many
 * BTC-related feeds (`WBTC/USD`, `TBTC/USD`, `CBBTC/USD`, ...).
 *
 * Returns `undefined` if no entry matches. Use {@link fetchPythFeedCatalog}
 * directly when you want search results or a list.
 *
 * @public
 */
export async function findPythFeedIdBySymbol(
  network: LeanOracleNetworkEndpoints,
  symbol: string,
  options?: Omit<FetchPythFeedCatalogOptions, "query">,
): Promise<PythFeedCatalogEntry | undefined> {
  const entries = await fetchPythFeedCatalog(network, {
    ...options,
    query: symbol,
  });
  const want = symbol.trim().toLowerCase();
  return entries.find(
    (e) =>
      (e.attributes.symbol ?? "").trim().toLowerCase() === want ||
      (e.attributes.display_symbol ?? "").trim().toLowerCase() === want,
  );
}
