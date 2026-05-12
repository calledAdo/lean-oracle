import test from "node:test";
import assert from "node:assert/strict";

import { LeanOracleClient } from "../../../dist/client/LeanOracleClient.js";
import { decodeLeanOracleCellDataHex } from "../../../dist/ckb/decodeOracleData.js";
import { encodeOracleCellDataBytes } from "../../../dist/ckb/encodeOracleData.js";
import { fetchHermesLatestPriceUpdates } from "../../../dist/hermes/index.js";
import { rebalanceFuel } from "../../../dist/fuel/index.js";

import {
  artifactGuardianSetOutPoint,
  loadDevnetDeploymentFixture,
  outPointsEqual,
} from "./helpers/artifacts.mjs";
import {
  assertDevnetRpcReachable,
  createDevnetSignerFixture,
} from "./helpers/devnetClient.mjs";
import {
  broadcastUpdatesSkipReason,
  hermesNetworkSkipReason,
  readDevnetTestEnv,
} from "./helpers/env.mjs";

const env = readDevnetTestEnv();
const fixture = loadDevnetDeploymentFixture({ env });

function hexFromBytes(bytes) {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

async function fetchHermesOrSkip(t) {
  try {
    return await fetchHermesLatestPriceUpdates(
      fixture.network,
      [fixture.feedId],
      { encoding: "hex", signal: AbortSignal.timeout(20_000) },
    );
  } catch (error) {
    const reason = hermesNetworkSkipReason(error);
    if (reason) {
      t.skip(reason);
      return undefined;
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Negative-path tests: draft a valid update via the SDK, then tamper one
//  field after drafting. The on-chain script must reject with the expected
//  error code. These guard the contract between SDK drafts and on-chain
//  validation — a bug where the SDK silently encodes a non-canonical payload
//  would otherwise pass every existing test.
// ─────────────────────────────────────────────────────────────────────────────

test(
  "tampered output cell-data emitterChain is rejected on-chain",
  { skip: broadcastUpdatesSkipReason(env), timeout: 120_000 },
  async (t) => {
    await assertDevnetRpcReachable(env);
    const { client, signer, lockScript } = await createDevnetSignerFixture(env);
    const oracle = new LeanOracleClient({
      network: fixture.network,
      cccClient: client,
    });

    const hermesEnvelope = await fetchHermesOrSkip(t);
    if (!hermesEnvelope) return;

    const tx = await oracle.draftOracleUpdateTx({
      feedId: fixture.feedId,
      oracleLockScript: fixture.oracleLockScript,
      hermesEnvelope,
    });

    // Tamper: re-encode the output cell-data with a wrong emitter chain.
    // The on-chain script enforces `new.emitter_chain == old.emitter_chain`
    // (ERROR_CONFIG_MUTATED = 14).
    const draftedData = decodeLeanOracleCellDataHex(tx.outputsData[0]);
    const tamperedData = encodeOracleCellDataBytes({
      ...draftedData,
      emitterChain: draftedData.emitterChain === 26 ? 99 : 26,
    });
    tx.outputsData[0] = hexFromBytes(tamperedData);

    const rebalance = await rebalanceFuel(tx, {
      cccClient: client,
      lockScript,
      feeRateShannonsPerKbOverride: 2000n,
      fuelLimit: 32,
    });
    if (rebalance.status === "insufficient") {
      t.skip(
        `insufficient devnet fuel; need ${rebalance.extraCapacityNeededShannons.toString()} more shannons`,
      );
      return;
    }
    assert.equal(rebalance.status, "ok");

    await assert.rejects(
      () => signer.sendTransaction(rebalance.mutated),
      (err) => {
        const msg = String(err?.message ?? err);
        // ERROR_CONFIG_MUTATED = 14 on the oracle_type script (data2 hash).
        return /error code 14/.test(msg) && /Inputs\[\d+\]\.Type/.test(msg);
      },
      "expected on-chain rejection with oracle_type error code 14 (CONFIG_MUTATED)",
    );
  },
);

test(
  "rebalanceFuel reports insufficient when no fuel candidates are available",
  { skip: broadcastUpdatesSkipReason(env), timeout: 60_000 },
  async (t) => {
    // Force-provoke the "insufficient" branch by setting `fuelLimit: 0`,
    // which caps the fuel collector to zero plain cells. The drafted update
    // tx has net-zero capacity (one oracle input, one oracle output of
    // equal capacity), so without fuel it cannot pay the fee + min-change.
    await assertDevnetRpcReachable(env);
    const { client, lockScript } = await createDevnetSignerFixture(env);
    const oracle = new LeanOracleClient({
      network: fixture.network,
      cccClient: client,
    });
    const hermesEnvelope = await fetchHermesOrSkip(t);
    if (!hermesEnvelope) return;

    const tx = await oracle.draftOracleUpdateTx({
      feedId: fixture.feedId,
      oracleLockScript: fixture.oracleLockScript,
      hermesEnvelope,
    });

    const result = await rebalanceFuel(tx, {
      cccClient: client,
      lockScript,
      feeRateShannonsPerKbOverride: 2000n,
      fuelLimit: 0,
    });

    assert.equal(result.status, "insufficient");
    assert.equal(result.fuelInputsAdded, 0);
    assert.ok(
      result.extraCapacityNeededShannons > 0n,
      `expected positive shortfall, got ${result.extraCapacityNeededShannons}`,
    );
    assert.ok(
      result.feeNeededShannons > 0n,
      `expected positive fee, got ${result.feeNeededShannons}`,
    );
  },
);

test(
  "tampered output cell-data publishTime (replay) is rejected on-chain",
  { skip: broadcastUpdatesSkipReason(env), timeout: 120_000 },
  async (t) => {
    await assertDevnetRpcReachable(env);
    const { client, signer, lockScript } = await createDevnetSignerFixture(env);
    const oracle = new LeanOracleClient({
      network: fixture.network,
      cccClient: client,
    });

    const before = await oracle.getOracleCellState({
      feedId: fixture.feedId,
      oracleLockScript: fixture.oracleLockScript,
    });
    assert.ok(before, "expected oracle state before tampering");

    const hermesEnvelope = await fetchHermesOrSkip(t);
    if (!hermesEnvelope) return;

    const tx = await oracle.draftOracleUpdateTx({
      feedId: fixture.feedId,
      oracleLockScript: fixture.oracleLockScript,
      hermesEnvelope,
    });

    // Tamper: replay the OLD publishTime as the NEW publishTime. The on-chain
    // script enforces strict-monotonic publishTime
    // (ERROR_TIMESTAMP_NOT_MONOTONIC = 13).
    const draftedData = decodeLeanOracleCellDataHex(tx.outputsData[0]);
    const tamperedData = encodeOracleCellDataBytes({
      ...draftedData,
      publishTimeUnix: before.data.publishTimeUnix,
    });
    tx.outputsData[0] = hexFromBytes(tamperedData);

    const rebalance = await rebalanceFuel(tx, {
      cccClient: client,
      lockScript,
      feeRateShannonsPerKbOverride: 2000n,
      fuelLimit: 32,
    });
    if (rebalance.status === "insufficient") {
      t.skip(
        `insufficient devnet fuel; need ${rebalance.extraCapacityNeededShannons.toString()} more shannons`,
      );
      return;
    }
    assert.equal(rebalance.status, "ok");

    await assert.rejects(
      () => signer.sendTransaction(rebalance.mutated),
      (err) => {
        const msg = String(err?.message ?? err);
        return /error code 13/.test(msg) && /Inputs\[\d+\]\.Type/.test(msg);
      },
      "expected on-chain rejection with oracle_type error code 13 (TIMESTAMP_NOT_MONOTONIC)",
    );
  },
);

test(
  "removing the guardian-set cell-dep from a drafted update is rejected on-chain",
  { skip: broadcastUpdatesSkipReason(env), timeout: 120_000 },
  async (t) => {
    // The SDK attaches the canonical guardian-set cell as a CellDep via
    // `resolveGuardianSetCellDep`. The on-chain script walks all cell-deps
    // looking for one whose type-script hash matches the oracle cell's
    // `guardian_set_type_hash`. If no such dep is present, it must reject with
    // ERROR_GUARDIAN_SET_NOT_FOUND (19). This guards the dep-walking path.
    await assertDevnetRpcReachable(env);
    const { client, signer, lockScript } = await createDevnetSignerFixture(env);
    const oracle = new LeanOracleClient({
      network: fixture.network,
      cccClient: client,
    });
    const hermesEnvelope = await fetchHermesOrSkip(t);
    if (!hermesEnvelope) return;

    const tx = await oracle.draftOracleUpdateTx({
      feedId: fixture.feedId,
      oracleLockScript: fixture.oracleLockScript,
      hermesEnvelope,
    });

    // Tamper: drop the guardian-set state cell-dep. What remains are code
    // deps for oracle_type / guardian_set_type / bind-lock — none of which
    // have a type script that matches `OracleData.guardian_set_type_hash`.
    const gsOutPoint = artifactGuardianSetOutPoint(fixture);
    const before = tx.cellDeps.length;
    tx.cellDeps = tx.cellDeps.filter(
      (dep) => !outPointsEqual(dep.outPoint, gsOutPoint),
    );
    assert.equal(
      tx.cellDeps.length,
      before - 1,
      "expected exactly one guardian-set cell-dep to be removed",
    );

    const rebalance = await rebalanceFuel(tx, {
      cccClient: client,
      lockScript,
      feeRateShannonsPerKbOverride: 2000n,
      fuelLimit: 32,
    });
    if (rebalance.status === "insufficient") {
      t.skip(
        `insufficient devnet fuel; need ${rebalance.extraCapacityNeededShannons.toString()} more shannons`,
      );
      return;
    }
    assert.equal(rebalance.status, "ok");

    await assert.rejects(
      () => signer.sendTransaction(rebalance.mutated),
      (err) => {
        const msg = String(err?.message ?? err);
        // ERROR_GUARDIAN_SET_NOT_FOUND = 19 on the oracle_type script.
        return /error code 19/.test(msg) && /Inputs\[\d+\]\.Type/.test(msg);
      },
      "expected on-chain rejection with oracle_type error code 19 (GUARDIAN_SET_NOT_FOUND)",
    );
  },
);
