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

// Guardian state identity and executable code deployment are independent axes.
const guardianIdentities =
  leanOracleTestnetPreset.deployment.guardianSetIdentityHistory;
const guardianCodeVersions =
  leanOracleTestnetPreset.deployment.guardianSetCodeVersions;
assert.ok(guardianIdentities, "testnet preset must carry guardianSetIdentityHistory");
assert.ok(guardianCodeVersions, "testnet preset must carry guardianSetCodeVersions");
assert.deepEqual(Object.keys(guardianIdentities), ["1", "2", "4"]);
assert.deepEqual(Object.keys(guardianCodeVersions), ["1", "2", "3"]);
assert.equal(
  guardianIdentities[1].codeHash,
  "0x57bddf3d57ea45c88ab68d0de706bbaecd68895fd6062b099626deb157100119",
);
assert.equal(
  guardianIdentities[4].codeHash,
  "0x7ab8c7d225c0e74ecb01b58f8c7a13e298df08460d0947b776b2e47cd5525782",
);
assert.equal(
  guardianIdentities[4].args,
  "0xff1d70fbea716cb99b1b0b9906bf00255fe080808d07bd15352a56273a15a3d5",
);
assert.equal(guardianIdentities[4].identityVersion, 4);
assert.equal(guardianCodeVersions[3].codeVersion, 3);
assert.deepEqual(guardianCodeVersions[3].codeDep, {
  outPoint: {
    txHash:
      "0x0903144bfb3a736d1a989783d0e6304c153bb5b7627b64843e73e9b2f58f42b9",
    index: 0n,
  },
  depType: "code",
});
assert.equal(
  guardianIdentities[2].args,
  "0x4767b1c0444b9206234622869b1205d1acac2b492c34c52e59af14278002a734",
  "guardian identity v2 must retain the legacy singleton Type ID args",
);
assert.equal(
  guardianCodeVersions[2].codeHash,
  guardianCodeVersions[3].codeHash,
  "code v3 redeployed the same binary under a protected code cell",
);
assert.notDeepEqual(
  guardianCodeVersions[2].codeDep,
  guardianCodeVersions[3].codeDep,
  "code v2 and v3 must retain their distinct dependency outpoints",
);
assert.equal(
  "guardianSetTypeVersions" in leanOracleTestnetPreset.deployment,
  false,
  "the overloaded guardianSetTypeVersions field must be removed",
);
assert.deepEqual(leanOracleTestnetPreset.deployment.guardianSetLock, {
  script: {
    codeHash:
      "0x5554bc20c9f3dbb8d1d7a6591b1b2ceeb0bbee822804635ee168911a440a111c",
    hashType: "data2",
    args: "0x7de82d61a7eb2ec82b0dc653e558ba120efcbfbb44dac87c12972d05bf250653",
  },
  codeDep: {
    outPoint: {
      txHash:
        "0xff625007fa8ba4ffbbaa97eb57fe70228228655a1fd72acb69e9abfbd1c4e065",
      index: 0n,
    },
    depType: "code",
  },
});
console.log(`${FILE}: guardian history shape PASS`);

assert.equal(
  leanOracleTestnetPreset.deployment.canonicalPublicOracleLock.codeDep.outPoint
    .txHash,
  "0xff625007fa8ba4ffbbaa97eb57fe70228228655a1fd72acb69e9abfbd1c4e065",
  "canonical public lock must reference the live Type ID-protected code cell",
);
assert.strictEqual(
  leanOracleTestnetPreset.deployment.canonicalPublicOracleLock,
  leanOracleTestnetPreset.deployment.guardianSetLock,
  "canonical public oracle and guardian cells must share one lock reference",
);
assert.equal(
  "defaultPublicOracleLock" in leanOracleTestnetPreset.deployment,
  false,
  "the caller-ambiguous defaultPublicOracleLock field must be removed",
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
  pinned.deployment.canonicalPublicOracleLock,
  leanOracleTestnetPreset.deployment.canonicalPublicOracleLock,
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
