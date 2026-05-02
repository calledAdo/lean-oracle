# Builder Track Weekly Report — April 2025 (Week 3)

**Name:** Adokiye

## ✅ Completed Tasks

### Oracle live cell discovery (indexer-backed)

- Implemented discovery keyed by the pair:
  - **LOCK** script (default public lock from deployment, or explicit user lock)
  - **TYPE** script (oracle type script with **feed id in `args`**)
- Used CCC `client.findCells` with:
  - `script` = lock
  - `scriptType` = `"lock"`
  - `scriptSearchMode` = `"exact"`
  - `filter.script` = oracle type script
  - `withData: true` so `OracleData` can be inspected during selection

**Why this query shape:** anyone can mint cells, but not every cell is “your oracle instance”. Filtering by oracle type + feed id args is the highest-signal constraint; lock choice scopes public vs personal deployments.

### Guardian set `CellDep` resolution

- Implemented scanning for live guardian-set cells matching deployment’s guardian type script identity.
- Validated candidates against the **expected guardian set type hash** implied by the consuming oracle cell’s decoded `OracleData` (so the attached dep matches what the oracle script will load/consume logically).

**Design note:** guardian set cells can rotate/replace on-chain; storing only a historical outpoint in config is brittle. The SDK therefore leans on **type identity + live scan + hash match**, not a permanent outpoint pin for the state cell.

### Transaction drafting: read path vs update path

#### Read deps (`packages/sdk/src/tx/readDeps.ts`)

- Select an oracle live cell and attach it as a **`CellDep`** so downstream scripts can read `OracleData` without consuming the oracle cell.
- Attach **`oracleTypeScriptCodeDepOutPoint`** as a code dep so verification can load oracle script bytecode when needed.

#### Pull update (`packages/sdk/src/tx/pullUpdate.ts`)

- Resolve the input oracle live cell, `getCell` to ensure current live view.
- Obtain Hermes update material (envelope) and:
  - write witness lock bytes using `encodeOracleUpdateWitness…`
  - compute next `OracleData` output bytes (initially via Hermes `parsed`)
- Attach required deps:
  - guardian set dep (for the update verification path)
  - oracle type code dep
  - AlwaysSuccess **lock code dep** when spending an AlwaysSuccess-locked oracle input (lock scripts need their code cell dep)

**Important CCC detail:** `addInput` returns the new input list length; witness placement must use **`length - 1`** as the input index. Getting this wrong produces transactions that look plausible locally but fail witness indexing rules.

### Workflows + client façade

- Added high-level draft helpers in `packages/sdk/src/tx/workflows.ts`:
  - `initiateReadOracleTx`
  - `initiateOracleUpdateTx`
- `LeanOracleClient` (`packages/sdk/src/client/LeanOracleClient.ts`) routes users through:
  - network-aware Hermes fetch
  - CCC client construction from `ckbJsonRpcUrl` + `network.name` (testnet vs mainnet client class)

**UX principle:** once you construct a client for a network, you should not need to pass `network` again on every method.

---

## 📚 Key Learning Areas

### 1. Indexer iteration is async streaming, not `Promise<Cell[]>`

CCC exposes `findCells` as an async iterable generator. Early implementations sometimes “drained everything” into arrays for convenience, but that pattern is expensive for common cases (“give me the latest acceptable cell”).

This week established the correct mental model:

- treat cell streams as **incremental**
- only buffer when you truly need the full set (analytics, debugging, multi-select)

_(Week 4 follows this through to an early-exit resolver and removal of dormant list+sort APIs.)_

### 2. “Public oracle” vs “personal oracle” is a lock choice, not a type choice

The oracle type script identifies the feed; the lock script identifies who may spend/update that oracle cell.

The SDK default public path uses deployment’s AlwaysSuccess preset; personal deployments pass an explicit lock.

### 3. Separation of concerns: drafting vs fees

Draft functions intentionally **do not** finalize fee coverage. That belongs in a dedicated balancer pass so:

- the same balancer can be reused for non-oracle transactions
- wallet policies can differ without forking oracle logic

---

## 🛑 Assumptions Corrected

1. **Assumption:** “We should store a default guardian live cell outpoint in deployment.”  
   **Correction:** outpoints go stale when guardian state migrates; type identity + scan is more robust.

2. **Assumption:** “Curator hints / known live cells maps belong in deployment.”  
   **Correction:** removed to keep deployment immutable “constants” honest and avoid pretending hints are protocol truth.

---

## 🔜 Next Steps (carried into Week 4)

- Implement/refine greedy fee rebalancing and composition helpers (`tx/pipeline.ts`).
- Prune redundant parameters on drafting surfaces as patterns stabilize.
- Add automated tests for byte layouts and tx mutation invariants.
