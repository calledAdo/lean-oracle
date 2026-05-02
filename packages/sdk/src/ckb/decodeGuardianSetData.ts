/**
 * @packageDocumentation
 *
 * Guardian sets are stored on-chain as a dedicated cell whose **data** matches
 * Rust `GuardianSetData` (`contracts/common/src/guardian_set.rs`).
 *
 * The oracle script loads this cell from **`CellDep`** and uses it to verify the
 * Wormhole VAA signature quorum.
 */

import { LeanOracleGuardianSetDataDecodeError } from "../errors.js";
import type { LeanOracleGuardianSetData } from "../types/guardianSet.js";
import type { HexString } from "../types/hex.js";

/** Fixed header length before the variable-length guardian list begins. */
export const GUARDIAN_SET_HEADER_BYTE_LENGTH = 60;

function bytesToHex(bytes: Uint8Array): HexString {
  let body = "";
  for (let i = 0; i < bytes.length; i++) {
    body += bytes[i]!.toString(16).padStart(2, "0");
  }
  return `0x${body}`;
}

function decodeFlexibleHex(label: string, hex: HexString): Uint8Array {
  const flattened = hex.trim().replace(/\s+/g, "");
  const body = flattened.startsWith("0x") || flattened.startsWith("0X")
    ? flattened.slice(2)
    : flattened;

  if (body.length % 2 !== 0) {
    throw new LeanOracleGuardianSetDataDecodeError(
      `${label}: hex length must be even (got ${String(body.length)} hex digits)`,
    );
  }

  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < body.length; i += 2) {
    const slice = body.slice(i, i + 2);
    const byte = Number.parseInt(slice, 16);
    if (!Number.isFinite(byte) || byte < 0 || byte > 0xff) {
      throw new LeanOracleGuardianSetDataDecodeError(
        `${label}: invalid hex byte "${slice}" at digit offset ${String(i)}`,
      );
    }
    out[i / 2] = byte;
  }
  return out;
}

/**
 * Decode raw guardian-set bytes.
 *
 * Layout:
 * - `[0..4)` set_index (u32 LE)
 * - `[4..8)` quorum (u32 LE)
 * - `[8..16)` creation_time (u64 LE)
 * - `[16..24)` expiration_time (u64 LE)
 * - `[24..56)` governance_lock_hash (32 bytes)
 * - `[56..60)` guardian_count (u32 LE)
 * - `[60..]` guardian_count * 20 bytes of guardian addresses
 *
 * @public
 */
export function decodeGuardianSetCellDataBytes(
  raw: Uint8Array,
): LeanOracleGuardianSetData {
  if (raw.length < GUARDIAN_SET_HEADER_BYTE_LENGTH) {
    throw new LeanOracleGuardianSetDataDecodeError(
      `Guardian set data too short: expected at least ${String(GUARDIAN_SET_HEADER_BYTE_LENGTH)} bytes, got ${String(raw.length)}`,
    );
  }

  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const setIndex = dv.getUint32(0, true);
  const quorum = dv.getUint32(4, true);
  const creationTimeUnix = dv.getBigUint64(8, true);
  const expirationTimeUnix = dv.getBigUint64(16, true);
  const governanceLockHash = bytesToHex(raw.subarray(24, 56));
  const guardianCount = dv.getUint32(56, true);

  const expectedLen =
    GUARDIAN_SET_HEADER_BYTE_LENGTH + Number(guardianCount) * 20;
  if (raw.length !== expectedLen) {
    throw new LeanOracleGuardianSetDataDecodeError(
      `Guardian set data wrong length: expected ${String(expectedLen)} bytes for guardian_count=${String(guardianCount)}, got ${String(raw.length)}`,
    );
  }

  const guardianAddresses: HexString[] = [];
  let cursor = GUARDIAN_SET_HEADER_BYTE_LENGTH;
  while (cursor < raw.length) {
    guardianAddresses.push(bytesToHex(raw.subarray(cursor, cursor + 20)));
    cursor += 20;
  }

  return {
    setIndex,
    quorum,
    creationTimeUnix,
    expirationTimeUnix,
    governanceLockHash,
    guardianAddresses,
  };
}

/**
 * Decode guardian-set cell data from a hex string (RPC/CCC style).
 *
 * @public
 */
export function decodeGuardianSetCellDataHex(
  guardianSetDataHex: HexString,
): LeanOracleGuardianSetData {
  const bytes = decodeFlexibleHex("Guardian set data hex", guardianSetDataHex);
  return decodeGuardianSetCellDataBytes(bytes);
}

