import test from "node:test";
import assert from "node:assert/strict";

import { LeanOracleClient } from "../../../dist/client/LeanOracleClient.js";
import { findLatestOracleLiveCellForFeed } from "../../../dist/ckb/findOracleCells.js";
import { decodeLeanOracleCellDataHex } from "../../../dist/ckb/decodeOracleData.js";
import { resolveGuardianSetCellDep } from "../../../dist/advanced.js";
import { fetchHermesLatestPriceUpdates } from "../../../dist/hermes/index.js";
import { rebalanceFuel } from "../../../dist/fuel/index.js";

import {
  artifactGuardianSetOutPoint,
  loadDevnetDeploymentFixture,
  outPointsEqual,
} from "./helpers/artifacts.mjs";
import {
  assertDevnetRpcReachable,
  createDevnetReadOnlyClient,
  createDevnetSignerFixture,
} from "./helpers/devnetClient.mjs";
import {
  broadcastUpdatesSkipReason,
  hermesNetworkSkipReason,
  readDevnetTestEnv,
  signerSkipReason,
} from "./helpers/env.mjs";

const env = readDevnetTestEnv();
const fixture = loadDevnetDeploymentFixture({ env });

function scriptsEqual(a, b) {
  return (
    a.codeHash === b.codeHash &&
    a.hashType === b.hashType &&
    (a.args ?? "0x") === (b.args ?? "0x")
  );
}

