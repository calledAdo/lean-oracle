/**
 * @packageDocumentation
 *
 * Encode oracle output cell data in the exact binary layout expected by the on-chain
 * `oracle_script` — Rust `OracleData::to_bytes` (`contracts/common/src/oracle_data.rs`).
 *
 * This module is used when drafting **update** transactions:
 * - witness carries the raw Hermes **`binary`** accumulator blob — this is the *only*
 *   payload the on-chain `oracle_script` cryptographically verifies.
 * - output cell data must mirror the price message the script extracts from `binary`.
 *
 * **Off-chain construction:** two builders are provided, selected by the
 * caller-controlled `outputSource` option (default `"hermes-parsed"`):
 *
 * - {@link buildOracleOutputFromHermesParsed} reads numeric fields from
 *   Hermes `parsed` — cheap and the historical default.
 * - {@link buildOracleOutputFromHermesBinary} parses `binary.data[0]` with
 *   the SDK's narrow PNAU parser (see `../hermes/parseAccumulator.ts`) and
 *   reads numeric fields from the decoded price-feed message.
 *
 * Neither off-chain source is a cryptographic authority. The on-chain
 * `oracle_script` re-derives the fields from `binary` and rejects the tx if
 * they disagree, regardless of which builder was used.
 *
 * The TS parser is intentionally narrow: it extracts the price-feed message
 * fields needed for the output cell and does **not** verify the embedded
 * Wormhole VAA signatures or the Pyth Merkle proof. Both are performed
 * on-chain against the same `binary` bytes the SDK echoes into the witness.
 */

import { LeanOracleOracleDataEncodeError } from "../errors.js";
import { normalizePythFeedId } from "../hermes/client.js";
import { parseAccumulatorBytesForFeed } from "../hermes/parseAccumulator.js";
import type { LeanOracleDecodedCellData } from "../types/cells.js";
import type { FeedIdHex, HexString } from "../types/hex.js";
import type {
  HermesBinaryUpdateEnvelope,
  HermesParsedPriceTouch,
  OracleUpdateOutputSource,
} from "../types/hermes.js";
import { ORACLE_CELL_DATA_BYTE_LENGTH } from "./decodeOracleData.js";
import {
  decodeHexExact as decodeHexInternal,
  decodeHexFlexible,
} from "../internal/hex.js";

function decodeHex32Strict(label: string, hex: HexString): Uint8Array {
  try {
    return decodeHexInternal(hex, 32);
  } catch (e) {
    throw new LeanOracleOracleDataEncodeError(
      `${label}: ${(e as Error).message}`,
    );
  }
}

function bigIntFromHermesDecimal(label: string, s: string): bigint {
  // Hermes renders these as base-10 strings that fit within i64/u64 bounds.
  if (!/^-?\d+$/.test(s.trim())) {
    throw new LeanOracleOracleDataEncodeError(
      `${label}: expected base-10 integer string, got "${s}"`,
    );
  }
  return BigInt(s);
}

function requireI64(label: string, v: bigint): bigint {
  const min = -(1n << 63n);
  const max = (1n << 63n) - 1n;
  if (v < min || v > max) {
    throw new LeanOracleOracleDataEncodeError(
      `${label}: value out of i64 range: ${v.toString()}`,
    );
  }
  return v;
}

function requireU64(label: string, v: bigint): bigint {
  const max = (1n << 64n) - 1n;
  if (v < 0n || v > max) {
    throw new LeanOracleOracleDataEncodeError(
      `${label}: value out of u64 range: ${v.toString()}`,
    );
  }
  return v;
}

function requireI32(label: string, v: number): number {
  if (!Number.isInteger(v) || v < -0x8000_0000 || v > 0x7fff_ffff) {
    throw new LeanOracleOracleDataEncodeError(
      `${label}: value out of i32 range: ${String(v)}`,
    );
  }
  return v;
}

function requireU32(label: string, v: number): number {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) {
    throw new LeanOracleOracleDataEncodeError(
      `${label}: value out of u32 range: ${String(v)}`,
    );
  }
  return v;
}

/**
 * Encode `OracleData` bytes from a fully populated decoded view.
 *
 * Mirrors Rust `OracleData::to_bytes` exactly.
 *
 * @public
 */
