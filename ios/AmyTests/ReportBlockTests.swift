import Foundation
import Testing
@testable import Amy

private func meta(_ node: String = "AI Agent") -> String {
    #"{"nodeId":"n1","nodeName":"\#(node)","itemIndex":0,"runIndex":0,"timestamp":1}"#
}

private func event(_ json: String) throws -> StreamEvent {
    try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8))
}

/// Feature A: a long, structured answer renders as a tappable report card
/// instead of a wall of text. Covers the wire decode (APIModels.swift's
/// BlockPayload) and the reducer's text -> report swap (ChatReducer.swift)
/// - same `event()`/`meta()` helper pattern as StreamingTests.swift.
@Suite struct ReportBlockTests {
    @Test func blockEventWithReportTypeDecodesTheTitleAndBody() throws {
        let e = try event(
            #"{"type":"block","content":"{\"blockType\":\"report\",\"title\":\"Best headphones\",\"body\":\"Full report body.\"}","metadata":\#(meta())}"#
        )
        #expect(e.type == .block)
        #expect(e.block == .report(ReportBlockPayload(title: "Best headphones", body: "Full report body.")))
    }

    @Test func blockEventWithBeatEndTypeDecodesAsAPureMarker() throws {
        let e = try event(#"{"type":"block","content":"{\"blockType\":\"beat_end\"}","metadata":\#(meta())}"#)
        #expect(e.block == .beatEnd)
    }

    @Test func unknownBlockTypeDecodesAsOtherRatherThanFailing() throws {
        let e = try event(#"{"type":"block","content":"{\"blockType\":\"table\"}","metadata":\#(meta())}"#)
        #expect(e.block == .other("table"))
    }

    @Test func reportBlockReplacesTheStreamedTextBlock() throws {
        var r = ChatReducer(messageId: "m")
        r.apply(try event(#"{"type":"item","content":"Here's a long answer...","metadata":\#(meta())}"#))
        r.apply(try event(
            #"{"type":"block","content":"{\"blockType\":\"report\",\"title\":\"Best headphones\",\"body\":\"Full report body.\"}","metadata":\#(meta())}"#
        ))
        #expect(r.message.blocks == [.report(title: "Best headphones", body: "Full report body.")])
        // .report blocks don't contribute to the plain-text accessor - the
        // streamed teaser text is gone, replaced entirely by the card.
        #expect(r.message.content == "")
    }

    @Test func beatEndBlockEventIsANoOpOnTheReducerItself() throws {
        // ChatViewModel (not ChatReducer) owns starting a new message when
        // beat_end arrives - apply() must leave the current message
        // untouched when it sees one; see BeatStreamTests.swift for the
        // reducer-level mechanics ChatViewModel relies on to do that.
        var r = ChatReducer(messageId: "m")
        r.apply(try event(#"{"type":"item","content":"beat one","metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"block","content":"{\"blockType\":\"beat_end\"}","metadata":\#(meta())}"#))
        #expect(r.message.content == "beat one")
    }

    @Test func spokenSummaryIsAShortIntroForAReport() throws {
        var r = ChatReducer(messageId: "m")
        r.apply(try event(
            #"{"type":"block","content":"{\"blockType\":\"report\",\"title\":\"Best headphones\",\"body\":\"Body\"}","metadata":\#(meta())}"#
        ))
        #expect(r.message.spokenSummary == "I've put together a report on Best headphones — take a look on your phone.")
    }

    @Test func spokenSummaryIsPlainContentForAnOrdinaryReply() throws {
        var r = ChatReducer(messageId: "m")
        r.apply(try event(#"{"type":"item","content":"Hello there","metadata":\#(meta())}"#))
        #expect(r.message.spokenSummary == "Hello there")
    }
}
