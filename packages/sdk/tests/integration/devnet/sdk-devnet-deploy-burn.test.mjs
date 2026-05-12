import test from "node:test";
import assert from "node:assert/strict";

import { LeanOracleClient } from "../../../dist/client/LeanOracleClient.js";
import { findLatestOracleLiveCellForFeed } from "../../../dist/ckb/findOracleCells.js";
import { decodeLeanOracleCellDataHex } from "../../../dist/ckb/decodeOracleData.js";
import {
  initiateOracleDeployTx,
  initiateOracleBurnTx,
} from "../../../dist/tx/index.js";
import { rebalanceFuel } from "../../../dist/fuel/index.js";

import {
  loadDevnetDeploymentFixture,
  outPointsEqual,
} from "./helpers/artifacts.mjs";
import {
  assertDevnetRpcReachable,
  createDevnetSignerFixture,
} from "./helpers/devnetClient.mjs";
import {
  broadcastUpdatesSkipReason,
  readDevnetTestEnv,
} from "./helpers/env.mjs";

const env = readDevnetTestEnv();
const fixture = loadDevnetDeploymentFixture({ env });

// Capacity for the new oracle cell. 152-byte oracle data + lock (~53) + type
// (~65) script bytes fits comfortably in 300 CKB. Excess flows back to the
// spender's change cell on burn.
const PERSONAL_ORACLE_CAPACITY_SHANNONS = 30_000_000_000n;

async function broadcastAndWait(t, client, signer, lockScript, tx) {
  // 2000 shannons/KB stays above the devnet min-fee floor (1000 shannons/KW)
  // even for the small burn tx, while keeping deploy fees negligible.
  const rebalance = await rebalanceFuel(tx, {
    cccClient: client,
    lockScript,
    feeRateShannonsPerKbOverride: 2000n,
    fuelLimit: 32,
  });

  if (rebalance.status === "insufficient") {
    t.skip(
      `insufficient devnet fuel for signer; need ${rebalance.extraCapacityNeededShannons.toString()} more shannons`,
    );
    return undefined;
  }
  assert.equal(rebalance.status, "ok", "expected fee rebalance to succeed");

  const txHash = await signer.sendTransaction(rebalance.mutated);
  assert.match(txHash, /^0x[0-9a-fA-F]{64}$/);
  const committed = await client.waitTransaction(txHash, 0, 60_000, 2_000);
  assert.ok(committed, `expected tx ${txHash} to be committed`);
  return txHash;
}

async function findPersonalOracle(client, lockScript) {
  return findLatestOracleLiveCellForFeed(client, fixture.feedId, {
    deployment: fixture.network.deployment,
    oracleLockScript: lockScript,
  });
}

test(
  "deploys and burns a personal oracle cell on devnet",
  { skip: broadcastUpdatesSkipReason(env), timeout: 180_000 },
  async (t) => {
    await assertDevnetRpcReachable(env);
    const { client, signer, lockScript } = await createDevnetSignerFixture(env);
    const oracle = new LeanOracleClient({
      network: fixture.network,
      cccClient: client,
    });

    // ── Setup: burn any stale personal oracle cell from a prior failed run ──
    const stale = await findPersonalOracle(client, lockScript);
    if (stale) {
      const cleanupTx = await initiateOracleBurnTx({
        network: fixture.network,
        cccClient: client,
        feedId: fixture.feedId,
        oracleLockScript: lockScript,
      });
      const cleaned = await broadcastAndWait(t, client, signer, lockScript, cleanupTx);
      if (!cleaned) return;
      const afterCleanup = await findPersonalOracle(client, lockScript);
      assert.equal(
        afterCleanup,
        undefined,
        "expected stale personal oracle cell to be burned during setup",
      );
    }

    // ── ① Deploy: build a personal oracle cell under the signer's own lock ──
    const deployTx = await initiateOracleDeployTx({
      network: fixture.network,
      cccClient: client,
      feedId: fixture.feedId,
      oracleLockScript: lockScript,
      capacity: PERSONAL_ORACLE_CAPACITY_SHANNONS,
    });

    assert.equal(deployTx.inputs.length, 0, "deploy draft has no inputs");
    assert.equal(deployTx.outputs.length, 1, "deploy draft has one output");
    assert.equal(
      deployTx.outputs[0].lock.codeHash,
      lockScript.codeHash,
      "output lock should match signer's lock",
    );
    assert.equal(
      deployTx.outputs[0].lock.args,
      lockScript.args,
      "output lock args should match signer's lock",
    );

    // Output data should encode our feed id with zeroed price fields.
    const draftData = decodeLeanOracleCellDataHex(deployTx.outputsData[0]);
    assert.equal(draftData.feedId, fixture.feedId);
    assert.equal(
      draftData.guardianSetTypeHash,
      fixture.network.deployment.guardianSetType.typeHash,
    );
    assert.equal(draftData.price, 0n, "initial price should default to 0");
    assert.equal(draftData.publishTimeUnix, 0n, "initial publishTime should default to 0");

    const deployTxHash = await broadcastAndWait(t, client, signer, lockScript, deployTx);
    if (!deployTxHash) return;

    // ── Verify the new personal oracle cell is discoverable ─────────────────
    const live = await findPersonalOracle(client, lockScript);
    assert.ok(live, "expected newly deployed personal oracle cell to be live");
    assert.equal(live.outPoint.txHash, deployTxHash);

    const state = await oracle.getOracleCellState({
      feedId: fixture.feedId,
      oracleLockScript: lockScript,
    });
    assert.ok(state, "expected oracle state for personal oracle cell");
    assert.equal(state.data.feedId, fixture.feedId);
    assert.equal(state.data.publishTimeUnix, 0n);

    // ── ② Burn: consume the personal oracle cell back to the signer ─────────
    const burnTx = await initiateOracleBurnTx({
      network: fixture.network,
      cccClient: client,
      feedId: fixture.feedId,
      oracleLockScript: lockScript,
    });

    assert.equal(burnTx.inputs.length, 1, "burn draft has one input");
    assert.equal(burnTx.outputs.length, 0, "burn draft has zero outputs");
    assert.ok(
      outPointsEqual(burnTx.inputs[0].previousOutput, live.outPoint),
      "burn input should reference the deployed oracle cell",
    );

    const burnTxHash = await broadcastAndWait(t, client, signer, lockScript, burnTx);
    if (!burnTxHash) return;

    // ── Verify the cell is gone ─────────────────────────────────────────────
    const after = await findPersonalOracle(client, lockScript);
    assert.equal(
      after,
      undefined,
      "expected personal oracle cell to be consumed after burn",
    );
  },
);
