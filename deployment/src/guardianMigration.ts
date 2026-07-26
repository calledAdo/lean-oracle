interface OutPointRecord {
  txHash: string;
  index: number;
}

interface GuardianCandidateRecord {
  kind: string;
  mode: string;
  network: string;
  identityVersion: number;
  fullTypeHash: string;
  verifiedAtBlock?: string;
  guardianSetType: Record<string, unknown> & {
    version: number;
    codeVersion: number;
    args: string;
  };
  guardianSetLock: Record<string, unknown> & { codeVersion?: number };
  guardianSet: {
    setIndex: number;
    quorum: number;
    guardianAddresses: string[];
  };
  deployed: OutPointRecord & {
    typeIdArgs: string;
    capacity: string | bigint;
  };
}

interface OracleEvidence {
  outPoint: OutPointRecord;
  guardianSetTypeHash: string;
  publishTimeUnix: bigint;
}

export type GuardianMigrationPhase =
  | "verify-guardian"
  | "create-staging"
  | "authenticate-staging"
  | "burn-old-oracle"
  | "migrate-public"
  | "promote"
  | "complete";

export interface GuardianMigrationProgress {
  guardianVerified?: boolean;
  stagingCreated?: unknown;
  stagingOracle?: unknown;
  oldOracleBurn?: unknown;
  finalPublicOracle?: unknown;
  promoted?: boolean;
}

export function nextGuardianMigrationPhase(
  progress: GuardianMigrationProgress,
): GuardianMigrationPhase {
  const checkpoints = [
    progress.guardianVerified === true,
    progress.stagingCreated !== undefined,
    progress.stagingOracle !== undefined,
    progress.oldOracleBurn !== undefined,
    progress.finalPublicOracle !== undefined,
    progress.promoted === true,
  ];
  let foundMissing = false;
  for (const checkpoint of checkpoints) {
    if (!checkpoint) {
      foundMissing = true;
      continue;
    }
    if (foundMissing) {
      throw new Error("Guardian migration progress is out of order");
    }
  }

  if (!checkpoints[0]) return "verify-guardian";
  if (!checkpoints[1]) return "create-staging";
  if (!checkpoints[2]) return "authenticate-staging";
  if (!checkpoints[3]) return "burn-old-oracle";
  if (!checkpoints[4]) return "migrate-public";
  if (!checkpoints[5]) return "promote";
  return "complete";
}

export function buildGuardianMigrationPromotion(params: {
  guardianCandidate: GuardianCandidateRecord;
  oldGuardianState: Record<string, unknown>;
  oracleTemplate: Record<string, unknown> & {
    network: string;
    guardianSet: Record<string, unknown>;
  };
  stagingOracle: OracleEvidence;
  oldOracleBurn: {
    outPoint: OutPointRecord;
    live: boolean;
    txHash: string;
  };
  expectedPublicLockHash: string;
  finalPublicOracle: OracleEvidence & { lockHash: string };
}) {
  const {
    guardianCandidate,
    stagingOracle,
    oldOracleBurn,
    finalPublicOracle,
  } = params;
  if (guardianCandidate.mode !== "broadcast") {
    throw new Error("Guardian candidate is not a verified broadcast deployment");
  }
  if (
    guardianCandidate.identityVersion !== 4 ||
    guardianCandidate.guardianSetType.codeVersion !== 3
  ) {
    throw new Error("Guardian candidate must be identity v4 backed by code version 3");
  }
  if (guardianCandidate.guardianSetLock.codeVersion !== 2) {
    throw new Error("Guardian candidate bind-lock must be version 2");
  }
  if (
    guardianCandidate.guardianSet.setIndex !== 7 ||
    guardianCandidate.guardianSet.quorum !== 13 ||
    guardianCandidate.guardianSet.guardianAddresses.length !== 19
  ) {
    throw new Error("Guardian candidate does not contain canonical set 7");
  }
  if (
    stagingOracle.guardianSetTypeHash !== guardianCandidate.fullTypeHash ||
    stagingOracle.publishTimeUnix <= 0n
  ) {
    throw new Error("Staging oracle is not authenticated against guardian identity v4");
  }
  if (!oldOracleBurn || oldOracleBurn.live !== false) {
    throw new Error("Old public oracle was not verified dead");
  }
  if (finalPublicOracle.guardianSetTypeHash !== guardianCandidate.fullTypeHash) {
    throw new Error("Final public oracle does not reference guardian identity v4");
  }
  if (finalPublicOracle.lockHash !== params.expectedPublicLockHash) {
    throw new Error("Final public oracle lock does not match the canonical public lock");
  }
  if (finalPublicOracle.publishTimeUnix <= stagingOracle.publishTimeUnix) {
    throw new Error("Final public oracle update is not strictly newer than staging");
  }

  const canonicalGuardianState = {
    kind: "deploy:guardian-set",
    mode: "broadcast",
    network: guardianCandidate.network,
    identityVersion: guardianCandidate.identityVersion,
    fullTypeHash: guardianCandidate.fullTypeHash,
    verifiedAtBlock: guardianCandidate.verifiedAtBlock,
    guardianSetType: {
      ...guardianCandidate.guardianSetType,
      version: guardianCandidate.identityVersion,
      identityVersion: guardianCandidate.identityVersion,
      codeVersion: guardianCandidate.guardianSetType.codeVersion,
    },
    guardianSetLock: guardianCandidate.guardianSetLock,
    guardianSet: guardianCandidate.guardianSet,
    deployed: guardianCandidate.deployed,
    legacy: params.oldGuardianState,
  };
  const canonicalOracleState = {
    ...params.oracleTemplate,
    mode: "broadcast",
    guardianSet: {
      ...params.oracleTemplate.guardianSet,
      outPoint: guardianCandidate.deployed,
      guardianSetTypeHash: guardianCandidate.fullTypeHash,
    },
    deployed: finalPublicOracle.outPoint,
  };

  return {
    kind: "migrate:owned-bind-guardian",
    mode: "broadcast",
    network: guardianCandidate.network,
    phase: "promoted",
    guardianIdentity: {
      from: params.oldGuardianState,
      to: guardianCandidate.deployed,
      fullTypeHash: guardianCandidate.fullTypeHash,
    },
    oracleCutover: {
      staging: stagingOracle,
      burn: oldOracleBurn,
      final: finalPublicOracle,
    },
    canonicalGuardianState,
    canonicalOracleState,
  };
}
