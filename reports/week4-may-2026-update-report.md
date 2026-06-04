# Builder Track Weekly Report — May 2026 (Week 4)

**Name:** Adokiye

> Scope note: Week 3 closed out the major feature work (SDK npm release,
> `owned_type_bind_lock`, the expanded test suites, testnet artifacts, and the
> README rewrite). This week was deliberately a **repository-hygiene and
> continuous-integration** pass — hardening the project's process layer so the
> feature work shipped in Week 3 stays correct as it evolves.

## ✅ Completed Tasks

### Continuous integration pipeline added

A GitHub Actions workflow was added at `.github/workflows/ci.yml`. Until now the
three pre-PR checks documented in the README were run by hand; they are now
enforced automatically on every push to `main` and on every pull request. The
workflow runs the documented checks as three parallel jobs:

| Job | Command | Local result |
|---|---|---|
| Contracts | `make contracts-test` | 65 passed, 2 ignored |
| SDK | `npm ci` → `npm run release:check` | all fixtures + tarball check PASS |
| Deployment | `npm ci` → `npm test` | 20/20 pass |

Design choices worth recording:

- **`npm ci`, not `npm install`.** CI installs strictly from the committed
  `package-lock.json` files, so any lockfile drift fails the run loudly instead
  of being silently papered over.
- **`Swatinem/rust-cache`** caches the Cargo build for the contracts job.
- **`concurrency` with `cancel-in-progress`** cancels superseded runs on the
  same ref to avoid wasting CI minutes on stale commits.
- Rust uses the native `x86_64-unknown-linux-gnu` host target the `Makefile`
  already targets for `contracts-test`, so no extra `rustup` target install is
  required for the test job.

### Artifact `.gitignore` scope bug fixed

`.gitignore` carried an overly broad rule, `deployment/artifacts/*.json`, that
matched **every** artifact file — including the `testnet.*.json` files the
README explicitly documents as checked into the repository. The currently
committed testnet artifacts survived only because they predated the rule; any
**regenerated or newly added** testnet artifact would have been silently
ignored by git. A neighbouring `devnet*.json` rule made the original intent
clear: only local devnet artifacts were ever meant to be ignored.

The broad rule was removed and replaced with a devnet-only ignore plus a comment
explaining why testnet/mainnet artifacts are tracked. Verified after the fix:

- a new `deployment/artifacts/testnet.*.json` is now **tracked** (good)
- `deployment/artifacts/devnet*.json` remains **ignored** (good)

This is exactly the class of quiet configuration drift the new CI pipeline is
meant to make visible.

### Lint and documentation cleanups

A `clippy` pass over the contract workspace surfaced a small set of warnings.
They were resolved selectively, with deployment safety as the deciding factor:

- **`owned_type_bind_lock` doc comment** — fixed a `doc_lazy_continuation`
  warning by adding a paragraph break in the module doc. This is a **comment-only
  change**: comments are stripped at compile time, so the produced RISC-V binary
  and its on-chain code hash are unchanged.
- **`hermes_real_fixture` test helper** — replaced a manual `len % 2 != 0`
  parity check with `is_multiple_of`. Test-only code, not part of any deployed
  binary.

Two warnings were **intentionally left in place**:

- The `&vaa` needless-borrow in `oracle_script` was **not** changed. It is live
  contract code, and editing it would alter the deployed contract's code hash —
  not acceptable for a cosmetic lint against an already-deployed script.
- The `result_unit_err` warnings on the `decode_hex*` test helpers were left as
  is. There is no `clippy` auto-fix (the only suggestion is "invent a custom
  error type"), and two call sites in `print_hermes.rs` use `.map_err(...)`,
  which is `Result`-only — switching to `Option` would break them. Not worth the
  churn for test-only hex decoders.

---

## 📚 Key Learning Areas

### 1. CI is the durable guard against configuration drift

The `.gitignore` bug is a perfect illustration: a hand-run, documented checklist
did not catch it, because the failure mode was *silent* — nothing errors when a
file is quietly ignored. A CI run that does `npm ci` and the three documented
checks turns that whole class of process drift into a visible, blocking signal.
Automating the checklist is worth more than the checklist.

### 2. On a deployed chain, a code hash is part of the contract's identity

The most important judgment call this week was *not* applying a lint. A
needless-borrow cleanup is trivially correct in ordinary Rust, but for a CKB
script that is already deployed and referenced by code hash in the SDK presets,
any byte change to the compiled binary changes that hash and silently forks the
script's identity. The practical rule that came out of this: **doc/comment and
test-only changes are hash-neutral and safe to land freely; any change to live
contract code is a deployment event, not a cleanup.**

### 3. Lockfiles are only a guarantee if CI enforces them

Committing `package-lock.json` does nothing on its own — local development uses
`npm install`, which happily reconciles drift. Using `npm ci` in CI is what
actually turns the lockfile into a reproducibility guarantee.

---

## 🛑 Risks Still Open

- CI currently runs the **host** contract tests (`contracts-test` on
  `x86_64-unknown-linux-gnu`). It does **not** yet build the RISC-V contract
  binaries (`make contracts-build`), so a regression that only manifests in the
  release `riscv64imac` build would not be caught by CI today.
- The low-severity `elliptic` advisory through `@ckb-ccc/core` remains present.
  It should be tracked upstream rather than force-fixed, since the automated fix
  is breaking. (Carried over from Week 3.)
- `owned_type_bind_lock` is still unaudited. A formal review is needed before the
  oracle is used for high-value feeds. (Carried over from Week 3.)
- Mainnet deployment remains inert — configs exist but no artifacts are
  published. (Carried over from Week 3.)

---

## 🔜 Next Steps

1. Extend CI to also run `make contracts-build` so the release RISC-V target is
   covered, not just the host test target.
2. Enable branch protection on `main` requiring the three CI jobs to pass before
   merge, now that they exist.
3. Resume the feature track: exercise the SDK against testnet oracle cells with
   real CKB wallets to validate the full update-and-read flow end to end.
4. Begin the `owned_type_bind_lock` code-review pass, focusing on the
   continuity-bind path edge cases. (Carried over from Week 3.)

---

## 🧪 Commands Verified

```bash
# Contract tests (host target)
cd crates/lean_oracle
cargo test --target x86_64-unknown-linux-gnu

# Contract lint pass
cargo clippy --target x86_64-unknown-linux-gnu

# SDK release gate (from a clean install)
cd packages/sdk
npm ci
npm run release:check

# Deployment validation (from a clean install)
cd deployment
npm ci
npm test
```
