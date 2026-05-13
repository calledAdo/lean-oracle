//! Integration tests for the `owned_type_bind_lock` contract.
//!
//! These tests run the compiled RISC-V binary through `ckb-testtool`, mirroring
//! the pattern used by `oracle_integration_tests.rs`.

use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::TransactionBuilder,
        packed::{CellDep, CellInput, CellOutput, OutPoint},
        prelude::*,
    },
    context::Context,
};
use lean_oracle_common::errors::*;

const MAX_CYCLES: u64 = 10_000_000;

fn load_owned_type_bind_lock(context: &mut Context) -> OutPoint {
    let bin = std::fs::read(
        "../target/riscv64imac-unknown-none-elf/release/owned_type_bind_lock",
    )
    .expect(
        "missing owned_type_bind_lock binary; build with `cargo build -p owned_type_bind_lock --release --target riscv64imac-unknown-none-elf`",
    );
    context.deploy_cell(bin.into())
}

fn deploy_always_success(context: &mut Context) -> OutPoint {
    context.deploy_cell(Bytes::from(
        ckb_testtool::builtin::ALWAYS_SUCCESS.to_vec(),
    ))
}

fn code_dep(op: &OutPoint) -> CellDep {
    CellDep::new_builder()
        .out_point(op.clone())
        .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
        .build()
}

#[test]
fn owner_escape_passes() {
    // Tx includes an input cell whose lock hash matches the bind lock's args
    // (owner-escape). The bind-locked cell is consumed with no corresponding
    // output — should still pass because the owner authorizes.
    let mut context = Context::default();
    let bind_op = load_owned_type_bind_lock(&mut context);
    let always_op = deploy_always_success(&mut context);

    // Owner lock: always_success with unique args so its lock hash is
    // deterministic.
    let owner_lock = context
        .build_script(&always_op, Bytes::from_static(b"owner"))
        .expect("build owner lock");
    let owner_lock_hash: [u8; 32] = owner_lock.calc_script_hash().unpack();

    let bind_lock = context
        .build_script(&bind_op, Bytes::from(owner_lock_hash.to_vec()))
        .expect("build bind lock");

    // The bind-locked cell needs a type script for the contract to even look
    // at it (the owner-escape path returns before reading type, but we
    // construct a realistic cell anyway).
    let type_script = context
        .build_script(&always_op, Bytes::from_static(b"type-A"))
        .expect("build type");

    let bound_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(bind_lock.clone())
            .type_(Some(type_script.clone()).pack())
            .build(),
        Bytes::from_static(b"state"),
    );
    let owner_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(owner_lock.clone())
            .build(),
        Bytes::new(),
    );

    let tx = TransactionBuilder::default()
        .cell_deps(vec![code_dep(&bind_op), code_dep(&always_op)])
        .input(CellInput::new_builder().previous_output(bound_cell).build())
        .input(CellInput::new_builder().previous_output(owner_cell).build())
        // Single change output back to the owner — no corresponding bound output.
        .output(
            CellOutput::new_builder()
                .capacity(199_000_000_000u64)
                .lock(owner_lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();
    let tx = context.complete_tx(tx);
    context.verify_tx(&tx, MAX_CYCLES).expect("tx ok");
}

#[test]
fn continuity_passes_without_owner() {
    // No owner input. One bind-locked input, one bind-locked output with the
    // same type-hash. Should pass via the continuity branch.
    let mut context = Context::default();
    let bind_op = load_owned_type_bind_lock(&mut context);
    let always_op = deploy_always_success(&mut context);

    let bind_lock = context
        .build_script(&bind_op, Bytes::from(vec![0u8; 32]))
        .expect("build bind lock");
    let type_script = context
        .build_script(&always_op, Bytes::from_static(b"type-A"))
        .expect("build type");

    let input_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(bind_lock.clone())
            .type_(Some(type_script.clone()).pack())
            .build(),
        Bytes::from_static(b"state-v1"),
    );

    let tx = TransactionBuilder::default()
        .cell_deps(vec![code_dep(&bind_op), code_dep(&always_op)])
        .input(CellInput::new_builder().previous_output(input_cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(bind_lock)
                .type_(Some(type_script).pack())
                .build(),
        )
        .output_data(Bytes::from_static(b"state-v2").pack())
        .build();
    let tx = context.complete_tx(tx);
    context.verify_tx(&tx, MAX_CYCLES).expect("tx ok");
}

#[test]
fn continuity_rejects_burn_without_owner() {
    // 1 bind-locked input, 0 bind-locked outputs, no owner input. Continuity
    // count mismatch.
    let mut context = Context::default();
    let bind_op = load_owned_type_bind_lock(&mut context);
    let always_op = deploy_always_success(&mut context);

    let bind_lock = context
        .build_script(&bind_op, Bytes::from(vec![0u8; 32]))
        .expect("build bind lock");
    let type_script = context
        .build_script(&always_op, Bytes::from_static(b"type-A"))
        .expect("build type");

    let input_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(bind_lock)
            .type_(Some(type_script).pack())
            .build(),
        Bytes::from_static(b"state"),
    );

    // Outputs use a different lock so they're not in the same group.
    let other_lock = context
        .build_script(&always_op, Bytes::from_static(b"other"))
        .expect("build other lock");
    let tx = TransactionBuilder::default()
        .cell_deps(vec![code_dep(&bind_op), code_dep(&always_op)])
        .input(CellInput::new_builder().previous_output(input_cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(other_lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();
    let tx = context.complete_tx(tx);
    let err = context.verify_tx(&tx, MAX_CYCLES).unwrap_err();
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_BIND_LOCK_COUNT_MISMATCH)));
}

