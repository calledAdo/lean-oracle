# Week 3 April 2025 — Progress Update Report

**Report type:** Weekly progress update (aligned with scholarship reporting expectations)

---

## 1. Project name, recipient name, and reporting period

| Field | Details |
|--------|---------|
| **Project name** | Lean Oracle — CKB oracle verification layer and TypeScript SDK |
| **Recipient name** | *[Replace with your full name as registered for the scholarship]* |
| **Reporting period** | Week of 14–20 April 2025 (Week 3 of April 2025) |

---

## 2. Work completed during the period — what was built, improved, or shipped?

Prior to this week the Lean Oracle work existed as a **scaffold**: a monorepo with the Rust Cargo workspace under `crates/lean_oracle/` (shared `common` crate, `oracle_script`, `guardian_set_script`, and host-side `tests`) and a **TypeScript SDK skeleton** under `packages/sdk/` with testnet/mainnet placeholders and a stub `LeanOracleClient`.

During Week 3 April 2025 we advanced that scaffold into a more credible development baseline:

- **Unit testing** — Expanded and tightened host-side tests around shared protocol logic (`lean-oracle-common`): parsing, error paths, and verifier helpers so regressions are caught before on-chain builds. Tests run against the same dependency pins as the contract stack to avoid host/contract drift.
- **Refactoring** — Clarified boundaries between the common library (pure parsing/verification) and the two type scripts (oracle cell vs guardian-set cell), reduced duplication in witness/data handling where safe, and kept `no_std` constraints intact for on-chain crates.
- **Integration testing** — Continued use of `ckb-testtool`-style flows to exercise real transaction skeletons against built contract binaries, including fixture-based cases and paths that mirror Hermes/Wormhole-style payloads where applicable.
- **SDK spin-up** — Firmed up the npm-oriented package layout: ESM entry points, `tsconfig` for `dist/` emit, placeholder `testnet` / `mainnet` network configs, and a minimal client shell so the next iteration can wire RPC/cell reads without restructuring the package.

Nothing was claimed as **production-shipped** this week; the focus was **engineering quality and test coverage** on top of the existing scaffold.

---

## 3. Link to the public repository

**Repository:** *[Insert your public Git URL when published — e.g. `https://github.com/<org-or-user>/lean_oracle`]*

**Note:** If the repository is not yet public, publish it before formal submission and replace this line with the live URL. Reviewers expect **active commits** within the reporting window; ensure Week 3 commits are visible on the default branch.

---

## 4. How Claude was used and how it contributed

Claude (via Cursor) was used as a **pair programmer and scaffolder**:

- Structuring the monorepo (`crates/` vs `packages/`), drafting `.gitignore`, README copy, and SDK `package.json` / `tsconfig.json` so conventions stay consistent.
- Accelerating **boilerplate** for tests and small refactors while we retained manual review of on-chain safety properties (panic behavior, `no_std`, and script boundaries).
- Summarizing and cross-checking **integration test** intent against the README architecture so new tests stayed aligned with the documented verification pipeline.

Claude did **not** replace design decisions on trust roots, guardian-set governance, or deployment parameters; those remain human-owned.

---

## 5. Significant obstacles and how they were or are being addressed

| Obstacle | Mitigation |
|----------|------------|
| **Dependency resolution** in the CKB test stack (pinned `ckb_schemars` / `ckb-fixed-hash-core` and related crates) | Kept explicit pins in the test crate manifest and documented them in comments; re-ran `cargo metadata` after moves to confirm the workspace still resolves. |
| **Splitting “host test” vs “on-chain”** concerns | Refactoring kept shared logic in `contracts/common` and avoided pulling std-only APIs into script crates. |
| **SDK still pre-feature** | Accepted as intentional: network presets and client are placeholders until RPC and cell layout APIs are finalized against testnet deployments. |

---

## 6. Planned for the following period (next week / early May)

- Wire the SDK to **concrete CKB RPC endpoints** and document oracle cell discovery for testnet, then mirror for mainnet.
- Add **adversarial** integration cases (stale updates, wrong feed, malformed VAAs) where not already covered.
- **CI** (optional next step): `cargo test` for the workspace and `npm run build` for the SDK on each push.
- Draft **deployment notes** for script hashes/cell deps once a testnet deployment exists.

---

## 7. Current status relative to production readiness

| Dimension | Approximate status | Notes |
|-----------|-------------------|--------|
| **On-chain verification pipeline** | **~55–65%** toward a first testnet-quality release | Core scripts and common lib exist; hardening and more edge-case tests remain. |
| **Host / integration test coverage** | **Improving** | Week 3 focused on depth of tests and integration paths, not feature count. |
| **TypeScript SDK** | **~15–25%** | Scaffold + types + client shell; no live reads/writes yet. |
| **Overall toward “production”** | **~40–50%** for a **narrow** oracle MVP (read path + governed updates) | Production for DeFi consumers would still need operational runbooks, monitoring, and audited deployment parameters. |

**Key milestones still ahead:** public repo with visible history, pinned testnet deployment, SDK read path against live cells, and a short security/review pass before encouraging third-party integration.

---

*End of Week 3 April 2025 update.*
