# Builder Track Weekly Report — April 2025 (Week 4)

**Name:** Adokiye

## ✅ Completed Tasks

### Fee rebalancing (`packages/sdk/src/tx/rebalanceFees.ts`)

Implemented a **greedy iterative** fee balancer suitable for CKB’s “capacity-in / capacity-out” accounting:

- query fee rate (shannons per KB) via CCC (`getFeeRate`) with conservative fallbacks
- compute net capacity implications of the current tx shape
- iteratively attach **plain “fuel” live cells** (no type script, empty data) locked by the user’s fee payer lock
- create/adjust a **change output** subject to **minimum cell capacity** rules (`MIN_CELL_CAPACITY_SHANNONS`)

**Why iterative:** each added input/output changes tx size and fee; a single-pass estimate often undershoots after mutations.

**Mutation-safety detail:** any helper that adds inputs must respect CCC’s “`addInput` returns new length” semantics when later setting witnesses or referring to input indices.

### Composition helpers (`packages/sdk/src/tx/pipeline.ts`)

Added convenience orchestration:

- run oracle attachment step(s)
- then run fee rebalance on the mutated transaction

This preserves modularity (users can call steps separately) while giving a one-call path for common apps.

### Package hygiene: standalone SDK narrative

Removed legacy references that could confuse consumers about dependencies or provenance. The SDK should read as a **self-contained** integration layer for Lean Oracle + Hermes + CCC.

### Pull update API simplification (`packages/sdk/src/tx/pullUpdate.ts`)

Aligned the update path with the actual protocol requirements:

- **Guardian set `CellDep` is always attached** for pull updates (not optional).
- **Hermes envelope selection is implicit**:
  - if `hermesEnvelope` is provided → use it
  - else fetch latest via `fetchHermesLatestPriceUpdates`

This removes boolean flags that could create invalid combinations (“fetch false but no envelope”, “omit guardian dep but still validate witness path”).

### Read deps API simplification (`packages/sdk/src/tx/readDeps.ts`)

Removed `OracleReadDepSelection` unions in favor of a straight parameter surface:

- always resolve via **`findLatestOracleLiveCellForFeed`**
- optional **`minPublishTimeUnix`** freshness floor passed directly

This matches how consumers actually used the SDK: nearly always `"latest"` mode, rarely an explicit bespoke selection path.

### Oracle cell selection optimization (`packages/sdk/src/ckb/findOracleCells.ts`)

Moved the dominant path to **streaming**:

- iterate `findCells(..., "desc", pageLimit)`
- decode `OracleData` per candidate
- return the **first** cell satisfying freshness constraints

Removed dormant “collect all cells + decode everything + sort” APIs that had become redundant and misleading after the optimization.

#### Why not set `pageLimit = 1` blindly

`pageLimit` is primarily a **page size** for indexer fetch granularity. Extremely small pages can increase round trips when early candidates fail freshness checks.

### AlwaysSuccess correctness when consuming oracle inputs

Pull updates attach the AlwaysSuccess lock **code cell dep** when the consumed oracle uses the deployment’s AlwaysSuccess preset lock—this matches CKB script loading requirements when unlocking those inputs.

---

## 📚 Key Learning Areas

### 1. Fees are a second transaction design problem

Oracle drafting establishes *semantic correctness* (state transition + verifier inputs). Fees establish *economics*:

- transaction size grows as you add deps/witnesses/fuel inputs
- each mutation can change estimated fee requirement

Splitting concerns keeps oracle logic understandable and avoids entangling wallet selection policies with verifier logic.

### 2. Prefer early exit for “latest acceptable cell” workloads

Indexer scans can sprawl across many live cells especially on public locks. Returning on the first validated hit reduces:

- wall time spent in RPC paging
- memory pressure from large intermediate arrays

### 3. Minimal exported surface reduces foot-guns

API simplifications this week weren’t purely cosmetic—they remove states that users could accidentally enter (half-specified Hermes behavior, forgetting guardian deps, redundant selection enums).

---

## 🛑 Risks Still Open

- **Pinned deployment constants** in presets may still contain placeholders until real deployments exist; without real code hashes/outpoints, drafted txs won’t execute on-chain even if structure is sound.
- **Hermes parsed vs binary alignment** remains a product risk until output fields are derived from binary or asserted more strictly client-side.

---

## 🧪 Immediate Follow-Ups (highest ROI)

These are intentionally still pending but should be prioritized next:

1. **Unit tests** for:
   - `OracleData` encode/decode roundtrip
   - witness length-prefix framing
   - fee balancer invariants on synthetic transactions  
2. **Fixture-driven tests** that mirror Rust contract test vectors once available  
3. **Integration smoke** against testnet indexer + Hermes beta (skipped if CI cannot access network—then use mocked fetch layers)

---

## 🧪 Commands

```bash
cd packages/sdk
npm install
npm run build
```
