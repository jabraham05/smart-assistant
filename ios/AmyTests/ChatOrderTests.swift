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

    /// agent-service stores each reply's live layout as metadata, so a
    /// reload (app back from the background, pull to refresh) rebuilds the
    /// report card / beat bubbles instead of flattening them.
    @Test func historyRebuildsAReportCard() throws {
        let shown = ChatViewModel.chronological(try page("""
        [{"id":"2","content":"Solar panels\\n\\nLong body.","peer_id":"amy","created_at":"2026-10-12T00:05:00.000Z",
          "metadata":{"replyLayout":"report","reportTitle":"Solar panels"}}]
        """))
        #expect(shown.count == 1)
        #expect(shown[0].blocks == [.report(title: "Solar panels", body: "Solar panels\n\nLong body.")])
    }

    @Test func historyRebuildsBeatBubbles() throws {
        let shown = ChatViewModel.chronological(try page("""
        [{"id":"2","content":"Hey!\\n\\nSure thing.\\n  \\nWhen?","peer_id":"amy","created_at":"2026-10-12T00:05:00.000Z",
          "metadata":{"replyLayout":"beats"}}]
        """))
        #expect(shown.map(\.content) == ["Hey!", "Sure thing.", "When?"])
        #expect(shown.map(\.id) == ["2", "2-beat1", "2-beat2"])
        #expect(shown.map(\.groupedWithPrevious) == [false, true, true])
    }

    @Test func beatsCapAtFourLikeTheServer() {
        #expect(ChatViewModel.beats(in: "a\n\nb\n\nc\n\nd\n\ne") == ["a", "b", "c", "d\n\ne"])
    }

    @Test func historyWithoutMetadataStaysOneBubble() throws {
        let shown = ChatViewModel.chronological(try page("""
        [{"id":"2","content":"Hey!\\n\\nSure thing.","peer_id":"amy","created_at":"2026-10-12T00:05:00.000Z"}]
        """))
        #expect(shown.map(\.content) == ["Hey!\n\nSure thing."])
    }
}
