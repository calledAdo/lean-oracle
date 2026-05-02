//! Shared Hermes sample blob and guardian list used by `oracle_data_tests`,
//! `oracle_integration_tests`, and the `print-hermes` binary.
//!
//! `REAL_HERMES_ACCUMULATOR_HEX` is the raw **`binary.data[0]`** from Hermes. The
//! `REAL_HERMES_EXPECTED_*` constants are the canonical decode from the
//! `lean-oracle-common` crate’s `pyth_accumulator` module for that blob (spot
//! fields / expo / publish times must match Hermes’s own `parsed` view).
//!
//! The hard-coded `REAL_GUARDIAN_SET` list can lag Wormhole mainnet rotations. If
//! the embedded VAA’s `guardian_set_index` changes, **`verify_guardian_quorum`
//! against this list may fail** until addresses are refreshed from chain.

/// Off-chain Wormhole guardian addresses (Ethereum-style 20-byte hex strings).
pub const REAL_GUARDIAN_SET: [&str; 19] = [
    "5893B5A76c3f739645648885bDCcC06cd70a3Cd3",
    "fF6CB952589BDE862c25Ef4392132fb9D4A42157",
    "114De8460193bdf3A2fCf81f86a09765F4762fD1",
    "107A0086b32d7A0977926A205131d8731D39cbEB",
    "8C82B2fd82FaeD2711d59AF0F2499D16e726f6b2",
    "11b39756C042441BE6D8650b69b54EbE715E2343",
    "938f104AEb5581293216ce97d771e0CB721221B1",
    "15e7cAF07C4e3DC8e7C469f92C8Cd88FB8005a20",
    "74a3bf913953D695260D88BC1aA25A4eeE363ef0",
    "000aC0076727b35FBea2dAc28fEE5cCB0fEA768e",
    "AF45Ced136b9D9e24903464AE889F5C8a723FC14",
    "f93124b7c738843CBB89E864c862c38cddCccF95",
    "D2CC37A4dc036a8D232b48f62cDD4731412f4890",
    "DA798F6896A3331F64b48c12D1D57Fd9cbe70811",
    "D1F64e26238811de5553C40f64af41eE1B6057Cc",
    "43ac8f567A31e7850Da532B361988Bfe0d3ae11b",
    "178e21ad2E77AE06711549CFBB1f9c7a9d8096e8",
    "5E1487F35515d02A92753504a8D75471b9f49EdB",
    "6FbEBc898F403E4773E95feB15E80C9A99c8348d",
];

