import type {
  LeanOracleDeployment,
  LeanOracleGuardianSetCodeRef,
  LeanOracleGuardianSetIdentityRef,
} from "../src/types/deployment.js";
import type { HexString } from "../src/types/hex.js";

const hex32 = (byte: string): HexString =>
  `0x${byte.repeat(32)}` as HexString;

const codeDep = {
  outPoint: { txHash: hex32("11"), index: 0n },
  depType: "code" as const,
};

const identityV4 = {
  codeHash: hex32("22"),
  hashType: "data2" as const,
  args: hex32("33"),
  identityVersion: 4,
} satisfies LeanOracleGuardianSetIdentityRef;

const guardianCodeV3 = {
  codeHash: hex32("22"),
  hashType: "data2" as const,
  codeDep,
  codeVersion: 3,
} satisfies LeanOracleGuardianSetCodeRef;

const ownedBindLock = {
  script: {
    codeHash: hex32("44"),
    hashType: "data2" as const,
    args: hex32("55"),
  },
  codeDep,
};

const deployment = {
  canonicalPublicOracleLock: ownedBindLock,
  guardianSetLock: ownedBindLock,
  guardianSetType: { ...identityV4, ...guardianCodeV3 },
  guardianSetIdentityHistory: { 4: identityV4 },
  guardianSetCodeVersions: { 3: guardianCodeV3 },
  oracleType: {
    codeHash: hex32("66"),
    hashType: "data2" as const,
    codeDep,
  },
  oracleTypeVersions: {
    4: {
      codeHash: hex32("66"),
      hashType: "data2" as const,
      codeDep,
    },
  },
  pythEmitter: { chain: 26, address: hex32("77") },
} satisfies LeanOracleDeployment;

void deployment;
