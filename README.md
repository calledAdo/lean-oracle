# Lean Oracle

A Pyth/Wormhole price oracle for [CKB](https://www.nervos.org/). Hermes provides
signed Pyth price update bytes, Wormhole guardian-set data defines the trust
root, and on-chain CKB scripts verify and store the latest accepted price state
in oracle cells that downstream protocols can read as cell deps.

| | |
|---|---|
| **Testnet** | Live — see [Live Deployments](#live-deployments) |
| **Mainnet** | Inert (API/config surfaces exist; no deployment yet) |
| **SDK** | [`lean-oracle-sdk`](packages/sdk/) on npm |
| **License** | [MIT](LICENSE) |
| **Audit** | Not audited — see [Security](#security--threat-model) |

The repository contains the on-chain scripts, a TypeScript SDK, and a deployment
toolbox for publishing and operating the oracle.

## Why Lean Oracle

- **CKB-native cell model.** Each price feed is a single, addressable oracle
  cell consumers reference as a cell dep. No registry contract, no router —
  the cell *is* the feed.
- **Permissionless updates.** Anyone can push a fresh Hermes update; the
  `owned_type_bind_lock` preserves type continuity and gives the owner an
  escape path without gating who can publish prices.
- **Minimal trust additions.** The oracle inherits Pyth/Wormhole's guardian-set
  quorum security and adds nothing beyond it. Hermes is an untrusted transport.
- **Lean script footprint.** Three small CKB scripts (oracle, guardian-set,
  bind-lock) with shared parsing in one `common` crate. No precompiles, no
  hidden dependencies.
- **Honest scope.** The oracle verifies authenticity and monotonicity.
  Freshness limits and risk policy are explicitly the consumer's
  responsibility — no false guarantees baked in.

## Architecture

```text
        ┌──────────────────────────┐
        │  Pythnet (off-chain)     │  signs price updates
        └──────────────┬───────────┘
                       │  guardian signatures
                       ▼
        ┌──────────────────────────┐
        │  Hermes (untrusted CDN)  │  serves accumulator update blobs
        └──────────────┬───────────┘
                       │  fetched by anyone
                       ▼
   ┌────────────────────────────────────────┐
   │  Update tx submitter (any CKB wallet)  │
   │  - drafts tx via lean-oracle-sdk       │
   │  - rebalances fees                     │
   │  - signs + broadcasts                  │
   └──────────────┬─────────────────────────┘
                  │
                  ▼
   ┌────────────────────────────────────────┐
   │  CKB chain                             │
   │  ┌──────────────────────────────────┐  │
   │  │ oracle_script  (type script)     │  │  verifies:
   │  │  + owned_type_bind_lock (lock)   │  │   - guardian sig quorum
   │  │  + guardian_set cell (cell dep)  │  │   - emitter chain/address
   │  │                                  │  │   - feed id match
   │  │  ⇒ Oracle Cell (price state)     │  │   - publish_time monotonic
   │  └──────────────────────────────────┘  │
   └──────────────┬─────────────────────────┘
                  │  cell dep
                  ▼
        ┌──────────────────────────┐
        │  Consumer dApp / script  │  reads price, applies own
        │  (your protocol)         │  staleness/risk rules
        └──────────────────────────┘
```

## What an Update Proves

A successful update proves that:

- the update bytes are structurally valid
- the update is signed by the **active** guardian set (current-set-only policy)
- the update comes from the configured **emitter chain** and **emitter address**
- the message contains the expected **Pyth price feed id**
- the new `publish_time` is **strictly newer** than the existing oracle state
- the output oracle cell **exactly matches** the authenticated price message

The oracle verifies authenticity and monotonicity. **Freshness limits,
deviation bounds, and other application-specific risk rules are the consumer's
responsibility.**

## For Consumers: Reading Prices

Install the SDK and read the latest testnet price for a Pyth feed:

```bash
npm install lean-oracle-sdk @ckb-ccc/core
```

```ts
import { LeanOracleTestnetClient } from "lean-oracle-sdk";

const feedId =
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"; // BTC/USD

const oracle = new LeanOracleTestnetClient();
const state = await oracle.getOracleCellState({ feedId });

if (!state) throw new Error(`No oracle cell for ${feedId}`);

// Apply your own staleness policy — the oracle guarantees monotonicity, not freshness.
const ageSeconds = Math.floor(Date.now() / 1000) - Number(state.data.publishTimeUnix);
if (ageSeconds > 60) throw new Error(`Price stale: ${ageSeconds}s old`);

console.log({
  price: state.data.price,        // bigint, scaled by 10^expo
  expo: state.data.expo,
  publishTimeUnix: state.data.publishTimeUnix,
  outPoint: state.outPoint,       // use as a CKB cell dep from your script
});
```

On-chain consumers reference the oracle cell by `outPoint` as a `CellDep`,
decode its data using the layout in `crates/lean_oracle/contracts/common/`, and
apply their own staleness/deviation rules before acting on the price.

### No public oracle cell for your feed? Deploy your own.

`getOracleCellState` returning `undefined` means no live oracle cell exists for
that Pyth feed id under the default public lock. Any feed Pyth signs (ETH/USD,
SOL/USD, equities, FX, …) can be brought up by deploying your own oracle cell
under a lock script *you* control — the on-chain scripts are permissionless,
so anyone can host a cell for any valid feed:

```ts
import { ccc } from "@ckb-ccc/core";
import { leanOracleTestnetPreset } from "lean-oracle-sdk/presets";
import { initiateOracleDeployTx } from "lean-oracle-sdk/tx";
import { rebalanceFuel } from "lean-oracle-sdk/fuel";

const cccClient = new ccc.ClientPublicTestnet();
const signer = new ccc.SignerCkbPrivateKey(cccClient, process.env.CKB_PRIVATE_KEY!);
const myLock = (await signer.getRecommendedAddressObj()).script;

const tx = await initiateOracleDeployTx({
  network: leanOracleTestnetPreset,
  cccClient,
  feedId: "0x...ETH/USD feed id...",
  oracleLockScript: myLock,        // your lock governs subsequent updates
  capacity: 20_000_000_000n,       // shannons; size per cell layout + headroom
});

const balanced = await rebalanceFuel(tx, { cccClient, lockScript: myLock, fuelLimit: 32 });
if (balanced.status !== "ok") throw new Error("insufficient capacity");

await signer.sendTransaction(balanced.mutated);
```

The cell you deploy is yours: the lock you supply governs who can submit
subsequent updates and who can burn the cell. If you want public, permissionless
updates instead, deploy under the `owned_type_bind_lock` preset
([live deployments](#live-deployments)) — it keeps type continuity while
letting anyone push fresh prices, with an owner escape path.

See [`packages/sdk/README.md`](packages/sdk/README.md) for the full SDK API,
feed-id lookup, update-transaction drafting, and devnet integration.

## Live Deployments

### Testnet

Guardian set index **7**, quorum **13** (Wormhole mainnet guardians).

| Component | Version | Code Hash | Deploy Tx |
|---|---|---|---|
| `oracle_type`           | v4 (latest) | `0x5711c27408e948befdf55cdebf29b6ed0b6c56d8866200dab1dd53f28bef8c55` | `0x797167087bce4fa6b5bb1b6620f4e52bdad86bff28de159a732db0f82440131d` |
| `oracle_type`           | v3 (legacy) | `0xb2a48cc368e55269e4bd10a6548a1ff3a18aff7a290927268b42f42ecb197d63` | `0xf794a02d605a1d76cb6610c9c6bb344165f96d1b4bf27e695d7f5ce0c3542d3b` |
| `oracle_type`           | v2 (legacy) | `0x10c9bcc3af00fc3728cb95d5e14ec882716af5f531a010852526ce784f6958ec` | `0x45f033f0944b50be1e5b80f733c321648ddcfdbe0c183477cf0b77bd0f8312b5` |
| `oracle_type`           | v1 (legacy) | `0x2277560d62a11a92084654b67848ea893fcf3c1880e20a3ce9c0c19d0ee27dc3` | `0xf39d3cb5eccab560bdab65529f4e6f86c2dc8c966a4d49a2fd17bb277e75bba2` |
| `guardian_set_type`     | v3 (live dep; same v2 code) | `0x7ab8c7d225c0e74ecb01b58f8c7a13e298df08460d0947b776b2e47cd5525782` | `0x0903144bfb3a736d1a989783d0e6304c153bb5b7627b64843e73e9b2f58f42b9` |
| `guardian_set_type`     | v2 (legacy dep) | `0x7ab8c7d225c0e74ecb01b58f8c7a13e298df08460d0947b776b2e47cd5525782` | `0xfd256c6dbd3b0e2be05cb6f3cbe1f2a0aa2102bb1c1aa63ddeacd670d19b5524` |
| `guardian_set_type`     | v1 (legacy) | `0x57bddf3d57ea45c88ab68d0de706bbaecd68895fd6062b099626deb157100119` | `0x78f83c3967c566c50c783d45c9165af94d23018c5254228b3eb418aa0c5ac37f` |
| `owned_type_bind_lock`  | v2 (live dep; same code) | `0x5554bc20c9f3dbb8d1d7a6591b1b2ceeb0bbee822804635ee168911a440a111c` | `0xff625007fa8ba4ffbbaa97eb57fe70228228655a1fd72acb69e9abfbd1c4e065` |

All values, plus oracle/guardian-set cell outpoints and the full version
history, are checked in under
[`deployment/artifacts/testnet.*.json`](deployment/artifacts/). The SDK's
`leanOracleTestnetPreset` consumes these directly — most consumers do not need
the hashes by hand.

The canonical guardian singleton is **identity v4**, backed by unchanged
guardian code v3. It is live at
`0x8adbeb73600fb4b96ecc7c133c1e006663bfd93640d3ee51e6ee397d2d6470e4:0`
with Type ID args
`0xff1d70fbea716cb99b1b0b9906bf00255fe080808d07bd15352a56273a15a3d5`
and full type hash
`0xf952c3b4f0019c20eb9b1b4049e05df4e4bddad5700238251d9504f4303bd476`.
Its state lock is OwnedTypeBindLock v2: anyone may submit an immediate
Wormhole-authorized rotation when the exact `(lock, type)` pair continues in
the output. The owner escape remains available to the deployment key.

The former deployer-locked identity v3 singleton remains live at
`0x5d756dece38618d904c9617d9f1446d1c15d73b87af961ea72144cde1b600729:0`
as explicit legacy state; canonical SDK operations no longer reference it.
The current public BTC/USD oracle v4 cell is
`0x6fa71b298dffa04abe7a77e0fe631ab5d66cef1a79f3365ff43afcb96bd49d53:0`.
It remains oracle code v4 and now stores the guardian identity v4 full type
hash. The replaced public oracle at `0x52fac33042a7e677e86204a73527243b6c0de5b7dfa37d1eaab16d4a0a335ad0:0`
is spent.

These version axes are independent: guardian **identity v4** describes the
singleton and lock lineage, guardian **code v3** describes its executable
binary, and oracle **v4** describes the oracle executable. Changing only the
guardian state lock did not create oracle v5 or guardian code v4.

### Mainnet

Not deployed. `LeanOracleMainnetClient` supports Hermes calls, but CKB-backed
methods reject with an explicit deployment-unavailable error. The preset does
not ship fake mainnet script hashes or outpoints.

## Pythnet / Wormhole Components

Lean Oracle keeps the main pieces of the Pythnet/Wormhole model, but represents
them in CKB-native state:

- **Hermes** — off-chain transport for Pyth accumulator update blobs. Hermes
  is **not trusted**; it only delivers bytes that the scripts verify.
- **Guardian set** — the Wormhole guardian addresses and quorum used to verify
  update signatures. The active set lives in a guardian-set cell.
- **Emitter chain** — the Wormhole source chain id expected for Pythnet price
  messages.
- **Emitter address** — the expected Pyth emitter address for the configured
  source.
- **Feed id** — the 32-byte Pyth price feed id (e.g. BTC/USD) that identifies a
  specific oracle cell.
- **Accumulator update** — the signed update payload fetched from Hermes and
  supplied as witness data during oracle updates.

This implementation uses a **current-set-only** guardian policy. Only the
active canonical guardian set is accepted. After Wormhole guardian rotation,
callers must fetch a fresh Hermes update signed by the new active set. Guardian
code v3 validates the canonical Wormhole `GuardianSetUpgrade` VAA on-chain before
replacing the active addresses and quorum.

## Security & Threat Model

**What you trust when consuming a Lean Oracle price:**

1. **Wormhole guardian quorum** (13-of-19 on the configured set). A
   guardian-majority compromise can produce a fraudulent update Lean Oracle
   will accept.
2. **Pythnet emitter** at the configured chain id + emitter address — the
   source of the signed price messages.
3. **CKB consensus** for the chain Lean Oracle is deployed on.

**What you do *not* trust:**

- **Hermes** — pure transport; tampered or stale bytes are rejected by
  signature verification.
- **The update submitter** — anyone can push an update; the script enforces
  feed-id match, emitter match, signature quorum, and `publish_time`
  monotonicity.
- **Update frequency** — the oracle does not enforce a maximum age. If you
  need a freshness bound, enforce it in your consumer (see the snippet
  above).

**Known boundaries:**

- **Guardian rotation:** the current-set-only policy means an update signed by
  the previous set is rejected after the CKB guardian cell rotates. Identity v4
  combines governance-verifying guardian code v3 with OwnedTypeBindLock v2.
  Any submitter may rotate it only by preserving the exact `(lock, type)` pair
  and supplying the valid `N -> N+1` Wormhole governance VAA.
- **No price arbitration:** the oracle stores exactly what Pyth signed. If
  Pyth publishes an aberrant value, Lean Oracle will accept it. Consumers
  should apply deviation/sanity checks if their use case warrants.
- **No audit yet.** This codebase has not been independently audited. Treat
  the testnet deployment as experimental. Do not use Lean Oracle for
  mainnet-equivalent value at risk until an audit lands.

## Repository Structure

```text
crates/lean_oracle/        Rust workspace for CKB contracts and contract tests
  contracts/common/        Shared parsing, hashing, layouts, and verifier logic
  contracts/oracle_script/ Oracle cell type script
  contracts/guardian_set_script/
                           Guardian-set cell type script
  contracts/owned_type_bind_lock/
                           Public-update lock with owner escape path
  tests/                   Host-side and ckb-testtool integration tests

packages/sdk/              TypeScript SDK published as lean-oracle-sdk

deployment/                TypeScript deployment CLI and network config
  config/                  Checked-in network deployment intent
  artifacts/               Generated deployment outputs (per network)
  src/, tests/             Deployment actions, validators, and tests

docs/superpowers/specs/    Design specs (see below)
reports/                   Weekly progress reports
```

## Design Docs

- [Deployment pipeline design](docs/superpowers/specs/2026-05-04-deployment-pipeline-design.md)
  — how the deployment CLI promotes script versions and writes artifacts.
- [SDK devnet integration tests design](docs/superpowers/specs/2026-05-10-sdk-devnet-integration-tests-design.md)
  — how the opt-in devnet suite is structured.

## Development

### Contracts

```bash
make contracts-build   # build optimized RISC-V CKB binaries
make contracts-test    # host-side test suite + ckb-testtool integration
```

`contracts-test` runs against `x86_64-unknown-linux-gnu` so host test
dependencies do not get compiled for the no-std contract target.

### SDK

```bash
cd packages/sdk
npm install
npm test                 # codecs, discovery, builders, witnesses, exports
npm run release:check    # test + tarball-pack subpath check
```

See [`packages/sdk/README.md`](packages/sdk/README.md) for devnet integration
tests, custom CCC client wiring, and code-version pinning.

### Deployment toolbox

```bash
cd deployment
npm install
npm run build
npm test

node --enable-source-maps ./dist/index.js <action> \
  --network <testnet|mainnet|devnet>
```

Typical bootstrap order for a network:

```text
deploy:guardian-set-type → promote:guardian-set-type → deploy:guardian-set
rotate:guardian-set       → apply the next canonical governance VAA
deploy:oracle-type       → promote:oracle-type       → deploy:oracle
```

See [`deployment/README.md`](deployment/README.md) for required environment
variables, dry-run behavior, artifact formats, and local devnet overrides.

### Local devnet

The SDK is isolated from the deployment package: for a local devnet, build
your own `LeanOracleNetworkConfig` from local deployment metadata and pass it
plus a hand-built CCC client to `LeanOracleClient`. Do not use the testnet
preset for devnet cells. Generated local devnet artifacts should not be
committed.

## Contributing

Issues and pull requests welcome at
<https://github.com/calledAdo/lean-oracle/issues>.

The repo uses three checks that should pass before opening a PR:

```bash
make contracts-test
( cd packages/sdk && npm run release:check )
( cd deployment   && npm test )
```

## License

Lean Oracle is released under the **MIT License** — see [`LICENSE`](LICENSE).
This covers the on-chain Rust contracts, the TypeScript SDK, and the
deployment toolbox.
