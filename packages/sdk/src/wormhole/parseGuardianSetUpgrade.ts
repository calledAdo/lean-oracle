/**
 * @packageDocumentation
 *
 * Parser for a **Wormhole guardian-set-upgrade governance VAA** — the artifact
 * that authorizes {@link attachGuardianSetRotation | trustless rotation} of the
 * on-chain guardian-set cell.
 *
 * A guardian-set upgrade is a governance VAA (module `Core`, action
 * `GuardianSetUpgrade`) emitted by the canonical Wormhole governance emitter and
 * signed by a quorum of the **current** guardian set. Because set `N` endorses
 * set `N+1`, the on-chain cell (which stores set `N`) can verify its own
 * successor. This module mirrors the on-chain Rust parser in
 * `contracts/common/src/governance.rs` so the SDK derives exactly the fields the
 * `guardian_set_script` will enforce.
 */

import { LeanOracleSdkError } from "../errors.js";
import type { HexString } from "../types/hex.js";
import { bytesToHex, decodeHexFlexible } from "../internal/hex.js";

/** Canonical Wormhole governance emitter chain (Solana). */
export const WORMHOLE_GOVERNANCE_EMITTER_CHAIN = 1;
/** Canonical Wormhole governance emitter address (`0x…04`), 32-byte hex. */
export const WORMHOLE_GOVERNANCE_EMITTER_ADDRESS: HexString =
  "0x0000000000000000000000000000000000000000000000000000000000000004";
/** Governance module id for the Core bridge ("Core", right-aligned in 32 bytes). */
export const WORMHOLE_GOVERNANCE_MODULE_CORE: HexString =
  "0x00000000000000000000000000000000000000000000000000000000436f7265";
/** Governance action id for `GuardianSetUpgrade`. */
export const WORMHOLE_GOVERNANCE_ACTION_GUARDIAN_SET_UPGRADE = 2;
/** Guardian-set upgrades are global; Wormhole issues them with target chain `0`. */
export const WORMHOLE_GOVERNANCE_TARGET_CHAIN_ALL = 0;

/**
 * Canonical Wormhole quorum for a set of `n` guardians: `floor(2n/3) + 1`.
 *
 * The on-chain script derives quorum itself rather than trusting cell data, so
 * callers building a rotation output **must** use this value.
 *
 * @public
 */
export function wormholeQuorum(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 0xff) {
    throw new LeanOracleSdkError(
      `Guardian count must be an integer between 1 and 255 (got ${String(n)})`,
    );
  }
  return Math.floor((n * 2) / 3) + 1;
}

/**
 * Result of parsing a guardian-set-upgrade governance VAA.
 *
 * @public
 */
export interface ParsedGuardianSetUpgrade {
  /** Guardian-set index that signed the VAA (must equal the current on-chain set). */
  signingSetIndex: number;
  /** Index the new set will occupy (`signingSetIndex + 1`). */
  newIndex: number;
  /** Addresses of the new set, 20-byte hex, in guardian order. */
  addresses: HexString[];
  /** Derived Wormhole quorum for the new set (`floor(2n/3)+1`). */
  quorum: number;
}

/**
 * Options controlling emitter/module validation. Defaults enforce the canonical
 * Wormhole governance identity; override only for tests or alternate networks.
 *
 * @public
 */
export interface ParseGuardianSetUpgradeOptions {
  expectedEmitterChain?: number;
  expectedEmitterAddress?: HexString;
  expectedModule?: HexString;
}

function eqHex(a: HexString, b: HexString): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Parse and validate a guardian-set-upgrade governance VAA.
 *
 * Rejects any VAA that is not a well-formed Core `GuardianSetUpgrade` from the
 * canonical governance emitter addressed to all chains — matching the on-chain
 * `verify_guardian_set_upgrade` checks (except signature verification, which the
 * script performs on-chain against the current set).
 *
 * @public
 */
