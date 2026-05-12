import type { Cell, CellDepLike, Client, DepTypeLike, Transaction } from "@ckb-ccc/core";
import { Script, hashCkb } from "@ckb-ccc/core";
import type { LeanOracleDeployment } from "../types/deployment.js";
import type { HexString } from "../types/hex.js";
import type { LeanOracleCellOutPoint } from "../types/deployment.js";
import {
  LeanOracleGuardianSetResolveError,
  LeanOracleSdkError,
} from "../errors.js";
import { normalizeHex32 as normalizeHex32Internal } from "../internal/hex.js";

export interface ResolveGuardianSetCellDepOptions {
  /** Required `guardian_set_type_hash` from candidate oracle cell data (`OracleData`). */
  expectedGuardianSetTypeHash?: HexString;
  signal?: AbortSignal;
}

/**
 * Default dependency type for the guardian-set **data** cell.
 *
 * Even though the guardian cell is read as data (not executed as code), CKB still requires a `dep_type`.
 * Using `"code"` is conventional and widely accepted by tooling.
 *
 * @public
 */
export const DEFAULT_GUARDIAN_SET_DEP_TYPE: DepTypeLike = "code";

function normalizeHex32(label: string, hex: HexString): HexString {
  try {
    return normalizeHex32Internal(hex);
  } catch (e) {
    throw new LeanOracleSdkError(
      `${label}: ${(e as Error).message}`,
    );
  }
}

function cellToOutPoint(cell: Cell): LeanOracleCellOutPoint {
  return {
    txHash: cell.outPoint.txHash,
    index: cell.outPoint.index,
  };
}

/**
 * Convert an outpoint into a CCC `CellDepLike`.
 *
 * @public
 */
export function guardianSetCellDepFromOutPoint(
  outPoint: LeanOracleCellOutPoint,
  depType: DepTypeLike = DEFAULT_GUARDIAN_SET_DEP_TYPE,
): CellDepLike {
  return {
    outPoint: {
      txHash: outPoint.txHash,
      index: outPoint.index,
    },
    depType,
  };
}

/**
 * Resolve the guardian-set live cell and return the corresponding `CellDepLike`.
 *
 * This is a convenience wrapper around {@link resolveGuardianSetCellDepOutPoint}.
 *
 * @public
 */
export async function resolveGuardianSetCellDep(
  cccClient: Client,
  deployment: LeanOracleDeployment,
  options?: ResolveGuardianSetCellDepOptions,
): Promise<CellDepLike> {
  const outPoint = await resolveGuardianSetCellDepOutPoint(
    cccClient,
    deployment,
    options,
  );
  return guardianSetCellDepFromOutPoint(outPoint);
}

/**
 * Ensure the guardian-set `CellDep` exists on the transaction.
 *
 * This mutates the passed `tx` (CCC `Transaction` is mutable) and returns it for chaining.
 *
 * @public
 */
export function attachGuardianSetCellDep(
  tx: Transaction,
  guardianDep: CellDepLike,
): Transaction {
  tx.addCellDeps(guardianDep);
  return tx;
}

function typeHashOfCellOrThrow(cell: Cell): HexString {
  const type = cell.cellOutput.type;
  if (!type) {
    throw new LeanOracleGuardianSetResolveError(
      "Guardian-set candidate cell had no type script (cannot match guardian_set_type_hash)",
    );
  }
  return hashCkb(type.toBytes());
}

/**
 * Resolve guardian-set **`CellDep`** outpoint usable across concurrent oracle txs.
 *
 * This function scans live cells by the guardian-set type script identity defined
 * in the `deployment` and matches them against the `expectedGuardianSetTypeHash`.
 *
 * The oracle update path requires exactly one matching guardian-set cell dependency.
 * If zero or more than one matching cell is found, resolution fails to prevent
 * transaction ambiguity.
 *
 * @public
 */
export async function resolveGuardianSetCellDepOutPoint(
  cccClient: Client,
  deployment: LeanOracleDeployment,
  options?: ResolveGuardianSetCellDepOptions,
): Promise<LeanOracleCellOutPoint> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw new LeanOracleSdkError("Guardian-set lookup aborted", {
      cause: signal.reason,
    });
  }

  if (!options?.expectedGuardianSetTypeHash?.trim()) {
    throw new LeanOracleGuardianSetResolveError(
      "`expectedGuardianSetTypeHash` is required to resolve a guardian-set CellDep",
    );
  }
  const expected = normalizeHex32(
    "expectedGuardianSetTypeHash",
    options.expectedGuardianSetTypeHash,
  );

  // ── Discovery via indexer by guardian type script identity ────────────────
  const identity = deployment.guardianSetType;
  const guardianTypeScript = Script.from({
    codeHash: identity.codeHash,
    hashType: identity.hashType,
    args: identity.args,
  });

  let matched: Cell | undefined;

  /*
   * We iterate over live cells matching the guardian-set type script.
   * To mirror the contract's strictness, we require a unique match.
   */
  for await (const cell of cccClient.findCellsByType(
    guardianTypeScript,
    true,
  )) {
    if (signal?.aborted) {
      throw new LeanOracleSdkError("Guardian-set lookup aborted", {
        cause: signal.reason,
      });
    }

    let isMatch = false;
    try {
      isMatch =
        normalizeHex32("guardian-set type hash", typeHashOfCellOrThrow(cell)) ===
        expected;
    } catch {
      // Skip cells with malformed or missing type scripts during resolution.
      isMatch = false;
    }

    if (!isMatch) continue;

    if (matched) {
      throw new LeanOracleGuardianSetResolveError(
        `Ambiguous guardian-set resolution: more than one live cell matches expected type hash ${expected}. The contract requires exactly one authoritative trust root.`,
      );
    }

    matched = cell;
  }

  if (!matched) {
    throw new LeanOracleGuardianSetResolveError(
      `No live guardian-set cell found for expected type hash ${expected}`,
    );
  }

  return cellToOutPoint(matched);
}
