import type { FeedIdHex } from "./hex.js";

/**
 * How Hermes encodes each `binary.data[]` payload (see `encoding` query on the API).
 *
 * @public
 */
export type HermesBinaryEncoding = "hex" | "base64";

/**
 * Subset of [`GET /v2/updates/price/latest`](https://hermes.pyth.network/docs) JSON.
 *
 * One request can request **multiple** feeds; Hermes responds with **one** accumulator
 * envelope where `parsed` may list one entry per feed, while `binary.data` is typically
 * a single combined update blob.
 *
 * @public
 */
export interface HermesBinaryUpdateEnvelope {
  binary: {
    encoding: HermesBinaryEncoding;
    /** One or more payloads; each string is hex *or* base64 per `encoding`. */
    data: string[];
  };
  parsed?: HermesParsedPriceTouch[];
}

/**
 * Hermes’s convenience view — authoritative on-chain verification uses `binary`.
 *
 * @public
 */
export interface HermesParsedPriceTouch {
  id: FeedIdHex;
  price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
  ema_price: {
    price: string;
    conf: string;
    expo: number;
    publish_time: number;
  };
  metadata: {
    slot: number;
    proof_available_time: number;
    prev_publish_time: number;
  };
}

/**
 * Source from which the SDK draws **dynamic price fields** when building the
 * new oracle output cell during update drafting.
 *
 * - `"hermes-parsed"` *(default)* — read fields from `hermesEnvelope.parsed`.
 *   Cheap and fast; no off-chain accumulator parsing. The contract still
 *   verifies the embedded `binary` accumulator on-chain and rejects any tx
 *   whose output disagrees.
 * - `"binary"` — parse `hermesEnvelope.binary.data[0]` client-side and read
 *   fields from the decoded price-feed message. Useful for binary-only
 *   envelopes or to surface format-mismatch errors before a transaction is
 *   ever submitted. The on-chain verification path is unchanged.
 *
 * Both modes use the **same** `binary.data[0]` bytes for the witness; the
 * option only changes where the *output cell* fields come from.
 *
 * @public
 */
export type OracleUpdateOutputSource = "hermes-parsed" | "binary";
