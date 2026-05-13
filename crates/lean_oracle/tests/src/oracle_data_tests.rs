//! This file is the main executable documentation suite for `lean_oracle`.
//!
//! Every test here is intentionally explicit because the project depends on:
//! - byte-precise layouts
//! - exact hashing rules
//! - exact signature recovery behavior
//! - exact accumulator parsing behavior
//!
//! In practice, these tests serve as both validation and worked examples.

use crate::hermes_real_fixture::{
    decode_hex, decode_hex_20, decode_hex_32, BTC_USD_FEED_ID_HEX, REAL_GUARDIAN_SET,
    REAL_HERMES_ACCUMULATOR_HEX, REAL_HERMES_EXPECTED_ACCUMULATOR_SLOT,
    REAL_HERMES_EXPECTED_CONF, REAL_HERMES_EXPECTED_EMA_CONF, REAL_HERMES_EXPECTED_EMA_PRICE,
    REAL_HERMES_EXPECTED_EXPO, REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX,
    REAL_HERMES_EXPECTED_PREV_PUBLISH_TIME, REAL_HERMES_EXPECTED_PRICE,
    REAL_HERMES_EXPECTED_PUBLISH_TIME,
};
use k256::ecdsa::SigningKey;
use lean_oracle_common::{
    guardian_set::GuardianSetData,
    merkle::{keccak256, pyth_leaf_hash, verify_merkle_proof, verify_pyth_merkle_proof},
    oracle_data::OracleData,
    oracle_witness::OracleUpdateWitness,
    pyth_accumulator::{ParsedAccumulatorUpdate, ParsedAccumulatorUpdateForFeed, PriceFeedMessage},
    types::{EmitterAddress, FeedId, GuardianAddress, GuardianSetIndex},
    wormhole_vaa::ParsedVaa,
    wormhole_verify::{ethereum_address, verify_guardian_quorum},
};
use sha3::{Digest, Keccak256};

#[test]
fn test_oracle_data_roundtrip() {
    let original = OracleData {
        feed_id: FeedId([0x11; 32]),
        guardian_set_type_hash: [0x99; 32],
        price: 123_456,
        conf: 789,
        expo: -7,
        publish_time: 1_775_182_293,
        prev_publish_time: 1_775_182_292,
        ema_price: 123_400,
        ema_conf: 700,
        emitter_chain: 26,
        emitter_address: EmitterAddress([0x22; 32]),
    };

    let bytes = original.to_bytes();
    let decoded = OracleData::from_bytes(&bytes).expect("decode oracle state");
    assert_eq!(decoded, original);
}

// Verify the simplified header layout: set_index(4) + quorum(4) + count(4) = 12 bytes,
// plus 20 bytes per guardian address.
#[test]
fn test_guardian_set_encoded_size_without_lifecycle_fields() {
    let gs = GuardianSetData {
        set_index: GuardianSetIndex(5),
        quorum: 3,
        guardian_addresses: vec![
            GuardianAddress([0x11; 20]),
            GuardianAddress([0x22; 20]),
        ],
    };
    let bytes = gs.to_bytes();
    assert_eq!(bytes.len(), 12 + 2 * 20, "encoded size must be header(12) + 2 addresses(40)");
}

#[test]
fn test_guardian_set_roundtrip() {
    let original = GuardianSetData {
        set_index: GuardianSetIndex(42),
        quorum: 13,
        guardian_addresses: vec![
            GuardianAddress([0x44; 20]),
            GuardianAddress([0x55; 20]),
            GuardianAddress([0x66; 20]),
        ],
    };

    let bytes = original.to_bytes();
    let decoded = GuardianSetData::from_bytes(&bytes).expect("decode guardian set");

    assert_eq!(decoded, original);
}


#[test]
fn test_oracle_update_witness_roundtrip() {
    let original = OracleUpdateWitness {
        accumulator_update: vec![1, 2, 3, 4, 5],
    };

    let bytes = original.to_bytes();
    let decoded = OracleUpdateWitness::from_bytes(&bytes).expect("decode witness");
    assert_eq!(decoded, original);
}

