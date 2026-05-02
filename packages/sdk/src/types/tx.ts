import type { Transaction } from "@ckb-ccc/core";

/**
 * Every fee helper assumes a CCC `Transaction` so capacity math matches serialization.
 *
 * @public
 */
export type CccRawTransaction = Transaction;
