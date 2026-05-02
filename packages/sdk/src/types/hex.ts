/**
 * Untyped hex string (`0x` + nibbles).
 *
 * @public
 */
export type HexString = string;

/**
 * Normalized 66-char `0x` + 64 hex nibbles (= 32 bytes), Pyth/Wormhole style.
 *
 * @public
 */
export type FeedIdHex = HexString;
