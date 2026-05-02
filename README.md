# Lean Oracle

A monorepo for the Lean Oracle project on CKB.

## Layout

This repository is organized as two sibling sub-projects:

- `crates/lean_oracle/` — the Rust Cargo workspace that contains the on-chain
  oracle scripts and shared protocol logic. Each member crate lives under
  `crates/lean_oracle/contracts/` (the type scripts and the shared `common`
  crate) plus a host-side `tests` crate.
- `packages/sdk/` — the TypeScript SDK that will be published to npm so other
  applications can read and update the oracle on both CKB testnet and CKB
  mainnet.

The two sub-projects are independent: the Rust workspace is fully self-contained
inside `crates/lean_oracle/` and the TypeScript package is fully self-contained
inside `packages/sdk/`. They are only co-located here so the on-chain
verification code and the off-chain client code can evolve together.

## Sub-projects

### `crates/lean_oracle/`

The Cargo workspace defines three on-chain crates and a host-side test crate:

- `contracts/common` — shared parsers, hashing, data layouts, and verifier
  helpers used by both type scripts.
- `contracts/oracle_script` — the oracle cell type script.
- `contracts/guardian_set_script` — the guardian-set cell type script.
- `tests` — host-side and `ckb-testtool`-based integration tests.

See [`crates/lean_oracle/README.md`](crates/lean_oracle/README.md) for the full
project vision and architecture.

### `packages/sdk/`

The npm package will expose a small client surface for consuming the oracle:

- network presets for CKB testnet and CKB mainnet
- a client for reading the oracle cell and (later) submitting updates

The package is currently a scaffold and does not yet implement the client. The
final published name will be decided before the first release.

## Status

Scaffold only. Code wiring beyond the existing Rust crate has not been
implemented yet.
