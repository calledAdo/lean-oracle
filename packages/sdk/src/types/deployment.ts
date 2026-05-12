import type { HexString } from "./hex.js";

/**
 * CKB **hash types** usable in **`Script.hashType`** literals (mirrors `@ckb-ccc/core`).
 *
 * @public
 */
export type LeanOracleScriptHashType = "type" | "data" | "data1" | "data2";

/** CKB [`OutPoint`](https://docs.nervos.org) for a consumed or referenced cell. */
export interface LeanOracleCellOutPoint {
  txHash: HexString;
  index: bigint;
}

/**
 * A full code dependency configuration for a CKB script.
 *
 * @public
 */
export interface LeanOracleCodeDep {
  outPoint: LeanOracleCellOutPoint;
  depType: "code" | "depGroup";
}

/**
 * Common shape for script identity (codeHash, hashType, optional args).
 *
 * @public
 */
export interface LeanOracleScriptIdentity {
  codeHash: HexString;
  hashType: LeanOracleScriptHashType;
  args?: HexString;
}

/**
 * Identity + code dependency for one version of the oracle `type` script.
 *
 * Used for both the canonical (latest) `oracleType` and each historical
 * entry in {@link LeanOracleDeployment.oracleTypeVersions}.
 *
 * @public
 */
export interface LeanOracleOracleTypeRef {
  /**
   * Oracle **`type`** script **code hash** (required for indexer-backed
   * discovery once contracts are published — omit only when enumerating
   * cells manually).
   */
  codeHash: HexString;
  /** How **`codeHash`** resolves (**`type`** identity vs **`data*`** blobs). */
  hashType: LeanOracleScriptHashType;
  /** Code cell dependency for this oracle type-script implementation. */
  codeDep: LeanOracleCodeDep;
}

/**
 * Canonical testnet/mainnet oracle + guardian artefacts once contracts are pinned.
 *
 * @public
 */
export interface LeanOracleDeployment {
  /**
   * The lock script and its dependency used by default for permissionless oracle cells.
   *
   * **Public / permissionless** oracle installs: indexer query uses this script unless the caller overrides
   * **`oracleLockScript`** when calling **`findLatestOracleLiveCellForFeed`**.
   */
  defaultPublicOracleLock: {
    script: LeanOracleScriptIdentity;
    codeDep: LeanOracleCodeDep;
  };

  /**
   * Identity and dependency for the **current** oracle type script — the
   * version used by default for discovery, update, deploy, and burn.
   */
  oracleType: LeanOracleOracleTypeRef;

  /**
   * Optional full history of oracle type-script code versions, keyed by the
   * monotonic version number used in the deployment artifacts' `versions`
   * map. Mirrors `deployment/artifacts/<network>.oracle-type.json#versions`
   * so consumers can trace and pin to an older code version without reading
   * the artifact files directly.
   *
   * The latest entry equals {@link oracleType}. This map does **not** change
   * default behaviour — discovery still uses {@link oracleType}. To operate
   * on a cell created under an older code version, build a config whose
   * {@link oracleType} is swapped for the desired entry (see
   * `leanOraclePresetForOracleVersion`).
   *
   * Omitted on inert presets (e.g. mainnet before launch) and on any config
   * a caller hand-builds without a version history.
   */
  oracleTypeVersions?: Record<number, LeanOracleOracleTypeRef>;

  /**
   * Identity, matching hash, and dependency for the guardian-set type script.
   */
  /**
   * Canonical Pyth Wormhole emitter used by price-feed VAAs (`SetDataSources`
   * data source). The on-chain `oracle_script` enforces, on every update, that
   * the VAA's emitter chain/address equal the values stored in the consumed
   * oracle cell — so personal-oracle deployments default to these values to
   * remain compatible with Pyth's authenticated price feed stream.
   *
   * Pyth governance can rotate the emitter via `SetDataSources`, but the
   * Pythnet emitter has been stable since Pythnet launch. Treat preset bumps
   * as the migration path if it ever changes.
   */
  pythEmitter: {
    /** Wormhole chain id (26 = Pythnet for current Pyth deployment). */
    chain: number;
    /** 32-byte Wormhole emitter address (`0x` + 64 hex). */
    address: HexString;
  };

  guardianSetType: {
    /** Guardian-set type script code hash. */
    codeHash: HexString;
    /** Guardian-set type script hash type. */
    hashType: LeanOracleScriptHashType;
    /**
     * Type script args for the guardian-set cell.
     * Defaults to `"0x"` when omitted.
     */
    args: HexString;
    /**
     * Code cell dependency for the guardian-set **type script** implementation.
     */
    codeDep: LeanOracleCodeDep;
  };
}

/**
 * JSON-serializable envelope emitted by the deployment toolbox.
 *
 * This shape is intentionally minimal and stable for consumers that want to
 * ingest `deployment/artifacts/*.json` files.
 *
 * @public
 */
export interface LeanOracleSerializedDeploymentArtifact {
  network: "testnet" | "mainnet" | "devnet";
  generatedAt: string;
  action: string;
  deployment: unknown;
}

/**
 * Deployment toolbox code-deployment artifact payload shape (serializable JSON).
 *
 * `latestCandidate` tracks the latest operator-local candidate deployment, while
 * `versions` is an explicit map of canonical numeric versions.
 *
 * @public
 */
export type LeanOracleCodeDeploymentScriptFamily = "guardian-set-type" | "oracle-type";

/**
 * @public
 */
export interface LeanOracleCodeDeploymentArtifact {
  scriptFamily: LeanOracleCodeDeploymentScriptFamily;
  latestCandidate?: unknown;
  versions: Record<number, unknown>;
}
