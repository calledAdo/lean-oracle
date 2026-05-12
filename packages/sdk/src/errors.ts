/**
 * Root error marker for callers to distinguish oracle-SDK failures.
 *
 * @public
 */
export class LeanOracleSdkError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "LeanOracleSdkError";
    this.cause = options?.cause;
  }
}

/**
 * Hermes HTTP gateway returned a non-2xx response or the body was not valid JSON.
 *
 * @public
 */
export class LeanOracleHermesError extends LeanOracleSdkError {
  /** HTTP status code from Hermes (when a response was returned). */
  readonly status: number;
  /** Resolved request URL (after base + path + query composition). */
  readonly url: string;
  /** Short slice of the raw body to aid debugging without logging multi-kB VAAs. */
  readonly responseBodySnippet: string;

  constructor(
    message: string,
    init: {
      status: number;
      url: string;
      responseBodySnippet: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: init.cause });
    this.name = "LeanOracleHermesError";
    this.status = init.status;
    this.url = init.url;
    this.responseBodySnippet = init.responseBodySnippet;
  }
}

/**
 * Response JSON did not match the expected Hermes price-update envelope layout.
 *
 * @public
 */
export class LeanOracleHermesMalformedEnvelopeError extends LeanOracleSdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LeanOracleHermesMalformedEnvelopeError";
  }
}

/**
 * Invalid hex / oversized accumulator when building **`OracleUpdateWitness`** bytes.
 *
 * @public
 */
export class LeanOracleWitnessEncodingError extends LeanOracleSdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LeanOracleWitnessEncodingError";
  }
}

/**
 * Oracle **`cell_data`** length or hex layout does not match **`OracleData`** (`152` bytes).
 *
 * @public
 */
export class LeanOracleCellDataDecodeError extends LeanOracleSdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LeanOracleCellDataDecodeError";
  }
}

/**
 * Guardian-set cell **`data`** did not match the expected on-chain `GuardianSetData` layout
 * (12-byte little-endian header plus `guardian_count * 20` address bytes; no trailing data).
 *
 * @public
 */
export class LeanOracleGuardianSetDataDecodeError extends LeanOracleSdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LeanOracleGuardianSetDataDecodeError";
  }
}

/**
 * Could not resolve a live guardian-set cell suitable for `CellDep`.
 *
 * @public
 */
export class LeanOracleGuardianSetResolveError extends LeanOracleSdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LeanOracleGuardianSetResolveError";
  }
}

/**
 * Failed to encode oracle output cell data (`OracleData::to_bytes` equivalent).
 *
 * @public
 */
export class LeanOracleOracleDataEncodeError extends LeanOracleSdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LeanOracleOracleDataEncodeError";
  }
}

/**
 * Fee / capacity planning could not satisfy the mutated transaction footprint.
 *
 * @public
 */
export class LeanOracleInsufficientBalanceError extends LeanOracleSdkError {
  readonly extraCapacityRequiredShannons: bigint;

  constructor(
    message: string,
    extraCapacityRequiredShannons: bigint,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LeanOracleInsufficientBalanceError";
    this.extraCapacityRequiredShannons = extraCapacityRequiredShannons;
  }
}
