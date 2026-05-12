import type { LeanOracleNetworkConfig } from "../types/network.js";

/**
 * Opinionated testnet preset backed by the canonical Lean Oracle testnet
 * deployment.
 *
 * The default public oracle lock is `OwnedTypeBindLock`: anyone may consume
 * the oracle cell as long as the (lock, type) identity continues into the
 * outputs (permissionless updates), while only the deployer — whose lock hash
 * is baked into `script.args` — may burn it via the owner-escape path.
 *
 * Operators who deploy oracle cells under a different lock should pass an
 * explicit `oracleLockScript` to discovery/client calls or provide a custom
 * network config with that lock as `deployment.defaultPublicOracleLock`.
 *
 * @public
 */
export const leanOracleTestnetPreset: LeanOracleNetworkConfig = {
  name: "testnet",
  hermesBaseUrl: "https://hermes.pyth.network",
  ckbJsonRpcUrl: "https://testnet.ckb.dev",
  deployment: {
    defaultPublicOracleLock: {
      script: {
        codeHash:
          "0x5554bc20c9f3dbb8d1d7a6591b1b2ceeb0bbee822804635ee168911a440a111c",
        hashType: "data2",
        // 32-byte owner lock hash baked into the testnet bind-lock instance
        // used by deploy:oracle. Anyone consuming the cell must either
        // preserve continuity in the outputs or include an input cell locked
        // by this hash (owner-escape path).
        args: "0x7de82d61a7eb2ec82b0dc653e558ba120efcbfbb44dac87c12972d05bf250653",
      },
      codeDep: {
        outPoint: {
          txHash:
            "0x982a5d5555ebc855a97d9e71a8ac9de9cefc25a62a44ccfc2b6605758c01ba9f",
          index: 0n,
        },
        depType: "code",
      },
    },
    // Current (latest) oracle type-script version — used by default for
    // discovery, update, deploy, and burn. Equals `oracleTypeVersions[2]`.
    oracleType: {
      codeHash:
        "0x10c9bcc3af00fc3728cb95d5e14ec882716af5f531a010852526ce784f6958ec",
      hashType: "data2",
      codeDep: {
        outPoint: {
          txHash:
            "0x45f033f0944b50be1e5b80f733c321648ddcfdbe0c183477cf0b77bd0f8312b5",
          index: 0n,
        },
        depType: "code",
      },
    },
    // Full code-version history, mirroring
    // deployment/artifacts/testnet.oracle-type.json#versions. The latest
    // entry equals `oracleType`; older entries exist so consumers can pin a
    // config to the version a cell was created under (see
    // `leanOraclePresetForOracleVersion`). Discovery still defaults to
    // `oracleType` — this map does not change behaviour.
    oracleTypeVersions: {
      // v1 — pre-burn-path binary.
      1: {
        codeHash:
          "0x2277560d62a11a92084654b67848ea893fcf3c1880e20a3ce9c0c19d0ee27dc3",
        hashType: "data2",
        codeDep: {
          outPoint: {
            txHash:
              "0xf39d3cb5eccab560bdab65529f4e6f86c2dc8c966a4d49a2fd17bb277e75bba2",
            index: 0n,
          },
          depType: "code",
        },
      },
      // v2 — current; adds the burn (1 input, 0 outputs) group shape.
      2: {
        codeHash:
          "0x10c9bcc3af00fc3728cb95d5e14ec882716af5f531a010852526ce784f6958ec",
        hashType: "data2",
        codeDep: {
          outPoint: {
            txHash:
              "0x45f033f0944b50be1e5b80f733c321648ddcfdbe0c183477cf0b77bd0f8312b5",
            index: 0n,
          },
          depType: "code",
        },
      },
    },
    pythEmitter: {
      chain: 26,
      address:
        "0xe101faedac5851e32b9b23b5f9411a8c2bac4aae3ed4dd7b811dd1a72ea4aa71",
    },
    guardianSetType: {
      codeHash:
        "0x57bddf3d57ea45c88ab68d0de706bbaecd68895fd6062b099626deb157100119",
      hashType: "data2",
      args: "0x3e62200a42204a48f974b7d6cc9dce4f8b9a009baf2d848ec316c156feedf1a5",
      codeDep: {
        outPoint: {
          txHash:
            "0x78f83c3967c566c50c783d45c9165af94d23018c5254228b3eb418aa0c5ac37f",
          index: 0n,
        },
        depType: "code",
      },
    },
  },
};
