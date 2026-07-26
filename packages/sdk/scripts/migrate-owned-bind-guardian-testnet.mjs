import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ccc } from "@ckb-ccc/core";

import {
  buildOracleOutputFromHermesUpdate,
  decodeGuardianSetCellDataHex,
  decodeLeanOracleCellDataHex,
} from "../dist/ckb/index.js";
import { rebalanceFuel } from "../dist/fuel/index.js";
import { fetchHermesLatestPriceUpdates } from "../dist/hermes/index.js";
import { leanOracleTestnetPreset } from "../dist/presets/index.js";
import {
  initiateOracleBurnTx,
  initiateOracleDeployTx,
  initiateOracleUpdateTx,
} from "../dist/tx/index.js";
import {
  writeDeploymentActionArtifacts,
} from "../../../deployment/dist/artifacts.js";
import { waitForCommittedTransaction } from "../../../deployment/dist/chainFinality.js";
import {
  createCccClient,
  createPrivateKeySigner,
} from "../../../deployment/dist/ccc.js";
import {
  assertGuardianSetCandidateReadback,
  encodeGuardianSetDataBytes,
} from "../../../deployment/dist/guardianSetDeploy.js";
import {
  buildGuardianMigrationPromotion,
  nextGuardianMigrationPhase,
} from "../../../deployment/dist/guardianMigration.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const DEPLOYMENT_ROOT = path.join(REPO_ROOT, "deployment");
const ARTIFACTS_DIR = path.join(DEPLOYMENT_ROOT, "artifacts");
const CANDIDATE_PATH = path.join(
  ARTIFACTS_DIR,
  "testnet.deploy-guardian-set-candidate.json",
);
const GUARDIAN_PATH = path.join(
  ARTIFACTS_DIR,
  "testnet.deploy-guardian-set.json",
);
const ORACLE_PATH = path.join(ARTIFACTS_DIR, "testnet.deploy-oracle.json");
const TESTNET_CONFIG_PATH = path.join(
  DEPLOYMENT_ROOT,
  "config",
  "testnet.json",
);
const RECEIPT_PATH = path.join(
  ARTIFACTS_DIR,
  "testnet.migrate-owned-bind-guardian.json",
);
const PROGRESS_PATH = path.join(
  ARTIFACTS_DIR,
  "testnet.owned-bind-guardian-migration.progress.json",
);

const FEED_ID =
  process.env.ORACLE_FEED_ID ??
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const RPC_URL =
  process.env.TESTNET_CKB_RPC_URL ?? leanOracleTestnetPreset.ckbJsonRpcUrl;
const DRY_RUN = process.env.DRY_RUN !== "false";
const BROADCAST = process.env.BROADCAST === "true";
const CONFIRM_BURN = process.env.GUARDIAN_MIGRATION_CONFIRM_BURN === "true";

function stringify(value) {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function readArtifact(file, label) {
  if (!fs.existsSync(file)) throw new Error(`Missing ${label} artifact: ${file}`);
  const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!envelope?.deployment || typeof envelope.deployment !== "object") {
    throw new Error(`${label} artifact has no deployment payload: ${file}`);
  }
  return envelope.deployment;
}

function outPoint(value) {
  return { txHash: value.txHash, index: BigInt(value.index) };
}

function serialOutPoint(value) {
  return { txHash: value.txHash, index: Number(value.index) };
}

function scriptsEqual(left, right) {
  return ccc.Script.from(left).eq(ccc.Script.from(right));
}

function writeProgress(progress) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const temp = `${PROGRESS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${stringify(progress)}\n`, { mode: 0o600 });
  fs.renameSync(temp, PROGRESS_PATH);
}

function readProgress() {
  if (fs.existsSync(RECEIPT_PATH)) {
    return {
      guardianVerified: true,
      stagingCreated: {},
      stagingOracle: {},
      oldOracleBurn: {},
      finalPublicOracle: {},
      promoted: true,
    };
  }
  if (!fs.existsSync(PROGRESS_PATH)) return {};
  return JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8"));
}

