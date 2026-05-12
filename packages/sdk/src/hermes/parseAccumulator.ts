/**
 * @packageDocumentation
 *
 * Narrow TypeScript port of the Lean Oracle Pyth-accumulator parser used by
 * `oracle_script` on-chain (see
 * `crates/lean_oracle/contracts/common/src/pyth_accumulator.rs`).
 *
 * Scope: extract a single authenticated `PriceFeedMessage` (price/conf/expo/
 * publish_time/prev_publish_time/ema_price/ema_conf) for a target feed id from
 * a Hermes accumulator (`PNAU`) blob.
 *
 * **Not** in scope here:
 * - Wormhole VAA signature / guardian-quorum verification
 * - Pyth Merkle proof verification
 *
 * Both are performed by the on-chain `oracle_script` against the same `binary`
 * blob the SDK echoes into `OracleUpdateWitness`. Re-implementing them here
 * would duplicate trust-critical code without strengthening the trust model
 * (the contract is the cryptographic authority, not the SDK). The SDK parser
 * is here only to populate the off-chain output cell when callers explicitly
 * opt into `outputSource: "binary"`.
 *
 * @internal — intentionally not part of the package's public API.
 */

import { bytesToHex, decodeHexFlexible } from "../internal/hex.js";
import type { FeedIdHex, HexString } from "../types/hex.js";

/** Outer accumulator wrapper magic (`"PNAU"`). */
const ACCUMULATOR_MAGIC = 0x504e4155;
/** Wormhole-merkle accumulator payload magic (`"AUWV"`). Reserved here for completeness; not parsed. */
const _ACCUMULATOR_WORMHOLE_MAGIC = 0x41555756;
/** Supported outer accumulator major version. */
const ACCUMULATOR_MAJOR_VERSION = 1;
/** Supported update type (WormholeMerkle). */
const UPDATE_TYPE_WORMHOLE_MERKLE = 0;
/** Supported message type (price-feed). */
const MESSAGE_TYPE_PRICE_FEED = 0;

void _ACCUMULATOR_WORMHOLE_MAGIC;

/**
 * Decoded `PriceFeedMessage` view, mirroring the Rust `PriceFeedMessage` struct.
 *
 * Integer widths follow Rust: `i64` / `u64` → `bigint`, `i32` → `number`.
 * `feedIdHex` is the canonical `0x` + 64-lowercase-hex form.
 *
 * @public
 */
export interface ParsedPriceFeedMessage {
  feedIdHex: FeedIdHex;
  price: bigint;
  conf: bigint;
  expo: number;
  publishTimeUnix: bigint;
  prevPublishTimeUnix: bigint;
  emaPrice: bigint;
  emaConf: bigint;
}

class Cursor {
  constructor(
    readonly buf: Uint8Array,
    public off: number = 0,
  ) {}

  private remaining(): number {
    return this.buf.length - this.off;
  }

  private demand(n: number): void {
    if (this.remaining() < n) {
      throw new Error(
        `accumulator parse error: truncated input (need ${String(n)} bytes at offset ${String(this.off)}, have ${String(this.remaining())})`,
      );
    }
  }

  readU8(): number {
    this.demand(1);
    return this.buf[this.off++]!;
  }

  readU16BE(): number {
    this.demand(2);
    const hi = this.buf[this.off]!;
    const lo = this.buf[this.off + 1]!;
    this.off += 2;
    return (hi << 8) | lo;
  }

  readU32BE(): number {
    this.demand(4);
    const v =
      this.buf[this.off]! * 0x1000000 +
      ((this.buf[this.off + 1]! << 16) |
        (this.buf[this.off + 2]! << 8) |
        this.buf[this.off + 3]!);
    this.off += 4;
    return v >>> 0;
  }

  readI32BE(): number {
    const u = this.readU32BE();
    return u >= 0x80000000 ? u - 0x100000000 : u;
  }

  readU64BE(): bigint {
    this.demand(8);
    let v = 0n;
    for (let i = 0; i < 8; i++) {
      v = (v << 8n) | BigInt(this.buf[this.off + i]!);
    }
    this.off += 8;
    return v;
  }

  readI64BE(): bigint {
    const u = this.readU64BE();
    return u >= 1n << 63n ? u - (1n << 64n) : u;
  }

  take(n: number): Uint8Array {
    this.demand(n);
    const slice = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return slice;
  }

  isFinished(): boolean {
    return this.off === this.buf.length;
  }
}

function normalizeFeedIdLower(feedId: FeedIdHex): HexString {
  const body = feedId.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(body)) {
    throw new Error(
      `accumulator parse error: invalid target feed id "${feedId}" (expected 32-byte hex)`,
    );
  }
  return `0x${body}`;
}

