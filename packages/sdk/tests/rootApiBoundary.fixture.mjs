/**
 * Fixture checks for the intended root-vs-subpath API boundary.
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import * as root from "../dist/index.js";
import * as presets from "../dist/presets/index.js";
import * as tx from "../dist/tx/index.js";
import * as wormhole from "../dist/wormhole/index.js";

// The root remains curated and consumer-facing.
assert.equal(typeof root.LeanOracleClient, "function");
assert.equal(typeof root.LeanOracleTestnetClient, "function");
assert.equal(typeof root.decodeLeanOracleCellDataHex, "function");

// Version-pinning helpers intentionally live only under /presets.
assert.equal(root.leanOraclePresetForOracleVersion, undefined);
assert.equal(root.leanOracleLatestOracleVersion, undefined);
assert.equal(typeof presets.leanOraclePresetForOracleVersion, "function");
assert.equal(typeof presets.leanOracleLatestOracleVersion, "function");

// Guardian rotation is opt-in through the focused /tx and /wormhole subpaths.
assert.equal(root.attachGuardianSetRotation, undefined);
assert.equal(root.parseGuardianSetUpgradeVaa, undefined);
assert.equal(typeof tx.attachGuardianSetRotation, "function");
assert.equal(typeof tx.buildGuardianSetRotationIfBehind, "function");
assert.equal(typeof wormhole.parseGuardianSetUpgradeVaa, "function");
assert.equal(typeof wormhole.fetchGuardianSetUpgradeVaa, "function");

console.log("rootApiBoundary.fixture.mjs: PASS");
