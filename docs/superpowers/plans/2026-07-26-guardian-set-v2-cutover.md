# Guardian Set V2 Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship, deploy, exercise, and publish trustless Wormhole guardian-set rotation while migrating CKB testnet from guardian set 6 to set 7.

**Architecture:** Keep the Rust type script as the sole signature-verification authority. Use Wormhole's canonical guardian-set registry to transport authentic upgrade VAAs, make rotation advance the deployment toolbox's canonical live-state artifact, and migrate testnet by creating a v2 set-6 cell and applying the official set-7 upgrade. Update the SDK preset and public BTC oracle only after chain reads confirm the new guardian identity.

**Tech Stack:** Rust/no-std/ckb-std/ckb-testtool, TypeScript/Node.js, `@ckb-ccc/core`, CKB testnet JSON-RPC, Wormhole canonical guardian registry, Hermes, npm.

---

### Task 1: Add The Official Guardian Upgrade Fixture

**Files:**
- Create: `fixtures/wormhole/mainnet-guardian-set-upgrade-v7.hex`
- Modify: `packages/sdk/tests/guardianSetUpgradeVaa.fixture.mjs`

- [ ] **Step 1: Add the authoritative fixture**

Extract the `gs7` hex field from Wormhole's maintained file
`guardianset/mainnetv2/canonical_sets/guardianSetVAAs.csv`, store it as one
lowercase hex line with no `0x`, and record its SHA-256 in the test output.

- [ ] **Step 2: Write the failing SDK assertions**

Add assertions that load the fixture and require:

```js
const official = fs.readFileSync(OFFICIAL_V7_FIXTURE, "utf8").trim();
const officialParsed = parseGuardianSetUpgradeVaa(`0x${official}`);
assert.equal(officialParsed.signingSetIndex, 6);
assert.equal(officialParsed.newIndex, 7);
assert.equal(officialParsed.quorum, 13);
assert.equal(officialParsed.addresses.length, 19);
```

Also compare all 19 addresses with a checked-in set-7 address constant copied
from `https://api.wormholescan.io/v1/guardianset/current`.

- [ ] **Step 3: Run the focused fixture**

Run: `npm run build && node tests/guardianSetUpgradeVaa.fixture.mjs`

Expected: PASS. This is characterization of Claude's parser, not a production
change, so a passing result establishes that the official bytes match its layout.

### Task 2: Verify The Real Rotation In CKB-VM

**Files:**
- Modify: `crates/lean_oracle/tests/src/oracle_integration_tests.rs`

- [ ] **Step 1: Write a production-shaped integration test**

Add a test that decodes the shared fixture with `include_str!`, constructs the
set-6 input from the 19 canonical addresses, parses the VAA to construct the
set-7 output, and runs the existing `build_rotation_tx` helper:

```rust
#[test]
fn test_official_guardian_set_6_to_7_upgrade_vaa() {
    let vaa = decode_hex(include_str!(
        "../../../../fixtures/wormhole/mainnet-guardian-set-upgrade-v7.hex"
    ).trim()).expect("decode official gs7 VAA");
    // Build old set 6, expected set 7, and verify the real 14-signature VAA.
    let cycles = context.verify_tx(&tx, MULTI_SIG_MAX_CYCLES)
        .expect("official gs7 VAA must rotate set 6 to set 7");
    assert!(cycles <= GUARDIAN_ROTATION_CYCLE_CEILING);
}
```

The expected output addresses must be declared independently from the VAA parse
so an offset/parser regression cannot make both actual and expected drift together.

- [ ] **Step 2: Run the test and inspect the failure**

Run: `cargo test --target x86_64-unknown-linux-gnu test_official_guardian_set_6_to_7_upgrade_vaa -- --nocapture`

Expected before helper/path completion: FAIL for the specific missing fixture
decoder or assertion, not a compiler error unrelated to the test.

- [ ] **Step 3: Complete the smallest test support needed**

Reuse the existing hex/address decoders and rotation transaction builder. Do not
add new production behavior unless the official VAA reveals a real parser/verifier
defect.

- [ ] **Step 4: Verify the focused and full contract suites**

Run:

```bash
cargo test --target x86_64-unknown-linux-gnu test_official_guardian_set_6_to_7_upgrade_vaa -- --nocapture
make contracts-test
make contracts-build
```

Expected: official VAA test passes under its cycle ceiling; 0 full-suite failures;
optimized RISC-V build exits 0.

### Task 3: Make Upgrade Discovery Follow Wormhole's Canonical Registry

**Files:**
- Modify: `packages/sdk/src/wormhole/fetchGuardianSetUpgradeVaa.ts`
- Create: `packages/sdk/tests/guardianSetUpgradeFetcher.fixture.mjs`
- Modify: `packages/sdk/src/wormhole/index.ts`
- Modify: `packages/sdk/package.json`

