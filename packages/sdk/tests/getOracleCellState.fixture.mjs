/**
 * Fixture checks for `LeanOracleClient.getOracleCellState`:
 *   - returns decoded data + outpoint + raw hex when a cell exists
 *   - returns undefined when discovery yields nothing (or floor excludes all)
 *
 * Uses an injected fake CCC client so we don't hit the network.
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import { LeanOracleClient } from "../dist/client/LeanOracleClient.js";

const FEED_ID = `0x${"aa".repeat(32)}`;

function buildOracleCellDataHex({ publishTimeUnix }) {
  const buf = new Uint8Array(152);
  const dv = new DataView(buf.buffer);
  buf.fill(0xaa, 0, 32);
  buf.fill(0xbb, 32, 64);
  dv.setBigInt64(64, 12345n, true);
  dv.setBigUint64(72, 67n, true);
  dv.setInt32(80, -8, true);
  dv.setBigUint64(84, publishTimeUnix, true);
  dv.setBigUint64(92, publishTimeUnix - 1n, true);
  dv.setBigInt64(100, 12000n, true);
  dv.setBigUint64(108, 50n, true);
  dv.setUint32(116, 26, true);
  buf.fill(0xcc, 120, 152);
  return "0x" + Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

const network = {
  name: "testnet",
  ckbJsonRpcUrl: "http://stub.invalid",
  hermesBaseUrl: "http://stub.invalid",
  deployment: {
    oracleType: { codeHash: `0x${"11".repeat(32)}`, hashType: "type" },
    defaultPublicOracleLock: {
      script: { codeHash: `0x${"22".repeat(32)}`, hashType: "type", args: "0x" },
    },
  },
};

function makeStubCccClient(cells) {
  return {
    findCells: async function* () {
      for (const c of cells) yield c;
    },
  };
}

// 1. Cell exists → decoded result.
{
  const cell = {
    outPoint: { txHash: `0x${"33".repeat(32)}`, index: 0n },
    outputData: buildOracleCellDataHex({ publishTimeUnix: 1_700_000_000n }),
  };
  const cccClient = makeStubCccClient([cell]);
  const client = new LeanOracleClient({ network, cccClient });

  const state = await client.getOracleCellState({ feedId: FEED_ID });
  assert.ok(state, "expected a state");
  assert.equal(state.outPoint.txHash, cell.outPoint.txHash);
  assert.equal(state.outPoint.index, 0n);
  assert.equal(state.oracleDataHex, cell.outputData);
  assert.equal(state.data.publishTimeUnix, 1_700_000_000n);
  assert.equal(state.data.price, 12345n);
  assert.equal(state.data.expo, -8);
}

// 2. No matching cells → undefined.
{
  const client = new LeanOracleClient({
    network,
    cccClient: makeStubCccClient([]),
  });
  const state = await client.getOracleCellState({ feedId: FEED_ID });
  assert.equal(state, undefined);
}

// 3. minPublishTimeUnix excludes everything → undefined.
{
  const cell = {
    outPoint: { txHash: `0x${"44".repeat(32)}`, index: 0n },
    outputData: buildOracleCellDataHex({ publishTimeUnix: 1_000_000n }),
  };
  const client = new LeanOracleClient({
    network,
    cccClient: makeStubCccClient([cell]),
  });
  const state = await client.getOracleCellState({
    feedId: FEED_ID,
    minPublishTimeUnix: 9_999_999_999n,
  });
  assert.equal(state, undefined);
}

console.log("getOracleCellState.fixture.mjs: PASS");
