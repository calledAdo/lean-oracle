# Builder Track Weekly Report — May 2026 (Week 3)

**Name:** Adokiye

## ✅ Completed Tasks

### SDK published to npm as `lean-oracle-sdk@0.1.0`

The `lean-oracle-sdk` package shipped its first public release. The full
release gate was proven before tagging:

```bash
cd packages/sdk
npm run release:check
```

which runs:

1. the full SDK fixture suite (all fast, no live chain required)
2. the tarball pack/install/import smoke test

The smoke test installs the packed tarball into a temporary consumer project
and imports every advertised subpath, verifying that no exports map is
misconfigured or missing from the published file list.

Key items in the final publish shape:

- package name: `lean-oracle-sdk`
- version: `0.1.0`
- `publishConfig.access = "public"` set
- `LICENSE` (MIT) included in the publish files
- `README.md` and `dist/` included
- Node engine declared `>=18`
- `prepublishOnly` enforces `release:check`, not just `tsc`

### `owned_type_bind_lock` contract introduced

A new CKB lock script was added to the contract workspace at
`crates/lean_oracle/contracts/owned_type_bind_lock/`. This lock is designed
specifically for **public, permissionless oracle cells** and replaces
AlwaysSuccess as the canonical lock for oracle state cells on testnet.

The lock enforces two properties simultaneously:

1. **Anyone may update the cell** — no key needed, as long as the cell's
   `(lock, type)` identity continues in the outputs.
2. **No one but the owner may burn or migrate the cell** — the lock refuses
   any transaction that drops, swaps, or collapses the bound identity without
   an owner authorization signal.

Authorization is split into two paths driven by the lock's `args` (32-byte
owner lock hash):

- **Owner-escape path.** If any transaction input's lock hash matches the
  stored owner lock hash, the lock returns success unconditionally. The owner
  cell's own lock script must run (and pass) to include that input, so the
  authorization is implicit and secure.

- **Continuity-bind path.** When no owner input is present, the lock verifies:
  - group input count equals group output count (no collapse, no extra outputs)
  - every group-input type hash appears in the group outputs

This is a meaningful protocol-level improvement. AlwaysSuccess was safe enough
for devnet smoke tests but left oracle cells capturable on a public chain. The
bind lock gives the canonical public deployment a real, auditable trust model.

### Contract error vocabulary centralized and extended

`crates/lean_oracle/contracts/common/src/errors.rs` is now the single source
of truth for all protocol error codes. New codes added this week cover the bind
lock:

| Code | Name | Meaning |
|------|------|---------|
| `40` | `ERROR_BIND_LOCK_ARGS_MALFORMED` | args not exactly 32 bytes |
| `41` | `ERROR_BIND_LOCK_NO_TYPE_SCRIPT` | bound cell missing a type script |
| `42` | `ERROR_BIND_LOCK_COUNT_MISMATCH` | group input / output count differs |
| `43` | `ERROR_BIND_LOCK_TYPE_NOT_FOUND` | input type hash absent from outputs |

Centralizing error codes here gives tests a stable failure vocabulary and
avoids silent code duplication across the three script crates.

### Contract test suite expanded significantly

The test crate grew from near-empty to ~4,830 lines this week across four test
modules:

| File | Lines | Coverage area |
|------|-------|---------------|
| `oracle_integration_tests.rs` | 3,547 | 74 integration tests via `ckb-testtool` |
| `oracle_data_tests.rs` | 803 | data encode/decode fixtures |
| `owned_type_bind_lock_tests.rs` | 313 | 6 integration tests for the new lock |
| `property_tests.rs` | 167 | proptest-based round-trip tests |

**`oracle_integration_tests.rs`** covers the full oracle script execution path:
guardian signature quorum verification, emitter chain/address matching, feed id
enforcement, publish time monotonicity, static field mutation detection, and
multi-path negative cases. All run through the actual RISC-V binary via the
`ckb-testtool` harness.

**`owned_type_bind_lock_tests.rs`** covers the six behavioral branches of the
new lock:

- owner escape passes with no continuity requirement
- continuity path passes when identity is preserved
- rejects transactions that collapse inputs
- rejects transactions that add extra outputs
- rejects transactions that swap the type script
- rejects args of the wrong length

**`property_tests.rs`** uses `proptest` for randomized round-trip validation:

- `oracle_data_roundtrip` — all 11 fields survive encode → decode across the
  full integer range; wire size is pinned at exactly 152 bytes
- `oracle_data_rejects_wrong_length` — `from_bytes` rejects every length except
  152, including truncations and paddings
- `guardian_set_data_roundtrip` — guardian set encoding round-trips for 1–19
  guardians, covering realistic quorum configurations
- `oracle_update_witness_roundtrip` — opaque accumulator blob survives round-trip
- `oracle_data_static_fields_reflexive` — identity check holds trivially
- `oracle_data_static_fields_detect_mutation` — mutating `feed_id` or
  `emitter_chain` is always detected

Property tests complement the fixed-fixture integration tests by covering every
sign/edge combination the oracle script will encounter rather than a curated
subset.

### Testnet deployment artifacts checked in

Deployment artifacts for testnet were locked into the repository under
`deployment/artifacts/`:

- `testnet.oracle-type.json` — oracle script at two versions:
  - **v1** — initial deployment (`promotedAt: 2026-05-10`)
  - **v2** — corrected deployment (`promotedAt: 2026-05-11`)
