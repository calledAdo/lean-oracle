import assert from "node:assert/strict";
import test from "node:test";

import { ccc } from "@ckb-ccc/core";

import {
  assertCodeDeploymentCandidatePromotable,
  buildCodeDeploymentTransaction,
  TYPE_ID_CODE_HASH,
} from "../dist/codeDeploy.js";

test("code deployments carry a Type ID so capacity selection skips code cells", () => {
  const lock = ccc.Script.from({
    codeHash: `0x${"11".repeat(32)}`,
    hashType: "type",
    args: `0x${"22".repeat(20)}`,
  });
  const codeDataHex = `0x${"ab".repeat(128)}`;
  const tx = buildCodeDeploymentTransaction({ lock, codeDataHex });

  assert.equal(tx.outputs.length, 1);
  assert.equal(tx.outputsData[0], codeDataHex);
  assert.equal(tx.outputs[0].type.codeHash, TYPE_ID_CODE_HASH);
  assert.equal(tx.outputs[0].type.hashType, "type");
  assert.equal(tx.outputs[0].type.args, `0x${"00".repeat(32)}`);
  assert.equal(
    tx.outputs[0].capacity,
    ccc.fixedPointFrom(tx.outputs[0].occupiedSize + 128),
  );
});

test("promotion requires a committed live Type ID cell matching local bytes", async () => {
  const codeDataHex = `0x${"ab".repeat(128)}`;
  const codeHash = ccc.hashCkb(ccc.bytesFrom(codeDataHex));
  const typeIdArgs = `0x${"33".repeat(32)}`;
  const candidate = {
    mode: "broadcast",
    codeHash,
    hashType: "data2",
    depType: "code",
    txHash: `0x${"44".repeat(32)}`,
    index: 0,
    capacity: 20_000_000_000n,
    typeIdArgs,
  };
  const liveCell = {
    cellOutput: {
      capacity: candidate.capacity,
      type: ccc.Script.from({
        codeHash: TYPE_ID_CODE_HASH,
        hashType: "type",
        args: typeIdArgs,
      }),
    },
    outputData: codeDataHex,
  };
  const client = {
    getTransaction: async () => ({ status: "committed" }),
    getCellLive: async () => liveCell,
  };

  await assert.doesNotReject(() =>
    assertCodeDeploymentCandidatePromotable({
      candidate,
      localBinary: ccc.bytesFrom(codeDataHex),
      client,
    }),
  );

  await assert.rejects(
    () =>
      assertCodeDeploymentCandidatePromotable({
        candidate: { ...candidate, mode: "dry-run" },
        localBinary: ccc.bytesFrom(codeDataHex),
        client,
      }),
    /broadcast candidate/u,
  );
  await assert.rejects(
    () =>
      assertCodeDeploymentCandidatePromotable({
        candidate: { ...candidate, hashType: "data" },
        localBinary: ccc.bytesFrom(codeDataHex),
        client,
      }),
    /data2\/code/u,
  );
  await assert.rejects(
    () =>
      assertCodeDeploymentCandidatePromotable({
        candidate,
        localBinary: ccc.bytesFrom(`0x${"cd".repeat(128)}`),
        client,
      }),
    /local release binary/u,
  );
  await assert.rejects(
    () =>
      assertCodeDeploymentCandidatePromotable({
        candidate,
        localBinary: ccc.bytesFrom(codeDataHex),
        client: { ...client, getTransaction: async () => ({ status: "pending" }) },
      }),
    /not committed/u,
  );
  await assert.rejects(
    () =>
      assertCodeDeploymentCandidatePromotable({
        candidate,
        localBinary: ccc.bytesFrom(codeDataHex),
        client: {
          ...client,
          getCellLive: async () => ({
            ...liveCell,
            cellOutput: { ...liveCell.cellOutput, type: undefined },
          }),
        },
      }),
    /Type ID/u,
  );
});
