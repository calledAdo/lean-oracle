//! This file contains the guardian-set type script entrypoint.
//!
//! Its job is intentionally narrow:
//! - allow creation of well-formed guardian-set cells (trusted genesis)
//! - allow **trustless** in-place rotation (forward set-index moves) authorized
//!   by a Wormhole guardian-set-upgrade governance VAA
//! - reject backwards or same-index set-index moves
//! - enforce canonical Type ID-based singleton identity
//! - enforce singleton script-group shape
//!
//! **Trustless rotation**: a guardian-set upgrade is a governance VAA (module
//! `Core`, action `GuardianSetUpgrade`) signed by a quorum of the *current* set.
//! Because the cell already stores the current set, it can verify its own
//! successor. Rotation authority therefore lives in the *type script*, not the
//! lock — the lock may be permissionless, and anyone can land the rotation once
//! Wormhole publishes the upgrade VAA. See `common::governance`.
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

// During host tests we still want access to `alloc`. In contract builds the
// `ckb_std::entry!` macro brings `alloc` into scope, which the update path uses
// to buffer the governance VAA witness.
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
    high_level::{
        load_cell_data, load_cell_type, load_input, load_script, load_witness_args, QueryIter,
    },
};
// Import shared errors, guardian-set decoding, and trustless-rotation logic.
use lean_oracle_common::{
    errors::*,
    governance::{verify_guardian_set_upgrade, RotationError},
    guardian_set::GuardianSetData,
    wormhole_verify::VerifyError,
};

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
    // Disallowing same-index (or backward) mutation ensures that every
    // legitimate signer rotation is visible as a set-index increment. The exact
    // "+1" step is re-checked cryptographically below, but rejecting non-forward
    // moves up front gives a clearer error and keeps parity with prior behavior.
    if new.set_index <= old.set_index {
        return ERROR_GUARDIAN_SET_CONTINUITY;
    }

    // Require the new set to be internally consistent.
    if !new.validate() {
        return ERROR_GUARDIAN_SET_MALFORMED;
    }

    // Trustless authorization: the rotation must be endorsed by a Wormhole
    // guardian-set-upgrade governance VAA signed by the *current* on-chain set.
    // The VAA is carried in the group input's WitnessArgs `input_type` field
    // (the same slot the oracle uses for its update witness).
    let governance_vaa = match load_rotation_vaa() {
        Ok(bytes) => bytes,
        Err(code) => return code,
    };

    match verify_guardian_set_upgrade(&old, &new, &governance_vaa) {
        Ok(()) => 0,
        Err(e) => rotation_error_code(e),
    }
}

// Load the guardian-set-upgrade governance VAA from the group input's witness.
fn load_rotation_vaa() -> Result<alloc::vec::Vec<u8>, i8> {
    let witness_args = load_witness_args(0, Source::GroupInput).map_err(|_| ERROR_SYSCALL)?;
    let input_type = witness_args
        .input_type()
        .to_opt()
        .ok_or(ERROR_GOVERNANCE_VAA_MALFORMED)?
        .raw_data();
    Ok(input_type.to_vec())
}

// Map a `RotationError` to its canonical `i8` status code.
fn rotation_error_code(e: RotationError) -> i8 {
    match e {
        RotationError::VaaMalformed => ERROR_GOVERNANCE_VAA_MALFORMED,
        RotationError::EmitterMismatch => ERROR_GOVERNANCE_EMITTER_MISMATCH,
        RotationError::ActionInvalid => ERROR_GOVERNANCE_ACTION_INVALID,
        RotationError::IndexMismatch => ERROR_ROTATION_INDEX_MISMATCH,
        RotationError::SetMismatch => ERROR_ROTATION_SET_MISMATCH,
        RotationError::QuorumMismatch => ERROR_ROTATION_QUORUM_MISMATCH,
        RotationError::Verify(VerifyError::Quorum) => ERROR_GUARDIAN_QUORUM_NOT_MET,
        RotationError::Verify(VerifyError::Order) => ERROR_GUARDIAN_SIGNATURE_ORDER,
        RotationError::Verify(VerifyError::Signature) => ERROR_GUARDIAN_SIGNATURE_INVALID,
    }
}
