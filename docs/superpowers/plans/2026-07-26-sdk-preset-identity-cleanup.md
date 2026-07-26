# SDK Preset Identity Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ambiguous deployment preset fields with explicit canonical lock, guardian identity/code history, and unavailable-network models.

**Architecture:** Preserve the current operational deployment object for live networks, split historical guardian metadata by responsibility, and model undeployed mainnet as a discriminated network union. A single availability guard keeps CKB methods strict while endpoint-only Hermes methods remain available.

**Tech Stack:** TypeScript 5.8, Node.js ESM fixtures, `@ckb-ccc/core`, npm package fixtures.

---

### Task 1: Canonical Lock and Guardian Histories

**Files:**
- Modify: `packages/sdk/tests/oracleVersionPreset.fixture.mjs`
- Modify: `packages/sdk/tests/guardianIdentityTypes.compile.ts`
- Modify: `packages/sdk/src/types/deployment.ts`
- Modify: `packages/sdk/src/presets/testnet.ts`

- [ ] Add assertions that `canonicalPublicOracleLock` exists,
  `defaultPublicOracleLock` does not, the guardian lock shares the same script
  and dependency, identity history has keys `1,2,4`, and code history has keys
  `1,2,3`.
- [ ] Run `npm run build && node tests/oracleVersionPreset.fixture.mjs` and
  confirm it fails because the new fields do not exist.
- [ ] Add `LeanOracleGuardianSetIdentityRef` and
  `LeanOracleGuardianSetCodeRef`, require both version axes on the current
  reference, and rename the deployment fields.
- [ ] Build the testnet preset from shared lock, identity, and code constants.
- [ ] Re-run the focused fixture and `npm run test:types`; expect both to pass.

### Task 2: Migrate SDK Consumers

**Files:**
- Modify: `packages/sdk/src/ckb/findOracleCells.ts`
- Modify: `packages/sdk/src/tx/pullUpdate.ts`
- Modify: `packages/sdk/src/tx/burnOracle.ts`
- Modify: SDK fixture configurations under `packages/sdk/tests/`
- Modify: devnet integration helpers under `packages/sdk/tests/integration/`

- [ ] Change one transaction fixture to use only
  `canonicalPublicOracleLock`, run it, and confirm current production access to
  `defaultPublicOracleLock` fails.
- [ ] Rename production reads and all fixture deployment literals.
- [ ] Run the discovery, transaction-builder, client-state, guardian-rotation,
  and type fixtures; expect them to pass.

### Task 3: Explicit Unavailable Mainnet

**Files:**
- Modify: `packages/sdk/src/types/network.ts`
- Modify: `packages/sdk/src/presets/mainnet.ts`
- Modify: `packages/sdk/src/client/LeanOracleClient.ts`
- Modify: `packages/sdk/src/client/presets.ts`
- Modify: `packages/sdk/src/hermes/client.ts`
- Modify: `packages/sdk/src/hermes/feedCatalog.ts`
- Modify: `packages/sdk/src/presets/oracleVersion.ts`
- Modify: `packages/sdk/tests/clientCccInjection.fixture.mjs`
- Modify: `packages/sdk/tests/oracleVersionPreset.fixture.mjs`

- [ ] Assert that mainnet has `deploymentStatus === "unavailable"`, no
  `deployment`, and that a CKB client method rejects without calling an injected
  CCC client.
- [ ] Run the two focused fixtures and confirm the fake deployment/current
  client behavior makes them fail.
- [ ] Add endpoint, available, unavailable, and union network types plus a
  central `requireLeanOracleNetworkConfig` guard.
- [ ] Make Hermes APIs accept endpoint metadata, mainnet use the unavailable
  shape, and client CKB methods call the guard.
- [ ] Re-run the focused fixtures and TypeScript build; expect them to pass.

### Task 4: Public Documentation and Release Metadata

**Files:**
- Modify: `packages/sdk/README.md`
- Modify: `README.md`
- Modify: `packages/sdk/package.json`
- Modify: `packages/sdk/package-lock.json`
- Modify: public exports under `packages/sdk/src/`

- [ ] Search for old field names and inert-zero mainnet descriptions; record
  every remaining consumer-facing occurrence.
- [ ] Update examples and explanations to the canonical lock, split histories,
  and Hermes-only unavailable mainnet behavior.
- [ ] Export the new public types/guard, bump the SDK version to `0.4.0`, and
  update the lockfile root package version.
- [ ] Run `rg` again and expect old names only in this migration documentation.

### Task 5: Verification

**Files:**
- Verify all modified files.

- [ ] Run `npm run release:check` in `packages/sdk`; expect all fixtures and the
  packed-consumer test to pass.
- [ ] Run deployment tests and contract tests because the checked-in preset is
  shared with deployment documentation and operator workflows.
- [ ] Run `git diff --check`, inspect the complete diff for accidental artifact
  or secret changes, and confirm the worktree contains only intended changes.