export function parseGuardianSetUpgradeVaa(
  vaa: HexString | Uint8Array,
  options?: ParseGuardianSetUpgradeOptions,
): ParsedGuardianSetUpgrade {
  const bytes = vaa instanceof Uint8Array ? vaa : decodeHexFlexible(vaa);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const need = (offset: number, len: number) => {
    if (offset + len > bytes.length) {
      throw new LeanOracleSdkError(
        `Governance VAA truncated: needed ${String(len)} bytes at offset ${String(offset)}`,
      );
    }
  };

  // ── VAA header ────────────────────────────────────────────────────────────
  need(0, 6);
  const version = bytes[0];
  if (version !== 1) {
    throw new LeanOracleSdkError(
      `Unsupported VAA version ${String(version)} (expected 1)`,
    );
  }
  const signingSetIndex = dv.getUint32(1, false);
  const sigCount = bytes[5];
  // Each signature entry is 1-byte index + 65-byte signature = 66 bytes.
  const bodyOffset = 6 + sigCount * 66;

  // ── VAA body ──────────────────────────────────────────────────────────────
  // timestamp(4) nonce(4) emitter_chain(2) emitter_address(32) sequence(8)
  // consistency(1) = 51-byte prefix, then payload.
  need(bodyOffset, 51);
  const emitterChain = dv.getUint16(bodyOffset + 8, false);
  const emitterAddress = bytesToHex(
    bytes.subarray(bodyOffset + 10, bodyOffset + 42),
  );
  const payloadOffset = bodyOffset + 51;

  const expectedEmitterChain =
    options?.expectedEmitterChain ?? WORMHOLE_GOVERNANCE_EMITTER_CHAIN;
  const expectedEmitterAddress =
    options?.expectedEmitterAddress ?? WORMHOLE_GOVERNANCE_EMITTER_ADDRESS;
  if (
    emitterChain !== expectedEmitterChain ||
    !eqHex(emitterAddress, expectedEmitterAddress)
  ) {
    throw new LeanOracleSdkError(
      `Governance VAA emitter mismatch: got chain ${String(emitterChain)} address ${emitterAddress}`,
    );
  }

  // ── Governance packet (payload) ───────────────────────────────────────────
  // module(32) action(1) target_chain(2) new_index(4) num(1) addresses(num*20)
  need(payloadOffset, 40);
  const module = bytesToHex(bytes.subarray(payloadOffset, payloadOffset + 32));
  const expectedModule = options?.expectedModule ?? WORMHOLE_GOVERNANCE_MODULE_CORE;
  if (!eqHex(module, expectedModule)) {
    throw new LeanOracleSdkError(`Governance VAA module mismatch: got ${module}`);
  }
  const action = bytes[payloadOffset + 32];
  if (action !== WORMHOLE_GOVERNANCE_ACTION_GUARDIAN_SET_UPGRADE) {
    throw new LeanOracleSdkError(
      `Governance VAA action ${String(action)} is not GuardianSetUpgrade`,
    );
  }
  const targetChain = dv.getUint16(payloadOffset + 33, false);
  if (targetChain !== WORMHOLE_GOVERNANCE_TARGET_CHAIN_ALL) {
    throw new LeanOracleSdkError(
      `Governance VAA target chain ${String(targetChain)} is not global (0)`,
    );
  }
  const newIndex = dv.getUint32(payloadOffset + 35, false);
  const numGuardians = bytes[payloadOffset + 39];
  if (numGuardians === 0) {
    throw new LeanOracleSdkError("Governance VAA declares an empty guardian set");
  }

  const addressesOffset = payloadOffset + 40;
  need(addressesOffset, numGuardians * 20);
  if (addressesOffset + numGuardians * 20 !== bytes.length) {
    throw new LeanOracleSdkError(
      "Governance VAA has trailing bytes after the guardian-set upgrade payload",
    );
  }
  const addresses: HexString[] = [];
  for (let i = 0; i < numGuardians; i++) {
    const start = addressesOffset + i * 20;
    addresses.push(bytesToHex(bytes.subarray(start, start + 20)));
  }

  return {
    signingSetIndex,
    newIndex,
    addresses,
    quorum: wormholeQuorum(numGuardians),
  };
}
