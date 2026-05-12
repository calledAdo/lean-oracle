/**
 * Fixture checks for guardian-set CellDep resolution.
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import { ccc } from "@ckb-ccc/core";
import {
  attachGuardianSetCellDep,
  guardianSetCellDepFromOutPoint,
  resolveGuardianSetCellDep,
  resolveGuardianSetCellDepOutPoint,
} from "../dist/ckb/index.js";
import {
  LeanOracleGuardianSetResolveError,
  LeanOracleSdkError,
} from "../dist/errors.js";

const guardianType = {
  codeHash: `0x${"11".repeat(32)}`,
  hashType: "type",
  args: `0x${"22".repeat(32)}`,
};
const guardianScript = ccc.Script.from(guardianType);
const guardianTypeHash = ccc.hashCkb(guardianScript.toBytes());
const deployment = {
  guardianSetType: {
    ...guardianType,
    codeDep: {
      outPoint: { txHash: `0x${"33".repeat(32)}`, index: 0n },
      depType: "code",
    },
  },
};

function cell(txByte, type = guardianScript) {
  return {
    outPoint: { txHash: `0x${txByte.toString(16).padStart(2, "0").repeat(32)}`, index: 0n },
    cellOutput: {
      capacity: 100n,
      lock: ccc.Script.from({
        codeHash: `0x${"44".repeat(32)}`,
        hashType: "type",
        args: "0x",
      }),
      type,
    },
    outputData: "0x",
  };
}

function clientWith(cells) {
  return {
    findCellsByType: async function* () {
      for (const c of cells) yield c;
    },
  };
}

// 1. Missing expected type hash fails before scanning.
await assert.rejects(
  () => resolveGuardianSetCellDepOutPoint(clientWith([]), deployment),
  LeanOracleGuardianSetResolveError,
);

// 2. No matching live cell is an explicit resolver error.
await assert.rejects(
  () =>
    resolveGuardianSetCellDepOutPoint(clientWith([]), deployment, {
      expectedGuardianSetTypeHash: guardianTypeHash,
    }),
  LeanOracleGuardianSetResolveError,
);

// 3. Exactly one matching cell resolves to a CellDep with conventional dep type.
{
  const outPoint = await resolveGuardianSetCellDepOutPoint(
    clientWith([cell(0xaa)]),
    deployment,
    { expectedGuardianSetTypeHash: guardianTypeHash },
  );
  assert.equal(outPoint.txHash, `0x${"aa".repeat(32)}`);
  const dep = await resolveGuardianSetCellDep(
    clientWith([cell(0xaa)]),
    deployment,
    { expectedGuardianSetTypeHash: guardianTypeHash },
  );
  assert.equal(dep.depType, "code");
  assert.deepEqual(dep.outPoint, outPoint);
}

// 4. Duplicate matching cells are rejected to avoid ambiguous trust roots.
await assert.rejects(
  () =>
    resolveGuardianSetCellDepOutPoint(
      clientWith([cell(0xaa), cell(0xbb)]),
      deployment,
      { expectedGuardianSetTypeHash: guardianTypeHash },
    ),
  LeanOracleGuardianSetResolveError,
);

// 5. Abort signals are honored before scanning.
{
  const ac = new AbortController();
  ac.abort("stop");
  await assert.rejects(
    () =>
      resolveGuardianSetCellDepOutPoint(clientWith([cell(0xaa)]), deployment, {
        expectedGuardianSetTypeHash: guardianTypeHash,
        signal: ac.signal,
      }),
    LeanOracleSdkError,
  );
}

// 6. Helpers attach the resolved dependency to a transaction.
{
  const tx = ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs: [],
    outputs: [],
    outputsData: [],
    witnesses: [],
  });
  const dep = guardianSetCellDepFromOutPoint({ txHash: `0x${"99".repeat(32)}`, index: 2n });
  attachGuardianSetCellDep(tx, dep);
  assert.equal(tx.cellDeps.length, 1);
  assert.equal(tx.cellDeps[0].outPoint.txHash, dep.outPoint.txHash);
  assert.equal(tx.cellDeps[0].outPoint.index, dep.outPoint.index);
}

console.log("guardianDep.fixture.mjs: PASS");
