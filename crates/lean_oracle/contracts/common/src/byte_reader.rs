//! Internal byte-reader utility for strict, cursor-based parsing.
//!
//! This helper ensures that we perform consistent slicing with overflow
//! protection and consistent endianness choices across all protocol parsers.

pub struct ByteReader<'a> {
    data: &'a [u8],
    cursor: usize,
}

impl<'a> ByteReader<'a> {
    /// Create a new reader from a byte slice.
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, cursor: 0 }
    }

    /// Slice `len` bytes from the current position and advance the cursor.
    pub fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let end = self.cursor.checked_add(len)?;
        if end > self.data.len() {
            return None;
        }
        let out = &self.data[self.cursor..end];
        self.cursor = end;
        Some(out)
    }

    /// Read a single byte and advance the cursor.
    pub fn read_u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }

    /// Read a big-endian `u16` and advance the cursor.
    pub fn read_u16_be(&mut self) -> Option<u16> {
        let bytes = self.take(2)?;
        Some(u16::from_be_bytes(bytes.try_into().ok()?))
    }

    /// Read a big-endian `u32` and advance the cursor.
    pub fn read_u32_be(&mut self) -> Option<u32> {
        let bytes = self.take(4)?;
        Some(u32::from_be_bytes(bytes.try_into().ok()?))
    }

    /// Read a big-endian `i32` and advance the cursor.
    pub fn read_i32_be(&mut self) -> Option<i32> {
        let bytes = self.take(4)?;
        Some(i32::from_be_bytes(bytes.try_into().ok()?))
    }

    /// Read a little-endian `u32` and advance the cursor.
    pub fn read_u32_le(&mut self) -> Option<u32> {
        let bytes = self.take(4)?;
        Some(u32::from_le_bytes(bytes.try_into().ok()?))
    }

    /// Read a big-endian `u64` and advance the cursor.
    pub fn read_u64_be(&mut self) -> Option<u64> {
        let bytes = self.take(8)?;
        Some(u64::from_be_bytes(bytes.try_into().ok()?))
    }

    /// Read a big-endian `i64` and advance the cursor.
    pub fn read_i64_be(&mut self) -> Option<i64> {
        let bytes = self.take(8)?;
        Some(i64::from_be_bytes(bytes.try_into().ok()?))
    }

    /// Check if the entire buffer has been consumed.
    pub fn is_finished(&self) -> bool {
        self.cursor == self.data.len()
    }

    /// Get the remaining unconsumed bytes.
    pub fn remaining(&self) -> &'a [u8] {
        &self.data[self.cursor..]
    }
}
