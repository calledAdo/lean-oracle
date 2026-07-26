/**
 * Fixture checks for optional CCC client injection on LeanOracleClient and presets.
 * Run after `npm run build` from the SDK package root.
 */
import assert from "node:assert/strict";
import { LeanOracleClient } from "../dist/client/LeanOracleClient.js";
import {
  LeanOracleTestnetClient,
  LeanOracleMainnetClient,
} from "../dist/client/presets.js";
import { leanOracleTestnetPreset } from "../dist/presets/testnet.js";
import { LeanOracleSdkError } from "../dist/errors.js";

const fakeCcc = { __fake: true };

// 1. Direct LeanOracleClient: injected client is stored verbatim.
{
  const oracle = new LeanOracleClient({
    network: leanOracleTestnetPreset,
    cccClient: fakeCcc,
  });
  assert.strictEqual(oracle.cccClient, fakeCcc);
}

// 2. Direct LeanOracleClient: omitted cccClient → default public client constructed.
{
  const oracle = new LeanOracleClient({ network: leanOracleTestnetPreset });
  assert.ok(oracle.cccClient, "expected a default cccClient");
  assert.notStrictEqual(oracle.cccClient, fakeCcc);
}

// 3. LeanOracleTestnetClient: zero-arg still works.
{
  const oracle = new LeanOracleTestnetClient();
  assert.ok(oracle.cccClient);
}

// 4. LeanOracleTestnetClient: injection wired through.
{
  const oracle = new LeanOracleTestnetClient({ cccClient: fakeCcc });
  assert.strictEqual(oracle.cccClient, fakeCcc);
}

// 5. LeanOracleMainnetClient: zero-arg still works.
{
  const oracle = new LeanOracleMainnetClient();
  assert.ok(oracle.cccClient);
}

// 6. LeanOracleMainnetClient: injection wired through.
{
  const oracle = new LeanOracleMainnetClient({ cccClient: fakeCcc });
  assert.strictEqual(oracle.cccClient, fakeCcc);
}

// 7. Mainnet CKB operations reject before issuing indexer/RPC work.
{
  let findCalls = 0;
  const countingCcc = {
    findCells() {
      findCalls += 1;
      return (async function* emptyCells() {})();
    },
  };
  const oracle = new LeanOracleMainnetClient({ cccClient: countingCcc });
  await assert.rejects(
    () =>
      oracle.getOracleCellState({
        feedId:
          "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
      }),
    (err) =>
      err instanceof LeanOracleSdkError && /not deployed.*mainnet/i.test(err.message),
  );
  assert.equal(findCalls, 0, "unavailable deployment must fail before CKB discovery");
}

console.log("clientCccInjection.fixture.mjs: PASS");
