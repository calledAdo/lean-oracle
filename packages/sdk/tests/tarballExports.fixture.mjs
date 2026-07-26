#!/usr/bin/env node
/**
 * Tarball smoke test: pack the SDK, install it into a temp dir, then import
 * every advertised subpath and exercise one symbol from each. Catches
 * `package.json#exports` drift that the in-tree tests cannot see because
 * they import directly from `dist/`.
 *
 * Run via `npm run test:pack` from `packages/sdk`.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK_DIR = path.resolve(HERE, "..");

function log(msg) {
  process.stdout.write(`tarballExports: ${msg}\n`);
}

function run(cmd, opts) {
  return execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lean-oracle-sdk-pack-"));
const consumerDir = path.join(tmpRoot, "consumer");
fs.mkdirSync(consumerDir, { recursive: true });

let failure;
try {
  // ── ① npm pack into the temp dir ────────────────────────────────────────
  log(`packing sdk into ${tmpRoot}`);
  const packStdout = run(`npm pack --pack-destination "${tmpRoot}" --silent`, {
    cwd: SDK_DIR,
  });
  const tarballName = packStdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".tgz"))
    .pop();
  if (!tarballName) {
    throw new Error(`npm pack did not emit a .tgz filename. Stdout: ${packStdout}`);
  }
  const tarballPath = path.join(tmpRoot, tarballName);
  if (!fs.existsSync(tarballPath)) {
    throw new Error(`expected tarball at ${tarballPath}`);
  }
  log(`tarball at ${tarballPath}`);

  // ── ② Set up a fresh consumer project and install the tarball ───────────
  fs.writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify(
      { name: "lean-oracle-sdk-consumer", version: "0.0.0", private: true, type: "module" },
      null,
      2,
    ),
  );
  log("installing tarball into consumer");
  run(`npm install --silent --no-audit --no-fund "${tarballPath}"`, {
    cwd: consumerDir,
  });

  // ── ③ Drop a consumer script that imports every advertised subpath ──────
  const consumerScript = `
import { strict as assert } from "node:assert";

import {
  LeanOracleClient,
  LeanOracleTestnetClient,
  LeanOracleMainnetClient,
  leanOracleTestnetPreset,
  decodeLeanOracleCellDataHex,
  ORACLE_CELL_DATA_BYTE_LENGTH,
} from "lean-oracle-sdk";
assert.equal(typeof LeanOracleClient, "function");
assert.equal(typeof LeanOracleTestnetClient, "function");
assert.equal(typeof LeanOracleMainnetClient, "function");
assert.equal(typeof leanOracleTestnetPreset, "object");
assert.equal(typeof decodeLeanOracleCellDataHex, "function");
assert.equal(typeof ORACLE_CELL_DATA_BYTE_LENGTH, "number");

import { findLatestOracleLiveCellForFeed } from "lean-oracle-sdk/ckb";
assert.equal(typeof findLatestOracleLiveCellForFeed, "function");

import {
  attachGuardianSetRotation,
  buildGuardianSetRotationIfBehind,
  initiateOracleDeployTx,
  initiateOracleBurnTx,
  initiateOracleUpdateTx,
  initiateReadOracleTx,
} from "lean-oracle-sdk/tx";
assert.equal(typeof attachGuardianSetRotation, "function");
assert.equal(typeof buildGuardianSetRotationIfBehind, "function");
assert.equal(typeof initiateOracleDeployTx, "function");
assert.equal(typeof initiateOracleBurnTx, "function");
assert.equal(typeof initiateOracleUpdateTx, "function");
assert.equal(typeof initiateReadOracleTx, "function");

import { rebalanceFuel } from "lean-oracle-sdk/fuel";
assert.equal(typeof rebalanceFuel, "function");

import {
  fetchHermesLatestPriceUpdates,
  normalizePythFeedId,
} from "lean-oracle-sdk/hermes";
assert.equal(typeof fetchHermesLatestPriceUpdates, "function");
assert.equal(typeof normalizePythFeedId, "function");

import {
  fetchGuardianSetUpgradeVaa,
  parseGuardianSetUpgradeVaa,
  wormholeQuorum,
} from "lean-oracle-sdk/wormhole";
assert.equal(typeof fetchGuardianSetUpgradeVaa, "function");
assert.equal(typeof parseGuardianSetUpgradeVaa, "function");
assert.equal(wormholeQuorum(19), 13);

import {
  leanOracleTestnetPreset as presetFromPresets,
  leanOracleMainnetPreset,
  leanOraclePresetForOracleVersion,
  leanOracleLatestOracleVersion,
} from "lean-oracle-sdk/presets";
assert.equal(presetFromPresets.name, "testnet");
assert.equal(leanOracleMainnetPreset.name, "mainnet");
assert.equal(typeof leanOraclePresetForOracleVersion, "function");
assert.equal(typeof leanOracleLatestOracleVersion, "function");
// Exercise the version helper end-to-end through the installed tarball.
{
  const latest = leanOracleLatestOracleVersion(presetFromPresets);
  assert.equal(typeof latest, "number");
  const pinned = leanOraclePresetForOracleVersion(presetFromPresets, latest);
  assert.equal(
    pinned.deployment.oracleType.codeHash,
    presetFromPresets.deployment.oracleType.codeHash,
  );
}

import {
  resolveGuardianSetCellDep,
  encodeOracleUpdateWitnessFromAccumulatorHex,
} from "lean-oracle-sdk/advanced";
assert.equal(typeof resolveGuardianSetCellDep, "function");
assert.equal(typeof encodeOracleUpdateWitnessFromAccumulatorHex, "function");

console.log("tarballExports: all subpaths resolved and exported expected symbols");
`;
  fs.writeFileSync(path.join(consumerDir, "consumer.mjs"), consumerScript);

  // ── ④ Execute the consumer script ───────────────────────────────────────
  log("executing consumer script");
  const out = run(`node consumer.mjs`, { cwd: consumerDir, stdio: "pipe" });
  process.stdout.write(out);
  log("PASS");
} catch (err) {
  failure = err;
  process.stderr.write(`tarballExports: FAIL ${err.message ?? err}\n`);
  if (err.stdout) process.stderr.write(`stdout:\n${err.stdout}\n`);
  if (err.stderr) process.stderr.write(`stderr:\n${err.stderr}\n`);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

process.exit(failure ? 1 : 0);
