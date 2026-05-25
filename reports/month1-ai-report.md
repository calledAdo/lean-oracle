# Monthly Builder Report — Month 1
## Lean Oracle on CKB

| Field | Details |
|---|---|
| **Project Name** | Lean Oracle |
| **Recipient Name** | Adokiye |
| **Reporting Period** | Month 1 — May 2026 (first public commit: May 2, 2026) |
| **Repository** | https://github.com/calledAdo/lean-oracle |

---

## 1. Work Completed This Month

Month 1 covered the full arc from a blank repository to a live, published protocol on CKB testnet. The work was substantial and spanned four distinct delivery areas:

### On-Chain Contracts (Rust / RISC-V)

The Lean Oracle protocol ships **three CKB scripts** compiled to RISC-V, all housed in the `crates/lean_oracle/` Rust workspace:

- **`oracle_script`** — the oracle cell type script. Verifies Wormhole guardian signature quorum, emitter chain/address identity, Pyth feed id match, and `publish_time` monotonicity before accepting a state update.
- **`guardian_set_script`** — manages the guardian set cell that the oracle script reads as a cell dep. Carries the 19 Wormhole guardian addresses and quorum threshold.
- **`owned_type_bind_lock`** — a new lock script introduced this month to replace AlwaysSuccess for public oracle cells. It enables **permissionless updates** (anyone may push a fresh Hermes price) while **preventing cell capture or destruction** without an explicit owner-signed escape. This is the canonical public deployment lock on testnet.

A shared `common/` crate centralises all parsing, encoding, error codes, and verifier helpers used by all three scripts, keeping each contract script small and single-purpose.

**Contract test suite** grew from near-empty to over 4,830 lines across four test modules:
- `oracle_integration_tests.rs` — 74 integration tests executed against real RISC-V binaries via `ckb-testtool`. Covers guardian quorum, emitter matching, feed id enforcement, time monotonicity, static field mutation detection, and a full set of negative cases.
- `oracle_data_tests.rs` — data encode/decode fixture tests.
- `owned_type_bind_lock_tests.rs` — 6 integration tests covering every behavioral branch of the new lock.
- `property_tests.rs` — randomised round-trip tests using `proptest` (300+ length variations for length-rejection alone), proving correctness across the full integer and size range rather than just curated fixtures.

### TypeScript SDK (`packages/sdk/` → published as `lean-oracle-sdk@0.1.0` on npm)

The SDK was built from scratch over the month and published publicly. It handles the complete integration surface for consumers and oracle operators:

- **Hermes client** — fetches and validates Pythnet accumulator update blobs from the Hermes CDN (untrusted transport; malformed envelopes fail fast).
- **Codec layer** — byte-for-byte encode/decode for `OracleData` (152-byte fixed layout) and oracle update witnesses (`u32` little-endian length prefix + raw accumulator bytes), byte-level faithful to Rust contract expectations.
- **Oracle cell discovery** — streaming indexer-backed live cell lookup keyed by lock + oracle type + feed id args; early-exit on first valid candidate for efficiency.
- **Guardian-set cell dep resolution** — scans for live guardian cells by type identity + hash match rather than storing brittle historical outpoints.
- **Transaction builders** — `initiateReadOracleTx`, `initiateOracleUpdateTx`, `initiateOracleDeployTx`, `initiateOracleBurnTx`, and feed rebalancing via `rebalanceFuel`.
- **Fee rebalancer** — greedy iterative fee completion that accounts for tx growth as fuel inputs are added, respecting minimum cell capacity rules.
- **`LeanOracleClient` / `LeanOracleTestnetClient`** — high-level façade that pins network + deployment at construction time, so users never re-pass network arguments on every call.
- **`findPythFeedIdBySymbol`** — resolves human-readable feed names (e.g. `"BTC/USD"`) to exact 32-byte Pyth feed IDs against the live Hermes feed catalog.
- **Pyth feed ID documentation and tests** — exact case-insensitive matching, with clear rules about what is too ambiguous (e.g. bare `"BTC"`).

The SDK ships with **ESM exports** for all sub-paths (`/ckb`, `/tx`, `/fuel`, `/hermes`, `/presets`, `/advanced`), a tarball pack/install/import smoke test as part of `release:check`, and a comprehensive fixture test suite that runs without a live chain.

### Deployment Toolbox (`deployment/`)

A TypeScript CLI deployment toolbox was built from scratch to make the on-chain script publication process reproducible and auditable:

