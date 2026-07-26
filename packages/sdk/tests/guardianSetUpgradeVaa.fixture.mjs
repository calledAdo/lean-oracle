/**
 * Fixture checks for parsing Wormhole guardian-set-upgrade governance VAAs and
 * the derived quorum. Mirrors the on-chain Rust parser in
 * `contracts/common/src/governance.rs`. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  parseGuardianSetUpgradeVaa,
  wormholeQuorum,
  WORMHOLE_GOVERNANCE_EMITTER_ADDRESS,
  WORMHOLE_GOVERNANCE_MODULE_CORE,
} from "../dist/wormhole/index.js";
import { LeanOracleSdkError } from "../dist/errors.js";

// ── wormholeQuorum: floor(2n/3)+1 ─────────────────────────────────────────────
assert.equal(wormholeQuorum(1), 1);
assert.equal(wormholeQuorum(2), 2);
assert.equal(wormholeQuorum(3), 3);
assert.equal(wormholeQuorum(19), 13);

// ── Build a canonical guardian-set-upgrade governance VAA ─────────────────────
function hexToBytes(hex) {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function buildUpgradeVaa({
  signingSetIndex,
  newIndex,
  addresses,
  emitterChain = 1,
  emitterAddress = WORMHOLE_GOVERNANCE_EMITTER_ADDRESS,
  module = WORMHOLE_GOVERNANCE_MODULE_CORE,
  action = 2,
  targetChain = 0,
  sigCount = 1,
}) {
  const parts = [];
  const push = (arr) => parts.push(Uint8Array.from(arr));
  const u16be = (n) => [(n >> 8) & 0xff, n & 0xff];
  const u32be = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

  // Header: version, guardian_set_index, sig_count, then sigCount*66 sig bytes.
  push([1]);
  push(u32be(signingSetIndex));
  push([sigCount]);
  for (let i = 0; i < sigCount; i++) push(new Array(66).fill(0));

  // Body prefix (51 bytes): timestamp, nonce, emitter_chain, emitter_address,
  // sequence, consistency.
  push(u32be(1000)); // timestamp
  push(u32be(0)); // nonce
  push(u16be(emitterChain));
  push(hexToBytes(emitterAddress));
  push(new Array(8).fill(0)); // sequence
  push([1]); // consistency

  // Governance packet payload.
  push(hexToBytes(module));
  push([action]);
  push(u16be(targetChain));
  push(u32be(newIndex));
  push([addresses.length]);
  for (const a of addresses) push(hexToBytes(a));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const p of parts) {
    out.set(p, cursor);
    cursor += p.length;
  }
  return out;
}

const addrs = [`0x${"22".repeat(20)}`, `0x${"33".repeat(20)}`];

const OFFICIAL_V7_FIXTURE = new URL(
  "../../../fixtures/wormhole/mainnet-guardian-set-upgrade-v7.hex",
  import.meta.url,
);
const officialV7Hex = fs.readFileSync(OFFICIAL_V7_FIXTURE, "utf8").trim();
const officialV7Addresses = [
  "0x5893b5a76c3f739645648885bdccc06cd70a3cd3",
  "0xff6cb952589bde862c25ef4392132fb9d4a42157",
  "0x114de8460193bdf3a2fcf81f86a09765f4762fd1",
  "0x107a0086b32d7a0977926a205131d8731d39cbeb",
  "0x8c82b2fd82faed2711d59af0f2499d16e726f6b2",
  "0x42579bffbcf4276e290ab8e4c162bd4052b97970",
  "0x938f104aeb5581293216ce97d771e0cb721221b1",
  "0xf3ea0ad4ffb5a178ae4ebc21861651b25bdcbb91",
  "0x9d16870160e703324d057c3361c34c5befba2c34",
  "0x000ac0076727b35fbea2dac28fee5ccb0fea768e",
  "0xaf45ced136b9d9e24903464ae889f5c8a723fc14",
  "0xf93124b7c738843cbb89e864c862c38cddcccf95",
  "0xd2cc37a4dc036a8d232b48f62cdd4731412f4890",
  "0xda798f6896a3331f64b48c12d1d57fd9cbe70811",
  "0xae565927bb8db25cd8bf3e7bb663d70023e4ea78",
  "0x3f851ad586a47cef8d04748f33ab0d71395f06b4",
  "0x178e21ad2e77ae06711549cfbb1f9c7a9d8096e8",
  "0x7899ceab1dc961dae9defdb7a4f521269a5448fc",
  "0x61d9800f9fcb4160fb0c6cf3a0902592bac2b434",
];

// ── Happy path ────────────────────────────────────────────────────────────────
const vaa = buildUpgradeVaa({ signingSetIndex: 1, newIndex: 2, addresses: addrs });
const parsed = parseGuardianSetUpgradeVaa(vaa);
assert.deepEqual(parsed, {
  signingSetIndex: 1,
  newIndex: 2,
  addresses: addrs,
  quorum: 2,
});

// Multi-signature header offset handling (13 sigs) must still parse identically.
const vaaMultiSig = buildUpgradeVaa({
  signingSetIndex: 4,
  newIndex: 5,
  addresses: addrs,
  sigCount: 13,
});
assert.deepEqual(parseGuardianSetUpgradeVaa(vaaMultiSig), {
  signingSetIndex: 4,
  newIndex: 5,
  addresses: addrs,
  quorum: 2,
});

// Production fixture: the canonical Wormhole mainnet set 6 -> 7 upgrade.
const officialParsed = parseGuardianSetUpgradeVaa(`0x${officialV7Hex}`);
assert.deepEqual(officialParsed, {
  signingSetIndex: 6,
  newIndex: 7,
  addresses: officialV7Addresses,
  quorum: 13,
});
assert.equal(officialV7Hex.length / 2, 1401);
assert.equal(
  createHash("sha256").update(Buffer.from(officialV7Hex, "hex")).digest("hex"),
  "bc4e5ce8ce1622f03414ace104f123680ef28ce9cecf537640de829d1c8dfe31",
);

// ── Negative: wrong emitter, module, action, target chain, trailing bytes ─────
assert.throws(
  () =>
    parseGuardianSetUpgradeVaa(
      buildUpgradeVaa({
        signingSetIndex: 1,
        newIndex: 2,
        addresses: addrs,
        emitterAddress: `0x${"99".repeat(32)}`,
      }),
    ),
  LeanOracleSdkError,
);

assert.throws(
  () =>
    parseGuardianSetUpgradeVaa(
      buildUpgradeVaa({
        signingSetIndex: 1,
        newIndex: 2,
        addresses: addrs,
        action: 99,
      }),
    ),
  LeanOracleSdkError,
);

assert.throws(
  () =>
    parseGuardianSetUpgradeVaa(
      buildUpgradeVaa({
        signingSetIndex: 1,
        newIndex: 2,
        addresses: addrs,
        targetChain: 26,
      }),
    ),
  LeanOracleSdkError,
);

// Trailing byte after the declared address list.
const good = buildUpgradeVaa({ signingSetIndex: 1, newIndex: 2, addresses: addrs });
const withTrailing = new Uint8Array(good.length + 1);
withTrailing.set(good, 0);
assert.throws(() => parseGuardianSetUpgradeVaa(withTrailing), LeanOracleSdkError);

console.log("guardianSetUpgradeVaa.fixture.mjs: OK");
