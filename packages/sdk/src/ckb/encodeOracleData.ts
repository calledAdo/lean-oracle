/**
 * @packageDocumentation
 *
 * Encode oracle output cell data in the exact binary layout expected by the on-chain
 * `oracle_script` — Rust `OracleData::to_bytes` (`contracts/common/src/oracle_data.rs`).
 *
 * This module is used when drafting **update** transactions:
 * - witness contains the raw Hermes accumulator blob
 * - output cell data must mirror the price message extracted by the script
 *
 * For the first TS implementation we fill numeric fields from **Hermes `parsed`**.
 * If `parsed` ever disagrees with `binary`, the transaction will be rejected on-chain.
 */

import { LeanOracleOracleDataEncodeError } from "../errors.js";
import { normalizePythFeedId } from "../hermes/client.js";
import type { LeanOracleDecodedCellData } from "../types/cells.js";
import type { FeedIdHex, HexString } from "../types/hex.js";
import type { HermesBinaryUpdateEnvelope, HermesParsedPriceTouch } from "../types/hermes.js";
import { ORACLE_CELL_DATA_BYTE_LENGTH } from "./decodeOracleData.js";

function decodeHex32Strict(label: string, hex: HexString): Uint8Array {
  const trimmed = hex.trim().toLowerCase();
  const body = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-f]{64}$/.test(body)) {
    throw new LeanOracleOracleDataEncodeError(
      `${label}: expected 32-byte hex (0x + 64 nibbles), got "${hex}"`,
    );
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 64; i += 2) {
    out[i / 2] = Number.parseInt(body.slice(i, i + 2), 16);
  }
  return out;
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
  out.set(decodeHex32Strict("emitterAddress", oracle.emitterAddress), 124);

  // Scalars (little-endian).
  dv.setBigInt64(64, requireI64("price", oracle.price), true);
  dv.setBigUint64(72, requireU64("conf", oracle.conf), true);
  dv.setInt32(80, requireI32("expo", oracle.expo), true);
  dv.setBigUint64(84, requireU64("publishTimeUnix", oracle.publishTimeUnix), true);
  dv.setBigUint64(92, requireU64("prevPublishTimeUnix", oracle.prevPublishTimeUnix), true);
  dv.setBigInt64(100, requireI64("emaPrice", oracle.emaPrice), true);
  dv.setBigUint64(108, requireU64("emaConf", oracle.emaConf), true);
  dv.setUint32(116, requireU32("guardianSetIndex", oracle.guardianSetIndex), true);
  dv.setUint32(120, requireU32("emitterChain", oracle.emitterChain), true);

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
      "Hermes response missing `parsed` field; cannot populate oracle output without parsing `binary` yet",
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
 * - **static config fields** from the existing oracle cell (guardian type hash/index, emitter fields)
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
    guardianSetIndex: inputOracle.guardianSetIndex,
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

