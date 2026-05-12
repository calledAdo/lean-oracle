import type { Client, ScriptLike, Transaction } from "@ckb-ccc/core";
import { Script, WitnessArgs, hexFrom } from "@ckb-ccc/core";
import type { FeedIdHex } from "../types/hex.js";
import type {
  HermesBinaryUpdateEnvelope,
  OracleUpdateOutputSource,
} from "../types/hermes.js";
import type { LeanOracleNetworkConfig } from "../types/network.js";
import {
  LeanOracleSdkError,
  LeanOracleOracleDataEncodeError,
} from "../errors.js";
import { fetchHermesLatestPriceUpdates } from "../hermes/client.js";
import { decodeLeanOracleCellDataHex } from "../ckb/decodeOracleData.js";
import { findLatestOracleLiveCellForFeed } from "../ckb/findOracleCells.js";
import {
  resolveGuardianSetCellDep,
  attachGuardianSetCellDep,
} from "../ckb/guardianDep.js";
import {
  buildOracleOutputFromHermesUpdate,
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
   *
   * Must include the Hermes **`parsed`** field when `outputSource` is
   * `"hermes-parsed"` (the default): the parsed-mode drafter reads numeric
   * oracle-cell fields from `parsed`. When `outputSource` is `"binary"`,
   * `parsed` is not required — the SDK derives the output fields directly
   * from `binary.data[0]`. In both modes the witness uses `binary.data[0]`,
   * which is what the on-chain `oracle_script` cryptographically verifies.
   */
  hermesEnvelope?: HermesBinaryUpdateEnvelope;

  /**
   * Selects how the SDK derives **dynamic price fields** for the new oracle
   * output cell. Defaults to `"hermes-parsed"` — preserving prior behavior.
   * See {@link OracleUpdateOutputSource}.
   */
  outputSource?: OracleUpdateOutputSource;
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

  // ── ② Get Hermes envelope (binary [+ parsed for default mode]) ───────────
  /*
   * The on-chain `oracle_script` cryptographically verifies only the **`binary`**
   * accumulator blob embedded in the witness. The **output cell** fields, by
   * contrast, can be sourced two ways — see `outputSource`:
   *
   *   - "hermes-parsed" (default): cheap; copy from `hermesEnvelope.parsed`.
   *   - "binary": parse `binary.data[0]` client-side and read fields from the
   *               decoded price-feed message.
   *
   * Both modes feed the same `binary.data[0]` into the witness; the contract
   * still rejects any tx whose output disagrees with what it extracts from
   * `binary` on-chain.
   */
  const outputSource: OracleUpdateOutputSource =
    params.outputSource ?? "hermes-parsed";

  const hermesEnvelope: HermesBinaryUpdateEnvelope =
    params.hermesEnvelope ??
    (await fetchHermesLatestPriceUpdates(params.network, [params.feedId], {
      encoding: "hex",
    }));

  if (!hermesEnvelope.binary?.data?.[0]) {
    throw new LeanOracleSdkError("Hermes response missing binary.data[0]");
  }

  if (
    outputSource === "hermes-parsed" &&
    (!hermesEnvelope.parsed || hermesEnvelope.parsed.length === 0)
  ) {
    throw new LeanOracleOracleDataEncodeError(
      "Hermes response is missing the `parsed` field. " +
        "The default SDK update drafter (`outputSource: \"hermes-parsed\"`) requires Hermes `parsed` to populate oracle output cell fields. " +
        "On-chain verification still uses the Hermes `binary` accumulator embedded in the witness. " +
        "Re-fetch with Hermes `parsed` enabled, supply a `hermesEnvelope` that already includes `parsed`, " +
        "or pass `outputSource: \"binary\"` to derive output fields from `binary.data[0]` instead.",
    );
  }

  // ── ③ Build oracle update witness bytes (OracleUpdateWitness) ─────────────
  const oracleUpdateWitnessBytes =
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
  params.tx.addCellDeps(deployment.oracleType.codeDep);

  // If the consumed oracle is locked by the default public lock, also attach its code dep.
  {
    const publicLock = Script.from({
      codeHash: deployment.defaultPublicOracleLock.script.codeHash,
      hashType: deployment.defaultPublicOracleLock.script.hashType,
      args: deployment.defaultPublicOracleLock.script.args ?? "0x",
    });
    if (scriptsEqual(Script.from(inputCell.cellOutput.lock), publicLock)) {
      params.tx.addCellDeps(deployment.defaultPublicOracleLock.codeDep);
    }
  }

  // ── ⑤ Create the new oracle output cell data ──────────────────────────────
  // Off-chain only: numeric fields are sourced from `outputSource` (default
  // `"hermes-parsed"`). The contract re-derives them from `binary` and
  // rejects this tx if they disagree.
  const outputOracleDecoded = buildOracleOutputFromHermesUpdate({
    inputOracle: inputOracleDecoded,
    hermesEnvelope,
    feedId: params.feedId,
    outputSource,
  });
  const outputOracleDataBytes = encodeOracleCellDataBytes(outputOracleDecoded);
  const outputOracleDataHex = hexFrom(outputOracleDataBytes);

  // ── ⑥ Mutate tx: add input, add output, set oracle update witness ───────
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
   * write `WitnessArgs.input_type` at `inputIndex`.
   *
   * The `lock` field is reserved for lock-script-owned witness material.
   */
  const witnessArgs =
    params.tx.getWitnessArgsAt(inputIndex) ?? WitnessArgs.from({});
  witnessArgs.inputType = hexFrom(oracleUpdateWitnessBytes);
  params.tx.setWitnessArgsAt(inputIndex, witnessArgs);

  return { mutated: params.tx };
}
