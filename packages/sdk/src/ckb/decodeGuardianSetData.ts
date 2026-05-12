/**
 * @packageDocumentation
 *
 * Guardian sets are stored on-chain as a dedicated cell whose **data** matches
 * Rust `GuardianSetData` (`contracts/common/src/guardian_set.rs`).
 *
 * **Current-set-only policy**: lifecycle fields are not present in the byte
 * layout. Only the active canonical guardian set is accepted for oracle
 * verification; after rotation, callers must use Hermes data signed by the new set.
 *
 * The oracle script loads this cell from **`CellDep`** and uses it to verify the
 * Wormhole VAA signature quorum.
 */

import { LeanOracleGuardianSetDataDecodeError } from "../errors.js";
import type { LeanOracleGuardianSetData } from "../types/guardianSet.js";
import type { HexString } from "../types/hex.js";
import {
  bytesToHex,
  decodeHexFlexible as decodeHexInternal,
} from "../internal/hex.js";

/**
 * Fixed header length before the variable-length guardian list: `set_index`,
 * `quorum`, and `guardian_count` (each u32 LE).
 */
export const GUARDIAN_SET_HEADER_BYTE_LENGTH = 12;

function decodeFlexibleHex(label: string, hex: HexString): Uint8Array {
  try {
    return decodeHexInternal(hex);
  } catch (e) {
    throw new LeanOracleGuardianSetDataDecodeError(
      `${label}: ${(e as Error).message}`,
    );
  }
}

/**
 * Decode raw guardian-set bytes.
 *
 * Layout:
 * - `[0..4)` set_index (u32 LE)
 * - `[4..8)` quorum (u32 LE)
 * - `[8..12)` guardian_count (u32 LE)
 * - `[12..]` `guardian_count` consecutive 20-byte guardian addresses
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
  const guardianCount = dv.getUint32(8, true);

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
