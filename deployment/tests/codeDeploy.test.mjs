import assert from "node:assert/strict";
import test from "node:test";

import { ccc } from "@ckb-ccc/core";

import {
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
