import type { HexString } from "./hex.js";

/**
 * Decoded on-chain guardian-set cell data (`contracts/common/src/guardian_set.rs`).
 *
 * Every multi-byte scalar is **little-endian**. The structure is strict:
 * `header (60 bytes) + guardian_count * 20` — trailing bytes are rejected.
 *
 * @public
 */
export interface LeanOracleGuardianSetData {
  /** Monotonic guardian set index. */
  setIndex: number;
  /** Minimum number of signatures required. */
  quorum: number;
  /** Unix seconds when this set was created. */
  creationTimeUnix: bigint;
  /** Unix seconds when this set expires (0 = indefinite). */
  expirationTimeUnix: bigint;
  /** 32-byte lock hash authorized to rotate the guardian set. */
  governanceLockHash: HexString;
  /** Guardian addresses as 20-byte Ethereum-style values (`0x` + 40 hex). */
  guardianAddresses: HexString[];
}