- [ ] **Step 1: Write a failing registry-fallback fixture**

Use an injected `fetchImpl` that returns an empty Wormholescan history response
for `/api/v1/vaas/...` and a two-line CSV containing `gs6` and the official `gs7`
record for the canonical registry URL. Assert:

```js
const found = await fetchGuardianSetUpgradeVaa(7, {
  fetchImpl,
  canonicalRegistryUrl: "https://registry.invalid/guardianSetVAAs.csv",
});
assert.equal(found, `0x${officialV7}`);
```

Add cases for registry HTTP failure after an empty history, malformed CSV rows,
wrong-index VAAs, abort propagation, and `null` only when both sources are
successfully exhausted.

- [ ] **Step 2: Run the fixture to verify RED**

Run: `npm run build && node tests/guardianSetUpgradeFetcher.fixture.mjs`

Expected: FAIL because `canonicalRegistryUrl` and fallback behavior do not exist.

- [ ] **Step 3: Implement canonical fallback**

Add:

```ts
export const DEFAULT_WORMHOLE_GUARDIAN_SET_REGISTRY_URL =
  "https://raw.githubusercontent.com/wormhole-foundation/wormhole/main/guardianset/mainnetv2/canonical_sets/guardianSetVAAs.csv";
```

Parse each non-empty row at its first comma, decode the hex field through
`parseGuardianSetUpgradeVaa`, and return only the VAA whose parsed `newIndex`
matches the requested target. Preserve emitter/module validation. Try the
Wormholescan-compatible history first and use the registry when history is empty
or unavailable; if both transports fail, throw a `LeanOracleSdkError` that keeps
both causes readable.

- [ ] **Step 4: Verify GREEN**

Run: `npm run build && node tests/guardianSetUpgradeFetcher.fixture.mjs`

Expected: PASS.

- [ ] **Step 5: Add the fixture to `npm test` and verify all SDK fixtures**

Run: `npm test`

Expected: 0 failures.

### Task 4: Cover And Harden The SDK Rotation Builder

**Files:**
- Create: `packages/sdk/tests/guardianSetRotation.fixture.mjs`
- Modify: `packages/sdk/src/ckb/encodeGuardianSetData.ts`
- Modify: `packages/sdk/src/wormhole/parseGuardianSetUpgrade.ts`
- Modify: `packages/sdk/src/tx/rotateGuardianSet.ts`
- Modify: `packages/sdk/package.json`

- [ ] **Step 1: Write failing builder and encoder tests**

Create a fake CCC client yielding one set-6 guardian cell and an otherwise empty
transaction that already contains one unrelated input and witness. Assert that
`attachGuardianSetRotation`:

```js
assert.equal(tx.inputs.length, 2);
assert.equal(decodeGuardianSetCellDataHex(tx.outputsData[0]).setIndex, 7);
assert.equal(tx.getWitnessArgsAt(1).inputType, `0x${officialV7}`);
assert.equal(tx.getWitnessArgsAt(0).lock, preexistingLockWitness);
assert.ok(hasDep(tx, network.deployment.guardianSetType.codeDep.outPoint));
```

Add rejection cases for zero/multiple live cells, signing-index mismatch, skipped
new index, abort, duplicate guardian addresses, non-u32/fractional set index and
quorum, and invalid `wormholeQuorum` inputs. Add keeper no-op and rotation cases.

- [ ] **Step 2: Run the fixture to verify RED**

Run: `npm run build && node tests/guardianSetRotation.fixture.mjs`

Expected: FAIL on at least the encoder/domain validation assertions.

- [ ] **Step 3: Implement minimal validation and remove duplicate resolution**

Validate integers before `DataView#setUint32`, reject duplicate addresses, and
require guardian counts in the VAA-supported `1..=255` range. Refactor the keeper
to pass its already-resolved cell to a private attachment helper so it does not
query chain state twice, while keeping the public API unchanged.

- [ ] **Step 4: Verify GREEN and add to `npm test`**

Run: `npm test`

Expected: all SDK fixtures pass.

### Task 5: Test Packaged Public Boundaries

**Files:**
- Modify: `packages/sdk/tests/tarballExports.fixture.mjs`
- Modify: `packages/sdk/tests/rootApiBoundary.fixture.mjs`

- [ ] **Step 1: Add the missing advertised imports**

The packed consumer must import and assert:

```js
import {
  parseGuardianSetUpgradeVaa,
  fetchGuardianSetUpgradeVaa,
  wormholeQuorum,
} from "lean-oracle-sdk/wormhole";
import {
  attachGuardianSetRotation,
  buildGuardianSetRotationIfBehind,
} from "lean-oracle-sdk/tx";
```

Also assert the root remains curated and does not accidentally expose the
Wormhole transport helpers.

