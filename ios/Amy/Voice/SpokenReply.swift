import Foundation

/// Decides which parts of a still-streaming reply are ready to be spoken.
/// Pure (no audio) so it's unit-testable: feed it the reply's full text as
/// it grows, get back the newly completed sentences.
struct SpokenReply {
    /// The reply text as of the last update, and how much of it has been
    /// handed out for speaking.
    private(set) var text = ""
    private(set) var spokenUpTo: String.Index

    init() {
        spokenUpTo = text.startIndex
    }

    enum Update: Equatable {
        /// Speak these (in order).
        case speak([String])
        /// The text was replaced, not extended (a backend retry discards the
        /// previous attempt): stop speaking, then speak these.
        case restart([String])
    }

    /// Call with the reply's full content each time it changes.
    mutating func update(_ newText: String) -> Update {
        if newText.hasPrefix(text) {
            text = newText
            return .speak(takeCompleteSentences())
        }
        // Not an extension of what we had - start over on the new text.
        text = newText
        spokenUpTo = text.startIndex
        return .restart(takeCompleteSentences())
    }

    /// Call once the stream ends: whatever's left is the last sentence,
    /// terminated or not.
    mutating func finish() -> [String] {
        let rest = String(text[spokenUpTo...])
        spokenUpTo = text.endIndex
        return Self.speakable(rest).map { [$0] } ?? []
    }

    private mutating func takeCompleteSentences() -> [String] {
        var out: [String] = []
        var cursor = spokenUpTo
        var i = spokenUpTo
        while i < text.endIndex {
            let c = text[i]
            let next = text.index(after: i)
            // A sentence ends at . ! ? followed by whitespace (not "3.5" or
            // "e.g.x"), or at a line break - list items and paragraphs read
            // naturally as separate utterances.
            let endsSentence: Bool
            if c == "\n" {
                endsSentence = true
            } else if ".!?".contains(c) {
                endsSentence = next < text.endIndex && text[next].isWhitespace
            } else {
                endsSentence = false
            }
            if endsSentence {
                if let s = Self.speakable(String(text[cursor..<next])) { out.append(s) }
                cursor = next
            }
            i = next
        }
        spokenUpTo = cursor
        return out
    }

    /// Strips markdown that would otherwise be read aloud ("asterisk
    /// asterisk") and drops fragments with nothing to say.
    static func speakable(_ raw: String) -> String? {
        var s = raw
        // [label](url) -> label
        s = s.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        // Bare URLs aren't worth reading out.
        s = s.replacingOccurrences(of: #"https?://\S+"#, with: "", options: .regularExpression)
        // Headings and list bullets at line start.
        s = s.replacingOccurrences(of: #"(?m)^\s*(#{1,6}\s+|[-*+]\s+)"#, with: "", options: .regularExpression)
        // Emphasis and code markers.
        s = s.replacingOccurrences(of: #"[*_`~]+"#, with: "", options: .regularExpression)
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return s.contains(where: { $0.isLetter || $0.isNumber }) ? s : nil
    }
}
