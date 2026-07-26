# Owned-Bind Guardian Singleton Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy a canonical set-7 guardian identity under `OwnedTypeBindLock`, move the public BTC/USD oracle to that identity while keeping oracle v4, and publish SDK `0.3.1` with permissionless guardian-rotation metadata.

**Architecture:** Keep the guardian v3 and oracle v4 binaries unchanged. Deploy guardian identity v4 as a non-canonical candidate, prove its lock/data/code lineage, stage and authenticate a replacement oracle under the deployer lock, burn the old public oracle, migrate the staging oracle to the public bind lock with a fresher update, and only then promote artifacts and the SDK preset. The old guardian identity remains live and explicitly legacy.

**Tech Stack:** Rust/CKB-VM (`ckb-testtool`), TypeScript and ESM JavaScript, `@ckb-ccc/core`, Node test runner, Wormhole governance VAAs, Pyth Hermes, CKB testnet JSON-RPC, npm.

---

## File Structure

- `crates/lean_oracle/tests/src/guardian_owned_bind_tests.rs`: combined CKB-VM proof that the bind lock and guardian governance script allow third-party rotation only with valid continuity and governance.
- `crates/lean_oracle/tests/src/lib.rs`: registers the focused Rust test module.
- `packages/sdk/src/types/deployment.ts`: adds explicit guardian identity/code version and guardian-state lock metadata.
- `packages/sdk/src/tx/rotateGuardianSet.ts`: validates the configured live lock and attaches its code dependency.
- `packages/sdk/src/tx/pullUpdate.ts`: supports exact oracle input selection and an explicit output lock for staged cutover.
- `packages/sdk/src/tx/burnOracle.ts`: supports exact oracle input selection so the cutover cannot burn the wrong v4 cell.
- `packages/sdk/src/tx/workflows.ts`: threads exact-input/output-lock options through high-level drafts.
- `packages/sdk/tests/guardianSetRotation.fixture.mjs`: covers bind-lock dependency and lock mismatch.
- `packages/sdk/tests/txBuilders.fixture.mjs`: covers exact staging update, lock migration, and exact burn.
- `packages/sdk/tests/oracleVersionPreset.fixture.mjs`: locks guardian identity v4 and unchanged oracle v4 semantics.
- `deployment/src/codeVersions.ts`: resolves canonical code records without circular imports.
- `deployment/src/guardianSetDeploy.ts`: builds, broadcasts, waits for, and verifies an OwnedTypeBindLock guardian candidate.
- `deployment/src/guardianMigration.ts`: validates candidate/cutover evidence and constructs canonical plus audit artifacts.
- `deployment/src/guardianSetRotate.ts`: includes and verifies the guardian-state lock dependency.
- `deployment/src/types.ts`, `deployment/src/config.ts`, `deployment/src/deploy.ts`, `deployment/src/index.ts`: register candidate deployment and promotion-safe migration configuration.
- `deployment/tests/guardianMigration.test.mjs`: tests candidate validation, promotion gates, rollback-safe artifact output, and dry-run behavior.
- `packages/sdk/scripts/migrate-owned-bind-guardian-testnet.mjs`: restartable operator workflow for staging, authentication, burn, public-lock migration, and promotion.
- `deployment/config/testnet.json`: selects identity v4, binary v3, bind-lock v2, and canonical set 7.
- `deployment/artifacts/testnet.*.json`, `packages/sdk/src/presets/testnet.ts`: generated only after verified testnet cutover.
- `README.md`, `deployment/README.md`, `packages/sdk/README.md`: document current/legacy identities and permissionless rotation.
- `packages/sdk/package.json`, `packages/sdk/package-lock.json`: release SDK `0.3.1`.

### Task 1: Add Guardian Identity and Lock Metadata

**Files:**
- Modify: `packages/sdk/src/types/deployment.ts`
- Create: `packages/sdk/tests/guardianIdentityTypes.compile.ts`
- Modify: `packages/sdk/package.json`

- [ ] **Step 1: Write the failing compile-time metadata fixture**

Construct a synthetic deployment that preserves oracle v4 while describing a
guardian identity v4 backed by code version 3:

