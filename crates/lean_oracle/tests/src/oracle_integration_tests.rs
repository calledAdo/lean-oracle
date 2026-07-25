//! Integration tests for the `oracle_type` and `guardian_set_type` contracts.
//!
//! These tests move beyond host-only parser checks and build actual CKB
//! transactions using `ckb-testtool`.

use crate::hermes_real_fixture::{
    decode_hex, decode_hex_20, decode_hex_32, BTC_USD_FEED_ID_HEX, REAL_GUARDIAN_SET,
    REAL_HERMES_ACCUMULATOR_HEX, REAL_HERMES_EXPECTED_CONF, REAL_HERMES_EXPECTED_EMA_CONF,
    REAL_HERMES_EXPECTED_EMA_PRICE, REAL_HERMES_EXPECTED_EXPO,
    REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX, REAL_HERMES_EXPECTED_PREV_PUBLISH_TIME,
    REAL_HERMES_EXPECTED_PRICE, REAL_HERMES_EXPECTED_PUBLISH_TIME,
};
use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::TransactionBuilder,
        packed::{CellDep, CellInput, CellOutput, OutPoint, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use k256::ecdsa::SigningKey;
use lean_oracle_common::{
    errors::*,
    guardian_set::GuardianSetData,
    merkle::{pyth_leaf_hash, pyth_node_hash},
    oracle_data::OracleData,
    oracle_witness::OracleUpdateWitness,
    pyth_accumulator::PriceFeedMessage,
    types::{EmitterAddress, FeedId, GuardianAddress, GuardianSetIndex},
    wormhole_verify::ethereum_address,
};
use sha3::{Digest, Keccak256};

const MAX_CYCLES: u64 = 100_000_000;
/// Higher cycle budget for tests that verify 13+ secp256k1 signatures. Each
/// signature recovery costs ~5-7M cycles; mainnet-shaped quorums need ~80-100M
/// for the signature loop alone, beyond the 100M `MAX_CYCLES` ceiling used by
/// single-signer tests. Raise the budget locally rather than the global so
/// existing single-sig tests still catch unbounded regressions.
const MULTI_SIG_MAX_CYCLES: u64 = 1_000_000_000;

/// Helper to calculate the standard CKB Type ID.
fn calculate_type_id(first_input: &CellInput, output_index: u64) -> [u8; 32] {
    let mut blake2b = ckb_testtool::ckb_hash::Blake2bBuilder::new(32)
        .personal(b"ckb-default-hash")
        .build();
    blake2b.update(first_input.as_slice());
    blake2b.update(&output_index.to_le_bytes());
    let mut hash = [0u8; 32];
    blake2b.finalize(&mut hash);
    hash
}

#[test]
fn test_oracle_update_with_canonical_guardian_set_succeeds() {
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, Bytes::from_static(b"lock"))
        .expect("build lock");

    // --- Simulated Canonical State ---
    // We pre-calculate a valid Type ID that WOULD be produced by a creation transaction.
    // The guardian-set creation logic is separately verified in other tests.
    let dummy_input = CellInput::new_builder()
        .previous_output(OutPoint::new_builder().tx_hash([0x11; 32].pack()).index(0u32).build())
        .build();
    let type_id = calculate_type_id(&dummy_input, 0);

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(type_id.to_vec()))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    let signing_key = SigningKey::from_bytes((&[1u8; 32]).into()).expect("key");
    let guardian_addr = ethereum_address(signing_key.verifying_key());

    let guardian_set_data = GuardianSetData {
        set_index: GuardianSetIndex(1),
        quorum: 1,
        guardian_addresses: vec![GuardianAddress(guardian_addr)],
    };

    // Create the canonical guardian-set cell in context.
    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );

    // --- Oracle Update ---
    let feed_id = FeedId([0x88u8; 32]);
    let emitter_address = EmitterAddress([0x44u8; 32]);
    let guardian_set_index = GuardianSetIndex(1u32);

    let price_message = PriceFeedMessage {
        feed_id,
        price: 2000,
        conf: 50,
        expo: -8,
        publish_time: 3000,
        prev_publish_time: 2990,
        ema_price: 1995,
        ema_conf: 40,
    };

    let accumulator_update = build_synthetic_accumulator_update(
        &[(0, &signing_key)],
        guardian_set_index,
        &emitter_address,
        &price_message,
    );

    let oracle_type_script = context
        .build_script(&oracle_type_op, Bytes::from(feed_id.as_slice().to_vec()))
        .expect("build oracle type");

    let old_oracle = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: 1900,
        conf: 60,
        expo: -8,
        publish_time: 2000,
        prev_publish_time: 1900,
        ema_price: 1895,
        ema_conf: 50,
        emitter_chain: 26,
        emitter_address,
    };

    let oracle_input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(old_oracle.to_bytes()),
    );

    let new_oracle = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: price_message.price,
        conf: price_message.conf,
        expo: price_message.expo,
        publish_time: price_message.publish_time,
        prev_publish_time: price_message.prev_publish_time,
        ema_price: price_message.ema_price,
        ema_conf: price_message.ema_conf,
        emitter_chain: 26,
        emitter_address,
    };

    let witness = OracleUpdateWitness { accumulator_update };
    let witness_args = WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(witness.to_bytes())).pack())
        .build();

    let tx_update = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(oracle_input_out_point).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(new_oracle.to_bytes()).pack())
        .cell_dep(code_dep(&oracle_type_op))
        .cell_dep(code_dep(&guardian_set_type_op))
        .cell_dep(
            CellDep::new_builder()
                .out_point(guardian_dep_out_point)
                .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
                .build(),
        )
        .witness(witness_args.as_bytes().pack())
        .build();

    let tx_update = context.complete_tx(tx_update);
    context
        .verify_tx(&tx_update, MAX_CYCLES)
        .expect("oracle update with canonical guardian set should succeed");
}

#[test]
fn test_guardian_set_recreation_with_same_type_id_fails() {
    let mut context = Context::default();
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, Bytes::from_static(b"lock"))
        .expect("build lock");

    // Create a valid Type ID from some input.
    let input_out_point = context.create_cell(
        CellOutput::new_builder().capacity(1000u64).lock(lock.clone()).build(),
        Bytes::new(),
    );
    let first_input = CellInput::new_builder().previous_output(input_out_point).build();
    let type_id = calculate_type_id(&first_input, 0);

    // Try to use this same Type ID in a DIFFERENT transaction with DIFFERENT inputs.
    // This simulates an attacker trying to "guess" or "spoof" a canonical Type ID.
    let input_out_point_2 = context.create_cell(
        CellOutput::new_builder().capacity(1000u64).lock(lock.clone()).build(),
        Bytes::new(),
    );
    let first_input_2 = CellInput::new_builder().previous_output(input_out_point_2).build();

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(type_id.to_vec()))
        .expect("build guardian set type");

    let guardian_set_data = GuardianSetData {
        set_index: GuardianSetIndex(1),
        quorum: 1,
        guardian_addresses: vec![GuardianAddress([0x11; 20])],
    };

    let tx = TransactionBuilder::default()
        .input(first_input_2)
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock)
                .type_(Some(guardian_set_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(guardian_set_data.to_bytes()).pack())
        .cell_dep(code_dep(&guardian_set_type_op))
        .build();

    let tx = context.complete_tx(tx);
    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("guardian set re-creation with same type id should fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_TYPE_ID_INVALID)));
}

#[test]
fn test_oracle_script_rejects_multiple_outputs_in_group() {
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, Bytes::from_static(b"lock"))
        .expect("build lock");

    let feed_id = FeedId([0x99u8; 32]);
    let oracle_type_script = context
        .build_script(&oracle_type_op, Bytes::from(feed_id.as_slice().to_vec()))
        .expect("build oracle type");

    let oracle_data = OracleData {
        feed_id,
        guardian_set_type_hash: [0x11; 32],
        price: 1000,
        conf: 10,
        expo: -8,
        publish_time: 1000,
        prev_publish_time: 900,
        ema_price: 1000,
        ema_conf: 10,
        emitter_chain: 26,
        emitter_address: EmitterAddress([0x22; 32]),
    };

    let tx = TransactionBuilder::default()
        // No inputs (creation path)
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock.clone())
                .type_(Some(oracle_type_script.clone()).pack())
                .build(),
        )
        .output_data(Bytes::from(oracle_data.to_bytes()).pack())
        // SECOND output in the SAME script group
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(oracle_data.to_bytes()).pack())
        .cell_dep(code_dep(&oracle_type_op))
        .build();

    let tx = context.complete_tx(tx);
    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("oracle creation with multiple group outputs should fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_INVALID_SCRIPT_GROUP)));
}

#[test]
fn test_oracle_script_rejects_multiple_inputs_in_group() {
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, Bytes::from_static(b"lock"))
        .expect("build lock");

    let feed_id = FeedId([0x99u8; 32]);
    let oracle_type_script = context
        .build_script(&oracle_type_op, Bytes::from(feed_id.as_slice().to_vec()))
        .expect("build oracle type");

    let oracle_data = OracleData {
        feed_id,
        guardian_set_type_hash: [0x11; 32],
        price: 1000,
        conf: 10,
        expo: -8,
        publish_time: 1000,
        prev_publish_time: 900,
        ema_price: 1000,
        ema_conf: 10,
        emitter_chain: 26,
        emitter_address: EmitterAddress([0x22; 32]),
    };

    let input_1 = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(oracle_data.to_bytes()),
    );
    let input_2 = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(oracle_data.to_bytes()),
    );

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(input_1).build())
        .input(CellInput::new_builder().previous_output(input_2).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(oracle_data.to_bytes()).pack())
        .cell_dep(code_dep(&oracle_type_op))
        .build();

    let tx = context.complete_tx(tx);
    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("oracle update with multiple group inputs should fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_INVALID_SCRIPT_GROUP)));
}

#[test]
fn test_guardian_set_script_rejects_multiple_outputs_in_group() {
    let mut context = Context::default();
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, Bytes::from_static(b"lock"))
        .expect("build lock");

    // Valid creation input
    let input_out_point = context.create_cell(
        CellOutput::new_builder().capacity(1000u64).lock(lock.clone()).build(),
        Bytes::new(),
    );
    let first_input = CellInput::new_builder().previous_output(input_out_point).build();
    let type_id = calculate_type_id(&first_input, 0);

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(type_id.to_vec()))
        .expect("build guardian set type");

    let guardian_set_data = GuardianSetData {
        set_index: GuardianSetIndex(1),
        quorum: 1,
        guardian_addresses: vec![GuardianAddress([0x11; 20])],
    };

    let tx = TransactionBuilder::default()
        .input(first_input)
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock.clone())
                .type_(Some(guardian_set_type_script.clone()).pack())
                .build(),
        )
        .output_data(Bytes::from(guardian_set_data.to_bytes()).pack())
        // SECOND output in SAME script group
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock)
                .type_(Some(guardian_set_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(guardian_set_data.to_bytes()).pack())
        .cell_dep(code_dep(&guardian_set_type_op))
        .build();

    let tx = context.complete_tx(tx);
    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("guardian set creation with multiple group outputs should fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_INVALID_SCRIPT_GROUP)));
}

#[test]
fn test_guardian_set_script_rejects_multiple_inputs_in_group() {
    let mut context = Context::default();
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, Bytes::from_static(b"lock"))
        .expect("build lock");

    let type_id = [0xAA; 32];
    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(type_id.to_vec()))
        .expect("build guardian set type");

    let guardian_set_data = GuardianSetData {
        set_index: GuardianSetIndex(1),
        quorum: 1,
        guardian_addresses: vec![GuardianAddress([0x11; 20])],
    };

    let input_1 = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(guardian_set_type_script.clone()).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );
    let input_2 = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(guardian_set_type_script.clone()).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(input_1).build())
        .input(CellInput::new_builder().previous_output(input_2).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock)
                .type_(Some(guardian_set_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(guardian_set_data.to_bytes()).pack())
        .cell_dep(code_dep(&guardian_set_type_op))
        .build();

    let tx = context.complete_tx(tx);
    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("guardian set update with multiple group inputs should fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_INVALID_SCRIPT_GROUP)));
}

#[test]
fn test_guardian_set_creation_succeeds_with_valid_type_id() {
    let mut context = Context::default();
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, Bytes::from_static(b"lock"))
        .expect("build lock");

    // Create a dummy input to provide an OutPoint for the Type ID.
    let input_out_point = context.create_cell(
        CellOutput::new_builder().capacity(1000u64).lock(lock.clone()).build(),
        Bytes::new(),
    );
    let first_input = CellInput::new_builder().previous_output(input_out_point).build();

    // Calculate the valid Type ID for output index 0.
    let type_id = calculate_type_id(&first_input, 0);

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(type_id.to_vec()))
        .expect("build guardian set type");

    let guardian_set_data = GuardianSetData {
        set_index: GuardianSetIndex(1),
        quorum: 1,
        guardian_addresses: vec![GuardianAddress([0x11; 20])],
    };

    let tx = TransactionBuilder::default()
        .input(first_input)
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock)
                .type_(Some(guardian_set_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(guardian_set_data.to_bytes()).pack())
        .cell_dep(code_dep(&guardian_set_type_op))
        .build();

    let tx = context.complete_tx(tx);
    context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("guardian set creation with valid type id should succeed");
}

