/**
 * @packageDocumentation
 *
 * Witness layout matches Rust **`OracleUpdateWitness::to_bytes`**
 * (`contracts/common/src/oracle_witness.rs` in **`lean-oracle`**).
 *
 * **`oracle_script`** loads the group-input witness **`input_type`** field and parses
 * **`OracleUpdateWitness::from_bytes`**:
 *
 * - **4 bytes** — `accumulator_update.len()` as **`u32` little-endian**.
 * - **`len` bytes** — raw Pyth **PNAU** accumulator blob (**exact Hermes `binary.data[n]`**, not base64-decoded JWT,
 *   not double-wrapped CBOR — just the verifier bytes Hermes emits when `encoding=hex`).
 */

import { LeanOracleWitnessEncodingError } from "../errors.js";
import type { HexString } from "../types/hex.js";
import { decodeHexFlexible as decodeHexInternal } from "../internal/hex.js";

/** Maximum accumulator payload size (`u32`) — matches CKB **`read_u32_le`** truncation semantics. */
const MAX_ACCUMULATOR_LEN = 0xffffffff;

/**
 * Decode a lax hex literal into bytes (Hermes blobs are often **`504e4155…`** without `0x`).
 */
function decodeHexFlexible(label: string, hex: HexString): Uint8Array {
  try {
    return decodeHexInternal(hex);
  } catch (e) {
    throw new LeanOracleWitnessEncodingError(`${label}: ${(e as Error).message}`);
  }
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
 * const oracleWitness = encodeOracleUpdateWitnessFromAccumulatorHex(env.binary.data[0]);
 * ```
 *
 * CCC then places **`oracleWitness`** into the oracle cell **`input_type`** witness field wired to **`oracle_script`**.
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
