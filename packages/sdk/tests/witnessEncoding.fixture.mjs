/**
 * Fixture checks for OracleUpdateWitness encoding.
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import {
  encodeOracleUpdateWitnessFromAccumulatorBytes,
  encodeOracleUpdateWitnessFromAccumulatorHex,
} from "../dist/advanced.js";
import { LeanOracleWitnessEncodingError } from "../dist/errors.js";

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// 1. Bytes API prefixes a little-endian u32 length and preserves payload.
{
  const payload = Uint8Array.from([0x50, 0x4e, 0x41, 0x55, 0x01]);
  const witness = encodeOracleUpdateWitnessFromAccumulatorBytes(payload);
  assert.equal(hex(witness.subarray(0, 4)), "05000000");
  assert.deepEqual([...witness.subarray(4)], [...payload]);
  assert.equal(hex(payload), "504e415501", "input payload must not be mutated");
}

// 2. Empty payload is representable as a zero-length witness body.
{
  const witness = encodeOracleUpdateWitnessFromAccumulatorBytes(new Uint8Array());
  assert.equal(hex(witness), "00000000");
}

// 3. Hex API accepts optional 0x prefix, whitespace, and mixed case.
{
  const witness = encodeOracleUpdateWitnessFromAccumulatorHex("0x50 4E\n4155");
  assert.equal(hex(witness), "04000000504e4155");
}

// 4. Bad hex is wrapped as the public witness error type.
assert.throws(
  () => encodeOracleUpdateWitnessFromAccumulatorHex("0xabc"),
  LeanOracleWitnessEncodingError,
);

assert.throws(
  () => encodeOracleUpdateWitnessFromAccumulatorHex("0xzz"),
  LeanOracleWitnessEncodingError,
);

console.log("witnessEncoding.fixture.mjs: PASS");