#[test]
fn test_guardian_set_creation_fails_with_invalid_type_id() {
    let mut context = Context::default();
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, Bytes::from_static(b"lock"))
        .expect("build lock");

    let input_out_point = context.create_cell(
        CellOutput::new_builder().capacity(1000u64).lock(lock.clone()).build(),
        Bytes::new(),
    );
    let first_input = CellInput::new_builder().previous_output(input_out_point).build();

    // Use a purposefully incorrect Type ID.
    let type_id = [0xEEu8; 32];

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(type_id.to_vec()))
        .expect("build guardian set type");

    let guardian_set_data = GuardianSetData {
        set_index: GuardianSetIndex(1),
        quorum: 1,
        guardian_addresses: vec![GuardianAddress([0x11; 20])],
    };

    let tx = TransactionBuilder::default()
        .input(first_input)
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock)
                .type_(Some(guardian_set_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(guardian_set_data.to_bytes()).pack())
        .cell_dep(code_dep(&guardian_set_type_op))
        .build();

    let tx = context.complete_tx(tx);
    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("guardian set creation with invalid type id should fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_TYPE_ID_INVALID)));
}

#[test]
fn test_oracle_update_fails_with_spoofed_guardian_set_dep() {
    // 1. Setup a valid synthetic update environment.
    let mut context = Context::default();

    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let _signing_key = SigningKey::from_bytes((&[1u8; 32]).into()).expect("key");

    let feed_id = FeedId([0x77u8; 32]);
    let emitter_address = EmitterAddress([0x33u8; 32]);
    let guardian_set_index = GuardianSetIndex(3u32);

    let price_message = PriceFeedMessage {
        feed_id,
        price: 1000,
        conf: 25,
        expo: -8,
        publish_time: 2000,
        prev_publish_time: 1990,
        ema_price: 995,
        ema_conf: 20,
    };

    let dummy_lock = context
        .build_script(&always_success_op, Bytes::from_static(b"oracle-lock"))
        .expect("build oracle lock");
    let guardian_lock = context
        .build_script(&always_success_op, Bytes::from_static(b"guardian-lock"))
        .expect("build guardian lock");

    // 2. Create the "canonical" guardian set (anchored by some Type ID).
    let canonical_type_id = [0xAAu8; 32];
    let canonical_guardian_script = context
        .build_script(&guardian_set_type_op, Bytes::from(canonical_type_id.to_vec()))
        .expect("build canonical guardian script");
    let canonical_type_hash: [u8; 32] = canonical_guardian_script.calc_script_hash().unpack();

    // 3. Create a "spoofed" guardian set (same code, different Type ID args).
    let spoofed_type_id = [0xBBu8; 32];
    let spoofed_guardian_script = context
        .build_script(&guardian_set_type_op, Bytes::from(spoofed_type_id.to_vec()))
        .expect("build spoofed guardian script");

    // Attacker controls the spoofed guardian set.
    let attacker_signing_key = SigningKey::from_bytes((&[2u8; 32]).into()).expect("attacker key");
    let attacker_addr = ethereum_address(attacker_signing_key.verifying_key());

    let spoofed_guardian_set_data = GuardianSetData {
        set_index: guardian_set_index,
        quorum: 1,
        guardian_addresses: vec![GuardianAddress(attacker_addr)],
    };

    let spoofed_guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(guardian_lock.clone())
            .type_(Some(spoofed_guardian_script).pack())
            .build(),
        Bytes::from(spoofed_guardian_set_data.to_bytes()),
    );

    // 4. Anchor the oracle to the CANONICAL guardian set.
    let oracle_type_script = context
        .build_script(&oracle_type_op, Bytes::from(feed_id.as_slice().to_vec()))
        .expect("build oracle type");

    let old_oracle = OracleData {
        feed_id,
        guardian_set_type_hash: canonical_type_hash,
        price: 900,
        conf: 30,
        expo: -8,
        publish_time: 1000,
        prev_publish_time: 900,
        ema_price: 895,
        ema_conf: 25,
        emitter_chain: 26,
        emitter_address,
    };

    let new_oracle = OracleData {
        feed_id,
        guardian_set_type_hash: canonical_type_hash,
        price: price_message.price,
        conf: price_message.conf,
        expo: price_message.expo,
        publish_time: price_message.publish_time,
        prev_publish_time: price_message.prev_publish_time,
        ema_price: price_message.ema_price,
        ema_conf: price_message.ema_conf,
        emitter_chain: 26,
        emitter_address,
    };

    let oracle_input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(dummy_lock.clone())
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(old_oracle.to_bytes()),
    );

    // 5. Attempt an oracle update using the SPOOFED guardian set as a dep.
    // Use the attacker's signed accumulator update.
    let spoofed_accumulator_update = build_synthetic_accumulator_update(
        &[(0, &attacker_signing_key)],
        guardian_set_index,
        &emitter_address,
        &price_message,
    );
    let witness = OracleUpdateWitness { accumulator_update: spoofed_accumulator_update };
    let witness_args = ckb_testtool::ckb_types::packed::WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(witness.to_bytes())).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(oracle_input_out_point)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(dummy_lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(new_oracle.to_bytes()).pack())
        .cell_dep(code_dep(&oracle_type_op))
        .cell_dep(code_dep(&guardian_set_type_op))
        .cell_dep(
            CellDep::new_builder()
                .out_point(spoofed_guardian_dep_out_point)
                .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
                .build(),
        )
        .witness(witness_args.as_bytes().pack())
        .build();

    let tx = context.complete_tx(tx);
    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("oracle update with spoofed guardian set should fail");
    
    // The oracle script fails to find the guardian set because it's looking for 
    // canonical_type_hash, but only spoofed_type_hash is provided in cell_deps.
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_GUARDIAN_SET_NOT_FOUND)));
}

#[test]
fn test_oracle_type_accepts_synthetic_signed_update() {
    let (context, tx, _, _) = build_synthetic_oracle_update_tx(|_| {}, |_| {});

    context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("synthetic valid update should verify");
}

#[test]
fn test_oracle_type_rejects_synthetic_tampered_output() {
    let (context, tx, _, _) = build_synthetic_oracle_update_tx(
        |_| {},
        |new_oracle| {
            new_oracle.price += 1;
        },
    );

    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("tampered output should fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_PRICE_UPDATE_MISMATCH)));
}

#[test]
#[ignore = "Exploratory: REAL_GUARDIAN_SET in fixture is stale/rotated relative to mainnet VAA"]
/// Exploratory integration test using real Hermes data.
///
/// NOTE: This test relies on a hardcoded guardian set (`REAL_GUARDIAN_SET`)
/// that may become stale if Wormhole rotates guardians. It is provided for
/// manual/exploratory verification and is not a stable CI gate for real
/// mainnet signature validity.
fn test_oracle_type_accepts_real_hermes_update_exploratory() {
    let mut context = Context::default();

    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let feed_id = FeedId(decode_hex_32(BTC_USD_FEED_ID_HEX).expect("decode feed id"));
    let emitter_address = EmitterAddress(decode_hex_32(
        "e101faedac5851e32b9b23b5f9411a8c2bac4aae3ed4dd7b811dd1a72ea4aa71",
    )
    .expect("decode emitter address"));
    let accumulator_update =
        decode_hex(REAL_HERMES_ACCUMULATOR_HEX).expect("decode accumulator hex");

    let dummy_lock = context
        .build_script(&always_success_op, Bytes::from_static(b"oracle-lock"))
        .expect("build oracle lock");
    let guardian_lock = context
        .build_script(&always_success_op, Bytes::from_static(b"guardian-lock"))
        .expect("build guardian lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(vec![0xAAu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    let guardian_set_data = GuardianSetData {
        set_index: GuardianSetIndex(REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX),
        quorum: 13,
        guardian_addresses: REAL_GUARDIAN_SET
            .iter()
            .map(|a| GuardianAddress(decode_hex_20(a).expect("decode guardian hex")))
            .collect(),
    };

    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(guardian_lock)
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );

    let oracle_type_script = context
        .build_script(&oracle_type_op, Bytes::from(feed_id.as_slice().to_vec()))
        .expect("build oracle type");

    let old_oracle = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: 7_820_000_000_000,
        conf: 2_500_000_000,
        expo: REAL_HERMES_EXPECTED_EXPO,
        publish_time: REAL_HERMES_EXPECTED_PUBLISH_TIME - 1,
        prev_publish_time: REAL_HERMES_EXPECTED_PUBLISH_TIME - 2,
        ema_price: 7_819_000_000_000,
        ema_conf: 2_500_000_000,
        emitter_chain: 26,
        emitter_address,
    };
    let new_oracle = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: REAL_HERMES_EXPECTED_PRICE,
        conf: REAL_HERMES_EXPECTED_CONF,
        expo: REAL_HERMES_EXPECTED_EXPO,
        publish_time: REAL_HERMES_EXPECTED_PUBLISH_TIME,
        prev_publish_time: REAL_HERMES_EXPECTED_PREV_PUBLISH_TIME,
        ema_price: REAL_HERMES_EXPECTED_EMA_PRICE,
        ema_conf: REAL_HERMES_EXPECTED_EMA_CONF,
        emitter_chain: 26,
        emitter_address,
    };

    let oracle_input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(dummy_lock.clone())
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(old_oracle.to_bytes()),
    );

    let witness = OracleUpdateWitness { accumulator_update };
    let witness_args = ckb_testtool::ckb_types::packed::WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(witness.to_bytes())).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(oracle_input_out_point)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(dummy_lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(new_oracle.to_bytes()).pack())
        .cell_dep(code_dep(&oracle_type_op))
        .cell_dep(code_dep(&guardian_set_type_op))
        .cell_dep(
            CellDep::new_builder()
                .out_point(guardian_dep_out_point)
                .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
                .build(),
        )
        .witness(witness_args.as_bytes().pack())
        .build();

    let tx = context.complete_tx(tx);
    context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("real oracle update should verify");
}

#[test]
fn test_oracle_type_rejects_wrong_guardian_set_index() {
    let (context, tx) = build_real_oracle_update_tx(
        |guardian_set| guardian_set.set_index = GuardianSetIndex(4),
        |_| {},
        |_| {},
    );

    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("wrong guardian-set index should fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_GUARDIAN_SET_INDEX_MISMATCH)));
}

#[test]
fn test_oracle_type_rejects_wrong_emitter_address() {
    let (context, tx) = build_real_oracle_update_tx(
        |_| {},
        |new_oracle| new_oracle.emitter_address = EmitterAddress([0x55; 32]),
        |_| {},
    );

    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("wrong emitter address should fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_CONFIG_MUTATED)));
}

#[test]
fn test_oracle_type_rejects_non_monotonic_publish_time() {
    let (context, tx) = build_real_oracle_update_tx(
        |_| {},
        |new_oracle| new_oracle.publish_time = REAL_HERMES_EXPECTED_PUBLISH_TIME,
        |old_oracle| old_oracle.publish_time = REAL_HERMES_EXPECTED_PUBLISH_TIME,
    );

    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("non-monotonic publish time should fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_TIMESTAMP_NOT_MONOTONIC)));
}

#[test]
#[ignore = "Real fixture has stale guardians; signature check fails (22) before price check (25)"]
fn test_oracle_type_rejects_tampered_output_price() {
    let (context, tx) = build_real_oracle_update_tx(
        |_| {},
        |new_oracle| new_oracle.price += 1,
        |_| {},
    );

    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("tampered oracle output should fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_PRICE_UPDATE_MISMATCH)));
}

#[test]
fn test_guardian_set_rotation_logic() {
    let mut context = Context::default();
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, Bytes::from_static(b"lock"))
        .expect("build lock");

    let type_id = [0xAA; 32];
    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(type_id.to_vec()))
        .expect("build guardian set type");

    let old_data = GuardianSetData {
        set_index: GuardianSetIndex(1),
        quorum: 1,
        guardian_addresses: vec![GuardianAddress([0x11; 20])],
    };

    let input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(guardian_set_type_script.clone()).pack())
            .build(),
        Bytes::from(old_data.to_bytes()),
    );

    // 1. Forward rotation should succeed
    let forward_data = GuardianSetData {
        set_index: GuardianSetIndex(2),
        ..old_data.clone()
    };
    let tx_forward = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(input_out_point.clone()).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock.clone())
                .type_(Some(guardian_set_type_script.clone()).pack())
                .build(),
        )
        .output_data(Bytes::from(forward_data.to_bytes()).pack())
        .cell_dep(code_dep(&guardian_set_type_op))
        .build();
    let tx_forward = context.complete_tx(tx_forward);
    context.verify_tx(&tx_forward, MAX_CYCLES).expect("forward rotation should succeed");

    // 2. Same-index mutation should fail
    let same_data = GuardianSetData {
        quorum: 2, // mutated
        guardian_addresses: vec![GuardianAddress([0x11; 20]), GuardianAddress([0x22; 20])],
        ..old_data.clone()
    };
    let tx_same = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(input_out_point.clone()).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock.clone())
                .type_(Some(guardian_set_type_script.clone()).pack())
                .build(),
        )
        .output_data(Bytes::from(same_data.to_bytes()).pack())
        .cell_dep(code_dep(&guardian_set_type_op))
        .build();
    let tx_same = context.complete_tx(tx_same);
    let err_same = context.verify_tx(&tx_same, MAX_CYCLES).expect_err("same-index mutation should fail");
    assert!(err_same.to_string().contains(&format!("error code {}", ERROR_GUARDIAN_SET_CONTINUITY)));

    // 3. Backward rotation should fail
    let backward_data = GuardianSetData {
        set_index: GuardianSetIndex(0),
        ..old_data
    };
    let tx_backward = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(input_out_point).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock)
                .type_(Some(guardian_set_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(backward_data.to_bytes()).pack())
        .cell_dep(code_dep(&guardian_set_type_op))
        .build();
    let tx_backward = context.complete_tx(tx_backward);
    let err_backward = context.verify_tx(&tx_backward, MAX_CYCLES).expect_err("backward rotation should fail");
    assert!(err_backward.to_string().contains(&format!("error code {}", ERROR_GUARDIAN_SET_CONTINUITY)));
}

