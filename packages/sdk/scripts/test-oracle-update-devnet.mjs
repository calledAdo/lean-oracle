import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { ccc } from "@ckb-ccc/core";

import {
  encodeOracleUpdateWitnessFromAccumulatorHex,
  fetchHermesLatestPriceUpdates,
  rebalanceFuel,
  resolveGuardianSetCellDep,
} from "../dist/index.js";
import { createCccClient, createPrivateKeySigner } from "../../../deployment/dist/ccc.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const ARTIFACTS_DIR = path.join(REPO_ROOT, "deployment", "artifacts");

const DEVNET_RPC = process.env.DEVNET_CKB_RPC_URL ?? "http://127.0.0.1:28114";
const DEVNET_PRIVATE_KEY = process.env.DEVNET_PRIVATE_KEY;
const BTC_FEED_ID =
  process.env.ORACLE_FEED_ID ??
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const HERMES_BASE_URL = process.env.HERMES_BASE_URL ?? "https://hermes.pyth.network";

const ORACLE_STATE_LEN = 152;

function requireEnv(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function selectLatestVersion(artifact) {
  const versions = artifact?.deployment?.versions;
  if (!versions || typeof versions !== "object") {
    throw new Error("Artifact is missing deployment.versions");
  }
  const latest = Object.keys(versions)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a)[0];
  if (latest === undefined) throw new Error("Artifact has no versions");
  return versions[String(latest)];
}

function bigintOutPoint(outPoint) {
  return {
    txHash: outPoint.txHash,
    index: BigInt(outPoint.index),
  };
}

function normalizeFeedId(feedId) {
  let body = feedId.trim().toLowerCase();
  if (body.startsWith("0x")) body = body.slice(2);
  if (!/^[0-9a-f]{64}$/.test(body)) {
    throw new Error(`Invalid feed id: ${feedId}`);
  }
  return `0x${body}`;
}

function hexToBytes(hex) {
  let body = hex.trim().toLowerCase();
  if (body.startsWith("0x")) body = body.slice(2);
  if (body.length % 2 !== 0) throw new Error(`Invalid hex length for ${hex}`);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function decodeOracleDataHex(hex) {
  const bytes = hexToBytes(hex);
  if (bytes.length !== ORACLE_STATE_LEN) {
    throw new Error(
      `Expected oracle cell data to be ${ORACLE_STATE_LEN} bytes, got ${bytes.length}`,
    );
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    feedId: bytesToHex(bytes.subarray(0, 32)),
    guardianSetTypeHash: bytesToHex(bytes.subarray(32, 64)),
    price: dv.getBigInt64(64, true),
    conf: dv.getBigUint64(72, true),
    expo: dv.getInt32(80, true),
    publishTimeUnix: dv.getBigUint64(84, true),
    prevPublishTimeUnix: dv.getBigUint64(92, true),
    emaPrice: dv.getBigInt64(100, true),
    emaConf: dv.getBigUint64(108, true),
    emitterChain: dv.getUint32(116, true),
    emitterAddress: bytesToHex(bytes.subarray(120, 152)),
  };
}

function parseDecimalBigInt(label, value) {
  if (!/^-?\d+$/.test(String(value).trim())) {
    throw new Error(`${label} must be a base-10 integer string`);
  }
  return BigInt(value);
}

function encodeOracleData(data) {
  const out = new Uint8Array(ORACLE_STATE_LEN);
  const dv = new DataView(out.buffer);
  out.set(hexToBytes(data.feedId), 0);
  out.set(hexToBytes(data.guardianSetTypeHash), 32);
  dv.setBigInt64(64, data.price, true);
  dv.setBigUint64(72, data.conf, true);
  dv.setInt32(80, data.expo, true);
  dv.setBigUint64(84, data.publishTimeUnix, true);
  dv.setBigUint64(92, data.prevPublishTimeUnix, true);
  dv.setBigInt64(100, data.emaPrice, true);
  dv.setBigUint64(108, data.emaConf, true);
  dv.setUint32(116, data.emitterChain, true);
  out.set(hexToBytes(data.emitterAddress), 120);
  return out;
}

function pickParsedTouch(envelope, feedId) {
  const parsed = envelope.parsed;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Hermes response is missing parsed updates");
  }
  const wanted = normalizeFeedId(feedId);
  const hit = parsed.find((entry) => normalizeFeedId(entry.id) === wanted);
  if (!hit) {
    throw new Error(`Hermes parsed payload did not include feed ${wanted}`);
  }
  return hit;
}