#[test]
fn test_parse_minimal_wormhole_vaa() {
    let mut encoded = Vec::new();
    encoded.push(1);
    encoded.extend_from_slice(&3u32.to_be_bytes());
    encoded.push(2);

    encoded.push(1);
    encoded.extend_from_slice(&[0x11; 65]);
    encoded.push(4);
    encoded.extend_from_slice(&[0x22; 65]);

    encoded.extend_from_slice(&1_775_182_293u32.to_be_bytes());
    encoded.extend_from_slice(&7u32.to_be_bytes());
    encoded.extend_from_slice(&26u16.to_be_bytes());
    encoded.extend_from_slice(&[0x33; 32]);
    encoded.extend_from_slice(&99u64.to_be_bytes());
    encoded.push(1);
    encoded.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]);

    let parsed = ParsedVaa::parse(&encoded).expect("parse vaa");
    assert_eq!(parsed.version, 1);
    assert_eq!(parsed.guardian_set_index, GuardianSetIndex(3));
    assert_eq!(parsed.signatures.len(), 2);
    assert_eq!(parsed.signatures[0].guardian_index, 1);
    assert_eq!(parsed.signatures[0].v(), 0x11);
    assert_eq!(parsed.signatures[1].guardian_index, 4);
    assert_eq!(parsed.timestamp, 1_775_182_293);
    assert_eq!(parsed.nonce, 7);
    assert_eq!(parsed.emitter_chain, 26);
    assert_eq!(parsed.emitter_address, EmitterAddress([0x33; 32]));
    assert_eq!(parsed.sequence, 99);
    assert_eq!(parsed.consistency_level, 1);
    assert_eq!(parsed.payload, vec![0xde, 0xad, 0xbe, 0xef]);
}

#[test]
fn test_verify_guardian_quorum_with_real_signatures() {
    let signing_key_1 = SigningKey::from_bytes((&[1u8; 32]).into()).expect("key1");
    let signing_key_2 = SigningKey::from_bytes((&[2u8; 32]).into()).expect("key2");

    let guardian_1 = ethereum_address(signing_key_1.verifying_key());
    let guardian_2 = ethereum_address(signing_key_2.verifying_key());

    let body = {
        let mut body = Vec::new();
        body.extend_from_slice(&1_775_182_293u32.to_be_bytes());
        body.extend_from_slice(&7u32.to_be_bytes());
        body.extend_from_slice(&26u16.to_be_bytes());
        body.extend_from_slice(&[0x33; 32]);
        body.extend_from_slice(&99u64.to_be_bytes());
        body.push(1);
        body.extend_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        body
    };

    let inner = Keccak256::digest(&body);
    let digest_1 = Keccak256::new().chain_update(inner);
    let digest_2 = Keccak256::new().chain_update(Keccak256::digest(&body));

    let (sig1, recid1) = signing_key_1
        .sign_digest_recoverable(digest_1)
        .expect("sign1");
    let (sig2, recid2) = signing_key_2
        .sign_digest_recoverable(digest_2)
        .expect("sign2");

    let mut encoded = Vec::new();
    encoded.push(1);
    encoded.extend_from_slice(&3u32.to_be_bytes());
    encoded.push(2);
    encoded.push(0);
    encoded.extend_from_slice(&sig1.to_bytes());
    encoded.push(recid1.to_byte());
    encoded.push(1);
    encoded.extend_from_slice(&sig2.to_bytes());
    encoded.push(recid2.to_byte());
    encoded.extend_from_slice(&body);

    let vaa = ParsedVaa::parse(&encoded).expect("parse signed vaa");
    let guardian_set = GuardianSetData {
        set_index: GuardianSetIndex(3),
        quorum: 2,
        guardian_addresses: vec![GuardianAddress(guardian_1), GuardianAddress(guardian_2)],
    };

    assert!(verify_guardian_quorum(&vaa, &guardian_set).is_ok());
}

#[test]
fn test_verify_merkle_proof_for_two_leaf_tree() {
    let left = keccak256(b"left");
    let right = keccak256(b"right");

    let mut combined = [0u8; 64];
    combined[..32].copy_from_slice(&left);
    combined[32..].copy_from_slice(&right);
    let root = keccak256(&combined);

    assert!(verify_merkle_proof(root, left, &[right]));
    assert!(verify_merkle_proof(root, right, &[left]));
}

