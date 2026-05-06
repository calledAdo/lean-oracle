# Lean Oracle Deployment

This directory contains the deployment toolbox for Lean Oracle.

- `config/` — checked-in per-network deployment intent
- `.env` — operator-local RPC endpoints, keys, and one-off overrides
- `artifacts/` — generated deployment outputs
- `src/` — TypeScript deployment CLI

## What this toolbox does

The deployment flow has two layers:

1. **Code deployments**
   - `deploy:guardian-set-type`
   - `deploy:oracle-type`

   These publish contract binaries as code cells and record them as deployment artifacts.

2. **State deployments**
   - `deploy:guardian-set`
   - `deploy:oracle`

   These create the live guardian-set and oracle state cells using canonical promoted code versions.

Code deployment artifacts support:

- `latestCandidate` — the most recently deployed code candidate
- `versions` — explicit canonical promoted versions

Promotion actions move a candidate into the canonical version map:

- `promote:guardian-set-type`
- `promote:oracle-type`

## Script identity policy

Custom Lean Oracle scripts are published as raw code blobs and referenced with:

- `hashType: "data2"`

This is important. It is the expected script identity for the current Rust / `ckb-std` contract build path.

## Install and build

```bash
cd deployment
npm install
npm run build
```

## CLI entrypoint

All actions run through:

```bash
node --enable-source-maps ./dist/index.js <action> --network <testnet|mainnet|devnet>
```

Examples:

```bash
node --enable-source-maps ./dist/index.js deploy:guardian-set-type --network testnet
node --enable-source-maps ./dist/index.js promote:guardian-set-type --network testnet
node --enable-source-maps ./dist/index.js deploy:guardian-set --network testnet
```

## Preflight validation

Use `validate:config` before stateful actions:

```bash
node --enable-source-maps ./dist/index.js validate:config deploy:guardian-set --network testnet
node --enable-source-maps ./dist/index.js validate:config deploy:oracle --network testnet
```

Validation checks:

- selected network
- required RPC/key env vars
- config file presence
- build paths for code deployment actions
- canonical promoted code versions for state deployment actions
- required oracle overrides for `deploy:oracle`
- required guardian-set deployment artifact for `deploy:oracle`

## Environment

Copy `.env.example` to `.env`.

### Required per network

- `TESTNET_CKB_RPC_URL`
- `TESTNET_DEPLOYER_PRIVATE_KEY`
- `MAINNET_CKB_RPC_URL`
- `MAINNET_DEPLOYER_PRIVATE_KEY`
- `DEVNET_CKB_RPC_URL`
- `DEVNET_DEPLOYER_PRIVATE_KEY`

### Common optional controls

- `DEPLOY_NETWORK`
  - default network if `--network` is omitted
- `DRY_RUN`
  - defaults to `true`
  - set `DRY_RUN=false` for real broadcasts
- `BROADCAST`
  - operator flag kept alongside `DRY_RUN`; use `BROADCAST=true` for explicit real runs

### Required for `deploy:oracle`

- `ORACLE_FEED_ID`
- `ORACLE_EMITTER_CHAIN`
- `ORACLE_EMITTER_ADDRESS`

Example:

```bash
cd deployment
TESTNET_CKB_RPC_URL=http://example.invalid \
TESTNET_DEPLOYER_PRIVATE_KEY=0x00 \
DRY_RUN=true \
ORACLE_FEED_ID=0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43 \
ORACLE_EMITTER_CHAIN=26 \
ORACLE_EMITTER_ADDRESS=0xe101faedac5851e32b9b23b5f9411a8c2bac4aae3ed4dd7b811dd1a72ea4aa71 \
node --enable-source-maps ./dist/index.js deploy:oracle --network testnet
```

## Standard deployment flow

Run these in order for a given network:

1. `deploy:guardian-set-type`
2. `promote:guardian-set-type`
3. `deploy:guardian-set`
4. `deploy:oracle-type`
5. `promote:oracle-type`
6. `deploy:oracle`

That order matters:

- state deployments depend on canonical promoted code versions
- `deploy:oracle` depends on an existing broadcast guardian-set state deployment

## Broadcast behavior

When `DRY_RUN=false`, the toolbox performs real chain broadcasts.

Important current behavior:

- code deployment actions build the contracts first
- devnet broadcast paths use an explicit fee-rate fallback
- guardian-set and oracle state cells compute occupied capacity dynamically instead of using fixed placeholder capacities

## Artifacts

Artifacts are written under:

- `deployment/artifacts/`

Code deployments are stored by:

- `<network>.guardian-set-type.json`
- `<network>.oracle-type.json`

State deployments are stored by:

- `<network>.deploy-guardian-set.json`
- `<network>.deploy-oracle.json`

These artifacts are local operator state and are usually gitignored.

## Devnet note

`devnet` is the only network with extra script-resolution setup.

Because local offckb devnets do not necessarily share public-network system-script outpoints, the toolbox requires a devnet-specific `secp256k1_blake160` KnownScript override via env:

- `DEVNET_SECP256K1_BLAKE160_CODE_HASH`
- `DEVNET_SECP256K1_BLAKE160_HASH_TYPE`
- `DEVNET_SECP256K1_BLAKE160_DEP_TX_HASH`
- `DEVNET_SECP256K1_BLAKE160_DEP_INDEX`
- `DEVNET_SECP256K1_BLAKE160_DEP_TYPE`

Populate these from your local chain's actual system script deployment.

For example, inspect them with:

```bash
offckb system-scripts
```

This devnet override is intentionally minimal and only covers the script the current deployment flow needs for fee-paying secp cells.

## Network config

Per-network checked-in defaults live in:

- `config/testnet.json`
- `config/mainnet.json`
- `config/devnet.json`

These files define:

- build target paths
- guardian-set intent
- network label

The checked-in guardian list currently mirrors the Wormhole Ethereum guardian set at index `6`. Refresh it whenever the upstream guardian set rotates.
