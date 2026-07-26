# Owned-Bind Guardian Singleton Migration Design

## Goal

Make canonical testnet guardian rotations permissionless at the CKB lock layer
without changing the guardian or oracle contract binaries. Deploy a new
guardian singleton initialized to canonical Wormhole set 7 under
`OwnedTypeBindLock`, replace the public BTC/USD oracle with an authenticated
oracle v4 cell anchored to the new guardian identity, update deployment and SDK
metadata, and publish the preset change.

## Accepted Trade-off

The currently deployed guardian singleton cannot be burned or migrated at set
7. Its type script requires one group output and rejects same-index updates.
This migration therefore creates a second guardian lineage. The old
deployer-locked singleton remains live and is retained as legacy metadata, but
the SDK and public oracle move to the new lineage.

Creation of the new guardian cell is a trusted bootstrap: the guardian type
script checks Type ID correctness and internal data consistency, but no prior
cell exists in that lineage to authenticate set 7. Deployment must compare all
19 addresses and quorum 13 against Wormhole's current canonical set before the
new identity is promoted. Later rotations are authenticated on chain.

## Version Semantics

No contract binary changes in this migration:

- The guardian code deployment remains binary v3, with the existing code hash
  and Type ID-protected code-dependency outpoint.
- The new guardian singleton is recorded as guardian configuration/identity v4
  because its new Type ID args produce a new full script hash. The v4 identity
  references the same guardian v3 binary and code dependency.
- The oracle contract remains oracle v4. `oracleTypeVersions[4]`, the oracle
  code hash, and oracle code dependency do not change.
- The replacement BTC/USD cell is a new oracle v4 instance whose immutable
  `guardian_set_type_hash` points to guardian identity v4.
- SDK `0.3.1` carries the new preset. Its package version is not an on-chain
  oracle version and does not imply oracle v5.

Metadata must distinguish the guardian binary version from the singleton
identity version so the repository does not claim that a new binary was
deployed. Historical guardian identities v1-v3 remain available for explicit
inspection; the default becomes identity v4.

The guardian code-deployment artifact remains at v3 because no code cell is
deployed. Guardian state and SDK identity metadata carry v4 and explicitly
record `codeVersion: 3`.

## New Guardian Singleton

The deployment action derives the deployer's recommended secp256k1 lock and
its full script hash. It constructs the new guardian output with:

- the current guardian v3 code hash and a newly derived Type ID args value;
- canonical set index 7, quorum 13, and the exact 19 Wormhole addresses;
- `OwnedTypeBindLock` v2 as the output lock;
- the deployer's lock hash as the bind-lock owner-escape args.

The state artifact records both executable dependencies: guardian v3 for the
type script and OwnedTypeBindLock v2 for future spends. The deployed cell's
data, type, lock, occupied capacity, Type ID derivation, code hashes, and live
status must be read back before promotion.

For a future set 7 -> 8 rotation, any keeper can consume the guardian cell and
recreate the same `(lock, type)` identity. `OwnedTypeBindLock` accepts that
continuity without an operator signature, while the guardian type script
requires the authentic governance VAA. The keeper supplies and signs only its
own fee inputs.

## SDK and Rotation Builders

Network deployment metadata gains an explicit guardian-state lock reference
containing its script and code dependency. Testnet points this reference to the
new OwnedTypeBindLock instance. Mainnet and historical configurations remain
compatible when the field is absent.

`attachGuardianSetRotation` continues to preserve the live cell's lock and
type, but also attaches the configured guardian-lock code dependency when the
input uses `OwnedTypeBindLock`. It must reject a configured lock that does not
match the resolved guardian cell, preventing a plan that cannot execute. The
keeper API remains unsigned and fee-payer agnostic.

Deployment rotation follows the same rules. It no longer describes testnet as
operator-gated after identity v4 becomes canonical. Dry-run output includes the
input lock, guardian type dependency, bind-lock dependency, and serialized
unsigned transition.

## Oracle Cutover

The old and replacement oracle cells use the same oracle v4 type script and
feed args. Making both public under the same lock would cause discovery to
select between them by publish time during the cutover. The replacement is
therefore staged under the deployer's secp256k1 lock:

1. Deploy a zero-initialized oracle v4 cell under the staging lock with the new
   guardian identity hash and unchanged BTC feed/Pyth emitter configuration.
2. Update that staging cell from Hermes using an exact outpoint, canonical set
   7 guardian dependency, and a nonzero strictly current publish time.
3. Read the cell back and verify every immutable field and authenticated price
   field before touching the old public oracle.
4. Burn the old public oracle v4 through its OwnedTypeBindLock owner-escape
   path and verify its outpoint is dead.
5. Fetch a fresher Hermes update and spend the staging oracle into an output
   under the canonical public OwnedTypeBindLock. The oracle update path allows
   the lock change while enforcing unchanged feed, guardian hash, and emitter.
6. Verify the final public cell, then advance artifacts and the SDK preset.

There is a short interval between steps 4 and 5 with no public-lock BTC cell.
If step 5 fails, the authenticated staging cell remains live and retryable
under the operator lock. The old public oracle is never burned before the
replacement configuration and set-7 authentication have both succeeded.

## Artifacts and Publication

The cutover writes an audit receipt containing the old and new guardian
identities, old and new oracle outpoints, staging outpoints, transaction hashes,
verified block numbers, and canonical set digest. Canonical artifacts advance
only after live-chain readback. The legacy guardian outpoint remains documented
and must not be returned by default discovery.

The testnet preset changes its default guardian reference to identity v4 and
records the guardian lock dependency. Oracle v4 remains the default oracle
type. Documentation must state that the public guardian is permissionless to
rotate only when both lock continuity and governance verification pass.

After contract, SDK, deployment, pack, and live-chain checks pass, publish SDK
`0.3.1` and install that exact registry version into a clean consumer to verify
all advertised subpaths and the new preset values.

## Failure Handling

- Stop before broadcast if the canonical set source does not report set 7,
  quorum 13, and the exact expected address list.
- Stop promotion if the new guardian lock is not the recorded
  OwnedTypeBindLock script or its owner args do not equal the deployer lock
  hash.
- Stop before burning the old oracle unless the staging oracle is live,
  authenticated, current, and anchored to the new guardian full type hash.
- Do not change checked-in canonical metadata until the final public oracle is
  live and the old public oracle is dead.
- Do not attempt to destroy the legacy guardian singleton; its current type
  script does not permit that transition.
- A failed final oracle lock migration leaves the staging cell available for a
  retry and blocks preset/package publication.

## Verification Criteria

Completion requires fresh evidence for all of the following:

- Rust tests prove a third-party fee payer can rotate an OwnedTypeBindLock
  guardian cell with a valid governance VAA and cannot rotate it with an
  invalid VAA or broken lock/type continuity.
- SDK and deployment fixtures assert both guardian and bind-lock dependencies,
  lock matching, dry-run fidelity, finality, and artifact ordering.
- The new testnet guardian singleton is live under OwnedTypeBindLock and its
  data exactly matches canonical Wormhole set 7.
- A transaction built without the deployer guardian signature can satisfy the
  new lock continuity path; no set 8 broadcast is required to verify this in
  the local CKB-VM integration test.
- The replacement public BTC/USD oracle is oracle v4, has a nonzero current
  publish time, and stores the new guardian identity hash.
- The old public oracle outpoint is dead; the old guardian singleton remains
  explicitly marked legacy.
- Checked-in artifacts, documentation, and SDK preset exactly match live-chain
  scripts and outpoints.
- Full contract, deployment, SDK release, tarball-consumer, and registry-
  consumer checks pass before completion is reported.