```ts
import type { LeanOracleDeployment } from "../src/types/deployment.js";

const codeDep = {
  outPoint: { txHash: `0x${"11".repeat(32)}`, index: 0n },
  depType: "code" as const,
};
const identityV4 = {
  codeHash: `0x${"22".repeat(32)}`,
  hashType: "data2" as const,
  args: `0x${"33".repeat(32)}`,
  codeDep,
  identityVersion: 4,
  codeVersion: 3,
};
const deployment = {
  defaultPublicOracleLock: {
    script: { codeHash: `0x${"44".repeat(32)}`, hashType: "data2", args: `0x${"55".repeat(32)}` },
    codeDep,
  },
  guardianSetLock: {
    script: { codeHash: `0x${"44".repeat(32)}`, hashType: "data2", args: `0x${"55".repeat(32)}` },
    codeDep,
  },
  guardianSetType: identityV4,
  guardianSetTypeVersions: { 4: identityV4 },
  oracleType: { codeHash: `0x${"66".repeat(32)}`, hashType: "data2", codeDep },
  oracleTypeVersions: { 4: { codeHash: `0x${"66".repeat(32)}`, hashType: "data2", codeDep } },
  pythEmitter: { chain: 26, address: `0x${"77".repeat(32)}` },
} satisfies LeanOracleDeployment;

void deployment;
```

- [ ] **Step 2: Run the fixture and verify it fails**

Run: `cd packages/sdk && npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck tests/guardianIdentityTypes.compile.ts`

Expected: FAIL because `identityVersion`, `codeVersion`, and `guardianSetLock` do not exist.

- [ ] **Step 3: Add explicit metadata types**

Extend guardian references without changing oracle version types:

```ts
export interface LeanOracleGuardianSetTypeRef {
  codeHash: HexString;
  hashType: LeanOracleScriptHashType;
  args: HexString;
  codeDep: LeanOracleCodeDep;
  identityVersion?: number;
  codeVersion?: number;
}

export interface LeanOracleGuardianSetLockRef {
  script: LeanOracleScriptIdentity;
  codeDep: LeanOracleCodeDep;
}

export interface LeanOracleDeployment {
  // existing fields remain
  guardianSetType: LeanOracleGuardianSetTypeRef;
  guardianSetLock?: LeanOracleGuardianSetLockRef;
  guardianSetTypeVersions?: Record<number, LeanOracleGuardianSetTypeRef>;
}
```

Do not modify the real testnet preset in this task. Its v4 identity args are generated by the candidate deployment and are applied only after live-chain verification in Task 10.

Add a `test:types` script containing the compile command above and invoke it
from `npm test` immediately after the normal SDK build.

- [ ] **Step 4: Run the fixture and SDK typecheck**

Run: `cd packages/sdk && npm run build && npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck tests/guardianIdentityTypes.compile.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/types/deployment.ts packages/sdk/tests/guardianIdentityTypes.compile.ts packages/sdk/package.json
git commit -m "sdk: model guardian identity and state lock"
```

### Task 2: Make Oracle Cutover Inputs Exact and Lock Migration Explicit

**Files:**
- Modify: `packages/sdk/src/tx/pullUpdate.ts`
- Modify: `packages/sdk/src/tx/burnOracle.ts`
- Modify: `packages/sdk/src/tx/workflows.ts`
- Test: `packages/sdk/tests/txBuilders.fixture.mjs`

- [ ] **Step 1: Write failing transaction-builder fixtures**

Add fixtures with two cells sharing oracle v4/feed identity and assert that an explicit outpoint is consumed. Add a staging update whose output lock differs from its input lock:

```js
const result = await attachOraclePullUpdate({
  network,
  cccClient: fakeClient,
  tx,
  feedId,
  oracleOutPoint: stagingCell.outPoint,
  outputLockScript: publicBindLock,
  hermesEnvelope,
  outputSource: "binary",
});
assert.deepEqual(tx.inputs.at(-1).previousOutput, stagingCell.outPoint);
assert.ok(tx.outputs.at(-1).lock.eq(publicBindLock));

const burn = await attachOracleBurn({
  network,
  cccClient: fakeClient,
  tx: burnTx,
  feedId,
  oracleOutPoint: oldPublicCell.outPoint,
});
assert.deepEqual(
  burnTx.inputs[burn.oracleInputIndex].previousOutput,
  oldPublicCell.outPoint,
);
```