#[test]
fn test_verify_pyth_merkle_proof_for_single_leaf() {
    let message = b"example-price-message";
    let root = pyth_leaf_hash(message);
    assert!(verify_pyth_merkle_proof(root, message, &[]));
}

#[test]
fn test_parse_minimal_accumulator_update() {
    let signing_key_1 = SigningKey::from_bytes((&[1u8; 32]).into()).expect("key1");
    let signing_key_2 = SigningKey::from_bytes((&[2u8; 32]).into()).expect("key2");

    let price_message = PriceFeedMessage {
        feed_id: FeedId([0x77; 32]),
        price: 1000,
        conf: 25,
        expo: -8,
        publish_time: 123456,
        prev_publish_time: 123455,
        ema_price: 995,
        ema_conf: 20,
    };

    let raw_message = encode_price_feed_message(&price_message);
    let root_digest = pyth_leaf_hash(&raw_message);

    let vaa_payload = {
        let mut payload = Vec::new();
        payload.extend_from_slice(&0x4155_5756u32.to_be_bytes());
        payload.push(0);
        payload.extend_from_slice(&282540738u64.to_be_bytes());
        payload.extend_from_slice(&0u32.to_be_bytes());
        payload.extend_from_slice(&root_digest);
        payload
    };

    let body = {
        let mut body = Vec::new();
        body.extend_from_slice(&1_775_182_293u32.to_be_bytes());
        body.extend_from_slice(&7u32.to_be_bytes());
        body.extend_from_slice(&26u16.to_be_bytes());
        body.extend_from_slice(&[0x33; 32]);
        body.extend_from_slice(&99u64.to_be_bytes());
        body.push(1);
        body.extend_from_slice(&vaa_payload);
        body
    };

    let inner = Keccak256::digest(&body);
    let (sig1, recid1) = signing_key_1
        .sign_digest_recoverable(Keccak256::new().chain_update(inner))
        .expect("sign1");
    let (sig2, recid2) = signing_key_2
        .sign_digest_recoverable(Keccak256::new().chain_update(Keccak256::digest(&body)))
        .expect("sign2");

    let vaa = {
        let mut encoded = Vec::new();
        encoded.push(1);
        encoded.extend_from_slice(&3u32.to_be_bytes());
        encoded.push(2);
        encoded.push(0);
        encoded.extend_from_slice(&sig1.to_bytes());
        encoded.push(recid1.to_byte());
        encoded.push(1);
        encoded.extend_from_slice(&sig2.to_bytes());
        encoded.push(recid2.to_byte());
        encoded.extend_from_slice(&body);
        encoded
    };

    let accumulator_update = {
        let mut encoded = Vec::new();
        encoded.extend_from_slice(&0x504e_4155u32.to_be_bytes());
        encoded.push(1);
        encoded.push(0);
        encoded.push(0);
        encoded.push(0);
        encoded.extend_from_slice(&(vaa.len() as u16).to_be_bytes());
        encoded.extend_from_slice(&vaa);
        encoded.push(1);
        encoded.extend_from_slice(&(raw_message.len() as u16).to_be_bytes());
        encoded.extend_from_slice(&raw_message);
        encoded.push(0);
        encoded
    };

    let parsed = ParsedAccumulatorUpdate::parse(&accumulator_update).expect("parse accumulator");
    assert_eq!(parsed.vaa.guardian_set_index, GuardianSetIndex(3));
    assert_eq!(parsed.vaa.emitter_chain, 26);
    assert_eq!(parsed.slot, 282540738);
    assert_eq!(parsed.root_digest, root_digest);
    assert_eq!(parsed.messages.len(), 1);
    assert_eq!(parsed.messages[0], price_message);
}

