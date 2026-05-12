import type { HexString } from "./hex.js";

/**
 * Decoded on-chain guardian-set cell data (`contracts/common/src/guardian_set.rs`).
 *
 * **Current-set-only policy**: this fork does not store Wormhole-style lifecycle
 * fields (`creation_time`, `expiration_time`). Only the active canonical guardian
 * set is trusted; rotation is expressed via `setIndex` and the address list.
 *
 * Every multi-byte scalar is **little-endian**. The structure is strict:
 * `header (12 bytes) + guardian_count * 20` — trailing bytes are rejected.
 *
 * @public
 */
export interface LeanOracleGuardianSetData {
  /** Monotonic guardian set index. */
  setIndex: number;
  /** Minimum number of signatures required. */
  quorum: number;
  /** Guardian addresses as 20-byte Ethereum-style values (`0x` + 40 hex). */
  guardianAddresses: HexString[];
}