function candidateNetwork(candidate) {
  return {
    ...leanOracleTestnetPreset,
    ckbJsonRpcUrl: RPC_URL,
    deployment: {
      ...leanOracleTestnetPreset.deployment,
      guardianSetType: {
        codeHash: candidate.guardianSetType.codeHash,
        hashType: candidate.guardianSetType.hashType,
        args: candidate.guardianSetType.args,
        identityVersion: candidate.identityVersion,
        codeVersion: candidate.guardianSetType.codeVersion,
        codeDep: {
          outPoint: outPoint(candidate.guardianSetType.outPoint),
          depType: candidate.guardianSetType.depType,
        },
      },
      guardianSetLock: {
        script: candidate.guardianSetLock.script,
        codeDep: {
          outPoint: outPoint(candidate.guardianSetLock.outPoint),
          depType: candidate.guardianSetLock.depType,
        },
      },
    },
  };
}

function oracleTypeScript(network) {
  return ccc.Script.from({
    codeHash: network.deployment.oracleType.codeHash,
    hashType: network.deployment.oracleType.hashType,
    args: FEED_ID,
  });
}

async function findOracleCellsForLock(client, network, lock) {
  const found = [];
  for await (const cell of client.findCells(
    {
      script: ccc.Script.from(lock),
      scriptType: "lock",
      scriptSearchMode: "exact",
      filter: { script: oracleTypeScript(network) },
      withData: true,
    },
    "desc",
    256,
  )) {
    const live = await client.getCellLive(cell.outPoint, true, true);
    if (live) found.push(live);
  }
  return found;
}

function candidateOracleCells(cells, candidateHash) {
  return cells.filter((cell) => {
    const decoded = decodeLeanOracleCellDataHex(cell.outputData);
    return decoded.guardianSetTypeHash === candidateHash;
  });
}

async function assertCodeDep(client, record, label) {
  const live = await client.getCellLive(outPoint(record.outPoint), true, true);
  if (!live) throw new Error(`${label} code dependency is not live`);
  const actualHash = ccc.hashCkb(ccc.hexFrom(live.outputData));
  if (actualHash !== record.codeHash) {
    throw new Error(`${label} code dependency data hash mismatch`);
  }
}

async function verifyCandidate(client, candidate, deployerLock) {
  if (
    candidate.mode !== "broadcast" ||
    candidate.identityVersion !== 4 ||
    candidate.guardianSetType.codeVersion !== 3
  ) {
    throw new Error("Guardian candidate is not broadcast identity v4/code v3");
  }
  const expectedOwnerHash = ccc.hashCkb(deployerLock.toBytes());
  if (candidate.guardianSetLock.script.args !== expectedOwnerHash) {
    throw new Error("Guardian candidate bind-lock owner does not match deployer lock");
  }
  const publicLock = ccc.Script.from(
    leanOracleTestnetPreset.deployment.defaultPublicOracleLock.script,
  );
  if (publicLock.args !== expectedOwnerHash) {
    throw new Error("Public oracle bind-lock owner does not match deployer lock");
  }

  const type = ccc.Script.from({
    codeHash: candidate.guardianSetType.codeHash,
    hashType: candidate.guardianSetType.hashType,
    args: candidate.guardianSetType.args,
  });
  if (candidate.deployed.typeIdArgs !== type.args) {
    throw new Error("Guardian candidate Type ID args disagree with its type script");
  }
  const fullTypeHash = ccc.hashCkb(type.toBytes());
  if (candidate.fullTypeHash !== fullTypeHash) {
    throw new Error("Guardian candidate full type hash mismatch");
  }

  const matching = [];
  for await (const cell of client.findCellsByType(type, true)) matching.push(cell);
  if (matching.length !== 1) {
    throw new Error(`Guardian candidate type resolves to ${matching.length} live cells`);
  }
  const live = matching[0];
  if (
    live.outPoint.txHash !== candidate.deployed.txHash ||
    live.outPoint.index !== BigInt(candidate.deployed.index)
  ) {
    throw new Error("Guardian candidate artifact outpoint is not the unique live cell");
  }
  assertGuardianSetCandidateReadback({
    expected: {
      cellOutput: {
        capacity: BigInt(candidate.deployed.capacity),
        lock: ccc.Script.from(candidate.guardianSetLock.script),
        type,
      },
      outputData: ccc.hexFrom(
        encodeGuardianSetDataBytes(candidate.guardianSet),
      ),
    },
    liveCell: live,
  });
  const decoded = decodeGuardianSetCellDataHex(live.outputData);
  const expectedGuardianSet = JSON.parse(
    fs.readFileSync(TESTNET_CONFIG_PATH, "utf8"),
  ).guardianSet;
  if (
    decoded.setIndex !== 7 ||
    decoded.quorum !== 13 ||
    decoded.guardianAddresses.length !== 19 ||
    stringify(decoded.guardianAddresses.map((address) => address.toLowerCase())) !==
      stringify(
        expectedGuardianSet.guardianAddresses.map((address) =>
          address.toLowerCase(),
        ),
      )
  ) {
    throw new Error("Guardian candidate is not canonical Wormhole set 7");
  }
  await assertCodeDep(client, candidate.guardianSetType, "guardian v3");
  await assertCodeDep(client, candidate.guardianSetLock, "bind-lock v2");
  return live;
}