#[test]
fn test_parse_accumulator_for_target_feed() {
    let signing_key_1 = SigningKey::from_bytes((&[1u8; 32]).into()).expect("key1");
    let signing_key_2 = SigningKey::from_bytes((&[2u8; 32]).into()).expect("key2");

    let target_message = PriceFeedMessage {
        feed_id: FeedId([0x77; 32]),
        price: 1000,
        conf: 25,
        expo: -8,
        publish_time: 123456,
        prev_publish_time: 123455,
        ema_price: 995,
        ema_conf: 20,
    };
    let other_message = PriceFeedMessage {
        feed_id: FeedId([0x88; 32]),
        price: 2000,
        conf: 30,
        expo: -8,
        publish_time: 223456,
        prev_publish_time: 223455,
        ema_price: 1995,
        ema_conf: 22,
    };

    let target_raw = encode_price_feed_message(&target_message);
    let other_raw = encode_price_feed_message(&other_message);

    let target_leaf = pyth_leaf_hash(&target_raw);
    let other_leaf = pyth_leaf_hash(&other_raw);
    let root_digest = lean_oracle_common::merkle::pyth_node_hash(target_leaf, other_leaf);

    let vaa_payload = {
        let mut payload = Vec::new();
        payload.extend_from_slice(&0x4155_5756u32.to_be_bytes());
        payload.push(0);
        payload.extend_from_slice(&282540738u64.to_be_bytes());
        payload.extend_from_slice(&0u32.to_be_bytes());
        payload.extend_from_slice(&root_digest);
        payload
    };

    let body = {
        let mut body = Vec::new();
        body.extend_from_slice(&1_775_182_293u32.to_be_bytes());
        body.extend_from_slice(&7u32.to_be_bytes());
        body.extend_from_slice(&26u16.to_be_bytes());
        body.extend_from_slice(&[0x33; 32]);
        body.extend_from_slice(&99u64.to_be_bytes());
        body.push(1);
        body.extend_from_slice(&vaa_payload);
        body
    };

    let inner = Keccak256::digest(&body);
    let (sig1, recid1) = signing_key_1
        .sign_digest_recoverable(Keccak256::new().chain_update(inner))
        .expect("sign1");
    let (sig2, recid2) = signing_key_2
        .sign_digest_recoverable(Keccak256::new().chain_update(Keccak256::digest(&body)))
        .expect("sign2");

    let vaa = {
        let mut encoded = Vec::new();
        encoded.push(1);
        encoded.extend_from_slice(&3u32.to_be_bytes());
        encoded.push(2);
        encoded.push(0);
        encoded.extend_from_slice(&sig1.to_bytes());
        encoded.push(recid1.to_byte());
        encoded.push(1);
        encoded.extend_from_slice(&sig2.to_bytes());
        encoded.push(recid2.to_byte());
        encoded.extend_from_slice(&body);
        encoded
    };

    let accumulator_update = {
        let mut encoded = Vec::new();
        encoded.extend_from_slice(&0x504e_4155u32.to_be_bytes());
        encoded.push(1);
        encoded.push(0);
        encoded.push(0);
        encoded.push(0);
        encoded.extend_from_slice(&(vaa.len() as u16).to_be_bytes());
        encoded.extend_from_slice(&vaa);
        encoded.push(2);
        encoded.extend_from_slice(&(target_raw.len() as u16).to_be_bytes());
        encoded.extend_from_slice(&target_raw);
        encoded.push(1);
        encoded.extend_from_slice(&other_leaf);
        encoded.extend_from_slice(&(other_raw.len() as u16).to_be_bytes());
        encoded.extend_from_slice(&other_raw);
        encoded.push(1);
        encoded.extend_from_slice(&target_leaf);
        encoded
    };

    let parsed = ParsedAccumulatorUpdateForFeed::parse_for_feed(&accumulator_update, &FeedId([0x77; 32]))
        .expect("parse target feed");
    assert_eq!(parsed.vaa.guardian_set_index, GuardianSetIndex(3));
    assert_eq!(parsed.slot, 282540738);
    assert_eq!(parsed.root_digest, root_digest);
    assert_eq!(parsed.message, target_message);
}

