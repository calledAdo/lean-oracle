/**
 * Fixture checks for deterministic fee/fuel rebalancing.
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import { ccc } from "@ckb-ccc/core";
import {
  MIN_CELL_CAPACITY_SHANNONS,
  rebalanceTransactionFeeAfterOracleMutation,
} from "../dist/fuel/index.js";

function lock(byte = "11") {
  return {
    codeHash: `0x${byte.repeat(32)}`,
    hashType: "type",
    args: "0x",
  };
}

function txWithOutput(capacity = 100n) {
  return ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs: [],
    outputs: [
      {
        capacity,
        lock: ccc.Script.from(lock("22")),
        type: null,
      },
    ],
    outputsData: ["0x"],
    witnesses: [],
  });
}

function fuel(txByte, capacityShannons) {
  return {
    outPoint: { txHash: `0x${txByte.repeat(32)}`, index: 0n },
    capacityShannons,
  };
}

const client = { getFeeRate: async () => 1000n };

// 1. Adds fuel inputs and a change output when capacity covers fee + min change.
{
  const tx = txWithOutput();
  const result = await rebalanceTransactionFeeAfterOracleMutation(tx, {
    cccClient: client,
    cumulativeNetCapacityShannons: 0n,
    sortedFuelCandidates: [fuel("aa", MIN_CELL_CAPACITY_SHANNONS + 1_000_000n)],
    changeLockScript: lock("33"),
    feeRateShannonsPerKbOverride: 1000n,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.fuelInputsAdded, 1);
  assert.equal(result.changeOutputAdded, true);
  assert.equal(result.mutated.inputs.length, 1);
  assert.equal(result.mutated.witnesses.length, 1);
  assert.equal(result.mutated.witnesses[0], "0x");
  assert.equal(result.mutated.outputs.length, 2);
  assert.ok(result.feePaidShannons > 0n);
}

// 2. Reports shortfall without fuel candidates.
{
  const tx = txWithOutput();
  const result = await rebalanceTransactionFeeAfterOracleMutation(tx, {
    cccClient: client,
    cumulativeNetCapacityShannons: 0n,
    sortedFuelCandidates: [],
    changeLockScript: lock("33"),
    feeRateShannonsPerKbOverride: 1000n,
  });
  assert.equal(result.status, "insufficient");
  assert.equal(result.fuelInputsAdded, 0);
  assert.equal(result.changeOutputAdded, false);
  assert.ok(result.extraCapacityNeededShannons > 0n);
}

// 3. force=true may burn remaining net capacity as fee without change output.
{
  const tx = txWithOutput();
  const result = await rebalanceTransactionFeeAfterOracleMutation(tx, {
    cccClient: client,
    cumulativeNetCapacityShannons: 0n,
    sortedFuelCandidates: [fuel("bb", 20_000n)],
    changeLockScript: lock("33"),
    minimumChangeCellCapacity: MIN_CELL_CAPACITY_SHANNONS,
    force: true,
    feeRateShannonsPerKbOverride: 1n,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.changeOutputAdded, false);
  assert.equal(result.feePaidShannons, 20_000n);
}

// 4. Consumes candidates in the caller-provided order.
{
  const tx = txWithOutput();
  const result = await rebalanceTransactionFeeAfterOracleMutation(tx, {
    cccClient: client,
    cumulativeNetCapacityShannons: 0n,
    sortedFuelCandidates: [
      fuel("cc", 1n),
      fuel("dd", MIN_CELL_CAPACITY_SHANNONS + 1_000_000n),
    ],
    changeLockScript: lock("33"),
    feeRateShannonsPerKbOverride: 1000n,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.fuelInputsAdded, 2);
  assert.equal(result.mutated.inputs[0].previousOutput.txHash, `0x${"cc".repeat(32)}`);
  assert.equal(result.mutated.inputs[1].previousOutput.txHash, `0x${"dd".repeat(32)}`);
}

console.log("rebalanceFees.fixture.mjs: PASS");