#[test]
fn test_oracle_continuity_across_guardian_rotation() {
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, Bytes::from_static(b"lock"))
        .expect("build lock");

    // --- 1. Setup Initial Guardian Set (Index 1) ---
    let type_id = [0xAA; 32];
    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(type_id.to_vec()))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    let key1 = SigningKey::from_bytes((&[1u8; 32]).into()).expect("key1");
    let addr1 = ethereum_address(key1.verifying_key());

    let guardian_data_v1 = GuardianSetData {
        set_index: GuardianSetIndex(1),
        quorum: 1,
        guardian_addresses: vec![GuardianAddress(addr1)],
    };

    let _guardian_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(guardian_set_type_script.clone()).pack())
            .build(),
        Bytes::from(guardian_data_v1.to_bytes()),
    );

    // --- 2. Setup Oracle anchored to this Lineage ---
    let feed_id = FeedId([0x77u8; 32]);
    let emitter_address = EmitterAddress([0x33u8; 32]);

    let oracle_type_script = context
        .build_script(&oracle_type_op, Bytes::from(feed_id.as_slice().to_vec()))
        .expect("build oracle type");

    let oracle_data_v0 = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: 100,
        conf: 10,
        expo: -8,
        publish_time: 1000,
        prev_publish_time: 900,
        ema_price: 100,
        ema_conf: 10,
        emitter_chain: 26,
        emitter_address,
    };

    let oracle_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(oracle_data_v0.to_bytes()),
    );

    // --- 3. Rotate Guardian Set (Index 1 -> Index 2) ---
    let key2 = SigningKey::from_bytes((&[2u8; 32]).into()).expect("key2");
    let addr2 = ethereum_address(key2.verifying_key());

    let guardian_data_v2 = GuardianSetData {
        set_index: GuardianSetIndex(2),
        quorum: 1,
        guardian_addresses: vec![GuardianAddress(addr2)],
    };

    // We "update" the guardian set cell in the mock context by creating a new one
    // and we will use it as CellDep. In a real tx, the old one is spent.
    let guardian_v2_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        Bytes::from(guardian_data_v2.to_bytes()),
    );

    // --- 4. Update Oracle using the NEW Guardian Set (Index 2) ---
    let price_message = PriceFeedMessage {
        feed_id,
        price: 200,
        conf: 20,
        expo: -8,
        publish_time: 3000,
        prev_publish_time: 2990,
        ema_price: 195,
        ema_conf: 18,
    };

    // VAA must be signed by key2 (the new guardian) and use index 2.
    let accumulator_update = build_synthetic_accumulator_update(
        &[(0, &key2)],
        GuardianSetIndex(2),
        &emitter_address,
        &price_message,
    );

    let oracle_data_v1 = OracleData {
        price: price_message.price,
        conf: price_message.conf,
        publish_time: price_message.publish_time,
        prev_publish_time: price_message.prev_publish_time,
        ema_price: price_message.ema_price,
        ema_conf: price_message.ema_conf,
        ..oracle_data_v0
    };

    let witness = OracleUpdateWitness { accumulator_update };
    let witness_args = WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(witness.to_bytes())).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(oracle_out_point).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(oracle_data_v1.to_bytes()).pack())
        .cell_dep(code_dep(&oracle_type_op))
        .cell_dep(code_dep(&guardian_set_type_op))
        .cell_dep(
            CellDep::new_builder()
                .out_point(guardian_v2_out_point)
                .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
                .build(),
        )
        .witness(witness_args.as_bytes().pack())
        .build();

    let tx = context.complete_tx(tx);
    context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("oracle update should succeed after guardian rotation");
}

fn build_synthetic_oracle_update_tx<F, G>(
    mutate_old_oracle: F,
    mutate_new_oracle: G,
) -> (
    Context,
    ckb_testtool::ckb_types::core::TransactionView,
    OracleData,
    OracleData,
)
where
    F: FnOnce(&mut OracleData),
    G: FnOnce(&mut OracleData),
{
    let mut context = Context::default();

    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let signing_key = SigningKey::from_bytes((&[1u8; 32]).into()).expect("key");
    let guardian_addr = ethereum_address(signing_key.verifying_key());

    let feed_id = FeedId([0x77u8; 32]);
    let emitter_address = EmitterAddress([0x33u8; 32]);
    let guardian_set_index = GuardianSetIndex(3u32);

    let price_message = PriceFeedMessage {
        feed_id,
        price: 1000,
        conf: 25,
        expo: -8,
        publish_time: 2000,
        prev_publish_time: 1990,
        ema_price: 995,
        ema_conf: 20,
    };

    let accumulator_update = build_synthetic_accumulator_update(
        &[(0, &signing_key)],
        guardian_set_index,
        &emitter_address,
        &price_message,
    );

    let dummy_lock = context
        .build_script(&always_success_op, Bytes::from_static(b"oracle-lock"))
        .expect("build oracle lock");
    let guardian_lock = context
        .build_script(&always_success_op, Bytes::from_static(b"guardian-lock"))
        .expect("build guardian lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(vec![0xAAu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    let guardian_set_data = GuardianSetData {
        set_index: guardian_set_index,
        quorum: 1,
        guardian_addresses: vec![GuardianAddress(guardian_addr)],
    };

    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(guardian_lock)
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );

    let oracle_type_script = context
        .build_script(&oracle_type_op, Bytes::from(feed_id.as_slice().to_vec()))
        .expect("build oracle type");

    let mut old_oracle = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: 900,
        conf: 30,
        expo: -8,
        publish_time: 1000,
        prev_publish_time: 900,
        ema_price: 895,
        ema_conf: 25,
        emitter_chain: 26,
        emitter_address,
    };
    mutate_old_oracle(&mut old_oracle);

    let mut new_oracle = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: price_message.price,
        conf: price_message.conf,
        expo: price_message.expo,
        publish_time: price_message.publish_time,
        prev_publish_time: price_message.prev_publish_time,
        ema_price: price_message.ema_price,
        ema_conf: price_message.ema_conf,
        emitter_chain: 26,
        emitter_address,
    };
    mutate_new_oracle(&mut new_oracle);

    let oracle_input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(dummy_lock.clone())
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(old_oracle.to_bytes()),
    );

    let witness = OracleUpdateWitness { accumulator_update };
    let witness_args = ckb_testtool::ckb_types::packed::WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(witness.to_bytes())).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(oracle_input_out_point)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(dummy_lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(new_oracle.to_bytes()).pack())
        .cell_dep(code_dep(&oracle_type_op))
        .cell_dep(code_dep(&guardian_set_type_op))
        .cell_dep(
            CellDep::new_builder()
                .out_point(guardian_dep_out_point)
                .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
                .build(),
        )
        .witness(witness_args.as_bytes().pack())
        .build();

    let tx = context.complete_tx(tx);
    (context, tx, old_oracle, new_oracle)
}

/// Build a synthetic Pyth accumulator-update blob whose embedded VAA is signed
/// by one or more guardian keys.
///
/// `signers` is a slice of `(guardian_index, signing_key)` pairs. Callers are
/// responsible for the order — the on-chain verifier requires signatures to
/// appear in strictly ascending guardian-index order. Pass them sorted to
/// produce a valid VAA; pass them out-of-order to deliberately exercise the
/// `ERROR_GUARDIAN_SIGNATURE_ORDER` path.
fn build_synthetic_accumulator_update(
    signers: &[(u8, &SigningKey)],
    guardian_set_index: GuardianSetIndex,
    emitter_address: &EmitterAddress,
    message: &PriceFeedMessage,
) -> Vec<u8> {
    let raw_message = encode_synthetic_price_feed_message(message);
    let root_digest = pyth_leaf_hash(&raw_message);

    let vaa_payload = {
        let mut payload = Vec::new();
        payload.extend_from_slice(&0x4155_5756u32.to_be_bytes());
        payload.push(0); // UpdateType::WormholeMerkle
        payload.extend_from_slice(&282540738u64.to_be_bytes()); // slot
        payload.extend_from_slice(&0u32.to_be_bytes()); // ring size
        payload.extend_from_slice(&root_digest);
        payload
    };

    let body = {
        let mut body = Vec::new();
        body.extend_from_slice(&1000u32.to_be_bytes()); // timestamp
        body.extend_from_slice(&7u32.to_be_bytes()); // nonce
        body.extend_from_slice(&26u16.to_be_bytes()); // emitter_chain
        body.extend_from_slice(emitter_address.as_slice());
        body.extend_from_slice(&99u64.to_be_bytes()); // sequence
        body.push(1); // consistency_level
        body.extend_from_slice(&vaa_payload);
        body
    };

    // Wormhole digests the body twice with keccak256.
    let body_digest_inner = Keccak256::digest(&body);

    let mut sig_section = Vec::new();
    sig_section.push(signers.len() as u8);
    for (guardian_index, key) in signers {
        let hash = Keccak256::new().chain_update(body_digest_inner);
        let (sig, recid) = key.sign_digest_recoverable(hash).expect("sign");
        sig_section.push(*guardian_index);
        sig_section.extend_from_slice(&sig.to_bytes());
        sig_section.push(recid.to_byte());
    }

    let vaa = {
        let mut encoded = Vec::new();
        encoded.push(1); // version
        encoded.extend_from_slice(&guardian_set_index.0.to_be_bytes());
        encoded.extend_from_slice(&sig_section);
        encoded.extend_from_slice(&body);
        encoded
    };

    let mut accumulator_update = Vec::new();
    accumulator_update.extend_from_slice(&0x504e_4155u32.to_be_bytes()); // PNAU
    accumulator_update.push(1); // major
    accumulator_update.push(0); // minor
    accumulator_update.push(0); // trailing header size
    accumulator_update.push(0); // update type WormholeMerkle
    accumulator_update.extend_from_slice(&(vaa.len() as u16).to_be_bytes());
    accumulator_update.extend_from_slice(&vaa);
    accumulator_update.push(1); // num updates
    accumulator_update.extend_from_slice(&(raw_message.len() as u16).to_be_bytes());
    accumulator_update.extend_from_slice(&raw_message);
    accumulator_update.push(0); // proof size 0 (single leaf)
    accumulator_update
}

/// Deterministically generate `n` distinct secp256k1 signing keys for tests.
/// Each key's seed is `[i+1, i+1, ..., i+1]` (32 bytes) so that the resulting
/// guardian set is stable across runs and the keys are easy to debug.
fn synthetic_guardian_keys(n: usize) -> Vec<SigningKey> {
    (0..n)
        .map(|i| {
            let seed = [(i as u8).wrapping_add(1); 32];
            SigningKey::from_bytes((&seed).into()).expect("derive synthetic guardian key")
        })
        .collect()
}

fn encode_synthetic_price_feed_message(message: &PriceFeedMessage) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(0); // MessageType::PriceFeed
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

// ---------------------------------------------------------------------------
// Oracle creation integration tests
// ---------------------------------------------------------------------------

fn build_oracle_creation_tx(
    context: &mut Context,
    oracle_type_op: &ckb_testtool::ckb_types::packed::OutPoint,
    guardian_set_type_op: &ckb_testtool::ckb_types::packed::OutPoint,
    always_success_op: &ckb_testtool::ckb_types::packed::OutPoint,
    oracle_state: &OracleData,
    guardian_dep_out_points: Vec<ckb_testtool::ckb_types::packed::OutPoint>,
    witness_opt: Option<WitnessArgs>,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let lock = context
        .build_script(always_success_op, ckb_testtool::ckb_types::bytes::Bytes::from_static(b"lock"))
        .expect("build lock");

    let feed_id = &oracle_state.feed_id;
    let oracle_type_script = context
        .build_script(oracle_type_op, ckb_testtool::ckb_types::bytes::Bytes::from(feed_id.as_slice().to_vec()))
        .expect("build oracle type");

    let mut builder = TransactionBuilder::default()
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(ckb_testtool::ckb_types::bytes::Bytes::from(oracle_state.to_bytes()).pack())
        .cell_dep(code_dep(oracle_type_op))
        .cell_dep(code_dep(guardian_set_type_op))
        .witness(
            witness_opt
                .unwrap_or_else(|| WitnessArgs::new_builder().build())
                .as_bytes()
                .pack(),
        );

    for dep in guardian_dep_out_points {
        builder = builder.cell_dep(
            CellDep::new_builder()
                .out_point(dep)
                .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
                .build(),
        );
    }

    context.complete_tx(builder.build())
}