function buildUpdatedOracleState(current, hermesEnvelope, feedId) {
  const touch = pickParsedTouch(hermesEnvelope, feedId);
  return {
    feedId: current.feedId,
    guardianSetTypeHash: current.guardianSetTypeHash,
    price: parseDecimalBigInt("price", touch.price.price),
    conf: BigInt(touch.price.conf),
    expo: Number(touch.price.expo),
    publishTimeUnix: BigInt(touch.price.publish_time),
    prevPublishTimeUnix: BigInt(touch.metadata.prev_publish_time),
    emaPrice: parseDecimalBigInt("ema_price", touch.ema_price.price),
    emaConf: BigInt(touch.ema_price.conf),
    emitterChain: current.emitterChain,
    emitterAddress: current.emitterAddress,
  };
}

async function fetchHermesEnvelope(network, feedId) {
  const abort = AbortSignal.timeout(20_000);
  try {
    return await fetchHermesLatestPriceUpdates(network, [feedId], {
      encoding: "hex",
      signal: abort,
    });
  } catch (error) {
    const url =
      `${HERMES_BASE_URL}/v2/updates/price/latest` +
      `?ids%5B%5D=${encodeURIComponent(feedId)}` +
      `&encoding=hex`;
    const stdout = execFileSync("curl", ["-sS", "--max-time", "20", url], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.binary ||
      !Array.isArray(parsed.binary.data)
    ) {
      throw error;
    }
    return parsed;
  }
}

