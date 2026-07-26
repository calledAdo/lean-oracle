# SDK Preset Identity Cleanup Design

## Goal

Make the SDK preset schema distinguish canonical on-chain deployment identity
from caller-owned oracle instances, distinguish guardian state identity from
guardian code deployment, and represent undeployed networks without fake script
hashes.

## Decisions

This is a deliberate pre-1.0 API cleanup for SDK `0.4.0`.

1. Rename `deployment.defaultPublicOracleLock` to
   `deployment.canonicalPublicOracleLock`. The preset describes the exact lock
   of the protocol's canonical public oracle. Personal oracle transactions
   continue to require a caller-supplied `oracleLockScript`.
2. Define the canonical testnet OwnedTypeBindLock owner hash and full lock
   reference once. Both the public oracle and guardian singleton reuse that
   object, eliminating duplicated literals and drift risk.
3. Replace the overloaded `guardianSetTypeVersions` history with:
   - `guardianSetIdentityHistory`, containing distinct state Type Script
     identities and their Type ID args;
   - `guardianSetCodeVersions`, containing executable code deployments and
     their CellDeps.
4. Keep `guardianSetType` as the current operational combination of canonical
   identity and executable dependency. Its `identityVersion` and `codeVersion`
   become required so callers cannot confuse those axes.
5. Represent mainnet as `LeanOracleUnavailableNetworkConfig`, with an explicit
   reason and no `deployment` object. `LeanOracleMainnetClient` remains usable
   for Hermes calls, while every CKB-backed client operation rejects before
   issuing an indexer/RPC request.

## Alternatives Considered

Keeping deprecated aliases would reduce immediate migration work, but it would
leave two names for the same canonical concept and retain optional-property
branches throughout transaction code. Documentation-only changes would not
prevent fake mainnet hashes or guardian version confusion. A fully nested
`guardianSet.identity/code/lock` redesign would be cleaner in isolation but is
larger than required; the split histories and required current-version fields
resolve the concrete ambiguity with a smaller migration.

## Data Model

`LeanOracleNetworkEndpoints` contains only the network name and RPC/Hermes URLs.
`LeanOracleNetworkConfig` extends it with a real `LeanOracleDeployment`.
`LeanOracleUnavailableNetworkConfig` extends it with
`deploymentStatus: "unavailable"`, a human-readable reason, and no deployment.
`LeanOracleNetwork` is their union.

`LeanOracleGuardianSetIdentityRef` contains `codeHash`, `hashType`, Type ID
`args`, and `identityVersion`. `LeanOracleGuardianSetCodeRef` contains
`codeHash`, `hashType`, `codeDep`, and `codeVersion`.
`LeanOracleGuardianSetTypeRef` combines both shapes for the currently usable
guardian singleton.

Testnet identity history contains versions 1, 2, and 4. Version 3 is absent
because the v2 and v3 configurations had the same state Type Script; v3 was a
new protected code-cell deployment, not a new guardian singleton identity.
Code history contains versions 1, 2, and 3. The v2 and v3 code hashes match,
but their dependency outpoints differ.

## Runtime Behavior

Oracle discovery, update, and burn use `canonicalPublicOracleLock` only when a
caller does not supply a lock override or when deciding whether to attach the
canonical lock dependency. Personal deployment remains caller-controlled.

Guardian resolution continues to query the exact current `guardianSetType`
script including Type ID args. Rotation continues to validate the exact
canonical guardian lock and attach both dependencies.

The base client accepts either available or unavailable network metadata.
Hermes methods need only endpoint metadata. CKB methods call one central
availability guard and throw `LeanOracleSdkError` containing the network name
and unavailability reason.

## Testing

Fixture and compile-time tests will prove the renamed public-lock field, shared
testnet lock reference, distinct guardian histories, required current version
fields, and absence of dummy mainnet deployment data. Client tests will prove
mainnet Hermes construction remains possible and CKB operations reject before
calling an injected client. The complete SDK release check and repository tests
must pass after documentation and examples are migrated.

## Compatibility

This removes three old public assumptions: `defaultPublicOracleLock`,
`guardianSetTypeVersions`, and `leanOracleMainnetPreset.deployment`. Consumers
must migrate to the explicit new names/types. The package version moves from
`0.3.1` to `0.4.0`; publishing is outside this change unless requested
separately.
