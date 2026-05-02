import type { Client, ScriptLike, Transaction } from "@ckb-ccc/core";
import { Script, WitnessArgs, hexFrom } from "@ckb-ccc/core";
import type { FeedIdHex } from "../types/hex.js";
import type { HermesBinaryUpdateEnvelope } from "../types/hermes.js";
import type { LeanOracleNetworkConfig } from "../types/network.js";
import { LeanOracleSdkError } from "../errors.js";
import { fetchHermesLatestPriceUpdates } from "../hermes/client.js";
import { decodeLeanOracleCellDataHex } from "../ckb/decodeOracleData.js";
import { findLatestOracleLiveCellForFeed } from "../ckb/findOracleCells.js";
import {
  resolveGuardianSetCellDep,
  attachGuardianSetCellDep,
} from "../ckb/guardianDep.js";
import {
  buildOracleOutputFromHermesParsed,
  encodeOracleCellDataBytes,
} from "../ckb/encodeOracleData.js";
import {
  encodeOracleUpdateWitnessFromAccumulatorBytes,
  encodeOracleUpdateWitnessFromAccumulatorHex,
} from "../witness/encodeUpdateWitness.js";

export interface OraclePullUpdateParams {
  network: LeanOracleNetworkConfig;
  cccClient: Client;
  tx: Transaction;
  /** Feed keyed by oracle type-script args. */
  feedId: FeedIdHex;
  /**
   * Optional lock-script override when resolving the input oracle cell.
   *
   * When omitted, oracle discovery uses the deployment’s default public lock (typically AlwaysSuccess).
   */
  oracleLockScript?: ScriptLike;

  /**
   * Optional Hermes response body from a prior `fetchHermesLatestPriceUpdates` call (one envelope per GET).
   *
   * If omitted, the SDK fetches the latest Hermes update for `feedId`.
   */
  hermesEnvelope?: HermesBinaryUpdateEnvelope;
}

export interface OraclePullUpdateResult {
  mutated: Transaction;
}

function scriptsEqual(a: Script, b: Script): boolean {
  return (
    a.codeHash === b.codeHash &&
    a.hashType === b.hashType &&
    (a.args ?? "0x") === (b.args ?? "0x")
  );
}

function decodeBase64ToBytes(input: string): Uint8Array {
  // Browser / workers.
  if (typeof globalThis.atob === "function") {
    const bin = globalThis.atob(input);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buf = (globalThis as any).Buffer?.from?.(input, "base64") as
    | Uint8Array
    | undefined;
  if (buf) return new Uint8Array(buf);
  throw new LeanOracleSdkError(
    "Base64 decoding unavailable in this runtime (no atob/Buffer)",
  );
}

/**
 * Consume an oracle cell, optionally fetch Hermes, craft **witness + output oracle cell** per **`oracle_script` update path**.
 *
 * @public
 */
export async function attachOraclePullUpdate(
  params: OraclePullUpdateParams,
): Promise<OraclePullUpdateResult> {
  const deployment = params.network.deployment;
  const client = params.cccClient;

  // ── ① Resolve the input oracle cell to consume ────────────────────────────
  const oracleLive = await findLatestOracleLiveCellForFeed(
    client,
    params.feedId,
    {
      deployment,
      oracleLockScript: params.oracleLockScript,
    },
  );

  if (!oracleLive) {
    throw new LeanOracleSdkError(
      `No oracle live cell found for feed ${params.feedId}`,
    );
  }

  const inputCell = await client.getCell({
    txHash: oracleLive.outPoint.txHash,
    index: oracleLive.outPoint.index,
  });
  if (!inputCell) {
    throw new LeanOracleSdkError(
      `Oracle input cell not found on-chain at ${oracleLive.outPoint.txHash}:${oracleLive.outPoint.index.toString()}`,
    );
  }

  // Decode current oracle config + static fields from the on-chain cell data.
  const inputOracleDecoded = decodeLeanOracleCellDataHex(inputCell.outputData);

  // ── ② Get Hermes envelope (binary + parsed) ──────────────────────────────
  const hermesEnvelope: HermesBinaryUpdateEnvelope =
    params.hermesEnvelope ??
    (await fetchHermesLatestPriceUpdates(params.network, [params.feedId], {
      encoding: "hex",
    }));

  if (!hermesEnvelope.binary?.data?.[0]) {
    throw new LeanOracleSdkError("Hermes response missing binary.data[0]");
  }

  // ── ③ Build witness lock bytes (OracleUpdateWitness) ──────────────────────
  const witnessLockBytes =
    hermesEnvelope.binary.encoding === "hex"
      ? encodeOracleUpdateWitnessFromAccumulatorHex(
          hermesEnvelope.binary.data[0],
        )
      : encodeOracleUpdateWitnessFromAccumulatorBytes(
          decodeBase64ToBytes(hermesEnvelope.binary.data[0]),
        );

  // ── ④ Attach guardian-set CellDep (required by the oracle update path) ───
  const guardianDep = await resolveGuardianSetCellDep(client, deployment, {
    expectedGuardianSetTypeHash: inputOracleDecoded.guardianSetTypeHash,
  });
  attachGuardianSetCellDep(params.tx, guardianDep);

  // Attach oracle type-script code dep (required to execute oracle script).
  params.tx.addCellDeps({
    outPoint: deployment.oracleTypeScriptCodeDepOutPoint,
    depType: "code",
  });

  // If the consumed oracle is locked by AlwaysSuccess, also attach its code dep.
  {
    const publicLock = Script.from(
      deployment.defaultPublicOracleLockScript as ScriptLike,
    );
    if (scriptsEqual(Script.from(inputCell.cellOutput.lock), publicLock)) {
      params.tx.addCellDeps({
        outPoint: deployment.alwaysSuccessLockCodeDepOutPoint,
        depType: "code",
      });
    }
  }

  // ── ⑤ Create the new oracle output cell data (from Hermes parsed) ─────────
  const outputOracleDecoded = buildOracleOutputFromHermesParsed(
    inputOracleDecoded,
    hermesEnvelope,
    params.feedId,
  );
  const outputOracleDataBytes = encodeOracleCellDataBytes(outputOracleDecoded);
  const outputOracleDataHex = hexFrom(outputOracleDataBytes);

  // ── ⑥ Mutate tx: add input, add output, set witness lock ─────────────────
  /**
   * CCC `addInput` returns the **new inputs length**, not the index.
   * The added input’s index is therefore `len - 1`.
   */
  const inputIndex =
    params.tx.addInput({
      previousOutput: inputCell.outPoint,
    }) - 1;

  const outputsLen = params.tx.addOutput({
    cellOutput: {
      capacity: inputCell.cellOutput.capacity,
      lock: inputCell.cellOutput.lock,
      type: inputCell.cellOutput.type,
    },
    outputData: outputOracleDataHex,
  });
  const oracleOutputIndex = outputsLen - 1;
  void oracleOutputIndex;

  /*
   * CCC’s `addInput` returns the **input index**. The on-chain oracle script reads the
   * witness at that same index (group-input 0 for the oracle script group), so we must
   * write `WitnessArgs.lock` at `inputIndex` — not `inputIndex - 1`.
   */
  const witnessArgs =
    params.tx.getWitnessArgsAt(inputIndex) ?? WitnessArgs.from({});
  witnessArgs.lock = hexFrom(witnessLockBytes);
  params.tx.setWitnessArgsAt(inputIndex, witnessArgs);

  return { mutated: params.tx };
}
