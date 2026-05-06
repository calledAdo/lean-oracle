//! This file defines the internal `ParseError` enum used by protocol parsers.
//!
//! Using a result-based parsing approach allows the code to signal specific
//! reasons for decoding failure, improving auditability and debugging.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseError {
    /// The input buffer ended prematurely while reading a required field.
    Truncated,
    /// The input buffer contained unexpected trailing bytes after parsing.
    TrailingBytes,
    /// A required magic value (e.g., `PNAU`, `AUWV`) did not match.
    WrongMagic,
    /// The protocol version is not supported by this implementation.
    UnsupportedVersion,
    /// The update type or message type is not supported.
    UnsupportedType,
    /// The internal structure of a field was malformed or inconsistent.
    Malformed,
    /// the requested target feed identifier was not found in the batch.
    TargetFeedMissing,
    /// The requested target feed appeared more than once in the batch.
    TargetFeedDuplicate,
}
