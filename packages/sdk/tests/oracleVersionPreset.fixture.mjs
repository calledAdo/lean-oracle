/**
 * Fixture checks for `leanOraclePresetForOracleVersion` /
 * `leanOracleLatestOracleVersion` and the testnet preset's
 * `deployment.oracleTypeVersions` map.
 *
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import {
  leanOracleTestnetPreset,
  leanOracleMainnetPreset,
  leanOraclePresetForOracleVersion,
  leanOracleLatestOracleVersion,
} from "../dist/presets/index.js";
import {
  LeanOracleSdkError,
} from "../dist/index.js";

const FILE = "oracleVersionPreset.fixture.mjs";

// ── ① The testnet preset carries a version history whose latest == oracleType
const versions = leanOracleTestnetPreset.deployment.oracleTypeVersions;
assert.ok(versions, "testnet preset must carry oracleTypeVersions");
const latestKey = leanOracleLatestOracleVersion(leanOracleTestnetPreset);
assert.equal(typeof latestKey, "number");
assert.deepEqual(
  versions[latestKey].codeHash,
  leanOracleTestnetPreset.deployment.oracleType.codeHash,
  "latest version entry must equal the canonical oracleType",
);
assert.deepEqual(
  versions[latestKey].codeDep,
  leanOracleTestnetPreset.deployment.oracleType.codeDep,
);
console.log(`${FILE}: testnet history shape PASS`);

// ── ② There is at least one older version distinct from latest
const olderKeys = Object.keys(versions)
  .map(Number)
  .filter((k) => k !== latestKey);
assert.ok(olderKeys.length >= 1, "expected at least one prior oracle_type version");
for (const k of olderKeys) {
  assert.notEqual(
    versions[k].codeHash,
    leanOracleTestnetPreset.deployment.oracleType.codeHash,
    `version ${k} should differ in codeHash from the latest`,
  );
  assert.match(versions[k].codeHash, /^0x[0-9a-fA-F]{64}$/);
  assert.ok(versions[k].codeDep.outPoint.txHash);
}
console.log(`${FILE}: prior-version distinctness PASS`);

// ── ③ leanOraclePresetForOracleVersion swaps oracleType, leaves the rest alone
const olderK = olderKeys[0];
const pinned = leanOraclePresetForOracleVersion(leanOracleTestnetPreset, olderK);
assert.equal(pinned.name, leanOracleTestnetPreset.name);
assert.equal(pinned.hermesBaseUrl, leanOracleTestnetPreset.hermesBaseUrl);
assert.deepEqual(
  pinned.deployment.oracleType,
  versions[olderK],
  "pinned config's oracleType must equal the requested version entry",
);
// Everything else on `deployment` must be unchanged.
assert.deepEqual(
  pinned.deployment.guardianSetType,
  leanOracleTestnetPreset.deployment.guardianSetType,
);
assert.deepEqual(
  pinned.deployment.defaultPublicOracleLock,
  leanOracleTestnetPreset.deployment.defaultPublicOracleLock,
);
// And the version history map is preserved on the pinned copy.
assert.deepEqual(pinned.deployment.oracleTypeVersions, versions);
// Original preset must not be mutated.
assert.notEqual(
  leanOracleTestnetPreset.deployment.oracleType.codeHash,
  versions[olderK].codeHash,
  "swapping a copy must not mutate the original preset",
);
console.log(`${FILE}: pin-to-older PASS`);

// ── ④ leanOraclePresetForOracleVersion throws on unknown version
assert.throws(
  () => leanOraclePresetForOracleVersion(leanOracleTestnetPreset, 9999),
  (err) =>
    err instanceof LeanOracleSdkError && /version 9999 not found/.test(err.message),
);
console.log(`${FILE}: unknown-version throws PASS`);

// ── ⑤ Inert mainnet preset has no version history; helper throws clearly
assert.equal(
  leanOracleLatestOracleVersion(leanOracleMainnetPreset),
  undefined,
  "mainnet preset (inert) should report no version history",
);
assert.throws(
  () => leanOraclePresetForOracleVersion(leanOracleMainnetPreset, 1),
  (err) =>
    err instanceof LeanOracleSdkError && /no oracleTypeVersions/.test(err.message),
);
console.log(`${FILE}: mainnet-inert PASS`);

console.log(`${FILE}: PASS`);