#[test]
fn test_oracle_creation_succeeds_with_valid_guardian_dep_and_no_witness() {
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, ckb_testtool::ckb_types::bytes::Bytes::from_static(b"lock"))
        .expect("build lock");

    let guardian_set_index = GuardianSetIndex(1u32);

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, ckb_testtool::ckb_types::bytes::Bytes::from(vec![0xCCu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    let guardian_set_data = GuardianSetData {
        set_index: guardian_set_index,
        quorum: 1,
        guardian_addresses: vec![GuardianAddress([0x11u8; 20])],
    };
    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        ckb_testtool::ckb_types::bytes::Bytes::from(guardian_set_data.to_bytes()),
    );

    let feed_id = FeedId([0xAAu8; 32]);
    let emitter_address = EmitterAddress([0x55u8; 32]);

    let oracle_state = OracleData {
        feed_id,
        guardian_set_type_hash,
        // v3: creation must produce an *uninitialized* cell — all price/time
        // fields zero. Only config (feed id, guardian-set lineage, emitter) is
        // anchored here; the price is authenticated later by an update.
        price: 0,
        conf: 0,
        expo: 0,
        publish_time: 0,
        prev_publish_time: 0,
        ema_price: 0,
        ema_conf: 0,
        emitter_chain: 26,
        emitter_address,
    };

    let tx = build_oracle_creation_tx(
        &mut context,
        &oracle_type_op,
        &guardian_set_type_op,
        &always_success_op,
        &oracle_state,
        vec![guardian_dep_out_point],
        None,
    );

    context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("oracle creation should succeed with valid guardian-set dep and no witness");
}

#[test]
fn test_oracle_creation_rejects_nonzero_price_state() {
    // v3: creation does not authenticate a Pyth VAA, so the price fields are
    // caller-controlled. The script must reject any created cell whose price/time
    // state is nonzero, so that a nonzero `publish_time` provably means the cell
    // was authenticated by an update. Otherwise anyone could mint a config-matching
    // cell carrying a fabricated price and have it read as authentic over a CellDep.
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, ckb_testtool::ckb_types::bytes::Bytes::from_static(b"lock"))
        .expect("build lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, ckb_testtool::ckb_types::bytes::Bytes::from(vec![0xCCu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    let guardian_set_data = GuardianSetData {
        set_index: GuardianSetIndex(1u32),
        quorum: 1,
        guardian_addresses: vec![GuardianAddress([0x11u8; 20])],
    };
    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock)
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        ckb_testtool::ckb_types::bytes::Bytes::from(guardian_set_data.to_bytes()),
    );

    let feed_id = FeedId([0xAAu8; 32]);
    let emitter_address = EmitterAddress([0x55u8; 32]);

    // Otherwise-valid creation, but with a single nonzero price field. Even with a
    // valid guardian-set dep present, the zero-state check must reject it — and it
    // runs before guardian validation, so the error is CREATION_STATE_NONZERO.
    let oracle_state = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: 0,
        conf: 0,
        expo: 0,
        publish_time: 1, // nonzero ⇒ must be rejected at creation
        prev_publish_time: 0,
        ema_price: 0,
        ema_conf: 0,
        emitter_chain: 26,
        emitter_address,
    };

    let tx = build_oracle_creation_tx(
        &mut context,
        &oracle_type_op,
        &guardian_set_type_op,
        &always_success_op,
        &oracle_state,
        vec![guardian_dep_out_point],
        None,
    );

    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("oracle creation with nonzero price state must fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_CREATION_STATE_NONZERO)));
}

#[test]
fn test_oracle_creation_fails_without_guardian_dep() {
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, ckb_testtool::ckb_types::bytes::Bytes::from(vec![0xCCu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    let feed_id = FeedId([0xAAu8; 32]);
    let emitter_address = EmitterAddress([0x55u8; 32]);
    let oracle_state = OracleData {
        feed_id,
        guardian_set_type_hash,
        // v3: creation must produce an uninitialized (zeroed) price state.
        price: 0,
        conf: 0,
        expo: 0,
        publish_time: 0,
        prev_publish_time: 0,
        ema_price: 0,
        ema_conf: 0,
        emitter_chain: 26,
        emitter_address,
    };

    let tx = build_oracle_creation_tx(
        &mut context,
        &oracle_type_op,
        &guardian_set_type_op,
        &always_success_op,
        &oracle_state,
        vec![], // no dep
        None,
    );

    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("oracle creation without guardian-set dep must fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_GUARDIAN_SET_NOT_FOUND)));
}

#[test]
fn test_oracle_creation_fails_with_mismatched_guardian_dep() {
    // Oracle state references canonical_type_hash, but we provide a dep with
    // a different type hash. The script should fail with NOT_FOUND.
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, ckb_testtool::ckb_types::bytes::Bytes::from_static(b"lock"))
        .expect("build lock");

    let guardian_set_index = GuardianSetIndex(1u32);

    // Canonical type hash (what oracle state will reference).
    let canonical_gs_script = context
        .build_script(&guardian_set_type_op, ckb_testtool::ckb_types::bytes::Bytes::from(vec![0xCCu8; 32]))
        .expect("canonical guardian script");
    let canonical_type_hash: [u8; 32] = canonical_gs_script.calc_script_hash().unpack();

    // Spoofed type hash (what we actually provide as dep).
    let spoofed_gs_script = context
        .build_script(&guardian_set_type_op, ckb_testtool::ckb_types::bytes::Bytes::from(vec![0xDDu8; 32]))
        .expect("spoofed guardian script");

    let guardian_set_data = GuardianSetData {
        set_index: guardian_set_index,
        quorum: 1,
        guardian_addresses: vec![GuardianAddress([0x11u8; 20])],
    };
    // Provide the SPOOFED dep, not the canonical one.
    let spoofed_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock)
            .type_(Some(spoofed_gs_script).pack())
            .build(),
        ckb_testtool::ckb_types::bytes::Bytes::from(guardian_set_data.to_bytes()),
    );

    let feed_id = FeedId([0xAAu8; 32]);
    let emitter_address = EmitterAddress([0x55u8; 32]);

    // Oracle state references CANONICAL type hash but dep has SPOOFED type hash.
    let oracle_state = OracleData {
        feed_id,
        guardian_set_type_hash: canonical_type_hash,
        // v3: creation must produce an *uninitialized* cell — all price/time
        // fields zero. Only config (feed id, guardian-set lineage, emitter) is
        // anchored here; the price is authenticated later by an update.
        price: 0,
        conf: 0,
        expo: 0,
        publish_time: 0,
        prev_publish_time: 0,
        ema_price: 0,
        ema_conf: 0,
        emitter_chain: 26,
        emitter_address,
    };

    let tx = build_oracle_creation_tx(
        &mut context,
        &oracle_type_op,
        &guardian_set_type_op,
        &always_success_op,
        &oracle_state,
        vec![spoofed_dep_out_point],
        None,
    );

    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("oracle creation with mismatched guardian dep must fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_GUARDIAN_SET_NOT_FOUND)));
}

#[test]
fn test_oracle_creation_fails_if_multiple_matching_guardian_deps_exist() {
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, ckb_testtool::ckb_types::bytes::Bytes::from_static(b"lock"))
        .expect("build lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, ckb_testtool::ckb_types::bytes::Bytes::from(vec![0xCCu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    let guardian_set_data = GuardianSetData {
        set_index: GuardianSetIndex(1u32),
        quorum: 1,
        guardian_addresses: vec![GuardianAddress([0x11u8; 20])],
    };

    // Two dep cells with the same type hash: should be rejected as ambiguous.
    let dep_a = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(guardian_set_type_script.clone()).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );
    let dep_b = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );

    let feed_id = FeedId([0xAAu8; 32]);
    let emitter_address = EmitterAddress([0x55u8; 32]);
    let oracle_state = OracleData {
        feed_id,
        guardian_set_type_hash,
        // v3: creation must produce an *uninitialized* cell — all price/time
        // fields zero. Only config (feed id, guardian-set lineage, emitter) is
        // anchored here; the price is authenticated later by an update.
        price: 0,
        conf: 0,
        expo: 0,
        publish_time: 0,
        prev_publish_time: 0,
        ema_price: 0,
        ema_conf: 0,
        emitter_chain: 26,
        emitter_address,
    };

    let tx = {
        build_oracle_creation_tx(
            &mut context,
            &oracle_type_op,
            &guardian_set_type_op,
            &always_success_op,
            &oracle_state,
            vec![dep_a, dep_b],
            None,
        )
    };

    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("oracle creation with ambiguous guardian deps must fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_GUARDIAN_SET_AMBIGUOUS)));
}

#[test]
fn test_oracle_creation_fails_if_guardian_dep_data_is_malformed() {
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, ckb_testtool::ckb_types::bytes::Bytes::from_static(b"lock"))
        .expect("build lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, ckb_testtool::ckb_types::bytes::Bytes::from(vec![0xCCu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    // Malformed guardian-set bytes (too short to decode).
    let malformed_bytes = ckb_testtool::ckb_types::bytes::Bytes::from(vec![0xAB, 0xCD]);
    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock)
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        malformed_bytes,
    );

    let feed_id = FeedId([0xAAu8; 32]);
    let emitter_address = EmitterAddress([0x55u8; 32]);

    let oracle_state = OracleData {
        feed_id,
        guardian_set_type_hash,
        // v3: creation must produce an *uninitialized* cell — all price/time
        // fields zero. Only config (feed id, guardian-set lineage, emitter) is
        // anchored here; the price is authenticated later by an update.
        price: 0,
        conf: 0,
        expo: 0,
        publish_time: 0,
        prev_publish_time: 0,
        ema_price: 0,
        ema_conf: 0,
        emitter_chain: 26,
        emitter_address,
    };

    let tx = build_oracle_creation_tx(
        &mut context,
        &oracle_type_op,
        &guardian_set_type_op,
        &always_success_op,
        &oracle_state,
        vec![guardian_dep_out_point],
        None,
    );

    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("oracle creation with malformed guardian dep must fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_GUARDIAN_SET_MALFORMED)));
}

#[test]
fn test_oracle_creation_fails_if_guardian_dep_decodes_but_is_invalid() {
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let lock = context
        .build_script(&always_success_op, ckb_testtool::ckb_types::bytes::Bytes::from_static(b"lock"))
        .expect("build lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, ckb_testtool::ckb_types::bytes::Bytes::from(vec![0xCCu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    // Decodes fine but fails validate(): quorum=0 is invalid.
    let invalid_guardian_set = GuardianSetData {
        set_index: GuardianSetIndex(1u32),
        quorum: 0,
        guardian_addresses: vec![GuardianAddress([0x11u8; 20])],
    };

    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock.clone())
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        ckb_testtool::ckb_types::bytes::Bytes::from(invalid_guardian_set.to_bytes()),
    );

    let feed_id = FeedId([0xAAu8; 32]);
    let emitter_address = EmitterAddress([0x55u8; 32]);
    let oracle_state = OracleData {
        feed_id,
        guardian_set_type_hash,
        // v3: creation must produce an *uninitialized* cell — all price/time
        // fields zero. Only config (feed id, guardian-set lineage, emitter) is
        // anchored here; the price is authenticated later by an update.
        price: 0,
        conf: 0,
        expo: 0,
        publish_time: 0,
        prev_publish_time: 0,
        ema_price: 0,
        ema_conf: 0,
        emitter_chain: 26,
        emitter_address,
    };

    let tx = build_oracle_creation_tx(
        &mut context,
        &oracle_type_op,
        &guardian_set_type_op,
        &always_success_op,
        &oracle_state,
        vec![guardian_dep_out_point],
        None,
    );

    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("oracle creation with invalid guardian dep must fail");
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_GUARDIAN_SET_INVALID)));
}

fn load_oracle_type(context: &mut Context) -> ckb_testtool::ckb_types::packed::OutPoint {
    let bin = std::fs::read("../target/riscv64imac-unknown-none-elf/release/oracle_type")
        .expect("missing oracle_type binary; build with cargo build -p oracle_script --release --target riscv64imac-unknown-none-elf");
    context.deploy_cell(bin.into())
}

fn load_guardian_set_type(context: &mut Context) -> ckb_testtool::ckb_types::packed::OutPoint {
    let bin = std::fs::read("../target/riscv64imac-unknown-none-elf/release/guardian_set_type")
        .expect("missing guardian_set_type binary; build with cargo build -p guardian_set_script --release --target riscv64imac-unknown-none-elf");
    context.deploy_cell(bin.into())
}

