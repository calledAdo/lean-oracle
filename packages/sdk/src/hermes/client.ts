/**
 * @packageDocumentation
 *
 * Lean Oracle integrates with **[Hermes](https://hermes.pyth.network/docs/)**, Pyth's
 * public REST (+ SSE) gateway that exposes **recent verified price updates**.
 *
 * This module wraps the **v2** HTTP endpoints that return:
 * - `binary` — wire-format payloads (typically **hex** — hex-decode before passing into witness-encoding helpers).
 * - `parsed` — human-readable parity fields. **On-chain proofs use `binary`** only;
 *   `parsed` is an off-chain projection. By default the TS update drafter reads
 *   output cell fields from `parsed` (`outputSource: "hermes-parsed"`), so callers
 *   using the default mode must keep `parsed` enabled. Callers can opt into
 *   `outputSource: "binary"` to derive those fields from `binary.data[0]`
 *   client-side and skip the `parsed` requirement entirely.
 *
 * All network I/O uses the platform **`fetch`** (Node 18+, modern browsers, workers).
 */

import {
  LeanOracleHermesError,
  LeanOracleHermesMalformedEnvelopeError,
  LeanOracleSdkError,
} from "../errors.js";
import type { FeedIdHex } from "../types/hex.js";
import type {
  HermesBinaryEncoding,
  HermesBinaryUpdateEnvelope,
} from "../types/hermes.js";
import type { LeanOracleNetworkEndpoints } from "../types/network.js";

// ─── Public surface ─────────────────────────────────────────────────────────────

/**
 * Common Hermes GET query knobs (REST + SSE URL builder).
 *
 * @public
 */
export interface HermesUrlQueryOptions {
  /**
   * Temporarily replaces {@link LeanOracleNetworkEndpoints.hermesBaseUrl}.
   */
  hermesBaseUrlOverride?: string;

  encoding?: HermesBinaryEncoding;

  verbose?: boolean;
}

/**
 * Options for **`fetchHermes*`** helpers (URL query + **`fetch`** controls).
 *
 * @public
 */
export interface FetchHermesLatestOptions extends HermesUrlQueryOptions {
  /** Pass-through to `fetch(..., { signal })` — abort in-flight pulls. */
  signal?: AbortSignal;
}

// ─── Small utilities (testable, pure) ───────────────────────────────────────────

/** Hermes rejects empty id lists outright — validate before issuing HTTP. */
const MIN_FEED_IDS = 1;

/** Hermes SSE + REST share the repeated `ids[]=<feed>` query convention. */
const QUERY_KEY_IDS = "ids[]";

/**
 * Canonicalize `hermesBaseUrl` from env objects / user input.
 *
 * Removes trailing slashes so concatenating `'/' + path'` never produces `'//v2/'`.
 */
