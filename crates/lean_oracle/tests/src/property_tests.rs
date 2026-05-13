//! Property-based round-trip tests for the protocol's wire encoders.
//!
//! These complement the fixed-fixture tests in `oracle_data_tests.rs` by
//! exercising every byte/sign/edge of the integer fields through randomized
//! inputs. A failing case shrinks to a minimal counter-example.

use lean_oracle_common::{
    guardian_set::GuardianSetData,
    oracle_data::OracleData,
    oracle_witness::OracleUpdateWitness,
    types::{EmitterAddress, FeedId, GuardianAddress, GuardianSetIndex},
};
use proptest::prelude::*;

fn arb_oracle_data() -> impl Strategy<Value = OracleData> {
    (
        any::<[u8; 32]>(),
        any::<[u8; 32]>(),
        any::<i64>(),
        any::<u64>(),
        any::<i32>(),
        any::<u64>(),
        any::<u64>(),
        any::<i64>(),
        any::<u64>(),
        any::<u32>(),
        any::<[u8; 32]>(),
    )
        .prop_map(
            |(
                feed_id,
                guardian_set_type_hash,
                price,
                conf,
                expo,
                publish_time,
                prev_publish_time,
                ema_price,
                ema_conf,
                emitter_chain,
                emitter_address,
            )| OracleData {
                feed_id: FeedId(feed_id),
                guardian_set_type_hash,
                price,
                conf,
                expo,
                publish_time,
                prev_publish_time,
                ema_price,
                ema_conf,
                emitter_chain,
                emitter_address: EmitterAddress(emitter_address),
            },
        )
}

fn arb_guardian_set_data() -> impl Strategy<Value = GuardianSetData> {
    (
        any::<u32>(),
        1u32..=19,
        // Up to 19 guardian addresses to mirror mainnet shape; minimum 1.
        prop::collection::vec(any::<[u8; 20]>(), 1..=19),
    )
        .prop_map(|(set_index, quorum_raw, addrs)| {
            // Clamp quorum to the size of the address set so we exercise
            // realistic configurations only.
            let quorum = quorum_raw.min(addrs.len() as u32);
            GuardianSetData {
                set_index: GuardianSetIndex(set_index),
                quorum,
                guardian_addresses: addrs.into_iter().map(GuardianAddress).collect(),
            }
        })
}

fn arb_oracle_update_witness() -> impl Strategy<Value = OracleUpdateWitness> {
    // The witness wraps an opaque accumulator-update blob — round-trip must
    // preserve byte-for-byte regardless of contents. Bound length so the
    // suite stays fast; structural meaning is checked by the on-chain parser
    // elsewhere.
    prop::collection::vec(any::<u8>(), 0..=1024).prop_map(|bytes| OracleUpdateWitness {
        accumulator_update: bytes,
    })
}

proptest! {
    /// `OracleData::to_bytes` followed by `from_bytes` recovers the original.
    /// Covers every sign/endian path on all 11 fields.
    #[test]
    fn oracle_data_roundtrip(original in arb_oracle_data()) {
        let bytes = original.to_bytes();
        prop_assert_eq!(bytes.len(), 152, "OracleData wire size must be exactly 152 bytes");
        let decoded = OracleData::from_bytes(&bytes).expect("from_bytes must succeed on freshly encoded data");
        prop_assert_eq!(decoded.feed_id.0, original.feed_id.0);
        prop_assert_eq!(decoded.guardian_set_type_hash, original.guardian_set_type_hash);
        prop_assert_eq!(decoded.price, original.price);
        prop_assert_eq!(decoded.conf, original.conf);
        prop_assert_eq!(decoded.expo, original.expo);
        prop_assert_eq!(decoded.publish_time, original.publish_time);
        prop_assert_eq!(decoded.prev_publish_time, original.prev_publish_time);
        prop_assert_eq!(decoded.ema_price, original.ema_price);
        prop_assert_eq!(decoded.ema_conf, original.ema_conf);
        prop_assert_eq!(decoded.emitter_chain, original.emitter_chain);
        prop_assert_eq!(decoded.emitter_address.0, original.emitter_address.0);
    }

    /// `from_bytes` rejects any payload whose length is not exactly 152.
    /// Truncation, padding, and adjacent-size near-misses must all fail.
    #[test]
    fn oracle_data_rejects_wrong_length(bytes in prop::collection::vec(any::<u8>(), 0..=300)) {
        prop_assume!(bytes.len() != 152);
        prop_assert!(OracleData::from_bytes(&bytes).is_none());
    }

    /// `GuardianSetData::to_bytes` followed by `from_bytes` recovers the original
    /// across guardian-set sizes from 1 up to mainnet's 19.
    #[test]
    fn guardian_set_data_roundtrip(original in arb_guardian_set_data()) {
        let bytes = original.to_bytes();
        let decoded = GuardianSetData::from_bytes(&bytes).expect("from_bytes must succeed on freshly encoded data");
        prop_assert_eq!(decoded.set_index.0, original.set_index.0);
        prop_assert_eq!(decoded.quorum, original.quorum);
        prop_assert_eq!(decoded.guardian_addresses.len(), original.guardian_addresses.len());
        for (a, b) in decoded.guardian_addresses.iter().zip(original.guardian_addresses.iter()) {
            prop_assert_eq!(a.0, b.0);
        }
    }

    /// Witness round-trip: opaque blob in, identical opaque blob out.
    #[test]
    fn oracle_update_witness_roundtrip(original in arb_oracle_update_witness()) {
        let bytes = original.to_bytes();
        let decoded = OracleUpdateWitness::from_bytes(&bytes).expect("from_bytes must succeed on freshly encoded data");
        prop_assert_eq!(decoded.accumulator_update, original.accumulator_update);
    }

    /// `static_fields_unchanged` is reflexive: any `OracleData` equals itself
    /// on its static fields (feed_id, guardian_set_type_hash, emitter_chain,
    /// emitter_address). This anchors the contract-side mutation check.
    #[test]
    fn oracle_data_static_fields_reflexive(d in arb_oracle_data()) {
        prop_assert!(d.static_fields_unchanged(&d));
    }

    /// Changing any static field breaks `static_fields_unchanged`. The dynamic
    /// price fields are deliberately permitted to differ.
    #[test]
    fn oracle_data_static_fields_detect_mutation(
        d in arb_oracle_data(),
        feed_id_perturb in any::<[u8; 32]>(),
        emitter_chain_perturb in any::<u32>(),
    ) {
        // Skip if the random perturbations happened to equal the original
        // (vanishingly small but possible).
        prop_assume!(d.feed_id.0 != feed_id_perturb);
        prop_assume!(d.emitter_chain != emitter_chain_perturb);

        let mut mutated_feed = d.clone();
        mutated_feed.feed_id = FeedId(feed_id_perturb);
        prop_assert!(!d.static_fields_unchanged(&mutated_feed));

        let mut mutated_chain = d.clone();
        mutated_chain.emitter_chain = emitter_chain_perturb;
        prop_assert!(!d.static_fields_unchanged(&mutated_chain));
    }
}