async function fetchHermesOrSkip(t) {
  try {
    return await fetchHermesLatestPriceUpdates(
      fixture.network,
      [fixture.feedId],
      {
        encoding: "hex",
        signal: AbortSignal.timeout(20_000),
      },
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

test("devnet artifacts produce an SDK network config", () => {
  assert.equal(fixture.network.name, "devnet");
  assert.equal(fixture.network.ckbJsonRpcUrl, env.rpcUrl);
  assert.equal(fixture.network.hermesBaseUrl, env.hermesBaseUrl);
  assert.equal(fixture.feedId, env.feedId);
  assert.match(
    fixture.network.deployment.oracleType.codeHash,
    /^0x[0-9a-fA-F]{64}$/,
  );
  assert.match(
    fixture.network.deployment.guardianSetType.typeHash,
    /^0x[0-9a-fA-F]{64}$/,
  );
  assert.ok(fixture.oracleDeployment.deployed.txHash);
  assert.equal(fixture.oracleDeployment.oracleConfig.feedId, env.feedId);
});

test("devnet RPC is reachable", async () => {
  const tip = await assertDevnetRpcReachable(env);
  assert.ok(tip.hash, "expected devnet tip header hash");
});

test(
  "discovers and decodes the deployed oracle cell",
  { skip: signerSkipReason(env) },
  async () => {
    await assertDevnetRpcReachable(env);
    const { client, lockScript } = await createDevnetSignerFixture(env);
    const live = await findLatestOracleLiveCellForFeed(client, fixture.feedId, {
      deployment: fixture.network.deployment,
      oracleLockScript: fixture.oracleLockScript,
    });

    assert.ok(live, `expected a live oracle cell for feed ${fixture.feedId}`);
    const decoded = decodeLeanOracleCellDataHex(live.oracleDataHex);

    assert.equal(decoded.feedId, fixture.feedId);
    assert.equal(
      decoded.guardianSetTypeHash,
      fixture.network.deployment.guardianSetType.typeHash,
    );
    assert.equal(
      decoded.emitterChain,
      fixture.oracleDeployment.oracleConfig.emitterChain,
    );
    assert.equal(
      decoded.emitterAddress,
      fixture.oracleDeployment.oracleConfig.emitterAddress,
    );
  },
);

test(
  "LeanOracleClient reads deployed oracle state",
  { skip: signerSkipReason(env) },
  async () => {
    await assertDevnetRpcReachable(env);
    const { client, lockScript } = await createDevnetSignerFixture(env);
    const oracle = new LeanOracleClient({
      network: fixture.network,
      cccClient: client,
    });

    const state = await oracle.getOracleCellState({
      feedId: fixture.feedId,
      oracleLockScript: fixture.oracleLockScript,
    });

    assert.ok(state, `expected oracle state for feed ${fixture.feedId}`);
    assert.equal(state.data.feedId, fixture.feedId);
    assert.deepEqual(
      decodeLeanOracleCellDataHex(state.oracleDataHex),
      state.data,
    );
  },
);

test(
  "draftReadOracleTx attaches oracle read deps without inputs or outputs",
  { skip: signerSkipReason(env) },
  async () => {
    await assertDevnetRpcReachable(env);
    const { client, lockScript } = await createDevnetSignerFixture(env);
    const oracle = new LeanOracleClient({
      network: fixture.network,
      cccClient: client,
    });

    const state = await oracle.getOracleCellState({
      feedId: fixture.feedId,
      oracleLockScript: fixture.oracleLockScript,
    });
    assert.ok(state, "expected oracle state before drafting read-deps tx");

    const tx = await oracle.draftReadOracleTx({
      feedId: fixture.feedId,
      oracleLockScript: fixture.oracleLockScript,
    });

    assert.equal(tx.inputs.length, 0);
    assert.equal(tx.outputs.length, 0);
    assert.ok(
      tx.cellDeps.some((dep) =>
        outPointsEqual(
          dep.outPoint,
          fixture.network.deployment.oracleType.codeDep.outPoint,
        ),
      ),
      "expected oracle type code dep",
    );
    assert.ok(
      tx.cellDeps.some((dep) => outPointsEqual(dep.outPoint, state.outPoint)),
      "expected live oracle cell dep",
    );
  },
);

test("resolveGuardianSetCellDep finds the deployed guardian-set cell", async () => {
  await assertDevnetRpcReachable(env);
  const client = createDevnetReadOnlyClient(env);
  const guardianDep = await resolveGuardianSetCellDep(
    client,
    fixture.network.deployment,
    {
      expectedGuardianSetTypeHash:
        fixture.network.deployment.guardianSetType.typeHash,
    },
  );

  assert.equal(guardianDep.depType, "code");
  assert.ok(
    outPointsEqual(guardianDep.outPoint, artifactGuardianSetOutPoint(fixture)),
  );
});

test(
  "draftOracleUpdateTx builds a devnet oracle update transaction",
  { skip: signerSkipReason(env) },
  async (t) => {
    await assertDevnetRpcReachable(env);
    const { client, lockScript } = await createDevnetSignerFixture(env);
    const oracle = new LeanOracleClient({
      network: fixture.network,
      cccClient: client,
    });
    const before = await oracle.getOracleCellState({
      feedId: fixture.feedId,
      oracleLockScript: fixture.oracleLockScript,
    });
    assert.ok(before, "expected oracle state before drafting update tx");

    const hermesEnvelope = await fetchHermesOrSkip(t);
    if (!hermesEnvelope) return;
    const tx = await oracle.draftOracleUpdateTx({
      feedId: fixture.feedId,
      oracleLockScript: fixture.oracleLockScript,
      hermesEnvelope,
    });

    assert.equal(tx.inputs.length, 1);
    assert.ok(outPointsEqual(tx.inputs[0].previousOutput, before.outPoint));
    assert.equal(tx.outputs.length, 1);
    assert.equal(tx.outputsData.length, 1);
    assert.ok(
      scriptsEqual(tx.outputs[0].lock, fixture.oracleLockScript),
      "expected output lock to match input oracle lock",
    );

    const after = decodeLeanOracleCellDataHex(tx.outputsData[0]);
    assert.equal(after.feedId, fixture.feedId);
    assert.equal(after.guardianSetTypeHash, before.data.guardianSetTypeHash);
    assert.ok(
      after.publishTimeUnix >= before.data.publishTimeUnix,
      `expected drafted publish time ${after.publishTimeUnix.toString()} >= current ${before.data.publishTimeUnix.toString()}`,
    );
    assert.ok(tx.witnesses.length >= 1);
    assert.match(String(tx.witnesses[0]), /^0x[0-9a-fA-F]+$/);
    assert.ok(
      tx.cellDeps.some((dep) =>
        outPointsEqual(
          dep.outPoint,
          fixture.network.deployment.oracleType.codeDep.outPoint,
        ),
      ),
      "expected oracle type code dep",
    );
    assert.ok(
      tx.cellDeps.some((dep) =>
        outPointsEqual(dep.outPoint, artifactGuardianSetOutPoint(fixture)),
      ),
      "expected guardian-set cell dep",
    );
  },
);

test(
  "broadcasts a devnet oracle update and observes the new live cell",
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
    assert.ok(before, "expected oracle state before broadcasting update tx");

    const hermesEnvelope = await fetchHermesOrSkip(t);
    if (!hermesEnvelope) return;
    const tx = await oracle.draftOracleUpdateTx({
      feedId: fixture.feedId,
      oracleLockScript: fixture.oracleLockScript,
      hermesEnvelope,
    });
    const rebalance = await rebalanceFuel(tx, {
      cccClient: client,
      lockScript,
      feeRateShannonsPerKbOverride: 1200n,
      fuelLimit: 32,
    });

    assert.equal(
      rebalance.status,
      "ok",
      rebalance.status === "insufficient"
        ? `insufficient fuel; need ${rebalance.extraCapacityNeededShannons.toString()} more shannons`
        : "expected fee rebalance to succeed",
    );

    const txHash = await signer.sendTransaction(rebalance.mutated);
    assert.match(txHash, /^0x[0-9a-fA-F]{64}$/);

    const committed = await client.waitTransaction(txHash, 0, 60_000, 2_000);
    assert.ok(committed, `expected update tx ${txHash} to be committed`);

    const after = await oracle.getOracleCellState({
      feedId: fixture.feedId,
      oracleLockScript: fixture.oracleLockScript,
      minPublishTimeUnix: before.data.publishTimeUnix,
    });
    assert.ok(after, "expected oracle state after committed update tx");
    assert.equal(after.data.feedId, before.data.feedId);
    assert.equal(after.data.guardianSetTypeHash, before.data.guardianSetTypeHash);
    assert.ok(
      after.data.publishTimeUnix >= before.data.publishTimeUnix,
      `expected on-chain publish time ${after.data.publishTimeUnix.toString()} >= previous ${before.data.publishTimeUnix.toString()}`,
    );
    assert.ok(
      !outPointsEqual(after.outPoint, before.outPoint),
      "expected broadcast update to consume the previous oracle cell and create a new one",
    );
  },
);

test(
  "rebalanceFuel handles devnet update drafts without broadcasting",
  { skip: signerSkipReason(env) },
  async (t) => {
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
      feeRateShannonsPerKbOverride: 1200n,
      fuelLimit: 32,
    });

    assert.ok(result.status === "ok" || result.status === "insufficient");
    assert.equal(result.mutated, tx);
    assert.ok(result.fuelInputsAdded >= 0);
    if (result.status === "ok") {
      assert.ok(result.feePaidShannons > 0n);
    } else {
      assert.ok(result.extraCapacityNeededShannons > 0n);
    }
  },
);
