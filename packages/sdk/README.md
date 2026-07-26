# Lean Oracle SDK

TypeScript SDK for the [Lean Oracle](https://github.com/calledAdo/lean-oracle)
on CKB. The package is intended to be the primary off-chain entry point for
applications that want to read or update the oracle on CKB testnet.

- **License:** MIT
- **Repository:** <https://github.com/calledAdo/lean-oracle> (SDK at
  `packages/sdk`)
- **Issues:** <https://github.com/calledAdo/lean-oracle/issues>

> **Pre-release (`0.4.x`).** The curated root surface is stable; advanced
> subpath exports may still change. Pin a version in production.

Mainnet is not live yet. The first npm release is testnet-first; use
`LeanOracleTestnetClient` or pass an explicit `LeanOracleNetworkConfig`.
`LeanOracleMainnetClient` remains useful for Hermes calls. CKB-backed methods
throw a deployment-unavailable error until a mainnet deployment is published;
the mainnet preset contains no placeholder hashes.

## Status

This package already contains the core TypeScript surfaces for:

- **Hermes** — price-update fetching and response parsing helpers
- **CKB Codecs** — on-chain oracle and guardian-set data encode-decode helpers
- **Discovery** — oracle cell discovery and input resolution
- **Transactions** — transaction drafting for read and update flows
- **Rebalancing** — fee rebalancing helpers for complex oracle updates
- **Presets** — a live testnet deployment and explicit unavailable-mainnet metadata

The package is substantive and functional, though it continues to evolve
alongside the on-chain scripts.

## Install

```bash
npm install lean-oracle-sdk @ckb-ccc/core
```

The SDK is ESM-only and requires Node.js 18 or newer. Browser and worker
runtimes are supported for read/Hermes helpers when they provide `fetch`.

## Quick Start

Read the latest deployed testnet oracle state for a Pyth feed:

```ts
import { LeanOracleTestnetClient } from "lean-oracle-sdk";

const feedId =
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

const oracle = new LeanOracleTestnetClient();
const state = await oracle.getOracleCellState({ feedId });

if (!state) {
  throw new Error(`No oracle cell found for ${feedId}`);
}

console.log({
  outPoint: state.outPoint,
  price: state.data.price,
  expo: state.data.expo,
  publishTimeUnix: state.data.publishTimeUnix,
});
```

`state.data` decodes the full `OracleData` cell payload. Key fields:

```ts
interface LeanOracleDecodedCellData {
  feedId: `0x${string}`;        // 32-byte Pyth price feed id
  guardianSetTypeHash: string;  // code hash of the guardian-set cell dep
  price: bigint;                // signed spot price, scaled by 10^expo
  conf: bigint;                 // spot confidence
  expo: number;                 // signed decimal exponent
  publishTimeUnix: bigint;      // unix seconds
  prevPublishTimeUnix: bigint;
  emaPrice: bigint;
  emaConf: bigint;
  emitterChain: number;         // Wormhole emitter chain id
  emitterAddress: string;       // 32-byte Wormhole emitter address
}
```

Draft an update transaction. The returned transaction is structurally ready for
the oracle update path but still needs normal fee inputs/change and signing:

```ts
import { ccc } from "@ckb-ccc/core";
import { LeanOracleTestnetClient } from "lean-oracle-sdk";
import { rebalanceFuel } from "lean-oracle-sdk/fuel";

// Build a CCC signer however your app does it. Minimal example:
const cccClient = new ccc.ClientPublicTestnet();
const signer = new ccc.SignerCkbPrivateKey(cccClient, process.env.CKB_PRIVATE_KEY!);
const signerLockScript = (await signer.getRecommendedAddressObj()).script;

const oracle = new LeanOracleTestnetClient({ cccClient });

const tx = await oracle.draftOracleUpdateTx({ feedId });
const rebalance = await rebalanceFuel(tx, {
  cccClient,
  lockScript: signerLockScript,
  fuelLimit: 32,
});

if (rebalance.status !== "ok") {
  throw new Error(
    `Not enough CKB capacity for fees; need ${rebalance.extraCapacityNeededShannons}`,
  );
}

const txHash = await signer.sendTransaction(rebalance.mutated);
```

