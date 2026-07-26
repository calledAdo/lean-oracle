import assert from "node:assert/strict";
import fs from "node:fs";

import {
  fetchGuardianSetUpgradeVaa,
  parseGuardianSetUpgradeVaa,
} from "../dist/wormhole/index.js";
import { LeanOracleSdkError } from "../dist/errors.js";

const officialV7 = fs
  .readFileSync(
    new URL(
      "../../../fixtures/wormhole/mainnet-guardian-set-upgrade-v7.hex",
      import.meta.url,
    ),
    "utf8",
  )
  .trim();

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Service Unavailable",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Service Unavailable",
    json: async () => {
      throw new Error("not JSON");
    },
    text: async () => body,
  };
}

const baseOptions = {
  baseUrl: "https://history.invalid",
  canonicalRegistryUrl: "https://registry.invalid/guardianSetVAAs.csv",
  pageSize: 50,
  maxScan: 50,
};

// Wormholescan currently omits gs7, while Wormhole's canonical registry has it.
{
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://history.invalid/")) {
      return jsonResponse({ data: [] });
    }
    if (String(url) === baseOptions.canonicalRegistryUrl) {
      return textResponse(`bad-row\ngs7,${officialV7}\n`);
    }
    throw new Error(`unexpected URL ${String(url)}`);
  };

  const found = await fetchGuardianSetUpgradeVaa(7, {
    ...baseOptions,
    fetchImpl,
  });
  assert.equal(found, `0x${officialV7}`);
  assert.deepEqual(parseGuardianSetUpgradeVaa(found), {
    ...parseGuardianSetUpgradeVaa(`0x${officialV7}`),
  });
  assert.equal(calls.length, 2);
}

// A history transport failure still falls back to the canonical registry.
{
  const fetchImpl = async (url) =>
    String(url).startsWith("https://history.invalid/")
      ? jsonResponse({}, 503)
      : textResponse(`gs7,${officialV7}\n`);
  assert.equal(
    await fetchGuardianSetUpgradeVaa(7, { ...baseOptions, fetchImpl }),
    `0x${officialV7}`,
  );
}

// Documented emitter overrides must be used for parsing as well as the URL.
{
  const mutated = Buffer.from(officialV7, "hex");
  const bodyOffset = 6 + mutated[5] * 66;
  mutated.fill(0x11, bodyOffset + 10, bodyOffset + 42);
  const alternateEmitter = `0x${"11".repeat(32)}`;
  const fetchImpl = async (url) =>
    String(url).startsWith("https://history.invalid/")
      ? jsonResponse({ data: [{ vaa: mutated.toString("base64") }] })
      : textResponse("");
  assert.equal(
    await fetchGuardianSetUpgradeVaa(7, {
      ...baseOptions,
      emitterAddress: alternateEmitter,
      fetchImpl,
    }),
    `0x${mutated.toString("hex")}`,
  );
}

// Successfully exhausting both sources is a clean no-op for keepers.
{
  const fetchImpl = async (url) =>
    String(url).startsWith("https://history.invalid/")
      ? jsonResponse({ data: [] })
      : textResponse("gs1,00\nmalformed\n");
  assert.equal(
    await fetchGuardianSetUpgradeVaa(7, { ...baseOptions, fetchImpl }),
    null,
  );
}

// If neither source can be contacted, surface an SDK transport error.
{
  const fetchImpl = async () => jsonResponse({}, 503);
  await assert.rejects(
    () => fetchGuardianSetUpgradeVaa(7, { ...baseOptions, fetchImpl }),
    LeanOracleSdkError,
  );
}

console.log("guardianSetUpgradeFetcher.fixture.mjs: PASS");
