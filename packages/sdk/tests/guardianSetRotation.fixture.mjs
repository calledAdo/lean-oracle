import assert from "node:assert/strict";
import fs from "node:fs";

import { ccc } from "@ckb-ccc/core";
import {
  attachGuardianSetRotation,
  buildGuardianSetRotationIfBehind,
} from "../dist/tx/index.js";
import {
  decodeGuardianSetCellDataHex,
  encodeGuardianSetCellDataBytes,
} from "../dist/ckb/index.js";
import {
  parseGuardianSetUpgradeVaa,
  wormholeQuorum,
} from "../dist/wormhole/index.js";
import { LeanOracleSdkError } from "../dist/errors.js";

const officialV7Hex = fs
  .readFileSync(
    new URL(
      "../../../fixtures/wormhole/mainnet-guardian-set-upgrade-v7.hex",
      import.meta.url,
    ),
    "utf8",
  )
  .trim();
const officialV7 = `0x${officialV7Hex}`;
const parsedV7 = parseGuardianSetUpgradeVaa(officialV7);

const set6Addresses = [
  "0x5893b5a76c3f739645648885bdccc06cd70a3cd3",
  "0xff6cb952589bde862c25ef4392132fb9d4a42157",
  "0x114de8460193bdf3a2fcf81f86a09765f4762fd1",
  "0x107a0086b32d7a0977926a205131d8731d39cbeb",
  "0x8c82b2fd82faed2711d59af0f2499d16e726f6b2",
  "0x42579bffbcf4276e290ab8e4c162bd4052b97970",
  "0x938f104aeb5581293216ce97d771e0cb721221b1",
  "0x18e41674ccf26329cd111406c1d05c6c80b23edc",
  "0x9d16870160e703324d057c3361c34c5befba2c34",
  "0x000ac0076727b35fbea2dac28fee5ccb0fea768e",
  "0xaf45ced136b9d9e24903464ae889f5c8a723fc14",
  "0xf93124b7c738843cbb89e864c862c38cddcccf95",
  "0xd2cc37a4dc036a8d232b48f62cdd4731412f4890",
  "0xda798f6896a3331f64b48c12d1d57fd9cbe70811",
  "0xd1f64e26238811de5553c40f64af41ee1b6057cc",
  "0x3f851ad586a47cef8d04748f33ab0d71395f06b4",
  "0x178e21ad2e77ae06711549cfbb1f9c7a9d8096e8",
  "0x7899ceab1dc961dae9defdb7a4f521269a5448fc",
  "0x6fbebc898f403e4773e95feb15e80c9a99c8348d",
];

const GUARDIAN_TYPE_CODE_HASH = `0x${"22".repeat(32)}`;
const GUARDIAN_ARGS = `0x${"33".repeat(32)}`;
const guardianType = ccc.Script.from({
  codeHash: GUARDIAN_TYPE_CODE_HASH,
  hashType: "type",
  args: GUARDIAN_ARGS,
});
const guardianCodeDep = {
  outPoint: { txHash: `0x${"44".repeat(32)}`, index: 0n },
  depType: "code",
};
const network = {
  name: "testnet",
  hermesBaseUrl: "https://hermes.invalid",
  ckbJsonRpcUrl: "https://ckb.invalid",
  deployment: {
    guardianSetType: {
      codeHash: GUARDIAN_TYPE_CODE_HASH,
      hashType: "type",
      args: GUARDIAN_ARGS,
      codeDep: guardianCodeDep,
    },
  },
};
const guardianCell = {
  outPoint: { txHash: `0x${"55".repeat(32)}`, index: 0n },
  cellOutput: {
    capacity: 52_600_000_000n,
    lock: ccc.Script.from({
      codeHash: `0x${"66".repeat(32)}`,
      hashType: "type",
      args: `0x${"77".repeat(20)}`,
    }),
    type: guardianType,
  },
  outputData: ccc.hexFrom(
    encodeGuardianSetCellDataBytes({
      setIndex: 6,
      quorum: 13,
      guardianAddresses: set6Addresses,
    }),
  ),
};

