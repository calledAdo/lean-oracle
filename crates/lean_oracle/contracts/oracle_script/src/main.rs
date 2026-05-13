//! This file contains the main oracle type script.
//!
//! It is the heart of the `lean_oracle` project.
//!
//! **Creation** (0 group inputs, 1 group output):
//! Creation is a configuration-anchoring step. It must:
//! 1. decode the new oracle output cell
//! 2. require `feed_id` to match script args
//! 3. require exactly one guardian-set dep in `CellDep` matching `guardian_set_type_hash`
//! 4. require that dep to decode as a guardian set (and be internally valid)
//!
//! Creation does *not* authenticate the oracle price fields. The first
//! authenticated state arrives via a normal update.
//!
//! **Update** (1 group input, 1 group output):
//! Update is the only witness-backed authenticated path:
//! 1. load and decode old/new oracle cells
//! 2. enforce immutable configuration fields
//! 3. enforce publish-time monotonicity
//! 4. load the accumulator witness from Source::GroupInput index 0
//! 5. parse the Pyth accumulator update
//! 6. verify VAA emitter fields match oracle state
//! 7. load the governed guardian-set dep via guardian_set_type_hash
//! 8. verify Wormhole guardian quorum
//! 9. require the oracle output cell to match the authenticated message
//!
//! **Burn** (1 group input, 0 group outputs):
//! Burn is the permissioned destruction path. The type script returns success
//! unconditionally — the cell's **lock script** is the sole authority for who
//! may destroy the cell. This is consistent with the personal-oracle model:
//! whoever installed the cell under their own lock can reclaim the capacity at
//! any time.

// Compile without the standard library so the binary can run in CKB-VM.
#![no_std]
// In contract builds, compile as a CKB entrypoint rather than a normal `main`.
#![cfg_attr(not(test), no_main)]

// During host tests we still want access to `alloc`.
#[cfg(test)]
extern crate alloc;

// Pull in the default allocator used by `ckb-std`.
#[cfg(not(test))]
use ckb_std::default_alloc;

// Register the CKB entrypoint symbol.
#[cfg(not(test))]
ckb_std::entry!(program_entry);
// Install an explicit allocator for contract builds.
//
// Keep the allocator profile aligned with the working Rust CKB contracts we
// use as reference so deployment/runtime behavior stays consistent.
#[cfg(not(test))]
default_alloc!(16384, 1258306, 64);

// Import the CKB types and VM loaders we need.
use ckb_std::{
    ckb_constants::Source,
    error::SysError,
    high_level::{load_cell_data, load_cell_type_hash, load_script, load_witness_args, QueryIter},
};
// Import shared protocol logic from the common crate.
use lean_oracle_common::{
    errors::*,
    guardian_set::GuardianSetData,
    oracle_data::OracleData,
    oracle_witness::OracleUpdateWitness,
    pyth_accumulator::{ParsedAccumulatorUpdateForFeed, PriceFeedMessage},
    types::FeedId,
    wormhole_verify::{verify_guardian_quorum, VerifyError},
};

// CKB entrypoint. Return `0` on success or an `i8` error code on failure.
pub fn program_entry() -> i8 {
    // Load the currently executing script so we can inspect its args.
    let script = match load_script() {
        Ok(s) => s,
        Err(_) => return ERROR_SYSCALL,
    };

    // The script args are expected to be exactly one 32-byte feed id.
    let args = script.args().raw_data();
    if args.len() != 32 {
        return ERROR_ENCODING;
    }

    let mut feed_id_bytes = [0u8; 32];
    feed_id_bytes.copy_from_slice(&args);
    let feed_id = FeedId(feed_id_bytes);

    // Determine script-group shape based on input/output counts.
    let input_count = QueryIter::new(load_cell_data, Source::GroupInput).count();
    let output_count = QueryIter::new(load_cell_data, Source::GroupOutput).count();

    match (input_count, output_count) {
        // Creation path: exactly 0 inputs, 1 output.
        (0, 1) => validate_creation(&feed_id),
        // Update path: exactly 1 input, 1 output.
        (1, 1) => validate_update(&feed_id),
        // Burn path: exactly 1 input, 0 outputs. Authorization is delegated to
        // the cell's lock script — the type script has no state transition to
        // verify.
        (1, 0) => 0,
        // Any other shape (e.g. multi-input) is rejected.
        _ => ERROR_INVALID_SCRIPT_GROUP,
    }
}