/// Real Hermes Pyth accumulator (PNAU) hex for BTC/USD feed testing.
pub const REAL_HERMES_ACCUMULATOR_HEX: &str = "504e41550100000003b801000000060d02217e8a20d22bfbb62c9b18d55a2583b8215010905aef30778e53bf6d54e4387c66c4ec70cd3273b50648080752525a6d6cdb8165c1a9bf6760d15563f482a46a000354aa569e7f112ff4a7a36ded41db453b31fe36c63f0207f6973e0f21d7a560c8482c9da1b1c8b1c173c26d2c5547a7e168d8235d1402afae031db2086914338900048e1a9c5c698ed61ea4755086366ea5059ab92ea03cb8b801a47055232d827e186931736f325f6cb5c77fd90bb6ac80cd6d01561515301f033449aaa89196529301063ee46fab759a10f62586505f1b774b9d629ac3483a77b9270eda07ab5211afef7d1ec083e058e89f098cae5e28e2e2984780dec2f96098b193f952eb31d989fb0007cab63ef2438ce2694c84d9d11fde54c5cb8d1c417f9531534fed389e49f9b1a2682c895010aaa2889034da42ea03524c1fc820f29668628259a58f283514860e0108a4be8e4a0a09ef7878dcaeb0ca4f9cf16ec9d570ded39483813d8ad0776b036b3a73996c4586f203d26e2a7526a5153eaefbaac37102b6362f602c28e1d754810009e0fd01a1c1c43d50a8d3d19efa96cfa9398741481bf6d3280d924d1a5a18adab31e2edd3ddc36cdb0b680c435e29d247a957f5c71957055fc5867025b752f196010a3ed2e004d35de2c5dcbb2c76fddd68f3e64eb0ea379ccd1bc59dba5e64d223af70a63b4f5075ff5aeba15a2bae490d9b26fdeb691143e5ba992148d3dc7e74a9000bb867aa0718bc4f230c967b8159c54787d0e3643fe0163558d04fe0fa423f83c85f1379d4db25c8ff9506e2881a8107528381586ec88961faefcbc4cd1be9378f000c87e5c091d4c8541be5b4a4c7927d29617684e0815422da49629cf74393055a6b571e2aa2097ce7571287723ffe27e166a51a7eef4ee3b3cae0dc0b44487f5a33000d10725ee024ddce2410672fe5f3db86842ecc66f5d8928239d6d544e14b80cd2b5c11b7e26af4492d768ac6f16bff543e833c422bc529d674b060cb67136e4b59010f4f9552f52b9cfcdac6423397ffc86c79499ea9637d82573fce4113887ce60103333dd9f0b528a24a35b1e4d715fa9c42f276fbd43c41cbb602ae1fe23c48020d0010fd242e2a5616eded987a2e8559ad9e45e3098f1996bfd673f3c2e1acc1b9a316102ee8be174ed203b5f6866eb43c0b4b465d91cf7b4a3dfc5b50cdb88094f81d0069f59d6b00000000001ae101faedac5851e32b9b23b5f9411a8c2bac4aae3ed4dd7b811dd1a72ea4aa71000000000c21723801415557560000000000112f1cd50000271011acb8a957280477ec8acf313a7bc3045bd6323701005500e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b430000071d5aec5fe4000000009c587248fffffff80000000069f59d6b0000000069f59d6b0000071d15221080000000009b4636d80dce40cc88aba021af3c2116cba066d8c36ef808dbd10bb2844a905f71cdbb5f6c7a099a6a37131055e68c4f4384f41b91617ea998b474d5eef5fe25815b02872da587fc6b92b7bfa498fe021ed03b5a1c89d6542ea00fa6297350b2ea99ce8270bb5e0006714f21eef844eb287c911dcb6c7c5331dfce0a5c0ab6f2b50298760a4944e31ddf9969d46616ae509651741a03b25bf86f61e504307d6f4e0937018d0ade14557fe913c42e2acdd30600f93aa0e5f1dd41d1663e2b060fcc501b52ded219b15af73bc5ca9d68a9b60d5e7b2cff15024eea1999d55d5c688dc35accfda38c2cf7d86ca5be4d779e5bba70b9559d7d208e3948986b0ce81ca6e55c56e0a7494687";

/// Pyth price feed id (32 bytes hex, no `0x`) matched by integration tests.
pub const BTC_USD_FEED_ID_HEX: &str =
    "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

// --- Canonical decode of `REAL_HERMES_ACCUMULATOR_HEX` (keep in sync with Hermes).

/// Accumulator/Pyth payload slot (`metadata.slot`).
pub const REAL_HERMES_EXPECTED_ACCUMULATOR_SLOT: u64 = 288_300_245;

/// Guardian set index carried in the embedded VAA (`guardian_set_index`).
pub const REAL_HERMES_EXPECTED_GUARDIAN_SET_INDEX: u32 = 6;

pub const REAL_HERMES_EXPECTED_PRICE: i64 = 7_822_660_886_500;
pub const REAL_HERMES_EXPECTED_CONF: u64 = 2_623_042_120;
pub const REAL_HERMES_EXPECTED_EXPO: i32 = -8;
pub const REAL_HERMES_EXPECTED_PUBLISH_TIME: u64 = 1_777_704_299;
pub const REAL_HERMES_EXPECTED_PREV_PUBLISH_TIME: u64 = 1_777_704_299;
pub const REAL_HERMES_EXPECTED_EMA_PRICE: i64 = 7_821_490_000_000;
pub const REAL_HERMES_EXPECTED_EMA_CONF: u64 = 2_605_070_040;

pub fn decode_hex(hex: &str) -> Result<Vec<u8>, ()> {
    if hex.len() % 2 != 0 {
        return Err(());
    }

    let mut out = Vec::with_capacity(hex.len() / 2);
    let bytes = hex.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let hi = decode_nibble(bytes[i]).ok_or(())?;
        let lo = decode_nibble(bytes[i + 1]).ok_or(())?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

pub fn decode_hex_20(hex: &str) -> Result<[u8; 20], ()> {
    let bytes = decode_hex(hex)?;
    if bytes.len() != 20 {
        return Err(());
    }
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    Ok(out)
}

pub fn decode_hex_32(hex: &str) -> Result<[u8; 32], ()> {
    let bytes = decode_hex(hex)?;
    if bytes.len() != 32 {
        return Err(());
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn decode_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
