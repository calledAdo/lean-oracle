/**
 * Fixture checks for `fetchPythFeedCatalog` / `findPythFeedIdBySymbol`.
 * Run after `npm run build` from the SDK package root.
 *
 * Each case stubs `globalThis.fetch` with a canned response and asserts the
 * helper either returns the expected shape or throws the expected error class
 * with a populated `status`/`url`/`responseBodySnippet`.
 */
import assert from "node:assert/strict";
import {
  fetchPythFeedCatalog,
  findPythFeedIdBySymbol,
} from "../dist/hermes/index.js";
import {
  LeanOracleHermesError,
  LeanOracleHermesMalformedEnvelopeError,
} from "../dist/errors.js";

const FILE_NAME = "feedCatalog.fixture.mjs";

const network = {
  name: "devnet",
  hermesBaseUrl: "https://hermes.example",
  ckbJsonRpcUrl: "http://localhost:28114",
  deployment: {},
};

const originalFetch = globalThis.fetch;

function stubFetch(handler) {
  globalThis.fetch = handler;
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function mockResponse({ status = 200, body = "" }) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

const VALID_ID_A = `0x${"a".repeat(64)}`;
const VALID_ID_B = `0x${"b".repeat(64)}`;

try {
  // ── ① Happy path: parses a well-formed catalog ────────────────────────────
  let observedUrl;
  stubFetch(async (url) => {
    observedUrl = String(url);
    return mockResponse({
      body: JSON.stringify([
        {
          id: VALID_ID_A,
          attributes: { symbol: "Crypto.BTC/USD", asset_type: "crypto", base: "BTC" },
        },
        {
          // Hermes sometimes returns ids without `0x` — `normalizePythFeedId`
          // should accept that and prepend.
          id: "b".repeat(64),
          attributes: { symbol: "Crypto.ETH/USD" },
        },
      ]),
    });
  });

  const entries = await fetchPythFeedCatalog(network, {
    query: "BTC",
    assetType: "crypto",
  });

  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, VALID_ID_A);
  assert.equal(entries[0].attributes.symbol, "Crypto.BTC/USD");
  assert.equal(entries[1].id, VALID_ID_B);

  // URL must include `/v2/price_feeds`, the query, and the asset_type filter.
  assert.match(observedUrl, /\/v2\/price_feeds(\?|$)/);
  assert.match(observedUrl, /query=BTC/);
  assert.match(observedUrl, /asset_type=crypto/);
  console.log(`${FILE_NAME}: happy path PASS`);

  // ── ② hermesBaseUrlOverride wins over network.hermesBaseUrl ───────────────
  stubFetch(async (url) => {
    observedUrl = String(url);
    return mockResponse({ body: "[]" });
  });
  await fetchPythFeedCatalog(network, {
    hermesBaseUrlOverride: "https://override.example///",
  });
  assert.match(observedUrl, /^https:\/\/override\.example\/v2\/price_feeds/);
  console.log(`${FILE_NAME}: hermesBaseUrlOverride PASS`);

  // ── ③ HTTP non-2xx → LeanOracleHermesError with status + snippet ──────────
  stubFetch(async () =>
    mockResponse({ status: 502, body: "<html>bad gateway</html>" }),
  );
  await assert.rejects(
    () => fetchPythFeedCatalog(network),
    (err) => {
      assert.ok(err instanceof LeanOracleHermesError);
      assert.equal(err.status, 502);
      assert.match(err.url, /\/v2\/price_feeds/);
      assert.match(err.responseBodySnippet, /bad gateway/);
      return true;
    },
  );
  console.log(`${FILE_NAME}: HTTP error PASS`);

  // ── ④ Non-JSON body with HTTP 200 → MalformedEnvelope ─────────────────────
  stubFetch(async () => mockResponse({ body: "not json" }));
  await assert.rejects(
    () => fetchPythFeedCatalog(network),
    (err) => {
      assert.ok(err instanceof LeanOracleHermesMalformedEnvelopeError);
      return true;
    },
  );
  console.log(`${FILE_NAME}: non-JSON body PASS`);

  // ── ⑤ JSON-but-not-array → MalformedEnvelope ──────────────────────────────
  stubFetch(async () => mockResponse({ body: '{"oops":true}' }));
  await assert.rejects(
    () => fetchPythFeedCatalog(network),
    (err) =>
      err instanceof LeanOracleHermesMalformedEnvelopeError &&
      /must return a JSON array/.test(err.message),
  );
  console.log(`${FILE_NAME}: non-array PASS`);

  // ── ⑥ Entry missing string `id` → MalformedEnvelope, indexed message ──────
  stubFetch(async () =>
    mockResponse({
      body: JSON.stringify([{ id: VALID_ID_A }, { attributes: {} }]),
    }),
  );
  await assert.rejects(
    () => fetchPythFeedCatalog(network),
    (err) =>
      err instanceof LeanOracleHermesMalformedEnvelopeError &&
      /entry 1 missing string "id"/.test(err.message),
  );
  console.log(`${FILE_NAME}: missing id PASS`);

  // ── ⑦ Entry with malformed id (non-hex / wrong length) → wrapped error ────
  stubFetch(async () =>
    mockResponse({
      body: JSON.stringify([{ id: "0xZZZZ", attributes: {} }]),
    }),
  );
  await assert.rejects(
    () => fetchPythFeedCatalog(network),
    (err) =>
      err instanceof LeanOracleHermesMalformedEnvelopeError &&
      /malformed id "0xZZZZ"/.test(err.message) &&
      err.cause !== undefined,
  );
  console.log(`${FILE_NAME}: malformed id PASS`);

  // ── ⑧ Fetch throws (DNS / network) → LeanOracleHermesError with status 0 ──
  stubFetch(async () => {
    throw new TypeError("fetch failed", {
      cause: new Error("getaddrinfo ENOTFOUND hermes.example"),
    });
  });
  await assert.rejects(
    () => fetchPythFeedCatalog(network),
    (err) => {
      assert.ok(err instanceof LeanOracleHermesError);
      assert.equal(err.status, 0);
      assert.match(err.responseBodySnippet, /fetch failed|ENOTFOUND/);
      return true;
    },
  );
  console.log(`${FILE_NAME}: network failure PASS`);

  // ── ⑨ findPythFeedIdBySymbol: exact match on `attributes.symbol` ──────────
  stubFetch(async () =>
    mockResponse({
      body: JSON.stringify([
        { id: VALID_ID_A, attributes: { symbol: "Crypto.BTC/USD" } },
        { id: VALID_ID_B, attributes: { symbol: "Crypto.ETH/USD" } },
      ]),
    }),
  );
  const hitSymbol = await findPythFeedIdBySymbol(network, "Crypto.BTC/USD");
  assert.ok(hitSymbol);
  assert.equal(hitSymbol.id, VALID_ID_A);
  console.log(`${FILE_NAME}: findPythFeedIdBySymbol exact PASS`);

  // ── ⑩ findPythFeedIdBySymbol: case-insensitive + display_symbol fallback ──
  stubFetch(async () =>
    mockResponse({
      body: JSON.stringify([
        { id: VALID_ID_A, attributes: { display_symbol: "BTC/USD" } },
      ]),
    }),
  );
  const hitDisplay = await findPythFeedIdBySymbol(network, "btc/usd");
  assert.ok(hitDisplay);
  assert.equal(hitDisplay.id, VALID_ID_A);
  console.log(`${FILE_NAME}: findPythFeedIdBySymbol display_symbol+case PASS`);

  // ── ⑪ findPythFeedIdBySymbol: no match → undefined ────────────────────────
  stubFetch(async () =>
    mockResponse({
      body: JSON.stringify([
        { id: VALID_ID_A, attributes: { symbol: "Crypto.ETH/USD" } },
      ]),
    }),
  );
  const miss = await findPythFeedIdBySymbol(network, "Crypto.SOL/USD");
  assert.equal(miss, undefined);
  console.log(`${FILE_NAME}: findPythFeedIdBySymbol no match PASS`);

  console.log(`${FILE_NAME}: PASS`);
} finally {
  restoreFetch();
}
