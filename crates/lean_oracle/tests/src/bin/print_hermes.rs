//! Decode and print Hermes accumulator bytes (`PNAU` blob) — same parsers as contracts.
//!
//! Default: decode `REAL_HERMES_ACCUMULATOR_HEX` from `hermes_real_fixture`.
//!
//! ```text
//! print-hermes --stdin < hermes-response.json
//! ```

use std::io::Read;

use lean_oracle_common::{
    guardian_set::GuardianSetData,
    pyth_accumulator::ParsedAccumulatorUpdateForFeed,
    wormhole_verify::verify_guardian_quorum,
};
use tests::hermes_real_fixture::{
    decode_hex, decode_hex_20, decode_hex_32, BTC_USD_FEED_ID_HEX, REAL_GUARDIAN_SET,
    REAL_HERMES_ACCUMULATOR_HEX, REAL_HERMES_EXPECTED_ACCUMULATOR_SLOT, REAL_HERMES_EXPECTED_CONF,
    REAL_HERMES_EXPECTED_EMA_CONF, REAL_HERMES_EXPECTED_EMA_PRICE, REAL_HERMES_EXPECTED_EXPO,
    REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX, REAL_HERMES_EXPECTED_PREV_PUBLISH_TIME,
    REAL_HERMES_EXPECTED_PRICE, REAL_HERMES_EXPECTED_PUBLISH_TIME,
};

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn stdin_blob() -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    std::io::stdin()
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    decode_input(&buf)
}

fn decode_input(raw: &[u8]) -> Result<Vec<u8>, String> {
    let s_lossy = String::from_utf8_lossy(raw);
    let t = s_lossy.trim();
    if t.starts_with('{') {
        let v: serde_json::Value =
            serde_json::from_slice(raw).map_err(|e| format!("invalid JSON: {}", e))?;
        let hex_str = extract_hermes_binary_data_hex(&v)
            .ok_or_else(|| "JSON missing binary.encoding=hex binary.data[0]".to_string())?;
        decode_hex(&hex_str).map_err(|_| "invalid hex in binary.data[0]".to_string())
    } else {
        let cleaned: String = t.chars().filter(|c| !c.is_whitespace()).collect();
        decode_hex(&cleaned).map_err(|_| "stdin is not valid hex".to_string())
    }
}

fn extract_hermes_binary_data_hex(v: &serde_json::Value) -> Option<String> {
    let bin = v
        .get("binary")
        .or_else(|| v.get("result").and_then(|r| r.get("binary")))?;
    let enc = bin.get("encoding")?.as_str()?;
    if enc != "hex" {
        return None;
    }
    let arr = bin.get("data")?.as_array()?;
    let first = arr.first()?.as_str()?;
    Some(first.to_string())
}

fn main() {
    let use_stdin = std::env::args().any(|a| a == "--stdin" || a == "-");
    let accumulator_update = if use_stdin {
        stdin_blob().unwrap_or_else(|e| panic!("{}", e))
    } else {
        decode_hex(REAL_HERMES_ACCUMULATOR_HEX).expect("decode fixture Hermes hex")
    };

    let target_feed_id = decode_hex_32(BTC_USD_FEED_ID_HEX).expect("decode feed id");

    let parsed = ParsedAccumulatorUpdateForFeed::parse_for_feed(&accumulator_update, &target_feed_id)
        .expect("parse_for_feed failed");

    let guardian_set = GuardianSetData {
        set_index: parsed.vaa.guardian_set_index,
        quorum: 13,
        creation_time: 0,
        expiration_time: 0,
        governance_lock_hash: [0u8; 32],
        guardian_addresses: REAL_GUARDIAN_SET
            .iter()
            .map(|addr| decode_hex_20(addr).expect("decode guardian hex"))
            .collect(),
    };

    let quorum_ok = verify_guardian_quorum(&parsed.vaa, &guardian_set).is_ok();

    let source = if use_stdin {
        "stdin"
    } else {
        "hermes_real_fixture (REAL_HERMES_ACCUMULATOR_HEX)"
    };
    println!("=== Hermes accumulator decode (source: {}) ===\n", source);

    println!("accumulator.slot: {}", parsed.slot);
    println!("merkle_root (20 bytes): 0x{}", hex_bytes(&parsed.root_digest));

    println!("\n--- embedded Wormhole VAA ---");
    println!("guardian_set_index: {}", parsed.vaa.guardian_set_index);
    println!("signature_count: {}", parsed.vaa.signatures.len());
    println!("emitter_chain: {}", parsed.vaa.emitter_chain);
    println!("emitter_address: 0x{}", hex_bytes(&parsed.vaa.emitter_address));
    println!("sequence: {}", parsed.vaa.sequence);
    println!("timestamp: {}", parsed.vaa.timestamp);
    println!(
        "verify_guardian_quorum (REAL_GUARDIAN_SET fixture; may fail after guardian rotation): {}",
        quorum_ok
    );

    println!("\n--- price message (BTC/USD feed) ---");
    println!("feed_id (bytes): 0x{}", hex_bytes(&parsed.message.feed_id));
    println!("price (raw): {}", parsed.message.price);
    println!("conf (raw): {}", parsed.message.conf);
    println!("expo: {}", parsed.message.expo);
    println!("publish_time (unix): {}", parsed.message.publish_time);
    println!("prev_publish_time (unix): {}", parsed.message.prev_publish_time);
    println!("ema_price (raw): {}", parsed.message.ema_price);
    println!("ema_conf (raw): {}", parsed.message.ema_conf);

    println!("\n--- matches REAL_HERMES_EXPECTED_* in hermes_real_fixture ---");
    let ok_slot = parsed.slot == REAL_HERMES_EXPECTED_ACCUMULATOR_SLOT;
    let ok_idx = parsed.vaa.guardian_set_index == REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX;
    let ok_msg = parsed.message.price == REAL_HERMES_EXPECTED_PRICE
        && parsed.message.conf == REAL_HERMES_EXPECTED_CONF
        && parsed.message.expo == REAL_HERMES_EXPECTED_EXPO
        && parsed.message.publish_time == REAL_HERMES_EXPECTED_PUBLISH_TIME
        && parsed.message.prev_publish_time == REAL_HERMES_EXPECTED_PREV_PUBLISH_TIME
        && parsed.message.ema_price == REAL_HERMES_EXPECTED_EMA_PRICE
        && parsed.message.ema_conf == REAL_HERMES_EXPECTED_EMA_CONF
        && parsed.message.feed_id == target_feed_id;

    println!(
        "(only when stdin == fixture hex OR default mode) slot + guardian_set_index + spot fields OK: {}",
        ok_slot && ok_idx && ok_msg
    );
}
