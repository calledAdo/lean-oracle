/**
 * Fixture checks for `findLatestOracleLiveCellForFeed`:
 *   - returns the candidate with the greatest decoded `publishTimeUnix`
 *     even when the indexer yields a more recently committed but stale-by-publish
 *     cell first under `desc` order.
 *   - respects `minPublishTimeUnix` floor.
 *
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import { findLatestOracleLiveCellForFeed } from "../dist/ckb/findOracleCells.js";

const FEED_ID = `0x${"aa".repeat(32)}`;

function buildOracleCellDataHex({ publishTimeUnix }) {
  const buf = new Uint8Array(152);
  const dv = new DataView(buf.buffer);
  buf.fill(0xaa, 0, 32);          // feedId
  buf.fill(0xbb, 32, 64);         // guardianSetTypeHash
  dv.setBigInt64(64, 1n, true);   // price
  dv.setBigUint64(72, 1n, true);  // conf
  dv.setInt32(80, -8, true);      // expo
  dv.setBigUint64(84, publishTimeUnix, true);
  dv.setBigUint64(92, publishTimeUnix - 1n, true);
  dv.setBigInt64(100, 1n, true);
  dv.setBigUint64(108, 1n, true);
  dv.setUint32(116, 26, true);
  buf.fill(0xcc, 120, 152);
  return "0x" + Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

const deployment = {
  oracleType: { codeHash: `0x${"11".repeat(32)}`, hashType: "type" },
  canonicalPublicOracleLock: {
    script: { codeHash: `0x${"22".repeat(32)}`, hashType: "type", args: "0x" },
  },
};

function makeCell(txHashByte, index, publishTimeUnix) {
  return {
    outPoint: { txHash: `0x${txHashByte.toString(16).padStart(2, "0").repeat(32)}`, index: BigInt(index) },
    outputData: buildOracleCellDataHex({ publishTimeUnix }),
  };
}

function makeStubClient(cells) {
  return {
    // eslint-disable-next-line require-yield
    findCells: async function* () {
      for (const c of cells) yield c;
    },
  };
}

// Scenario 1: indexer `desc` returns a recently-committed but stale cell first.
// The latest-by-publishTime should still win.
{
  const cells = [
    makeCell(0x01, 0, 1_000_500n), // first in desc order, but lower publish time
    makeCell(0x02, 1, 1_000_900n), // older commit, but greatest publish time → winner
    makeCell(0x03, 2, 1_000_700n),
  ];
  const client = makeStubClient(cells);
  const result = await findLatestOracleLiveCellForFeed(client, FEED_ID, { deployment });
  assert.ok(result, "expected a result");
  assert.equal(result.outPoint.txHash, `0x${"02".repeat(32)}`);
  assert.equal(result.outPoint.index, 1n);
}

// Scenario 2: minPublishTimeUnix floor excludes everything.
{
  const cells = [
    makeCell(0x01, 0, 1_000_500n),
    makeCell(0x02, 1, 1_000_900n),
  ];
  const client = makeStubClient(cells);
  const result = await findLatestOracleLiveCellForFeed(client, FEED_ID, {
    deployment,
    minPublishTimeUnix: 2_000_000n,
  });
  assert.equal(result, undefined);
}

// Scenario 3: minPublishTimeUnix floor passes only one candidate.
{
  const cells = [
    makeCell(0x01, 0, 1_000_500n),
    makeCell(0x02, 1, 1_000_900n),
    makeCell(0x03, 2, 999_000n),
  ];
  const client = makeStubClient(cells);
  const result = await findLatestOracleLiveCellForFeed(client, FEED_ID, {
    deployment,
    minPublishTimeUnix: 1_000_800n,
  });
  assert.ok(result);
  assert.equal(result.outPoint.txHash, `0x${"02".repeat(32)}`);
}

// Scenario 4: ties on max publish time → first-seen (indexer desc order) wins.
{
  const cells = [
    makeCell(0x0a, 0, 1_000_900n), // first-seen at max → winner
    makeCell(0x0b, 1, 1_000_900n),
  ];
  const client = makeStubClient(cells);
  const result = await findLatestOracleLiveCellForFeed(client, FEED_ID, { deployment });
  assert.ok(result);
  assert.equal(result.outPoint.txHash, `0x${"0a".repeat(32)}`);
}

// Scenario 5: malformed candidate cell_data surfaces as a wrapped SDK error.
{
  const cells = [
    makeCell(0x01, 0, 1_000_500n),
    {
      outPoint: { txHash: `0x${"de".repeat(32)}`, index: 7n },
      outputData: "0xdeadbeef", // wrong length
    },
  ];
  const client = makeStubClient(cells);
  await assert.rejects(
    () => findLatestOracleLiveCellForFeed(client, FEED_ID, { deployment }),
    (err) => err && /Malformed oracle cell_data/.test(err.message),
  );
}

console.log("findLatestOracleLiveCellForFeed.fixture.mjs: PASS");
