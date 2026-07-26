import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ccc } from "@ckb-ccc/core";

import {
  readCodeDeploymentArtifact,
  writeDeploymentActionArtifacts,
  writeDeploymentArtifact,
} from "../dist/artifacts.js";
import {
  buildRotatedGuardianCanonicalState,
  rotateGuardianSetStateCell,
} from "../dist/guardianSetRotate.js";
import { encodeGuardianSetDataBytes } from "../dist/guardianSetDeploy.js";

const officialV7 = `0x${fs
  .readFileSync(
    new URL(
      "../../fixtures/wormhole/mainnet-guardian-set-upgrade-v7.hex",
      import.meta.url,
    ),
    "utf8",
  )
  .trim()}`;

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lean-oracle-rotation-"));
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  return root;
}

const guardianSetType = {
  version: 2,
  codeHash: `0x${"11".repeat(32)}`,
  hashType: "data2",
  depType: "code",
  outPoint: { txHash: `0x${"22".repeat(32)}`, index: 0 },
};
const guardianSetLock = {
  codeVersion: 2,
  codeHash: `0x${"70".repeat(32)}`,
  hashType: "data2",
  depType: "code",
  outPoint: { txHash: `0x${"71".repeat(32)}`, index: 0 },
  script: {
    codeHash: `0x${"70".repeat(32)}`,
    hashType: "data2",
    args: `0x${"72".repeat(32)}`,
  },
};
const priorState = {
  kind: "deploy:guardian-set",
  mode: "broadcast",
  network: "testnet",
  identityVersion: 4,
  fullTypeHash: `0x${"73".repeat(32)}`,
  guardianSetType: {
    ...guardianSetType,
    version: 4,
    identityVersion: 4,
    codeVersion: guardianSetType.version,
  },
  guardianSetLock,
  guardianSet: { setIndex: 6, quorum: 13, guardianAddresses: [] },
  deployed: {
    txHash: `0x${"33".repeat(32)}`,
    index: 0,
    typeIdArgs: `0x${"44".repeat(32)}`,
    capacity: "52600000000",
  },
};

test("rotation projection preserves guardian identity and bind-lock metadata", () => {
  const canonical = buildRotatedGuardianCanonicalState({
    priorState,
    nextSet: { setIndex: 7, quorum: 13, guardianAddresses: [] },
    deployed: {
      txHash: `0x${"74".repeat(32)}`,
      index: 0,
      typeIdArgs: priorState.deployed.typeIdArgs,
      capacity: 52_600_000_000n,
    },
  });
  assert.equal(canonical.identityVersion, 4);
  assert.equal(canonical.guardianSetType.version, 4);
  assert.equal(canonical.guardianSetType.codeVersion, 2);
  assert.deepEqual(canonical.guardianSetLock, guardianSetLock);
  assert.equal(canonical.guardianSet.setIndex, 7);
});

