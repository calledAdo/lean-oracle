LEAN_ORACLE_DIR := crates/lean_oracle
HOST_TARGET := x86_64-unknown-linux-gnu
CKB_TARGET := riscv64imac-unknown-none-elf

.PHONY: contracts-build contracts-test

contracts-build:
	cd $(LEAN_ORACLE_DIR) && cargo build -p oracle_script -p guardian_set_script -p owned_type_bind_lock --release --target $(CKB_TARGET)

contracts-test:
	cd $(LEAN_ORACLE_DIR) && cargo test --target $(HOST_TARGET)
