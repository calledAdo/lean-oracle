//! This file parses the raw Pyth accumulator update blob returned by Hermes.
//!
//! The parser implemented here follows the same high-level structure as the
//! Solidity-side Pyth accumulator verifier:
//! - parse the outer `PNAU` wrapper
//! - extract the embedded Wormhole VAA
//! - parse the Wormhole payload to get the signed Merkle root
//! - parse each attached price message and its proof
//! - verify that every decoded message is included in the signed root
//!
//! This is the bridge between "raw Hermes bytes" and "typed price updates that
//! the oracle cell can compare against its output state".

use crate::{
    byte_reader::ByteReader,
    merkle::verify_pyth_merkle_proof,
    parse_error::ParseError,
    types::FeedId,
    wormhole_vaa::ParsedVaa,
};

// Magic for the outer Pyth accumulator wrapper (`PNAU`).
pub const ACCUMULATOR_MAGIC: u32 = 0x504e4155;
// Magic for the Wormhole-merkle accumulator payload (`AUWV`).
pub const ACCUMULATOR_WORMHOLE_MAGIC: u32 = 0x41555756;
// Supported outer accumulator major version.
pub const ACCUMULATOR_MAJOR_VERSION: u8 = 1;
// Supported update type inside the outer wrapper (WormholeMerkle).
pub const UPDATE_TYPE_WORMHOLE_MERKLE: u8 = 0;
// Supported message type for price-feed messages.
pub const MESSAGE_TYPE_PRICE_FEED: u8 = 0;

// Typed view of one decoded and authenticated Pyth price message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PriceFeedMessage {
    /// 32-byte Pyth feed identifier.
    pub feed_id: FeedId,
    /// Spot price value.
    pub price: i64,
    /// Spot confidence interval.
    pub conf: u64,
    /// Decimal exponent.
    pub expo: i32,
    /// Current publish time.
    pub publish_time: u64,
    /// Previous publish time carried by the message.
    pub prev_publish_time: u64,
    /// EMA price value.
    pub ema_price: i64,
    /// EMA confidence interval.
    pub ema_conf: u64,
}

// Parsed view of a whole accumulator update batch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedAccumulatorUpdate {
    /// The embedded Wormhole VAA.
    pub vaa: ParsedVaa,
    /// Slot number extracted from the payload.
    pub slot: u64,
    /// Signed 20-byte Merkle root.
    pub root_digest: [u8; 20],
    /// All authenticated messages in the batch.
    pub messages: alloc::vec::Vec<PriceFeedMessage>,
}

// Parsed view of an accumulator update for one target feed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedAccumulatorUpdateForFeed {
    /// The embedded Wormhole VAA.
    pub vaa: ParsedVaa,
    /// Slot number extracted from the payload.
    pub slot: u64,
    /// Signed 20-byte Merkle root.
    pub root_digest: [u8; 20],
    /// The single authenticated message for the requested feed.
    pub message: PriceFeedMessage,
}

struct AccumulatorHeader {
    vaa: ParsedVaa,
    slot: u64,
    root_digest: [u8; 20],
}

impl ParsedAccumulatorUpdate {
    /// Parse a full accumulator update from raw Hermes bytes.
    pub fn parse(data: &[u8]) -> Result<Self, ParseError> {
        let mut reader = ByteReader::new(data);
        let header = parse_accumulator_header(&mut reader)?;

        let mut body_reader = ByteReader::new(reader.remaining());
        let num_updates = body_reader.read_u8().ok_or(ParseError::Truncated)? as usize;
        let mut messages = alloc::vec::Vec::with_capacity(num_updates);

        for _ in 0..num_updates {
            let message_size = body_reader.read_u16_be().ok_or(ParseError::Truncated)? as usize;
            let message_bytes = body_reader.take(message_size).ok_or(ParseError::Truncated)?;
            let proof_size = body_reader.read_u8().ok_or(ParseError::Truncated)? as usize;
            let mut proof = alloc::vec::Vec::with_capacity(proof_size);

            for _ in 0..proof_size {
                let proof_item = body_reader.take(20).ok_or(ParseError::Truncated)?;
                let mut digest = [0u8; 20];
                digest.copy_from_slice(proof_item);
                proof.push(digest);
            }

            if !verify_pyth_merkle_proof(header.root_digest, message_bytes, &proof) {
                return Err(ParseError::Malformed);
            }

            let message = parse_price_feed_message(message_bytes)?;
            messages.push(message);
        }

        if !body_reader.is_finished() {
            return Err(ParseError::TrailingBytes);
        }

        Ok(Self {
            vaa: header.vaa,
            slot: header.slot,
            root_digest: header.root_digest,
            messages,
        })
    }
}

