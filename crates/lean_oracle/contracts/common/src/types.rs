//! This file defines lightweight domain newtypes to improve type safety and
//! clarity across the `lean_oracle` codebase.
//!
//! These types wrap raw byte arrays and integers to prevent accidental
//! mix-ups between distinct concepts like feed identifiers, addresses, and
//! indices.

/// 32-byte Pyth price feed identifier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeedId(pub [u8; 32]);

impl FeedId {
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl AsRef<[u8]> for FeedId {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// 32-byte Wormhole emitter address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EmitterAddress(pub [u8; 32]);

impl EmitterAddress {
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl AsRef<[u8]> for EmitterAddress {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// 20-byte Wormhole guardian address (Ethereum-style).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GuardianAddress(pub [u8; 20]);

impl GuardianAddress {
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl AsRef<[u8]> for GuardianAddress {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// 32-bit Wormhole guardian-set index.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct GuardianSetIndex(pub u32);