// Validate creation of a new oracle cell.
//
// Creation anchors oracle configuration to a canonical guardian-set lineage
// (by requiring the guardian-set dep referenced by `guardian_set_type_hash`
// to be present and valid). It does not authenticate the price fields.
fn validate_creation(feed_id_args: &FeedId) -> i8 {
    // Load the oracle output cell's data.
    let output = match load_cell_data(0, Source::GroupOutput) {
        Ok(data) => data,
        Err(_) => return ERROR_SYSCALL,
    };

    // Decode the oracle output state.
    let state = match OracleData::from_bytes(&output) {
        Some(state) => state,
        None => return ERROR_ORACLE_DATA_MALFORMED,
    };

    // Feed id must match the script args.
    if &state.feed_id != feed_id_args {
        return ERROR_INVALID_FEED_ID;
    }

    // Load the governed guardian-set dep via the type hash in oracle state.
    let guardian_set = match load_guardian_set(&state.guardian_set_type_hash) {
        Ok(gs) => gs,
        Err(code) => return code,
    };

    // Ensure the anchored guardian set is internally sane.
    if !guardian_set.validate() {
        return ERROR_GUARDIAN_SET_INVALID;
    }

    0
}

// Validate an update of an existing oracle cell.
fn validate_update(feed_id_args: &FeedId) -> i8 {
    // Load the old oracle data from the input side.
    let input = match load_cell_data(0, Source::GroupInput) {
        Ok(data) => data,
        Err(_) => return ERROR_SYSCALL,
    };
    // Load the new oracle data from the output side.
    let output = match load_cell_data(0, Source::GroupOutput) {
        Ok(data) => data,
        Err(_) => return ERROR_SYSCALL,
    };

    // Decode the old oracle state.
    let old = match OracleData::from_bytes(&input) {
        Some(state) => state,
        None => return ERROR_ORACLE_DATA_MALFORMED,
    };
    // Decode the new oracle state.
    let new = match OracleData::from_bytes(&output) {
        Some(state) => state,
        None => return ERROR_ORACLE_DATA_MALFORMED,
    };

    // Require the new state to keep the same feed id as the script args.
    if &new.feed_id != feed_id_args {
        return ERROR_INVALID_FEED_ID;
    }
    // Require all immutable config fields to stay unchanged.
    if !old.static_fields_unchanged(&new) {
        return ERROR_CONFIG_MUTATED;
    }
    // Require the publish time to move forward strictly.
    if new.publish_time <= old.publish_time {
        return ERROR_TIMESTAMP_NOT_MONOTONIC;
    }
    // Load and decode the oracle-update witness.
    let witness = match load_update_witness() {
        Ok(witness) => witness,
        Err(code) => return code,
    };

    // Parse the raw Pyth accumulator update from the witness.
    let accumulator = match ParsedAccumulatorUpdateForFeed::parse_for_feed(
        &witness.accumulator_update,
        &new.feed_id,
    ) {
        Ok(update) => update,
        Err(_) => return ERROR_ACCUMULATOR_UPDATE_MALFORMED,
    };
    // Borrow the embedded VAA for the next validation steps.
    let vaa = &accumulator.vaa;

    // Require the VAA emitter chain to match the oracle cell config.
    if vaa.emitter_chain as u32 != new.emitter_chain {
        return ERROR_EMITTER_MISMATCH;
    }
    // Require the VAA emitter address to match the oracle cell config.
    if vaa.emitter_address != new.emitter_address {
        return ERROR_EMITTER_MISMATCH;
    }

    // Load the governed guardian-set cell by the type hash stored in oracle
    // state.
    let guardian_set = match load_guardian_set(&new.guardian_set_type_hash) {
        Ok(state) => state,
        Err(code) => return code,
    };

    // Require the VAA to use the current guardian-set index of the loaded set.
    //
    // Current-set-only policy: this Nervos fork does not support Wormhole's
    // guardian-set grace window or previous-set acceptance. Only the active
    // canonical set is trusted. After a guardian rotation, callers must fetch a
    // new blob signed by the current set. Any VAA signed by an older or future
    // index is rejected immediately.
    if vaa.guardian_set_index != guardian_set.set_index {
        return ERROR_GUARDIAN_SET_INDEX_MISMATCH;
    }

    // Verify the guardian quorum carried by the VAA.
    match verify_guardian_quorum(&vaa, &guardian_set) {
        Ok(()) => {}
        Err(VerifyError::Quorum) => return ERROR_GUARDIAN_QUORUM_NOT_MET,
        Err(VerifyError::Order) => return ERROR_GUARDIAN_SIGNATURE_ORDER,
        Err(VerifyError::Signature) => return ERROR_GUARDIAN_SIGNATURE_INVALID,
    }

    // Require the oracle output cell to match the authenticated message exactly.
    if !price_update_matches_state(&accumulator.message, &new) {
        return ERROR_PRICE_UPDATE_MISMATCH;
    }

    // If every structural, cryptographic, and temporal check passed, the
    // update is valid.
    0
}

