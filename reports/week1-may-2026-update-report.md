# Builder Track Weekly Report — May 2026 (Week 1)

**Name:** Adokiye

## ✅ Completed Tasks

### Deployment toolbox established under `deployment/`

Built out a dedicated deployment workspace for Lean Oracle so contract publication and state-cell creation no longer depend on ad hoc commands or memory. The toolbox now lives under `deployment/` and includes:

- checked-in network intent files for `testnet`, `mainnet`, and `devnet`
- a TypeScript CLI entrypoint with explicit actions:
  - `deploy:guardian-set-type`
  - `promote:guardian-set-type`
  - `deploy:guardian-set`
  - `deploy:oracle-type`
  - `promote:oracle-type`
  - `deploy:oracle`
  - `validate:config`
- local artifact writing so each deployment step leaves behind machine-readable outputs for downstream use

The key structural gain this week was separating **code deployment** from **state deployment** and introducing the idea of:

- `latestCandidate` for most recent unpublished code deployments
- canonical `versions` for promoted code that state deployments are allowed to consume

That gives the deployment path a stable shape instead of relying on “whatever was last published”.

### Real devnet deployment flow proven end to end

The deployment path was not left at the “artifact writes successfully” stage. We pushed it all the way through real devnet broadcasts and proved the canonical sequence works:

1. deploy guardian-set type code
2. promote guardian-set type
3. deploy guardian-set state cell
4. deploy oracle type code
5. promote oracle type
6. deploy oracle state cell

This required repeated dry-run and real-broadcast verification, not just code inspection.

The final devnet run produced real on-chain artifacts for:

- guardian-set type code
- guardian-set state cell
- oracle type code
- oracle state cell

and those artifacts were then consumed again later in the update test, which matters because it proves the deployment outputs are useful protocol inputs and not just bookkeeping.

### Root cause of the script execution failure identified and fixed

The biggest deployment blocker this week was a persistent:

- `VM Internal Error: MemWriteOnExecutablePage`

when the deployed guardian-set and oracle scripts were actually executed as type scripts.

This was chased through multiple layers:

- fee-rate completion
- devnet CCC known-script metadata
- occupied capacity sizing
- contract allocator settings
- `ckb-std` version alignment
- Rust contract build profile
- debugger replay / replacement-binary experiments
- comparison against another working CKB Rust contract repo

Those investigations were useful because they ruled out a lot of surface-level explanations, but the decisive fix turned out to be deployment-side:

- custom code cells must be referenced with **`hashType: "data2"`**
- not `hashType: "data"`

Once that was corrected in code deployment and the contracts were redeployed cleanly, the type scripts executed successfully.

This was the turning point for the entire deployment week.

### Devnet CCC client made reproducible instead of machine-specific

The devnet flow needed a local CCC client setup that does **not** inherit public testnet assumptions. The deployment client was updated so that:

- `mainnet` keeps public mainnet CCC behavior
- `testnet` keeps public testnet CCC behavior
- `devnet` uses a local JSON-RPC client with explicit script metadata

Initially that metadata was hardcoded, but by the end of the week the setup was improved to be reproducible on any machine:

- devnet `secp256k1_blake160` KnownScript metadata is now sourced from `.env`
- `.env.example` documents the minimal required fields

This keeps the deployment path generic by default while isolating the only network-specific oddity to the devnet note.

### Real occupied-capacity sizing added for state cells

Both state deployment flows originally used placeholder capacities that were too optimistic for real cells.

That caused transaction verification failures such as:

- `InsufficientCellCapacity(Outputs[0])`

These were fixed by changing state deployment to compute the actual occupied capacity from the output shape instead of hardcoding a fixed value:

- guardian-set state cell now derives capacity from actual lock + type + data size
- oracle state cell now does the same
- both add a small deterministic margin afterward

This matters because deployment now scales with real guardian sets and real oracle payloads instead of depending on toy placeholder assumptions.

### Devnet fee-rate fallback added for real broadcasts

On offckb devnet, the RPC path for:

- `get_fee_rate_statistics`

was returning `null`, which caused CCC fee completion to fail during real broadcasts.

Instead of overhauling fee logic, the deployment flow now uses a small deterministic fee-rate fallback for devnet real broadcasts. This unblocked:

- code deployment broadcasts
- guardian-set state deployment
- oracle state deployment

without changing public-network behavior.

### Oracle deployment artifact chain tightened

As state deployments began to feed other state deployments, the artifact format needed to be more complete.

One concrete fix here was ensuring the guardian-set deployment artifact carries forward the full script identity needed later by `deploy:oracle`, specifically:

- `guardianSetType.hashType`

Without that, the oracle deployment path could not reconstruct the guardian-set type script identity deterministically.

This was a small but important lesson from the week: once deployment outputs become inputs to later steps, artifacts have to be treated like part of the protocol surface.

### Contract runtime baseline aligned to the working CKB profile

While the final deployment breakthrough came from `data2`, there was still useful hardening work on the contract side:

- moved script crates onto the modern `ckb-std` line
- aligned the CKB cargo target config (`riscv64imac-unknown-none-elf`, `target-feature=-a`, strip link arg)
- standardized allocator settings across the real scripts

This left the contract build profile in a much healthier place and closer to the known working reference contracts we compared against during debugging.

### Temporary devnet oracle update test built and proven

After the deployment path was working, the week did not stop at “cells deployed successfully”.

A temporary SDK-side script was added to test a real update flow against a BTC oracle cell:

- redeploy oracle state with the BTC stable feed id
- fetch the latest BTC update from Hermes
- draft and submit an update transaction
- verify the oracle cell moved from zeroed initial state to live price state

The successful test showed:

- input oracle cell before update:
  - publish time `0`
  - price `0`
- updated oracle cell after on-chain update:
  - publish time `1778063261`
  - formatted BTC price `82205.33669408`

This is important because it proves the deployment outputs are not only valid on-chain, but are also consumable by the update path afterward.

---

## 📚 Key Learning Areas

### 1. Deployment success means “deployed cells are usable later”, not just “the tx was accepted”

The strongest validation this week came from the sequence:

- deploy guardian set
- deploy oracle
- update oracle

Once the update flow succeeded using the freshly deployed artifacts, we could say with much more confidence that deployment was working as intended.

### 2. Script identity details are protocol-critical

The `hashType` distinction looked small on paper, but it decided whether the deployed code could execute at all.

The lesson is straightforward:

- code publication format
- script identity
- VM selection

are not “tooling details”; they are part of the protocol contract.

### 3. Devnet support should be explicit, not implicit

Trying to let devnet quietly behave like testnet caused unnecessary confusion:

- wrong secp dep outpoint assumptions
- fallback RPC behavior
- fee-rate RPC mismatches

The week’s fixes made devnet explicit where it actually differs and left the common path generic everywhere else.

### 4. Artifacts are part of the system boundary

Once deployment became multi-stage, artifacts were no longer disposable logs.

They became:

- the source of canonical code versions
- the source of outpoints for later state deployments
- the source of oracle/guardian wiring for later update tests

That means artifact structure and completeness directly affect correctness.

---

## 🛑 Important corrections made during the week

1. **Assumption:** the deployment problem was probably in Rust contract logic or allocator behavior.  
   **Correction:** the decisive execution fix was deployment-side `hashType: "data2"`.

2. **Assumption:** fixed placeholder capacities were good enough for state cells.  
   **Correction:** real guardian-set and oracle state cells required dynamic occupied-capacity sizing.

3. **Assumption:** devnet could safely piggyback on public testnet CCC behavior.  
   **Correction:** devnet needed explicit local secp KnownScript metadata and local-only client behavior.

4. **Assumption:** successful deployment ends at state-cell creation.  
   **Correction:** the stronger proof was a successful Hermes-backed oracle update after deployment.

---

## 🔜 Next Steps

Now that the deployment side has been exercised successfully on devnet, the main focus should shift toward the SDK:

1. align SDK assumptions with the actual on-chain oracle state layout
2. decide how devnet/custom network config should be surfaced cleanly in the SDK
3. turn the temporary oracle update path into a cleaner supported flow
4. document the deployment-to-SDK handoff more clearly

---

## 🧪 Representative commands / flows proven this week

```bash
# Build deployment CLI
cd deployment
npm install
npm run build

# Validate config
node --enable-source-maps ./dist/index.js validate:config deploy:guardian-set --network devnet
node --enable-source-maps ./dist/index.js validate:config deploy:oracle --network devnet

# Canonical deployment order
node --enable-source-maps ./dist/index.js deploy:guardian-set-type --network devnet
node --enable-source-maps ./dist/index.js promote:guardian-set-type --network devnet
node --enable-source-maps ./dist/index.js deploy:guardian-set --network devnet
node --enable-source-maps ./dist/index.js deploy:oracle-type --network devnet
node --enable-source-maps ./dist/index.js promote:oracle-type --network devnet
node --enable-source-maps ./dist/index.js deploy:oracle --network devnet

# Temporary BTC oracle update smoke
node packages/sdk/scripts/test-oracle-update-devnet.mjs
```