- [ ] **Step 2: Run the fixture and verify it fails**

Run: `cd packages/sdk && npm run build && node tests/txBuilders.fixture.mjs`

Expected: FAIL because the parameters are absent and updates preserve the input lock unconditionally.

- [ ] **Step 3: Implement exact resolution and output lock selection**

Add optional `oracleOutPoint` and `outputLockScript` fields. Resolve exact cells with `client.getCell` when supplied and validate that their oracle type args match `feedId`. Otherwise retain current discovery. Build the update output with:

```ts
const outputLock = params.outputLockScript
  ? Script.from(params.outputLockScript)
  : Script.from(inputCell.cellOutput.lock);

params.tx.addOutput({
  cellOutput: {
    capacity: inputCell.cellOutput.capacity,
    lock: outputLock,
    type: inputCell.cellOutput.type,
  },
  outputData: outputOracleDataHex,
});
```

Thread both options through `initiateOracleUpdateTx`; thread `oracleOutPoint` through `initiateOracleBurnTx`. Do not attach the output lock dependency: CKB executes input locks only.

- [ ] **Step 4: Run focused and full SDK fixtures**

Run: `cd packages/sdk && npm run build && node tests/txBuilders.fixture.mjs`

Expected: PASS.

Run: `cd packages/sdk && npm test`

Expected: all fixture scripts PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/tx/pullUpdate.ts packages/sdk/src/tx/burnOracle.ts packages/sdk/src/tx/workflows.ts packages/sdk/tests/txBuilders.fixture.mjs
git commit -m "sdk: support exact oracle cutover transactions"
```

### Task 3: Attach the Guardian Bind-Lock Dependency

**Files:**
- Modify: `packages/sdk/src/tx/rotateGuardianSet.ts`
- Test: `packages/sdk/tests/guardianSetRotation.fixture.mjs`

- [ ] **Step 1: Write failing lock/dependency tests**

Configure `network.deployment.guardianSetLock`, make the fake guardian cell use that script, and assert both dependencies are present. Add a mismatched live lock case:

```js
assert.ok(hasDep(tx, guardianCodeDep.outPoint));
assert.ok(hasDep(tx, guardianBindLockDep.outPoint));

await assert.rejects(
  () => attachGuardianSetRotation({
    network,
    cccClient: fakeClient([cellWithDifferentLock]),
    tx: ccc.Transaction.from({}),
    governanceVaa: officialV7,
  }),
  /guardian.*lock.*mismatch/iu,
);
```

- [ ] **Step 2: Run the fixture and verify it fails**

Run: `cd packages/sdk && npm run build && node tests/guardianSetRotation.fixture.mjs`

Expected: FAIL because only the guardian type dependency is attached.

- [ ] **Step 3: Validate and attach the configured lock**

Before mutating the transaction, compare the resolved live lock to `guardianSetLock.script`. If configured and unequal, throw `LeanOracleSdkError`. If equal, add `guardianSetLock.codeDep` after the guardian type dependency. Preserve behavior when the optional metadata is absent for legacy/custom configurations.

- [ ] **Step 4: Run rotation and package-boundary fixtures**

Run: `cd packages/sdk && npm run build && node tests/guardianSetRotation.fixture.mjs && node tests/rootApiBoundary.fixture.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/tx/rotateGuardianSet.ts packages/sdk/tests/guardianSetRotation.fixture.mjs
git commit -m "sdk: attach guardian state lock dependency"
```

### Task 4: Prove Permissionless Rotation in CKB-VM

**Files:**
- Create: `crates/lean_oracle/tests/src/guardian_owned_bind_tests.rs`
- Modify: `crates/lean_oracle/tests/src/lib.rs`

- [ ] **Step 1: Write the failing combined integration tests**

Build a guardian input under an OwnedTypeBindLock whose owner hash does not match any transaction input. Include a separate fee-payer input, recreate the exact guardian `(lock, type)` output, and attach a valid synthetic `N -> N+1` VAA. Register these tests:

```rust
#[test]
fn third_party_rotates_owned_bind_guardian_with_governance_vaa() {
    let fixture = owned_bind_guardian_fixture();
    let tx = fixture.rotation_tx(fixture.valid_upgrade_vaa(), true);
    fixture.context.verify_tx(&tx, MAX_CYCLES).expect("permissionless rotation");
}

