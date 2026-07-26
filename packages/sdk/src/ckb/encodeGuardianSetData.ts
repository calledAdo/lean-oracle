/**
 * @packageDocumentation
 *
 * Encoder for on-chain guardian-set cell **data**, the inverse of
 * {@link decodeGuardianSetCellDataBytes}. Used when building a guardian-set
 * rotation output cell (see {@link attachGuardianSetRotation}).
 *
 * Layout (all scalars little-endian): `set_index(4) | quorum(4) |
 * guardian_count(4) | guardian_count * 20-byte addresses`.
 */

import { LeanOracleGuardianSetDataDecodeError } from "../errors.js";
import type { LeanOracleGuardianSetData } from "../types/guardianSet.js";
import { GUARDIAN_SET_HEADER_BYTE_LENGTH } from "./decodeGuardianSetData.js";
import { bytesToHex, decodeHexExact } from "../internal/hex.js";

/**
 * Encode a {@link LeanOracleGuardianSetData} into raw cell bytes.
 *
 * @public
 */
export function encodeGuardianSetCellDataBytes(
  data: LeanOracleGuardianSetData,
): Uint8Array {
  const n = data.guardianAddresses.length;
  if (n === 0 || n > 0xff) {
    throw new LeanOracleGuardianSetDataDecodeError(
      "Guardian set must contain between 1 and 255 addresses",
    );
  }
  if (
    !Number.isInteger(data.setIndex) ||
    data.setIndex < 0 ||
    data.setIndex > 0xffff_ffff
  ) {
    throw new LeanOracleGuardianSetDataDecodeError(
      `Guardian set index ${String(data.setIndex)} is not a u32 integer`,
    );
  }
  if (!Number.isInteger(data.quorum) || data.quorum < 1 || data.quorum > n) {
    throw new LeanOracleGuardianSetDataDecodeError(
      `Guardian set quorum ${String(data.quorum)} out of range for ${String(n)} guardians`,
    );
  }

  const decodedAddresses = data.guardianAddresses.map((address) =>
    decodeHexExact(address, 20),
  );
  const normalizedAddresses = decodedAddresses.map(bytesToHex);
  if (new Set(normalizedAddresses).size !== normalizedAddresses.length) {
    throw new LeanOracleGuardianSetDataDecodeError(
      "Guardian set addresses must be unique",
    );
  }

  const out = new Uint8Array(GUARDIAN_SET_HEADER_BYTE_LENGTH + n * 20);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.setIndex >>> 0, true);
  dv.setUint32(4, data.quorum >>> 0, true);
  dv.setUint32(8, n >>> 0, true);

  let cursor = GUARDIAN_SET_HEADER_BYTE_LENGTH;
  for (const bytes of decodedAddresses) {
    out.set(bytes, cursor);
    cursor += 20;
  }
  return out;
}