fn deploy_always_success(context: &mut Context) -> ckb_testtool::ckb_types::packed::OutPoint {
    context.deploy_cell(Bytes::from(ckb_testtool::builtin::ALWAYS_SUCCESS.to_vec()))
}

fn code_dep(op: &ckb_testtool::ckb_types::packed::OutPoint) -> CellDep {
    CellDep::new_builder()
        .out_point(op.clone())
        .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
        .build()
}

fn build_real_oracle_update_tx<F, G, H>(
    mutate_guardian_set: F,
    mutate_new_oracle: G,
    mutate_old_oracle: H,
) -> (Context, ckb_testtool::ckb_types::core::TransactionView)
where
    F: FnOnce(&mut GuardianSetData),
    G: FnOnce(&mut OracleData),
    H: FnOnce(&mut OracleData),
{
    let mut context = Context::default();

    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let feed_id = FeedId(decode_hex_32(BTC_USD_FEED_ID_HEX).expect("decode feed id"));
    let emitter_address = EmitterAddress(decode_hex_32(
        "e101faedac5851e32b9b23b5f9411a8c2bac4aae3ed4dd7b811dd1a72ea4aa71",
    )
    .expect("decode emitter address"));
    let accumulator_update =
        decode_hex(REAL_HERMES_ACCUMULATOR_HEX).expect("decode accumulator hex");

    let dummy_lock = context
        .build_script(&always_success_op, Bytes::from_static(b"oracle-lock"))
        .expect("build oracle lock");
    let guardian_lock = context
        .build_script(&always_success_op, Bytes::from_static(b"guardian-lock"))
        .expect("build guardian lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(vec![0xAAu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    let mut guardian_set_data = GuardianSetData {
        set_index: GuardianSetIndex(REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX),
        quorum: 13,
        guardian_addresses: REAL_GUARDIAN_SET
            .iter()
            .map(|a| GuardianAddress(decode_hex_20(a).expect("decode guardian hex")))
            .collect(),
    };
    mutate_guardian_set(&mut guardian_set_data);

    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(guardian_lock)
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );

    let oracle_type_script = context
        .build_script(&oracle_type_op, Bytes::from(feed_id.as_slice().to_vec()))
        .expect("build oracle type");

    let mut old_oracle = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: 7_820_000_000_000,
        conf: 2_500_000_000,
        expo: REAL_HERMES_EXPECTED_EXPO,
        publish_time: REAL_HERMES_EXPECTED_PUBLISH_TIME - 1,
        prev_publish_time: REAL_HERMES_EXPECTED_PUBLISH_TIME - 2,
        ema_price: 7_819_000_000_000,
        ema_conf: 2_500_000_000,
        emitter_chain: 26,
        emitter_address,
    };
    mutate_old_oracle(&mut old_oracle);

    let mut new_oracle = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: REAL_HERMES_EXPECTED_PRICE,
        conf: REAL_HERMES_EXPECTED_CONF,
        expo: REAL_HERMES_EXPECTED_EXPO,
        publish_time: REAL_HERMES_EXPECTED_PUBLISH_TIME,
        prev_publish_time: REAL_HERMES_EXPECTED_PREV_PUBLISH_TIME,
        ema_price: REAL_HERMES_EXPECTED_EMA_PRICE,
        ema_conf: REAL_HERMES_EXPECTED_EMA_CONF,
        emitter_chain: 26,
        emitter_address,
    };
    mutate_new_oracle(&mut new_oracle);

    let oracle_input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(dummy_lock.clone())
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(old_oracle.to_bytes()),
    );

    let witness = OracleUpdateWitness { accumulator_update };
    let witness_args = ckb_testtool::ckb_types::packed::WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(witness.to_bytes())).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(oracle_input_out_point)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(dummy_lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(new_oracle.to_bytes()).pack())
        .cell_dep(code_dep(&oracle_type_op))
        .cell_dep(code_dep(&guardian_set_type_op))
        .cell_dep(
            CellDep::new_builder()
                .out_point(guardian_dep_out_point)
                .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
                .build(),
        )
        .witness(witness_args.as_bytes().pack())
        .build();

    let tx = context.complete_tx(tx);
    (context, tx)
}

// ─────────────────────────────────────────────────────────────────────────────
//  Burn-path tests (group shape `(1, 0)`)
//
//  The oracle script's burn path returns success without reading data or
//  witnesses; authorization is delegated to the lock. These tests cover the
//  shape-acceptance contract directly, complementing the lock-side tests in
//  `owned_type_bind_lock_tests.rs`.
// ─────────────────────────────────────────────────────────────────────────────

fn make_burnable_oracle_cell(
    context: &mut Context,
    oracle_type_op: &ckb_testtool::ckb_types::packed::OutPoint,
    always_op: &ckb_testtool::ckb_types::packed::OutPoint,
    feed_id_byte: u8,
) -> (
    ckb_testtool::ckb_types::packed::OutPoint,
    ckb_testtool::ckb_types::packed::Script,
) {
    let lock = context
        .build_script(always_op, Bytes::from_static(b"burn-lock"))
        .expect("build burn lock");
    let oracle_type_script = context
        .build_script(
            oracle_type_op,
            Bytes::from(vec![feed_id_byte; 32]),
        )
        .expect("build oracle type");

    // Burn does not decode data; any structurally valid 152-byte payload works.
    let data = OracleData {
        feed_id: FeedId([feed_id_byte; 32]),
        guardian_set_type_hash: [0u8; 32],
        price: 1,
        conf: 1,
        expo: 0,
        publish_time: 1,
        prev_publish_time: 0,
        ema_price: 1,
        ema_conf: 1,
        emitter_chain: 26,
        emitter_address: EmitterAddress([0u8; 32]),
    };

    let out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(lock)
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(data.to_bytes()),
    );
    (out_point, oracle_type_script)
}

#[test]
fn test_oracle_burn_path_accepts_one_input_zero_outputs() {
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let always_op = deploy_always_success(&mut context);

    let (oracle_input_op, _) =
        make_burnable_oracle_cell(&mut context, &oracle_type_op, &always_op, 0x88);

    // One input (oracle, type=oracle_type), no oracle-typed outputs. A plain
    // change cell collects the returned capacity.
    let change_lock = context
        .build_script(&always_op, Bytes::from_static(b"change"))
        .expect("build change lock");

    let tx = TransactionBuilder::default()
        .cell_deps(vec![code_dep(&oracle_type_op), code_dep(&always_op)])
        .input(
            CellInput::new_builder()
                .previous_output(oracle_input_op)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(99_000_000_000u64)
                .lock(change_lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();

    let tx = context.complete_tx(tx);
    context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("burn (1, 0) group should verify");
}

#[test]
fn test_oracle_burn_path_rejects_two_input_zero_outputs() {
    // Two oracle cells under the *same* type script (same feed id) burned in
    // one tx produces group shape (2, 0), which the oracle script rejects with
    // ERROR_INVALID_SCRIPT_GROUP. This guards the script-group fall-through
    // arm against multi-cell-burn drift.
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let always_op = deploy_always_success(&mut context);

    let (oracle_a_op, _) =
        make_burnable_oracle_cell(&mut context, &oracle_type_op, &always_op, 0x99);
    let (oracle_b_op, _) =
        make_burnable_oracle_cell(&mut context, &oracle_type_op, &always_op, 0x99);

    let change_lock = context
        .build_script(&always_op, Bytes::from_static(b"change"))
        .expect("build change lock");

    let tx = TransactionBuilder::default()
        .cell_deps(vec![code_dep(&oracle_type_op), code_dep(&always_op)])
        .input(CellInput::new_builder().previous_output(oracle_a_op).build())
        .input(CellInput::new_builder().previous_output(oracle_b_op).build())
        .output(
            CellOutput::new_builder()
                .capacity(199_000_000_000u64)
                .lock(change_lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();

    let tx = context.complete_tx(tx);
    let err = context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("(2, 0) group shape should be rejected");
    assert!(
        err.to_string()
            .contains(&format!("error code {}", ERROR_INVALID_SCRIPT_GROUP)),
        "expected ERROR_INVALID_SCRIPT_GROUP ({}), got: {}",
        ERROR_INVALID_SCRIPT_GROUP,
        err,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Multi-feed update in a single transaction
//
//  Two oracle cells keyed to *different* feed-ids are updated in the same tx.
//  Each oracle-type script group must see shape (1, 1) independently and
//  validate against its own price-feed message — this guards the per-group
//  isolation that the contract's group-shape match relies on.
// ─────────────────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn build_multi_feed_update_tx() -> (Context, ckb_testtool::ckb_types::core::TransactionView) {
    let mut context = Context::default();

    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_op = deploy_always_success(&mut context);

    let signing_key = SigningKey::from_bytes((&[1u8; 32]).into()).expect("key");
    let guardian_addr = ethereum_address(signing_key.verifying_key());
    let guardian_set_index = GuardianSetIndex(3u32);
    let emitter_address = EmitterAddress([0x33u8; 32]);

    let feed_a = FeedId([0xA0u8; 32]);
    let feed_b = FeedId([0xB0u8; 32]);

    let msg_a = PriceFeedMessage {
        feed_id: feed_a,
        price: 1_000,
        conf: 10,
        expo: -8,
        publish_time: 2_000,
        prev_publish_time: 1_990,
        ema_price: 999,
        ema_conf: 9,
    };
    let msg_b = PriceFeedMessage {
        feed_id: feed_b,
        price: 7_500,
        conf: 50,
        expo: -8,
        publish_time: 2_500,
        prev_publish_time: 2_480,
        ema_price: 7_490,
        ema_conf: 45,
    };

    let accum_a = build_synthetic_accumulator_update(
        &[(0, &signing_key)],
        guardian_set_index,
        &emitter_address,
        &msg_a,
    );
    let accum_b = build_synthetic_accumulator_update(
        &[(0, &signing_key)],
        guardian_set_index,
        &emitter_address,
        &msg_b,
    );

    let dummy_lock = context
        .build_script(&always_op, Bytes::from_static(b"oracle-lock"))
        .expect("build oracle lock");
    let guardian_lock = context
        .build_script(&always_op, Bytes::from_static(b"guardian-lock"))
        .expect("build guardian lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(vec![0xAAu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] =
        guardian_set_type_script.calc_script_hash().unpack();

    let guardian_set_data = GuardianSetData {
        set_index: guardian_set_index,
        quorum: 1,
        guardian_addresses: vec![GuardianAddress(guardian_addr)],
    };

    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(guardian_lock)
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );

    let oracle_type_a = context
        .build_script(&oracle_type_op, Bytes::from(feed_a.as_slice().to_vec()))
        .expect("build oracle type A");
    let oracle_type_b = context
        .build_script(&oracle_type_op, Bytes::from(feed_b.as_slice().to_vec()))
        .expect("build oracle type B");

    let old_a = OracleData {
        feed_id: feed_a,
        guardian_set_type_hash,
        price: 0,
        conf: 0,
        expo: -8,
        publish_time: 1_000,
        prev_publish_time: 999,
        ema_price: 0,
        ema_conf: 0,
        emitter_chain: 26,
        emitter_address,
    };
    let new_a = OracleData {
        feed_id: feed_a,
        guardian_set_type_hash,
        price: msg_a.price,
        conf: msg_a.conf,
        expo: msg_a.expo,
        publish_time: msg_a.publish_time,
        prev_publish_time: msg_a.prev_publish_time,
        ema_price: msg_a.ema_price,
        ema_conf: msg_a.ema_conf,
        emitter_chain: 26,
        emitter_address,
    };
    let old_b = OracleData {
        feed_id: feed_b,
        guardian_set_type_hash,
        price: 0,
        conf: 0,
        expo: -8,
        publish_time: 1_500,
        prev_publish_time: 1_499,
        ema_price: 0,
        ema_conf: 0,
        emitter_chain: 26,
        emitter_address,
    };
    let new_b = OracleData {
        feed_id: feed_b,
        guardian_set_type_hash,
        price: msg_b.price,
        conf: msg_b.conf,
        expo: msg_b.expo,
        publish_time: msg_b.publish_time,
        prev_publish_time: msg_b.prev_publish_time,
        ema_price: msg_b.ema_price,
        ema_conf: msg_b.ema_conf,
        emitter_chain: 26,
        emitter_address,
    };

    let input_a = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(dummy_lock.clone())
            .type_(Some(oracle_type_a.clone()).pack())
            .build(),
        Bytes::from(old_a.to_bytes()),
    );
    let input_b = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(dummy_lock.clone())
            .type_(Some(oracle_type_b.clone()).pack())
            .build(),
        Bytes::from(old_b.to_bytes()),
    );

    let witness_a = OracleUpdateWitness {
        accumulator_update: accum_a,
    };
    let witness_b = OracleUpdateWitness {
        accumulator_update: accum_b,
    };
    let witness_args_a = WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(witness_a.to_bytes())).pack())
        .build();
    let witness_args_b = WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(witness_b.to_bytes())).pack())
        .build();

    // Input/witness alignment: input N's group sees its first GroupInput's
    // witness at tx-witness index N. Order matters here.
    let tx = TransactionBuilder::default()
        .cell_deps(vec![
            code_dep(&oracle_type_op),
            code_dep(&guardian_set_type_op),
            CellDep::new_builder()
                .out_point(guardian_dep_out_point)
                .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
                .build(),
        ])
        .input(CellInput::new_builder().previous_output(input_a).build())
        .input(CellInput::new_builder().previous_output(input_b).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(dummy_lock.clone())
                .type_(Some(oracle_type_a).pack())
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(dummy_lock)
                .type_(Some(oracle_type_b).pack())
                .build(),
        )
        .output_data(Bytes::from(new_a.to_bytes()).pack())
        .output_data(Bytes::from(new_b.to_bytes()).pack())
        .witness(witness_args_a.as_bytes().pack())
        .witness(witness_args_b.as_bytes().pack())
        .build();

    let tx = context.complete_tx(tx);
    (context, tx)
}

