/**
 * Fixture checks for OracleData encoding and validation.
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import {
  ORACLE_CELL_DATA_BYTE_LENGTH,
  decodeOracleCellDataBytes,
} from "../dist/ckb/decodeOracleData.js";
import { encodeOracleCellDataBytes } from "../dist/ckb/encodeOracleData.js";
import { LeanOracleOracleDataEncodeError } from "../dist/errors.js";

const valid = {
  feedId: `0x${"aa".repeat(32)}`,
  guardianSetTypeHash: `0x${"bb".repeat(32)}`,
  price: -(1n << 63n),
  conf: (1n << 64n) - 1n,
  expo: -0x8000_0000,
  publishTimeUnix: 1_777_704_299n,
  prevPublishTimeUnix: 1_777_704_000n,
  emaPrice: (1n << 63n) - 1n,
  emaConf: 42n,
  emitterChain: 26,
  emitterAddress: `0x${"cc".repeat(32)}`,
};

// 1. Encoding produces the fixed on-chain byte length and decodes back.
{
  const encoded = encodeOracleCellDataBytes(valid);
  assert.equal(encoded.length, ORACLE_CELL_DATA_BYTE_LENGTH);
  assert.deepEqual(decodeOracleCellDataBytes(encoded), valid);
}

// 2. Fixed 32-byte hex fields are strictly validated.
for (const [field, value] of [
  ["feedId", "0x1234"],
  ["guardianSetTypeHash", "0x1234"],
  ["emitterAddress", "0x1234"],
]) {
  assert.throws(
    () => encodeOracleCellDataBytes({ ...valid, [field]: value }),
    LeanOracleOracleDataEncodeError,
    `${field} should reject non-32-byte hex`,
  );
}

// 3. Integer bounds match the Rust layout.
for (const patch of [
  { price: -(1n << 63n) - 1n },
  { price: 1n << 63n },
  { emaPrice: 1n << 63n },
  { conf: -1n },
  { conf: 1n << 64n },
  { publishTimeUnix: -1n },
  { emaConf: 1n << 64n },
  { expo: -0x8000_0001 },
  { expo: 0x8000_0000 },
  { emitterChain: -1 },
  { emitterChain: 0x1_0000_0000 },
]) {
  const field = Object.keys(patch)[0];
  assert.throws(
    () => encodeOracleCellDataBytes({ ...valid, ...patch }),
    LeanOracleOracleDataEncodeError,
    `expected range rejection for ${field}`,
  );
}

console.log("encodeOracleData.fixture.mjs: PASS");