function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * Hermes happily accepts **`0xe62…`** **or** bare **`e62…`**.
 *
 * We normalize to **`0x` + 64 lowercase hex nibbles** so callers can dedupe reliably
 * and URLs stay consistent with [Pyth price id examples](https://docs.pyth.network/).
 */
export function normalizePythFeedId(feedId: FeedIdHex): string {
  let body = feedId.trim().toLowerCase();
  if (body.startsWith("0x")) body = body.slice(2);
  if (!/^[0-9a-f]{64}$/.test(body)) {
    throw new LeanOracleSdkError(
      `Invalid Pyth price feed id: expected 64 hex nibbles (optionally 0x-prefixed), got "${feedId}"`,
    );
  }
  return `0x${body}`;
}

/**
 * Convert user **bigint unix seconds** (`publish_time`) to a Hermes-safe path segment.
 *
 * Hermes paths use decimal integer seconds; guarding `MAX_SAFE_INTEGER` avoids silent
 * `Number` coercion bugs far in the future.
 */
export function publishTimeUnixToPathSegment(ts: bigint): string {
  if (ts < 0n || ts > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LeanOracleSdkError(
      `publishTimeUnix out of range for Hermes URL path segment: ${ts.toString()}`,
    );
  }
  return ts.toString(10);
}

/**
 * Build search params Hermes echoes on **latest**, **historical**, and **stream** routes.
 *
 * @internal exported for golden tests later
 */
export function appendHermesCommonQueryParams(
  params: URLSearchParams,
  feedIdsNormalized: readonly string[],
  opts: HermesUrlQueryOptions,
): void {
  /*
   * One append per feed id — duplicates become `ids[]=a&ids[]=b`,
   * which matches `curl`-style Hermes docs.
   */
  for (const id of feedIdsNormalized) params.append(QUERY_KEY_IDS, id);

  /*
   * `encoding` selects wire representation for `binary.data[]`.
   * Default **hex** — matches Rust `decode_hex` & manual inspection in terminals.
   */
  const encoding = opts.encoding ?? "hex";
  params.set("encoding", encoding);

  /** Optional verbosity flag — safe no-op when Hermes schema ignores it later. */
  if (opts.verbose === true) params.set("verbose", "true");
}

/**
 * Structural guard so `JSON.parse` output cannot silently masquerade as typed data.
 *
 * Accepts loosened `parsed` shape (Hermes evolves fields) while strictly requiring
 * the `binary` envelope our contracts consume.
 */
function parseHermesPriceUpdateEnvelope(
  parsedJson: unknown,
): HermesBinaryUpdateEnvelope {
  if (parsedJson === null || typeof parsedJson !== "object") {
    throw new LeanOracleHermesMalformedEnvelopeError(
      "Hermes JSON root must be an object",
    );
  }

  const root = parsedJson as Record<string, unknown>;
  const binary = root.binary;
  if (binary === null || typeof binary !== "object") {
    throw new LeanOracleHermesMalformedEnvelopeError(
      'Hermes response missing required "binary" object',
    );
  }

  const bin = binary as Record<string, unknown>;
  const encoding = bin.encoding;
  const data = bin.data;

  if (encoding !== "hex" && encoding !== "base64") {
    throw new LeanOracleHermesMalformedEnvelopeError(
      `Unexpected Hermes binary.encoding: ${String(encoding)}`,
    );
  }
  if (!Array.isArray(data) || data.length < 1) {
    throw new LeanOracleHermesMalformedEnvelopeError(
      'Hermes response "binary.data" must be a non-empty array of strings',
    );
  }
  for (let i = 0; i < data.length; i++) {
    if (typeof data[i] !== "string") {
      throw new LeanOracleHermesMalformedEnvelopeError(
        `Hermes binary.data[${String(i)}] must be a string`,
      );
    }
  }

  /*
   * `parsed` is diagnostic — tolerate absence for forward compatibility.
   * When present, loosely validate outer array so obvious garbage fails fast.
   */
  let parsedTouches: HermesBinaryUpdateEnvelope["parsed"];
  if (root.parsed !== undefined) {
    if (!Array.isArray(root.parsed)) {
      throw new LeanOracleHermesMalformedEnvelopeError(
        'Hermes "parsed", when provided, must be an array',
      );
    }
    parsedTouches = root.parsed as HermesBinaryUpdateEnvelope["parsed"];
  }

  return {
    binary: {
      encoding,
      data: data as string[],
    },
    parsed: parsedTouches,
  };
}

/**
 * Core `fetch → status check → JSON → envelope validation` funnel shared by helpers.
 *
 * Limits logged error snippets to **`maxSnippetChars`** characters so gigantic VAAs never
 * flood consoles or telemetry.
 */
async function fetchHermesJsonEnvelope(
  url: URL,
  signal: AbortSignal | undefined,
  maxSnippetChars: number,
): Promise<HermesBinaryUpdateEnvelope> {
  /*
   * Node 18+ / browsers expose global `fetch`; fail fast elsewhere with an actionable SDK error.
   */
  const doFetch = globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new LeanOracleSdkError(
      "`fetch` is unavailable in this runtime — use Node ≥18 or provide a fetch polyfill",
    );
  }

  /** Perform the outbound GET (Hermes endpoints are anonymous read-only pulls). */
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "GET",
      headers: {
        /** Some intermediaries behave better when `Accept` is explicit. */
        Accept: "application/json",
      },
      signal,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof Error
        ? (err as Error & { cause?: unknown }).cause
        : undefined;
    const causeMessage =
      cause instanceof Error ? cause.message : cause ? String(cause) : "";
    throw new LeanOracleHermesError(
      `Hermes request failed before receiving a response for ${url.toString()}: ${message}`,
      {
        status: 0,
        url: url.toString(),
        responseBodySnippet: causeMessage || message,
        cause: err,
      },
    );
  }

  const bodyText = await response.text();
  /** Never ship multi-kilo bodies verbatim into exceptions / logs — clip defensively. */
  const clipped =
    bodyText.length > maxSnippetChars
      ? `${bodyText.slice(0, maxSnippetChars)}…`
      : bodyText;

  if (!response.ok) {
    /*
     * Map HTTP semantics to **`LeanOracleHermesError`** so apps can retry / alert
     * based on **`status`** (429 rate limits vs 502 upstream blips vs 414 too-long URL).
     */
    throw new LeanOracleHermesError(
      `Hermes responded with HTTP ${String(response.status)} for ${url.toString()}`,
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
  } catch (err: unknown) {
    throw new LeanOracleHermesMalformedEnvelopeError(
      "Hermes returned non-JSON body despite HTTP 200",
      { cause: err },
    );
  }

  /** Final lightweight schema guard before callers trust the envelope. */
  return parseHermesPriceUpdateEnvelope(decoded);
}

// ─── User-facing Hermes façade ─────────────────────────────────────────────────

/** Default clip length when surfacing malformed HTTP bodies (~2 KiB preview). */
const DEFAULT_ERROR_SNIPPET_LEN = 2048;