#[test]
fn test_multi_feed_update_in_single_tx_succeeds() {
    let (context, tx) = build_multi_feed_update_tx();
    context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("two-feed update should verify");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Multi-signer Wormhole VAA tests — quorum + signature ordering + identity
//
//  These exercise `verify_guardian_quorum` against an N-key guardian set with
//  an arbitrary signer subset. They guard the four signature-side failure
//  codes (21 / 22 / 23) and the positive `=quorum` boundary.
// ─────────────────────────────────────────────────────────────────────────────

/// Build an oracle-update tx whose VAA is signed by an arbitrary subset of
/// guardians from a synthetic N-key set.
///
/// - `guardian_keys` is the full guardian set (becomes the on-chain
///   `GuardianSetData.guardian_addresses` at the matching indices).
/// - `quorum` is set in `GuardianSetData.quorum`.
/// - `signers` is the slice of `(guardian_index, &SigningKey)` pairs that
///   sign the VAA, **in the exact order** they should appear in the wire
///   format. Pass them sorted ascending for the happy path; pass them
///   unsorted to trigger `ERROR_GUARDIAN_SIGNATURE_ORDER`.
fn build_multi_signer_update_tx(
    guardian_keys: &[SigningKey],
    quorum: u32,
    signers: &[(u8, &SigningKey)],
) -> (Context, ckb_testtool::ckb_types::core::TransactionView) {
    let mut context = Context::default();

    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_op = deploy_always_success(&mut context);

    let feed_id = FeedId([0x77u8; 32]);
    let emitter_address = EmitterAddress([0x33u8; 32]);
    let guardian_set_index = GuardianSetIndex(3u32);

    let price_message = PriceFeedMessage {
        feed_id,
        price: 1000,
        conf: 25,
        expo: -8,
        publish_time: 2000,
        prev_publish_time: 1990,
        ema_price: 995,
        ema_conf: 20,
    };

    let accumulator_update = build_synthetic_accumulator_update(
        signers,
        guardian_set_index,
        &emitter_address,
        &price_message,
    );

    let dummy_lock = context
        .build_script(&always_op, Bytes::from_static(b"oracle-lock"))
        .expect("build oracle lock");
    let guardian_lock = context
        .build_script(&always_op, Bytes::from_static(b"guardian-lock"))
        .expect("build guardian lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(vec![0xAAu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    let guardian_set_data = GuardianSetData {
        set_index: guardian_set_index,
        quorum,
        guardian_addresses: guardian_keys
            .iter()
            .map(|k| GuardianAddress(ethereum_address(k.verifying_key())))
            .collect(),
    };

    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(guardian_lock)
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );

    let oracle_type_script = context
        .build_script(&oracle_type_op, Bytes::from(feed_id.as_slice().to_vec()))
        .expect("build oracle type");

    let old_oracle = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: 900,
        conf: 30,
        expo: -8,
        publish_time: 1000,
        prev_publish_time: 900,
        ema_price: 895,
        ema_conf: 25,
        emitter_chain: 26,
        emitter_address,
    };
    let new_oracle = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: price_message.price,
        conf: price_message.conf,
        expo: price_message.expo,
        publish_time: price_message.publish_time,
        prev_publish_time: price_message.prev_publish_time,
        ema_price: price_message.ema_price,
        ema_conf: price_message.ema_conf,
        emitter_chain: 26,
        emitter_address,
    };

    let oracle_input_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(dummy_lock.clone())
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(old_oracle.to_bytes()),
    );

    let witness = OracleUpdateWitness { accumulator_update };
    let witness_args = WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(witness.to_bytes())).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(
            CellInput::new_builder()
                .previous_output(oracle_input_out_point)
                .build(),
        )
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(dummy_lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(new_oracle.to_bytes()).pack())
        .cell_dep(code_dep(&oracle_type_op))
        .cell_dep(code_dep(&guardian_set_type_op))
        .cell_dep(
            CellDep::new_builder()
                .out_point(guardian_dep_out_point)
                .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
                .build(),
        )
        .witness(witness_args.as_bytes().pack())
        .build();

    let tx = context.complete_tx(tx);
    (context, tx)
}

/// Quorum=13 / N=19 (mainnet-shaped). Exactly 13 distinct signers, indices
/// 0..=12, ascending. Must verify.
#[test]
fn test_quorum_boundary_accepts_exactly_threshold_signatures() {
    let keys = synthetic_guardian_keys(19);
    let signers: Vec<(u8, &SigningKey)> = (0u8..13).map(|i| (i, &keys[i as usize])).collect();

    let (context, tx) = build_multi_signer_update_tx(&keys, 13, &signers);
    context
        .verify_tx(&tx, MULTI_SIG_MAX_CYCLES)
        .expect("=quorum signatures should verify");
}

/// Quorum=13 / N=19 but only 12 signatures provided. Must reject with
/// `ERROR_GUARDIAN_QUORUM_NOT_MET` (21).
#[test]
fn test_quorum_boundary_rejects_one_below_threshold() {
    let keys = synthetic_guardian_keys(19);
    let signers: Vec<(u8, &SigningKey)> = (0u8..12).map(|i| (i, &keys[i as usize])).collect();

    let (context, tx) = build_multi_signer_update_tx(&keys, 13, &signers);
    let err = context
        .verify_tx(&tx, MULTI_SIG_MAX_CYCLES)
        .expect_err("(quorum-1) signatures should fail");
    assert!(
        err.to_string()
            .contains(&format!("error code {}", ERROR_GUARDIAN_QUORUM_NOT_MET)),
        "expected ERROR_GUARDIAN_QUORUM_NOT_MET ({}), got: {}",
        ERROR_GUARDIAN_QUORUM_NOT_MET,
        err,
    );
}

/// 13 valid signatures but the index sequence is not strictly ascending —
/// indices 0..=12 with the last two swapped. Must reject with
/// `ERROR_GUARDIAN_SIGNATURE_ORDER` (23).
#[test]
fn test_signature_order_rejects_non_ascending_indices() {
    let keys = synthetic_guardian_keys(19);
    let mut signers: Vec<(u8, &SigningKey)> =
        (0u8..13).map(|i| (i, &keys[i as usize])).collect();
    // Swap the last two so indices go ... 10, 12, 11
    let last = signers.len() - 1;
    signers.swap(last, last - 1);

    let (context, tx) = build_multi_signer_update_tx(&keys, 13, &signers);
    let err = context
        .verify_tx(&tx, MULTI_SIG_MAX_CYCLES)
        .expect_err("non-ascending guardian indices should fail");
    assert!(
        err.to_string()
            .contains(&format!("error code {}", ERROR_GUARDIAN_SIGNATURE_ORDER)),
        "expected ERROR_GUARDIAN_SIGNATURE_ORDER ({}), got: {}",
        ERROR_GUARDIAN_SIGNATURE_ORDER,
        err,
    );
}

