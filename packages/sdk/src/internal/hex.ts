import type { HexString } from "../types/hex.js";

/**
 * Internal hex/bytes utility functions for the Lean Oracle SDK.
 *
 * These helpers are shared across codec and transaction modules to ensure
 * consistent hex normalization, validation, and decoding.
 */

/**
 * Convert raw bytes into a canonical `0x`-prefixed lowercase hex string.
 */
export function bytesToHex(bytes: Uint8Array): HexString {
  let body = "";
  for (let i = 0; i < bytes.length; i++) {
    body += bytes[i]!.toString(16).padStart(2, "0");
  }
  return `0x${body}`;
}

/**
 * Strip whitespace and optional `0x` prefix from a hex string.
 *
 * Returns only the raw lowercase hex nibbles.
 */
export function stripHexPrefixAndWhitespace(hex: string): string {
  const flattened = hex.trim().replace(/\s+/g, "").toLowerCase();
  return flattened.startsWith("0x") ? flattened.slice(2) : flattened;
}

/**
 * Decode a flexible hex string into a `Uint8Array`.
 *
 * - Allows optional `0x` prefix.
 * - Ignores internal whitespace.
 * - Case-insensitive.
 *
 * Throws a plain `Error` if the string length is odd or contains non-hex characters.
 */
export function decodeHexFlexible(hex: string): Uint8Array {
  const body = stripHexPrefixAndWhitespace(hex);

  if (body.length % 2 !== 0) {
    throw new Error(
      `Hex string length must be even (got ${String(body.length)} nibbles)`,
    );
  }

  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < body.length; i += 2) {
    const slice = body.slice(i, i + 2);
    const byte = Number.parseInt(slice, 16);
    if (!Number.isFinite(byte) || byte < 0 || byte > 0xff) {
      throw new Error(`Invalid hex byte literal "${slice}" at offset ${String(i)}`);
    }
    out[i / 2] = byte;
  }
  return out;
}

/**
 * Decode a hex string and enforce an exact byte length.
 *
 * Throws a plain `Error` if length is incorrect or decoding fails.
 */
export function decodeHexExact(hex: string, expectedByteLen: number): Uint8Array {
  const bytes = decodeHexFlexible(hex);
  if (bytes.length !== expectedByteLen) {
    throw new Error(
      `Expected ${String(expectedByteLen)} bytes (${String(expectedByteLen * 2)} nibbles), got ${String(bytes.length)}`,
    );
  }
  return bytes;
}

/**
 * Normalize and validate a 32-byte hex string (e.g. feed ID, code hash).
 *
 * Returns a canonical `0x`-prefixed lowercase hex string.
 */
export function normalizeHex32(hex: string): HexString {
  const body = stripHexPrefixAndWhitespace(hex);
  if (!/^[0-9a-f]{64}$/.test(body)) {
    throw new Error(`Expected 32-byte hex (64 nibbles), got "${hex}"`);
  }
  return `0x${body}`;
}