/**
 * Pull the **latest** accumulator batch for **`feedIds`** in one Hermes GET.
 *
 * Route: **`GET /v2/updates/price/latest`**.
 *
 * Behaviour notes:
 *
 * - **Multi-feed optimization** — Hermes packs multiple feeds inside **one**
 *   `HermesBinaryUpdateEnvelope`; `parsed?.length` can therefore exceed `#feedIds`.
 * - **Concurrency** — multiple independent oracle deployments can coexist on CKB — Hermes remains
 *   feed-keyed (`ids[]`).
 * - **On-chain fidelity** — only `binary` bytes are cryptographically verified by the
 *   on-chain `oracle_script` (echoed into **`OracleUpdateWitness`**). `parsed` is
 *   **not** an on-chain authority. The default TS update drafter reads output cell
 *   fields from `parsed` for ergonomics; callers can opt into `outputSource: "binary"`
 *   to use the SDK's narrow PNAU parser instead. The narrow parser does not verify
 *   the embedded VAA signatures or Merkle proofs — those checks remain on-chain.
 *
 * @see https://docs.pyth.network/price-feeds/how-pyth-works/hermes
 *
 * @public
 */
export async function fetchHermesLatestPriceUpdates(
  network: LeanOracleNetworkEndpoints,
  feedIds: readonly FeedIdHex[],
  options?: FetchHermesLatestOptions,
): Promise<HermesBinaryUpdateEnvelope> {
  if (feedIds.length < MIN_FEED_IDS) {
    throw new LeanOracleSdkError(
      "Hermes expects at least one `ids[]` price feed identifier",
    );
  }

  const baseRaw = options?.hermesBaseUrlOverride ?? network.hermesBaseUrl;
  const base = normalizeBaseUrl(baseRaw);

  const normalizedIds = feedIds.map((id) => normalizePythFeedId(id));

  /** Compose path + repeated `ids[]=` parameters + optional `verbose`. */
  const params = new URLSearchParams();
  appendHermesCommonQueryParams(params, normalizedIds, options ?? {});

  const url = new URL("/v2/updates/price/latest", `${base}/`);
  url.search = params.toString();

  /** Delegate to funnel — handles fetch, clipping, envelopes. */
  return fetchHermesJsonEnvelope(
    url,
    options?.signal,
    DEFAULT_ERROR_SNIPPET_LEN,
  );
}

/**
 * Pull price updates anchored at (or Hermes-definition “≤”) `publish_time` seconds.
 *
 * Route: **`GET /v2/updates/price/{publish_time}`** — useful when you need deterministic
 * replays aligned with benchmarks / debugging.
 *
 * @public
 */
export async function fetchHermesPriceUpdatesAtPublishTime(
  network: LeanOracleNetworkEndpoints,
  feedIds: readonly FeedIdHex[],
  publishTimeUnix: bigint,
  options?: FetchHermesLatestOptions,
): Promise<HermesBinaryUpdateEnvelope> {
  if (feedIds.length < MIN_FEED_IDS) {
    throw new LeanOracleSdkError(
      "Hermes expects at least one `ids[]` price feed identifier",
    );
  }

  const baseRaw = options?.hermesBaseUrlOverride ?? network.hermesBaseUrl;
  const base = normalizeBaseUrl(baseRaw);
  const segment = publishTimeUnixToPathSegment(publishTimeUnix);

  const normalizedIds = feedIds.map((id) => normalizePythFeedId(id));

  const params = new URLSearchParams();
  appendHermesCommonQueryParams(params, normalizedIds, options ?? {});

  const url = new URL(`/v2/updates/price/${segment}`, `${base}/`);
  url.search = params.toString();

  return fetchHermesJsonEnvelope(
    url,
    options?.signal,
    DEFAULT_ERROR_SNIPPET_LEN,
  );
}

/**
 * Construct **`EventSource`**-ready URL for **`/v2/updates/price/stream`**.
 *
 * The endpoint streams newline-delimited `data:` JSON payloads—each matches
 * **`HermesBinaryUpdateEnvelope`**.
 *
 * This helper **does not** open SSE — callers own long-lived sockets (frontend,
 * websocket bridges, dashboards).
 *
 * @public
 */
export function buildHermesSseStreamUrl(
  network: LeanOracleNetworkEndpoints,
  feedIds: readonly FeedIdHex[],
  options?: HermesUrlQueryOptions,
): URL {
  if (feedIds.length < MIN_FEED_IDS) {
    throw new LeanOracleSdkError(
      "Hermes stream expects at least one `ids[]` price feed identifier",
    );
  }

  const baseRaw = options?.hermesBaseUrlOverride ?? network.hermesBaseUrl;
  const base = normalizeBaseUrl(baseRaw);
  const normalizedIds = feedIds.map((id) => normalizePythFeedId(id));

  /** Mirror REST `ids[]` + `encoding` (+ optional `verbose`) for long-lived SSE. */
  const params = new URLSearchParams();
  appendHermesCommonQueryParams(params, normalizedIds, {
    encoding: options?.encoding ?? "hex",
    verbose: options?.verbose,
  });

  const url = new URL("/v2/updates/price/stream", `${base}/`);
  url.search = params.toString();
  return url;
}
