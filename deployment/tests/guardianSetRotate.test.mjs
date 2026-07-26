import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readCodeDeploymentArtifact,
  writeDeploymentActionArtifacts,
  writeDeploymentArtifact,
} from "../dist/artifacts.js";
import { rotateGuardianSetStateCell } from "../dist/guardianSetRotate.js";

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
const priorState = {
  kind: "deploy:guardian-set",
  mode: "broadcast",
  network: "testnet",
  guardianSetType,
  guardianSet: { setIndex: 6, quorum: 13, guardianAddresses: [] },
  deployed: {
    txHash: `0x${"33".repeat(32)}`,
    index: 0,
    typeIdArgs: `0x${"44".repeat(32)}`,
    capacity: "52600000000",
  },
};

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
    });
    assert.equal(result.mode, "dry-run");
    assert.deepEqual(result.governanceVaa, {
      signingSetIndex: 6,
      newIndex: 7,
    });
    assert.equal(result.nextSet.setIndex, 7);
    assert.equal(result.nextSet.quorum, 13);
    assert.equal(result.nextSet.guardianAddresses.length, 19);
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
