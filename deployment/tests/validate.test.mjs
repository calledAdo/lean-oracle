import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateConfigPreflight } from "../dist/validate.js";

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lean-oracle-validate-test-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  return root;
}

function writeConfig(root, network, body) {
  fs.writeFileSync(
    path.join(root, "config", `${network}.json`),
    JSON.stringify(body, null, 2),
  );
}

function writeArtifact(root, network, filename, body) {
  fs.writeFileSync(
    path.join(root, "artifacts", `${network}.${filename}.json`),
    JSON.stringify(body, null, 2),
  );
}

const VALID_GUARDIAN_SET = {
  setIndex: 6,
  quorum: 2,
  guardianAddresses: ["0xa1", "0xa2", "0xa3"],
};

const VALID_BUILD = {
  oracleBinaryPath: "x/oracle",
  guardianSetBinaryPath: "x/gs",
  ownedTypeBindLockBinaryPath: "x/bl",
};

function fakeCodeArtifact(family, versions) {
  return {
    deployment: { scriptFamily: family, versions },
  };
}

test("rejects when target action is missing", () => {
  const root = makeRoot();
  try {
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: [],
      env: {},
    });
    assert.equal(exitCode, 2);
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("missing target action")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects an unknown target action", () => {
  const root = makeRoot();
  try {
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:nope", "--network", "devnet"],
      env: { DEVNET_CKB_RPC_URL: "x", DEVNET_DEPLOYER_PRIVATE_KEY: "x" },
    });
    assert.equal(exitCode, 1);
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("invalid target action")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects when network is missing on both CLI and env", () => {
  const root = makeRoot();
  try {
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:oracle-type"],
      env: {},
    });
    assert.equal(exitCode, 1);
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("missing network")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects when the per-network config file does not exist", () => {
  const root = makeRoot();
  try {
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:oracle-type", "--network", "devnet"],
      env: { DEVNET_CKB_RPC_URL: "x", DEVNET_DEPLOYER_PRIVATE_KEY: "x" },
    });
    assert.equal(exitCode, 1);
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("config file missing")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects when config.network does not match the selected network", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", { network: "testnet", build: VALID_BUILD });
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:oracle-type", "--network", "devnet"],
      env: { DEVNET_CKB_RPC_URL: "x", DEVNET_DEPLOYER_PRIVATE_KEY: "x" },
    });
    assert.equal(exitCode, 1);
    assert.ok(lines.some((l) => l.startsWith("FAIL") && l.includes("config network mismatch")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects when required <NETWORK>_CKB_RPC_URL is missing", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", { network: "devnet", build: VALID_BUILD });
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:oracle-type", "--network", "devnet"],
      env: { DEVNET_DEPLOYER_PRIVATE_KEY: "x" },
    });
    assert.equal(exitCode, 1);
    assert.ok(
      lines.some((l) => l.startsWith("FAIL") && l.includes("DEVNET_CKB_RPC_URL is required")),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deploy:guardian-set rejects a guardian set with non-unique addresses", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", {
      network: "devnet",
      build: VALID_BUILD,
      guardianSet: {
        setIndex: 1,
        quorum: 1,
        guardianAddresses: ["0xa1", "0xa1"],
      },
    });
    writeArtifact(
      root,
      "devnet",
      "guardian-set-type",
      fakeCodeArtifact("guardian-set-type", { 1: { codeHash: "0x1" } }),
    );
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:guardian-set", "--network", "devnet"],
      env: { DEVNET_CKB_RPC_URL: "x", DEVNET_DEPLOYER_PRIVATE_KEY: "x" },
    });
    assert.equal(exitCode, 1);
    assert.ok(
      lines.some(
        (l) =>
          l.startsWith("FAIL") &&
          l.includes("guardianSet.guardianAddresses must be unique"),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deploy:guardian-set rejects when quorum > guardian count", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", {
      network: "devnet",
      build: VALID_BUILD,
      guardianSet: {
        setIndex: 1,
        quorum: 5,
        guardianAddresses: ["0xa1", "0xa2"],
      },
    });
    writeArtifact(
      root,
      "devnet",
      "guardian-set-type",
      fakeCodeArtifact("guardian-set-type", { 1: { codeHash: "0x1" } }),
    );
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:guardian-set", "--network", "devnet"],
      env: { DEVNET_CKB_RPC_URL: "x", DEVNET_DEPLOYER_PRIVATE_KEY: "x" },
    });
    assert.equal(exitCode, 1);
    assert.ok(
      lines.some(
        (l) => l.startsWith("FAIL") && l.includes("quorum cannot exceed guardianAddresses"),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deploy:oracle rejects an ORACLE_FEED_ID with the wrong byte length", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", { network: "devnet", build: VALID_BUILD });
    writeArtifact(
      root,
      "devnet",
      "oracle-type",
      fakeCodeArtifact("oracle-type", { 1: { codeHash: "0x1" } }),
    );
    writeArtifact(
      root,
      "devnet",
      "owned-type-bind-lock",
      fakeCodeArtifact("owned-type-bind-lock", { 1: { codeHash: "0x1" } }),
    );
    writeArtifact(root, "devnet", "deploy-guardian-set", {
      deployment: {
        deployed: { txHash: "0xaa", index: 0, typeIdArgs: "0xbb" },
      },
    });
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:oracle", "--network", "devnet"],
      env: {
        DEVNET_CKB_RPC_URL: "x",
        DEVNET_DEPLOYER_PRIVATE_KEY: "x",
        ORACLE_FEED_ID: "0xdeadbeef",
        ORACLE_EMITTER_CHAIN: "26",
        ORACLE_EMITTER_ADDRESS: `0x${"00".repeat(32)}`,
      },
    });
    assert.equal(exitCode, 1);
    assert.ok(
      lines.some(
        (l) => l.startsWith("FAIL") && l.includes("ORACLE_FEED_ID must be 32 bytes"),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deploy:oracle rejects ORACLE_EMITTER_CHAIN that is not a u32", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", { network: "devnet", build: VALID_BUILD });
    writeArtifact(
      root,
      "devnet",
      "oracle-type",
      fakeCodeArtifact("oracle-type", { 1: { codeHash: "0x1" } }),
    );
    writeArtifact(
      root,
      "devnet",
      "owned-type-bind-lock",
      fakeCodeArtifact("owned-type-bind-lock", { 1: { codeHash: "0x1" } }),
    );
    writeArtifact(root, "devnet", "deploy-guardian-set", {
      deployment: {
        deployed: { txHash: "0xaa", index: 0, typeIdArgs: "0xbb" },
      },
    });
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:oracle", "--network", "devnet"],
      env: {
        DEVNET_CKB_RPC_URL: "x",
        DEVNET_DEPLOYER_PRIVATE_KEY: "x",
        ORACLE_FEED_ID: `0x${"ab".repeat(32)}`,
        ORACLE_EMITTER_CHAIN: "not-a-number",
        ORACLE_EMITTER_ADDRESS: `0x${"00".repeat(32)}`,
      },
    });
    assert.equal(exitCode, 1);
    assert.ok(
      lines.some(
        (l) =>
          l.startsWith("FAIL") && l.includes("ORACLE_EMITTER_CHAIN must be a u32 integer"),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deploy:oracle reports a missing canonical version in oracle-type artifact", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", { network: "devnet", build: VALID_BUILD });
    writeArtifact(root, "devnet", "oracle-type", fakeCodeArtifact("oracle-type", {}));
    writeArtifact(
      root,
      "devnet",
      "owned-type-bind-lock",
      fakeCodeArtifact("owned-type-bind-lock", { 1: { codeHash: "0x1" } }),
    );
    writeArtifact(root, "devnet", "deploy-guardian-set", {
      deployment: {
        deployed: { txHash: "0xaa", index: 0, typeIdArgs: "0xbb" },
      },
    });
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:oracle", "--network", "devnet"],
      env: {
        DEVNET_CKB_RPC_URL: "x",
        DEVNET_DEPLOYER_PRIVATE_KEY: "x",
        ORACLE_FEED_ID: `0x${"ab".repeat(32)}`,
        ORACLE_EMITTER_CHAIN: "26",
        ORACLE_EMITTER_ADDRESS: `0x${"00".repeat(32)}`,
      },
    });
    assert.equal(exitCode, 1);
    assert.ok(
      lines.some(
        (l) =>
          l.startsWith("FAIL") &&
          l.includes("no canonical version present in devnet.oracle-type.json"),
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deploy:oracle passes preflight when every required input is present and DRY_RUN=true", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", { network: "devnet", build: VALID_BUILD });
    writeArtifact(
      root,
      "devnet",
      "oracle-type",
      fakeCodeArtifact("oracle-type", { 1: { codeHash: "0x1" } }),
    );
    writeArtifact(
      root,
      "devnet",
      "owned-type-bind-lock",
      fakeCodeArtifact("owned-type-bind-lock", { 1: { codeHash: "0x1" } }),
    );
    writeArtifact(root, "devnet", "deploy-guardian-set", {
      deployment: {
        deployed: { txHash: "0xaa", index: 0, typeIdArgs: "0xbb" },
      },
    });
    const { exitCode, lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:oracle", "--network", "devnet"],
      env: {
        DEVNET_CKB_RPC_URL: "x",
        DEVNET_DEPLOYER_PRIVATE_KEY: "x",
        DRY_RUN: "true",
        ORACLE_FEED_ID: `0x${"ab".repeat(32)}`,
        ORACLE_EMITTER_CHAIN: "26",
        ORACLE_EMITTER_ADDRESS: `0x${"00".repeat(32)}`,
      },
    });
    assert.equal(
      exitCode,
      0,
      `expected pass but saw FAIL lines:\n${lines.filter((l) => l.startsWith("FAIL")).join("\n")}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI --network overrides env DEPLOY_NETWORK", () => {
  const root = makeRoot();
  try {
    writeConfig(root, "devnet", { network: "devnet", build: VALID_BUILD });
    writeConfig(root, "testnet", { network: "testnet", build: VALID_BUILD });
    const { lines } = validateConfigPreflight({
      deploymentRoot: root,
      argv: ["deploy:oracle-type", "--network", "devnet"],
      env: {
        DEPLOY_NETWORK: "testnet",
        DEVNET_CKB_RPC_URL: "x",
        DEVNET_DEPLOYER_PRIVATE_KEY: "x",
      },
    });
    assert.ok(lines.some((l) => l.startsWith("OK") && l.includes("network: devnet")));
    assert.ok(!lines.some((l) => l.includes("network: testnet")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
