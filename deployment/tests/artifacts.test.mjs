import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  codeArtifactPath,
  readCodeDeploymentArtifact,
  writeDeploymentArtifact,
} from "../dist/artifacts.js";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lean-oracle-deployment-test-"));
}

test("codeArtifactPath composes the expected path", () => {
  const p = codeArtifactPath("/x", "devnet", "oracle-type");
  assert.equal(p, path.join("/x", "artifacts", "devnet.oracle-type.json"));
});

test("readCodeDeploymentArtifact returns null when the file is missing", () => {
  const root = tempRoot();
  try {
    const got = readCodeDeploymentArtifact({
      deploymentRoot: root,
      network: "devnet",
      scriptFamily: "oracle-type",
    });
    assert.equal(got, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("readCodeDeploymentArtifact parses an existing envelope", () => {
  const root = tempRoot();
  try {
    const payload = {
      scriptFamily: "oracle-type",
      versions: { 1: { codeHash: "0xaa" } },
    };
    writeDeploymentArtifact(root, "devnet", "deploy:oracle-type", payload);

    const got = readCodeDeploymentArtifact({
      deploymentRoot: root,
      network: "devnet",
      scriptFamily: "oracle-type",
    });
    assert.ok(got, "expected envelope");
    assert.equal(got.network, "devnet");
    assert.equal(got.action, "deploy:oracle-type");
    assert.equal(got.deployment.scriptFamily, "oracle-type");
    assert.deepEqual(got.deployment.versions, { 1: { codeHash: "0xaa" } });
    assert.ok(typeof got.generatedAt === "string");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeDeploymentArtifact preserves prior versions when caller emits an empty versions map", () => {
  // This is the merge contract the deploy pipeline relies on: `deploy:oracle-type`
  // emits `{ versions: {} }` and only sets `latestCandidate`; the existing
  // canonical `versions` table must survive that write so subsequent reads
  // still resolve a code-dep.
  const root = tempRoot();
  try {
    const initial = {
      scriptFamily: "oracle-type",
      latestCandidate: undefined,
      versions: {
        1: { codeHash: "0x1111", txHash: "0xaa", index: 0, version: 1 },
      },
    };
    writeDeploymentArtifact(root, "devnet", "deploy:oracle-type", initial);

    const candidateOnly = {
      scriptFamily: "oracle-type",
      latestCandidate: { codeHash: "0x2222", txHash: "0xbb", index: 0 },
      versions: {},
    };
    writeDeploymentArtifact(root, "devnet", "deploy:oracle-type", candidateOnly);

    const merged = readCodeDeploymentArtifact({
      deploymentRoot: root,
      network: "devnet",
      scriptFamily: "oracle-type",
    });
    assert.ok(merged);
    assert.equal(merged.deployment.latestCandidate.codeHash, "0x2222");
    assert.deepEqual(merged.deployment.versions, initial.versions);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeDeploymentArtifact replaces versions when the caller provides a non-empty map", () => {
  // The promote step emits a non-empty `versions` map that supersedes the
  // existing one. The merge logic must NOT preserve the older map in this case.
  const root = tempRoot();
  try {
    writeDeploymentArtifact(root, "devnet", "deploy:oracle-type", {
      scriptFamily: "oracle-type",
      versions: { 1: { codeHash: "0x1111" } },
    });
    writeDeploymentArtifact(root, "devnet", "promote:oracle-type", {
      scriptFamily: "oracle-type",
      versions: {
        1: { codeHash: "0x1111" },
        2: { codeHash: "0x2222" },
      },
    });

    const got = readCodeDeploymentArtifact({
      deploymentRoot: root,
      network: "devnet",
      scriptFamily: "oracle-type",
    });
    assert.ok(got);
    assert.deepEqual(Object.keys(got.deployment.versions).sort(), ["1", "2"]);
    assert.equal(got.deployment.versions["2"].codeHash, "0x2222");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeDeploymentArtifact uses action-derived filename for non-code artifacts", () => {
  // State-cell artifacts (`deploy:oracle`, `deploy:guardian-set`) are not
  // CodeDeploymentArtifacts and must be filed by action name, not scriptFamily.
  const root = tempRoot();
  try {
    const stateDeployment = {
      kind: "deploy:oracle",
      deployed: { txHash: "0xcc", index: 0 },
    };
    const { artifactPath } = writeDeploymentArtifact(
      root,
      "devnet",
      "deploy:oracle",
      stateDeployment,
    );
    assert.equal(
      path.basename(artifactPath),
      "devnet.deploy-oracle.json",
      "non-code artifact must be named by action",
    );
    assert.ok(fs.existsSync(artifactPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeDeploymentArtifact serializes BigInt values as strings", () => {
  // Several deploy paths carry shannons / index as BigInt; the writer's
  // replacer must coerce them rather than crash on JSON.stringify.
  const root = tempRoot();
  try {
    const { artifactPath } = writeDeploymentArtifact(
      root,
      "devnet",
      "deploy:oracle-type",
      {
        scriptFamily: "oracle-type",
        latestCandidate: {
          codeHash: "0xaa",
          capacity: 12_345_678_901n,
          index: 7n,
        },
        versions: {},
      },
    );
    const raw = fs.readFileSync(artifactPath, "utf8");
    assert.ok(raw.includes('"capacity": "12345678901"'));
    assert.ok(raw.includes('"index": "7"'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
