# Builder Track Weekly Report — April 2025 (Week 1)

**Name:** Adokiye

## ✅ Completed Tasks

### Repository layout and goals

- **Unified Lean Oracle repo** under `lean_oracle/` so contract logic (Rust) and consumer tooling (TypeScript) live in one place. The intent is a single “source of truth” for:
  - on-chain script semantics and cell layouts
  - off-chain SDK that drafts transactions Hermes-assisted updates can drive
- **Rust workspace sanity**: validated that the crates resolve from the workspace root (e.g. `cargo metadata --no-deps` / workspace membership) so future contract work is not fractured across orphaned paths.

### TypeScript SDK scaffold (`packages/sdk/`)

- **Package + build pipeline**: Added `package.json`, `tsconfig.json`, `type: module`, and `tsc` build output conventions (`dist/`) suitable for eventual npm publishing.
- **Module skeleton** (conceptual layering that carried through later work):
  - **types** — network presets, deployments, Hermes payloads, hex conventions
  - **hermes** — HTTP boundary to Hermes (to be implemented in subsequent weeks)
  - **ckb** — decoding/encoding on-chain payloads (`OracleData`, guardian set data), discovery helpers
  - **witness** — oracle update witness framing
  - **tx** — transaction mutation (read deps, pull update, fees, pipelines, workflows)
  - **client** — thin façade that hides CCC construction and repeats fewer parameters across calls

### Presets & configuration direction

- **Network presets** (`networks/testnet.ts`, `networks/mainnet.ts`): established the pattern that each network exposes:
  - Hermes base URL
  - CKB JSON-RPC URL
  - a **`deployment`** object meant to converge to immutable, chain-pinned artefacts (will start as placeholders and get replaced with deployed script identities/outpoints).

### Architectural decision: “draft unsigned tx” first

Early agreement on **separating**:

1. **Semantic drafting** — correct inputs/outputs/`CellDep`s/witness placements for oracle read/update paths  
2. **Fee completion** — a later pass that attaches fee inputs / change outputs  

This avoids baking wallet UX into the oracle domain functions and mirrors how CKB integrations usually compose responsibilities.

---

## 📚 Key Learning Areas

### 1. Why a mixed Rust + TypeScript repo is worth the overhead

Rust remains authoritative for correctness of contract behavior and memory layout (`OracleData`, witness parsing, guardian checks). TypeScript mirrors those layouts precisely so drafted transactions survive VM verification.

The SDK is intentionally **not** a second implementation of verifier logic—it is:

- byte-for-byte faithful encoding/decoders
- safe transaction scaffolding that matches scripting expectations  
- tooling that hides repetitive CCC wiring behind small entrypoints  

### 2. What “minimal client surface area” buys you

A common SDK failure mode is exploding parameter structs because every helper repeats `network + client + deployment + tx`. Week 1 set the trajectory:

- **network + deployment pinned at construction time**
- CCC `Client` created inside the façade (rather than threaded through user code)
- public methods skew toward **`feedId` + occasional overrides**, not exhaustive plumbing

---

## 🛑 Constraints / Risks Acknowledged Early

### Deployment artefacts are placeholders until contracts publish

Oracle type hash, oracle code dep outpoint, guardian set metadata, etc. cannot be finalized until deployments exist on-chain. The SDK presets therefore must stay honest: **structs are shaped for production pinning**, literals may temporarily be placeholders.

---

## 🔜 Next Steps (carried into Week 2+)

- Implement Hermes HTTP client with strict validation of the `binary` envelope.
- Mirror contract `OracleData` + guardian set layouts in TypeScript with roundtrip tests.
- Grow `tx/` helpers for read-only deps vs spend/update paths.

---

## 🧪 Commands / checks (typical for this week)

```bash
# Rust workspace health (from lean_oracle root)
cargo metadata --no-deps

# SDK typecheck/build (once src exists)
cd packages/sdk && npm install && npm run build
```
