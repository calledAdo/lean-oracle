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
assert.equal(latestKey, 4, "oracle v4 must be the canonical reproducible build");
assert.equal(
  versions[latestKey].codeHash,
  "0x5711c27408e948befdf55cdebf29b6ed0b6c56d8866200dab1dd53f28bef8c55",
);
assert.equal(
  versions[latestKey].codeDep.outPoint.txHash,
  "0x797167087bce4fa6b5bb1b6620f4e52bdad86bff28de159a732db0f82440131d",
);
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

// The guardian type was redeployed for trustless rotation. Keep the immutable
// v1 identity available while making the verified v2 state the default.
const guardianVersions =
  leanOracleTestnetPreset.deployment.guardianSetTypeVersions;
assert.ok(guardianVersions, "testnet preset must carry guardianSetTypeVersions");
assert.deepEqual(
  guardianVersions[2],
  leanOracleTestnetPreset.deployment.guardianSetType,
  "guardian v2 history entry must equal the canonical guardianSetType",
);
assert.equal(
  guardianVersions[1].codeHash,
  "0x57bddf3d57ea45c88ab68d0de706bbaecd68895fd6062b099626deb157100119",
);
assert.equal(
  guardianVersions[2].codeHash,
  "0x7ab8c7d225c0e74ecb01b58f8c7a13e298df08460d0947b776b2e47cd5525782",
);
assert.equal(
  guardianVersions[2].args,
  "0x4767b1c0444b9206234622869b1205d1acac2b492c34c52e59af14278002a734",
);
assert.deepEqual(guardianVersions[2].codeDep, {
  outPoint: {
    txHash:
      "0xfd256c6dbd3b0e2be05cb6f3cbe1f2a0aa2102bb1c1aa63ddeacd670d19b5524",
    index: 0n,
  },
  depType: "code",
});
console.log(`${FILE}: guardian history shape PASS`);

assert.equal(
  leanOracleTestnetPreset.deployment.defaultPublicOracleLock.codeDep.outPoint
    .txHash,
  "0xff625007fa8ba4ffbbaa97eb57fe70228228655a1fd72acb69e9abfbd1c4e065",
  "default public lock must reference the live Type ID-protected code cell",
);
console.log(`${FILE}: public lock dep liveness PASS`);

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
