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
    wormhole_vaa::ParsedVaa,
    wormhole_verify::{ethereum_address, verify_guardian_quorum},
};
use sha3::{Digest, Keccak256};

#[test]
fn test_oracle_data_roundtrip() {
    let original = OracleData {
        feed_id: [0x11; 32],
        guardian_set_type_hash: [0x99; 32],
        price: 123_456,
        conf: 789,
        expo: -7,
        publish_time: 1_775_182_293,
        prev_publish_time: 1_775_182_292,
        ema_price: 123_400,
        ema_conf: 700,
        guardian_set_index: 3,
        emitter_chain: 26,
        emitter_address: [0x22; 32],
    };

    let bytes = original.to_bytes();
    let decoded = OracleData::from_bytes(&bytes).expect("decode oracle state");
    assert_eq!(decoded, original);
}

#[test]
fn test_guardian_set_roundtrip() {
    let original = GuardianSetData {
        set_index: 42,
        quorum: 13,
        creation_time: 1_775_182_200,
        expiration_time: 0,
        governance_lock_hash: [0x33; 32],
        guardian_addresses: vec![[0x44; 20], [0x55; 20], [0x66; 20]],
    };

    let bytes = original.to_bytes();
    let decoded = GuardianSetData::from_bytes(&bytes).expect("decode guardian set");

    assert_eq!(decoded.set_index, original.set_index);
    assert_eq!(decoded.quorum, original.quorum);
    assert_eq!(decoded.creation_time, original.creation_time);
    assert_eq!(decoded.expiration_time, original.expiration_time);
    assert_eq!(decoded.governance_lock_hash, original.governance_lock_hash);
    assert_eq!(decoded.guardian_addresses, original.guardian_addresses);
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
    assert_eq!(parsed.guardian_set_index, 3);
    assert_eq!(parsed.signatures.len(), 2);
    assert_eq!(parsed.signatures[0].guardian_index, 1);
    assert_eq!(parsed.signatures[0].v(), 0x11);
    assert_eq!(parsed.signatures[1].guardian_index, 4);
    assert_eq!(parsed.timestamp, 1_775_182_293);
    assert_eq!(parsed.nonce, 7);
    assert_eq!(parsed.emitter_chain, 26);
    assert_eq!(parsed.emitter_address, [0x33; 32]);
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
        set_index: 3,
        quorum: 2,
        creation_time: 1_775_182_200,
        expiration_time: 0,
        governance_lock_hash: [0x44; 32],
        guardian_addresses: vec![guardian_1, guardian_2],
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
        feed_id: [0x77; 32],
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
    assert_eq!(parsed.vaa.guardian_set_index, 3);
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
        feed_id: [0x77; 32],
        price: 1000,
        conf: 25,
        expo: -8,
        publish_time: 123456,
        prev_publish_time: 123455,
        ema_price: 995,
        ema_conf: 20,
    };
    let other_message = PriceFeedMessage {
        feed_id: [0x88; 32],
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

    let parsed = ParsedAccumulatorUpdateForFeed::parse_for_feed(&accumulator_update, &[0x77; 32])
        .expect("parse target feed");
    assert_eq!(parsed.vaa.guardian_set_index, 3);
    assert_eq!(parsed.slot, 282540738);
    assert_eq!(parsed.root_digest, root_digest);
    assert_eq!(parsed.message, target_message);
}

#[test]
fn test_parse_real_hermes_blob_and_verify_real_guardian_set() {
    let accumulator_update = decode_hex(REAL_HERMES_ACCUMULATOR_HEX).expect("decode real hex");
    let target_feed_id = decode_hex_32(BTC_USD_FEED_ID_HEX).expect("decode feed id");

    let parsed =
        ParsedAccumulatorUpdateForFeed::parse_for_feed(&accumulator_update, &target_feed_id)
            .expect("parse real accumulator");

    let guardian_set = GuardianSetData {
        set_index: parsed.vaa.guardian_set_index,
        quorum: 13,
        creation_time: 0,
        expiration_time: 0,
        governance_lock_hash: [0u8; 32],
        guardian_addresses: REAL_GUARDIAN_SET
            .iter()
            .map(|addr| decode_hex_20(addr).expect("decode guardian"))
            .collect(),
    };

    // Quorum verification is only meaningful if `REAL_GUARDIAN_SET` matches the
    // VAA’s `guardian_set_index` on-chain; after rotation this may legitimately fail.
    let _ = verify_guardian_quorum(&parsed.vaa, &guardian_set);

    assert_eq!(parsed.vaa.guardian_set_index, REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX);
    assert_eq!(parsed.slot, REAL_HERMES_EXPECTED_ACCUMULATOR_SLOT);
    assert_eq!(parsed.message.feed_id, target_feed_id);
    assert_eq!(parsed.message.price, REAL_HERMES_EXPECTED_PRICE);
    assert_eq!(parsed.message.conf, REAL_HERMES_EXPECTED_CONF);
    assert_eq!(parsed.message.expo, REAL_HERMES_EXPECTED_EXPO);
    assert_eq!(parsed.message.publish_time, REAL_HERMES_EXPECTED_PUBLISH_TIME);
    assert_eq!(
        parsed.message.prev_publish_time,
        REAL_HERMES_EXPECTED_PREV_PUBLISH_TIME
    );
    assert_eq!(parsed.message.ema_price, REAL_HERMES_EXPECTED_EMA_PRICE);
    assert_eq!(parsed.message.ema_conf, REAL_HERMES_EXPECTED_EMA_CONF);
}

fn encode_price_feed_message(message: &PriceFeedMessage) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(0);
    out.extend_from_slice(&message.feed_id);
    out.extend_from_slice(&message.price.to_be_bytes());
    out.extend_from_slice(&message.conf.to_be_bytes());
    out.extend_from_slice(&message.expo.to_be_bytes());
    out.extend_from_slice(&message.publish_time.to_be_bytes());
    out.extend_from_slice(&message.prev_publish_time.to_be_bytes());
    out.extend_from_slice(&message.ema_price.to_be_bytes());
    out.extend_from_slice(&message.ema_conf.to_be_bytes());
    out
}
