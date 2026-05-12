/**
 * Fixture checks for Hermes transport failures.
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import { fetchHermesLatestPriceUpdates } from "../dist/hermes/index.js";
import { LeanOracleHermesError } from "../dist/errors.js";

const feedId = `0x${"aa".repeat(32)}`;
const network = {
  name: "devnet",
  hermesBaseUrl: "https://hermes.invalid",
  ckbJsonRpcUrl: "http://localhost:28114",
  deployment: {},
};

const originalFetch = globalThis.fetch;

try {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo EAI_AGAIN hermes.invalid"), {
        code: "EAI_AGAIN",
        hostname: "hermes.invalid",
      }),
    });
  };

  await assert.rejects(
    () =>
      fetchHermesLatestPriceUpdates(network, [feedId], {
        encoding: "hex",
      }),
    (error) => {
      assert.ok(error instanceof LeanOracleHermesError);
      assert.equal(error.status, 0);
      assert.match(error.url, /^https:\/\/hermes\.invalid\/v2\/updates\/price\/latest/);
      assert.match(error.responseBodySnippet, /EAI_AGAIN|fetch failed/);
      assert.ok(error.cause instanceof TypeError);
      return true;
    },
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("hermesTransportError.fixture.mjs: PASS");