async function requireOneOracle(cells, label) {
  if (cells.length !== 1) {
    throw new Error(`${label} expected exactly one live cell, found ${cells.length}`);
  }
  return cells[0];
}

function oracleEvidence(cell) {
  const decoded = decodeLeanOracleCellDataHex(cell.outputData);
  return {
    outPoint: serialOutPoint(cell.outPoint),
    guardianSetTypeHash: decoded.guardianSetTypeHash,
    publishTimeUnix: decoded.publishTimeUnix.toString(),
  };
}

async function sendAndReadOutput(params) {
  const rebalanced = await rebalanceFuel(params.tx, {
    cccClient: params.client,
    lockScript: params.deployerLock,
  });
  if (rebalanced.status !== "ok") {
    throw new Error(
      `${params.operation} needs ${rebalanced.extraCapacityNeededShannons.toString()} more shannons`,
    );
  }
  const txHash = await params.signer.sendTransaction(rebalanced.mutated);
  const committed = await waitForCommittedTransaction(params.client, txHash, {
    operation: params.operation,
  });
  const cell = await params.client.getCellLive({ txHash, index: 0n }, true, true);
  if (!cell) {
    throw new Error(`${params.operation} committed without a live output at index 0`);
  }
  return { txHash, committed, cell };
}

async function fetchFreshHermes(network, inputOracle, minimumPublishTime = -1n) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const hermesEnvelope = await fetchHermesLatestPriceUpdates(
      network,
      [FEED_ID],
      { encoding: "hex" },
    );
    const decoded = buildOracleOutputFromHermesUpdate({
      inputOracle,
      hermesEnvelope,
      feedId: FEED_ID,
      outputSource: "binary",
    });
    if (decoded.publishTimeUnix > minimumPublishTime) return hermesEnvelope;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("Hermes did not provide a strictly newer BTC update within 180 seconds");
}

async function verifyInitialState(client, deployerLock) {
  const candidate = readArtifact(CANDIDATE_PATH, "guardian candidate");
  const oldGuardianState = readArtifact(GUARDIAN_PATH, "canonical guardian");
  const oracleTemplate = readArtifact(ORACLE_PATH, "canonical oracle");
  await verifyCandidate(client, candidate, deployerLock);

  const oldGuardian = await client.getCellLive(
    outPoint(oldGuardianState.deployed),
    true,
    true,
  );
  if (!oldGuardian) throw new Error("Legacy guardian singleton is not live");

  const publicLock = ccc.Script.from(
    leanOracleTestnetPreset.deployment.defaultPublicOracleLock.script,
  );
  const oldPublic = await requireOneOracle(
    await findOracleCellsForLock(client, leanOracleTestnetPreset, publicLock),
    "old public oracle",
  );
  const oldDecoded = decodeLeanOracleCellDataHex(oldPublic.outputData);
  if (
    oldDecoded.guardianSetTypeHash !==
    oracleTemplate.guardianSet.guardianSetTypeHash
  ) {
    throw new Error("Old public oracle does not reference the canonical legacy guardian");
  }

  return {
    schemaVersion: 1,
    network: "testnet",
    guardianVerified: true,
    guardianCandidate: candidate,
    oldGuardianState,
    oracleTemplate: {
      ...oracleTemplate,
      deployed: serialOutPoint(oldPublic.outPoint),
    },
    oldPublicOracle: {
      ...oracleEvidence(oldPublic),
      capacity: oldPublic.cellOutput.capacity.toString(),
      lockHash: ccc.hashCkb(publicLock.toBytes()),
    },
  };
}