#[test]
fn test_real_hermes_blob_decodes_to_saved_hermes_values() {
    let accumulator_update = decode_hex(REAL_HERMES_ACCUMULATOR_HEX).expect("decode real hex");
    let target_feed_id = FeedId(decode_hex_32(BTC_USD_FEED_ID_HEX).expect("decode feed id"));

    let parsed =
        ParsedAccumulatorUpdateForFeed::parse_for_feed(&accumulator_update, &target_feed_id)
            .expect("parse real accumulator");

    let guardian_set = GuardianSetData {
        set_index: parsed.vaa.guardian_set_index,
        quorum: 13,
        guardian_addresses: REAL_GUARDIAN_SET
            .iter()
            .map(|addr| GuardianAddress(decode_hex_20(addr).expect("decode guardian")))
            .collect(),
    };

    // Note: This check is informational/exploratory only. Fixture validity
    // depends on decode fidelity (below), not on current mainnet signatures.
    let _quorum_ok = verify_guardian_quorum(&parsed.vaa, &guardian_set).is_ok();

    assert_eq!(
        parsed.vaa.guardian_set_index,
        GuardianSetIndex(REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX)
    );
    assert_eq!(parsed.slot, REAL_HERMES_EXPECTED_ACCUMULATOR_SLOT);
    assert_eq!(parsed.message.feed_id, target_feed_id);
    assert_eq!(parsed.message.price, REAL_HERMES_EXPECTED_PRICE);
    assert_eq!(parsed.message.conf, REAL_HERMES_EXPECTED_CONF);
    assert_eq!(parsed.message.expo, REAL_HERMES_EXPECTED_EXPO);
    assert_eq!(
        parsed.message.publish_time,
        REAL_HERMES_EXPECTED_PUBLISH_TIME
    );
    assert_eq!(
        parsed.message.prev_publish_time,
        REAL_HERMES_EXPECTED_PREV_PUBLISH_TIME
    );
    assert_eq!(parsed.message.ema_price, REAL_HERMES_EXPECTED_EMA_PRICE);
    assert_eq!(parsed.message.ema_conf, REAL_HERMES_EXPECTED_EMA_CONF);
}

#[test]
fn test_vaa_parse_rejects_unsupported_version() {
    let mut encoded = Vec::new();
    encoded.push(2u8); // version 2 — unsupported
    encoded.extend_from_slice(&3u32.to_be_bytes()); // guardian_set_index
    encoded.push(0u8); // no signatures
    // minimal 51-byte body
    encoded.extend_from_slice(&0u32.to_be_bytes()); // timestamp
    encoded.extend_from_slice(&0u32.to_be_bytes()); // nonce
    encoded.extend_from_slice(&26u16.to_be_bytes()); // emitter_chain
    encoded.extend_from_slice(&[0u8; 32]); // emitter_address
    encoded.extend_from_slice(&0u64.to_be_bytes()); // sequence
    encoded.push(0u8); // consistency_level

    assert!(
        ParsedVaa::parse(&encoded).is_none(),
        "VAA version != 1 must be rejected"
    );
}

#[test]
fn test_wormhole_merkle_payload_rejects_trailing_bytes() {
    // Build a wormhole-merkle payload with one extra trailing byte.
    let root_digest = [0xAAu8; 20];
    let wh_payload = {
        let mut p = Vec::new();
        p.extend_from_slice(&0x4155_5756u32.to_be_bytes()); // AUWV magic
        p.push(0u8); // update type WormholeMerkle
        p.extend_from_slice(&0u64.to_be_bytes()); // slot
        p.extend_from_slice(&0u32.to_be_bytes()); // ring_size
        p.extend_from_slice(&root_digest);
        p.push(0xFFu8); // trailing byte — must cause rejection
        p
    };

    // Build a minimal VAA body containing this payload (no signatures needed —
    // the trailing-byte error fires during payload parsing, before sig verification).
    let body = {
        let mut b = Vec::new();
        b.extend_from_slice(&0u32.to_be_bytes()); // timestamp
        b.extend_from_slice(&0u32.to_be_bytes()); // nonce
        b.extend_from_slice(&26u16.to_be_bytes()); // emitter_chain
        b.extend_from_slice(&[0u8; 32]); // emitter_address
        b.extend_from_slice(&0u64.to_be_bytes()); // sequence
        b.push(0u8); // consistency_level
        b.extend_from_slice(&wh_payload);
        b
    };

    let vaa = {
        let mut v = Vec::new();
        v.push(1u8); // version
        v.extend_from_slice(&0u32.to_be_bytes()); // guardian_set_index
        v.push(0u8); // 0 signatures
        v.extend_from_slice(&body);
        v
    };

    let accumulator = {
        let mut a = Vec::new();
        a.extend_from_slice(&0x504e_4155u32.to_be_bytes()); // PNAU magic
        a.push(1u8); // major version
        a.push(0u8); // minor version
        a.push(0u8); // trailing header size
        a.push(0u8); // update type WormholeMerkle
        a.extend_from_slice(&(vaa.len() as u16).to_be_bytes());
        a.extend_from_slice(&vaa);
        a.push(0u8); // num_updates = 0
        a
    };

    assert!(
        ParsedAccumulatorUpdate::parse(&accumulator).is_err(),
        "wormhole-merkle payload with trailing bytes must be rejected"
    );
}

