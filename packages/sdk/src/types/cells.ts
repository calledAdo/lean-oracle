import type { FeedIdHex, HexString } from "./hex.js";
import type { LeanOracleCellOutPoint } from "./deployment.js";

/** Raw `cell_data` bytes for an oracle payload (typically 152-byte `OracleData`). */
export type LeanOracleCellDataHex = HexString;

/**
 * Minimal live-cell view after CCC / indexer hydration (expanded later).
 *
 * @public
 */
export interface LeanOracleLiveCellLike {
  outPoint: LeanOracleCellOutPoint;
  oracleDataHex: LeanOracleCellDataHex;
}

/**
 * Decoded on-chain **`OracleData`** layout (`contracts/common/src/oracle_data.rs`).
 *
 * Integer fields use **`bigint`** where Rust uses **`i64` / `u64`** so Pyth-scale mantissas stay exact.
 * Field order and endianness match **`OracleData::from_bytes`** (all multi-byte scalars **little-endian**).
 *
 * @public
 */
export interface LeanOracleDecodedCellData {
  /** 32-byte Pyth price feed id (`0x` + 64 hex nibbles). */
  feedId: FeedIdHex;
  /** Type script **code hash** (32 bytes) of the guardian-set cell this oracle loads from **`CellDep`**. */
  guardianSetTypeHash: HexString;
  /** Signed spot price (Pyth message `price`, scaled by **`10^expo`** off-chain). */
  price: bigint;
  /** Spot confidence (`conf`), same scaling family as **`price`**. */
  conf: bigint;
  /** Decimal exponent applied to **`price`** / **`conf`** (signed **`i32`**). */
  expo: number;
  /** Publication time of the signed update (unix seconds). */
  publishTimeUnix: bigint;
  /** Previous publication time echoed by Pyth (**`prev_publish_time`**). */
  prevPublishTimeUnix: bigint;
  /** EMA price from the authenticated update (**`ema_price`**). */
  emaPrice: bigint;
  /** EMA confidence (**`ema_conf`**). */
  emaConf: bigint;
  /** Wormhole emitter chain id carried in **`OracleData`**. */
  emitterChain: number;
  /** 32-byte Wormhole emitter address (`0x` + 64 hex). */
  emitterAddress: HexString;
}
