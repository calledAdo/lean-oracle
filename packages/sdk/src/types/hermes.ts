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