// Load the oracle-update witness from the first group input.
fn load_update_witness() -> Result<OracleUpdateWitness, i8> {
    // This script expects the update payload to be stored in the `input_type`
    // field of the first group input's WitnessArgs. This is a transaction-building
    // convention for the oracle update flow. The `lock` field is reserved for
    // lock-script-owned witness material.
    let witness_args = load_witness_args(0, Source::GroupInput).map_err(|_| ERROR_SYSCALL)?;
    // Extract the `input_type` field where this script stores its witness bytes.
    let input_type = witness_args
        .input_type()
        .to_opt()
        .ok_or(ERROR_WITNESS_MALFORMED)?
        .raw_data();

    // Decode the witness into the typed wrapper.
    OracleUpdateWitness::from_bytes(input_type.as_ref()).ok_or(ERROR_WITNESS_MALFORMED)
}

// Load the governed guardian-set cell from `CellDep` by matching its type hash.
fn load_guardian_set(expected_type_hash: &[u8; 32]) -> Result<GuardianSetData, i8> {
    // Track the unique matching dep-cell index.
    let mut matched_index: Option<usize> = None;
    // Start scanning all transaction dep cells from index zero.
    let mut i = 0usize;

    // Walk all dep cells until the VM reports out-of-bounds.
    loop {
        match load_cell_type_hash(i, Source::CellDep) {
            Ok(Some(type_hash)) => {
                // If the dep cell's type hash matches the one required by the
                // oracle state, attempt to record its index.
                if type_hash.as_slice() == expected_type_hash {
                    // Reject ambiguity: the transaction must provide exactly
                    // one authoritative guardian-set dep for this type hash.
                    if matched_index.is_some() {
                        return Err(ERROR_GUARDIAN_SET_AMBIGUOUS);
                    }
                    matched_index = Some(i);
                }
            }
            Ok(None) => {}
            Err(SysError::IndexOutOfBound) => break,
            Err(_) => return Err(ERROR_SYSCALL),
        }
        i += 1;
    }

    // Require that exactly one matching dep-cell was located.
    let index = matched_index.ok_or(ERROR_GUARDIAN_SET_NOT_FOUND)?;
    // Load the matched guardian-set cell's raw data.
    let data = load_cell_data(index, Source::CellDep).map_err(|_| ERROR_SYSCALL)?;
    // Decode the data into the typed guardian-set representation.
    GuardianSetData::from_bytes(&data).ok_or(ERROR_GUARDIAN_SET_MALFORMED)
}

// Compare a decoded Pyth message against the oracle output state.
fn price_update_matches_state(update: &PriceFeedMessage, state: &OracleData) -> bool {
    update.feed_id == state.feed_id
        && update.price == state.price
        && update.conf == state.conf
        && update.expo == state.expo
        && update.publish_time == state.publish_time
        && update.prev_publish_time == state.prev_publish_time
        && update.ema_price == state.ema_price
        && update.ema_conf == state.ema_conf
}
