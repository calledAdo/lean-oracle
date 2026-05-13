//! `OwnedTypeBindLock` — permissionless-update lock with an owner escape hatch.
//!
//! This lock is designed for **public, permissionless** state cells (e.g. the
//! canonical oracle cells anyone may update via Hermes pulls) where two
//! properties are required:
//!
//! 1. **Anyone may consume the cell**, as long as the cell's `(lock, type)`
//!    identity continues in the outputs. This lets random callers submit
//!    updates without owning a key.
//! 2. **The cell cannot be captured or burned** by a non-owner — the lock
//!    refuses any transaction that drops, swaps, or collapses the bound cell.
//!
//! Authorization is split into two paths driven by the lock's `args`:
//!
//! - **Owner-escape path.** `args` is a 32-byte hash naming the **owner lock**.
//!   If any input cell in the transaction has that lock hash, the lock
//!   returns success unconditionally. Soundness: only inputs run their lock
//!   scripts, so including an owner-locked input requires the owner's
//!   signature against *that* lock. The owner therefore retains the ability
//!   to burn or migrate the cell at will.
//!
//! - **Continuity-bind path.** When no owner-locked input is present, the
//!   lock requires:
//!     - `|GroupInput| == |GroupOutput|` (no 2→1 collapse, no extra outputs)
//!     - Every group-input type hash appears in the group outputs (type
//!       identity is preserved per cell)
//!   Lock continuity is implicit: outputs that share this lock's group are by
//!   definition output cells whose lock matches this lock's script hash.
//!
//! `args` layout: exactly 32 bytes (the owner's lock hash). To deploy a cell
//! that admits no owner escape (pure continuity), use a sentinel hash that
//! cannot collide with any real script hash — e.g. all-zero bytes.

#![no_std]
#![cfg_attr(not(test), no_main)]

#[cfg(test)]
extern crate alloc;

#[cfg(not(test))]
use ckb_std::default_alloc;

#[cfg(not(test))]
ckb_std::entry!(program_entry);
#[cfg(not(test))]
default_alloc!(4096, 65536, 64);

use ckb_std::{
    ckb_constants::Source,
    error::SysError,
    high_level::{
        load_cell_lock_hash, load_cell_type_hash, load_script, load_script_hash, QueryIter,
    },
};
use lean_oracle_common::errors::*;

pub fn program_entry() -> i8 {
    let script = match load_script() {
        Ok(s) => s,
        Err(_) => return ERROR_SYSCALL,
    };
    let args = script.args().raw_data();
    if args.len() != 32 {
        return ERROR_BIND_LOCK_ARGS_MALFORMED;
    }
    let mut owner_lock_hash = [0u8; 32];
    owner_lock_hash.copy_from_slice(&args);

    // ── ① Owner-escape: any input whose lock hash matches `args` authorizes. ─
    //
    // Scans ALL transaction inputs (`Source::Input`), not just this script's
    // group — the owner cell is locked by a different script (e.g. secp256k1)
    // and therefore lives outside this lock's group.
    match owner_input_present(&owner_lock_hash) {
        Ok(true) => return 0,
        Ok(false) => {}
        Err(code) => return code,
    }

    // ── ② Continuity-bind path. ──────────────────────────────────────────────
    //
    // Lock scripts only have a meaningful `GroupInput` — CKB does not execute
    // output locks, so `GroupOutput` is always empty for locks. We therefore
    // count the lock's "output group" by walking `Source::Output` and
    // filtering by lock hash against this script's own hash.
    let self_lock_hash = match load_script_hash() {
        Ok(h) => h,
        Err(_) => return ERROR_SYSCALL,
    };

    let group_in_count = QueryIter::new(load_cell_lock_hash, Source::GroupInput).count();
    let group_out_count = match count_outputs_with_lock_hash(&self_lock_hash) {
        Ok(n) => n,
        Err(code) => return code,
    };
    if group_in_count != group_out_count {
        return ERROR_BIND_LOCK_COUNT_MISMATCH;
    }

    for i in 0..group_in_count {
        let in_type_hash = match load_cell_type_hash(i, Source::GroupInput) {
            Ok(Some(t)) => t,
            Ok(None) => return ERROR_BIND_LOCK_NO_TYPE_SCRIPT,
            Err(_) => return ERROR_SYSCALL,
        };
        if !output_group_has_type_hash(&self_lock_hash, &in_type_hash) {
            return ERROR_BIND_LOCK_TYPE_NOT_FOUND;
        }
    }
    0
}

// Walk all transaction inputs (across all script groups) and return true if
// any input cell's lock hash equals `expected`. Owner authorization is
// inferred from presence: the input's lock script will be executed by the VM,
// requiring the owner's signature there.
fn owner_input_present(expected: &[u8; 32]) -> Result<bool, i8> {
    let mut i = 0usize;
    loop {
        match load_cell_lock_hash(i, Source::Input) {
            Ok(h) => {
                if &h == expected {
                    return Ok(true);
                }
            }
            Err(SysError::IndexOutOfBound) => return Ok(false),
            Err(_) => return Err(ERROR_SYSCALL),
        }
        i += 1;
    }
}

fn count_outputs_with_lock_hash(lock_hash: &[u8; 32]) -> Result<usize, i8> {
    let mut count = 0usize;
    let mut i = 0usize;
    loop {
        match load_cell_lock_hash(i, Source::Output) {
            Ok(h) => {
                if &h == lock_hash {
                    count += 1;
                }
            }
            Err(SysError::IndexOutOfBound) => return Ok(count),
            Err(_) => return Err(ERROR_SYSCALL),
        }
        i += 1;
    }
}

fn output_group_has_type_hash(lock_hash: &[u8; 32], expected_type: &[u8; 32]) -> bool {
    let mut i = 0usize;
    loop {
        match load_cell_lock_hash(i, Source::Output) {
            Ok(h) if &h == lock_hash => match load_cell_type_hash(i, Source::Output) {
                Ok(Some(t)) => {
                    if &t == expected_type {
                        return true;
                    }
                }
                Ok(None) => {}
                Err(_) => return false,
            },
            Ok(_) => {}
            Err(SysError::IndexOutOfBound) => return false,
            Err(_) => return false,
        }
        i += 1;
    }
}