#[test]
fn owned_bind_continuity_does_not_bypass_bad_governance() {
    let fixture = owned_bind_guardian_fixture();
    let tx = fixture.rotation_tx(fixture.forged_upgrade_vaa(), true);
    assert_script_error(fixture.context.verify_tx(&tx, MAX_CYCLES), ERROR_GUARDIAN_SIGNATURE_INVALID);
}

#[test]
fn valid_governance_does_not_bypass_broken_owned_bind_continuity() {
    let fixture = owned_bind_guardian_fixture();
    let tx = fixture.rotation_tx(fixture.valid_upgrade_vaa(), false);
    assert_script_error(fixture.context.verify_tx(&tx, MAX_CYCLES), ERROR_BIND_LOCK_COUNT_MISMATCH);
}
```

The helper must attach both real contract code dependencies and assert no input lock hash equals the bind-lock owner args.

- [ ] **Step 2: Run the focused tests and verify the initial failure**

Run: `cargo test -p lean_oracle_tests guardian_owned_bind -- --nocapture`

Expected: initial compile/test failure until the fixture wires the combined script groups correctly.

- [ ] **Step 3: Complete the minimal fixture wiring**

Reuse the existing synthetic governance VAA and Ethereum-address helpers. Deploy `owned_type_bind_lock` and `guardian_set_type` into `ckb-testtool`, create one guardian input and one unrelated fee input, add one guardian successor plus one fee change output, and include both code deps.

- [ ] **Step 4: Run focused and complete contract verification**

Run: `cargo test -p lean_oracle_tests guardian_owned_bind -- --nocapture`

Expected: three tests PASS.

Run: `make contracts-test`

Expected: all non-ignored contract tests PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/lean_oracle/tests/src/lib.rs crates/lean_oracle/tests/src/guardian_owned_bind_tests.rs
git commit -m "test: prove permissionless guardian rotation"
```

### Task 5: Build and Verify a Guardian Identity Candidate

**Files:**
- Create: `deployment/src/codeVersions.ts`
- Modify: `deployment/src/guardianSetDeploy.ts`
- Modify: `deployment/src/oracleDeploy.ts`
- Modify: `deployment/src/types.ts`
- Modify: `deployment/src/config.ts`
- Modify: `deployment/src/deploy.ts`
- Modify: `deployment/src/index.ts`
- Modify: `deployment/package.json`
- Modify: `deployment/config/testnet.json`
- Create: `deployment/tests/guardianMigration.test.mjs`

- [ ] **Step 1: Write failing deployment tests**

Add tests for `deploy:guardian-set-candidate` that assert identity v4 uses code version 3, derives bind-lock owner args from the deployer lock hash, records bind-lock v2, waits for commitment, and rejects mismatched live readback:

```js
assert.equal(result.identityVersion, 4);
assert.equal(result.guardianSetType.codeVersion, 3);
assert.equal(result.guardianSetLock.codeVersion, 2);
assert.equal(result.guardianSetLock.script.codeHash, bindLockV2.codeHash);
assert.equal(result.guardianSetLock.script.args, deployerLockHash);
assert.deepEqual(result.guardianSet, canonicalSet7);
await assert.rejects(() => deployWithReadback({ lock: wrongLock }), /readback.*lock/iu);
```

- [ ] **Step 2: Run deployment tests and verify they fail**

Run: `cd deployment && npm test`

Expected: FAIL because the action, metadata, and verification path do not exist.

- [ ] **Step 3: Extract canonical code-version resolution**

Move the latest-version selection into `codeVersions.ts`:

