/**
 * Fixture checks for fast transaction-builder behavior with fake CCC clients.
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import { ccc } from "@ckb-ccc/core";
import {
  attachOracleBurn,
  attachOracleDeploy,
  attachOraclePullUpdate,
  attachOracleReadDeps,
  initiateOracleBurnTx,
  initiateOracleDeployTx,
  initiateOracleUpdateTx,
  initiateReadOracleTx,
} from "../dist/tx/index.js";
import { decodeLeanOracleCellDataHex } from "../dist/ckb/index.js";
import { LeanOracleSdkError } from "../dist/errors.js";

const FEED_ID = `0x${"aa".repeat(32)}`;
const GUARDIAN_ARGS = `0x${"12".repeat(32)}`;
const ORACLE_TYPE_CODE_HASH = `0x${"11".repeat(32)}`;
const GUARDIAN_TYPE_CODE_HASH = `0x${"22".repeat(32)}`;
const PUBLIC_LOCK_CODE_HASH = `0x${"33".repeat(32)}`;
const CUSTOM_LOCK = ccc.Script.from({
  codeHash: `0x${"44".repeat(32)}`,
  hashType: "type",
  args: `0x${"55".repeat(20)}`,
});
const PUBLIC_LOCK = ccc.Script.from({
  codeHash: PUBLIC_LOCK_CODE_HASH,
  hashType: "type",
  args: "0x",
});

const guardianTypeScript = ccc.Script.from({
  codeHash: GUARDIAN_TYPE_CODE_HASH,
  hashType: "type",
  args: GUARDIAN_ARGS,
});
const guardianTypeHash = ccc.hashCkb(guardianTypeScript.toBytes());

const deployment = {
  canonicalPublicOracleLock: {
    script: { codeHash: PUBLIC_LOCK_CODE_HASH, hashType: "type", args: "0x" },
    codeDep: {
      outPoint: { txHash: `0x${"66".repeat(32)}`, index: 0n },
      depType: "code",
    },
  },
  oracleType: {
    codeHash: ORACLE_TYPE_CODE_HASH,
    hashType: "type",
    codeDep: {
      outPoint: { txHash: `0x${"77".repeat(32)}`, index: 0n },
      depType: "code",
    },
  },
  guardianSetType: {
    codeHash: GUARDIAN_TYPE_CODE_HASH,
    hashType: "type",
    args: GUARDIAN_ARGS,
    codeDep: {
      outPoint: { txHash: `0x${"88".repeat(32)}`, index: 0n },
      depType: "code",
    },
  },
  pythEmitter: {
    chain: 26,
    address: `0x${"99".repeat(32)}`,
  },
};
const network = {
  name: "testnet",
  hermesBaseUrl: "https://hermes.invalid",
  ckbJsonRpcUrl: "http://ckb.invalid",
  deployment,
};

function emptyTx() {
  return ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs: [],
    outputs: [],
    outputsData: [],
    witnesses: [],
  });
}

function oracleDataHex({ publishTimeUnix = 10n } = {}) {
  const buf = new Uint8Array(152);
  const dv = new DataView(buf.buffer);
  buf.fill(0xaa, 0, 32);
  const guardianBytes = Uint8Array.from(
    guardianTypeHash.slice(2).match(/../g).map((x) => parseInt(x, 16)),
  );
  buf.set(guardianBytes, 32);
  dv.setBigInt64(64, 1n, true);
  dv.setBigUint64(72, 2n, true);
  dv.setInt32(80, -8, true);
  dv.setBigUint64(84, publishTimeUnix, true);
  dv.setBigUint64(92, publishTimeUnix - 1n, true);
  dv.setBigInt64(100, 3n, true);
  dv.setBigUint64(108, 4n, true);
  dv.setUint32(116, 26, true);
  buf.fill(0x99, 120, 152);
  return `0x${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const oracleOutPoint = { txHash: `0x${"ab".repeat(32)}`, index: 1n };
const oracleCell = {
  outPoint: oracleOutPoint,
  cellOutput: {
    capacity: 30_000_000_000n,
    lock: CUSTOM_LOCK,
    type: ccc.Script.from({
      codeHash: ORACLE_TYPE_CODE_HASH,
      hashType: "type",
      args: FEED_ID,
    }),
  },
  outputData: oracleDataHex(),
};
const stagingOutPoint = { txHash: `0x${"bc".repeat(32)}`, index: 2n };
const stagingCell = {
  ...oracleCell,
  outPoint: stagingOutPoint,
  outputData: oracleDataHex({ publishTimeUnix: 5n }),
};
const wrongFeedOutPoint = { txHash: `0x${"bd".repeat(32)}`, index: 3n };
const wrongFeedCell = {
  ...stagingCell,
  outPoint: wrongFeedOutPoint,
  cellOutput: {
    ...stagingCell.cellOutput,
    type: ccc.Script.from({
      codeHash: ORACLE_TYPE_CODE_HASH,
      hashType: "type",
      args: `0x${"ef".repeat(32)}`,
    }),
  },
};
const guardianCell = {
  outPoint: { txHash: `0x${"cd".repeat(32)}`, index: 0n },
  cellOutput: {
    capacity: 100n,
    lock: CUSTOM_LOCK,
    type: guardianTypeScript,
  },
  outputData: "0x",
};

function fakeClient({ cells = [oracleCell], guardianCells = [guardianCell] } = {}) {
  return {
    findCells: async function* () {
      for (const c of cells) yield c;
    },
    findCellsByType: async function* () {
      for (const c of guardianCells) yield c;
    },
    getCell: async (outPoint) => {
      return cells.find(
        (c) => c.outPoint.txHash === outPoint.txHash && c.outPoint.index === outPoint.index,
      );
    },
  };
}

function hasDep(tx, outPoint) {
  return tx.cellDeps.some(
    (dep) => dep.outPoint.txHash === outPoint.txHash && dep.outPoint.index === outPoint.index,
  );
}

function assertOutPointEqual(actual, expected) {
  assert.equal(actual.txHash, expected.txHash);
  assert.equal(actual.index, expected.index);
}

const hermesEnvelope = {
  binary: { encoding: "hex", data: ["00"] },
  parsed: [
    {
      id: FEED_ID,
      price: { price: "101", conf: "2", expo: -8, publish_time: 20 },
      ema_price: { price: "99", conf: "3", expo: -8, publish_time: 20 },
      metadata: { slot: 1, proof_available_time: 20, prev_publish_time: 10 },
    },
  ],
};

// 1. Read-deps builder attaches oracle code dep and latest oracle cell dep only.
{
  const tx = emptyTx();
  const res = await attachOracleReadDeps({
    network,
    cccClient: fakeClient(),
    tx,
    feedId: FEED_ID,
    oracleLockScript: CUSTOM_LOCK,
  });
  assert.strictEqual(res.mutated, tx);
  assert.equal(tx.inputs.length, 0);
  assert.equal(tx.outputs.length, 0);
  assert.ok(hasDep(tx, deployment.oracleType.codeDep.outPoint));
  assert.ok(hasDep(tx, oracleOutPoint));
}

// 2. Read-deps builder fails clearly when no oracle cell matches.
await assert.rejects(
  () =>
    attachOracleReadDeps({
      network,
      cccClient: fakeClient({ cells: [] }),
      tx: emptyTx(),
      feedId: FEED_ID,
      oracleLockScript: CUSTOM_LOCK,
    }),
  LeanOracleSdkError,
);

// 3. Deploy builder creates one oracle output with encoded initial data and required deps.
{
  const tx = emptyTx();
  const res = await attachOracleDeploy({
    network,
    cccClient: fakeClient(),
    tx,
    feedId: FEED_ID,
    oracleLockScript: CUSTOM_LOCK,
    capacity: 30_000_000_000n,
    initialPrice: { price: 123n, publishTimeUnix: 456n },
  });
  assert.equal(res.oracleOutputIndex, 0);
  assert.equal(tx.inputs.length, 0);
  assert.equal(tx.outputs.length, 1);
  assert.equal(tx.outputs[0].capacity, 30_000_000_000n);
  assert.equal(tx.outputs[0].type.args, FEED_ID);
  assert.ok(hasDep(tx, deployment.oracleType.codeDep.outPoint));
  assert.ok(hasDep(tx, guardianCell.outPoint));
  const decoded = decodeLeanOracleCellDataHex(tx.outputsData[0]);
  assert.equal(decoded.feedId, FEED_ID);
  assert.equal(decoded.guardianSetTypeHash, guardianTypeHash);
  assert.equal(decoded.price, 123n);
  assert.equal(decoded.publishTimeUnix, 456n);
}

// 4. Burn builder consumes the oracle cell and adds no outputs.
{
  const tx = emptyTx();
  const res = await attachOracleBurn({
    network,
    cccClient: fakeClient(),
    tx,
    feedId: FEED_ID,
    oracleLockScript: CUSTOM_LOCK,
  });
  assert.equal(res.oracleInputIndex, 0);
  assert.equal(tx.inputs.length, 1);
  assertOutPointEqual(tx.inputs[0].previousOutput, oracleOutPoint);
  assert.equal(tx.outputs.length, 0);
  assert.ok(hasDep(tx, deployment.oracleType.codeDep.outPoint));
}

// 5. High-level workflow wrappers start from empty transactions and delegate correctly.
{
  const readTx = await initiateReadOracleTx({
    network,
    cccClient: fakeClient(),
    feedId: FEED_ID,
    oracleLockScript: CUSTOM_LOCK,
  });
  assert.equal(readTx.inputs.length, 0);
  assert.ok(hasDep(readTx, oracleOutPoint));

  const deployTx = await initiateOracleDeployTx({
    network,
    cccClient: fakeClient(),
    feedId: FEED_ID,
    oracleLockScript: CUSTOM_LOCK,
    capacity: 30_000_000_000n,
  });
  assert.equal(deployTx.outputs.length, 1);

  const burnTx = await initiateOracleBurnTx({
    network,
    cccClient: fakeClient(),
    feedId: FEED_ID,
    oracleLockScript: CUSTOM_LOCK,
  });
  assert.equal(burnTx.inputs.length, 1);
  assert.equal(burnTx.outputs.length, 0);
}

// 6. Exact staging updates ignore a fresher same-feed cell and may migrate the output lock.
{
  const tx = emptyTx();
  await attachOraclePullUpdate({
    network,
    cccClient: fakeClient({ cells: [oracleCell, stagingCell] }),
    tx,
    feedId: FEED_ID,
    oracleOutPoint: stagingOutPoint,
    outputLockScript: PUBLIC_LOCK,
    hermesEnvelope,
  });
  assertOutPointEqual(tx.inputs[0].previousOutput, stagingOutPoint);
  assert.ok(tx.outputs[0].lock.eq(PUBLIC_LOCK));
}

// 7. Exact burns consume the requested cell instead of discovery's freshest match.
{
  const tx = emptyTx();
  const result = await attachOracleBurn({
    network,
    cccClient: fakeClient({ cells: [oracleCell, stagingCell] }),
    tx,
    feedId: FEED_ID,
    oracleOutPoint: stagingOutPoint,
  });
  assertOutPointEqual(
    tx.inputs[result.oracleInputIndex].previousOutput,
    stagingOutPoint,
  );
}

// 8. High-level update/burn workflows thread exact outpoints and output locks.
{
  const client = fakeClient({ cells: [oracleCell, stagingCell] });
  const updateTx = await initiateOracleUpdateTx({
    network,
    cccClient: client,
    feedId: FEED_ID,
    oracleOutPoint: stagingOutPoint,
    outputLockScript: PUBLIC_LOCK,
    hermesEnvelope,
  });
  assertOutPointEqual(updateTx.inputs[0].previousOutput, stagingOutPoint);
  assert.ok(updateTx.outputs[0].lock.eq(PUBLIC_LOCK));

  const burnTx = await initiateOracleBurnTx({
    network,
    cccClient: client,
    feedId: FEED_ID,
    oracleOutPoint: stagingOutPoint,
  });
  assertOutPointEqual(burnTx.inputs[0].previousOutput, stagingOutPoint);
}

// 9. Exact update and burn reject cells outside the configured oracle/feed group.
await assert.rejects(
  () =>
    attachOraclePullUpdate({
      network,
      cccClient: fakeClient({ cells: [wrongFeedCell] }),
      tx: emptyTx(),
      feedId: FEED_ID,
      oracleOutPoint: wrongFeedOutPoint,
      hermesEnvelope,
    }),
  /does not match the configured oracle type and feed/iu,
);
await assert.rejects(
  () =>
    attachOracleBurn({
      network,
      cccClient: fakeClient({ cells: [wrongFeedCell] }),
      tx: emptyTx(),
      feedId: FEED_ID,
      oracleOutPoint: wrongFeedOutPoint,
    }),
  /does not match the configured oracle type and feed/iu,
);

console.log("txBuilders.fixture.mjs: PASS");
