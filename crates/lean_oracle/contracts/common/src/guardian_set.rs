//! This file defines the in-memory representation and manual byte encoding for
//! guardian-set cells.
//!
//! A guardian-set cell is the on-chain root of trust for Wormhole-style oracle
//! verification inside `lean_oracle`. The oracle script does not hardcode the
//! allowed signers; instead, it loads a governed guardian-set cell from
//! `CellDep` and checks recovered Ethereum-style guardian addresses against it.
//!
//! **Current-set-only policy**: this Nervos fork intentionally does not support
//! Wormhole's guardian-set expiry or grace-window behavior. Only the active
//! canonical guardian set is trusted for verification. Once a guardian rotation
//! occurs, blobs signed by the old set are no longer accepted. Callers must
//! fetch a new signed blob from Hermes after rotation.
//!
//! Lifecycle fields (`creation_time`, `expiration_time`) are intentionally
//! absent from the layout. They are not part of this trust model.
//!
//! Signer rotation is supported in place by incrementing the `set_index` and
//! updating the `guardian_addresses`. Authority for such updates is handled
//! by the cell's lock script.

use crate::types::{GuardianAddress, GuardianSetIndex};

// This struct is the decoded Rust view of a guardian-set cell's data section.
// Only fields needed for active-set verification are stored — lifecycle fields
// (creation_time, expiration_time) are intentionally absent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuardianSetData {
    /// Monotonic set index.
    pub set_index: GuardianSetIndex,
    /// Minimum number of guardian signatures required for acceptance.
    pub quorum: u32,
    /// The governed guardian addresses.
    pub guardian_addresses: alloc::vec::Vec<GuardianAddress>,
}

// Header size before the variable-length address vector:
// set_index(4) + quorum(4) + guardian_count(4) = 12 bytes.
pub const GUARDIAN_SET_HEADER_LEN: usize = 12;

impl GuardianSetData {
    /// Decode a guardian-set cell from raw bytes.
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() < GUARDIAN_SET_HEADER_LEN {
            return None;
        }

        let set_index = GuardianSetIndex(u32::from_le_bytes(data[0..4].try_into().ok()?));
        let quorum = u32::from_le_bytes(data[4..8].try_into().ok()?);
        let guardian_count = u32::from_le_bytes(data[8..12].try_into().ok()?) as usize;

        // Enforce exact total size to avoid trailing-garbage bugs.
        if data.len() != GUARDIAN_SET_HEADER_LEN + guardian_count * 20 {
            return None;
        }

        let mut guardian_addresses = alloc::vec::Vec::with_capacity(guardian_count);
        let mut cursor = GUARDIAN_SET_HEADER_LEN;
        while cursor < data.len() {
            let mut addr = [0u8; 20];
            addr.copy_from_slice(&data[cursor..cursor + 20]);
            guardian_addresses.push(GuardianAddress(addr));
            cursor += 20;
        }

        Some(Self {
            set_index,
            quorum,
            guardian_addresses,
        })
    }

    /// Encode the guardian-set struct back into the on-chain byte layout.
    pub fn to_bytes(&self) -> alloc::vec::Vec<u8> {
        let mut out =
            alloc::vec::Vec::with_capacity(GUARDIAN_SET_HEADER_LEN + self.guardian_addresses.len() * 20);
        out.extend_from_slice(&self.set_index.0.to_le_bytes());
        out.extend_from_slice(&self.quorum.to_le_bytes());
        out.extend_from_slice(&(self.guardian_addresses.len() as u32).to_le_bytes());
        for addr in &self.guardian_addresses {
            out.extend_from_slice(addr.as_slice());
        }
        out
    }

    /// Validate the internal consistency of the guardian set.
    pub fn validate(&self) -> bool {
        // A valid set must have at least one guardian and a non-zero quorum
        // that does not exceed the set size.
        if self.guardian_addresses.is_empty()
            || self.quorum == 0
            || self.quorum as usize > self.guardian_addresses.len()
        {
            return false;
        }
        // All guardian addresses must be distinct. Duplicate addresses would
        // allow a single key to satisfy multiple signature slots.
        let addrs = &self.guardian_addresses;
        for i in 0..addrs.len() {
            for j in (i + 1)..addrs.len() {
                if addrs[i] == addrs[j] {
                    return false;
                }
            }
        }
        true
    }
}
