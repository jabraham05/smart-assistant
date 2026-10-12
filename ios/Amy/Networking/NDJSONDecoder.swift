import Foundation

/// Splits a byte stream into NDJSON lines on 0x0A only. Not
/// `AsyncBytes.lines`: that also splits on \r, U+2028 and U+2029, and
/// JSON.stringify leaves U+2028/U+2029 unescaped inside strings - a reply
/// containing one would be cut mid-object and that event lost.
struct NDJSONLineSplitter {
    private var buffer: [UInt8] = []

    /// Feeds one byte; returns a complete, non-blank line when 0x0A ends one.
    mutating func append(_ byte: UInt8) -> Data? {
        guard byte == 0x0A else {
            buffer.append(byte)
            return nil
        }
        defer { buffer.removeAll(keepingCapacity: true) }
        return Self.nonBlank(buffer)
    }

    /// Whatever is left after the stream ends without a trailing newline.
    mutating func finish() -> Data? {
        defer { buffer.removeAll() }
        return Self.nonBlank(buffer)
    }

    private static func nonBlank(_ bytes: [UInt8]) -> Data? {
        let isBlank = bytes.allSatisfy { $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }
        return isBlank ? nil : Data(bytes)
    }
}

enum NDJSON {
    /// Decodes every line of a byte sequence into StreamEvents, skipping
    /// lines that aren't valid events (same as useChat.ts's try/catch skip).
    static func events<S: AsyncSequence & Sendable>(from bytes: S) -> AsyncThrowingStream<StreamEvent, Error>
    where S.Element == UInt8 {
        AsyncThrowingStream { continuation in
            let task = Task {
                var splitter = NDJSONLineSplitter()
                let decoder = JSONDecoder()
                do {
                    for try await byte in bytes {
                        if let line = splitter.append(byte),
                           let event = try? decoder.decode(StreamEvent.self, from: line) {
                            continuation.yield(event)
                        }
                    }
                    if let line = splitter.finish(),
                       let event = try? decoder.decode(StreamEvent.self, from: line) {
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