```ts
export function loadLatestCanonicalCodeVersion(params: {
  deploymentRoot: string;
  network: DeploymentNetwork;
  scriptFamily: CodeDeploymentScriptFamily;
}): CodeDeploymentVersionRecord {
  const envelope = readCodeDeploymentArtifact(params);
  const versions = (envelope?.deployment as CodeDeploymentArtifact | undefined)?.versions;
  if (!versions || Object.keys(versions).length === 0) {
    throw new Error(`No canonical ${params.scriptFamily} version for ${params.network}`);
  }
  return versions[Math.max(...Object.keys(versions).map(Number))];
}
```

Use it from guardian and oracle deployment code so there is no import cycle.

- [ ] **Step 4: Implement candidate deployment**

Add `guardianSetIdentityVersion: 4` and `guardianSetLock: "owned-type-bind"` to testnet config. Resolve guardian v3 and bind-lock v2, compute the deployer lock hash, create the output lock from bind-lock code hash/hash type plus owner hash, then build the Type ID output. Wait for commitment and require exact type, lock, data, capacity, and Type ID args on readback before returning `mode: "broadcast"`.

Register `deploy:guardian-set-candidate` as a chain-mutating action and write it to `testnet.deploy-guardian-set-candidate.json`; do not overwrite `testnet.deploy-guardian-set.json`.

- [ ] **Step 5: Run deployment tests**

Run: `cd deployment && npm test`

Expected: all suites PASS, including candidate finality/readback rejection cases.

- [ ] **Step 6: Commit**

```bash
git add deployment/src deployment/tests/guardianMigration.test.mjs deployment/package.json deployment/config/testnet.json
git commit -m "deployment: stage owned-bind guardian identity"
```

### Task 6: Add Restartable Cutover and Promotion Gates

**Files:**
- Create: `deployment/src/guardianMigration.ts`
- Modify: `deployment/src/artifacts.ts`
- Modify: `deployment/tests/guardianMigration.test.mjs`
- Create: `packages/sdk/scripts/migrate-owned-bind-guardian-testnet.mjs`
- Modify: `packages/sdk/package.json`

- [ ] **Step 1: Write failing state-machine and artifact tests**

Model phases `guardian-verified`, `staging-authenticated`, `old-oracle-burned`, `public-migrated`, and `promoted`. Assert that promotion rejects missing/out-of-order evidence and that dry-run writes nothing:

```js
assert.throws(
  () => buildGuardianMigrationPromotion({
    candidate,
    stagingOracle,
    oldOracleBurn: undefined,
    finalPublicOracle,
  }),
  /old public oracle.*not verified dead/iu,
);
assert.deepEqual(
  writeDeploymentActionArtifacts(root, "testnet", "migrate:owned-bind-guardian", dryRun),
  { artifactPaths: [] },
);
```

- [ ] **Step 2: Run deployment tests and verify they fail**

Run: `cd deployment && npm test`

Expected: FAIL because migration promotion and receipt handling are absent.

- [ ] **Step 3: Implement pure promotion validation**

`buildGuardianMigrationPromotion` must verify:

```ts
candidate.identityVersion === 4;
candidate.guardianSetType.codeVersion === 3;
candidate.guardianSet.setIndex === 7;
candidate.guardianSet.quorum === 13;
stagingOracle.guardianSetTypeHash === candidate.fullTypeHash;
stagingOracle.publishTimeUnix > 0n;
oldOracleBurn.live === false;
finalPublicOracle.lockHash === expectedPublicLockHash;
finalPublicOracle.guardianSetTypeHash === candidate.fullTypeHash;
finalPublicOracle.publishTimeUnix > stagingOracle.publishTimeUnix;
```

Return canonical guardian/oracle state payloads plus an immutable audit receipt. Write canonical files before the audit receipt and roll back synchronous failures using the established artifact helper.

- [ ] **Step 4: Implement the restartable operator script**

The script reads its receipt before every phase and performs only the next missing phase. It must use exact outpoints for staging update and old burn, `outputSource: "binary"`, commitment polling, live-cell readback, and the deployment promotion validator. It exits before the burn unless the staging oracle is authenticated against the candidate full type hash.

