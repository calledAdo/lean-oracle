/**
 * @packageDocumentation
 *
 * Witness layout matches Rust **`OracleUpdateWitness::to_bytes`**
 * (`contracts/common/src/oracle_witness.rs` in **`lean-oracle`**).
 *
 * **`oracle_script`** loads the group-input witness **`lock`** field and parses
 * **`OracleUpdateWitness::from_bytes`**:
 *
 * - **4 bytes** — `accumulator_update.len()` as **`u32` little-endian**.
 * - **`len` bytes** — raw Pyth **PNAU** accumulator blob (**exact Hermes `binary.data[n]`**, not base64-decoded JWT,
 *   not double-wrapped CBOR — just the verifier bytes Hermes emits when `encoding=hex`).
 */

import { LeanOracleWitnessEncodingError } from "../errors.js";
import type { HexString } from "../types/hex.js";

/** Maximum accumulator payload size (`u32`) — matches CKB **`read_u32_le`** truncation semantics. */
const MAX_ACCUMULATOR_LEN = 0xffffffff;

/**
 * Decode a lax hex literal into bytes (Hermes blobs are often **`504e4155…`** without `0x`).
 *
 * - Strips ASCII whitespace everywhere (Hermes tooling sometimes pretty-prints with newlines).
 * - Optional **`0x` / `0X`** prefix.
 * - Rejects odd-length nibbles / non-hex characters with **`LeanOracleWitnessEncodingError`**.
 */
function decodeHexFlexible(label: string, hex: HexString): Uint8Array {
  /*
   * Collapse stray whitespace copied from explorers / jq output so clients don’t
   * brittle-fail on formatting alone.
   */
  const flattened = hex.trim().replace(/\s+/g, "");
  const body =
    flattened.startsWith("0x") || flattened.startsWith("0X")
      ? flattened.slice(2)
      : flattened;

  if (body.length % 2 !== 0) {
    throw new LeanOracleWitnessEncodingError(
      `${label}: hex string length must be even (${String(body.length)} nibbles)`,
    );
  }

  const out = new Uint8Array(body.length / 2);
  /**
   * Why loop through the entire `body`? Is there a better way?
   *
   * The loop processes each hex pair into a byte, since JavaScript's `Uint8Array.from` does
   * not natively support creating from a hex string, and Buffer usage is usually eschewed in cross-platform JS.
   *
   * This is a standard approach for most small-to-medium sized blobs—Hermes accumulator
   * hex strings are typically ~1-4KB, rarely approaching the many-MB range, so the O(n)
   * loop is not a practical bottleneck (and avoids Node-only shims).
   *
   * For alternatives: Buffer.from(body, "hex") is faster but not portable to browsers and throws
   * on invalid hex. For purely browser environments, one could use typed array tricks, but validation
   * is less user-friendly than with this manual step.
   */
  for (let i = 0; i < body.length; i += 2) {
    const slice = body.slice(i, i + 2);
    const byte = Number.parseInt(slice, 16);
    if (!Number.isFinite(byte) || byte < 0 || byte > 0xff) {
      throw new LeanOracleWitnessEncodingError(
        `${label}: invalid hex byte literal "${slice}" at offset ${String(i)}`,
      );
    }
    out[i / 2] = byte;
  }
  return out;
}

/**
 * Serialize **`OracleUpdateWitness`** from decoded accumulator bytes.
 *
 * Mirrors **`OracleUpdateWitness::to_bytes`** in **`oracle_witness.rs`**: prefixed length + payload.
 *
 * Use this when Hermes **`encoding=base64`** produced bytes already ( **`atob`/Buffer** decoded )
 * instead of chaining another hex decoder.
 *
 * @public
 */
export function encodeOracleUpdateWitnessFromAccumulatorBytes(
  accumulatorUpdate: Uint8Array,
): Uint8Array {
  /*
   * In JavaScript **`ArrayBuffer` max size (~2 GiB on V8)** already caps practical blobs,
   * but we explicitly guard **`u32` overflow** because that is the on-chain framing contract.
   */
  const len = accumulatorUpdate.length;
  if (len > MAX_ACCUMULATOR_LEN) {
    throw new LeanOracleWitnessEncodingError(
      `Accumulator payload length ${String(len)} exceeds u32 (${String(MAX_ACCUMULATOR_LEN)})`,
    );
  }

  /*
   * Allocate contiguous buffer: avoid mutating **`accumulatorUpdate`**
   * in case callers reuse a pooled **`Uint8Array`** view afterwards.
   */
  const witness = new Uint8Array(4 + len);

  /*
   * Little-endian **`u32` length prefix** identical to **`u32::to_le_bytes`** in Rust —
   * `DataView.setUint32` handles endianness deterministically regardless of CPU host order.
   */
  new DataView(witness.buffer, witness.byteOffset, 4).setUint32(0, len, true);

  witness.set(accumulatorUpdate, 4);
  return witness;
}

/**
 * Decode Hermes accumulator **hex string** (**`binary.data[*]`**) and prepend the CKB **`OracleUpdateWitness`** header.
 *
 * ### Typical pairing with Hermes
 *
 * ```typescript
 * const env = await fetchHermesLatestPriceUpdates(network, [feed]);
 * assert(env.binary.encoding === "hex");
 * const witnessLock = encodeOracleUpdateWitnessFromAccumulatorHex(env.binary.data[0]);
 * ```
 *
 * CCC then places **`witnessLock`** into the oracle cell lock witness field wired to **`oracle_script`**.
 *
 * @public
 */
export function encodeOracleUpdateWitnessFromAccumulatorHex(
  accumulatorHex: HexString,
): Uint8Array {
  /*
   * Step ① — nibbles → bytes (PNAU… raw accumulator).
   * Step ② — wrap with **`LE u32` length** for contract consumption.
   */
  const accumulator = decodeHexFlexible(
    "Hermes accumulator hex",
    accumulatorHex,
  );
  return encodeOracleUpdateWitnessFromAccumulatorBytes(accumulator);
}