export function encodeOracleCellDataBytes(
  oracle: LeanOracleDecodedCellData,
): Uint8Array {
  const out = new Uint8Array(ORACLE_CELL_DATA_BYTE_LENGTH);
  const dv = new DataView(out.buffer);

  // Fixed-width slabs.
  out.set(decodeHex32Strict("feedId", oracle.feedId), 0);
  out.set(decodeHex32Strict("guardianSetTypeHash", oracle.guardianSetTypeHash), 32);
  out.set(decodeHex32Strict("emitterAddress", oracle.emitterAddress), 120);

  // Scalars (little-endian).
  dv.setBigInt64(64, requireI64("price", oracle.price), true);
  dv.setBigUint64(72, requireU64("conf", oracle.conf), true);
  dv.setInt32(80, requireI32("expo", oracle.expo), true);
  dv.setBigUint64(84, requireU64("publishTimeUnix", oracle.publishTimeUnix), true);
  dv.setBigUint64(92, requireU64("prevPublishTimeUnix", oracle.prevPublishTimeUnix), true);
  dv.setBigInt64(100, requireI64("emaPrice", oracle.emaPrice), true);
  dv.setBigUint64(108, requireU64("emaConf", oracle.emaConf), true);
  dv.setUint32(116, requireU32("emitterChain", oracle.emitterChain), true);

  return out;
}

/**
 * Find the Hermes parsed entry matching `feedId` in a multi-feed envelope.
 */
export function pickHermesParsedTouchForFeed(
  envelope: HermesBinaryUpdateEnvelope,
  feedId: FeedIdHex,
): HermesParsedPriceTouch {
  const parsed = envelope.parsed;
  if (!parsed || parsed.length === 0) {
    throw new LeanOracleOracleDataEncodeError(
      "Hermes response is missing the `parsed` field. " +
        "The default SDK update drafter (`outputSource: \"hermes-parsed\"`) reads oracle output cell fields (price/conf/expo/publish_time/...) from Hermes `parsed`. " +
        "On-chain verification still uses the Hermes `binary` accumulator embedded in the witness. " +
        "Re-fetch with Hermes `parsed` enabled, supply a `hermesEnvelope` that already includes `parsed`, " +
        "or pass `outputSource: \"binary\"` to derive output fields from `binary.data[0]` instead.",
    );
  }
  const normalized = normalizePythFeedId(feedId);
  const hit = parsed.find((p) => normalizePythFeedId(p.id) === normalized);
  if (!hit) {
    throw new LeanOracleOracleDataEncodeError(
      `Hermes parsed did not include requested feed id ${normalized}`,
    );
  }
  return hit;
}

/**
 * Build the **new** oracle output state by combining:
 * - **static config fields** from the existing oracle cell (guardian type hash, emitter fields)
 * - **dynamic price fields** from Hermes `parsed`
 *
 * @public
 */
export function buildOracleOutputFromHermesParsed(
  inputOracle: LeanOracleDecodedCellData,
  hermesEnvelope: HermesBinaryUpdateEnvelope,
  feedId: FeedIdHex,
): LeanOracleDecodedCellData {
  const touch = pickHermesParsedTouchForFeed(hermesEnvelope, feedId);

  const price = requireI64(
    "hermes.price.price",
    bigIntFromHermesDecimal("hermes.price.price", touch.price.price),
  );
  const conf = requireU64(
    "hermes.price.conf",
    bigIntFromHermesDecimal("hermes.price.conf", touch.price.conf),
  );
  const expo = requireI32("hermes.price.expo", touch.price.expo);
  const publishTimeUnix = requireU64(
    "hermes.price.publish_time",
    BigInt(touch.price.publish_time),
  );
  const prevPublishTimeUnix = requireU64(
    "hermes.metadata.prev_publish_time",
    BigInt(touch.metadata.prev_publish_time),
  );
  const emaPrice = requireI64(
    "hermes.ema_price.price",
    bigIntFromHermesDecimal("hermes.ema_price.price", touch.ema_price.price),
  );
  const emaConf = requireU64(
    "hermes.ema_price.conf",
    bigIntFromHermesDecimal("hermes.ema_price.conf", touch.ema_price.conf),
  );

  return {
    // static / identity fields (must remain unchanged for a valid update)
    feedId: inputOracle.feedId,
    guardianSetTypeHash: inputOracle.guardianSetTypeHash,
    emitterChain: inputOracle.emitterChain,
    emitterAddress: inputOracle.emitterAddress,

    // dynamic fields from Hermes
    price,
    conf,
    expo,
    publishTimeUnix,
    prevPublishTimeUnix,
    emaPrice,
    emaConf,
  };
}

