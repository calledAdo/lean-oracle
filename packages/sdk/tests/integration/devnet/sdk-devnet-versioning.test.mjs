import test from "node:test";
import assert from "node:assert/strict";

import { findLatestOracleLiveCellForFeed } from "../../../dist/ckb/findOracleCells.js";
import {
  leanOraclePresetForOracleVersion,
  leanOracleLatestOracleVersion,
} from "../../../dist/presets/index.js";

import {
  loadDevnetDeploymentFixture,
  outPointsEqual,
} from "./helpers/artifacts.mjs";
import {
  assertDevnetRpcReachable,
  createDevnetReadOnlyClient,
} from "./helpers/devnetClient.mjs";
import { readDevnetTestEnv } from "./helpers/env.mjs";

const env = readDevnetTestEnv();
const fixture = loadDevnetDeploymentFixture({ env });

/**
 * Returns the lowest version key that is *not* the latest, or `undefined` if
 * the chain has only ever had one code version (nothing to exercise).
 */
function olderOracleVersionKey() {
  const versions = fixture.network.deployment.oracleTypeVersions;
  const latest = leanOracleLatestOracleVersion(fixture.network);
  if (!versions || latest === undefined) return undefined;
  const older = Object.keys(versions)
    .map(Number)
    .filter((k) => k !== latest)
    .sort((a, b) => a - b);
  return older.length ? older[0] : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cross-version (forward-compat) behaviour
//
//  CKB type scripts are immutable per cell — a cell's `type.codeHash` is fixed
//  at creation. When the canonical `oracleType` code is upgraded (new
//  codeHash), cells created under the old codeHash are not reachable via the
//  default preset, which queries the indexer filtered by the latest codeHash.
//
//  The supported recovery path is `leanOraclePresetForOracleVersion`, which
//  builds a config whose `oracleType` is pinned to a historical version from
//  `deployment.oracleTypeVersions`. These tests document that contract:
//   * pinning to an old version changes the queried codeHash
//   * the SDK operates normally against a pinned-old config (no crash)
//   * old-codeHash and latest-codeHash queries return disjoint result sets
// ─────────────────────────────────────────────────────────────────────────────

test("pinning to an older oracle-type version changes the queried codeHash", () => {
  const olderKey = olderOracleVersionKey();
  if (olderKey === undefined) return; // single-version chain — nothing to assert

  const latest = fixture.network.deployment.oracleType;
  const pinned = leanOraclePresetForOracleVersion(fixture.network, olderKey);
  assert.notEqual(
    pinned.deployment.oracleType.codeHash,
    latest.codeHash,
    "pinned older codeHash must differ from the latest preset codeHash",
  );
  assert.match(pinned.deployment.oracleType.codeHash, /^0x[0-9a-fA-F]{64}$/);
  assert.ok(pinned.deployment.oracleType.codeDep.outPoint.txHash);
  // The rest of the config is untouched.
  assert.deepEqual(
    pinned.deployment.guardianSetType,
    fixture.network.deployment.guardianSetType,
  );
});

test("a config pinned to an older oracle-type version operates without error", async () => {
  const olderKey = olderOracleVersionKey();
  if (olderKey === undefined) return;
  await assertDevnetRpcReachable(env);
  const client = createDevnetReadOnlyClient(env);
  const pinned = leanOraclePresetForOracleVersion(fixture.network, olderKey);

  // Whether or not any cell still exists under the old codeHash, discovery
  // must complete cleanly rather than throw. (Stale personal-oracle cells
  // from before an upgrade are a realistic source of such cells.)
  const result = await findLatestOracleLiveCellForFeed(client, fixture.feedId, {
    deployment: pinned.deployment,
    oracleLockScript: fixture.oracleLockScript,
  });
  assert.ok(
    result === undefined || typeof result.oracleDataHex === "string",
    "pinned-old discovery must return either undefined or a well-formed live cell",
  );
});

test("old-codeHash and latest-codeHash discovery return disjoint cells", async () => {
  const olderKey = olderOracleVersionKey();
  if (olderKey === undefined) return;
  await assertDevnetRpcReachable(env);
  const client = createDevnetReadOnlyClient(env);

  // Latest (canonical) config — finds the live BTC oracle cell deployed under
  // the current code version.
  const latestResult = await findLatestOracleLiveCellForFeed(
    client,
    fixture.feedId,
    {
      deployment: fixture.network.deployment,
      oracleLockScript: fixture.oracleLockScript,
    },
  );

  // Same feed + lock but pinned to a prior code version. Because discovery
  // filters by `type.codeHash`, this query cannot surface the cell the latest
  // config just found.
  const pinned = leanOraclePresetForOracleVersion(fixture.network, olderKey);
  const pinnedResult = await findLatestOracleLiveCellForFeed(
    client,
    fixture.feedId,
    {
      deployment: pinned.deployment,
      oracleLockScript: fixture.oracleLockScript,
    },
  );

  if (latestResult && pinnedResult) {
    assert.ok(
      !outPointsEqual(latestResult.outPoint, pinnedResult.outPoint),
      "a cell found under the latest codeHash must not also appear under the old codeHash query",
    );
  } else {
    assert.ok(
      latestResult === undefined || typeof latestResult.oracleDataHex === "string",
    );
    assert.ok(
      pinnedResult === undefined || typeof pinnedResult.oracleDataHex === "string",
    );
  }
});
