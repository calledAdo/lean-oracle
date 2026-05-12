import fs from "node:fs";
import path from "node:path";

import type { DeploymentNetwork } from "./types.js";

type ResultLine = { ok: boolean; message: string };

function ok(message: string): ResultLine {
  return { ok: true, message: `OK   ${message}` };
}
function fail(message: string): ResultLine {
  return { ok: false, message: `FAIL ${message}` };
}

function isHex(value: string) {
  return /^[0-9a-fA-F]+$/.test(value);
}

function validateHexBytes(name: string, value: string | undefined, bytes: number): string[] {
  if (!value) return [`${name} is required`];
  if (!value.startsWith("0x")) return [`${name} must start with 0x`];
  const hex = value.slice(2);
  if (hex.length !== bytes * 2) return [`${name} must be ${bytes} bytes`];
  if (!isHex(hex)) return [`${name} must be hex`];
  return [];
}

function validateU32(name: string, value: string | undefined): string[] {
  if (!value) return [`${name} is required`];
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) return [`${name} must be a u32 integer`];
  return [];
}

function latestCanonicalVersionKey(versions: unknown): number | null {
  if (!versions || typeof versions !== "object") return null;
  const keys = Object.keys(versions as Record<string, unknown>)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (keys.length === 0) return null;
  return Math.max(...keys);
}