- [ ] **Step 2: Run the packed test**

Run: `npm run test:pack`

Expected: PASS when run with permission to spawn npm's shell subprocesses.

### Task 6: Make Deployment Rotation Advance Canonical State

**Files:**
- Create: `deployment/tests/guardianSetRotate.test.mjs`
- Modify: `deployment/src/guardianSetRotate.ts`
- Modify: `deployment/src/artifacts.ts`
- Modify: `deployment/src/index.ts`
- Modify: `deployment/src/types.ts`
- Modify: `deployment/package.json`

- [ ] **Step 1: Write failing canonical-artifact tests**

Build a set-6 deployment artifact in a temporary directory and a synthetic
rotation result. Assert the rotation receipt remains at
`testnet.rotate-guardian-set.json`, while the canonical state at
`testnet.deploy-guardian-set.json` becomes:

```js
{
  kind: "deploy:guardian-set",
  mode: "broadcast",
  network: "testnet",
  guardianSetType,
  guardianSet: nextSet,
  deployed: {
    txHash: rotationTxHash,
    index: 0,
    typeIdArgs: priorTypeIdArgs,
    capacity: nextCapacity,
  },
}
```

Verify `oracleDeploy` loads the rotated outpoint, not the spent predecessor.

- [ ] **Step 2: Run deployment tests to verify RED**

Run: `npm test`

Expected: FAIL because rotation does not currently produce/persist canonical state.

- [ ] **Step 3: Return canonical state from rotation and persist it atomically**

Include full guardian script metadata, unchanged Type ID args, next set, new
outpoint, and capacity in the broadcast result. After writing the audit receipt,
write its `canonicalState` through `writeDeploymentArtifact` using action
`deploy:guardian-set`. Keep dry-run side-effect free.

- [ ] **Step 4: Verify GREEN**

Run: `npm test`

Expected: all deployment tests pass.

### Task 7: Enforce Explicit Broadcast Authorization

**Files:**
- Modify: `deployment/src/deploy.ts`
- Modify: `deployment/tests/validate.test.mjs`
- Modify: `deployment/.env.example`
- Modify: `deployment/README.md`

- [ ] **Step 1: Write failing action-level tests**

Require every mutating action with `DRY_RUN=false` to reject unless
`BROADCAST=true`. Promotion is a local artifact mutation and may run without a
chain broadcast only when its action-specific preconditions pass.

- [ ] **Step 2: Run deployment tests to verify RED**

Run: `npm test`

Expected: FAIL because `BROADCAST` is currently ignored.

- [ ] **Step 3: Add the centralized guard**

At the entry to `runDeploymentAction`, distinguish chain-mutating actions from
dry runs and local promotions. Throw:

```ts
throw new Error("Refusing chain broadcast: set both DRY_RUN=false and BROADCAST=true");
```

- [ ] **Step 4: Verify GREEN**

Run: `npm test`

Expected: all deployment tests pass.

### Task 8: Preflight The Exact Testnet Cutover

**Files:**
- Modify after broadcasts: `deployment/config/testnet.json`
- Modify after broadcasts: `deployment/artifacts/testnet.guardian-set-type.json`
- Modify after broadcasts: `deployment/artifacts/testnet.deploy-guardian-set.json`

- [ ] **Step 1: Verify local and upstream identities**

Run commands that prove:

- local guardian binary hash equals dry-run candidate hash;
- official fixture parses exactly `6 -> 7` with quorum 13;
- fixture set-7 addresses equal `/v1/guardianset/current`;
- latest Hermes BTC accumulator uses guardian index 7;
- the testnet deployer has enough live capacity;
- the existing v1 guardian cell is still set 6 at its checked-in outpoint.

- [ ] **Step 2: Run all pre-broadcast suites**

Run:

```bash
make contracts-test
make contracts-build
npm --prefix deployment test
npm --prefix packages/sdk run release:check
```

Expected: every command exits 0.

- [ ] **Step 3: Record the exact planned transactions in dry-run mode**

Run guardian code deployment, guardian state deployment, and rotation with
`DRY_RUN=true`; inspect code hash, set indices, addresses, Type ID source, and
capacity before enabling broadcast.

### Task 9: Broadcast Guardian V2 And Rotate To Set 7

**Files:**
- Generated/modified: `deployment/artifacts/testnet.guardian-set-type.json`
- Generated/modified: `deployment/artifacts/testnet.deploy-guardian-set.json`
- Generated/modified: `deployment/artifacts/testnet.rotate-guardian-set.json`

- [ ] **Step 1: Deploy the v2 guardian code cell**

Run `deploy:guardian-set-type` with `DEPLOY_NETWORK=testnet`,
`DRY_RUN=false`, and `BROADCAST=true`. Wait for the transaction to be committed,
then verify its output data hash equals the local optimized binary hash.