/// 13 ascending signatures but one of them comes from a key that is NOT in
/// the on-chain guardian set (a 20th, unregistered key signing at index 12).
/// The verifier should recover an address that does not match the registered
/// guardian at that index and fail with `ERROR_GUARDIAN_SIGNATURE_INVALID`
/// (22).
#[test]
fn test_signature_identity_rejects_unregistered_signer() {
    let registered = synthetic_guardian_keys(19);
    let imposter = SigningKey::from_bytes((&[0xEEu8; 32]).into()).expect("imposter key");

    // First 12 from the registered set, then the imposter claiming index 12.
    let mut signers: Vec<(u8, &SigningKey)> =
        (0u8..12).map(|i| (i, &registered[i as usize])).collect();
    signers.push((12u8, &imposter));

    let (context, tx) = build_multi_signer_update_tx(&registered, 13, &signers);
    let err = context
        .verify_tx(&tx, MULTI_SIG_MAX_CYCLES)
        .expect_err("unregistered signer should fail");
    assert!(
        err.to_string()
            .contains(&format!("error code {}", ERROR_GUARDIAN_SIGNATURE_INVALID)),
        "expected ERROR_GUARDIAN_SIGNATURE_INVALID ({}), got: {}",
        ERROR_GUARDIAN_SIGNATURE_INVALID,
        err,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Multi-leaf accumulator test
//
//  Production Hermes blobs commonly batch many price-feed messages into one
//  signed accumulator. Each on-chain update only consumes the message matching
//  its own feed-id, but the parser still verifies merkle proofs for every
//  message it encounters. The existing synthetic tests use proof-size 0
//  (single-leaf), so the proof-folding code path in `verify_pyth_merkle_proof`
//  is otherwise unexercised at the integration level.
// ─────────────────────────────────────────────────────────────────────────────

/// Build a synthetic accumulator update whose body batches `messages.len()`
/// price-feed messages into a 2-leaf merkle tree. The signed root commits to
/// both leaves; each message is accompanied by its sibling-only proof.
///
/// Precondition: `messages.len() == 2`. The intent is to exercise the
/// `proof_size > 0` path of the on-chain accumulator parser; larger trees
/// share the same structure and can be added as needed.
fn build_two_leaf_accumulator_update(
    signers: &[(u8, &SigningKey)],
    guardian_set_index: GuardianSetIndex,
    emitter_address: &EmitterAddress,
    messages: &[PriceFeedMessage; 2],
) -> Vec<u8> {
    let raw_messages: Vec<Vec<u8>> = messages
        .iter()
        .map(encode_synthetic_price_feed_message)
        .collect();
    let leaves: [[u8; 20]; 2] = [
        pyth_leaf_hash(&raw_messages[0]),
        pyth_leaf_hash(&raw_messages[1]),
    ];
    let root = pyth_node_hash(leaves[0], leaves[1]);
    // For a 2-leaf tree, each leaf's proof is just the opposite sibling.
    let proofs: [Vec<[u8; 20]>; 2] = [vec![leaves[1]], vec![leaves[0]]];

    let vaa_payload = {
        let mut payload = Vec::new();
        payload.extend_from_slice(&0x4155_5756u32.to_be_bytes());
        payload.push(0); // UpdateType::WormholeMerkle
        payload.extend_from_slice(&282540738u64.to_be_bytes());
        payload.extend_from_slice(&0u32.to_be_bytes());
        payload.extend_from_slice(&root);
        payload
    };

    let body = {
        let mut body = Vec::new();
        body.extend_from_slice(&1000u32.to_be_bytes());
        body.extend_from_slice(&7u32.to_be_bytes());
        body.extend_from_slice(&26u16.to_be_bytes());
        body.extend_from_slice(emitter_address.as_slice());
        body.extend_from_slice(&99u64.to_be_bytes());
        body.push(1);
        body.extend_from_slice(&vaa_payload);
        body
    };

    let body_digest_inner = Keccak256::digest(&body);
    let mut sig_section = Vec::new();
    sig_section.push(signers.len() as u8);
    for (gi, key) in signers {
        let h = Keccak256::new().chain_update(body_digest_inner);
        let (sig, recid) = key.sign_digest_recoverable(h).expect("sign");
        sig_section.push(*gi);
        sig_section.extend_from_slice(&sig.to_bytes());
        sig_section.push(recid.to_byte());
    }

    let vaa = {
        let mut v = Vec::new();
        v.push(1);
        v.extend_from_slice(&guardian_set_index.0.to_be_bytes());
        v.extend_from_slice(&sig_section);
        v.extend_from_slice(&body);
        v
    };

    let mut accumulator_update = Vec::new();
    accumulator_update.extend_from_slice(&0x504e_4155u32.to_be_bytes()); // PNAU
    accumulator_update.push(1); // major
    accumulator_update.push(0); // minor
    accumulator_update.push(0); // trailing header size
    accumulator_update.push(0); // update type WormholeMerkle
    accumulator_update.extend_from_slice(&(vaa.len() as u16).to_be_bytes());
    accumulator_update.extend_from_slice(&vaa);
    // num_updates = 2; per-update body = [msg_len][msg][proof_size][proof_items]
    accumulator_update.push(2);
    for i in 0..2 {
        accumulator_update.extend_from_slice(&(raw_messages[i].len() as u16).to_be_bytes());
        accumulator_update.extend_from_slice(&raw_messages[i]);
        accumulator_update.push(proofs[i].len() as u8);
        for sibling in &proofs[i] {
            accumulator_update.extend_from_slice(sibling);
        }
    }
    accumulator_update
}

#[test]
fn test_multi_leaf_accumulator_update_succeeds() {
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_op = deploy_always_success(&mut context);

    let signing_key = SigningKey::from_bytes((&[1u8; 32]).into()).expect("key");
    let guardian_addr = ethereum_address(signing_key.verifying_key());
    let guardian_set_index = GuardianSetIndex(3u32);
    let emitter_address = EmitterAddress([0x33u8; 32]);
    let target_feed = FeedId([0xC0u8; 32]);
    let other_feed = FeedId([0xD0u8; 32]);

    let target_message = PriceFeedMessage {
        feed_id: target_feed,
        price: 2_500,
        conf: 20,
        expo: -8,
        publish_time: 3_000,
        prev_publish_time: 2_990,
        ema_price: 2_499,
        ema_conf: 19,
    };
    let other_message = PriceFeedMessage {
        feed_id: other_feed,
        price: 9_999,
        conf: 50,
        expo: -8,
        publish_time: 3_001,
        prev_publish_time: 2_995,
        ema_price: 9_998,
        ema_conf: 49,
    };

    let accumulator_update = build_two_leaf_accumulator_update(
        &[(0, &signing_key)],
        guardian_set_index,
        &emitter_address,
        &[target_message.clone(), other_message],
    );

    let dummy_lock = context
        .build_script(&always_op, Bytes::from_static(b"oracle-lock"))
        .expect("build oracle lock");
    let guardian_lock = context
        .build_script(&always_op, Bytes::from_static(b"guardian-lock"))
        .expect("build guardian lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(vec![0xAAu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] =
        guardian_set_type_script.calc_script_hash().unpack();

    let guardian_set_data = GuardianSetData {
        set_index: guardian_set_index,
        quorum: 1,
        guardian_addresses: vec![GuardianAddress(guardian_addr)],
    };

    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(guardian_lock)
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );

    let oracle_type_script = context
        .build_script(
            &oracle_type_op,
            Bytes::from(target_feed.as_slice().to_vec()),
        )
        .expect("build oracle type");

    let old_oracle = OracleData {
        feed_id: target_feed,
        guardian_set_type_hash,
        price: 900,
        conf: 30,
        expo: -8,
        publish_time: 2_000,
        prev_publish_time: 1_990,
        ema_price: 895,
        ema_conf: 25,
        emitter_chain: 26,
        emitter_address,
    };
    let new_oracle = OracleData {
        feed_id: target_feed,
        guardian_set_type_hash,
        price: target_message.price,
        conf: target_message.conf,
        expo: target_message.expo,
        publish_time: target_message.publish_time,
        prev_publish_time: target_message.prev_publish_time,
        ema_price: target_message.ema_price,
        ema_conf: target_message.ema_conf,
        emitter_chain: 26,
        emitter_address,
    };

    let oracle_input = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(dummy_lock.clone())
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(old_oracle.to_bytes()),
    );

    let witness = OracleUpdateWitness { accumulator_update };
    let witness_args = WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(witness.to_bytes())).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(oracle_input).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(dummy_lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(new_oracle.to_bytes()).pack())
        .cell_dep(code_dep(&oracle_type_op))
        .cell_dep(code_dep(&guardian_set_type_op))
        .cell_dep(
            CellDep::new_builder()
                .out_point(guardian_dep_out_point)
                .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
                .build(),
        )
        .witness(witness_args.as_bytes().pack())
        .build();

    let tx = context.complete_tx(tx);
    context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("two-leaf accumulator update should verify");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cycle-budget regression
//
//  A canonical 13-of-19 mainnet-shaped oracle update should comfortably fit
//  inside ~150M cycles. If a future change to k256, merkle, oracle_data, or
//  any of the parsers pushes cycle consumption above this ceiling, this test
//  fires — well before the regression reaches the ~10^9 block-cycle limit.
//
//  The ceiling is intentionally loose (~2x current observed): tight enough to
//  catch real regressions, loose enough to absorb minor codegen drift.
// ─────────────────────────────────────────────────────────────────────────────

/// Upper bound on cycles for a quorum-13/N-19 oracle update. Observed at
/// time of writing: ~104M (synthetic single-leaf accumulator, 13 secp
/// recoveries). The 150M ceiling leaves ~45% headroom; a real regression
/// (an unintended secp recovery, an extra hash, codegen drift) will exceed
/// it long before reaching the chain's per-tx limit.
const CANONICAL_UPDATE_CYCLE_CEILING: u64 = 150_000_000;

#[test]
fn test_canonical_update_stays_within_cycle_budget() {
    let keys = synthetic_guardian_keys(19);
    let signers: Vec<(u8, &SigningKey)> =
        (0u8..13).map(|i| (i, &keys[i as usize])).collect();

    let (context, tx) = build_multi_signer_update_tx(&keys, 13, &signers);
    let cycles = context
        .verify_tx(&tx, MULTI_SIG_MAX_CYCLES)
        .expect("canonical 13/19 update must verify");

    assert!(
        cycles <= CANONICAL_UPDATE_CYCLE_CEILING,
        "13/19 update consumed {} cycles, exceeding ceiling of {}. \
         If this is an intentional perf change, raise CANONICAL_UPDATE_CYCLE_CEILING; \
         otherwise investigate the regression.",
        cycles,
        CANONICAL_UPDATE_CYCLE_CEILING,
    );

    // Sanity floor: a real update must consume non-trivial cycles. If this
    // fires it means the test setup degenerated (e.g. signature verification
    // got short-circuited away), not a perf win.
    assert!(
        cycles >= 10_000_000,
        "13/19 update consumed only {} cycles — suspiciously low",
        cycles,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Signature malleability — high-S rejection
//
//  secp256k1 ECDSA signatures admit two valid `s` values for any signed
//  digest: the canonical "low-S" form and its complement `n - s` ("high-S").
//  Ethereum / Wormhole both *require* low-S; accepting high-S enables
//  transaction-id malleability and cross-chain replay vectors.
//
//  These tests negate the `s` half of one signature in an otherwise-valid
//  13/19 VAA and assert the on-chain verifier rejects it.
// ─────────────────────────────────────────────────────────────────────────────

/// Compute `n - s` where `n` is the secp256k1 group order. Used to flip a
/// canonical low-S signature into its high-S complement.
fn negate_secp256k1_s(s_bytes: &[u8; 32]) -> [u8; 32] {
    // secp256k1 group order n (big-endian).
    const N: [u8; 32] = [
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xFE, 0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36,
        0x41, 0x41,
    ];
    // n - s via schoolbook subtraction in big-endian.
    let mut out = [0u8; 32];
    let mut borrow: i32 = 0;
    for i in (0..32).rev() {
        let lhs = N[i] as i32;
        let rhs = s_bytes[i] as i32 + borrow;
        let diff = lhs - rhs;
        if diff < 0 {
            out[i] = (diff + 256) as u8;
            borrow = 1;
        } else {
            out[i] = diff as u8;
            borrow = 0;
        }
    }
    assert_eq!(borrow, 0, "s must be strictly less than n");
    out
}

/// Locate and mutate the first guardian signature inside a synthetic
/// accumulator-update blob produced by `build_synthetic_accumulator_update`.
///
/// Wire layout in that blob, starting from byte 0:
///   PNAU magic (4) + major (1) + minor (1) + trailing_header (1)
///   + update_type (1) + vaa_len (2)
///   = 10 bytes of preamble
///   VAA body begins at offset 10:
///   version (1) + guardian_set_index (4) + sig_count (1) = 6 bytes header
///   per-signature record (66 bytes): guardian_index (1) + r (32) + s (32) + recid (1)
///
/// So the first signature's `s` half occupies bytes
/// `10 + 6 + 1 + 32` .. `10 + 6 + 1 + 32 + 32` = offsets 49..81.
fn flip_first_signature_s(blob: &mut [u8]) {
    let s_start = 10 + 6 + 1 + 32;
    let s_end = s_start + 32;
    let mut s_bytes = [0u8; 32];
    s_bytes.copy_from_slice(&blob[s_start..s_end]);
    let flipped = negate_secp256k1_s(&s_bytes);
    blob[s_start..s_end].copy_from_slice(&flipped);
}

#[test]
fn test_signature_malleability_rejects_high_s_form() {
    // Build a canonical 13/19 update, then flip the first signature's `s`
    // half to its complement (`n - s`). The verifier must reject — either
    // because k256's `Signature::from_slice` rejects high-S outright, or
    // because the recovered address no longer matches the registered
    // guardian.
    let keys = synthetic_guardian_keys(19);
    let signers: Vec<(u8, &SigningKey)> =
        (0u8..13).map(|i| (i, &keys[i as usize])).collect();

    // We need direct access to the witness bytes so we can patch them after
    // signing. Reuse `build_synthetic_accumulator_update` directly rather
    // than going through `build_multi_signer_update_tx`, so the tampering
    // happens before the tx is sealed.
    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_op = deploy_always_success(&mut context);

    let feed_id = FeedId([0x77u8; 32]);
    let emitter_address = EmitterAddress([0x33u8; 32]);
    let guardian_set_index = GuardianSetIndex(3u32);
    let price_message = PriceFeedMessage {
        feed_id,
        price: 1000,
        conf: 25,
        expo: -8,
        publish_time: 2000,
        prev_publish_time: 1990,
        ema_price: 995,
        ema_conf: 20,
    };

    let mut accumulator_update = build_synthetic_accumulator_update(
        &signers,
        guardian_set_index,
        &emitter_address,
        &price_message,
    );
    flip_first_signature_s(&mut accumulator_update);

    let dummy_lock = context
        .build_script(&always_op, Bytes::from_static(b"oracle-lock"))
        .expect("build oracle lock");
    let guardian_lock = context
        .build_script(&always_op, Bytes::from_static(b"guardian-lock"))
        .expect("build guardian lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(vec![0xAAu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] =
        guardian_set_type_script.calc_script_hash().unpack();

    let guardian_set_data = GuardianSetData {
        set_index: guardian_set_index,
        quorum: 13,
        guardian_addresses: keys
            .iter()
            .map(|k| GuardianAddress(ethereum_address(k.verifying_key())))
            .collect(),
    };
    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(guardian_lock)
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );

    let oracle_type_script = context
        .build_script(&oracle_type_op, Bytes::from(feed_id.as_slice().to_vec()))
        .expect("build oracle type");
    let old_oracle = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: 900,
        conf: 30,
        expo: -8,
        publish_time: 1000,
        prev_publish_time: 900,
        ema_price: 895,
        ema_conf: 25,
        emitter_chain: 26,
        emitter_address,
    };
    let new_oracle = OracleData {
        feed_id,
        guardian_set_type_hash,
        price: price_message.price,
        conf: price_message.conf,
        expo: price_message.expo,
        publish_time: price_message.publish_time,
        prev_publish_time: price_message.prev_publish_time,
        ema_price: price_message.ema_price,
        ema_conf: price_message.ema_conf,
        emitter_chain: 26,
        emitter_address,
    };
    let oracle_input = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(dummy_lock.clone())
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(old_oracle.to_bytes()),
    );

    let witness = OracleUpdateWitness { accumulator_update };
    let witness_args = WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(witness.to_bytes())).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(oracle_input).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(dummy_lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(new_oracle.to_bytes()).pack())
        .cell_dep(code_dep(&oracle_type_op))
        .cell_dep(code_dep(&guardian_set_type_op))
        .cell_dep(
            CellDep::new_builder()
                .out_point(guardian_dep_out_point)
                .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
                .build(),
        )
        .witness(witness_args.as_bytes().pack())
        .build();
    let tx = context.complete_tx(tx);

    let err = context
        .verify_tx(&tx, MULTI_SIG_MAX_CYCLES)
        .expect_err("high-S signature must be rejected");
    let msg = err.to_string();
    // Accepted outcomes:
    //   ERROR_GUARDIAN_SIGNATURE_INVALID (22) — k256 rejects high-S outright,
    //                                            or the recovered address no
    //                                            longer matches the registered
    //                                            guardian at index 0.
    //   ERROR_GUARDIAN_SIGNATURE_ORDER (23)   — if recovery happens to land on
    //                                            an address that, paired with
    //                                            the remaining signatures,
    //                                            falsifies strict-ascending.
    let accepted = msg.contains(&format!("error code {}", ERROR_GUARDIAN_SIGNATURE_INVALID))
        || msg.contains(&format!("error code {}", ERROR_GUARDIAN_SIGNATURE_ORDER));
    assert!(
        accepted,
        "high-S signature should be rejected with {} (INVALID) or {} (ORDER), got: {}",
        ERROR_GUARDIAN_SIGNATURE_INVALID, ERROR_GUARDIAN_SIGNATURE_ORDER, err,
    );
}

