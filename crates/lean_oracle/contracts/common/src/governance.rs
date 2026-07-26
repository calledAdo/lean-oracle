//! This file implements **trustless** guardian-set rotation.
//!
//! A Wormhole guardian-set upgrade is itself a governance VAA (module `Core`,
//! action `2 = GuardianSetUpgrade`) signed by a quorum of the *current* guardian
//! set. In other words, set `N` cryptographically endorses set `N+1`.
//!
//! The guardian-set cell already stores set `N`'s addresses, so it can verify
//! its own successor using the exact same quorum logic the oracle relies on
//! (`wormhole_verify::verify_guardian_quorum`). This lets the rotation be
//! **permissionless**: the cell's lock no longer has to be a trusted key, because
//! the *type script* proves the transition is authentic. Anyone — an oracle
//! owner, a public keeper, or the deployer — can land the rotation the moment
//! Wormhole publishes the upgrade VAA.
//!
//! Only genesis (the very first set) is trusted, since there is no prior on-chain
//! set to verify it against. Every rotation afterwards is trustless.

use crate::{
    byte_reader::ByteReader,
    guardian_set::GuardianSetData,
    types::{GuardianAddress, GuardianSetIndex},
    wormhole_vaa::ParsedVaa,
    wormhole_verify::{verify_guardian_quorum, VerifyError},
};

/// Wormhole governance module identifier for the Core bridge.
///
/// Governance modules are 32-byte, right-aligned ASCII. "Core" therefore lives
/// in the final four bytes with the preceding 28 bytes zeroed.
pub const WORMHOLE_GOVERNANCE_MODULE_CORE: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, b'C', b'o',
    b'r', b'e',
];

/// Governance action id for `GuardianSetUpgrade`.
pub const WORMHOLE_GOVERNANCE_ACTION_GUARDIAN_SET_UPGRADE: u8 = 2;

/// The canonical Wormhole governance emitter chain (Solana).
pub const WORMHOLE_GOVERNANCE_EMITTER_CHAIN: u16 = 1;

/// The canonical Wormhole governance emitter address (`0x…04`).
pub const WORMHOLE_GOVERNANCE_EMITTER_ADDRESS: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4,
];

/// The target-chain value used for guardian-set upgrades. These are global,
/// so Wormhole issues them with chain id `0` ("all chains").
pub const WORMHOLE_GOVERNANCE_TARGET_CHAIN_ALL: u16 = 0;

/// Decoded `GuardianSetUpgrade` governance body (the bytes *after* the standard
/// module/action/chain governance header).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuardianSetUpgrade {
    /// Index the new set will occupy (`old_index + 1`).
    pub new_index: GuardianSetIndex,
    /// Addresses that make up the new set, in guardian order.
    pub addresses: alloc::vec::Vec<GuardianAddress>,
}

/// Reasons a proposed guardian-set rotation can be rejected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RotationError {
    /// The governance VAA failed structural parsing, or its payload was not a
    /// well-formed guardian-set upgrade.
    VaaMalformed,
    /// The VAA did not originate from the canonical Wormhole governance emitter.
    EmitterMismatch,
    /// The governance module, action, or target chain was not a guardian-set
    /// upgrade addressed to all chains.
    ActionInvalid,
    /// The declared new index was not exactly `old_index + 1`, or the output
    /// cell's `set_index` did not match the VAA's declared new index, or the VAA
    /// was not signed by the current on-chain set.
    IndexMismatch,
    /// The output cell's addresses did not exactly equal the VAA's declared set.
    SetMismatch,
    /// The output cell's `quorum` did not equal the canonical Wormhole quorum
    /// derived from the new set size.
    QuorumMismatch,
    /// The current-set quorum failed to verify the upgrade VAA's signatures.
    Verify(VerifyError),
}

/// Canonical Wormhole quorum for a set of `n` guardians: `floor(2n/3) + 1`.
///
/// This is computed by the type script rather than trusted from cell data, so a
/// malicious submitter cannot smuggle in a weak quorum (e.g. `1`) alongside an
/// otherwise-valid address list.
pub fn wormhole_quorum(n: usize) -> u32 {
    ((n as u64 * 2) / 3 + 1) as u32
}