impl ParsedAccumulatorUpdateForFeed {
    /// Parse an accumulator update and extract the authenticated message for
    /// the requested feed id.
    pub fn parse_for_feed(data: &[u8], target_feed_id: &FeedId) -> Result<Self, ParseError> {
        let mut reader = ByteReader::new(data);
        let header = parse_accumulator_header(&mut reader)?;

        let mut body_reader = ByteReader::new(reader.remaining());
        let num_updates = body_reader.read_u8().ok_or(ParseError::Truncated)? as usize;
        let mut matched_message: Option<PriceFeedMessage> = None;

        for _ in 0..num_updates {
            let message_size = body_reader.read_u16_be().ok_or(ParseError::Truncated)? as usize;
            let message_bytes = body_reader.take(message_size).ok_or(ParseError::Truncated)?;
            let (message_type, feed_id) = parse_message_header(message_bytes)?;

            let proof_size = body_reader.read_u8().ok_or(ParseError::Truncated)? as usize;

            if message_type != MESSAGE_TYPE_PRICE_FEED {
                // Unsupported message type: reject if this is the target feed,
                // skip silently if it is an irrelevant non-target entry.
                if &feed_id == target_feed_id {
                    return Err(ParseError::UnsupportedType);
                }
                let proof_bytes_len = proof_size.checked_mul(20).ok_or(ParseError::Malformed)?;
                body_reader.take(proof_bytes_len).ok_or(ParseError::Truncated)?;
                continue;
            }

            if &feed_id == target_feed_id {
                if matched_message.is_some() {
                    return Err(ParseError::TargetFeedDuplicate);
                }

                let mut proof = alloc::vec::Vec::with_capacity(proof_size);
                for _ in 0..proof_size {
                    let proof_item = body_reader.take(20).ok_or(ParseError::Truncated)?;
                    let mut digest = [0u8; 20];
                    digest.copy_from_slice(proof_item);
                    proof.push(digest);
                }

                if !verify_pyth_merkle_proof(header.root_digest, message_bytes, &proof) {
                    return Err(ParseError::Malformed);
                }

                matched_message = Some(parse_price_feed_message(message_bytes)?);
            } else {
                let proof_bytes_len = proof_size.checked_mul(20).ok_or(ParseError::Malformed)?;
                body_reader.take(proof_bytes_len).ok_or(ParseError::Truncated)?;
            }
        }

        if !body_reader.is_finished() {
            return Err(ParseError::TrailingBytes);
        }

        Ok(Self {
            vaa: header.vaa,
            slot: header.slot,
            root_digest: header.root_digest,
            message: matched_message.ok_or(ParseError::TargetFeedMissing)?,
        })
    }
}

