# Builder Track Weekly Report — April 2025 (Week 2)

**Name:** Adokiye

## ✅ Completed Tasks

### Hermes integration (off-chain data source)

- **Client helpers** in `packages/sdk/src/hermes/client.ts` for:
  - latest price updates (`/v2/updates/price/latest`)
  - updates at a specific publish time (time-keyed endpoint family)
  - SSE stream URL construction (`/v2/updates/price/stream`)
- **Normalization & validation**:
  - normalize Hermes base URLs and query parameters (encoding, feed id list)
  - validate the returned **`binary`** object structure (`encoding` + `data[]` entries are strings)
- **Types** in `packages/sdk/src/types/hermes.ts`:
  - `HermesBinaryEncoding` (`hex` | `base64`)
  - `HermesBinaryUpdateEnvelope` (`binary` required, `parsed` optional)
  - `HermesParsedPriceTouch` for consumer-friendly fields

**Why this matters:** Hermes is the transport; CKB scripts still verify the accumulator payload. The SDK must treat Hermes as an untrusted API surface and fail fast on malformed envelopes.

### Oracle update witness encoding

- Implemented `encodeOracleUpdateWitnessFromAccumulatorBytes` / `…FromAccumulatorHex` in `packages/sdk/src/witness/encodeUpdateWitness.ts`.
- **Framing rule:** `u32` **little-endian** length prefix + raw accumulator bytes (matches the contract-side witness layout expectations).

**Pitfall fixed during implementation:** `DataView` byte length must match the write width (e.g. `setUint32` covers 4 bytes; accidentally requesting 8 bytes is incorrect).

### On-chain oracle payload: `OracleData`

- **Decode** (`packages/sdk/src/ckb/decodeOracleData.ts`): parse fixed-length `OracleData` from cell `data` using `DataView` for LE scalars and strict length checks.
- **Encode** (`packages/sdk/src/ckb/encodeOracleData.ts`): build bytes for new oracle outputs; includes `buildOracleOutputFromHermesParsed` to merge:
  - **static** fields carried forward from the existing on-chain oracle cell
  - **dynamic** fields sourced from Hermes **`parsed`** for the target feed

**Explicit engineering choice (Phase 1):** use Hermes `parsed` to populate output fields while still placing the **authoritative binary blob** into the witness. If `parsed` disagrees with `binary`, the transaction should be rejected on-chain—so this is a productivity trade, not a safety bypass.

### Deterministic AlwaysSuccess metadata (public oracle ergonomics)

- Added curated CCC-compatible AlwaysSuccess literals in `packages/sdk/src/networks/alwaysSuccessCcc.ts`:
  - lock preset (`codeHash`, `hashType`, empty `args`)
  - **code cell dep outpoints** for testnet/mainnet presets
- Extended deployment typing (`packages/sdk/src/types/deployment.ts`) so consumers always carry:
  - `defaultPublicOracleLockScript`
  - `alwaysSuccessLockCodeDepOutPoint` (needed when spending AlwaysSuccess-locked cells)

This removes dependence on **`client.getKnownScript`** for discovering AlwaysSuccess identities in constrained environments.

---

## 📚 Key Learning Areas

### 1. Hermes `binary` is the verifier input; `parsed` is ancillary

Hermes bundles:

- accumulator update material under `binary` (hex or base64 array segments)
- optional human-friendly structs under `parsed`

For CKB scripting, **`binary`** is what matters at verification time. **`parsed`** is excellent for prototyping output cell fields in TypeScript quickly, but it is logically downstream of correctness guarantees enforced on-chain.

### 2. Byte-level parity with Rust is non-negotiable

CKB payloads are brutally literal:

- off-by-one length errors fail verification
- wrong endianness silently produces “valid-looking” bytes that are wrong
- hex normalization mismatches break indexer queries (especially feed id args)

The SDK approach is: fixed sizes, explicit checks, early throws with actionable messages.

### 3. “Deployment” is a configuration contract, not a grab-bag

As the SDK matured, deployment fields became **required** where they affect transaction soundness (script identities, code deps, public lock preset). This prevents half-configured clients from producing transactions that “almost work”.

---

## 🛑 Assumptions Corrected

1. **Assumption:** “We can resolve AlwaysSuccess via CCC known-script tables everywhere.”  
   **Correction:** many RPC/indexer setups are bare and won’t give you reliable known-script metadata. Hardcoding curated AlwaysSuccess parameters + dep outpoints for public presets is more predictable.

2. **Assumption:** “We can infer output oracle fields only from Hermes `parsed` forever.”  
   **Correction:** acceptable for early integration; long-term, parsing/deriving from `binary` reduces mismatch risk and removes reliance on Hermes’ parsed projection.

---

## 🔜 Next Steps (carried into Week 3)

- Live cell discovery for oracle + guardian set via CCC indexer APIs.
- Transaction drafting: attach oracle as `CellDep` for reads; consume+recreate for updates.
- Wire guardian set `CellDep` resolution to on-chain `guardian_set_type_hash` expectations.

---

## 🧪 Suggested verification focus (when tests land)

- Witness prefix length correctness for edge blob sizes.
- `OracleData` encode/decode roundtrip on synthetic fixtures matching Rust test vectors (to be added).
