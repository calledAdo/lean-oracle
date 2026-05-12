/**
 * Fixture checks for Hermes URL/query helpers.
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import {
  buildHermesSseStreamUrl,
  fetchHermesLatestPriceUpdates,
  fetchHermesPriceUpdatesAtPublishTime,
  normalizePythFeedId,
  publishTimeUnixToPathSegment,
} from "../dist/hermes/index.js";
import { LeanOracleSdkError } from "../dist/errors.js";

const FEED_A = `0x${"aa".repeat(32)}`;
const FEED_B_BARE = "BB".repeat(32);
const network = {
  name: "testnet",
  hermesBaseUrl: "https://unused.example",
  ckbJsonRpcUrl: "http://unused.example",
  deployment: {},
};

function ids(url) {
  return url.searchParams.getAll("ids[]");
}

// 1. Feed id normalization is canonical and rejects malformed ids.
assert.equal(normalizePythFeedId(FEED_B_BARE), `0x${"bb".repeat(32)}`);
assert.throws(() => normalizePythFeedId("0x1234"), LeanOracleSdkError);

// 2. Publish-time path segments reject negative and unsafe values.
assert.equal(publishTimeUnixToPathSegment(123n), "123");
assert.throws(() => publishTimeUnixToPathSegment(-1n), LeanOracleSdkError);
assert.throws(
  () => publishTimeUnixToPathSegment(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
  LeanOracleSdkError,
);

// 3. SSE URL trims base URL, repeats ids[], and includes encoding/verbose.
{
  const url = buildHermesSseStreamUrl(network, [FEED_A, FEED_B_BARE], {
    hermesBaseUrlOverride: "https://hermes.example///",
    encoding: "base64",
    verbose: true,
  });
  assert.equal(url.origin, "https://hermes.example");
  assert.equal(url.pathname, "/v2/updates/price/stream");
  assert.deepEqual(ids(url), [FEED_A, `0x${"bb".repeat(32)}`]);
  assert.equal(url.searchParams.get("encoding"), "base64");
  assert.equal(url.searchParams.get("verbose"), "true");
}

// 4. REST helpers build the expected latest and historical URLs before fetch.
{
  const seen = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ binary: { encoding: "hex", data: ["00"] } }));
  };
  try {
    await fetchHermesLatestPriceUpdates(network, [FEED_A], {
      hermesBaseUrlOverride: "https://hermes.example/",
    });
    await fetchHermesPriceUpdatesAtPublishTime(network, [FEED_A], 456n, {
      hermesBaseUrlOverride: "https://hermes.example/",
      verbose: true,
    });
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.match(seen[0], /^https:\/\/hermes\.example\/v2\/updates\/price\/latest\?/);
  assert.match(seen[0], /ids%5B%5D=0x/);
  assert.match(seen[0], /encoding=hex/);
  assert.match(seen[1], /^https:\/\/hermes\.example\/v2\/updates\/price\/456\?/);
  assert.match(seen[1], /verbose=true/);
}

// 5. Empty feed lists fail before any network I/O.
await assert.rejects(
  () => fetchHermesLatestPriceUpdates(network, []),
  LeanOracleSdkError,
);
assert.throws(() => buildHermesSseStreamUrl(network, []), LeanOracleSdkError);

console.log("hermesUrls.fixture.mjs: PASS");
