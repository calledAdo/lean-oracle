//! This file contains the canonical error-code table for the lean_oracle
//! project.
//!
//! Every script in this workspace returns compact `i8` status codes to CKB.
//! Centralizing them here gives us:
//! - stable failure semantics
//! - easier debugging in tests
//! - one place to evolve the protocol's error vocabulary

// Generic encoding/parsing failure. This is used when transaction bytes,
// witness bytes, or script args cannot be interpreted safely.
pub const ERROR_ENCODING: i8 = -1;
// Generic syscall failure. This covers failures while loading cells, headers,
// witnesses, or scripts from the CKB VM.
pub const ERROR_SYSCALL: i8 = -2;
// Generic authorization failure reserved for governance-style checks.
pub const ERROR_UNAUTHORIZED: i8 = -3;

// The oracle cell's raw data did not match the expected binary layout.
pub const ERROR_ORACLE_DATA_MALFORMED: i8 = 10;
// The guardian-set cell's raw data did not match the expected binary layout.
pub const ERROR_GUARDIAN_SET_MALFORMED: i8 = 11;
// The oracle script args did not match the feed identifier encoded in state.
pub const ERROR_INVALID_FEED_ID: i8 = 12;
// The new publish time did not strictly advance relative to the previous one.
pub const ERROR_TIMESTAMP_NOT_MONOTONIC: i8 = 13;
// Static oracle configuration fields were changed during a normal update.
pub const ERROR_CONFIG_MUTATED: i8 = 14;
// The oracle witness did not match the expected witness layout.
pub const ERROR_WITNESS_MALFORMED: i8 = 15;
// The embedded Wormhole VAA failed basic structural parsing.
pub const ERROR_VAA_MALFORMED: i8 = 16;
// The VAA references a guardian-set index that does not match the oracle cell.
pub const ERROR_GUARDIAN_SET_INDEX_MISMATCH: i8 = 17;
// The VAA emitter chain or emitter address does not match the oracle config.
pub const ERROR_EMITTER_MISMATCH: i8 = 18;
// The required guardian-set dep cell could not be found in the transaction.
pub const ERROR_GUARDIAN_SET_NOT_FOUND: i8 = 19;
// More than one guardian-set dep cell matched the expected type hash.
// The script requires exactly one matching dep to avoid resolution ambiguity.
pub const ERROR_GUARDIAN_SET_AMBIGUOUS: i8 = 20;
// The VAA did not contain enough guardian signatures to satisfy quorum.
pub const ERROR_GUARDIAN_QUORUM_NOT_MET: i8 = 21;
// A guardian signature failed recovery or did not map to the governed set.
pub const ERROR_GUARDIAN_SIGNATURE_INVALID: i8 = 22;
// Guardian signatures were not ordered strictly by guardian index.
pub const ERROR_GUARDIAN_SIGNATURE_ORDER: i8 = 23;
// The authenticated price-feed message could not be parsed.
pub const ERROR_PRICE_UPDATE_MALFORMED: i8 = 24;
// The authenticated price-feed message did not match the oracle output cell.
pub const ERROR_PRICE_UPDATE_MISMATCH: i8 = 25;
// The raw Pyth accumulator update could not be parsed or verified.
pub const ERROR_ACCUMULATOR_UPDATE_MALFORMED: i8 = 26;
// The script failed to verify the canonical Type ID rule.
pub const ERROR_TYPE_ID_INVALID: i8 = 27;
// The script group shape is invalid (e.g. multi-cell transitions).
pub const ERROR_INVALID_SCRIPT_GROUP: i8 = 28;

// The new guardian-set index moved backwards or failed to advance (same-index
// mutation). Governance authority for the rotation is handled by the lock script.
pub const ERROR_GUARDIAN_SET_CONTINUITY: i8 = 30;

// The guardian-set dep decoded but failed internal consistency checks.
pub const ERROR_GUARDIAN_SET_INVALID: i8 = 31;

// `OwnedTypeBindLock` errors.
//
// The lock's script args were not exactly 32 bytes (expected owner lock hash).
pub const ERROR_BIND_LOCK_ARGS_MALFORMED: i8 = 40;
// A group input is missing a type script. The bind lock refuses to guard cells
// without a type identity to continue.
pub const ERROR_BIND_LOCK_NO_TYPE_SCRIPT: i8 = 41;
// Group input count and group output count must match. A mismatch means the
// caller is trying to collapse or expand bound cells.
pub const ERROR_BIND_LOCK_COUNT_MISMATCH: i8 = 42;
// A group input's type hash had no matching type hash in any group output.
pub const ERROR_BIND_LOCK_TYPE_NOT_FOUND: i8 = 43;

// v3: a newly created oracle cell carried nonzero price state. Creation must
// produce an *uninitialized* cell (all price/time fields zero) so that a nonzero
// `publish_time` provably means the cell has been authenticated by an update.
pub const ERROR_CREATION_STATE_NONZERO: i8 = 44;

// Trustless guardian-set rotation errors (guardian_set_script update path).
//
// The governance VAA supplied to authorize a rotation could not be parsed, or
// its upgrade payload was not a well-formed guardian-set upgrade.
pub const ERROR_GOVERNANCE_VAA_MALFORMED: i8 = 45;
// The governance VAA did not originate from the canonical Wormhole governance
// emitter (chain + address).
pub const ERROR_GOVERNANCE_EMITTER_MISMATCH: i8 = 46;
// The governance message was not a guardian-set upgrade addressed to all chains
// (wrong module, action, or target chain).
pub const ERROR_GOVERNANCE_ACTION_INVALID: i8 = 47;
// The rotation did not advance the set index by exactly one step, the output
// cell's index did not match the VAA's declared new index, or the VAA was not
// signed by the current on-chain set.
pub const ERROR_ROTATION_INDEX_MISMATCH: i8 = 48;
// The output cell's guardian addresses did not exactly match the addresses
// declared in the governance upgrade VAA.
pub const ERROR_ROTATION_SET_MISMATCH: i8 = 49;
// The output cell's quorum did not equal the canonical Wormhole quorum derived
// from the new set size.
pub const ERROR_ROTATION_QUORUM_MISMATCH: i8 = 50;