See [Custom CCC client](#custom-ccc-client) below for sharing/injecting a
preconfigured CCC `Client`.

## Finding Pyth Feed IDs

Oracle cells are keyed by a 32-byte Pyth price feed id. You can look up feed ids
from Pyth's public catalog or through the SDK's Hermes catalog helper.

For example, to find BTC/USD, pass the display symbol `"BTC/USD"`:

```ts
import {
  findPythFeedIdBySymbol,
} from "lean-oracle-sdk/hermes";
import { leanOracleTestnetPreset } from "lean-oracle-sdk/presets";

const btc = await findPythFeedIdBySymbol(
  leanOracleTestnetPreset,
  "BTC/USD",
  { assetType: "crypto" },
);

if (!btc) {
  throw new Error("BTC/USD feed not found in Pyth catalog");
}

console.log(btc.id);
```

`findPythFeedIdBySymbol` performs an exact, case-insensitive match against
Pyth's full catalog symbol (`"Crypto.BTC/USD"`) and display symbol
(`"BTC/USD"`). Plain `"BTC"` is intentionally not enough: the catalog contains
many BTC-related feeds such as `WBTC/USD`, `TBTC/USD`, and `CBBTC/USD`.

Use `fetchPythFeedCatalog` from `lean-oracle-sdk/hermes` when you want to build
a search UI or list multiple feeds. You can also browse Pyth's published feed
list at <https://www.pyth.network/developers/price-feed-ids>.

## Layout

- `client/` — primary consumer-facing client surface (`LeanOracleClient`)
- `hermes/` — Pyth/Hermes fetch and parsing helpers
- `ckb/` — manual byte codecs for oracle and guardian-set cells (guardian-set
  cell data: 12-byte LE header `set_index`, `quorum`, `guardian_count`, then
  `guardian_count` × 20-byte addresses; no lifecycle timestamps)
- `tx/` — transaction pipelines and building workflows
- `wormhole/` — guardian upgrade VAA parsing and canonical-registry fetching
- `presets/` — network configuration presets, CCC lock preset wiring, and
  oracle-type code-version helpers
- `witness/` — oracle update witness encoding
- `types/` — shared TypeScript definitions
- `internal/` — internal helpers and stubs

## Imports

The package root is the **stable, consumer-facing API**: client classes,
network presets, public errors and core (non-transport) types, basic
decode helpers, and oracle-cell discovery.

```ts
import {
  LeanOracleTestnetClient,
  decodeLeanOracleCellDataHex,
  decodeGuardianSetCellDataHex,
} from "lean-oracle-sdk";
```

Hermes fetch helpers and Hermes-specific types live under the dedicated
`/hermes` subpath:

```ts
import {
  fetchHermesLatestPriceUpdates,
  buildHermesSseStreamUrl,
} from "lean-oracle-sdk/hermes";

import type {
  HermesBinaryUpdateEnvelope,
  OracleUpdateOutputSource,
} from "lean-oracle-sdk/hermes";
```

Guardian rotation parsing and transport live under `/wormhole`; transaction
attachment and keeper planning remain under `/tx`:

```ts
import {
  fetchGuardianSetUpgradeVaa,
  parseGuardianSetUpgradeVaa,
  wormholeQuorum,
} from "lean-oracle-sdk/wormhole";
import {
  attachGuardianSetRotation,
  buildGuardianSetRotationIfBehind,
} from "lean-oracle-sdk/tx";
```

Lower-level helpers (witness encoders, transaction-mutation primitives,
fee/fuel rebalancing, guardian-dep resolution, output construction) are
**explicit subpath imports**:

```ts
// Low-level tx mutation primitives
import { attachOraclePullUpdate }
  from "lean-oracle-sdk/tx";

// Fee / fuel / capacity primitives
import {
  rebalanceTransactionFeeAfterOracleMutation,
  collectPlainFuelCellsByLock,
} from "lean-oracle-sdk/fuel";

// Off-chain oracle output construction, witness encoders, and other
// advanced helpers
import {
  buildOracleOutputFromHermesParsed,
  encodeOracleUpdateWitnessFromAccumulatorHex,
} from "lean-oracle-sdk/advanced";
```

Available subpaths: `./ckb`, `./tx`, `./fuel`, `./hermes`, `./wormhole`,
`./presets`, `./advanced`.

### Reading the latest oracle state

Use `getOracleCellState` to locate and decode the latest live oracle cell for a
feed in one call. Returns `undefined` when no matching cell exists.

```ts
import { LeanOracleTestnetClient } from "lean-oracle-sdk";

const client = new LeanOracleTestnetClient();
const current = await client.getOracleCellState({ feedId });
if (current) {
  console.log(current.data.price, current.data.publishTimeUnix);
}
```

### Update output source: `parsed` vs `binary`

When drafting an oracle update, the SDK needs to populate the **dynamic price
fields** (price/conf/expo/publish_time/...) of the new output cell. Two modes
are supported via `outputSource`:

```ts
// Default — copy fields from Hermes `parsed`. Cheap and fast.
await client.draftOracleUpdateTx({ feedId });

// Opt-in — parse `binary.data[0]` client-side and use those fields.
// Useful for binary-only envelopes or to surface format mismatches before
// a transaction is ever submitted.
await client.draftOracleUpdateTx({ feedId, outputSource: "binary" });
```

In **both** modes the witness carries the same `binary.data[0]`, and the
on-chain `oracle_script` cryptographically verifies it. `outputSource` only
changes where the *output cell* fields come from off-chain. Default behavior
is `"hermes-parsed"` and is unchanged from prior releases.

### Custom CCC client

`LeanOracleClient`, `LeanOracleTestnetClient`, and `LeanOracleMainnetClient`
all accept an optional preconfigured CCC `Client`. When omitted, the SDK
constructs a public client (`ClientPublicMainnet` / `ClientPublicTestnet`)
from the network's JSON-RPC URL. Pass `cccClient` when you need to share a
single CCC instance across services, point at an authenticated/private CKB
endpoint, or inject a test fake.

```ts
import { LeanOracleTestnetClient } from "lean-oracle-sdk";
import { ClientPublicTestnet } from "@ckb-ccc/core";

const cccClient = new ClientPublicTestnet({ url: process.env.CKB_RPC_URL });
const oracle = new LeanOracleTestnetClient({ cccClient });
```

> Prefer root imports when possible; reach for subpaths when you need
> transaction-author-level control. See the pre-release stability note at the
> top of this README.

### Code upgrades and cell versions

CKB type scripts are immutable per cell: the `type.codeHash` of an oracle
cell is fixed when the cell is created. If the canonical `oracleType` code is
ever upgraded — a new `oracle_type` binary, hence a new `codeHash` — then
cells that were created under the **old** `codeHash` are not reachable via the
default preset, because discovery queries the indexer filtered by the latest
`codeHash`.

The bundled presets carry their full code-version history under
`deployment.oracleTypeVersions` (a map keyed by version number, mirroring
`deployment/artifacts/<network>.oracle-type.json#versions`). The latest entry
equals `deployment.oracleType`, which is what discovery, update, deploy, and
burn use by default — this map does **not** change default behaviour. The
current testnet default is oracle v4. It preserves v3's zero-initialized
creation behavior; the new code identity makes the build reproducible after
guardian governance was added to the shared contract crate.

To operate on a cell created under a prior code version, build a config pinned
to that version with `leanOraclePresetForOracleVersion`:

```ts
import {
  leanOracleTestnetPreset,
  leanOraclePresetForOracleVersion,
} from "lean-oracle-sdk/presets";
import { LeanOracleClient } from "lean-oracle-sdk";

// Operate on cells created under oracle_type v1.
const oracle = new LeanOracleClient({
  network: leanOraclePresetForOracleVersion(leanOracleTestnetPreset, 1),
});
```

`leanOracleLatestOracleVersion(config)` returns the highest version key in the
history (or `undefined` for an unavailable network like mainnet before launch).
`leanOraclePresetForOracleVersion` throws a `LeanOracleSdkError` if the config
has no version history or the requested version is absent.

The testnet guardian state identities are recorded under
`deployment.guardianSetIdentityHistory`, while executable deployments are
recorded independently under `deployment.guardianSetCodeVersions`. Canonical
guardian **identity v4** has
Type ID args
`0xff1d70fbea716cb99b1b0b9906bf00255fe080808d07bd15352a56273a15a3d5`
and reuses guardian **code v3**. The version increment describes the new
singleton/lock lineage, not a new binary. Oracle code remains independently at
**v4**; no oracle v5 was created for this guardian-lock migration.

Identity v4 is locked by `deployment.guardianSetLock`, an
OwnedTypeBindLock v2 instance. Anyone may rotate the singleton by preserving
its exact `(lock, type)` identity and attaching a valid immediate-successor
Wormhole `GuardianSetUpgrade` VAA. Both the lock dependency and guardian code
dependency are attached by `attachGuardianSetRotation`. The former
deployer-locked identity v3 singleton remains live as legacy state but is no
longer selected by the canonical preset.

SDK `0.4.0` makes these distinctions explicit. Custom network configurations
must rename `defaultPublicOracleLock` to `canonicalPublicOracleLock`, replace
`guardianSetTypeVersions` with separate `guardianSetIdentityHistory` and
`guardianSetCodeVersions` maps, and include `identityVersion` plus `codeVersion`
on the current `guardianSetType`. `leanOracleMainnetPreset` is now an
unavailable-network config with no `deployment` property.

## Scripts

- `npm run build` — type-check and emit to `dist/`
- `npm run clean` — remove `dist/`
- `npm run test` — build, then run SDK fixture checks for codecs, discovery, client behavior, transaction builders, fee balancing, package boundaries, and accumulator parsing
- `npm run test:pack` — pack the SDK, install it into a temporary consumer project, and import every advertised subpath
- `npm run release:check` — `npm test && npm run test:pack`
- `npm run migrate:owned-bind-guardian:testnet` — repository operator workflow
  for the guarded, restartable identity-v4 cutover
- `npm run prepublishOnly` — clean, then run the release check before `npm publish`
- `npm run test:integration:devnet` — run the repository's opt-in integration tests against an already-deployed local devnet

## Devnet Integration Tests

This repository has an opt-in integration suite for local devnet:

```bash
cd packages/sdk
npm run test:integration:devnet
```

The published SDK is isolated from this repository's deployment tooling. For a
local devnet, create your own CCC client and provide a complete
`LeanOracleNetworkConfig` whose `deployment` values come from your own local
deployment process. Do not use the testnet preset for devnet cells; the preset
contains the public testnet deployment constants.

### Environment

- `DEVNET_CKB_RPC_URL` defaults to `http://127.0.0.1:28114`.
- `HERMES_BASE_URL` defaults to `https://hermes.pyth.network`.
- `ORACLE_FEED_ID` defaults to the BTC feed used by the integration tests.
- `DEVNET_PRIVATE_KEY` is the private key used by signer-required tests
  to derive a secp256k1 lock, collect plain fuel cells, sign transactions, and
  optionally broadcast mutations.
- `DEVNET_BROADCAST_UPDATES=true` enables mutating tests that submit update,
  deploy, and burn transactions. Leave unset to avoid changing chain state.

Example:

```bash
cd packages/sdk
DEVNET_CKB_RPC_URL=http://127.0.0.1:28114 \
DEVNET_PRIVATE_KEY=0x... \
DEVNET_BROADCAST_UPDATES=true \
npm run test:integration:devnet
```

Missing signer env skips signer-required tests. An unreachable devnet RPC fails
the suite because the command explicitly targets a local devnet deployment.

### Creating a Devnet Client in Your Own Script

Published testnet/mainnet presets are available from `lean-oracle-sdk`, but
local devnets should use the base `LeanOracleClient`. Build a
`LeanOracleNetworkConfig` from your own local deployment metadata, create the
CCC client yourself, then pass both into the SDK:

```ts
import { ccc } from "@ckb-ccc/core";
import { LeanOracleClient } from "lean-oracle-sdk";

const rpcUrl = process.env.DEVNET_CKB_RPC_URL ?? "http://127.0.0.1:28114";

const network = {
  name: "devnet",
  ckbJsonRpcUrl: rpcUrl,
  hermesBaseUrl: process.env.HERMES_BASE_URL ?? "https://hermes.pyth.network",
  deployment: {
    // The canonical public lock used when callers do not pass
    // `oracleLockScript` explicitly. This may be AlwaysSuccess, an
    // owned-type-bind-lock instance, or another lock from your devnet setup.
    canonicalPublicOracleLock: {
      script: {
        codeHash: "0x...",
        hashType: "type",
        args: "0x...",
      },
      codeDep: {
        outPoint: { txHash: "0x...", index: 0n },
        depType: "code",
      },
    },
    oracleType: {
      codeHash: "0x...",
      hashType: "type",
      codeDep: {
        outPoint: { txHash: "0x...", index: 0n },
        depType: "code",
      },
    },
    guardianSetType: {
      codeHash: "0x...",
      hashType: "type",
      args: "0x...",
      identityVersion: 1,
      codeVersion: 1,
      codeDep: {
        outPoint: { txHash: "0x...", index: 0n },
        depType: "code",
      },
    },
    pythEmitter: {
      chain: 26,
      address: "0xe101faedac5851e32b9b23b5f9411a8c2bac4aae3ed4dd7b811dd1a72ea4aa71",
    },
  },
};

const cccClient = new ccc.ClientJsonRpc(rpcUrl);
const oracle = new LeanOracleClient({ network, cccClient });
```

If your oracle cells are locked by a script other than
`network.deployment.canonicalPublicOracleLock.script`, pass that lock on each
operation:

```ts
await oracle.getOracleCellState({ feedId, oracleLockScript });
await oracle.draftOracleUpdateTx({ feedId, oracleLockScript });
```