- [ ] **Step 2: Promote the candidate to v2**

Run `promote:guardian-set-type`, inspect the version table, and verify v1 remains
preserved while v2 points to the committed code cell.

- [ ] **Step 3: Deploy the v2 set-6 state cell**

Keep `deployment/config/testnet.json` at set 6 for this step. Broadcast
`deploy:guardian-set`, wait for commitment, and read the cell back to verify set
6/quorum 13/all 19 addresses/type code hash/Type ID args.

- [ ] **Step 4: Rotate with the official set-7 VAA**

Pass the shared fixture as `GUARDIAN_UPGRADE_VAA`, broadcast
`rotate:guardian-set`, and wait for commitment. Verify the input outpoint is
spent and the canonical artifact points to the new set-7 output.

- [ ] **Step 5: Read back the canonical live cell**

Require exact equality with Wormholescan's set-7 index, quorum, and address list.
Stop before metadata or package changes if any byte differs.

### Task 10: Update Presets, Configuration, And Documentation

**Files:**
- Modify: `deployment/config/testnet.json`
- Modify: `packages/sdk/src/presets/testnet.ts`
- Modify: `packages/sdk/src/types/deployment.ts`
- Modify: `packages/sdk/tests/oracleVersionPreset.fixture.mjs`
- Modify: `README.md`
- Modify: `packages/sdk/README.md`
- Modify: `deployment/README.md`

- [ ] **Step 1: Write failing preset assertions with deployed values**

Assert the default guardian identity matches the new v2 code hash/dep/Type ID
args and that a `guardianSetTypeVersions` history retains v1 and v2 identities.

- [ ] **Step 2: Run the preset fixture to verify RED**

Run: `npm run build && node tests/oracleVersionPreset.fixture.mjs`

Expected: FAIL because guardian history is absent or values are still v1.

- [ ] **Step 3: Update metadata from verified chain reads**

Set testnet guardian config to set 7, update the SDK default and history, document
the breaking guardian-identity migration, deployed v2 hashes/outpoints, rotation
transaction, current set 7, and deployer-lock limitation.

- [ ] **Step 4: Verify GREEN and artifact consistency**

Run SDK and deployment tests plus a script that recomputes script hashes from
the checked-in values and compares them with chain data.

### Task 11: Restore A Current Public BTC Oracle

**Files:**
- Generated/modified when needed: `deployment/artifacts/testnet.deploy-oracle.json`

- [ ] **Step 1: Discover all default-lock BTC oracle v3 cells**

Query by the v3 oracle type script and default public lock. Decode every match
and classify it by guardian type hash. If more than one unspent match exists, or
if a cell is not controlled through the canonical owner escape, stop for manual
review before burning anything.

- [ ] **Step 2: Choose the safe migration path from chain state**

If no v3 cell exists, broadcast `deploy:oracle`. If exactly one v3 cell exists
and already references the new guardian identity, reuse it. If exactly one
canonical owner-controlled v3 cell references the old guardian identity, burn it
with the SDK owner path, confirm commitment, then deploy its replacement.

- [ ] **Step 3: Submit and verify a current Hermes update**

Fetch a fresh BTC accumulator, assert its embedded VAA uses set 7, build the
update with the new guardian CellDep, sign/broadcast, and wait for commitment.
Read back the oracle and require nonzero current publish time, correct feed id,
correct Pyth emitter, and the new guardian type hash.

### Task 12: Independently Review And Publish

**Files:**
- Modify: `packages/sdk/package.json`
- Modify: `packages/sdk/package-lock.json`

- [ ] **Step 1: Determine and apply the next minor SDK version**

Query the npm registry, verify the local version is not already published, then
run `npm version minor --no-git-tag-version` in `packages/sdk`.

- [ ] **Step 2: Run final verification**

Run all Rust tests/builds, deployment tests, SDK release checks, real testnet
guardian/oracle reads, and `git diff --check`. Capture exact pass/failure counts.

- [ ] **Step 3: Commit the reviewed implementation checkpoint**

Review the diff for secrets and unrelated generated files, then commit source,
tests, docs, package version, and checked-in testnet artifacts without committing
`.env`, private keys, temporary responses, build output, or npm credentials.

- [ ] **Step 4: Request independent code review**

Use `superpowers:requesting-code-review` against base `8d312a2` and the
implementation checkpoint SHA. Resolve every Critical or Important finding in a
follow-up commit and repeat all relevant tests.

- [ ] **Step 5: Publish and verify from a clean consumer**

Require `npm whoami` success, publish with public access, wait for the registry
version to appear, install that exact version into a temporary clean project,
and import the root, `/ckb`, `/tx`, `/wormhole`, `/hermes`, `/presets`, `/fuel`,
and `/advanced` entry points.
