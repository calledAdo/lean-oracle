import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ccc } from "@ckb-ccc/core";

const HELPER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HELPER_DIR, "../../../../../..");
const ARTIFACTS_DIR = path.join(REPO_ROOT, "deployment", "artifacts");

const DEFAULT_PUBLIC_ORACLE_LOCK_ARGS =
  "0x8e42b1999f265a0078503c4acec4d5e134534297";

function artifactPath(filename) {
  return path.join(ARTIFACTS_DIR, filename);
}

function readJsonArtifact(filename) {
  const fullPath = artifactPath(filename);
  if (!fs.existsSync(fullPath)) {
    throw new Error(
      `Missing devnet deployment artifact: ${fullPath}. Run the deployment flow before npm run test:integration:devnet.`,
    );
  }
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function selectLatestVersion(artifact, label) {
  const versions = artifact?.deployment?.versions;
  if (!versions || typeof versions !== "object") {
    throw new Error(`${label} artifact is missing deployment.versions`);
  }
  const latest = Object.keys(versions)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a)[0];
  if (latest === undefined) {
    throw new Error(`${label} artifact has no canonical versions`);
  }
  return versions[String(latest)];
}

function bigintOutPoint(outPoint) {
  if (!outPoint?.txHash || outPoint.index === undefined) {
    throw new Error(`Malformed outPoint: ${JSON.stringify(outPoint)}`);
  }
  return {
    txHash: outPoint.txHash,
    index: BigInt(outPoint.index),
  };
}

function codeDepFromVersion(version) {
  if (!version.txHash || version.index === undefined || !version.depType) {
    throw new Error(`Malformed code version record: ${JSON.stringify(version)}`);
  }
  return {
    outPoint: bigintOutPoint({ txHash: version.txHash, index: version.index }),
    depType: version.depType,
  };
}

export function loadDevnetDeploymentFixture({ env }) {
  const guardianSetTypeArtifact = readJsonArtifact("devnet.guardian-set-type.json");
  const oracleTypeArtifact = readJsonArtifact("devnet.oracle-type.json");
  const bindLockArtifact = readJsonArtifact("devnet.owned-type-bind-lock.json");
  const guardianSetEnvelope = readJsonArtifact("devnet.deploy-guardian-set.json");
  const oracleEnvelope = readJsonArtifact("devnet.deploy-oracle.json");

  const guardianSetTypeVersion = selectLatestVersion(
    guardianSetTypeArtifact,
    "guardian-set-type",
  );
  const oracleTypeVersion = selectLatestVersion(oracleTypeArtifact, "oracle-type");
  const bindLockVersion = selectLatestVersion(
    bindLockArtifact,
    "owned-type-bind-lock",
  );
  const guardianSetDeployment = guardianSetEnvelope.deployment;
  const oracleDeployment = oracleEnvelope.deployment;

  if (!guardianSetDeployment?.deployed?.typeIdArgs) {
    throw new Error("devnet.deploy-guardian-set.json is missing deployed.typeIdArgs");
  }
  if (!oracleDeployment?.deployed?.txHash) {
    throw new Error("devnet.deploy-oracle.json is missing deployed.txHash");
  }
  if (!oracleDeployment?.ownedTypeBindLock?.ownerLockHash) {
    throw new Error(
      "devnet.deploy-oracle.json is missing ownedTypeBindLock.ownerLockHash",
    );
  }

  const guardianSetTypeArgs = guardianSetDeployment.deployed.typeIdArgs;
  const guardianSetTypeScript = ccc.Script.from({
    codeHash: guardianSetDeployment.guardianSetType.codeHash,
    hashType: guardianSetDeployment.guardianSetType.hashType,
    args: guardianSetTypeArgs,
  });
  const guardianSetTypeHash = ccc.hashCkb(guardianSetTypeScript.toBytes());

  // Canonical public oracle lock: OwnedTypeBindLock instance keyed to the
  // deployer's owner-lock-hash, matching what `deploy:oracle` produced on
  // devnet. Discovery queries that omit `oracleLockScript` fall back to this.
  const canonicalPublicOracleLock = {
    script: {
      codeHash: bindLockVersion.codeHash,
      hashType: bindLockVersion.hashType,
      args: oracleDeployment.ownedTypeBindLock.ownerLockHash,
    },
    codeDep: codeDepFromVersion(bindLockVersion),
  };
  // Discard the legacy hard-coded fallback args so future fixtures don't
  // accidentally reach for the secp-based public lock.
  void DEFAULT_PUBLIC_ORACLE_LOCK_ARGS;

  return {
    feedId: env.feedId,
    guardianSetDeployment,
    oracleDeployment,
    // Lock script under which the canonical devnet oracle cell is held.
    // Tests pass this as `oracleLockScript:` for discovery; the signer's own
    // lock continues to be used for `rebalanceFuel` (fuel + change).
    oracleLockScript: canonicalPublicOracleLock.script,
    network: {
      name: "devnet",
      hermesBaseUrl: env.hermesBaseUrl,
      ckbJsonRpcUrl: env.rpcUrl,
      deployment: {
        canonicalPublicOracleLock,
        oracleType: {
          codeHash: oracleTypeVersion.codeHash,
          hashType: oracleTypeVersion.hashType,
          codeDep: codeDepFromVersion(oracleTypeVersion),
        },
        // Full oracle type-script version history, mirroring the artifact's
        // `versions` map. Latest entry equals `oracleType` above.
        oracleTypeVersions: Object.fromEntries(
          Object.entries(oracleTypeArtifact?.deployment?.versions ?? {}).map(
            ([key, v]) => [
              Number(key),
              {
                codeHash: v.codeHash,
                hashType: v.hashType,
                codeDep: codeDepFromVersion(v),
              },
            ],
          ),
        ),
        guardianSetType: {
          codeHash: guardianSetTypeVersion.codeHash,
          hashType: guardianSetTypeVersion.hashType,
          args: guardianSetTypeArgs,
          identityVersion:
            guardianSetDeployment.identityVersion ??
            guardianSetDeployment.guardianSetType.version,
          codeVersion:
            guardianSetDeployment.guardianSetType.codeVersion ??
            guardianSetTypeVersion.version,
          typeHash: guardianSetTypeHash,
          codeDep: codeDepFromVersion(guardianSetTypeVersion),
        },
        pythEmitter: {
          chain: oracleDeployment.oracleConfig.emitterChain,
          address: oracleDeployment.oracleConfig.emitterAddress,
        },
      },
    },
  };
}

export function artifactOracleOutPoint(fixture) {
  return bigintOutPoint(fixture.oracleDeployment.deployed);
}

export function artifactGuardianSetOutPoint(fixture) {
  return bigintOutPoint(fixture.guardianSetDeployment.deployed);
}

export function outPointsEqual(a, b) {
  return a.txHash === b.txHash && BigInt(a.index) === BigInt(b.index);
}
