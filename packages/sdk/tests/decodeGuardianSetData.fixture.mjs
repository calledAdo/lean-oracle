/**
 * Fixture checks for guardian-set decoding (12-byte header + 20 * count addresses).
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import {
  GUARDIAN_SET_HEADER_BYTE_LENGTH,
  decodeGuardianSetCellDataBytes,
  decodeGuardianSetCellDataHex,
} from "../dist/ckb/decodeGuardianSetData.js";
import { LeanOracleGuardianSetDataDecodeError } from "../dist/errors.js";

assert.equal(GUARDIAN_SET_HEADER_BYTE_LENGTH, 12);

const fixture = new Uint8Array(52);
const dv = new DataView(fixture.buffer);
dv.setUint32(0, 3, true);
dv.setUint32(4, 2, true);
dv.setUint32(8, 2, true);
fixture.fill(0x11, 12, 32);
fixture.fill(0x22, 32, 52);

const addr1 = `0x${"11".repeat(20)}`;
const addr2 = `0x${"22".repeat(20)}`;

const decoded = decodeGuardianSetCellDataBytes(fixture);
assert.deepEqual(decoded, {
  setIndex: 3,
  quorum: 2,
  guardianAddresses: [addr1, addr2],
});

const hex =
  "0x" +
  [...fixture].map((b) => b.toString(16).padStart(2, "0")).join("");
assert.deepEqual(decodeGuardianSetCellDataHex(hex), decoded);

assert.throws(
  () => decodeGuardianSetCellDataBytes(new Uint8Array(11)),
  LeanOracleGuardianSetDataDecodeError,
);

assert.throws(
  () => decodeGuardianSetCellDataBytes(new Uint8Array(53)),
  LeanOracleGuardianSetDataDecodeError,
);

assert.throws(
  () => decodeGuardianSetCellDataHex("0xzz"),
  LeanOracleGuardianSetDataDecodeError,
);