function formatScaledPrice(price, expo) {
  const negative = price < 0n;
  const abs = negative ? -price : price;
  if (expo >= 0) {
    const whole = abs * 10n ** BigInt(expo);
    return `${negative ? "-" : ""}${whole.toString()}`;
  }
  const decimals = -expo;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function buildDevnetNetwork() {
  const guardianSetTypeArtifact = readJson(
    path.join(ARTIFACTS_DIR, "devnet.guardian-set-type.json"),
  );
  const guardianSetArtifact = readJson(
    path.join(ARTIFACTS_DIR, "devnet.deploy-guardian-set.json"),
  );
  const oracleTypeArtifact = readJson(
    path.join(ARTIFACTS_DIR, "devnet.oracle-type.json"),
  );

  const guardianSetTypeVersion = selectLatestVersion(guardianSetTypeArtifact);
  const oracleTypeVersion = selectLatestVersion(oracleTypeArtifact);
  const guardianSetDeployment = guardianSetArtifact.deployment;

  const guardianSetTypeArgs = guardianSetDeployment.deployed.typeIdArgs;
  const guardianSetTypeScript = ccc.Script.from({
    codeHash: guardianSetDeployment.guardianSetType.codeHash,
    hashType: guardianSetDeployment.guardianSetType.hashType,
    args: guardianSetTypeArgs,
  });
  const guardianSetTypeHash = ccc.hashCkb(guardianSetTypeScript.toBytes());

  return {
    name: "testnet",
    hermesBaseUrl: HERMES_BASE_URL,
    ckbJsonRpcUrl: DEVNET_RPC,
    deployment: {
      canonicalPublicOracleLock: {
        script: {
          codeHash:
            "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
          hashType: "type",
          args: "0x8e42b1999f265a0078503c4acec4d5e134534297",
        },
        codeDep: {
          outPoint: {
            txHash:
              "0x4d804f1495612631da202fe9902fa9899118554b08138cfe5dfb50e1ede76293",
            index: 0n,
          },
          depType: "depGroup",
        },
      },
      oracleType: {
        codeHash: oracleTypeVersion.codeHash,
        hashType: oracleTypeVersion.hashType,
        codeDep: {
          outPoint: bigintOutPoint({
            txHash: oracleTypeVersion.txHash,
            index: oracleTypeVersion.index,
          }),
          depType: oracleTypeVersion.depType,
        },
      },
      guardianSetType: {
        codeHash: guardianSetTypeVersion.codeHash,
        hashType: guardianSetTypeVersion.hashType,
        args: guardianSetTypeArgs,
        identityVersion:
          guardianSetDeployment.identityVersion ??
          guardianSetDeployment.guardianSetType.version,
        codeVersion:
          guardianSetDeployment.guardianSetType.codeVersion ??
          guardianSetTypeVersion.version,
        typeHash: guardianSetTypeHash,
        codeDep: {
          outPoint: bigintOutPoint({
            txHash: guardianSetTypeVersion.txHash,
            index: guardianSetTypeVersion.index,
          }),
          depType: guardianSetTypeVersion.depType,
        },
      },
    },
  };
}

async function findCurrentOracleCell(client, signerLock, network, feedId) {
  const oracleTypeScript = ccc.Script.from({
    codeHash: network.deployment.oracleType.codeHash,
    hashType: network.deployment.oracleType.hashType,
    args: normalizeFeedId(feedId),
  });

  for await (const cell of client.findCells(
    {
      script: ccc.Script.from(signerLock),
      scriptType: "lock",
      scriptSearchMode: "exact",
      filter: { script: oracleTypeScript },
      withData: true,
    },
    "desc",
    256,
  )) {
    return cell;
  }

  return null;
}

async function main() {
  requireEnv("DEVNET_PRIVATE_KEY", DEVNET_PRIVATE_KEY);

  const network = buildDevnetNetwork();
  const client = createCccClient("devnet", DEVNET_RPC, {
    rpcUrl: DEVNET_RPC,
    deployerPrivateKey: DEVNET_PRIVATE_KEY,
    broadcast: "true",
    dryRun: "false",
    devnetSecp256k1Blake160CodeHash:
      process.env.DEVNET_SECP256K1_BLAKE160_CODE_HASH ??
      "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
    devnetSecp256k1Blake160HashType:
      process.env.DEVNET_SECP256K1_BLAKE160_HASH_TYPE ?? "type",
    devnetSecp256k1Blake160DepTxHash:
      process.env.DEVNET_SECP256K1_BLAKE160_DEP_TX_HASH ??
      "0x4d804f1495612631da202fe9902fa9899118554b08138cfe5dfb50e1ede76293",
    devnetSecp256k1Blake160DepIndex:
      process.env.DEVNET_SECP256K1_BLAKE160_DEP_INDEX ?? "0",
    devnetSecp256k1Blake160DepType:
      process.env.DEVNET_SECP256K1_BLAKE160_DEP_TYPE ?? "depGroup",
    oracleFeedId: BTC_FEED_ID,
    oracleEmitterChain: "",
    oracleEmitterAddress: "",
  });
  const signer = createPrivateKeySigner(client, DEVNET_PRIVATE_KEY);
  const { script: signerLock } = await signer.getRecommendedAddressObj();

  const currentOracleCell = await findCurrentOracleCell(client, signerLock, network, BTC_FEED_ID);
  if (!currentOracleCell) {
    throw new Error(
      `No live oracle cell found for BTC feed ${BTC_FEED_ID}. Redeploy oracle state first.`,
    );
  }

  const before = decodeOracleDataHex(currentOracleCell.outputData);
  const hermes = await fetchHermesEnvelope(network, BTC_FEED_ID);
  const updated = buildUpdatedOracleState(before, hermes, BTC_FEED_ID);
  const outputDataHex = ccc.hexFrom(encodeOracleData(updated));
  const witnessBytes = encodeOracleUpdateWitnessFromAccumulatorHex(hermes.binary.data[0]);

  const tx = ccc.Transaction.from({
    version: 0n,
    cellDeps: [],
    headerDeps: [],
    inputs: [],
    outputs: [],
    outputsData: [],
    witnesses: [],
  });

  const inputIndex =
    tx.addInput({
      previousOutput: currentOracleCell.outPoint,
    }) - 1;

  tx.addOutput({
    cellOutput: {
      capacity: currentOracleCell.cellOutput.capacity,
      lock: currentOracleCell.cellOutput.lock,
      type: currentOracleCell.cellOutput.type,
    },
    outputData: outputDataHex,
  });

  const witnessArgs = tx.getWitnessArgsAt(inputIndex) ?? ccc.WitnessArgs.from({});
  witnessArgs.inputType = ccc.hexFrom(witnessBytes);
  tx.setWitnessArgsAt(inputIndex, witnessArgs);

  tx.addCellDeps(network.deployment.oracleType.codeDep);
  tx.addCellDeps(network.deployment.canonicalPublicOracleLock.codeDep);
  tx.addCellDeps(
    await resolveGuardianSetCellDep(client, network.deployment, {
      expectedGuardianSetTypeHash: before.guardianSetTypeHash,
    }),
  );

  const rebalance = await rebalanceFuel(tx, {
    cccClient: client,
    lockScript: signerLock,
    // Give the one-off devnet update a small cushion above pool minimum so
    // iterative size growth doesn't leave us a few dozen shannons short.
    feeRateShannonsPerKbOverride: 1200n,
  });

  if (rebalance.status !== "ok") {
    throw new Error(
      `Insufficient fuel for update tx; need ${rebalance.extraCapacityNeededShannons.toString()} more shannons`,
    );
  }

  const txHash = await signer.sendTransaction(rebalance.mutated);
  const updatedCell = await findCurrentOracleCell(client, signerLock, network, BTC_FEED_ID);
  const after = updatedCell ? decodeOracleDataHex(updatedCell.outputData) : null;

  console.log(
    JSON.stringify(
      {
        feedId: BTC_FEED_ID,
        hermesBaseUrl: HERMES_BASE_URL,
        inputOracleOutPoint: {
          txHash: currentOracleCell.outPoint.txHash,
          index: currentOracleCell.outPoint.index.toString(),
        },
        updateTxHash: txHash,
        before: {
          publishTimeUnix: before.publishTimeUnix.toString(),
          price: before.price.toString(),
          expo: before.expo,
          formattedPrice: formatScaledPrice(before.price, before.expo),
        },
        after: after
          ? {
              publishTimeUnix: after.publishTimeUnix.toString(),
              price: after.price.toString(),
              expo: after.expo,
              formattedPrice: formatScaledPrice(after.price, after.expo),
            }
          : null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
