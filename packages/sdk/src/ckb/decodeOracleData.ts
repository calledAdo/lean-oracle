/**
 * @packageDocumentation
 *
 * On-chain oracle state is stored verbatim as **`OracleData`** bytes in each oracle cell's
 * **`outputs_data`** / live **`data`** field — see **`contracts/common/src/oracle_data.rs`**.
 *
 * Length is fixed at **`ORACLE_CELL_DATA_BYTE_LENGTH`** (`156`).
 * CCC / RPC returns data as **`0x`** hex blobs; indexer paths may expose **`Uint8Array`** —
 * both entry points converge on the same **`DataView`** read rules as Rust **`from_le_bytes`**.
 */

import { LeanOracleCellDataDecodeError } from "../errors.js";
import type {
  LeanOracleCellDataHex,
  LeanOracleDecodedCellData,
} from "../types/cells.js";
import type { FeedIdHex, HexString } from "../types/hex.js";

/** Byte length of **`OracleData::to_bytes`** — same as Rust **`ORACLE_STATE_LEN`** (`156`). */
export const ORACLE_CELL_DATA_BYTE_LENGTH = 156;

/**
 * Decode lax hex (**`LeanOracleCellDataHex`**) copied from explorers or CCC output.
 *
 * Rejects odd-length digit strings / non-hex characters with **`LeanOracleCellDataDecodeError`**.
 *
 * Mirrors the permissive decoding style used elsewhere in this SDK (**`0x` optional**, collapses ASCII whitespace).
 */
function decodeFlexibleHexOracleCell(label: string, hex: LeanOracleCellDataHex): Uint8Array {
  const flattened = hex.trim().replace(/\s+/g, "");
  const body = flattened.startsWith("0x") || flattened.startsWith("0X")
    ? flattened.slice(2)
    : flattened;

  if (body.length % 2 !== 0) {
    throw new LeanOracleCellDataDecodeError(
      `${label}: hex length must be even (got ${String(body.length)} hex digits)`,
    );
  }

  const byteLen = body.length / 2;
  if (byteLen !== ORACLE_CELL_DATA_BYTE_LENGTH) {
    throw new LeanOracleCellDataDecodeError(
      `${label}: expected ${String(ORACLE_CELL_DATA_BYTE_LENGTH)} data bytes (${String(ORACLE_CELL_DATA_BYTE_LENGTH * 2)} hex digits), decoded ${String(byteLen)}`,
    );
  }

  const out = new Uint8Array(ORACLE_CELL_DATA_BYTE_LENGTH);
  for (let i = 0; i < body.length; i += 2) {
    const slice = body.slice(i, i + 2);
    const byte = Number.parseInt(slice, 16);
    if (!Number.isFinite(byte) || byte < 0 || byte > 0xff) {
      throw new LeanOracleCellDataDecodeError(
        `${label}: invalid hex byte "${slice}" at digit offset ${String(i)}`,
      );
    }
    out[i / 2] = byte;
  }
  return out;
}

/**
 * Canonical **`0x` + lowercase nibbles** for a byte view (deterministic fingerprints / map keys).
 */
function bytesToHex(bytes: Uint8Array): HexString {
  let body = "";
  for (let i = 0; i < bytes.length; i++) {
    body += bytes[i]!.toString(16).padStart(2, "0");
  }
  return `0x${body}`;
}

/**
 * Decode raw **`OracleData`** bytes (**exactly **`ORACLE_CELL_DATA_BYTE_LENGTH`** **).
 *
 * Layout (offsets, all LE except raw byte slabs):
 *
 * | Range | Field |
 * | ----- | ----- |
 * | **`[0..32)`** | **`feed_id`** |
 * | **`[32..64)`** | **`guardian_set_type_hash`** |
 * | **`64..72`** | **`price`** (`i64`) |
 * | **`72..80`** | **`conf`** (`u64`) |
 * | **`80..84`** | **`expo`** (`i32`) |
 * | **`84..92`** | **`publish_time`** (`u64`) |
 * | **`92..100`** | **`prev_publish_time`** (`u64`) |
 * | **`100..108`** | **`ema_price`** (`i64`) |
 * | **`108..116`** | **`ema_conf`** (`u64`) |
 * | **`116..120`** | **`guardian_set_index`** (`u32`) |
 * | **`120..124`** | **`emitter_chain`** (`u32`) |
 * | **`124..156`** | **`emitter_address`** (32 bytes) |
 *
 * @public
 */
export function decodeOracleCellDataBytes(
  raw: Uint8Array,
): LeanOracleDecodedCellData {
  /*
   * `Uint8Array` may alias a wider `ArrayBuffer` — constrain **`DataView`** to this view only.
   */
  if (raw.length !== ORACLE_CELL_DATA_BYTE_LENGTH) {
    throw new LeanOracleCellDataDecodeError(
      `Oracle cell data must be ${String(ORACLE_CELL_DATA_BYTE_LENGTH)} bytes, got ${String(raw.length)}`,
    );
  }

  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

  const feedIdBytes = raw.subarray(0, 32);
  const guardianSetTypeHashBytes = raw.subarray(32, 64);

  /*
   * Signed / unsigned 64-bit reads map 1:1 to Rust **`i64::from_le_bytes`** /
   * **`u64::from_le_bytes`** via **`DataView`** (`true` = little-endian).
   */
  const price = dv.getBigInt64(64, true);
  const conf = dv.getBigUint64(72, true);
  const expo = dv.getInt32(80, true);
  const publishTimeUnix = dv.getBigUint64(84, true);
  const prevPublishTimeUnix = dv.getBigUint64(92, true);
  const emaPrice = dv.getBigInt64(100, true);
  const emaConf = dv.getBigUint64(108, true);
  const guardianSetIndex = dv.getUint32(116, true);
  const emitterChain = dv.getUint32(120, true);
  const emitterAddressBytes = raw.subarray(124, 156);

  return {
    feedId: bytesToHex(feedIdBytes) as FeedIdHex,
    guardianSetTypeHash: bytesToHex(guardianSetTypeHashBytes),
    price,
    conf,
    expo,
    publishTimeUnix,
    prevPublishTimeUnix,
    emaPrice,
    emaConf,
    guardianSetIndex,
    emitterChain,
    emitterAddress: bytesToHex(emitterAddressBytes),
  };
}

/**
 * Decode oracle **`cell_data`** from a **`0x…`** hex string (CCC / RPC style).
 *
 * @public
 */
export function decodeLeanOracleCellDataHex(
  oracleDataHex: LeanOracleCellDataHex,
): LeanOracleDecodedCellData {
  const bytes = decodeFlexibleHexOracleCell("Oracle cell data hex", oracleDataHex);
  return decodeOracleCellDataBytes(bytes);
}
