import { ccc } from "@ckb-ccc/core";

import {
  createCccClient,
  createPrivateKeySigner,
} from "../../../../../../deployment/dist/ccc.js";

export async function assertDevnetRpcReachable(env) {
  let response;
  try {
    response = await fetch(env.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "get_tip_header",
        params: [],
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new Error(
      `Devnet RPC unavailable at ${env.rpcUrl}. Start local devnet or set DEVNET_CKB_RPC_URL before running npm run test:integration:devnet. Cause: ${error?.message ?? String(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Devnet RPC ${env.rpcUrl} returned HTTP ${response.status} for get_tip_header`,
    );
  }

  const body = await response.json();
  if (body.error) {
    throw new Error(
      `Devnet RPC ${env.rpcUrl} returned JSON-RPC error for get_tip_header: ${JSON.stringify(body.error)}`,
    );
  }
  if (!body.result) {
    throw new Error(`Devnet RPC ${env.rpcUrl} returned no get_tip_header result`);
  }

  return body.result;
}

export function createDevnetReadOnlyClient(env) {
  return new ccc.ClientJsonRpc(env.rpcUrl);
}

function toDeploymentEnv(env) {
  return {
    rpcUrl: env.rpcUrl,
    deployerPrivateKey: env.privateKey,
    broadcast: "false",
    dryRun: "true",
    devnetSecp256k1Blake160CodeHash: env.devnetSecp256k1Blake160CodeHash,
    devnetSecp256k1Blake160HashType: env.devnetSecp256k1Blake160HashType,
    devnetSecp256k1Blake160DepTxHash: env.devnetSecp256k1Blake160DepTxHash,
    devnetSecp256k1Blake160DepIndex: env.devnetSecp256k1Blake160DepIndex,
    devnetSecp256k1Blake160DepType: env.devnetSecp256k1Blake160DepType,
    oracleFeedId: env.feedId,
    oracleEmitterChain: "",
    oracleEmitterAddress: "",
  };
}

export async function createDevnetSignerFixture(env) {
  const client = createCccClient("devnet", env.rpcUrl, toDeploymentEnv(env));
  const signer = createPrivateKeySigner(client, env.privateKey);
  const { script: lockScript } = await signer.getRecommendedAddressObj();
  return { client, signer, lockScript };
}
