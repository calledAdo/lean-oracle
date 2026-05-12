export const DEFAULT_DEVNET_RPC_URL = "http://127.0.0.1:28114";
export const DEFAULT_HERMES_BASE_URL = "https://hermes.pyth.network";
export const DEFAULT_BTC_FEED_ID =
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

const DEFAULT_DEVNET_SECP = {
  codeHash:
    "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hashType: "type",
  depTxHash:
    "0x4d804f1495612631da202fe9902fa9899118554b08138cfe5dfb50e1ede76293",
  depIndex: "0",
  depType: "depGroup",
};

export function normalizeFeedId(feedId) {
  let body = String(feedId).trim().toLowerCase();
  if (body.startsWith("0x")) body = body.slice(2);
  if (!/^[0-9a-f]{64}$/.test(body)) {
    throw new Error(`Invalid ORACLE_FEED_ID: ${feedId}`);
  }
  return `0x${body}`;
}

export function readDevnetTestEnv(source = process.env) {
  return {
    rpcUrl: source.DEVNET_CKB_RPC_URL || DEFAULT_DEVNET_RPC_URL,
    hermesBaseUrl: source.HERMES_BASE_URL || DEFAULT_HERMES_BASE_URL,
    feedId: normalizeFeedId(source.ORACLE_FEED_ID || DEFAULT_BTC_FEED_ID),
    privateKey: source.DEVNET_PRIVATE_KEY || "",
    devnetSecp256k1Blake160CodeHash:
      source.DEVNET_SECP256K1_BLAKE160_CODE_HASH || DEFAULT_DEVNET_SECP.codeHash,
    devnetSecp256k1Blake160HashType:
      source.DEVNET_SECP256K1_BLAKE160_HASH_TYPE || DEFAULT_DEVNET_SECP.hashType,
    devnetSecp256k1Blake160DepTxHash:
      source.DEVNET_SECP256K1_BLAKE160_DEP_TX_HASH || DEFAULT_DEVNET_SECP.depTxHash,
    devnetSecp256k1Blake160DepIndex:
      source.DEVNET_SECP256K1_BLAKE160_DEP_INDEX || DEFAULT_DEVNET_SECP.depIndex,
    devnetSecp256k1Blake160DepType:
      source.DEVNET_SECP256K1_BLAKE160_DEP_TYPE || DEFAULT_DEVNET_SECP.depType,
    broadcastUpdates: source.DEVNET_BROADCAST_UPDATES === "true",
  };
}

export function signerSkipReason(env) {
  const missing = [];
  if (!env.privateKey) missing.push("DEVNET_PRIVATE_KEY");
  if (!env.devnetSecp256k1Blake160CodeHash) {
    missing.push("DEVNET_SECP256K1_BLAKE160_CODE_HASH");
  }
  if (!env.devnetSecp256k1Blake160HashType) {
    missing.push("DEVNET_SECP256K1_BLAKE160_HASH_TYPE");
  }
  if (!env.devnetSecp256k1Blake160DepTxHash) {
    missing.push("DEVNET_SECP256K1_BLAKE160_DEP_TX_HASH");
  }
  if (!env.devnetSecp256k1Blake160DepIndex) {
    missing.push("DEVNET_SECP256K1_BLAKE160_DEP_INDEX");
  }
  if (!env.devnetSecp256k1Blake160DepType) {
    missing.push("DEVNET_SECP256K1_BLAKE160_DEP_TYPE");
  }
  return missing.length > 0
    ? `skipping signer-required devnet test; missing ${missing.join(", ")}`
    : undefined;
}

export function hermesNetworkSkipReason(error) {
  const message = error && error.message ? String(error.message) : String(error);
  if (
    error?.name === "AbortError" ||
    /fetch failed|ECONNRESET|ENOTFOUND|ETIMEDOUT|network|timeout/i.test(message)
  ) {
    return `skipping Hermes-backed devnet test; Hermes/network unavailable: ${message}`;
  }
  return undefined;
}

export function broadcastUpdatesSkipReason(env) {
  if (!env.broadcastUpdates) {
    return "skipping mutating devnet broadcast test; set DEVNET_BROADCAST_UPDATES=true";
  }
  return signerSkipReason(env);
}
