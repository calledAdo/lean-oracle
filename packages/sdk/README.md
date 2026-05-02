# Lean Oracle SDK

TypeScript SDK for the [Lean Oracle](../../crates/lean_oracle/README.md) on
CKB. The package is intended to be the primary off-chain entry point for
applications that want to read or update the oracle on either CKB testnet or
CKB mainnet.

## Status

This package is currently a scaffold. It exposes empty barrels for:

- `networks/testnet` and `networks/mainnet` — network configuration presets
- `client` — the consumer-facing client surface

Real client logic and the final published package name will be added in
follow-up work.

## Layout

```
src/
├── index.ts          # public barrel
├── networks/
│   ├── index.ts
│   ├── testnet.ts    # CKB testnet preset (placeholder)
│   └── mainnet.ts    # CKB mainnet preset (placeholder)
└── client/
    └── index.ts      # LeanOracleClient placeholder
```

## Scripts

- `npm run build` — type-check and emit to `dist/`
- `npm run clean` — remove `dist/`
- `npm run prepublishOnly` — clean + build before `npm publish`
