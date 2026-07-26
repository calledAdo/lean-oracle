//! Combined CKB-VM tests for permissionless guardian rotation.

use ckb_testtool::{
    ckb_types::{
        bytes::Bytes,
        core::TransactionBuilder,
        packed::{CellDep, CellInput, CellOutput, OutPoint, Script, WitnessArgs},
        prelude::*,
    },
    context::Context,
};
use k256::ecdsa::SigningKey;
use lean_oracle_common::{
    errors::{ERROR_BIND_LOCK_COUNT_MISMATCH, ERROR_GUARDIAN_SIGNATURE_INVALID},
    governance::{
        WORMHOLE_GOVERNANCE_ACTION_GUARDIAN_SET_UPGRADE, WORMHOLE_GOVERNANCE_EMITTER_ADDRESS,
        WORMHOLE_GOVERNANCE_EMITTER_CHAIN, WORMHOLE_GOVERNANCE_MODULE_CORE,
        WORMHOLE_GOVERNANCE_TARGET_CHAIN_ALL,
    },
    guardian_set::GuardianSetData,
    types::{GuardianAddress, GuardianSetIndex},
    wormhole_verify::ethereum_address,
};
use sha3::{Digest, Keccak256};

const MAX_CYCLES: u64 = 200_000_000;

fn load_contract(context: &mut Context, name: &str) -> OutPoint {
    let path = format!("../target/riscv64imac-unknown-none-elf/release/{name}");
    let bin = std::fs::read(&path).unwrap_or_else(|_| {
        panic!("missing {name} binary at {path}; build optimized contracts first")
    });
    context.deploy_cell(bin.into())
}

fn deploy_always_success(context: &mut Context) -> OutPoint {
    context.deploy_cell(Bytes::from(ckb_testtool::builtin::ALWAYS_SUCCESS.to_vec()))
}

fn code_dep(out_point: &OutPoint) -> CellDep {
    CellDep::new_builder()
        .out_point(out_point.clone())
        .dep_type(ckb_testtool::ckb_types::core::DepType::Code)
        .build()
}

fn guardian_upgrade_vaa(
    signing_key: &SigningKey,
    signing_set_index: GuardianSetIndex,
    new_index: u32,
    new_addresses: &[GuardianAddress],
) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&WORMHOLE_GOVERNANCE_MODULE_CORE);
    payload.push(WORMHOLE_GOVERNANCE_ACTION_GUARDIAN_SET_UPGRADE);
    payload.extend_from_slice(&WORMHOLE_GOVERNANCE_TARGET_CHAIN_ALL.to_be_bytes());
    payload.extend_from_slice(&new_index.to_be_bytes());
    payload.push(new_addresses.len() as u8);
    for address in new_addresses {
        payload.extend_from_slice(address.as_slice());
    }

    let mut body = Vec::new();
    body.extend_from_slice(&1000u32.to_be_bytes());
    body.extend_from_slice(&0u32.to_be_bytes());
    body.extend_from_slice(&WORMHOLE_GOVERNANCE_EMITTER_CHAIN.to_be_bytes());
    body.extend_from_slice(&WORMHOLE_GOVERNANCE_EMITTER_ADDRESS);
    body.extend_from_slice(&1u64.to_be_bytes());
    body.push(1);
    body.extend_from_slice(&payload);

    let body_digest_inner = Keccak256::digest(&body);
    let hash = Keccak256::new().chain_update(body_digest_inner);
    let (signature, recovery_id) = signing_key
        .sign_digest_recoverable(hash)
        .expect("sign governance VAA");

    let mut encoded = Vec::new();
    encoded.push(1);
    encoded.extend_from_slice(&signing_set_index.0.to_be_bytes());
    encoded.push(1);
    encoded.push(0);
    encoded.extend_from_slice(&signature.to_bytes());
    encoded.push(recovery_id.to_byte());
    encoded.extend_from_slice(&body);
    encoded
}

struct Fixture {
    context: Context,
    guardian_code: OutPoint,
    bind_code: OutPoint,
    always_code: OutPoint,
    guardian_input: OutPoint,
    fee_input: OutPoint,
    guardian_type: Script,
    bind_lock: Script,
    fee_lock: Script,
    old_key: SigningKey,
    attacker_key: SigningKey,
    next_data: GuardianSetData,
}