#[test]
fn continuity_rejects_type_substitution() {
    // 1 input, 1 output, same bind lock — but output uses a different type
    // script. Continuity check finds no matching type hash in outputs.
    let mut context = Context::default();
    let bind_op = load_owned_type_bind_lock(&mut context);
    let always_op = deploy_always_success(&mut context);

    let bind_lock = context
        .build_script(&bind_op, Bytes::from(vec![0u8; 32]))
        .expect("build bind lock");
    let type_a = context
        .build_script(&always_op, Bytes::from_static(b"type-A"))
        .expect("type A");
    let type_b = context
        .build_script(&always_op, Bytes::from_static(b"type-B"))
        .expect("type B");

    let input_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(bind_lock.clone())
            .type_(Some(type_a).pack())
            .build(),
        Bytes::from_static(b"state"),
    );

    let tx = TransactionBuilder::default()
        .cell_deps(vec![code_dep(&bind_op), code_dep(&always_op)])
        .input(CellInput::new_builder().previous_output(input_cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(bind_lock)
                .type_(Some(type_b).pack())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();
    let tx = context.complete_tx(tx);
    let err = context.verify_tx(&tx, MAX_CYCLES).unwrap_err();
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_BIND_LOCK_TYPE_NOT_FOUND)));
}

#[test]
fn rejects_malformed_args() {
    // Bind lock deployed with 0-length args — must reject before any state
    // check.
    let mut context = Context::default();
    let bind_op = load_owned_type_bind_lock(&mut context);
    let always_op = deploy_always_success(&mut context);

    let bind_lock = context
        .build_script(&bind_op, Bytes::new())
        .expect("build bind lock");
    let type_script = context
        .build_script(&always_op, Bytes::from_static(b"type-A"))
        .expect("type");

    let input_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(bind_lock.clone())
            .type_(Some(type_script.clone()).pack())
            .build(),
        Bytes::new(),
    );

    let tx = TransactionBuilder::default()
        .cell_deps(vec![code_dep(&bind_op), code_dep(&always_op)])
        .input(CellInput::new_builder().previous_output(input_cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(bind_lock)
                .type_(Some(type_script).pack())
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();
    let tx = context.complete_tx(tx);
    let err = context.verify_tx(&tx, MAX_CYCLES).unwrap_err();
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_BIND_LOCK_ARGS_MALFORMED)));
}

#[test]
fn rejects_input_without_type_script() {
    // A bind-locked input with no type script falls into the continuity
    // branch and triggers the no-type-script guard.
    let mut context = Context::default();
    let bind_op = load_owned_type_bind_lock(&mut context);
    let always_op = deploy_always_success(&mut context);

    let bind_lock = context
        .build_script(&bind_op, Bytes::from(vec![0u8; 32]))
        .expect("build bind lock");

    let input_cell = context.create_cell(
        CellOutput::new_builder()
            .capacity(100_000_000_000u64)
            .lock(bind_lock.clone())
            .build(),
        Bytes::new(),
    );

    let tx = TransactionBuilder::default()
        .cell_deps(vec![code_dep(&bind_op), code_dep(&always_op)])
        .input(CellInput::new_builder().previous_output(input_cell).build())
        .output(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(bind_lock)
                .build(),
        )
        .output_data(Bytes::new().pack())
        .build();
    let tx = context.complete_tx(tx);
    let err = context.verify_tx(&tx, MAX_CYCLES).unwrap_err();
    assert!(err
        .to_string()
        .contains(&format!("error code {}", ERROR_BIND_LOCK_NO_TYPE_SCRIPT)));
}