- `testnet.guardian-set-type.json`
- `testnet.deploy-guardian-set.json`
- `testnet.deploy-oracle.json`
- `testnet.owned-type-bind-lock.json`

Having two oracle-type versions tracked in the artifact is significant: the SDK
`presets` module now supports oracle-type-version pinning, so consumers can
explicitly request a specific deployed version instead of always defaulting to
latest.

### Deployment validation test suite added

`deployment/tests/` now contains two test files totalling ~580 lines of
coverage for the deployment tooling itself:

**`artifacts.test.mjs`** (~178 lines) — unit tests for artifact I/O helpers:
path composition, null-on-missing behavior, parse/write round-trips, and
schema checks.

**`validate.test.mjs`** (~401 lines) — integration tests for the
`validate:config` action, covering required fields, type constraints, version
reference checks, and cross-field consistency rules. This ensures deployment
config files are caught at validation time, not silently accepted and then
broken mid-broadcast.

### Root README rewritten as canonical project overview

The repository root `README.md` was rewritten from scratch as the public-facing
Pythnet-on-CKB overview. It now covers:

- architecture diagram showing the full Pythnet → Hermes → submitter → CKB chain flow
- what an update proves (guardian quorum, emitter identity, feed match, monotonic time)
- live deployment table linking testnet artifacts
- SDK quick-start with install, preset client, and custom network config examples
- consumer contract guidance (cell dep pattern, data layout, staleness responsibility)
- operator commands for maintaining oracle state cells
- security and threat model section with honest scope declaration

The old crate-level `README.md` was removed to avoid duplicate, diverging docs.

### Root `LICENSE` and `Makefile` added

A root-level `MIT LICENSE` was committed, covering the whole repository. A
`Makefile` was added with operator-facing shorthand commands for common
maintenance tasks like rebuilding contracts and running the canonical deployment
sequence.

### Deployment tooling expanded for `owned_type_bind_lock`

`deployment/src/oracleDeploy.ts` was significantly expanded to support deploying
oracle cells with the new bind lock instead of AlwaysSuccess. The deployment
flow now understands:

- which lock script to attach to the oracle state cell
- how to resolve the bind lock code dep outpoint for that lock
- how to wire the owner lock hash into the bind lock args

`deployment/src/validate.ts` was also updated to validate the bind-lock
configuration fields before any broadcast is attempted.

---

## 📚 Key Learning Areas

### 1. AlwaysSuccess is a devnet convenience, not a production lock

AlwaysSuccess was originally used as the oracle cell lock because it made
devnet testing simple. But it allows any transaction to burn or capture the
cell, which is unacceptable for public deployments.

The bind lock solves exactly the gap that AlwaysSuccess leaves: permissionless
updates remain possible for anyone, but the cell's type identity is preserved
across every update, and only the declared owner can remove it.

### 2. Property tests find edge cases that fixture tests cannot

The proptest suite immediately proved its value during development. Fixed
fixtures test the "happy path encoding" and a selection of known error cases.
Property tests cover the full integer range, sign boundaries, and length
variations — precisely the cases that are easy to overlook when writing test
data by hand.

The `oracle_data_rejects_wrong_length` test in particular covers 300 different
lengths, which is not practical as a fixture list.

### 3. Testnet version tracking belongs in artifacts, not memory

The oracle type was deployed twice before reaching the version used by the
SDK presets. Tracking both versions in the artifact file (rather than
overwriting with the latest) means:

- the SDK can offer type-version pinning with real on-chain data
- consumers stuck on an older version can still resolve their cell dep
- the deployment history is auditable without relying on git blame

### 4. Deployment validation tests pay back immediately

The first time `validate.test.mjs` was run against real config files, it caught
a cross-field inconsistency that would have produced a misleading error mid-broadcast.
Catching it at validation time instead — with a clear message — saved the kind
of debugging that burns time when the error surfaces ten steps later.

---

## 🛑 Risks Still Open

- The low-severity `elliptic` advisory through `@ckb-ccc/core` is still
  present. It should be tracked upstream rather than force-applied, since the
  automated fix would be breaking.
- The `owned_type_bind_lock` contract has not been audited. The logic is
  intentionally small and readable, but a formal review is needed before the
  oracle is used for high-value feeds.
- Mainnet deployment is inert — configs exist but no artifacts have been
  published. The testnet track must first demonstrate reliability at the
  expected update cadence.
- Advanced SDK subpath APIs (`/tx`, `/advanced`) may still shift as more
  consumer-side transaction authoring patterns are exercised.

---

## 🔜 Next Steps

1. Exercise the SDK against testnet oracle cells using real CKB wallets to
   validate the full update-and-read flow end to end.
2. Write consumer-facing examples demonstrating signing and submitting update
   transactions from a standard wallet (not the test harness key).
3. Begin the `owned_type_bind_lock` code review pass with a focus on the
   continuity-bind path edge cases.
4. Evaluate mainnet deployment readiness once testnet shows stable operation.

---

## 🧪 Commands Verified

```bash
# Contract tests
cd crates/lean_oracle
cargo test

# SDK release gate
cd packages/sdk
npm run release:check

# Deployment validation
cd deployment
npm run build
npm test

# SDK devnet integration (full suite)
cd packages/sdk
npm run test:integration:devnet
```
