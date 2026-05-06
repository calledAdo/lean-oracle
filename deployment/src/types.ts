export type DeploymentNetwork = "testnet" | "mainnet" | "devnet";

export type DeploymentAction =
  | "deploy:guardian-set-type"
  | "deploy:oracle-type"
  | "deploy:guardian-set"
  | "deploy:oracle"
  | "promote:guardian-set-type"
  | "promote:oracle-type"
  | "validate:config";

export interface GuardianSetConfig {
  setIndex: number;
  quorum: number;
  guardianAddresses: string[];
}

export interface BuildConfig {
  target: string;
  oracleBinaryPath: string;
  guardianSetBinaryPath: string;
}

export interface NetworkDeploymentConfig {
  network: DeploymentNetwork;
  build: BuildConfig;
  guardianSet: GuardianSetConfig;
}

/** Resolved operator env (required RPC/key + optional overrides). */
export interface DeploymentEnv {
  rpcUrl: string;
  deployerPrivateKey: string;
  broadcast: string;
  dryRun: string;
  devnetSecp256k1Blake160CodeHash: string;
  devnetSecp256k1Blake160HashType: ScriptHashType | "";
  devnetSecp256k1Blake160DepTxHash: string;
  devnetSecp256k1Blake160DepIndex: string;
  devnetSecp256k1Blake160DepType: "code" | "depGroup" | "";
  oracleFeedId: string;
  oracleEmitterChain: string;
  oracleEmitterAddress: string;
}

export interface DeploymentPaths {
  deploymentRoot: string;
}

export interface DeploymentContext {
  action: DeploymentAction;
  network: DeploymentNetwork;
  config: NetworkDeploymentConfig;
  env: DeploymentEnv;
  paths: DeploymentPaths;
}

export interface DeploymentArtifactEnvelope {
  network: DeploymentNetwork;
  action: DeploymentAction;
  generatedAt: string;
  deployment: unknown;
}

/**
 * Script "families" that produce code deployments/artifacts.
 *
 * These are intentionally not tied 1:1 to CLI actions; the artifact model
 * supports candidate vs canonical versioning per family.
 */
export type CodeDeploymentScriptFamily = "guardian-set-type" | "oracle-type";

export type CanonicalCodeVersion = number;

export type ScriptHashType = "type" | "data" | "data1" | "data2";

export interface CodeDeploymentCandidate {
  mode: "dry-run" | "broadcast";
  codeHash: string;
  hashType: ScriptHashType;
  depType: "code";
  txHash?: string;
  index?: number;
}

export interface CodeDeploymentVersionRecord extends CodeDeploymentCandidate {
  version: CanonicalCodeVersion;
  promotedAt: string;
}

/**
 * Code-deployment artifact payload:
 * - `latestCandidate` is an operator-local "most recent" candidate deployment.
 * - `versions` are explicit canonical versions (numeric, stable).
 *
 * Promotion from candidate -> canonical is out of scope for now, but the type
 * layout preserves the intended model.
 */
export interface CodeDeploymentArtifact {
  scriptFamily: CodeDeploymentScriptFamily;
  latestCandidate?: CodeDeploymentCandidate;
  versions: Record<CanonicalCodeVersion, CodeDeploymentVersionRecord>;
}

/**
 * State deployments should be tied to explicit canonical version selections.
 * State actions should not rely on `latestCandidate`.
 */
export interface StateDeploymentVersionSelection {
  oracleTypeVersion: CanonicalCodeVersion;
  guardianSetTypeVersion: CanonicalCodeVersion;
}