Expose: `npm run migrate:owned-bind-guardian:testnet`.

- [ ] **Step 5: Run deployment, SDK, and dry-run checks**

Run: `cd deployment && npm test`

Expected: all suites PASS.

Run: `cd packages/sdk && npm test`

Expected: all fixture scripts PASS.

Run the migration script with `DRY_RUN=true`; expected output lists the candidate/current outpoints and next phase, sends no transactions, and leaves artifact checksums unchanged.

- [ ] **Step 6: Commit**

```bash
git add deployment/src/guardianMigration.ts deployment/src/artifacts.ts deployment/tests/guardianMigration.test.mjs packages/sdk/scripts/migrate-owned-bind-guardian-testnet.mjs packages/sdk/package.json
git commit -m "deployment: add guarded guardian cutover workflow"
```

### Task 7: Run Pre-Broadcast Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Verify canonical external inputs**

Fetch Wormholescan's current set and require index 7 plus exact case-insensitive equality with all 19 configured addresses. Decode a current Hermes BTC accumulator and require guardian set index 7, emitter chain 26, and the configured Pyth emitter address.

- [ ] **Step 2: Run all local release gates**

Run: `make contracts-test`

Expected: all non-ignored tests PASS, including the combined OwnedTypeBindLock guardian tests.

Run: `make contracts-build`

Expected: optimized RISC-V binaries build successfully; guardian and oracle hashes remain equal to their v3/v4 artifact hashes.

Run: `cd deployment && npm test`

Expected: all deployment suites PASS.

Run: `cd packages/sdk && npm run release:check`

Expected: all fixtures and packed-consumer imports PASS.

- [ ] **Step 3: Confirm a clean checkpoint**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intentional committed work.

### Task 8: Deploy and Verify Guardian Identity v4 Candidate

**Files:**
- Generate: `deployment/artifacts/testnet.deploy-guardian-set-candidate.json`

- [ ] **Step 1: Produce the exact dry-run plan**

Run the candidate action with `DRY_RUN=true` and `BROADCAST=false` using testnet operator environment.

Expected: set 7/quorum 13/19 addresses, identity v4, code version 3, bind-lock version 2, and no artifact write.

- [ ] **Step 2: Broadcast the candidate**

Run the same action with `DRY_RUN=false` and `BROADCAST=true`.

Expected: one committed state output under OwnedTypeBindLock; candidate artifact written only after exact readback.

- [ ] **Step 3: Independently verify the candidate through RPC**

Require status `live`, decode cell data to set 7/quorum 13/19 exact addresses, recompute the full type hash, verify Type ID args, verify the guardian v3 code dep remains live and byte-identical, and verify bind-lock args equal the deployer lock hash.

- [ ] **Step 4: Stop on any mismatch**

Do not run the oracle migration script unless every candidate check passes. The old guardian and old oracle remain canonical at this checkpoint.

### Task 9: Execute the Oracle v4 Cutover and Promote

**Files:**
- Generate: `deployment/artifacts/testnet.owned-bind-guardian-migration.json`
- Modify through guarded promotion: `deployment/artifacts/testnet.deploy-guardian-set.json`
- Modify through guarded promotion: `deployment/artifacts/testnet.deploy-oracle.json`

- [ ] **Step 1: Stage oracle v4 under the deployer lock**

Run `npm run migrate:owned-bind-guardian:testnet` with broadcast enabled.

Expected first phases: a zero-initialized staging v4 BTC cell references the candidate guardian hash, then an exact-outpoint Hermes update commits with nonzero publish time. Old public oracle remains live.

- [ ] **Step 2: Verify the pre-burn gate**

Read both cells. Require the staging cell to be live, oracle v4, deployer-locked, current, set-7 authenticated, and anchored to identity v4. Require the old public cell to match the recorded old outpoint.

- [ ] **Step 3: Resume to burn and public migration**

Resume the same restartable command. It burns the exact old public outpoint through owner escape, verifies it dead, fetches a strictly newer Hermes update, and migrates the staging cell output lock to the public OwnedTypeBindLock.