impl Fixture {
    fn new() -> Self {
        let mut context = Context::default();
        let guardian_code = load_contract(&mut context, "guardian_set_type");
        let bind_code = load_contract(&mut context, "owned_type_bind_lock");
        let always_code = deploy_always_success(&mut context);

        let owner_lock = context
            .build_script(&always_code, Bytes::from_static(b"owner"))
            .expect("owner lock");
        let owner_lock_hash: [u8; 32] = owner_lock.calc_script_hash().unpack();
        let bind_lock = context
            .build_script(&bind_code, Bytes::from(owner_lock_hash.to_vec()))
            .expect("bind lock");
        let fee_lock = context
            .build_script(&always_code, Bytes::from_static(b"third-party-fee-payer"))
            .expect("fee lock");
        assert_ne!(owner_lock.calc_script_hash(), fee_lock.calc_script_hash());

        let guardian_type = context
            .build_script(&guardian_code, Bytes::from(vec![0xabu8; 32]))
            .expect("guardian type");
        let old_key = SigningKey::from_bytes((&[1u8; 32]).into()).expect("old key");
        let new_key = SigningKey::from_bytes((&[2u8; 32]).into()).expect("new key");
        let attacker_key = SigningKey::from_bytes((&[3u8; 32]).into()).expect("attacker key");

        let old_data = GuardianSetData {
            set_index: GuardianSetIndex(7),
            quorum: 1,
            guardian_addresses: vec![GuardianAddress(ethereum_address(old_key.verifying_key()))],
        };
        let next_data = GuardianSetData {
            set_index: GuardianSetIndex(8),
            quorum: 1,
            guardian_addresses: vec![GuardianAddress(ethereum_address(new_key.verifying_key()))],
        };

        let guardian_input = context.create_cell(
            CellOutput::new_builder()
                .capacity(100_000_000_000u64)
                .lock(bind_lock.clone())
                .type_(Some(guardian_type.clone()).pack())
                .build(),
            Bytes::from(old_data.to_bytes()),
        );
        let fee_input = context.create_cell(
            CellOutput::new_builder()
                .capacity(10_000_000_000u64)
                .lock(fee_lock.clone())
                .build(),
            Bytes::new(),
        );

        Self {
            context,
            guardian_code,
            bind_code,
            always_code,
            guardian_input,
            fee_input,
            guardian_type,
            bind_lock,
            fee_lock,
            old_key,
            attacker_key,
            next_data,
        }
    }

    fn transaction(
        &mut self,
        signing_key: &SigningKey,
        preserve_bind_lock: bool,
    ) -> ckb_testtool::ckb_types::core::TransactionView {
        let vaa = guardian_upgrade_vaa(
            signing_key,
            GuardianSetIndex(7),
            8,
            &self.next_data.guardian_addresses,
        );
        let witness = WitnessArgs::new_builder()
            .input_type(Some(Bytes::from(vaa)).pack())
            .build();
        let guardian_output_lock = if preserve_bind_lock {
            self.bind_lock.clone()
        } else {
            self.fee_lock.clone()
        };

        let tx = TransactionBuilder::default()
            .cell_deps(vec![
                code_dep(&self.guardian_code),
                code_dep(&self.bind_code),
                code_dep(&self.always_code),
            ])
            .input(
                CellInput::new_builder()
                    .previous_output(self.guardian_input.clone())
                    .build(),
            )
            .input(
                CellInput::new_builder()
                    .previous_output(self.fee_input.clone())
                    .build(),
            )
            .output(
                CellOutput::new_builder()
                    .capacity(100_000_000_000u64)
                    .lock(guardian_output_lock)
                    .type_(Some(self.guardian_type.clone()).pack())
                    .build(),
            )
            .output(
                CellOutput::new_builder()
                    .capacity(9_000_000_000u64)
                    .lock(self.fee_lock.clone())
                    .build(),
            )
            .output_data(Bytes::from(self.next_data.to_bytes()).pack())
            .output_data(Bytes::new().pack())
            .witness(witness.as_bytes().pack())
            .witness(Bytes::new().pack())
            .build();
        self.context.complete_tx(tx)
    }
}

fn assert_error_contains(error: impl core::fmt::Display, code: i8) {
    assert!(
        error.to_string().contains(&format!("error code {code}")),
        "expected error code {code}, got {error}"
    );
}

#[test]
fn guardian_owned_bind_third_party_rotation_accepts_valid_governance() {
    let mut fixture = Fixture::new();
    let key = fixture.old_key.clone();
    let tx = fixture.transaction(&key, true);
    fixture
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("third-party permissionless rotation");
}

#[test]
fn guardian_owned_bind_continuity_does_not_bypass_bad_governance() {
    let mut fixture = Fixture::new();
    let key = fixture.attacker_key.clone();
    let tx = fixture.transaction(&key, true);
    let error = fixture
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("forged guardian must fail");
    assert_error_contains(error, ERROR_GUARDIAN_SIGNATURE_INVALID);
}

#[test]
fn guardian_owned_bind_valid_governance_does_not_bypass_broken_continuity() {
    let mut fixture = Fixture::new();
    let key = fixture.old_key.clone();
    let tx = fixture.transaction(&key, false);
    let error = fixture
        .context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("broken bind-lock continuity must fail");
    assert_error_contains(error, ERROR_BIND_LOCK_COUNT_MISMATCH);
}