export function validateConfigPreflight(args: {
  deploymentRoot: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
}): { exitCode: number; lines: string[] } {
  const out: ResultLine[] = [];

  const targetAction = args.argv[0];
  if (!targetAction) {
    out.push(fail("missing target action. Usage: validate:config <target-action> --network <testnet|mainnet|devnet>"));
    return { exitCode: 2, lines: out.map((l) => l.message) };
  }

  const allowedTargets = new Set([
    "deploy:guardian-set-type",
    "deploy:oracle-type",
    "deploy:owned-type-bind-lock",
    "deploy:guardian-set",
    "deploy:oracle",
  ]);
  if (!allowedTargets.has(targetAction)) {
    out.push(fail(`invalid target action: ${targetAction}`));
  } else {
    out.push(ok(`target action: ${targetAction}`));
  }

  const idx = args.argv.indexOf("--network");
  const cliNetwork = idx >= 0 ? args.argv[idx + 1] : undefined;
  const network = (cliNetwork ?? args.env.DEPLOY_NETWORK) as DeploymentNetwork | undefined;
  if (network !== "testnet" && network !== "mainnet" && network !== "devnet") {
    out.push(fail("missing network. Use --network <testnet|mainnet|devnet> or DEPLOY_NETWORK"));
  } else {
    out.push(ok(`network: ${network}`));
  }

  const configPath =
    network === "testnet" || network === "mainnet" || network === "devnet"
      ? path.join(args.deploymentRoot, "config", `${network}.json`)
      : null;
  if (!configPath || !fs.existsSync(configPath)) {
    out.push(fail(`config file missing: ${configPath ?? "<unknown>"}`));
  } else {
    out.push(ok(`config file exists: ${path.relative(args.deploymentRoot, configPath)}`));
  }

  const prefix = network ? network.toUpperCase() : "<missing>";
  const rpc = network ? args.env[`${prefix}_CKB_RPC_URL`] : undefined;
  const pk = network ? args.env[`${prefix}_DEPLOYER_PRIVATE_KEY`] : undefined;
  if (!rpc) out.push(fail(`${prefix}_CKB_RPC_URL is required`));
  else out.push(ok(`${prefix}_CKB_RPC_URL present`));
  if (!pk) out.push(fail(`${prefix}_DEPLOYER_PRIVATE_KEY is required`));
  else out.push(ok(`${prefix}_DEPLOYER_PRIVATE_KEY present`));

  const dryRun = args.env.DRY_RUN ?? "true";
  out.push(ok(`DRY_RUN=${dryRun}`));

  let config: any = null;
  if (configPath && fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (network && config.network !== network) {
        out.push(fail(`config network mismatch: expected ${network}, got ${config.network}`));
      } else if (network) {
        out.push(ok("config network matches selected network"));
      }
    } catch (e) {
      out.push(fail(`failed to parse config JSON: ${(e as Error).message}`));
    }
  }

  const artifactsDir = path.join(args.deploymentRoot, "artifacts");
  const codeArtifactPath = (
    family: "guardian-set-type" | "oracle-type" | "owned-type-bind-lock",
  ) => path.join(artifactsDir, `${network}.${family}.json`);

  function checkCanonicalCodeArtifact(
    family: "guardian-set-type" | "oracle-type" | "owned-type-bind-lock",
  ) {
    const p = codeArtifactPath(family);
    if (!fs.existsSync(p)) {
      out.push(fail(`missing code artifact: ${path.relative(args.deploymentRoot, p)}`));
      return;
    }
    out.push(ok(`code artifact exists: ${path.relative(args.deploymentRoot, p)}`));
    try {
      const env = JSON.parse(fs.readFileSync(p, "utf8")) as any;
      const ver = latestCanonicalVersionKey(env?.deployment?.versions);
      if (ver === null) {
        out.push(fail(`no canonical version present in ${network}.${family}.json`));
      } else {
        out.push(ok(`canonical version selected: ${family} v${ver}`));
      }
    } catch (e) {
      out.push(fail(`failed to read code artifact ${network}.${family}.json: ${(e as Error).message}`));
    }
  }

  if (
    targetAction === "deploy:guardian-set-type" ||
    targetAction === "deploy:oracle-type" ||
    targetAction === "deploy:owned-type-bind-lock"
  ) {
    if (
      config?.build?.oracleBinaryPath &&
      config?.build?.guardianSetBinaryPath &&
      config?.build?.ownedTypeBindLockBinaryPath
    ) {
      out.push(ok("build config paths present in config"));
    } else {
      out.push(fail("build config paths missing in config.build"));
    }
  }

  if (targetAction === "deploy:guardian-set") {
    const gs = config?.guardianSet;
    if (!gs) {
      out.push(fail("guardianSet config missing"));
    } else {
      out.push(ok("guardianSet config present"));
      if (!Number.isInteger(gs.setIndex) || gs.setIndex < 0) out.push(fail("guardianSet.setIndex must be a non-negative integer"));
      else out.push(ok("guardianSet.setIndex valid"));
      if (!Number.isInteger(gs.quorum) || gs.quorum <= 0) out.push(fail("guardianSet.quorum must be > 0"));
      else out.push(ok("guardianSet.quorum valid"));
      if (!Array.isArray(gs.guardianAddresses) || gs.guardianAddresses.length === 0) out.push(fail("guardianSet.guardianAddresses must be non-empty"));
      else out.push(ok("guardianSet.guardianAddresses present"));
      if (Array.isArray(gs.guardianAddresses)) {
        const uniq = new Set(gs.guardianAddresses);
        if (uniq.size !== gs.guardianAddresses.length) out.push(fail("guardianSet.guardianAddresses must be unique"));
        else out.push(ok("guardianSet.guardianAddresses unique"));
        if (Number.isInteger(gs.quorum) && gs.quorum > gs.guardianAddresses.length) out.push(fail("guardianSet.quorum cannot exceed guardianAddresses length"));
        else out.push(ok("guardianSet.quorum <= guardian address count"));
      }
    }
    checkCanonicalCodeArtifact("guardian-set-type");
  }

  if (targetAction === "deploy:oracle") {
    for (const msg of validateHexBytes("ORACLE_FEED_ID", args.env.ORACLE_FEED_ID, 32)) out.push(fail(msg));
    if (validateHexBytes("ORACLE_FEED_ID", args.env.ORACLE_FEED_ID, 32).length === 0) out.push(ok("ORACLE_FEED_ID valid"));

    for (const msg of validateU32("ORACLE_EMITTER_CHAIN", args.env.ORACLE_EMITTER_CHAIN)) out.push(fail(msg));
    if (validateU32("ORACLE_EMITTER_CHAIN", args.env.ORACLE_EMITTER_CHAIN).length === 0) out.push(ok("ORACLE_EMITTER_CHAIN valid"));

    for (const msg of validateHexBytes("ORACLE_EMITTER_ADDRESS", args.env.ORACLE_EMITTER_ADDRESS, 32)) out.push(fail(msg));
    if (validateHexBytes("ORACLE_EMITTER_ADDRESS", args.env.ORACLE_EMITTER_ADDRESS, 32).length === 0) out.push(ok("ORACLE_EMITTER_ADDRESS valid"));

    checkCanonicalCodeArtifact("oracle-type");
    checkCanonicalCodeArtifact("owned-type-bind-lock");

    const gsStatePath = path.join(artifactsDir, `${network}.deploy-guardian-set.json`);
    if (!fs.existsSync(gsStatePath)) {
      out.push(fail(`missing guardian-set state artifact: ${path.relative(args.deploymentRoot, gsStatePath)}`));
    } else {
      out.push(ok(`guardian-set state artifact exists: ${path.relative(args.deploymentRoot, gsStatePath)}`));
      try {
        const env = JSON.parse(fs.readFileSync(gsStatePath, "utf8")) as any;
        const dep = env?.deployment;
        const hasDeployed = !!dep?.deployed?.txHash && dep?.deployed?.index !== undefined && !!dep?.deployed?.typeIdArgs;
        if ((args.env.DRY_RUN ?? "true") === "false") {
          if (!hasDeployed) {
            out.push(fail("guardian-set state artifact must contain deployed outPoint/typeIdArgs when DRY_RUN=false"));
          } else {
            out.push(ok("guardian-set state artifact contains deployed reference data"));
          }
        } else {
          out.push(ok("guardian-set deployed reference not required (DRY_RUN != false)"));
        }
      } catch (e) {
        out.push(fail(`failed to read guardian-set state artifact: ${(e as Error).message}`));
      }
    }
  }

  const exitCode = out.some((l) => !l.ok) ? 1 : 0;
  return { exitCode, lines: out.map((l) => l.message) };
}
