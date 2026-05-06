//! This file defines the binary witness wrapper used by oracle update
//! transactions.
//!
//! The current witness format is intentionally small:
//! - a single length prefix
//! - followed by one raw Pyth accumulator update blob
//!
//! The on-chain script is responsible for parsing that blob further.

use crate::byte_reader::ByteReader;

// The decoded witness view used by the oracle script.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OracleUpdateWitness {
    // Raw Pyth accumulator update bytes, usually fetched from Hermes.
    pub accumulator_update: alloc::vec::Vec<u8>,
}

impl OracleUpdateWitness {
    // Decode the witness wrapper from raw bytes.
    pub fn from_bytes(data: &[u8]) -> Option<Self> {
        let mut reader = ByteReader::new(data);

        // Read the size prefix for the accumulator blob.
        let update_len = reader.read_u32_le()? as usize;
        // Slice out the accumulator blob itself.
        let accumulator_update = reader.take(update_len)?.to_vec();

        // Reject trailing bytes so the witness format stays strict and
        // unambiguous during transaction validation.
        if !reader.is_finished() {
            return None;
        }

        // Return the decoded witness.
        Some(Self { accumulator_update })
    }

    // Encode the witness back into the canonical binary format.
    pub fn to_bytes(&self) -> alloc::vec::Vec<u8> {
        // Create the output buffer.
        let mut out = alloc::vec::Vec::new();
        // Write the blob length prefix.
        out.extend_from_slice(&(self.accumulator_update.len() as u32).to_le_bytes());
        // Write the accumulator bytes themselves.
        out.extend_from_slice(&self.accumulator_update);
        // Return the encoded witness bytes.
        out
    }
}