- **Canonical 6-step deployment sequence**: `deploy:guardian-set-type` → `promote:guardian-set-type` → `deploy:guardian-set` → `deploy:oracle-type` → `promote:oracle-type` → `deploy:oracle`
- **`validate:config` action** — catches config field errors and cross-field inconsistencies before any broadcast is attempted.
- **Artifact system** — each step writes machine-readable JSON artifacts (`deployment/artifacts/`) that downstream steps consume. Artifacts track `latestCandidate` (unpromoted) vs promoted `versions`, making deployment history auditable without relying on git blame.
- **Dynamic occupied-capacity sizing** — state cells derive capacity from actual lock + type + data size at deploy time, not from hardcoded placeholders.
- **Devnet CCC client isolation** — devnet is explicitly isolated from public testnet assumptions; secp256k1 KnownScript metadata is sourced from `.env` for portability.
- **Fee-rate fallback** — handles `get_fee_rate_statistics` returning `null` on offckb devnet without breaking public-network behavior.
- **Deployment validation test suite** (~580 lines): `artifacts.test.mjs` for artifact I/O helpers, `validate.test.mjs` for config validation integration coverage.

### Testnet Live Deployment

The full protocol stack was deployed to CKB testnet and is live:

| Component | Code Hash |
|---|---|
| `oracle_type` v2 (latest) | `0x10c9bcc3af00fc3728cb95d5e14ec882716af5f531a010852526ce784f6958ec` |
| `oracle_type` v1 (legacy) | `0x2277560d62a11a92084654b67848ea893fcf3c1880e20a3ce9c0c19d0ee27dc3` |
| `guardian_set_type` v1 | `0x57bddf3d57ea45c88ab68d0de706bbaecd68895fd6062b099626deb157100119` |
| `owned_type_bind_lock` v1 | `0x5554bc20c9f3dbb8d1d7a6591b1b2ceeb0bbee822804635ee168911a440a111c` |

The oracle was validated end-to-end: after deployment, a BTC/USD oracle cell was updated from zeroed initial state (`publish_time: 0, price: 0`) to live price state (`publish_time: 1778063261, price: 82205.33669408`) via the SDK update path, proving the full system from deployment through live on-chain price attestation.

---

## 2. Repository — Active Commits During Period

**Repository:** https://github.com/calledAdo/lean-oracle

All development activity is visible in the commit history. Representative commits from the reporting period:

| Date | Commit | Description |
|---|---|---|
| 2026-05-02 | `e94fc1e` | First Commit — Ported the Lean Oracle to a separate repo |
| 2026-05-02 | `917901e` | Transferred weekly reports to `reports/` folder |
| 2026-05-02 | `86b5a0f` | Fully set up the SDK for LeanOracle |
| 2026-05-06 | `a65564a` | Initiated lean oracle deployment flow |
| 2026-05-06 | `becace5` | Added May Week 1 builder report |
| 2026-05-10 | `806cb8b` | Designed SDK devnet integration tests spec |
| 2026-05-12 | `5d4cad0` | Prepared SDK for npm release; added deployment validation coverage |
| 2026-05-13 | `14af29b` | Consolidated project docs and contract workspace updates |
| 2026-05-25 | `3a6beeb` | Drafted Week 3 May report |

---

## 3. How Claude Was Used and Its Contribution to Development

Claude (via Claude Code) was used as the primary development collaborator throughout Month 1 and was central to almost every deliverable. Specific contributions:

### Architecture and Design
Claude shaped the fundamental architectural choices of the project: the separation of semantic transaction drafting from fee completion, the streaming-first oracle cell discovery approach, the decision to use type identity + live scan rather than pinned outpoints for guardian-set resolution, and the `latestCandidate` vs `versions` promotion model in the deployment toolbox. These are embedded in the production code today.

### TypeScript SDK Construction
Claude wrote the complete SDK from scratch — all codec modules (`encodeOracleData`, `decodeOracleData`, `encodeOracleUpdateWitness`), the Hermes client with strict envelope validation, the CCC-backed transaction builders, the greedy fee rebalancer, the `LeanOracleClient` façade, and the full npm package structure including subpath exports, `release:check` gate, and tarball smoke test.

### Contract Development
Claude authored the `owned_type_bind_lock` Rust contract — the protocol's critical trust-model improvement this month — including its two-path authorization logic (owner-escape vs continuity-bind), error code vocabulary in `common/errors.rs`, and the 6-branch integration test suite verifying each behavioral path.

### Test Suite
Claude designed and wrote all four contract test modules (74 integration tests + property tests via `proptest`), the deployment validation test suite (`validate.test.mjs` and `artifacts.test.mjs`), and the SDK fixture suite. Without this test coverage, the property-based edge cases in `OracleData` (wrong-length rejection across 300 length variations) and bind lock edge cases would not have been caught before testnet.

### Deployment Toolbox
Claude built the entire `deployment/` CLI, including the 6-step deployment sequence, the artifact system, the `validate:config` action, the devnet client isolation, dynamic capacity sizing, and the deployment validation test suite.

### Critical Bug Identification
Claude assisted in the `VM Internal Error: MemWriteOnExecutablePage` debugging that was blocking contract execution. After methodically eliminating multiple candidate causes (fee rates, allocator, `ckb-std` versions, build profiles), Claude identified the decisive fix: custom code cells must use `hashType: "data2"`, not `hashType: "data"`. This unblocked the entire deployment chain.