#[test]
fn test_negate_secp256k1_s_helper_is_self_inverse() {
    // Sanity: flipping `s` twice must recover the original. Guards against
    // off-by-one drift in the schoolbook subtraction helper.
    let original: [u8; 32] = [
        0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC, 0xDE, 0xF0, 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD,
        0xEF, 0xFE, 0xDC, 0xBA, 0x98, 0x76, 0x54, 0x32, 0x10, 0x0F, 0x1E, 0x2D, 0x3C, 0x4B, 0x5A,
        0x69, 0x78,
    ];
    let once = negate_secp256k1_s(&original);
    let twice = negate_secp256k1_s(&once);
    assert_eq!(twice, original);
    assert_ne!(once, original);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Maximum-size payload — wide accumulator at production-realistic shape
//
//  Hermes blobs occasionally batch dozens of price feeds into one signed
//  accumulator. The on-chain `parse_for_feed` walks every entry but only
//  verifies the merkle proof for the target feed — so cycle cost grows with
//  the *parse walk* across N entries, not with N proof verifications.
//
//  This test exercises a balanced 32-leaf accumulator (depth 5). It asserts:
//   * the tx verifies
//   * cycles stay under a regression ceiling
//   * the witness fits well under the CKB per-tx byte-size limit
// ─────────────────────────────────────────────────────────────────────────────

/// Build a balanced binary Pyth merkle tree over `leaves`. Returns the
/// per-level node vector with `out[0] == leaves` and `out.last() == [root]`.
///
/// Precondition: `leaves.len()` is a power of two ≥ 1.
fn build_balanced_pyth_tree(leaves: &[[u8; 20]]) -> Vec<Vec<[u8; 20]>> {
    assert!(leaves.len().is_power_of_two());
    let mut levels: Vec<Vec<[u8; 20]>> = vec![leaves.to_vec()];
    while levels.last().expect("non-empty").len() > 1 {
        let cur = levels.last().expect("non-empty");
        let mut next = Vec::with_capacity(cur.len() / 2);
        let mut i = 0;
        while i < cur.len() {
            next.push(pyth_node_hash(cur[i], cur[i + 1]));
            i += 2;
        }
        levels.push(next);
    }
    levels
}

/// Compute the merkle proof for `leaf_index` against the tree levels produced
/// by `build_balanced_pyth_tree`. Order: leaf-adjacent sibling first, root-
/// adjacent sibling last (matches what `verify_pyth_merkle_proof` consumes).
fn pyth_proof_for_leaf(levels: &[Vec<[u8; 20]>], leaf_index: usize) -> Vec<[u8; 20]> {
    let mut proof = Vec::with_capacity(levels.len() - 1);
    let mut idx = leaf_index;
    for level in &levels[..levels.len() - 1] {
        let sibling = level[idx ^ 1];
        proof.push(sibling);
        idx /= 2;
    }
    proof
}

/// Build a synthetic accumulator update over `messages.len()` price-feed
/// messages arranged in a balanced binary merkle tree. `messages.len()` must
/// be a power of two ≥ 1.
fn build_n_leaf_accumulator_update(
    signers: &[(u8, &SigningKey)],
    guardian_set_index: GuardianSetIndex,
    emitter_address: &EmitterAddress,
    messages: &[PriceFeedMessage],
) -> Vec<u8> {
    assert!(!messages.is_empty() && messages.len().is_power_of_two());

    let raw_messages: Vec<Vec<u8>> = messages
        .iter()
        .map(encode_synthetic_price_feed_message)
        .collect();
    let leaves: Vec<[u8; 20]> = raw_messages
        .iter()
        .map(|m| pyth_leaf_hash(m))
        .collect();
    let levels = build_balanced_pyth_tree(&leaves);
    let root = levels.last().expect("non-empty")[0];

    let vaa_payload = {
        let mut p = Vec::new();
        p.extend_from_slice(&0x4155_5756u32.to_be_bytes());
        p.push(0);
        p.extend_from_slice(&282540738u64.to_be_bytes());
        p.extend_from_slice(&0u32.to_be_bytes());
        p.extend_from_slice(&root);
        p
    };

    let body = {
        let mut b = Vec::new();
        b.extend_from_slice(&1000u32.to_be_bytes());
        b.extend_from_slice(&7u32.to_be_bytes());
        b.extend_from_slice(&26u16.to_be_bytes());
        b.extend_from_slice(emitter_address.as_slice());
        b.extend_from_slice(&99u64.to_be_bytes());
        b.push(1);
        b.extend_from_slice(&vaa_payload);
        b
    };

    let body_digest_inner = Keccak256::digest(&body);
    let mut sig_section = Vec::new();
    sig_section.push(signers.len() as u8);
    for (gi, key) in signers {
        let h = Keccak256::new().chain_update(body_digest_inner);
        let (sig, recid) = key.sign_digest_recoverable(h).expect("sign");
        sig_section.push(*gi);
        sig_section.extend_from_slice(&sig.to_bytes());
        sig_section.push(recid.to_byte());
    }

    let vaa = {
        let mut v = Vec::new();
        v.push(1);
        v.extend_from_slice(&guardian_set_index.0.to_be_bytes());
        v.extend_from_slice(&sig_section);
        v.extend_from_slice(&body);
        v
    };

    let mut blob = Vec::new();
    blob.extend_from_slice(&0x504e_4155u32.to_be_bytes()); // PNAU
    blob.push(1); // major
    blob.push(0); // minor
    blob.push(0); // trailing header size
    blob.push(0); // update type WormholeMerkle
    blob.extend_from_slice(&(vaa.len() as u16).to_be_bytes());
    blob.extend_from_slice(&vaa);
    blob.push(messages.len() as u8); // num_updates
    for i in 0..messages.len() {
        blob.extend_from_slice(&(raw_messages[i].len() as u16).to_be_bytes());
        blob.extend_from_slice(&raw_messages[i]);
        let proof = pyth_proof_for_leaf(&levels, i);
        blob.push(proof.len() as u8);
        for sib in &proof {
            blob.extend_from_slice(sib);
        }
    }
    blob
}

/// Upper bound on cycles for a wide (32-leaf, 13/19 quorum) accumulator
/// update. `parse_for_feed` only verifies the *target* leaf's proof
/// regardless of N, so walking 31 extra entries adds negligible cost —
/// observed ~104M, essentially identical to the single-leaf canonical case
/// (~104M). Ceiling 200M leaves ~2x headroom; a real regression (e.g. an
/// accidental per-entry proof verification) would blow past it fast.
const WIDE_UPDATE_CYCLE_CEILING: u64 = 200_000_000;

#[test]
fn test_wide_accumulator_32_leaves_verifies_within_budget() {
    const N_LEAVES: usize = 32;
    let keys = synthetic_guardian_keys(19);
    let signers: Vec<(u8, &SigningKey)> =
        (0u8..13).map(|i| (i, &keys[i as usize])).collect();

    let mut context = Context::default();
    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_op = deploy_always_success(&mut context);

    let guardian_set_index = GuardianSetIndex(3u32);
    let emitter_address = EmitterAddress([0x33u8; 32]);

    // Target feed sits at leaf index 0; remaining 31 leaves are foreign feeds
    // with deterministically distinct ids. The on-chain script only verifies
    // the proof for the target leaf, but it still walks the wire bytes of
    // every other entry. The target id (`0xFF…FF`) cannot collide with the
    // `[i; 32]` ids used for the foreign leaves.
    let target_feed = FeedId([0xFFu8; 32]);
    let mut messages: Vec<PriceFeedMessage> = Vec::with_capacity(N_LEAVES);
    messages.push(PriceFeedMessage {
        feed_id: target_feed,
        price: 2_500,
        conf: 20,
        expo: -8,
        publish_time: 3_000,
        prev_publish_time: 2_990,
        ema_price: 2_499,
        ema_conf: 19,
    });
    for i in 1..N_LEAVES {
        messages.push(PriceFeedMessage {
            feed_id: FeedId([i as u8; 32]),
            price: 1_000 + i as i64,
            conf: 10,
            expo: -8,
            publish_time: 3_000 + i as u64,
            prev_publish_time: 2_990,
            ema_price: 999,
            ema_conf: 9,
        });
    }

    let accumulator_update = build_n_leaf_accumulator_update(
        &signers,
        guardian_set_index,
        &emitter_address,
        &messages,
    );

    let dummy_lock = context
        .build_script(&always_op, Bytes::from_static(b"oracle-lock"))
        .expect("build oracle lock");
    let guardian_lock = context
        .build_script(&always_op, Bytes::from_static(b"guardian-lock"))
        .expect("build guardian lock");
    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::from(vec![0xAAu8; 32]))
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] =
        guardian_set_type_script.calc_script_hash().unpack();

    let guardian_set_data = GuardianSetData {
        set_index: guardian_set_index,
        quorum: 13,
        guardian_addresses: keys
            .iter()
            .map(|k| GuardianAddress(ethereum_address(k.verifying_key())))
            .collect(),
    };
    let guardian_dep_out_point = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(guardian_lock)
            .type_(Some(guardian_set_type_script).pack())
            .build(),
        Bytes::from(guardian_set_data.to_bytes()),
    );

    let oracle_type_script = context
        .build_script(&oracle_type_op, Bytes::from(target_feed.as_slice().to_vec()))
        .expect("build oracle type");
    let old_oracle = OracleData {
        feed_id: target_feed,
        guardian_set_type_hash,
        price: 900,
        conf: 30,
        expo: -8,
        publish_time: 2_000,
        prev_publish_time: 1_990,
        ema_price: 895,
        ema_conf: 25,
        emitter_chain: 26,
        emitter_address,
    };
    let new_oracle = OracleData {
        feed_id: target_feed,
        guardian_set_type_hash,
        price: messages[0].price,
        conf: messages[0].conf,
        expo: messages[0].expo,
        publish_time: messages[0].publish_time,
        prev_publish_time: messages[0].prev_publish_time,
        ema_price: messages[0].ema_price,
        ema_conf: messages[0].ema_conf,
        emitter_chain: 26,
        emitter_address,
    };

    let oracle_input = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(dummy_lock.clone())
            .type_(Some(oracle_type_script.clone()).pack())
            .build(),
        Bytes::from(old_oracle.to_bytes()),
    );

    let witness_bytes = accumulator_update.len();
    let witness = OracleUpdateWitness {
        accumulator_update,
    };
    let witness_args = WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(witness.to_bytes())).pack())
        .build();

    let tx = TransactionBuilder::default()
        .input(CellInput::new_builder().previous_output(oracle_input).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(dummy_lock)
                .type_(Some(oracle_type_script).pack())
                .build(),
        )
        .output_data(Bytes::from(new_oracle.to_bytes()).pack())
        .cell_dep(code_dep(&oracle_type_op))
        .cell_dep(code_dep(&guardian_set_type_op))
        .cell_dep(
            CellDep::new_builder()
                .out_point(guardian_dep_out_point)
                .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
                .build(),
        )
        .witness(witness_args.as_bytes().pack())
        .build();
    let tx = context.complete_tx(tx);

    let cycles = context
        .verify_tx(&tx, MULTI_SIG_MAX_CYCLES)
        .expect("32-leaf accumulator must verify");

    assert!(
        cycles <= WIDE_UPDATE_CYCLE_CEILING,
        "32-leaf update consumed {} cycles, exceeding ceiling {}. \
         Investigate parser-walk regression before raising ceiling.",
        cycles,
        WIDE_UPDATE_CYCLE_CEILING,
    );

    // Sanity: the accumulator-update blob alone must be well under CKB's
    // ~512 KB per-tx limit. We expect ~7 KB. The bound is loose — its only
    // job is to fire if a future change makes the wire format unexpectedly
    // bloated.
    assert!(
        witness_bytes < 32 * 1024,
        "32-leaf accumulator unexpectedly large: {} bytes",
        witness_bytes,
    );
}

#[test]
fn test_build_balanced_pyth_tree_proof_round_trip() {
    // Independent self-check on the test helper: every leaf's proof, when
    // folded with `verify_pyth_merkle_proof`, must reconstruct the root.
    // Guards against off-by-one bugs in `pyth_proof_for_leaf` that the wide-
    // accumulator test wouldn't catch (since on-chain only verifies leaf 0).
    use lean_oracle_common::merkle::verify_pyth_merkle_proof;

    let raw_messages: Vec<Vec<u8>> = (0..8)
        .map(|i| {
            let m = PriceFeedMessage {
                feed_id: FeedId([i as u8; 32]),
                price: i as i64,
                conf: i as u64,
                expo: 0,
                publish_time: i as u64,
                prev_publish_time: 0,
                ema_price: i as i64,
                ema_conf: i as u64,
            };
            encode_synthetic_price_feed_message(&m)
        })
        .collect();
    let leaves: Vec<[u8; 20]> = raw_messages.iter().map(|m| pyth_leaf_hash(m)).collect();
    let levels = build_balanced_pyth_tree(&leaves);
    let root = levels.last().expect("non-empty")[0];

    for (i, raw) in raw_messages.iter().enumerate() {
        let proof = pyth_proof_for_leaf(&levels, i);
        assert!(
            verify_pyth_merkle_proof(root, raw, &proof),
            "proof for leaf {} should fold to root",
            i,
        );
    }
}
