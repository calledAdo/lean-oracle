import type { Cell, CellDepLike, Client, DepTypeLike, Transaction } from "@ckb-ccc/core";
import { Script, hashCkb } from "@ckb-ccc/core";
import type { LeanOracleDeployment } from "../types/deployment.js";
import type { HexString } from "../types/hex.js";
import type { LeanOracleCellOutPoint } from "../types/deployment.js";
import {
  LeanOracleGuardianSetResolveError,
  LeanOracleSdkError,
} from "../errors.js";

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

/** Default max page size when scanning guardian cells by type. */
const DEFAULT_GUARDIAN_FIND_PAGE_LIMIT = 256;

function normalizeHex32(label: string, hex: HexString): HexString {
  const trimmed = hex.trim().toLowerCase();
  const body = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-f]{64}$/.test(body)) {
    throw new LeanOracleSdkError(
      `${label}: expected 32-byte hex (0x + 64 nibbles), got "${hex}"`,
    );
  }
  return `0x${body}`;
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

async function collectPagedCells(
  cellStream: AsyncIterable<Cell>,
  signal?: AbortSignal,
): Promise<Cell[]> {
  const cells: Cell[] = [];
  for await (const cell of cellStream) {
    if (signal?.aborted) {
      throw new LeanOracleSdkError("Guardian-set lookup aborted", {
        cause: signal.reason,
      });
    }
    cells.push(cell);
  }
  return cells;
}

/**
 * Resolve guardian-set **`CellDep`** outpoint usable across concurrent oracle txs.
 *
 * @public
 */
export async function resolveGuardianSetCellDepOutPoint(
  cccClient: Client,
  deployment: LeanOracleDeployment,
  options?: ResolveGuardianSetCellDepOptions,
): Promise<LeanOracleCellOutPoint> {
  if (options?.signal?.aborted) {
    throw new LeanOracleSdkError("Guardian-set lookup aborted", {
      cause: options.signal.reason,
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
  const guardianCodeHash = deployment.guardianSetTypeScriptCodeHash;

  const guardianTypeScript = Script.from({
    codeHash: guardianCodeHash,
    hashType: deployment.guardianSetTypeScriptHashType,
    args: deployment.guardianSetTypeScriptArgs,
  });

  const pageLimit = DEFAULT_GUARDIAN_FIND_PAGE_LIMIT;
  const candidates = await collectPagedCells(
    cccClient.findCellsByType(guardianTypeScript, true, "desc", pageLimit),
    options?.signal,
  );

  const matches = candidates.filter((cell) => {
    try {
      return normalizeHex32("guardian-set type hash", typeHashOfCellOrThrow(cell)) === expected;
    } catch {
      return false;
    }
  });

  if (matches.length === 0) {
    throw new LeanOracleGuardianSetResolveError(
      `No live guardian-set cell found for expected type hash ${expected}`,
    );
  }
  /*
   * For now we accept the first match (descending RPC order) rather than failing on ambiguity.
   * The on-chain script will still reject **transactions** that include >1 matching dep, but
   * here we are only returning a single OutPoint to be attached as the unique dep.
   *
   * Later we can refine selection (e.g. highest `set_index`, non-expired, newest outpoint).
   */
  return cellToOutPoint(matches[0]!);
}