/// Parse a `GuardianSetUpgrade` from a governance VAA payload.
///
/// Layout:
/// - `module`  : 32 bytes (must be Core)
/// - `action`  : 1 byte   (must be `GuardianSetUpgrade`)
/// - `chain`   : 2 bytes  (must be `0`, i.e. all chains)
/// - `new_index`: 4 bytes big-endian
/// - `num_guardians`: 1 byte
/// - `addresses`: `num_guardians * 20` bytes
///
/// Returns `None` on any structural problem, including trailing bytes.
pub fn parse_guardian_set_upgrade(payload: &[u8]) -> Result<GuardianSetUpgrade, RotationError> {
    let mut reader = ByteReader::new(payload);

    let module = reader.take(32).ok_or(RotationError::VaaMalformed)?;
    if module != WORMHOLE_GOVERNANCE_MODULE_CORE {
        return Err(RotationError::ActionInvalid);
    }

    let action = reader.read_u8().ok_or(RotationError::VaaMalformed)?;
    if action != WORMHOLE_GOVERNANCE_ACTION_GUARDIAN_SET_UPGRADE {
        return Err(RotationError::ActionInvalid);
    }

    let target_chain = reader.read_u16_be().ok_or(RotationError::VaaMalformed)?;
    if target_chain != WORMHOLE_GOVERNANCE_TARGET_CHAIN_ALL {
        return Err(RotationError::ActionInvalid);
    }

    let new_index = GuardianSetIndex(reader.read_u32_be().ok_or(RotationError::VaaMalformed)?);
    let num_guardians = reader.read_u8().ok_or(RotationError::VaaMalformed)? as usize;
    if num_guardians == 0 {
        return Err(RotationError::VaaMalformed);
    }

    let mut addresses = alloc::vec::Vec::with_capacity(num_guardians);
    for _ in 0..num_guardians {
        let raw = reader.take(20).ok_or(RotationError::VaaMalformed)?;
        let mut addr = [0u8; 20];
        addr.copy_from_slice(raw);
        addresses.push(GuardianAddress(addr));
    }

    // Reject trailing garbage so the upgrade body is exactly what we parsed.
    if !reader.is_finished() {
        return Err(RotationError::VaaMalformed);
    }

    Ok(GuardianSetUpgrade {
        new_index,
        addresses,
    })
}

/// Verify that `new` is the authentic successor of `old`, authorized by a
/// Wormhole guardian-set-upgrade governance VAA.
///
/// This is the trust-critical core of permissionless rotation. On success, the
/// caller may replace `old`'s cell data with `new` regardless of who signed the
/// transaction, because authenticity is proven by `old`'s own guardian quorum.
pub fn verify_guardian_set_upgrade(
    old: &GuardianSetData,
    new: &GuardianSetData,
    governance_vaa: &[u8],
) -> Result<(), RotationError> {
    // 1. Parse the governance VAA envelope.
    let vaa = ParsedVaa::parse(governance_vaa).ok_or(RotationError::VaaMalformed)?;

    // 2. It must originate from the canonical Wormhole governance emitter.
    if vaa.emitter_chain != WORMHOLE_GOVERNANCE_EMITTER_CHAIN
        || vaa.emitter_address.as_slice() != WORMHOLE_GOVERNANCE_EMITTER_ADDRESS
    {
        return Err(RotationError::EmitterMismatch);
    }

    // 3. It must be signed by the *current* on-chain set — set N endorses N+1.
    if vaa.guardian_set_index != old.set_index {
        return Err(RotationError::IndexMismatch);
    }

    // 4. Decode the guardian-set-upgrade body.
    let upgrade = parse_guardian_set_upgrade(&vaa.payload)?;

    // 5. The upgrade must advance the index by exactly one step, and the output
    //    cell must carry exactly that index. Requiring a single step forces
    //    missed rotations to be applied one-at-a-time, each endorsed by its
    //    immediate predecessor.
    let expected_new_index = old
        .set_index
        .0
        .checked_add(1)
        .ok_or(RotationError::IndexMismatch)?;
    if upgrade.new_index.0 != expected_new_index || new.set_index.0 != expected_new_index {
        return Err(RotationError::IndexMismatch);
    }

    // 6. The output cell's addresses must equal the VAA's declared set exactly.
    if new.guardian_addresses != upgrade.addresses {
        return Err(RotationError::SetMismatch);
    }

    // 7. The output cell's quorum must be the canonical derived quorum, never a
    //    submitter-chosen value.
    if new.quorum != wormhole_quorum(new.guardian_addresses.len()) {
        return Err(RotationError::QuorumMismatch);
    }

    // 8. Finally, the current set must actually meet quorum over the VAA.
    verify_guardian_quorum(&vaa, old).map_err(RotationError::Verify)?;

    Ok(())
}
