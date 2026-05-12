/**
 * Fixture checks for oracle data decoding (152-byte fixed layout).
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import {
  ORACLE_CELL_DATA_BYTE_LENGTH,
  decodeOracleCellDataBytes,
  decodeLeanOracleCellDataHex,
} from "../dist/ckb/decodeOracleData.js";
import { LeanOracleCellDataDecodeError } from "../dist/errors.js";

assert.equal(ORACLE_CELL_DATA_BYTE_LENGTH, 152);

const fixture = new Uint8Array(152);
const dv = new DataView(fixture.buffer);

// feedId [0..32)
fixture.fill(0xaa, 0, 32);
const feedId = `0x${"aa".repeat(32)}`;

// guardianSetTypeHash [32..64)
fixture.fill(0xbb, 32, 64);
const guardianSetTypeHash = `0x${"bb".repeat(32)}`;

// price [64..72) i64 LE
dv.setBigInt64(64, -1234567890n, true);

// conf [72..80) u64 LE
dv.setBigUint64(72, 987654321n, true);

// expo [80..84) i32 LE
dv.setInt32(80, -8, true);

// publishTimeUnix [84..92) u64 LE
dv.setBigUint64(84, 1715235000n, true);

// prevPublishTimeUnix [92..100) u64 LE
dv.setBigUint64(92, 1715234000n, true);

// emaPrice [100..108) i64 LE
dv.setBigInt64(100, -1234567000n, true);

// emaConf [108..116) u64 LE
dv.setBigUint64(108, 987654000n, true);

// emitterChain [116..120) u32 LE
dv.setUint32(116, 26, true);

// emitterAddress [120..152)
fixture.fill(0xcc, 120, 152);
const emitterAddress = `0x${"cc".repeat(32)}`;

const decoded = decodeOracleCellDataBytes(fixture);
assert.deepEqual(decoded, {
  feedId,
  guardianSetTypeHash,
  price: -1234567890n,
  conf: 987654321n,
  expo: -8,
  publishTimeUnix: 1715235000n,
  prevPublishTimeUnix: 1715234000n,
  emaPrice: -1234567000n,
  emaConf: 987654000n,
  emitterChain: 26,
  emitterAddress,
});

const hex = "0x" + Array.from(fixture, (b) => b.toString(16).padStart(2, "0")).join("");
assert.deepEqual(decodeLeanOracleCellDataHex(hex), decoded);

assert.throws(
  () => decodeOracleCellDataBytes(new Uint8Array(151)),
  LeanOracleCellDataDecodeError,
);

assert.throws(
  () => decodeOracleCellDataBytes(new Uint8Array(153)),
  LeanOracleCellDataDecodeError,
);

console.log("decodeOracleData.fixture.mjs: PASS");