/**
 * Build the **new** oracle output state by combining:
 * - **static config fields** from the existing oracle cell (guardian type hash, emitter fields)
 * - **dynamic price fields** parsed from the Hermes **`binary`** accumulator
 *   (`hermesEnvelope.binary.data[0]`)
 *
 * Use this when you want the SDK to derive output fields directly from the
 * accumulator bytes the contract verifies, instead of trusting Hermes
 * `parsed`. The witness still carries the same `binary.data[0]`; only the
 * source of the *output cell* fields changes.
 *
 * Throws {@link LeanOracleOracleDataEncodeError} if the binary blob is
 * malformed or does not contain `feedId`.
 *
 * @public
 */
export function buildOracleOutputFromHermesBinary(
  inputOracle: LeanOracleDecodedCellData,
  hermesEnvelope: HermesBinaryUpdateEnvelope,
  feedId: FeedIdHex,
): LeanOracleDecodedCellData {
  const first = hermesEnvelope.binary?.data?.[0];
  if (!first) {
    throw new LeanOracleOracleDataEncodeError(
      "Hermes envelope missing `binary.data[0]`; cannot derive oracle output from binary accumulator",
    );
  }

  let bytes: Uint8Array;
  if (hermesEnvelope.binary.encoding === "hex") {
    try {
      bytes = decodeHexFlexible(first);
    } catch (cause) {
      throw new LeanOracleOracleDataEncodeError(
        `Hermes binary.data[0] is not valid hex: ${(cause as Error).message}`,
        { cause },
      );
    }
  } else {
    bytes = decodeBase64ToBytes(first);
  }

  let parsed;
  try {
    parsed = parseAccumulatorBytesForFeed(bytes, feedId);
  } catch (cause) {
    throw new LeanOracleOracleDataEncodeError(
      `Failed to parse Hermes binary accumulator for feed ${normalizePythFeedId(feedId)}: ${(cause as Error).message}`,
      { cause },
    );
  }

  return {
    feedId: inputOracle.feedId,
    guardianSetTypeHash: inputOracle.guardianSetTypeHash,
    emitterChain: inputOracle.emitterChain,
    emitterAddress: inputOracle.emitterAddress,
    price: parsed.price,
    conf: parsed.conf,
    expo: parsed.expo,
    publishTimeUnix: parsed.publishTimeUnix,
    prevPublishTimeUnix: parsed.prevPublishTimeUnix,
    emaPrice: parsed.emaPrice,
    emaConf: parsed.emaConf,
  };
}

function decodeBase64ToBytes(input: string): Uint8Array {
  if (typeof globalThis.atob === "function") {
    const bin = globalThis.atob(input);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buf = (globalThis as any).Buffer?.from?.(input, "base64") as
    | Uint8Array
    | undefined;
  if (buf) return new Uint8Array(buf);
  throw new LeanOracleOracleDataEncodeError(
    "Base64 decoding unavailable in this runtime (no atob/Buffer)",
  );
}

/**
 * Parameters for the unified Hermes oracle output builder.
 *
 * @public
 */
export interface BuildOracleOutputFromHermesUpdateParams {
  /** Decoded view of the existing oracle cell whose static config fields are preserved. */
  inputOracle: LeanOracleDecodedCellData;
  /** Hermes update envelope (`binary` always required; `parsed` required for the default mode). */
  hermesEnvelope: HermesBinaryUpdateEnvelope;
  /** Target Pyth feed id. */
  feedId: FeedIdHex;
  /**
   * How to derive the dynamic price fields. Defaults to `"hermes-parsed"`,
   * matching {@link draftOracleUpdateTx}. See {@link OracleUpdateOutputSource}.
   *
   * No silent fallback between modes: each path requires its own input
   * (`parsed` for `"hermes-parsed"`, valid `binary.data[0]` containing the
   * target feed for `"binary"`).
   */
  outputSource?: OracleUpdateOutputSource;
}

/**
 * Unified Hermes oracle output builder used by SDK update drafting.
 *
 * Dispatches to {@link buildOracleOutputFromHermesParsed} (default) or
 * {@link buildOracleOutputFromHermesBinary} based on `outputSource`. Static
 * config fields (`feedId`, `guardianSetTypeHash`, `emitterChain`,
 * `emitterAddress`) are always taken from `inputOracle`; only the dynamic
 * price fields come from the selected source.
 *
 * @public
 */
export function buildOracleOutputFromHermesUpdate(
  params: BuildOracleOutputFromHermesUpdateParams,
): LeanOracleDecodedCellData {
  const source: OracleUpdateOutputSource =
    params.outputSource ?? "hermes-parsed";

  if (source === "binary") {
    return buildOracleOutputFromHermesBinary(
      params.inputOracle,
      params.hermesEnvelope,
      params.feedId,
    );
  }

  return buildOracleOutputFromHermesParsed(
    params.inputOracle,
    params.hermesEnvelope,
    params.feedId,
  );
}