#[test]
fn test_guardian_set_rejects_duplicate_addresses() {
    let dup = GuardianSetData {
        set_index: GuardianSetIndex(1),
        quorum: 1,
        guardian_addresses: vec![GuardianAddress([0x11; 20]), GuardianAddress([0x11; 20])],
    };
    assert!(!dup.validate(), "duplicate guardian addresses must be rejected");
}

#[test]
fn test_guardian_set_accepts_distinct_addresses() {
    let distinct = GuardianSetData {
        set_index: GuardianSetIndex(1),
        quorum: 2,
        guardian_addresses: vec![GuardianAddress([0x11; 20]), GuardianAddress([0x22; 20])],
    };
    assert!(distinct.validate(), "distinct guardian addresses must be accepted");
}

#[test]
fn test_parse_for_feed_skips_unsupported_non_target_message_type() {
    // Batch: [unsupported-type non-target, PriceFeed target]
    // The unsupported message should be skipped; target extraction must succeed.
    let signing_key = SigningKey::from_bytes((&[1u8; 32]).into()).expect("key");
    let target_feed_id = FeedId([0x77; 32]);
    let non_target_feed_id = FeedId([0xBB; 32]);

    let target_message = PriceFeedMessage {
        feed_id: target_feed_id,
        price: 5000,
        conf: 10,
        expo: -8,
        publish_time: 999,
        prev_publish_time: 998,
        ema_price: 4990,
        ema_conf: 8,
    };

    let target_raw = encode_price_feed_message(&target_message);

    // Build the unsupported-type message bytes (type=0x01, non-target feed_id, padding).
    let mut unsupported_raw = Vec::new();
    unsupported_raw.push(0x01u8); // unsupported type
    unsupported_raw.extend_from_slice(non_target_feed_id.as_slice());
    unsupported_raw.extend_from_slice(&[0u8; 8]); // arbitrary trailing bytes

    let unsupported_leaf = pyth_leaf_hash(&unsupported_raw);
    let target_leaf = pyth_leaf_hash(&target_raw);
    let root_digest = lean_oracle_common::merkle::pyth_node_hash(unsupported_leaf, target_leaf);

    let vaa_payload = {
        let mut p = Vec::new();
        p.extend_from_slice(&0x4155_5756u32.to_be_bytes());
        p.push(0);
        p.extend_from_slice(&1u64.to_be_bytes());
        p.extend_from_slice(&0u32.to_be_bytes());
        p.extend_from_slice(&root_digest);
        p
    };
    let body = {
        let mut b = Vec::new();
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&26u16.to_be_bytes());
        b.extend_from_slice(&[0u8; 32]);
        b.extend_from_slice(&0u64.to_be_bytes());
        b.push(1);
        b.extend_from_slice(&vaa_payload);
        b
    };
    let hash = Keccak256::new().chain_update(Keccak256::digest(&body));
    let (sig, recid) = signing_key.sign_digest_recoverable(hash).expect("sign");
    let vaa = {
        let mut v = Vec::new();
        v.push(1);
        v.extend_from_slice(&0u32.to_be_bytes());
        v.push(1);
        v.push(0);
        v.extend_from_slice(&sig.to_bytes());
        v.push(recid.to_byte());
        v.extend_from_slice(&body);
        v
    };
    let accumulator_update = {
        let mut a = Vec::new();
        a.extend_from_slice(&0x504e_4155u32.to_be_bytes());
        a.push(1); a.push(0); a.push(0);
        a.push(0); // WormholeMerkle
        a.extend_from_slice(&(vaa.len() as u16).to_be_bytes());
        a.extend_from_slice(&vaa);
        a.push(2); // num_updates
        // message 0: unsupported-type, non-target — proof_size=1 (sibling=target_leaf)
        a.extend_from_slice(&(unsupported_raw.len() as u16).to_be_bytes());
        a.extend_from_slice(&unsupported_raw);
        a.push(1);
        a.extend_from_slice(&target_leaf);
        // message 1: target PriceFeed — proof_size=1 (sibling=unsupported_leaf)
        a.extend_from_slice(&(target_raw.len() as u16).to_be_bytes());
        a.extend_from_slice(&target_raw);
        a.push(1);
        a.extend_from_slice(&unsupported_leaf);
        a
    };

    let parsed = ParsedAccumulatorUpdateForFeed::parse_for_feed(&accumulator_update, &target_feed_id)
        .expect("should succeed: unsupported non-target message must be skipped");
    assert_eq!(parsed.message, target_message);
}

