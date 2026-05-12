/**
 * @packageDocumentation
 *
 * On-chain oracle state is stored verbatim as **`OracleData`** bytes in each oracle cell's
 * **`outputs_data`** / live **`data`** field — see **`contracts/common/src/oracle_data.rs`**.
 *
 * Length is fixed at **`ORACLE_CELL_DATA_BYTE_LENGTH`** (`152`).
 * CCC / RPC returns data as **`0x`** hex blobs; indexer paths may expose **`Uint8Array`** —
 * both entry points converge on the same **`DataView`** read rules as Rust **`from_le_bytes`**.
 */

import { LeanOracleCellDataDecodeError } from "../errors.js";
import type {
  LeanOracleCellDataHex,
  LeanOracleDecodedCellData,
} from "../types/cells.js";
import type { FeedIdHex } from "../types/hex.js";
import {
  bytesToHex,
  decodeHexExact as decodeHexInternal,
} from "../internal/hex.js";

/** Byte length of **`OracleData::to_bytes`** — same as Rust **`ORACLE_STATE_LEN`** (`152`). */
export const ORACLE_CELL_DATA_BYTE_LENGTH = 152;

/**
 * Decode lax hex (**`LeanOracleCellDataHex`**) and enforce oracle data length.
 */
function decodeFlexibleHexOracleCell(
  label: string,
  hex: LeanOracleCellDataHex,
): Uint8Array {
  try {
    return decodeHexInternal(hex, ORACLE_CELL_DATA_BYTE_LENGTH);
  } catch (e) {
    throw new LeanOracleCellDataDecodeError(
      `${label}: ${(e as Error).message}`,
    );
  }
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
 * | **`116..120`** | **`emitter_chain`** (`u32`) |
 * | **`120..152`** | **`emitter_address`** (32 bytes) |
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
  const emitterChain = dv.getUint32(116, true);
  const emitterAddressBytes = raw.subarray(120, 152);

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