async function createStaging(params) {
  const existing = candidateOracleCells(
    await findOracleCellsForLock(
      params.client,
      params.network,
      params.deployerLock,
    ),
    params.progress.guardianCandidate.fullTypeHash,
  );
  if (existing.length > 1) {
    throw new Error("Multiple candidate-backed staging oracle cells exist");
  }
  if (existing.length === 1) return oracleEvidence(existing[0]);

  const tx = await initiateOracleDeployTx({
    network: params.network,
    cccClient: params.client,
    feedId: FEED_ID,
    oracleLockScript: params.deployerLock,
    capacity: BigInt(params.progress.oldPublicOracle.capacity),
    guardianSetTypeHash: params.progress.guardianCandidate.fullTypeHash,
  });
  const { cell } = await sendAndReadOutput({ ...params, tx, operation: "staging oracle creation" });
  if (!scriptsEqual(cell.cellOutput.lock, params.deployerLock)) {
    throw new Error("Staging oracle creation lock readback mismatch");
  }
  const decoded = decodeLeanOracleCellDataHex(cell.outputData);
  if (
    decoded.guardianSetTypeHash !== params.progress.guardianCandidate.fullTypeHash ||
    decoded.publishTimeUnix !== 0n
  ) {
    throw new Error("Staging oracle creation data readback mismatch");
  }
  return oracleEvidence(cell);
}

async function authenticateStaging(params) {
  let inputCell = await params.client.getCellLive(
    outPoint(params.progress.stagingCreated.outPoint),
    true,
    true,
  );
  if (!inputCell) {
    const recovered = candidateOracleCells(
      await findOracleCellsForLock(
        params.client,
        params.network,
        params.deployerLock,
      ),
      params.progress.guardianCandidate.fullTypeHash,
    );
    inputCell = await requireOneOracle(recovered, "authenticated staging recovery");
    const evidence = oracleEvidence(inputCell);
    if (BigInt(evidence.publishTimeUnix) <= 0n) {
      throw new Error("Recovered staging oracle is not authenticated");
    }
    return evidence;
  }

  const before = decodeLeanOracleCellDataHex(inputCell.outputData);
  const hermesEnvelope = await fetchFreshHermes(params.network, before);
  const tx = await initiateOracleUpdateTx({
    network: params.network,
    cccClient: params.client,
    feedId: FEED_ID,
    oracleOutPoint: inputCell.outPoint,
    hermesEnvelope,
    outputSource: "binary",
  });
  const { cell } = await sendAndReadOutput({
    ...params,
    tx,
    operation: "staging oracle authentication",
  });
  if (!scriptsEqual(cell.cellOutput.lock, params.deployerLock)) {
    throw new Error("Authenticated staging oracle lock readback mismatch");
  }
  const evidence = oracleEvidence(cell);
  if (
    evidence.guardianSetTypeHash !== params.progress.guardianCandidate.fullTypeHash ||
    BigInt(evidence.publishTimeUnix) <= 0n
  ) {
    throw new Error("Staging oracle authentication readback failed");
  }
  return evidence;
}

