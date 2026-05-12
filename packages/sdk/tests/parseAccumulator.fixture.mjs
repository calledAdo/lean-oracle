/**
 * Fixture checks for the Hermes accumulator parser + binary-source output builder.
 *
 * Source of truth: the same real Hermes BTC/USD `PNAU` blob used by the Rust
 * tests in `crates/lean_oracle/tests/src/hermes_real_fixture.rs`. Expected
 * decoded values (price/conf/expo/publish_time/...) are mirrored verbatim.
 *
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import {
  parseAccumulatorBytesForFeed,
  parseAccumulatorHexForFeed,
} from "../dist/hermes/parseAccumulator.js";
import {
  buildOracleOutputFromHermesBinary,
  buildOracleOutputFromHermesParsed,
  buildOracleOutputFromHermesUpdate,
} from "../dist/ckb/encodeOracleData.js";
import { LeanOracleOracleDataEncodeError } from "../dist/errors.js";

// ── Real Hermes fixture (verbatim copy of the Rust fixture) ────────────────
const REAL_HERMES_ACCUMULATOR_HEX = "504e41550100000003b801000000060d02217e8a20d22bfbb62c9b18d55a2583b8215010905aef30778e53bf6d54e4387c66c4ec70cd3273b50648080752525a6d6cdb8165c1a9bf6760d15563f482a46a000354aa569e7f112ff4a7a36ded41db453b31fe36c63f0207f6973e0f21d7a560c8482c9da1b1c8b1c173c26d2c5547a7e168d8235d1402afae031db2086914338900048e1a9c5c698ed61ea4755086366ea5059ab92ea03cb8b801a47055232d827e186931736f325f6cb5c77fd90bb6ac80cd6d01561515301f033449aaa89196529301063ee46fab759a10f62586505f1b774b9d629ac3483a77b9270eda07ab5211afef7d1ec083e058e89f098cae5e28e2e2984780dec2f96098b193f952eb31d989fb0007cab63ef2438ce2694c84d9d11fde54c5cb8d1c417f9531534fed389e49f9b1a2682c895010aaa2889034da42ea03524c1fc820f29668628259a58f283514860e0108a4be8e4a0a09ef7878dcaeb0ca4f9cf16ec9d570ded39483813d8ad0776b036b3a73996c4586f203d26e2a7526a5153eaefbaac37102b6362f602c28e1d754810009e0fd01a1c1c43d50a8d3d19efa96cfa9398741481bf6d3280d924d1a5a18adab31e2edd3ddc36cdb0b680c435e29d247a957f5c71957055fc5867025b752f196010a3ed2e004d35de2c5dcbb2c76fddd68f3e64eb0ea379ccd1bc59dba5e64d223af70a63b4f5075ff5aeba15a2bae490d9b26fdeb691143e5ba992148d3dc7e74a9000bb867aa0718bc4f230c967b8159c54787d0e3643fe0163558d04fe0fa423f83c85f1379d4db25c8ff9506e2881a8107528381586ec88961faefcbc4cd1be9378f000c87e5c091d4c8541be5b4a4c7927d29617684e0815422da49629cf74393055a6b571e2aa2097ce7571287723ffe27e166a51a7eef4ee3b3cae0dc0b44487f5a33000d10725ee024ddce2410672fe5f3db86842ecc66f5d8928239d6d544e14b80cd2b5c11b7e26af4492d768ac6f16bff543e833c422bc529d674b060cb67136e4b59010f4f9552f52b9cfcdac6423397ffc86c79499ea9637d82573fce4113887ce60103333dd9f0b528a24a35b1e4d715fa9c42f276fbd43c41cbb602ae1fe23c48020d0010fd242e2a5616eded987a2e8559ad9e45e3098f1996bfd673f3c2e1acc1b9a316102ee8be174ed203b5f6866eb43c0b4b465d91cf7b4a3dfc5b50cdb88094f81d0069f59d6b00000000001ae101faedac5851e32b9b23b5f9411a8c2bac4aae3ed4dd7b811dd1a72ea4aa71000000000c21723801415557560000000000112f1cd50000271011acb8a957280477ec8acf313a7bc3045bd6323701005500e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b430000071d5aec5fe4000000009c587248fffffff80000000069f59d6b0000000069f59d6b0000071d15221080000000009b4636d80dce40cc88aba021af3c2116cba066d8c36ef808dbd10bb2844a905f71cdbb5f6c7a099a6a37131055e68c4f4384f41b91617ea998b474d5eef5fe25815b02872da587fc6b92b7bfa498fe021ed03b5a1c89d6542ea00fa6297350b2ea99ce8270bb5e0006714f21eef844eb287c911dcb6c7c5331dfce0a5c0ab6f2b50298760a4944e31ddf9969d46616ae509651741a03b25bf86f61e504307d6f4e0937018d0ade14557fe913c42e2acdd30600f93aa0e5f1dd41d1663e2b060fcc501b52ded219b15af73bc5ca9d68a9b60d5e7b2cff15024eea1999d55d5c688dc35accfda38c2cf7d86ca5be4d779e5bba70b9559d7d208e3948986b0ce81ca6e55c56e0a7494687";

const BTC_USD_FEED_ID =
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

const EXPECTED = {
  feedIdHex: BTC_USD_FEED_ID,
  price: 7_822_660_886_500n,
  conf: 2_623_042_120n,
  expo: -8,
  publishTimeUnix: 1_777_704_299n,
  prevPublishTimeUnix: 1_777_704_299n,
  emaPrice: 7_821_490_000_000n,
  emaConf: 2_605_070_040n,
};

// 1. parseAccumulatorHexForFeed extracts the expected fields verbatim.
{
  const parsed = parseAccumulatorHexForFeed(
    REAL_HERMES_ACCUMULATOR_HEX,
    BTC_USD_FEED_ID,
  );
  assert.deepEqual(parsed, EXPECTED);
}

// 2. Bytes API agrees with hex API.
{
  const body = REAL_HERMES_ACCUMULATOR_HEX;
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  const parsed = parseAccumulatorBytesForFeed(out, BTC_USD_FEED_ID);
  assert.deepEqual(parsed, EXPECTED);
}

// 3. Asking for a feed not present in the accumulator throws a clear error.
{
  const otherFeed = "0x" + "11".repeat(32);
  assert.throws(
    () => parseAccumulatorHexForFeed(REAL_HERMES_ACCUMULATOR_HEX, otherFeed),
    /target feed.*not present/,
  );
}

// 4. Wrong outer magic throws.
{
  assert.throws(
    () => parseAccumulatorHexForFeed("0xdeadbeef" + "00".repeat(40), BTC_USD_FEED_ID),
    /wrong outer magic|truncated/,
  );
}

// 5. buildOracleOutputFromHermesBinary uses binary fields and preserves static fields.
{
  const inputOracle = {
    feedId: BTC_USD_FEED_ID,
    guardianSetTypeHash: `0x${"bb".repeat(32)}`,
    price: 1n,
    conf: 1n,
    expo: 0,
    publishTimeUnix: 0n,
    prevPublishTimeUnix: 0n,
    emaPrice: 1n,
    emaConf: 1n,
    emitterChain: 26,
    emitterAddress: `0x${"cc".repeat(32)}`,
  };
  const envelope = {
    binary: { encoding: "hex", data: [REAL_HERMES_ACCUMULATOR_HEX] },
    // intentionally NO `parsed`
  };
  const out = buildOracleOutputFromHermesBinary(
    inputOracle,
    envelope,
    BTC_USD_FEED_ID,
  );
  // Static fields preserved
  assert.equal(out.feedId, inputOracle.feedId);
  assert.equal(out.guardianSetTypeHash, inputOracle.guardianSetTypeHash);
  assert.equal(out.emitterChain, inputOracle.emitterChain);
  assert.equal(out.emitterAddress, inputOracle.emitterAddress);
  // Dynamic fields from binary
  assert.equal(out.price, EXPECTED.price);
  assert.equal(out.conf, EXPECTED.conf);
  assert.equal(out.expo, EXPECTED.expo);
  assert.equal(out.publishTimeUnix, EXPECTED.publishTimeUnix);
  assert.equal(out.prevPublishTimeUnix, EXPECTED.prevPublishTimeUnix);
  assert.equal(out.emaPrice, EXPECTED.emaPrice);
  assert.equal(out.emaConf, EXPECTED.emaConf);
}

// 6. buildOracleOutputFromHermesBinary throws domain SDK error for missing feed.
{
  const inputOracle = {
    feedId: "0x" + "11".repeat(32),
    guardianSetTypeHash: `0x${"bb".repeat(32)}`,
    price: 1n,
    conf: 1n,
    expo: 0,
    publishTimeUnix: 0n,
    prevPublishTimeUnix: 0n,
    emaPrice: 1n,
    emaConf: 1n,
    emitterChain: 26,
    emitterAddress: `0x${"cc".repeat(32)}`,
  };
  const envelope = {
    binary: { encoding: "hex", data: [REAL_HERMES_ACCUMULATOR_HEX] },
  };
  assert.throws(
    () =>
      buildOracleOutputFromHermesBinary(
        inputOracle,
        envelope,
        "0x" + "11".repeat(32),
      ),
    LeanOracleOracleDataEncodeError,
  );
}

// 7. Default-path builder still requires `parsed` (parity with prior behavior).
{
  const inputOracle = {
    feedId: BTC_USD_FEED_ID,
    guardianSetTypeHash: `0x${"bb".repeat(32)}`,
    price: 1n,
    conf: 1n,
    expo: 0,
    publishTimeUnix: 0n,
    prevPublishTimeUnix: 0n,
    emaPrice: 1n,
    emaConf: 1n,
    emitterChain: 26,
    emitterAddress: `0x${"cc".repeat(32)}`,
  };
  const envelopeNoParsed = {
    binary: { encoding: "hex", data: [REAL_HERMES_ACCUMULATOR_HEX] },
  };
  assert.throws(
    () =>
      buildOracleOutputFromHermesParsed(
        inputOracle,
        envelopeNoParsed,
        BTC_USD_FEED_ID,
      ),
    LeanOracleOracleDataEncodeError,
  );
}

// 8. Parsed-path builder works when `parsed` is supplied.
{
  const inputOracle = {
    feedId: BTC_USD_FEED_ID,
    guardianSetTypeHash: `0x${"bb".repeat(32)}`,
    price: 1n,
    conf: 1n,
    expo: 0,
    publishTimeUnix: 0n,
    prevPublishTimeUnix: 0n,
    emaPrice: 1n,
    emaConf: 1n,
    emitterChain: 26,
    emitterAddress: `0x${"cc".repeat(32)}`,
  };
  const envelope = {
    binary: { encoding: "hex", data: [REAL_HERMES_ACCUMULATOR_HEX] },
    parsed: [
      {
        id: BTC_USD_FEED_ID,
        price: {
          price: String(EXPECTED.price),
          conf: String(EXPECTED.conf),
          expo: EXPECTED.expo,
          publish_time: Number(EXPECTED.publishTimeUnix),
        },
        ema_price: {
          price: String(EXPECTED.emaPrice),
          conf: String(EXPECTED.emaConf),
          expo: EXPECTED.expo,
          publish_time: Number(EXPECTED.publishTimeUnix),
        },
        metadata: {
          slot: 0,
          proof_available_time: 0,
          prev_publish_time: Number(EXPECTED.prevPublishTimeUnix),
        },
      },
    ],
  };
  const out = buildOracleOutputFromHermesParsed(
    inputOracle,
    envelope,
    BTC_USD_FEED_ID,
  );
  assert.equal(out.price, EXPECTED.price);
  assert.equal(out.publishTimeUnix, EXPECTED.publishTimeUnix);
}

// 9. Unified builder, default mode → uses parsed and matches the parsed-path output.
{
  const inputOracle = {
    feedId: BTC_USD_FEED_ID,
    guardianSetTypeHash: `0x${"bb".repeat(32)}`,
    price: 1n,
    conf: 1n,
    expo: 0,
    publishTimeUnix: 0n,
    prevPublishTimeUnix: 0n,
    emaPrice: 1n,
    emaConf: 1n,
    emitterChain: 26,
    emitterAddress: `0x${"cc".repeat(32)}`,
  };
  const envelope = {
    binary: { encoding: "hex", data: [REAL_HERMES_ACCUMULATOR_HEX] },
    parsed: [
      {
        id: BTC_USD_FEED_ID,
        price: {
          price: String(EXPECTED.price),
          conf: String(EXPECTED.conf),
          expo: EXPECTED.expo,
          publish_time: Number(EXPECTED.publishTimeUnix),
        },
        ema_price: {
          price: String(EXPECTED.emaPrice),
          conf: String(EXPECTED.emaConf),
          expo: EXPECTED.expo,
          publish_time: Number(EXPECTED.publishTimeUnix),
        },
        metadata: {
          slot: 0,
          proof_available_time: 0,
          prev_publish_time: Number(EXPECTED.prevPublishTimeUnix),
        },
      },
    ],
  };
  const expectedParsed = buildOracleOutputFromHermesParsed(
    inputOracle,
    envelope,
    BTC_USD_FEED_ID,
  );
  const unifiedDefault = buildOracleOutputFromHermesUpdate({
    inputOracle,
    hermesEnvelope: envelope,
    feedId: BTC_USD_FEED_ID,
  });
  assert.deepEqual(unifiedDefault, expectedParsed);
  const unifiedExplicit = buildOracleOutputFromHermesUpdate({
    inputOracle,
    hermesEnvelope: envelope,
    feedId: BTC_USD_FEED_ID,
    outputSource: "hermes-parsed",
  });
  assert.deepEqual(unifiedExplicit, expectedParsed);
}

// 10. Unified builder, binary mode → works without parsed and matches the binary-path output.
{
  const inputOracle = {
    feedId: BTC_USD_FEED_ID,
    guardianSetTypeHash: `0x${"bb".repeat(32)}`,
    price: 1n,
    conf: 1n,
    expo: 0,
    publishTimeUnix: 0n,
    prevPublishTimeUnix: 0n,
    emaPrice: 1n,
    emaConf: 1n,
    emitterChain: 26,
    emitterAddress: `0x${"cc".repeat(32)}`,
  };
  const envelopeNoParsed = {
    binary: { encoding: "hex", data: [REAL_HERMES_ACCUMULATOR_HEX] },
  };
  const expectedBinary = buildOracleOutputFromHermesBinary(
    inputOracle,
    envelopeNoParsed,
    BTC_USD_FEED_ID,
  );
  const unifiedBinary = buildOracleOutputFromHermesUpdate({
    inputOracle,
    hermesEnvelope: envelopeNoParsed,
    feedId: BTC_USD_FEED_ID,
    outputSource: "binary",
  });
  assert.deepEqual(unifiedBinary, expectedBinary);
  assert.equal(unifiedBinary.price, EXPECTED.price);
  assert.equal(unifiedBinary.publishTimeUnix, EXPECTED.publishTimeUnix);
}

// 11. Unified builder, default mode without parsed → throws (no silent fallback).
{
  const inputOracle = {
    feedId: BTC_USD_FEED_ID,
    guardianSetTypeHash: `0x${"bb".repeat(32)}`,
    price: 1n,
    conf: 1n,
    expo: 0,
    publishTimeUnix: 0n,
    prevPublishTimeUnix: 0n,
    emaPrice: 1n,
    emaConf: 1n,
    emitterChain: 26,
    emitterAddress: `0x${"cc".repeat(32)}`,
  };
  const envelopeNoParsed = {
    binary: { encoding: "hex", data: [REAL_HERMES_ACCUMULATOR_HEX] },
  };
  assert.throws(
    () =>
      buildOracleOutputFromHermesUpdate({
        inputOracle,
        hermesEnvelope: envelopeNoParsed,
        feedId: BTC_USD_FEED_ID,
        // outputSource omitted — default "hermes-parsed"
      }),
    LeanOracleOracleDataEncodeError,
  );
}

console.log("parseAccumulator.fixture.mjs: PASS");
