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
        packed::{CellDep, CellInput, CellOutput},
        prelude::*,
    },
    context::Context,
};
use lean_oracle_common::{
    errors::*,
    guardian_set::GuardianSetData,
    oracle_data::OracleData,
    oracle_witness::OracleUpdateWitness,
};

const MAX_CYCLES: u64 = 100_000_000;

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

#[test]
fn test_oracle_type_accepts_real_hermes_update_with_real_guardian_dep() {
    let mut context = Context::default();

    let oracle_type_op = load_oracle_type(&mut context);
    let guardian_set_type_op = load_guardian_set_type(&mut context);
    let always_success_op = deploy_always_success(&mut context);

    let feed_id = decode_hex_32(BTC_USD_FEED_ID_HEX).expect("decode feed id");
    let emitter_address = decode_hex_32(
        "e101faedac5851e32b9b23b5f9411a8c2bac4aae3ed4dd7b811dd1a72ea4aa71",
    )
    .expect("decode emitter address");
    let accumulator_update =
        decode_hex(REAL_HERMES_ACCUMULATOR_HEX).expect("decode accumulator hex");

    let dummy_lock = context
        .build_script(&always_success_op, Bytes::from_static(b"oracle-lock"))
        .expect("build oracle lock");
    let guardian_lock = context
        .build_script(&always_success_op, Bytes::from_static(b"guardian-lock"))
        .expect("build guardian lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::new())
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    let guardian_set_data = GuardianSetData {
        set_index: REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX,
        quorum: 13,
        creation_time: 0,
        expiration_time: 0,
        governance_lock_hash: [0x11; 32],
        guardian_addresses: REAL_GUARDIAN_SET
            .iter()
            .map(|a| decode_hex_20(a).expect("decode guardian hex"))
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
        .build_script(&oracle_type_op, Bytes::from(feed_id.to_vec()))
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
        guardian_set_index: REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX,
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
        guardian_set_index: REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX,
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
        .lock(Some(Bytes::from(witness.to_bytes())).pack())
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
        |guardian_set| guardian_set.set_index = 4,
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
        |new_oracle| new_oracle.emitter_address = [0x55; 32],
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

    let feed_id = decode_hex_32(BTC_USD_FEED_ID_HEX).expect("decode feed id");
    let emitter_address = decode_hex_32(
        "e101faedac5851e32b9b23b5f9411a8c2bac4aae3ed4dd7b811dd1a72ea4aa71",
    )
    .expect("decode emitter address");
    let accumulator_update =
        decode_hex(REAL_HERMES_ACCUMULATOR_HEX).expect("decode accumulator hex");

    let dummy_lock = context
        .build_script(&always_success_op, Bytes::from_static(b"oracle-lock"))
        .expect("build oracle lock");
    let guardian_lock = context
        .build_script(&always_success_op, Bytes::from_static(b"guardian-lock"))
        .expect("build guardian lock");

    let guardian_set_type_script = context
        .build_script(&guardian_set_type_op, Bytes::new())
        .expect("build guardian set type");
    let guardian_set_type_hash: [u8; 32] = guardian_set_type_script.calc_script_hash().unpack();

    let mut guardian_set_data = GuardianSetData {
        set_index: REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX,
        quorum: 13,
        creation_time: 0,
        expiration_time: 0,
        governance_lock_hash: [0x11; 32],
        guardian_addresses: REAL_GUARDIAN_SET
            .iter()
            .map(|a| decode_hex_20(a).expect("decode guardian hex"))
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
        .build_script(&oracle_type_op, Bytes::from(feed_id.to_vec()))
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
        guardian_set_index: REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX,
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
        guardian_set_index: REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX,
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
        .lock(Some(Bytes::from(witness.to_bytes())).pack())
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