async function burnOldPublic(params) {
  const oldOutPoint = outPoint(params.progress.oldPublicOracle.outPoint);
  const oldLive = await params.client.getCellLive(oldOutPoint, true, true);
  if (!oldLive) {
    const successors = await findOracleCellsForLock(
      params.client,
      params.network,
      params.network.deployment.defaultPublicOracleLock.script,
    );
    if (successors.length !== 0) {
      throw new Error(
        "Recorded old public oracle is dead but a public successor remains live",
      );
    }
    return {
      outPoint: serialOutPoint(oldOutPoint),
      live: false,
      txHash: "recovered-after-commit",
    };
  }
  const tx = await initiateOracleBurnTx({
    network: leanOracleTestnetPreset,
    cccClient: params.client,
    feedId: FEED_ID,
    oracleOutPoint: oldOutPoint,
  });
  const rebalanced = await rebalanceFuel(tx, {
    cccClient: params.client,
    lockScript: params.deployerLock,
  });
  if (rebalanced.status !== "ok") {
    throw new Error(
      `old oracle burn needs ${rebalanced.extraCapacityNeededShannons.toString()} more shannons`,
    );
  }
  if (rebalanced.fuelInputsAdded < 1) {
    throw new Error("Old oracle owner-escape burn has no deployer-locked input");
  }
  const txHash = await params.signer.sendTransaction(rebalanced.mutated);
  await waitForCommittedTransaction(params.client, txHash, {
    operation: "old public oracle burn",
  });
  if (await params.client.getCellLive(oldOutPoint, true, true)) {
    throw new Error("Old public oracle is still live after committed burn");
  }
  const successors = await findOracleCellsForLock(
    params.client,
    params.network,
    params.network.deployment.defaultPublicOracleLock.script,
  );
  if (successors.length !== 0) {
    throw new Error("A legacy public oracle successor remains live after burn");
  }
  return { outPoint: serialOutPoint(oldOutPoint), live: false, txHash };
}

async function migratePublic(params) {
  const publicLock = ccc.Script.from(
    params.network.deployment.defaultPublicOracleLock.script,
  );
  const publicCells = await findOracleCellsForLock(
    params.client,
    params.network,
    publicLock,
  );
  const existing = candidateOracleCells(
    publicCells,
    params.progress.guardianCandidate.fullTypeHash,
  );
  if (existing.length !== publicCells.length) {
    throw new Error("A legacy public oracle remains live after the burn checkpoint");
  }
  if (existing.length > 1) {
    throw new Error("Multiple candidate-backed public oracle cells exist");
  }
  if (existing.length === 1) {
    const evidence = {
      ...oracleEvidence(existing[0]),
      lockHash: ccc.hashCkb(publicLock.toBytes()),
    };
    if (
      BigInt(evidence.publishTimeUnix) <=
      BigInt(params.progress.stagingOracle.publishTimeUnix)
    ) {
      throw new Error("Recovered public oracle is not newer than staging evidence");
    }
    return evidence;
  }

  const stagingOutPoint = outPoint(params.progress.stagingOracle.outPoint);
  const inputCell = await params.client.getCellLive(stagingOutPoint, true, true);
  if (!inputCell) {
    throw new Error("Authenticated staging oracle is dead and no public successor exists");
  }
  const before = decodeLeanOracleCellDataHex(inputCell.outputData);
  const hermesEnvelope = await fetchFreshHermes(
    params.network,
    before,
    BigInt(params.progress.stagingOracle.publishTimeUnix),
  );
  const tx = await initiateOracleUpdateTx({
    network: params.network,
    cccClient: params.client,
    feedId: FEED_ID,
    oracleOutPoint: stagingOutPoint,
    outputLockScript: publicLock,
    hermesEnvelope,
    outputSource: "binary",
  });
  const { cell } = await sendAndReadOutput({
    ...params,
    tx,
    operation: "public oracle lock migration",
  });
  if (!scriptsEqual(cell.cellOutput.lock, publicLock)) {
    throw new Error("Public oracle migration lock readback mismatch");
  }
  const evidence = {
    ...oracleEvidence(cell),
    lockHash: ccc.hashCkb(publicLock.toBytes()),
  };
  if (BigInt(evidence.publishTimeUnix) <= BigInt(params.progress.stagingOracle.publishTimeUnix)) {
    throw new Error("Public oracle migration is not newer than staging evidence");
  }
  return evidence;
}