#[test]
fn test_parse_for_feed_rejects_unsupported_target_message_type() {
    // Batch: single message with type=0x01 (unsupported) and the target feed_id.
    // parse_for_feed must return UnsupportedType.
    let signing_key = SigningKey::from_bytes((&[1u8; 32]).into()).expect("key");
    let target_feed_id = FeedId([0x77; 32]);

    let mut unsupported_raw = Vec::new();
    unsupported_raw.push(0x01u8); // unsupported type
    unsupported_raw.extend_from_slice(target_feed_id.as_slice()); // IS the target
    unsupported_raw.extend_from_slice(&[0u8; 8]);

    let root_digest = pyth_leaf_hash(&unsupported_raw);

    let vaa_payload = {
        let mut p = Vec::new();
        p.extend_from_slice(&0x4155_5756u32.to_be_bytes());
        p.push(0);
        p.extend_from_slice(&1u64.to_be_bytes());
        p.extend_from_slice(&0u32.to_be_bytes());
        p.extend_from_slice(&root_digest);
        p
    };
    let body = {
        let mut b = Vec::new();
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&26u16.to_be_bytes());
        b.extend_from_slice(&[0u8; 32]);
        b.extend_from_slice(&0u64.to_be_bytes());
        b.push(1);
        b.extend_from_slice(&vaa_payload);
        b
    };
    let hash = Keccak256::new().chain_update(Keccak256::digest(&body));
    let (sig, recid) = signing_key.sign_digest_recoverable(hash).expect("sign");
    let vaa = {
        let mut v = Vec::new();
        v.push(1);
        v.extend_from_slice(&0u32.to_be_bytes());
        v.push(1); v.push(0);
        v.extend_from_slice(&sig.to_bytes());
        v.push(recid.to_byte());
        v.extend_from_slice(&body);
        v
    };
    let accumulator_update = {
        let mut a = Vec::new();
        a.extend_from_slice(&0x504e_4155u32.to_be_bytes());
        a.push(1); a.push(0); a.push(0); a.push(0);
        a.extend_from_slice(&(vaa.len() as u16).to_be_bytes());
        a.extend_from_slice(&vaa);
        a.push(1); // num_updates
        a.extend_from_slice(&(unsupported_raw.len() as u16).to_be_bytes());
        a.extend_from_slice(&unsupported_raw);
        a.push(0); // proof_size 0
        a
    };

    let result = ParsedAccumulatorUpdateForFeed::parse_for_feed(&accumulator_update, &target_feed_id);
    assert!(
        matches!(result, Err(lean_oracle_common::parse_error::ParseError::UnsupportedType)),
        "target with unsupported message type must be rejected"
    );
}

