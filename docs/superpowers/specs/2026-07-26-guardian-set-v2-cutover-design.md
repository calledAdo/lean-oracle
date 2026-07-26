# Guardian Set V2 Cutover Design

## Goal

Ship the trustless Wormhole guardian-set rotation implementation safely, migrate
the canonical CKB testnet guardian state from set 6 to set 7, update SDK and
deployment metadata, verify a current Hermes price update, and publish the SDK.

## Scope

The cutover covers the Rust guardian type script, SDK parsing and transaction
builders, deployment tooling, checked-in testnet metadata, the canonical public
BTC oracle when migration is required, documentation, and package publication.
It does not change the guardian cell's lock to a permissionless lock. The new
cell remains deployer-locked, so the type script verifies Wormhole governance
while the operator lock still authorizes the transaction.

## Trust Source

Wormhole's maintained canonical-set registry is the source for guardian upgrade
VAAs:

`https://raw.githubusercontent.com/wormhole-foundation/wormhole/main/guardianset/mainnetv2/canonical_sets/guardianSetVAAs.csv`

The `gs7` record must parse as a Core `GuardianSetUpgrade`, be emitted by chain
1/address `0x...04`, be signed by set 6, target all chains, declare set 7, and
contain the same 19 addresses reported by Wormholescan's current guardian-set
endpoint. Hermes must independently produce price VAAs carrying guardian set
index 7 before the testnet cutover is considered current.

The existing Wormholescan emitter-history fetch remains a compatibility source,
but the SDK fetcher must fall back to the canonical registry because the emitter
history endpoint does not currently return the `6 -> 7` record.

## Contract Verification

The on-chain implementation remains structurally unchanged unless the real VAA
test exposes a defect. A production-shaped integration test will spend a set-6
guardian cell, attach the official `gs7` VAA in `WitnessArgs.input_type`, produce
the exact set-7 cell data with quorum 13, and verify within an explicit cycle
ceiling. Existing negative tests continue to cover malformed governance data,
wrong identity/action/index/set/quorum, insufficient signatures, signature
ordering, and forged signers.

## SDK Design

The SDK keeps three separate responsibilities:

1. `parseGuardianSetUpgradeVaa` validates the VAA envelope and governance
   payload without pretending to verify signatures off-chain.
2. The canonical-registry fetch path locates the requested upgrade by parsed
   `newIndex`; the Wormholescan history path remains best-effort and both paths
   use the same parser before returning bytes.
3. `attachGuardianSetRotation` resolves the unique live cell, checks the
   immediate successor relationship, preserves lock/type identity, adjusts
   capacity for data growth, attaches the code dep, and writes the VAA to the
   correct input witness.

Fixtures will exercise the official `gs7` VAA, registry parsing/fallback,
transaction mutation including nonzero input offsets, keeper no-op/rotation
results, encoder validation, and the packaged `./wormhole` and `./tx` exports.

## Deployment State

Rotation must advance the canonical guardian-state record, not merely write an
unrelated receipt. The deployment toolbox will maintain a state artifact whose
live outpoint, set data, Type ID args, script identity, and capacity always refer
to the latest guardian cell. A separate rotation receipt may be retained for
audit history, but `deploy:oracle` must never read a spent pre-rotation outpoint.

Every real broadcast requires both `DRY_RUN=false` and `BROADCAST=true`. Dry-run
continues to avoid RPC writes and must report the exact planned transition.

## Testnet Sequence

1. Run all contract, SDK release, and deployment tests.
2. Build the optimized RISC-V contracts and record the guardian binary hash.
3. Broadcast `deploy:guardian-set-type`, then promote the candidate as v2.
4. Deploy a new v2 guardian Type ID cell initialized with canonical set 6.
5. Rotate that cell to set 7 with the official `gs7` VAA.
6. Confirm the old outpoint is spent and the new outpoint contains set 7,
   quorum 13, and the expected addresses under the v2 type script.
7. Update checked-in config, deployment artifacts, SDK preset/version history,
   and live-deployment documentation.
8. Inspect canonical public BTC oracle cells. If no v3 cell exists, deploy one
   against the new guardian identity. If an existing v3 cell is anchored to the
   old guardian identity, migrate it through the owner-authorized burn/recreate
   path. Do not burn an unrelated or user-owned cell.
9. Submit a current Hermes BTC update and verify the resulting cell has a
   nonzero current publish time and references the new guardian type hash.
10. Run release checks from the packed tarball, bump the SDK minor version,
    publish, and verify the registry package exposes the new subpaths.

## Failure Handling

No promotion occurs unless the deployed candidate's code hash equals the local
release binary hash. No state deployment occurs unless the promoted artifact is
canonical. No rotation occurs unless the official VAA parses as exactly `6 -> 7`
and its address list matches the current-set endpoint. No preset or npm release
is published until chain reads confirm the new live outpoint. Any failed or
ambiguous oracle discovery stops before a burn or redeploy.

## Verification Criteria

Completion requires fresh evidence for all of the following:

- Rust host tests and optimized contract build pass.
- The real `gs7` contract fixture verifies and remains below its cycle ceiling.
- SDK tests, deployment tests, and packed-consumer tests pass.
- Testnet code and state transactions are committed.
- The canonical guardian live cell is set 7 and matches Wormhole's 19 addresses.
- A current Hermes BTC VAA verifies through the new guardian cell.
- Checked-in artifacts and SDK preset match on-chain scripts and outpoints.
- The published npm version imports `lean-oracle-sdk/wormhole` and
  `lean-oracle-sdk/tx` successfully.