function fakeClient(cells = [guardianCell]) {
  let resolutions = 0;
  return {
    get resolutions() {
      return resolutions;
    },
    findCellsByType: async function* () {
      resolutions++;
      for (const cell of cells) yield cell;
    },
  };
}

function txWithExistingInput() {
  const tx = ccc.Transaction.from({
    inputs: [
      {
        previousOutput: {
          txHash: `0x${"88".repeat(32)}`,
          index: 1n,
        },
      },
    ],
  });
  tx.setWitnessArgsAt(0, ccc.WitnessArgs.from({ lock: "0x1234" }));
  return tx;
}

function hasDep(tx, expected) {
  return tx.cellDeps.some(
    (dep) =>
      dep.outPoint.txHash === expected.txHash && dep.outPoint.index === expected.index,
  );
}

// The group witness belongs at the guardian input's absolute index, even when
// a caller already placed unrelated inputs and lock witnesses in the tx.
{
  const tx = txWithExistingInput();
  const result = await attachGuardianSetRotation({
    network,
    cccClient: fakeClient(),
    tx,
    governanceVaa: officialV7,
  });

  assert.strictEqual(result.mutated, tx);
  assert.equal(tx.inputs.length, 2);
  assert.equal(tx.outputs.length, 1);
  assert.equal(tx.getWitnessArgsAt(0).lock, "0x1234");
  assert.equal(tx.getWitnessArgsAt(1).inputType, officialV7);
  assert.ok(hasDep(tx, guardianCodeDep.outPoint));
  assert.equal(tx.outputs[0].capacity, guardianCell.cellOutput.capacity);
  assert.deepEqual(decodeGuardianSetCellDataHex(tx.outputsData[0]), {
    setIndex: 7,
    quorum: 13,
    guardianAddresses: parsedV7.addresses,
  });
}

await assert.rejects(
  () =>
    attachGuardianSetRotation({
      network,
      cccClient: fakeClient([]),
      tx: ccc.Transaction.from({}),
      governanceVaa: officialV7,
    }),
  LeanOracleSdkError,
);
await assert.rejects(
  () =>
    attachGuardianSetRotation({
      network,
      cccClient: fakeClient([guardianCell, guardianCell]),
      tx: ccc.Transaction.from({}),
      governanceVaa: officialV7,
    }),
  LeanOracleSdkError,
);

// Keeper no-op must leave the transaction untouched.
{
  const client = fakeClient();
  const tx = txWithExistingInput();
  const plan = await buildGuardianSetRotationIfBehind({
    network,
    cccClient: client,
    tx,
    fetchUpgradeVaa: async (currentIndex) => {
      assert.equal(currentIndex, 6);
      return null;
    },
  });
  assert.deepEqual(plan, { rotated: false, currentIndex: 6 });
  assert.equal(tx.inputs.length, 1);
  assert.equal(client.resolutions, 1);
}

// Keeper rotation resolves the live cell only once.
{
  const client = fakeClient();
  const plan = await buildGuardianSetRotationIfBehind({
    network,
    cccClient: client,
    tx: txWithExistingInput(),
    fetchUpgradeVaa: async () => officialV7,
  });
  assert.equal(plan.rotated, true);
  assert.equal(plan.currentIndex, 6);
  assert.equal(plan.nextIndex, 7);
  assert.equal(client.resolutions, 1);
}

// Public codecs should reject values that would be wrapped or rejected on-chain.
assert.throws(() => wormholeQuorum(0), LeanOracleSdkError);
assert.throws(() => wormholeQuorum(1.5), LeanOracleSdkError);
assert.throws(
  () =>
    encodeGuardianSetCellDataBytes({
      setIndex: -1,
      quorum: 1,
      guardianAddresses: [set6Addresses[0]],
    }),
  LeanOracleSdkError,
);
assert.throws(
  () =>
    encodeGuardianSetCellDataBytes({
      setIndex: 1,
      quorum: 1,
      guardianAddresses: [set6Addresses[0], set6Addresses[0]],
    }),
  LeanOracleSdkError,
);

console.log("guardianSetRotation.fixture.mjs: PASS");