test("rotation receipt advances the canonical guardian state artifact", () => {
  const root = tempRoot();
  try {
    writeDeploymentArtifact(root, "testnet", "deploy:guardian-set", priorState);
    const canonicalState = {
      ...priorState,
      guardianSet: {
        setIndex: 7,
        quorum: 13,
        guardianAddresses: [`0x${"55".repeat(20)}`],
      },
      deployed: {
        ...priorState.deployed,
        txHash: `0x${"66".repeat(32)}`,
        capacity: "52700000000",
      },
    };
    const receipt = {
      kind: "rotate:guardian-set",
      mode: "broadcast",
      network: "testnet",
      rotated: { from: 6, to: 7 },
      canonicalState,
    };

    const written = writeDeploymentActionArtifacts(
      root,
      "testnet",
      "rotate:guardian-set",
      receipt,
    );
    assert.equal(written.artifactPaths.length, 2);

    const receiptEnvelope = JSON.parse(
      fs.readFileSync(
        path.join(root, "artifacts", "testnet.rotate-guardian-set.json"),
        "utf8",
      ),
    );
    assert.deepEqual(receiptEnvelope.deployment.rotated, { from: 6, to: 7 });

    const canonicalEnvelope = JSON.parse(
      fs.readFileSync(
        path.join(root, "artifacts", "testnet.deploy-guardian-set.json"),
        "utf8",
      ),
    );
    assert.equal(canonicalEnvelope.action, "deploy:guardian-set");
    assert.deepEqual(canonicalEnvelope.deployment, canonicalState);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("official gs7 VAA produces an exact dry-run transition", async () => {
  const root = tempRoot();
  try {
    writeDeploymentArtifact(root, "testnet", "deploy:guardian-set-type", {
      scriptFamily: "guardian-set-type",
      versions: {
        2: {
          version: 2,
          mode: "broadcast",
          codeHash: guardianSetType.codeHash,
          hashType: guardianSetType.hashType,
          depType: guardianSetType.depType,
          txHash: guardianSetType.outPoint.txHash,
          index: guardianSetType.outPoint.index,
        },
      },
    });
    writeDeploymentArtifact(root, "testnet", "deploy:guardian-set", priorState);

    const result = await rotateGuardianSetStateCell({
      ctx: {
        network: "testnet",
        config: {
          network: "testnet",
          build: {},
          guardianSet: priorState.guardianSet,
        },
        env: {
          dryRun: "true",
          guardianUpgradeVaa: officialV7,
          guardianSetTypeIdArgs: "",
        },
        paths: { deploymentRoot: root },
      },
      cccClient: {
        findCellsByType: async function* () {
          yield {
            outPoint: {
              txHash: priorState.deployed.txHash,
              index: BigInt(priorState.deployed.index),
            },
            cellOutput: {
              capacity: BigInt(priorState.deployed.capacity),
              lock: ccc.Script.from(guardianSetLock.script),
              type: ccc.Script.from({
                codeHash: guardianSetType.codeHash,
                hashType: guardianSetType.hashType,
                args: priorState.deployed.typeIdArgs,
              }),
            },
            outputData: ccc.hexFrom(
              encodeGuardianSetDataBytes({
                setIndex: 6,
                quorum: 13,
                guardianAddresses: Array.from(
                  { length: 19 },
                  (_, index) => `0x${index.toString(16).padStart(40, "0")}`,
                ),
              }),
            ),
          };
        },
      },
    });
    assert.equal(result.mode, "dry-run");
    assert.deepEqual(result.governanceVaa, {
      signingSetIndex: 6,
      newIndex: 7,
    });
    assert.equal(result.nextSet.setIndex, 7);
    assert.equal(result.nextSet.quorum, 13);
    assert.equal(result.nextSet.guardianAddresses.length, 19);
    assert.equal(result.planned.currentOutPoint.txHash, priorState.deployed.txHash);
    assert.equal(result.planned.outputCapacity, 52_600_000_000n);
    assert.deepEqual(result.planned.lockCodeDep, {
      outPoint: guardianSetLock.outPoint,
      depType: guardianSetLock.depType,
    });
    assert.match(result.planned.unsignedTransition, /^0x[0-9a-f]+$/u);
    assert.equal(
      readCodeDeploymentArtifact({
        deploymentRoot: root,
        network: "testnet",
        scriptFamily: "guardian-set-type",
      }).deployment.versions[2].version,
      2,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rotation rejects non-hex VAA input before artifact or chain resolution", async () => {
  await assert.rejects(
    () =>
      rotateGuardianSetStateCell({
        ctx: {
          network: "testnet",
          config: { network: "testnet", build: {}, guardianSet: priorState.guardianSet },
          env: {
            dryRun: "true",
            guardianUpgradeVaa: "0xzz",
            guardianSetTypeIdArgs: `0x${"44".repeat(32)}`,
          },
          paths: { deploymentRoot: "/does/not/matter" },
        },
      }),
    /hex/u,
  );
});