Expected: final public cell is live, has a later publish time than staging, and stores the candidate guardian full type hash.

- [ ] **Step 4: Promote canonical metadata**

The command invokes the pure promotion gate and atomically advances canonical guardian/oracle artifacts before writing the audit receipt. Guardian identity v4 becomes default; guardian code artifact remains v3; oracle code artifact remains v4.

- [ ] **Step 5: Verify legacy and current state**

Require the old public oracle dead, final public oracle live, new guardian live, and old guardian still live but marked legacy. Run an SDK discovery/update dry run using generated metadata and require it selects only the new public oracle and new guardian identity.

### Task 10: Update Preset, Documentation, and SDK 0.3.1

**Files:**
- Modify: `packages/sdk/src/presets/testnet.ts`
- Modify: `packages/sdk/tests/oracleVersionPreset.fixture.mjs`
- Modify: `README.md`
- Modify: `deployment/README.md`
- Modify: `packages/sdk/README.md`
- Modify: `packages/sdk/package.json`
- Modify: `packages/sdk/package-lock.json`

- [ ] **Step 1: Replace fixture identity values with verified chain values**

Set guardian identity v4 args/full identity, guardian lock script/code dep, and canonical guardian/oracle outpoints from the promotion result. Preserve guardian v1-v3 and oracle v1-v4 histories. Assert oracle latest version remains 4.

- [ ] **Step 2: Document exact behavior**

Document that anyone may rotate identity v4 only by preserving `(lock, type)` and supplying a valid immediate-successor governance VAA. State that identity v3 remains deployer-locked and live as legacy, and that identity v4 reuses guardian binary v3.

- [ ] **Step 3: Bump package metadata**

Run: `cd packages/sdk && npm version 0.3.1 --no-git-tag-version`

Expected: `package.json` and `package-lock.json` report `0.3.1`; no on-chain version changes.

- [ ] **Step 4: Run final release verification**

Run: `make contracts-test && make contracts-build`

Expected: contract tests/build PASS.

Run: `cd deployment && npm test`

Expected: all deployment suites PASS.

Run: `cd packages/sdk && npm run release:check`

Expected: SDK fixtures and packed consumer PASS.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add README.md deployment/README.md packages/sdk/README.md deployment/artifacts packages/sdk/src/presets/testnet.ts packages/sdk/tests/oracleVersionPreset.fixture.mjs packages/sdk/package.json packages/sdk/package-lock.json
git commit -m "guardian: promote permissionless testnet identity"
```

### Task 11: Review, Publish, and Registry-Verify

**Files:**
- No further source changes unless review finds a defect.

- [ ] **Step 1: Review the complete migration diff**

Review from design commit `589e9d9` through HEAD for trust regressions, incorrect version semantics, premature artifact promotion, wrong-outpoint burn risk, missing bind-lock deps, and secret leakage. Resolve all critical and important findings before publication.

- [ ] **Step 2: Verify package absence**

Run: `npm view lean-oracle-sdk@0.3.1 version --json`

Expected before publish: npm `E404` for version `0.3.1`.

- [ ] **Step 3: Publish with an ephemeral npm config**

Create a mode-`600` npm config under `/tmp`, write the operator-provided token only to that file, install a shell trap that removes it, and run `npm publish --access public` from `packages/sdk`.

Expected: `+ lean-oracle-sdk@0.3.1`; no token appears in repository files or command output.

- [ ] **Step 4: Verify the public registry artifact**

Install `lean-oracle-sdk@0.3.1` into a fresh `/tmp` consumer with scripts disabled. Import root plus `/ckb`, `/tx`, `/wormhole`, `/hermes`, `/presets`, `/fuel`, and `/advanced`. Assert the installed package version is `0.3.1`, guardian identity version is 4, oracle latest version is 4, and the preset outpoints equal the verified chain artifacts.

- [ ] **Step 5: Final live-chain and repository check**

Require guardian identity v4 and the public BTC oracle live, old public oracle dead, all referenced code deps live, worktree clean, and no temporary npm credential file present. Report exact transaction/outpoint/version evidence and the intentionally retained legacy guardian identity.
