//! This file contains the guardian-set type script entrypoint.
//!
//! Its job is intentionally narrow:
//! - allow creation of well-formed guardian-set cells
//! - allow in-place rotation (forward set-index moves)
//! - reject backwards or same-index set-index moves
//! - enforce canonical Type ID-based singleton identity
//! - enforce singleton script-group shape
//!
//! Governance authority for rotations is modeled by the cell's lock script.
//!
//! **Current-set-only policy**: guardian-set lifecycle fields (creation_time,
//! expiration_time) are not stored. This fork does not implement Wormhole's
//! expiry or grace behavior. Once a rotation occurs, only the new canonical set
//! is accepted by the oracle. Callers must fetch a fresh blob after rotation.

// Compile without the standard library so the binary can run in CKB-VM.
#![no_std]
// When not testing on the host, compile as a CKB entrypoint rather than a
// normal Rust `main`.
#![cfg_attr(not(test), no_main)]

// During host tests we still want access to `alloc`.
#[cfg(test)]
extern crate alloc;

// Pull in the default allocator used by `ckb-std` in contract builds.
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

// Import the CKB data source enum and cell-data loader.
use ckb_std::{
    ckb_constants::Source,
    ckb_types::prelude::*,
    high_level::{load_cell_data, load_cell_type, load_input, load_script, QueryIter},
};
// Import shared errors and guardian-set decoding.
use lean_oracle_common::{errors::*, guardian_set::GuardianSetData};

// CKB entrypoint. Return `0` on success or an `i8` error code on failure.
pub fn program_entry() -> i8 {
    // Enforce singleton script group shape.
    // Both creation and update must have exactly one output in the group.
    let output_count = QueryIter::new(load_cell_data, Source::GroupOutput).count();
    if output_count != 1 {
        return ERROR_INVALID_SCRIPT_GROUP;
    }

    // The script group must contain at most one input cell.
    let input_count = QueryIter::new(load_cell_data, Source::GroupInput).count();
    if input_count > 1 {
        return ERROR_INVALID_SCRIPT_GROUP;
    }

    // Validate the canonical Type ID singleton rule.
    let type_id_err = validate_type_id(input_count);
    if type_id_err != 0 {
        return type_id_err;
    }

    // Route creation and update paths separately.
    if input_count == 0 {
        return validate_creation();
    }
    // Otherwise validate an update transition (input_count == 1).
    validate_update()
}

/// Verify the standard CKB Type ID rule.
///
/// This ensures the guardian-set cell is a unique canonical singleton.
fn validate_type_id(input_count: usize) -> i8 {
    let script = match load_script() {
        Ok(s) => s,
        Err(_) => return ERROR_SYSCALL,
    };
    let args = script.args().raw_data();

    // Type ID args must be exactly 32 bytes.
    if args.len() != 32 {
        return ERROR_TYPE_ID_INVALID;
    }

    if input_count == 1 {
        // Update transition: continuity is guaranteed by the script hash match.
        return 0;
    }

    // Creation: input_count == 0. Verify the Type ID is derived correctly.
    //
    // type_id = blake2b(first_input, first_output_index)
    let first_input = match load_input(0, Source::Input) {
        Ok(i) => i,
        Err(_) => return ERROR_SYSCALL,
    };

    // Find our absolute output index in the transaction.
    let mut output_index = None;
    for (i, s) in QueryIter::new(load_cell_type, Source::Output).enumerate() {
        if let Some(s) = s {
            if s.as_slice() == script.as_slice() {
                output_index = Some(i);
                break;
            }
        }
    }

    let output_index = match output_index {
        Some(idx) => idx as u64,
        None => return ERROR_SYSCALL,
    };

    // Calculate the expected Type ID using CKB's default blake2b settings.
    let mut blake2b = blake2b_ref::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    blake2b.update(first_input.as_slice());
    blake2b.update(&output_index.to_le_bytes());
    let mut expected_id = [0u8; 32];
    blake2b.finalize(&mut expected_id);

    if args.as_ref() != expected_id {
        return ERROR_TYPE_ID_INVALID;
    }

    0
}

// Validate creation of a new guardian-set cell.
fn validate_creation() -> i8 {
    // Load the single guardian-set output cell's data.
    let output = match load_cell_data(0, Source::GroupOutput) {
        Ok(data) => data,
        Err(_) => return ERROR_SYSCALL,
    };

    // Decode the guardian-set state.
    let state = match GuardianSetData::from_bytes(&output) {
        Some(state) => state,
        None => return ERROR_GUARDIAN_SET_MALFORMED,
    };

    // Require the set to be internally consistent (non-empty, valid quorum).
    if !state.validate() {
        return ERROR_GUARDIAN_SET_MALFORMED;
    }

    // If the initial state is well formed, creation is allowed.
    0
}

// Validate an update to an existing guardian-set cell.
fn validate_update() -> i8 {
    // Load the old guardian-set data from the input side.
    let input = match load_cell_data(0, Source::GroupInput) {
        Ok(data) => data,
        Err(_) => return ERROR_SYSCALL,
    };
    // Load the new guardian-set data from the output side.
    let output = match load_cell_data(0, Source::GroupOutput) {
        Ok(data) => data,
        Err(_) => return ERROR_SYSCALL,
    };

    // Decode the old guardian-set state.
    let old = match GuardianSetData::from_bytes(&input) {
        Some(state) => state,
        None => return ERROR_GUARDIAN_SET_MALFORMED,
    };
    // Decode the new guardian-set state.
    let new = match GuardianSetData::from_bytes(&output) {
        Some(state) => state,
        None => return ERROR_GUARDIAN_SET_MALFORMED,
    };

    // Require strict forward rotation for in-place updates.
    //
    // Disallowing same-index mutation ensures that every legitimate signer
    // rotation is visible as a set-index increment.
    if new.set_index <= old.set_index {
        return ERROR_GUARDIAN_SET_CONTINUITY;
    }

    // Require the new set to be internally consistent.
    if !new.validate() {
        return ERROR_GUARDIAN_SET_MALFORMED;
    }

    // Mutation is allowed if the set_index moves forward.
    // Authorization is assumed to be handled by the cell's lock script.
    0
}
