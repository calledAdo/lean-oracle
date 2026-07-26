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
            "0xff625007fa8ba4ffbbaa97eb57fe70228228655a1fd72acb69e9abfbd1c4e065",
          index: 0n,
        },
        depType: "code",
      },
    },
    // Current (latest) oracle type-script version - used by default for
    // discovery, update, deploy, and burn. Equals `oracleTypeVersions[4]`.
    oracleType: {
      codeHash:
        "0x5711c27408e948befdf55cdebf29b6ed0b6c56d8866200dab1dd53f28bef8c55",
      hashType: "data2",
      codeDep: {
        outPoint: {
          txHash:
            "0x797167087bce4fa6b5bb1b6620f4e52bdad86bff28de159a732db0f82440131d",
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
      // v2 — adds the burn (1 input, 0 outputs) group shape.
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
      // v3 - zero-initializes price state at creation, so a nonzero
      // publish_time provably means the cell was authenticated by an update.
      3: {
        codeHash:
          "0xb2a48cc368e55269e4bd10a6548a1ff3a18aff7a290927268b42f42ecb197d63",
        hashType: "data2",
        codeDep: {
          outPoint: {
            txHash:
              "0xf794a02d605a1d76cb6610c9c6bb344165f96d1b4bf27e695d7f5ce0c3542d3b",
            index: 0n,
          },
          depType: "code",
        },
      },
      // v4 - current reproducible build after guardian governance was added to
      // the shared contract crate; oracle behavior is unchanged from v3.
      4: {
        codeHash:
          "0x5711c27408e948befdf55cdebf29b6ed0b6c56d8866200dab1dd53f28bef8c55",
        hashType: "data2",
        codeDep: {
          outPoint: {
            txHash:
              "0x797167087bce4fa6b5bb1b6620f4e52bdad86bff28de159a732db0f82440131d",
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
        "0x7ab8c7d225c0e74ecb01b58f8c7a13e298df08460d0947b776b2e47cd5525782",
      hashType: "data2",
      args: "0xff1d70fbea716cb99b1b0b9906bf00255fe080808d07bd15352a56273a15a3d5",
      identityVersion: 4,
      codeVersion: 3,
      codeDep: {
        outPoint: {
          txHash:
            "0x0903144bfb3a736d1a989783d0e6304c153bb5b7627b64843e73e9b2f58f42b9",
          index: 0n,
        },
        depType: "code",
      },
    },
    guardianSetLock: {
      script: {
        codeHash:
          "0x5554bc20c9f3dbb8d1d7a6591b1b2ceeb0bbee822804635ee168911a440a111c",
        hashType: "data2",
        args: "0x7de82d61a7eb2ec82b0dc653e558ba120efcbfbb44dac87c12972d05bf250653",
      },
      codeDep: {
        outPoint: {
          txHash:
            "0xff625007fa8ba4ffbbaa97eb57fe70228228655a1fd72acb69e9abfbd1c4e065",
          index: 0n,
        },
        depType: "code",
      },
    },
    guardianSetTypeVersions: {
      // v1 - trusted-lock rotation only; retained for legacy cell inspection.
      1: {
        codeHash:
          "0x57bddf3d57ea45c88ab68d0de706bbaecd68895fd6062b099626deb157100119",
        hashType: "data2",
        identityVersion: 1,
        codeVersion: 1,
        args:
          "0x3e62200a42204a48f974b7d6cc9dce4f8b9a009baf2d848ec316c156feedf1a5",
        codeDep: {
          outPoint: {
            txHash:
              "0x78f83c3967c566c50c783d45c9165af94d23018c5254228b3eb418aa0c5ac37f",
            index: 0n,
          },
          depType: "code",
        },
      },
      // v2 - first governance-verifying deployment; code cell was untyped.
      2: {
        codeHash:
          "0x7ab8c7d225c0e74ecb01b58f8c7a13e298df08460d0947b776b2e47cd5525782",
        hashType: "data2",
        identityVersion: 2,
        codeVersion: 2,
        args:
          "0x4767b1c0444b9206234622869b1205d1acac2b492c34c52e59af14278002a734",
        codeDep: {
          outPoint: {
            txHash:
              "0xfd256c6dbd3b0e2be05cb6f3cbe1f2a0aa2102bb1c1aa63ddeacd670d19b5524",
            index: 0n,
          },
          depType: "code",
        },
      },
      // v3 - legacy deployer-locked singleton and Type ID-protected code dep.
      3: {
        codeHash:
          "0x7ab8c7d225c0e74ecb01b58f8c7a13e298df08460d0947b776b2e47cd5525782",
        hashType: "data2",
        identityVersion: 3,
        codeVersion: 3,
        args:
          "0x4767b1c0444b9206234622869b1205d1acac2b492c34c52e59af14278002a734",
        codeDep: {
          outPoint: {
            txHash:
              "0x0903144bfb3a736d1a989783d0e6304c153bb5b7627b64843e73e9b2f58f42b9",
            index: 0n,
          },
          depType: "code",
        },
      },
      // v4 - canonical permissionless singleton identity. It reuses guardian
      // code v3 and moves only the state lock to OwnedTypeBindLock v2.
      4: {
        codeHash:
          "0x7ab8c7d225c0e74ecb01b58f8c7a13e298df08460d0947b776b2e47cd5525782",
        hashType: "data2",
        args:
          "0xff1d70fbea716cb99b1b0b9906bf00255fe080808d07bd15352a56273a15a3d5",
        identityVersion: 4,
        codeVersion: 3,
        codeDep: {
          outPoint: {
            txHash:
              "0x0903144bfb3a736d1a989783d0e6304c153bb5b7627b64843e73e9b2f58f42b9",
            index: 0n,
          },
          depType: "code",
        },
      },
    },
  },
};