fn parse_accumulator_header(reader: &mut ByteReader) -> Result<AccumulatorHeader, ParseError> {
    let magic = reader.read_u32_be().ok_or(ParseError::Truncated)?;
    if magic != ACCUMULATOR_MAGIC {
        return Err(ParseError::WrongMagic);
    }

    let major = reader.read_u8().ok_or(ParseError::Truncated)?;
    if major != ACCUMULATOR_MAJOR_VERSION {
        return Err(ParseError::UnsupportedVersion);
    }

    let _minor = reader.read_u8().ok_or(ParseError::Truncated)?;
    let trailing_header_size = reader.read_u8().ok_or(ParseError::Truncated)? as usize;
    reader.take(trailing_header_size).ok_or(ParseError::Truncated)?;

    let update_type = reader.read_u8().ok_or(ParseError::Truncated)?;
    if update_type != UPDATE_TYPE_WORMHOLE_MERKLE {
        return Err(ParseError::UnsupportedType);
    }

    let wh_proof_size = reader.read_u16_be().ok_or(ParseError::Truncated)? as usize;
    let vaa_bytes = reader.take(wh_proof_size).ok_or(ParseError::Truncated)?;
    let vaa = ParsedVaa::parse(vaa_bytes).ok_or(ParseError::Malformed)?;

    let (slot, root_digest) = parse_wormhole_merkle_payload(&vaa.payload)?;

    Ok(AccumulatorHeader {
        vaa,
        slot,
        root_digest,
    })
}

fn parse_wormhole_merkle_payload(payload: &[u8]) -> Result<(u64, [u8; 20]), ParseError> {
    let mut reader = ByteReader::new(payload);
    let magic = reader.read_u32_be().ok_or(ParseError::Truncated)?;
    if magic != ACCUMULATOR_WORMHOLE_MAGIC {
        return Err(ParseError::WrongMagic);
    }

    let update_type = reader.read_u8().ok_or(ParseError::Truncated)?;
    if update_type != UPDATE_TYPE_WORMHOLE_MERKLE {
        return Err(ParseError::UnsupportedType);
    }

    let slot = reader.read_u64_be().ok_or(ParseError::Truncated)?;
    let _ring_size = reader.read_u32_be().ok_or(ParseError::Truncated)?;

    let mut digest = [0u8; 20];
    digest.copy_from_slice(reader.take(20).ok_or(ParseError::Truncated)?);

    // The payload is expected to be exactly 37 bytes (4+1+8+4+20). Trailing
    // bytes would indicate a format version change or malformed input.
    if !reader.is_finished() {
        return Err(ParseError::TrailingBytes);
    }

    Ok((slot, digest))
}

fn parse_price_feed_message(data: &[u8]) -> Result<PriceFeedMessage, ParseError> {
    let mut reader = ByteReader::new(data);
    let message_type = reader.read_u8().ok_or(ParseError::Truncated)?;
    if message_type != MESSAGE_TYPE_PRICE_FEED {
        return Err(ParseError::UnsupportedType);
    }

    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(reader.take(32).ok_or(ParseError::Truncated)?);

    let price = reader.read_i64_be().ok_or(ParseError::Truncated)?;
    let conf = reader.read_u64_be().ok_or(ParseError::Truncated)?;
    let expo = reader.read_i32_be().ok_or(ParseError::Truncated)?;
    let publish_time = reader.read_u64_be().ok_or(ParseError::Truncated)?;
    let prev_publish_time = reader.read_u64_be().ok_or(ParseError::Truncated)?;
    let ema_price = reader.read_i64_be().ok_or(ParseError::Truncated)?;
    let ema_conf = reader.read_u64_be().ok_or(ParseError::Truncated)?;

    if !reader.is_finished() {
        return Err(ParseError::TrailingBytes);
    }

    Ok(PriceFeedMessage {
        feed_id: FeedId(feed_id),
        price,
        conf,
        expo,
        publish_time,
        prev_publish_time,
        ema_price,
        ema_conf,
    })
}

fn parse_message_header(data: &[u8]) -> Result<(u8, FeedId), ParseError> {
    let mut reader = ByteReader::new(data);
    let message_type = reader.read_u8().ok_or(ParseError::Truncated)?;
    let mut feed_id = [0u8; 32];
    feed_id.copy_from_slice(reader.take(32).ok_or(ParseError::Truncated)?);
    Ok((message_type, FeedId(feed_id)))
}