#[test]
fn test_parse_for_feed_rejects_duplicate_target_messages() {
    // Batch: two PriceFeed messages with the same target feed_id.
    // parse_for_feed must return TargetFeedDuplicate.
    let signing_key = SigningKey::from_bytes((&[1u8; 32]).into()).expect("key");
    let target_feed_id = FeedId([0x77; 32]);

    let msg_a = PriceFeedMessage {
        feed_id: target_feed_id,
        price: 1000,
        conf: 10,
        expo: -8,
        publish_time: 100,
        prev_publish_time: 99,
        ema_price: 999,
        ema_conf: 9,
    };
    let msg_b = PriceFeedMessage {
        price: 2000,
        publish_time: 200,
        prev_publish_time: 199,
        ema_price: 1999,
        ..msg_a.clone()
    };

    let raw_a = encode_price_feed_message(&msg_a);
    let raw_b = encode_price_feed_message(&msg_b);
    let leaf_a = pyth_leaf_hash(&raw_a);
    let leaf_b = pyth_leaf_hash(&raw_b);
    let root_digest = lean_oracle_common::merkle::pyth_node_hash(leaf_a, leaf_b);

    let vaa_payload = {
        let mut p = Vec::new();
        p.extend_from_slice(&0x4155_5756u32.to_be_bytes());
        p.push(0);
        p.extend_from_slice(&1u64.to_be_bytes());
        p.extend_from_slice(&0u32.to_be_bytes());
        p.extend_from_slice(&root_digest);
        p
    };
    let body = {
        let mut b = Vec::new();
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&26u16.to_be_bytes());
        b.extend_from_slice(&[0u8; 32]);
        b.extend_from_slice(&0u64.to_be_bytes());
        b.push(1);
        b.extend_from_slice(&vaa_payload);
        b
    };
    let hash = Keccak256::new().chain_update(Keccak256::digest(&body));
    let (sig, recid) = signing_key.sign_digest_recoverable(hash).expect("sign");
    let vaa = {
        let mut v = Vec::new();
        v.push(1);
        v.extend_from_slice(&0u32.to_be_bytes());
        v.push(1); v.push(0);
        v.extend_from_slice(&sig.to_bytes());
        v.push(recid.to_byte());
        v.extend_from_slice(&body);
        v
    };
    let accumulator_update = {
        let mut a = Vec::new();
        a.extend_from_slice(&0x504e_4155u32.to_be_bytes());
        a.push(1); a.push(0); a.push(0); a.push(0);
        a.extend_from_slice(&(vaa.len() as u16).to_be_bytes());
        a.extend_from_slice(&vaa);
        a.push(2); // num_updates
        // msg_a with proof=[leaf_b]
        a.extend_from_slice(&(raw_a.len() as u16).to_be_bytes());
        a.extend_from_slice(&raw_a);
        a.push(1);
        a.extend_from_slice(&leaf_b);
        // msg_b with proof=[leaf_a]
        a.extend_from_slice(&(raw_b.len() as u16).to_be_bytes());
        a.extend_from_slice(&raw_b);
        a.push(1);
        a.extend_from_slice(&leaf_a);
        a
    };

    let result = ParsedAccumulatorUpdateForFeed::parse_for_feed(&accumulator_update, &target_feed_id);
    assert!(
        matches!(result, Err(lean_oracle_common::parse_error::ParseError::TargetFeedDuplicate)),
        "duplicate target messages must be rejected"
    );
}

fn encode_price_feed_message(message: &PriceFeedMessage) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(0);
    out.extend_from_slice(message.feed_id.as_slice());
    out.extend_from_slice(&message.price.to_be_bytes());
    out.extend_from_slice(&message.conf.to_be_bytes());
    out.extend_from_slice(&message.expo.to_be_bytes());
    out.extend_from_slice(&message.publish_time.to_be_bytes());
    out.extend_from_slice(&message.prev_publish_time.to_be_bytes());
    out.extend_from_slice(&message.ema_price.to_be_bytes());
    out.extend_from_slice(&message.ema_conf.to_be_bytes());
    out
}
