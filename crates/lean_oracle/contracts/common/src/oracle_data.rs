//! This file defines the in-memory representation and manual byte encoding for
//! oracle state cells.
//!
//! The oracle cell is the canonical on-chain storage object for a single feed.
//! It stores:
//! - the feed identifier
//! - the guardian-set dependency it trusts (anchored by type hash)
//! - the latest authenticated price values
//! - source-emitter information
//!
//! Creation of a new oracle cell anchors configuration (not price state) to a
//! canonical guardian-set lineage via `guardian_set_type_hash`. The first
//! authenticated price state is expected to arrive via a normal update.
//!
//! Note that `guardian_set_index` is not stored in the oracle state; instead,
//! it is read from the active guardian-set dependency during verification.
//! This allows oracle instances to continue across in-place guardian rotations.

use crate::types::{EmitterAddress, FeedId};

// This struct is the decoded Rust representation of a single oracle cell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OracleData {
    /// 32-byte Pyth feed identifier this cell tracks.
    pub feed_id: FeedId,
    /// Type hash of the guardian-set cell the oracle trusts.
    pub guardian_set_type_hash: [u8; 32],
    /// Latest signed spot price.
    pub price: i64,
    /// Confidence interval for the current spot price.
    pub conf: u64,
    /// Decimal exponent applied to `price` and `conf`.
    pub expo: i32,
    /// Time at which the current signed price was published.
    pub publish_time: u64,
    /// Previous publish time included in the signed update.
    pub prev_publish_time: u64,
    /// EMA price carried by the signed update.
    pub ema_price: i64,
    /// EMA confidence carried by the signed update.
    pub ema_conf: u64,
    /// Wormhole emitter chain identifier that must match the parsed VAA.
    pub emitter_chain: u32,
    /// Wormhole emitter address that must match the parsed VAA.
    pub emitter_address: EmitterAddress,
}

// Total byte length of the oracle cell data layout (152 bytes).
pub const ORACLE_STATE_LEN: usize = 152;

impl OracleData {
    /// Decode an oracle state struct from raw cell data.
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        if data.len() != ORACLE_STATE_LEN {
            return None;
        }

        let mut feed_id = [0u8; 32];
        feed_id.copy_from_slice(&data[0..32]);

        let mut guardian_set_type_hash = [0u8; 32];
        guardian_set_type_hash.copy_from_slice(&data[32..64]);

        let mut emitter_address = [0u8; 32];
        emitter_address.copy_from_slice(&data[120..152]);

        Some(Self {
            feed_id: FeedId(feed_id),
            guardian_set_type_hash,
            price: i64::from_le_bytes(data[64..72].try_into().ok()?),
            conf: u64::from_le_bytes(data[72..80].try_into().ok()?),
            expo: i32::from_le_bytes(data[80..84].try_into().ok()?),
            publish_time: u64::from_le_bytes(data[84..92].try_into().ok()?),
            prev_publish_time: u64::from_le_bytes(data[92..100].try_into().ok()?),
            ema_price: i64::from_le_bytes(data[100..108].try_into().ok()?),
            ema_conf: u64::from_le_bytes(data[108..116].try_into().ok()?),
            emitter_chain: u32::from_le_bytes(data[116..120].try_into().ok()?),
            emitter_address: EmitterAddress(emitter_address),
        })
    }

    /// Encode the oracle state struct back into its exact byte layout.
    pub fn to_bytes(&self) -> alloc::vec::Vec<u8> {
        let mut out = alloc::vec::Vec::with_capacity(ORACLE_STATE_LEN);
        out.extend_from_slice(self.feed_id.as_slice());
        out.extend_from_slice(&self.guardian_set_type_hash);
        out.extend_from_slice(&self.price.to_le_bytes());
        out.extend_from_slice(&self.conf.to_le_bytes());
        out.extend_from_slice(&self.expo.to_le_bytes());
        out.extend_from_slice(&self.publish_time.to_le_bytes());
        out.extend_from_slice(&self.prev_publish_time.to_le_bytes());
        out.extend_from_slice(&self.ema_price.to_le_bytes());
        out.extend_from_slice(&self.ema_conf.to_le_bytes());
        out.extend_from_slice(&self.emitter_chain.to_le_bytes());
        out.extend_from_slice(self.emitter_address.as_slice());
        out
    }

    /// Compare configuration fields that must stay fixed during an update.
    pub fn static_fields_unchanged(&self, other: &Self) -> bool {
        self.feed_id == other.feed_id
            && self.guardian_set_type_hash == other.guardian_set_type_hash
            && self.emitter_chain == other.emitter_chain
            && self.emitter_address == other.emitter_address
    }
}