/**
 * Parse a Hermes accumulator (`PNAU`) blob and extract the `PriceFeedMessage`
 * for `targetFeedId`.
 *
 * Throws a plain `Error` on malformed input or when the target feed is not
 * present. Callers should wrap into a domain-specific SDK error for users.
 *
 * @internal
 */
export function parseAccumulatorBytesForFeed(
  bytes: Uint8Array,
  targetFeedId: FeedIdHex,
): ParsedPriceFeedMessage {
  const target = normalizeFeedIdLower(targetFeedId);
  const r = new Cursor(bytes);

  // ── Outer accumulator header ────────────────────────────────────────────
  const magic = r.readU32BE();
  if (magic !== ACCUMULATOR_MAGIC) {
    throw new Error(
      `accumulator parse error: wrong outer magic 0x${magic.toString(16).padStart(8, "0")} (expected "PNAU" / 0x504e4155)`,
    );
  }

  const major = r.readU8();
  if (major !== ACCUMULATOR_MAJOR_VERSION) {
    throw new Error(
      `accumulator parse error: unsupported major version ${String(major)} (expected ${String(ACCUMULATOR_MAJOR_VERSION)})`,
    );
  }

  r.readU8(); // minor — tolerated
  const trailingHeaderSize = r.readU8();
  r.take(trailingHeaderSize); // currently empty / forward-compat

  const updateType = r.readU8();
  if (updateType !== UPDATE_TYPE_WORMHOLE_MERKLE) {
    throw new Error(
      `accumulator parse error: unsupported update type ${String(updateType)} (expected WormholeMerkle/0)`,
    );
  }

  const whProofSize = r.readU16BE();
  // Skip the embedded VAA. We do NOT verify it client-side (see module doc).
  r.take(whProofSize);

  // ── Body: per-message price-feed entries with their merkle proofs ──────
  const numUpdates = r.readU8();
  let matched: ParsedPriceFeedMessage | undefined;

  for (let i = 0; i < numUpdates; i++) {
    void i;
    const messageSize = r.readU16BE();
    const messageBytes = r.take(messageSize);
    const proofSize = r.readU8();
    const proofByteLen = proofSize * 20;

    if (messageBytes.length < 33) {
      throw new Error(
        "accumulator parse error: truncated price-feed message (header < 33 bytes)",
      );
    }
    const msgType = messageBytes[0]!;
    const feedIdBytes = messageBytes.subarray(1, 33);
    const feedIdHex = bytesToHex(feedIdBytes);

    if (msgType !== MESSAGE_TYPE_PRICE_FEED) {
      // Mirror Rust: hard-fail only if this is the target feed; otherwise skip.
      if (feedIdHex === target) {
        throw new Error(
          `accumulator parse error: target feed ${target} carries unsupported message type ${String(msgType)}`,
        );
      }
      r.take(proofByteLen);
      continue;
    }

    if (feedIdHex === target) {
      if (matched !== undefined) {
        throw new Error(
          `accumulator parse error: target feed ${target} appears more than once`,
        );
      }
      r.take(proofByteLen); // skip merkle proof — verification is on-chain
      matched = parsePriceFeedMessage(messageBytes);
    } else {
      r.take(proofByteLen);
    }
  }

  if (!r.isFinished()) {
    throw new Error(
      `accumulator parse error: ${String(r.buf.length - r.off)} trailing bytes after body`,
    );
  }

  if (matched === undefined) {
    throw new Error(
      `accumulator parse error: target feed ${target} not present in accumulator`,
    );
  }

  return matched;
}

/**
 * Convenience: parse from a hex string (with or without `0x`).
 *
 * @internal
 */
export function parseAccumulatorHexForFeed(
  hex: string,
  targetFeedId: FeedIdHex,
): ParsedPriceFeedMessage {
  return parseAccumulatorBytesForFeed(decodeHexFlexible(hex), targetFeedId);
}

function parsePriceFeedMessage(messageBytes: Uint8Array): ParsedPriceFeedMessage {
  const r = new Cursor(messageBytes);
  r.readU8(); // type — already validated by caller
  const feedIdBytes = r.take(32);
  const price = r.readI64BE();
  const conf = r.readU64BE();
  const expo = r.readI32BE();
  const publishTimeUnix = r.readU64BE();
  const prevPublishTimeUnix = r.readU64BE();
  const emaPrice = r.readI64BE();
  const emaConf = r.readU64BE();

  if (!r.isFinished()) {
    throw new Error(
      "accumulator parse error: trailing bytes inside price-feed message",
    );
  }

  return {
    feedIdHex: bytesToHex(feedIdBytes),
    price,
    conf,
    expo,
    publishTimeUnix,
    prevPublishTimeUnix,
    emaPrice,
    emaConf,
  };
}