async function main() {
  if (!DRY_RUN && !BROADCAST) {
    throw new Error("Broadcast migration requires both DRY_RUN=false and BROADCAST=true");
  }
  if (fs.existsSync(RECEIPT_PATH)) {
    const receipt = readArtifact(RECEIPT_PATH, "guardian migration receipt");
    if (receipt.mode !== "broadcast" || receipt.phase !== "promoted") {
      throw new Error("Guardian migration receipt is not a completed promotion");
    }
    console.log(
      stringify({
        mode: DRY_RUN ? "dry-run" : "broadcast",
        phase: "complete",
        receipt: RECEIPT_PATH,
        sendsTransactions: false,
        writesArtifacts: false,
      }),
    );
    return;
  }
  if (!fs.existsSync(CANDIDATE_PATH)) {
    const result = {
      mode: DRY_RUN ? "dry-run" : "broadcast",
      nextPhase: "deploy-guardian-candidate",
      candidateArtifact: CANDIDATE_PATH,
    };
    if (DRY_RUN) {
      console.log(stringify(result));
      return;
    }
    throw new Error(`Deploy and verify the guardian candidate first: ${CANDIDATE_PATH}`);
  }

  const privateKey = process.env.TESTNET_DEPLOYER_PRIVATE_KEY;
  if (!DRY_RUN && !privateKey) {
    throw new Error("TESTNET_DEPLOYER_PRIVATE_KEY is required for broadcast migration");
  }
  const client = createCccClient("testnet", RPC_URL);
  const signer = privateKey ? createPrivateKeySigner(client, privateKey) : undefined;
  const deployerLock = signer
    ? (await signer.getRecommendedAddressObj()).script
    : undefined;
  if (!deployerLock) {
    throw new Error("TESTNET_DEPLOYER_PRIVATE_KEY is required to verify owner-lock continuity");
  }

  if (DRY_RUN) {
    const verified = await verifyInitialState(client, deployerLock);
    console.log(
      stringify({
        mode: "dry-run",
        nextPhase: "create-staging",
        candidateGuardian: verified.guardianCandidate.deployed,
        legacyGuardian: verified.oldGuardianState.deployed,
        currentPublicOracle: verified.oldPublicOracle.outPoint,
        sendsTransactions: false,
        writesArtifacts: false,
      }),
    );
    return;
  }

  while (true) {
    const progress = readProgress();
    const phase = nextGuardianMigrationPhase(progress);
    if (phase === "complete") {
      console.log(stringify({ mode: "broadcast", phase, receipt: RECEIPT_PATH }));
      return;
    }
    if (phase === "verify-guardian") {
      writeProgress(await verifyInitialState(client, deployerLock));
      continue;
    }

    const network = candidateNetwork(progress.guardianCandidate);
    const common = { client, signer, deployerLock, network, progress };
    if (phase === "create-staging") {
      writeProgress({
        ...progress,
        stagingCreated: await createStaging(common),
      });
      continue;
    }
    if (phase === "authenticate-staging") {
      writeProgress({
        ...progress,
        stagingOracle: await authenticateStaging(common),
      });
      continue;
    }
    if (phase === "burn-old-oracle" && !CONFIRM_BURN) {
      console.log(
        stringify({
          mode: "broadcast",
          phase: "staging-authenticated",
          stagingOracle: progress.stagingOracle,
          oldPublicOracle: progress.oldPublicOracle.outPoint,
          nextPhase: phase,
          resumeWith: "GUARDIAN_MIGRATION_CONFIRM_BURN=true",
        }),
      );
      return;
    }
    if (phase === "burn-old-oracle") {
      writeProgress({ ...progress, oldOracleBurn: await burnOldPublic(common) });
      continue;
    }
    if (phase === "migrate-public") {
      writeProgress({
        ...progress,
        finalPublicOracle: await migratePublic(common),
      });
      continue;
    }
    if (phase === "promote") {
      await verifyCandidate(client, progress.guardianCandidate, deployerLock);
      const promotion = buildGuardianMigrationPromotion({
        guardianCandidate: progress.guardianCandidate,
        oldGuardianState: progress.oldGuardianState,
        oracleTemplate: progress.oracleTemplate,
        stagingOracle: {
          ...progress.stagingOracle,
          publishTimeUnix: BigInt(progress.stagingOracle.publishTimeUnix),
        },
        oldOracleBurn: progress.oldOracleBurn,
        expectedPublicLockHash: progress.oldPublicOracle.lockHash,
        finalPublicOracle: {
          ...progress.finalPublicOracle,
          publishTimeUnix: BigInt(progress.finalPublicOracle.publishTimeUnix),
        },
      });
      writeDeploymentActionArtifacts(
        DEPLOYMENT_ROOT,
        "testnet",
        "migrate:owned-bind-guardian",
        promotion,
      );
      writeProgress({ ...progress, promoted: true });
      continue;
    }
    throw new Error(`Unsupported guardian migration phase: ${phase}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
