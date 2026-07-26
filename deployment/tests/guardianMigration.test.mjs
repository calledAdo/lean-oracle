import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ccc } from "@ckb-ccc/core";

import { writeDeploymentArtifact } from "../dist/artifacts.js";
import { loadLatestCanonicalCodeVersion } from "../dist/codeVersions.js";
import {
  assertGuardianSetCandidateReadback,
  buildGuardianSetCandidateTemplate,
} from "../dist/guardianSetDeploy.js";
import {
  assertChainBroadcastAuthorized,
  runDeploymentAction,
} from "../dist/deploy.js";
import { waitForCommittedTransaction } from "../dist/chainFinality.js";

const guardianCode = {
  version: 3,
  mode: "broadcast",
  codeHash: `0x${"11".repeat(32)}`,
  hashType: "data2",
  depType: "code",
  txHash: `0x${"12".repeat(32)}`,
  index: 0,
  promotedAt: "2026-07-26T00:00:00.000Z",
};
const bindLockCode = {
  version: 2,
  mode: "broadcast",
  codeHash: `0x${"21".repeat(32)}`,
  hashType: "data2",
  depType: "code",
  txHash: `0x${"22".repeat(32)}`,
  index: 0,
  promotedAt: "2026-07-26T00:00:00.000Z",
};
const deployerLock = ccc.Script.from({
  codeHash: `0x${"31".repeat(32)}`,
  hashType: "type",
  args: `0x${"32".repeat(20)}`,
});
const canonicalSet7 = {
  setIndex: 7,
  quorum: 13,
  guardianAddresses: Array.from(
    { length: 19 },
    (_, index) => `0x${index.toString(16).padStart(40, "0")}`,
  ),
};

test("latest code resolver selects guardian v3 and bind-lock v2", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-migration-"));
  try {
    writeDeploymentArtifact(root, "testnet", "deploy:guardian-set-type", {
      scriptFamily: "guardian-set-type",
      versions: { 2: { ...guardianCode, version: 2 }, 3: guardianCode },
    });
    writeDeploymentArtifact(root, "testnet", "deploy:owned-type-bind-lock", {
      scriptFamily: "owned-type-bind-lock",
      versions: { 1: { ...bindLockCode, version: 1 }, 2: bindLockCode },
    });

    assert.equal(
      loadLatestCanonicalCodeVersion({
        deploymentRoot: root,
        network: "testnet",
        scriptFamily: "guardian-set-type",
      }).version,
      3,
    );
    assert.equal(
      loadLatestCanonicalCodeVersion({
        deploymentRoot: root,
        network: "testnet",
        scriptFamily: "owned-type-bind-lock",
      }).version,
      2,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("candidate template separates identity v4 from guardian code v3", () => {
  const candidate = buildGuardianSetCandidateTemplate({
    identityVersion: 4,
    guardianCode,
    bindLockCode,
    deployerLock,
    guardianSet: canonicalSet7,
  });

  assert.equal(candidate.identityVersion, 4);
  assert.equal(candidate.guardianSetType.codeVersion, 3);
  assert.equal(candidate.guardianSetLock.codeVersion, 2);
  assert.equal(candidate.guardianSetLock.script.codeHash, bindLockCode.codeHash);
  assert.equal(
    candidate.guardianSetLock.script.args,
    ccc.hashCkb(deployerLock.toBytes()),
  );
  assert.equal(candidate.guardianSetData.length, 12 + 19 * 20);
});

test("candidate readback requires exact type, lock, data, and capacity", () => {
  const candidate = buildGuardianSetCandidateTemplate({
    identityVersion: 4,
    guardianCode,
    bindLockCode,
    deployerLock,
    guardianSet: canonicalSet7,
  });
  candidate.guardianSetType.script.args = `0x${"41".repeat(32)}`;
  const expected = {
    cellOutput: {
      capacity: 52_600_000_000n,
      lock: candidate.guardianSetLock.script,
      type: candidate.guardianSetType.script,
    },
    outputData: ccc.hexFrom(candidate.guardianSetData),
  };

  assert.doesNotThrow(() =>
    assertGuardianSetCandidateReadback({ expected, liveCell: expected }),
  );
  assert.throws(
    () =>
      assertGuardianSetCandidateReadback({
        expected,
        liveCell: {
          ...expected,
          cellOutput: {
            ...expected.cellOutput,
            lock: ccc.Script.from({
              codeHash: `0x${"ff".repeat(32)}`,
              hashType: "type",
              args: "0x",
            }),
          },
        },
      }),
    /readback.*lock/iu,
  );
});

test("candidate action is broadcast-gated and dry-runs without canonical promotion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-migration-"));
  try {
    writeDeploymentArtifact(root, "testnet", "deploy:guardian-set-type", {
      scriptFamily: "guardian-set-type",
      versions: { 3: guardianCode },
    });
    writeDeploymentArtifact(root, "testnet", "deploy:owned-type-bind-lock", {
      scriptFamily: "owned-type-bind-lock",
      versions: { 2: bindLockCode },
    });
    assert.throws(
      () =>
        assertChainBroadcastAuthorized({
          action: "deploy:guardian-set-candidate",
          env: { dryRun: "false", broadcast: "false" },
        }),
      /both DRY_RUN=false and BROADCAST=true/u,
    );

    const result = await runDeploymentAction({
      action: "deploy:guardian-set-candidate",
      network: "testnet",
      config: {
        network: "testnet",
        build: {},
        guardianSet: canonicalSet7,
        guardianSetIdentityVersion: 4,
        guardianSetLock: "owned-type-bind",
      },
      env: { dryRun: "true", broadcast: "false" },
      paths: { deploymentRoot: root },
    });
    assert.equal(result.kind, "deploy:guardian-set-candidate");
    assert.equal(result.identityVersion, 4);
    assert.equal(result.guardianSetType.codeVersion, 3);
    assert.equal(result.guardianSetLock.codeVersion, 2);
    assert.equal(result.mode, "dry-run");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("commitment waiter returns committed evidence and rejects chain rejection", async () => {
  const committed = await waitForCommittedTransaction(
    { getTransaction: async () => ({ status: "committed", blockNumber: 99n }) },
    `0x${"51".repeat(32)}`,
    { timeoutMs: 50, pollIntervalMs: 0, operation: "guardian candidate" },
  );
  assert.equal(committed.status, "committed");
  await assert.rejects(
    () =>
      waitForCommittedTransaction(
        { getTransaction: async () => ({ status: "rejected" }) },
        `0x${"52".repeat(32)}`,
        { timeoutMs: 50, pollIntervalMs: 0, operation: "guardian candidate" },
      ),
    /guardian candidate transaction .* was rejected/u,
  );
});
