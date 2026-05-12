# Builder Track Weekly Report — May 2026 (Week 2)

**Name:** Adokiye

## ✅ Completed Tasks

### SDK package surface prepared for npm

The SDK moved from a broad internal work-in-progress surface toward a cleaner
published package shape under `packages/sdk`.

Key package-readiness work completed:

- package name set to `lean-oracle-sdk`
- ESM package exports defined for:
  - root API
  - `/ckb`
  - `/tx`
  - `/fuel`
  - `/hermes`
  - `/presets`
  - `/advanced`
- `README.md`, `LICENSE`, and `dist/` included in the publish file list
- Node engine declared as `>=18`
- `prepublishOnly` changed to run the release gate, not just TypeScript build

The release gate now runs:

```bash
npm run release:check
```

which executes:

- full SDK fixture suite
- tarball pack/install/import smoke test

This is important because a package can compile but still fail when installed
from npm if `exports` or generated files drift. The tarball smoke test now
catches that.

### Public API boundary clarified

The SDK root export was kept intentionally consumer-facing:

- client classes
- network presets
- core public errors
- core data types
- basic CKB decode helpers
- oracle-cell discovery

Lower-level or more volatile helpers remain behind subpaths:

- Hermes helpers and feed catalog lookup under `/hermes`
- transaction builders under `/tx`
- fee/fuel helpers under `/fuel`
- network/version helpers under `/presets`
- witness and advanced helpers under `/advanced`

One important correction made this week: oracle type-version helpers are
**not** root exports. They are intentionally imported from:

```ts
import {
  leanOraclePresetForOracleVersion,
  leanOracleLatestOracleVersion,
} from "lean-oracle-sdk/presets";
```

The tests and README were updated to lock that boundary in place.

### Devnet usage clarified as isolated SDK configuration

The SDK documentation was corrected so npm users are not told to depend on
this repository's deployment folders or internal artifact paths.

The devnet guidance now states the correct SDK pattern:

1. create a CCC client yourself
2. provide your own `LeanOracleNetworkConfig`
3. pass both to the base client:

```ts
const oracle = new LeanOracleClient({
  network: yourDevnetNetworkConfig,
  cccClient: yourCccClient,
});
```

This keeps the SDK isolated. Local devnet deployment metadata can come from any
tooling the user chooses, as long as it is shaped into the public
`LeanOracleNetworkConfig`.

The docs also clarify that preset clients are for published network constants.
Custom devnet deployments should use `LeanOracleClient` directly, not pretend
to be the testnet preset.

### Pyth feed ID discovery documented

Added documentation for finding Pyth feed ids through the SDK instead of
hardcoding or guessing symbols.

The README now shows:

```ts
import { findPythFeedIdBySymbol } from "lean-oracle-sdk/hermes";
import { leanOracleTestnetPreset } from "lean-oracle-sdk/presets";

const btc = await findPythFeedIdBySymbol(
  leanOracleTestnetPreset,
  "BTC/USD",
  { assetType: "crypto" },
);
```

The behavior was verified against Hermes:

- `"BTC/USD"` resolves successfully
- `"Crypto.BTC/USD"` resolves successfully
- `"btc/usd"` resolves successfully
- `"BTC"` does not match because it is ambiguous

The source commentary for `findPythFeedIdBySymbol` was also updated to explain
that it performs exact, case-insensitive matching against Pyth's full catalog
symbol and display symbol.

### SDK test coverage expanded

The SDK fixture suite was broadened substantially. New fast tests were added
for:

- OracleData encoding and integer range validation
- Oracle update witness framing
- Hermes URL/query construction
- guardian-set cell-dep resolution
- fee/fuel rebalancing branches
- read/deploy/burn transaction builders
- root-vs-subpath API boundaries

These tests are intentionally fast and do not require a live chain. They cover
behavior that was previously protected mostly by devnet integration tests.

### Tarball smoke test added

A package-level smoke test now:

1. builds the SDK
2. runs `npm pack`
3. installs the tarball into a temporary consumer project
4. imports every advertised subpath
5. checks representative exported symbols

This gives stronger confidence that the npm package can actually be consumed
after publication.

### Devnet integration suite verified from SDK side

The SDK integration suite was run against a live local devnet RPC at:

```text
http://127.0.0.1:28114
```

The suite verified:

- devnet RPC reachability
- oracle cell discovery
- oracle cell decoding
- high-level client reads
- read-deps transaction drafting
- guardian-set dependency resolution
- oracle update transaction drafting
- fee rebalancing
- personal oracle deploy and burn flow
- negative on-chain rejection cases
- oracle type-version pinning behavior

The SDK-side devnet env naming was also simplified from
`DEVNET_DEPLOYER_PRIVATE_KEY` to `DEVNET_PRIVATE_KEY`, since this is just the
private key used by the SDK integration harness.

---

## 📚 Key Learning Areas

### 1. npm readiness needs installed-package tests

TypeScript build success is not enough for npm readiness. The package can still
fail if:

- `exports` points to a missing file
- a subpath omits types
- the root API exposes the wrong symbol set
- a tarball excludes required files

The tarball install smoke test now catches that class of issue before publish.

### 2. Devnet belongs to explicit user configuration

A local devnet is not a variant of the public testnet preset. It has its own:

- RPC URL
- code hashes
- code deps
- lock scripts
- oracle and guardian-set deployment constants

The clean SDK abstraction is therefore `LeanOracleClient` plus a caller-supplied
`LeanOracleNetworkConfig`, not hidden coupling to repo-local deployment outputs.

### 3. Feed symbols need exact matching

Plain asset names like `"BTC"` are not precise enough for Pyth feed lookup.
There are many BTC-related feeds. The SDK helper now clearly documents exact
matching against:

- full symbol: `"Crypto.BTC/USD"`
- display symbol: `"BTC/USD"`

This avoids users accidentally selecting the wrong feed.

### 4. Keep stable and advanced surfaces separate

The SDK now has a clearer distinction between:

- stable root imports for ordinary consumers
- subpath imports for advanced transaction authors and tooling

That keeps the root API easier to learn while still exposing the lower-level
pieces needed for serious integrations.

---

## 🛑 Risks Still Open

- A low-severity transitive `elliptic` advisory remains through the
  `@ckb-ccc/core` dependency tree. The automated npm audit fix would be
  breaking, so this should be tracked upstream rather than force-applied.
- The package is still a `0.1.0` testnet-first SDK. Advanced/subpath APIs may
  still evolve as consumers exercise more transaction-author workflows.
- Live Hermes availability can affect integration tests that fetch fresh price
  updates. The fast SDK tests cover Hermes response handling, but true update
  integration still depends on network availability.

---

## 🔜 Next Steps

1. Publish the `0.1.0` testnet-first SDK after one final `npm run release:check`.
2. Track upstream dependency updates for the low-severity audit advisory.
3. Continue improving examples around signing and submitting transactions with
   user-provided CCC wallets.
4. Add more consumer-facing examples once the first npm users exercise the API.

---

## 🧪 Commands Verified

```bash
cd packages/sdk

npm test
npm run test:pack
npm run release:check
npm run test:integration:devnet
```

The release check and integration suite completed without SDK failures.