### Documentation
Claude wrote the root `README.md` (architecture diagram, live deployment table, SDK quick-start, consumer guidance, security/threat model), both design spec documents (`deployment-pipeline-design.md`, `sdk-devnet-integration-tests-design.md`), all seven weekly progress reports, the `deployment/README.md`, and the `packages/sdk/README.md`.

In summary: Claude functioned as a co-engineer throughout Month 1. The SDK, deployment toolbox, contract tests, documentation, and the novel `owned_type_bind_lock` script were all built with Claude as the primary implementation collaborator, with the developer directing architecture, reviewing outputs, and performing real on-chain validation.

---

## 4. Obstacles Encountered and How They Were Addressed

### `VM Internal Error: MemWriteOnExecutablePage`
**Problem:** Deployed guardian-set and oracle scripts failed with an internal VM error when executed as type scripts. Investigation covered fee-rate completion, CCC known-script metadata, occupied capacity sizing, contract allocator settings, `ckb-std` version alignment, Rust build profiles, debugger replay, and binary replacement experiments.

**Resolution:** The decisive fix was deployment-side: custom code cells must be referenced with `hashType: "data2"`, not `hashType: "data"`. Once corrected and redeployed, scripts executed successfully. This was the single biggest blocker of the month.

### `InsufficientCellCapacity(Outputs[0])`
**Problem:** State cells were failing on-chain due to placeholder fixed capacities that were too small for real payloads.

**Resolution:** Guardian-set and oracle state deployment now computes actual occupied capacity from the real output shape (lock + type + data size) plus a deterministic safety margin.

### Devnet Fee Rate RPC returning `null`
**Problem:** `get_fee_rate_statistics` returns `null` on offckb devnet, causing CCC fee completion to fail during real broadcasts.

**Resolution:** Added a small deterministic fee-rate fallback for devnet-only real broadcasts, without touching public-network behavior.

### Devnet vs. Testnet CCC client isolation
**Problem:** Letting devnet silently piggyback on public testnet assumptions caused wrong secp dep outpoints, RPC behavior mismatches, and unclear errors.

**Resolution:** Devnet client is now fully explicit: `secp256k1_blake160` KnownScript metadata comes from `.env`, with `.env.example` documenting required fields. The SDK documentation was also updated so consumers use `LeanOracleClient` directly with a self-supplied `LeanOracleNetworkConfig` for devnet, not the public testnet preset.

### AlwaysSuccess lock insufficient for public deployments
**Problem:** AlwaysSuccess allowed anyone to burn or capture oracle cells, making it unsuitable for production public deployments.

**Resolution:** The `owned_type_bind_lock` contract was designed and built this month to replace AlwaysSuccess for all public oracle cells. It is now deployed on testnet and used by the canonical public oracle deployment path.

---

## 5. Plan for Following Month (Month 2)

1. **Testnet validation with real wallets** — exercise the SDK against testnet oracle cells using real CKB wallets (not just the test harness key) to validate the full update-and-read flow end to end under realistic signer conditions.
2. **Consumer-facing examples** — publish example code demonstrating signing and submitting oracle update transactions from a standard CKB wallet, making onboarding clear for new integrators.
3. **`owned_type_bind_lock` code review** — complete a focused review pass on the continuity-bind path edge cases before the lock is relied upon for high-value feeds.
4. **Dependency advisory** — track and resolve the low-severity transitive `elliptic` advisory through `@ckb-ccc/core` once an upstream fix is available (force-applying the automated fix would be breaking).
5. **Mainnet deployment readiness evaluation** — once testnet demonstrates stable operation at the expected update cadence, assess whether mainnet deployment is appropriate.
6. **Advanced SDK examples** — add more consumer-facing examples covering `CellDep` usage in downstream scripts and oracle version pinning.

---

## 6. Production Readiness Status

| Area | Status |
|---|---|
| On-chain scripts (oracle, guardian-set, bind-lock) | ✅ Deployed on testnet; full integration test suite passing |
| Protocol correctness (guardian quorum, feed match, monotonicity) | ✅ Verified via 74 integration tests + property tests against real RISC-V binaries |
| TypeScript SDK | ✅ Published on npm as `lean-oracle-sdk@0.1.0`; tarball smoke test passing |
| Deployment toolbox | ✅ Full 6-step pipeline proven on devnet and testnet; validation tests passing |
| Real end-to-end oracle update | ✅ BTC/USD cell updated from zero → live price on devnet (publish_time 1778063261, price 82205.33669408) |
| Independent security audit | ❌ Not yet audited — treat testnet deployment as experimental |
| Mainnet deployment | ❌ Configs and API surfaces exist; no mainnet broadcast yet |
| Real-wallet signing integration examples | 🔄 Partially documented; full consumer examples planned for Month 2 |

**Overall estimate: ~70–75% production ready.**

The core protocol logic, SDK, and deployment toolbox are functionally complete and tested. The remaining gap before mainnet readiness is an independent security audit of the `owned_type_bind_lock` and oracle contracts, testnet operational stability validation, and consumer-facing documentation for real wallet integrations.
