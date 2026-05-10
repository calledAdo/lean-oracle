# SDK Devnet Integration Tests Design

## Goal

Add an explicit integration-test framework for the TypeScript SDK that validates
real SDK behavior against an already-deployed local CKB devnet.

The first version does not provision or reset devnet. It assumes the deployment
toolbox has already broadcast the Lean Oracle code cells, guardian-set state
cell, and oracle state cell, and that the corresponding local artifacts exist
under `deployment/artifacts/`.

## Scope

In scope:

- A dedicated SDK integration test command for local devnet.
- A small devnet test harness that loads deployment artifacts and environment
  values.
- Tests that exercise the compiled SDK public and advanced surfaces against a
  real devnet RPC.
- Clear skip/setup behavior when devnet prerequisites are absent.
- Documentation of required local setup.

Out of scope for this first slice:

- Automatic devnet provisioning or reset.
- CI orchestration for launching offckb.
- Mainnet/testnet live integration tests.
- Replacing the current fast fixture checks.

## Tooling Choice

Use Node's built-in `node:test` runner for devnet integration tests.

Reasons:

- The SDK already uses plain ESM `.mjs` fixture checks.
- No new test framework dependency is required.
- `node:test` supports subtests, skips, timeouts, and TAP output.
- The tests can import from `dist/`, matching real package output.

The existing `npm run test` remains the fast fixture suite. A new opt-in command
runs the devnet suite:

```bash
npm run test:integration:devnet
```

That command builds the SDK first, then runs `node --test` over
`tests/integration/devnet/*.test.mjs`.

## Prerequisites

The suite expects:

- `DEVNET_CKB_RPC_URL`, defaulting to `http://127.0.0.1:28114`.
- `deployment/artifacts/devnet.guardian-set-type.json`.
- `deployment/artifacts/devnet.oracle-type.json`.
- `deployment/artifacts/devnet.deploy-guardian-set.json`.
- `deployment/artifacts/devnet.deploy-oracle.json`.

For signer/fuel/broadcast-adjacent tests, it also expects:

- `DEVNET_DEPLOYER_PRIVATE_KEY`.
- Devnet secp256k1 known-script env vars used by `deployment/src/ccc.ts`.

Hermes-backed drafting expects:

- `HERMES_BASE_URL`, defaulting to `https://hermes.pyth.network`.
- `ORACLE_FEED_ID`, defaulting to the BTC feed currently used by deployment
  docs and the one-off devnet script.

Read-only tests must run with only RPC + artifacts. Tests that need the signer
must be skipped when signer prerequisites are absent.

## Harness Design

Create `packages/sdk/tests/integration/devnet/helpers/`.

### `artifacts.mjs`

Responsibilities:

- Locate repo root from the test file.
- Read the four devnet deployment artifacts.
- Select the latest canonical code version from each code artifact.
- Compute `guardianSetType.typeHash` from the deployed guardian-set type script.
- Convert JSON artifact numeric indices to `bigint`.
- Build a `LeanOracleNetworkConfig` compatible object for the SDK.

The harness should avoid duplicating SDK codecs. Where possible, tests should
assert through SDK functions, not private copies of layout logic.

### `env.mjs`

Responsibilities:

- Read environment variables.
- Provide defaults for local devnet RPC, Hermes URL, and BTC feed id.
- Expose helper predicates for signer-required tests.
- Produce clear skip reasons.

### `devnetClient.mjs`

Responsibilities:

- Create a devnet CCC client using the deployment toolbox's existing
  `createCccClient("devnet", ...)` helper when signer known-script data is
  required.
- For read-only tests, create the least privileged JSON-RPC client that can
  query cells.
- Create the signer and recommended lock when `DEVNET_DEPLOYER_PRIVATE_KEY` is
  available.

The tests should not invent a separate devnet known-script model.

## Test Cases

### Artifact and Config Smoke Test

Validates that artifact loading produces a complete SDK network config:

- network name is `devnet`.
- RPC and Hermes URLs are set.
- oracle type code dep is populated.
- guardian-set type identity and type hash are populated.
- default public oracle lock and code dep are populated.

### Oracle Discovery Test

Using the deployed signer lock as `oracleLockScript`, call:

- `findLatestOracleLiveCellForFeed`.
- `LeanOracleClient.getOracleCellState`.

Assert:

- a live oracle cell is found.
- decoded `feedId` matches the configured feed.
- `guardianSetTypeHash` matches the artifact-derived guardian-set type hash.
- `emitterChain` and `emitterAddress` match the oracle deployment artifact.

This test requires signer lock derivation, so it is skipped without signer env.

### Read-Deps Draft Test

Call `client.draftReadOracleTx({ feedId, oracleLockScript })`.

Assert:

- the transaction has the oracle type code dep.
- the transaction has the live oracle cell as a cell dep.
- no inputs or outputs are added.

This verifies the SDK read path against actual live devnet cells.

### Guardian-Set Dep Resolution Test

Call `resolveGuardianSetCellDep` with the expected guardian-set type hash from
the live oracle cell.

Assert:

- the resolved outpoint matches `devnet.deploy-guardian-set.json`.
- dep type is `code`.

### Oracle Update Draft Test

Fetch a Hermes latest envelope for the configured feed, then call:

- `client.draftOracleUpdateTx({ feedId, oracleLockScript, hermesEnvelope })`.

Assert:

- the transaction consumes the current oracle cell.
- it emits one replacement oracle output with the same lock/type.
- output data decodes to the configured feed id.
- output `publishTimeUnix` is greater than or equal to the previous oracle
  state when Hermes has a fresh update.
- witness input type is populated.
- guardian-set and oracle type deps are attached.

The test drafts only. It does not broadcast.

### Fuel/Rebalance Test

When signer env is present, collect plain fuel cells for the signer lock and run
`rebalanceFuel` against a drafted update transaction.

Assert:

- if fuel exists, the result is either `ok` with fee metadata or a clear
  `insufficient` result.
- the test should fail only on SDK/runtime errors, not because a local wallet is
  underfunded.

This gives coverage for the SDK fuel machinery without requiring every run to
mutate chain state.

## Error and Skip Behavior

The suite should distinguish:

- Missing devnet artifacts: fail early with an actionable setup message.
- RPC unavailable: fail early, because the selected command explicitly asked
  for devnet integration.
- Missing signer env: skip signer-required tests.
- Missing Hermes/network access: skip only Hermes-backed drafting tests if the
  failure is clearly network setup; malformed Hermes envelopes should fail.
- No deployed oracle cell for the feed: fail with a message telling the operator
  to run the deployment flow for that feed.

## Package Scripts

Add to `packages/sdk/package.json`:

```json
{
  "scripts": {
    "test:integration:devnet": "npm run build && node --test tests/integration/devnet/*.test.mjs"
  }
}
```

The existing `test` script remains unchanged unless later we decide to compose
all suites under a top-level command.

## Documentation

Update `packages/sdk/README.md` with:

- The new command.
- Required env vars.
- A note that devnet must already be deployed.
- A short example:

```bash
cd packages/sdk
DEVNET_CKB_RPC_URL=http://127.0.0.1:28114 \
DEVNET_DEPLOYER_PRIVATE_KEY=0x... \
npm run test:integration:devnet
```

## Future Work

Later, add a separate setup command that can provision devnet using
`deployment/` before running this suite. That flow should remain separate from
the normal integration command so developers can choose between validating an
existing deployment and rebuilding local chain state.
