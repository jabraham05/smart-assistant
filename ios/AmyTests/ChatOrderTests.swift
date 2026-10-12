import Foundation
import Testing
@testable import Amy

@Suite struct ChatOrderTests {
    private func page(_ json: String) throws -> [HistoryMessage] {
        try JSONDecoder().decode([HistoryMessage].self, from: Data(json.utf8))
    }

    /// store_turn writes both messages in one batch, so they share a
    /// timestamp; the page comes newest-first. The user's message must
    /// still come first.
    @Test func aTurnWithOneTimestampKeepsUserThenAmy() throws {
        let newestFirst = try page("""
        [
          {"id":"4","content":"Sure thing.","peer_id":"amy","created_at":"2026-10-12T00:05:00.000Z"},
          {"id":"3","content":"Can you help?","peer_id":"user","created_at":"2026-10-12T00:05:00.000Z"},
          {"id":"2","content":"Hi!","peer_id":"amy","created_at":"2026-10-12T00:01:00.000Z"},
          {"id":"1","content":"Hello","peer_id":"user","created_at":"2026-10-12T00:01:00.000Z"}
        ]
        """)
        let shown = ChatViewModel.chronological(newestFirst)
        #expect(shown.map(\.content) == ["Hello", "Hi!", "Can you help?", "Sure thing."])
        #expect(shown.map(\.role) == [.user, .assistant, .user, .assistant])
    }
}
