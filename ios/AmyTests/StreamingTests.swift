import Foundation
import Testing
@testable import Amy

private func bytes(_ s: String) -> AsyncStream<UInt8> {
    AsyncStream { c in
        for b in Array(s.utf8) { c.yield(b) }
        c.finish()
    }
}

private func collect(_ s: String) async throws -> [StreamEvent] {
    var out: [StreamEvent] = []
    for try await e in NDJSON.events(from: bytes(s)) { out.append(e) }
    return out
}

private func meta(_ node: String = "AI Agent") -> String {
    #"{"nodeId":"n1","nodeName":"\#(node)","itemIndex":0,"runIndex":0,"timestamp":1}"#
}

private func event(_ json: String) throws -> StreamEvent {
    try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8))
}

@Suite struct NDJSONTests {
    @Test func splitsLinesAndSkipsBlankAndInvalid() async throws {
        let body = """
        {"type":"begin","metadata":\(meta())}

        not json at all
        {"type":"item","content":"Hi","metadata":\(meta())}
        {"type":"end","metadata":\(meta())}
        """
        let events = try await collect(body)
        #expect(events.map(\.type) == [.begin, .item, .end])
    }

    @Test func keepsFinalLineWithoutTrailingNewline() async throws {
        let events = try await collect(#"{"type":"item","content":"a","metadata":\#(meta())}"#)
        #expect(events.count == 1)
    }

    /// JSON.stringify doesn't escape U+2028 - a line-reader that treats it as
    /// a line break would cut this event in half and drop it.
    @Test func doesNotSplitOnUnicodeLineSeparator() async throws {
        let body = "{\"type\":\"item\",\"content\":\"one\u{2028}two\",\"metadata\":\(meta())}\n"
        let events = try await collect(body)
        #expect(events.count == 1)
        #expect(events.first?.content == "one\u{2028}two")
    }

    @Test func toleratesCRLF() async throws {
        let body = "{\"type\":\"item\",\"content\":\"x\",\"metadata\":\(meta())}\r\n"
        #expect(try await collect(body).count == 1)
    }

    @Test func unknownTypeAndTraceKindDecodeAsOther() throws {
        let e = try event(#"{"type":"mystery","metadata":\#(meta())}"#)
        #expect(e.type == .other("mystery"))
        let t = try event(#"{"type":"trace","trace":{"kind":"classify","boundTools":[]},"metadata":\#(meta())}"#)
        #expect(t.trace == .other("classify"))
    }
}

@Suite struct ChatReducerTests {
    @Test func onlyAIAgentItemsBecomeReplyText() throws {
        var r = ChatReducer(messageId: "m")
        r.apply(try event(#"{"type":"item","content":"internal","metadata":\#(meta("Router"))}"#))
        r.apply(try event(#"{"type":"item","content":"Hello ","metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"item","content":"there","metadata":\#(meta())}"#))
        #expect(r.message.content == "Hello there")
    }

    @Test func ackIsTheStartOfTheReply() throws {
        var r = ChatReducer(messageId: "m")
        r.apply(try event(#"{"type":"ack","content":"On it. ","metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"item","content":"Done.","metadata":\#(meta())}"#))
        #expect(r.message.content == "On it. Done.")
    }

    @Test func retryDiscardsPriorAttemptText() throws {
        var r = ChatReducer(messageId: "m")
        r.apply(try event(#"{"type":"item","content":"bad attempt","metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"trace","trace":{"kind":"retry","attempt":1,"reason":"fabricated_id"},"metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"item","content":"good","metadata":\#(meta())}"#))
        #expect(r.message.content == "good")
    }

    @Test func retryKeepsTheAck() throws {
        var r = ChatReducer(messageId: "m")
        r.apply(try event(#"{"type":"ack","content":"Give me a moment.\n\n","metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"item","content":"bad","metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"trace","trace":{"kind":"retry","attempt":1,"reason":"empty_output"},"metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"item","content":"good","metadata":\#(meta())}"#))
        #expect(r.message.content == "Give me a moment.\n\ngood")
    }

    /// A retry must not blank the bubble while the next attempt runs.
    @Test func retryKeepsThePreviousAttemptVisibleUntilNewTextArrives() throws {
        var r = ChatReducer(messageId: "m")
        r.apply(try event(#"{"type":"item","content":"First try.","metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"trace","trace":{"kind":"retry","attempt":2,"reason":"confabulation"},"metadata":\#(meta())}"#))
        #expect(r.message.content == "First try.")
        #expect(r.message.isRevising)
        // Tool activity during the retry doesn't replace the text either.
        r.apply(try event(#"{"type":"trace","trace":{"kind":"tool_call","attempt":2,"iteration":1,"name":"web_search","args":{}},"metadata":\#(meta())}"#))
        #expect(r.message.content == "First try.")
        r.apply(try event(#"{"type":"item","content":"Second","metadata":\#(meta())}"#))
        #expect(r.message.content == "Second")
        #expect(!r.message.isRevising)
        r.apply(try event(#"{"type":"item","content":" try.","metadata":\#(meta())}"#))
        #expect(r.message.content == "Second try.")
    }

    /// When the retry yields nothing the server keeps the first attempt - so does the app.
    @Test func aRetryWithNoNewTextKeepsTheFirstAttempt() throws {
        var r = ChatReducer(messageId: "m")
        r.apply(try event(#"{"type":"item","content":"Only answer.","metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"trace","trace":{"kind":"retry","attempt":2,"reason":"search_intent"},"metadata":\#(meta())}"#))
        r.finish()
        #expect(r.message.content == "Only answer.")
        #expect(!r.message.isRevising)
        #expect(!r.message.isEmpty)
    }

    /// tone_backstop: retry + the cleaned full text in one item.
    @Test func toneBackstopReplacesWithTheCleanedText() throws {
        var r = ChatReducer(messageId: "m")
        r.apply(try event(#"{"type":"item","content":"Done! Let me know if you need anything else.","metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"trace","trace":{"kind":"retry","attempt":2,"reason":"tone_backstop"},"metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"item","content":"Done!","metadata":\#(meta())}"#))
        #expect(r.message.content == "Done!")
    }

    @Test func toolResultClosesItsOwnCall() throws {
        var r = ChatReducer(messageId: "m")
        r.apply(try event(#"{"type":"trace","trace":{"kind":"tool_call","attempt":0,"iteration":0,"name":"web_search","args":{"q":"x"}},"metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"trace","trace":{"kind":"tool_call","attempt":0,"iteration":1,"name":"web_search","args":{}},"metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"trace","trace":{"kind":"tool_result","attempt":0,"iteration":0,"name":"web_search","result":"ok","isError":false},"metadata":\#(meta())}"#))
        #expect(r.message.steps.map(\.status) == [.done, .running])
        #expect(r.message.steps.first?.label == "Searching the web")
    }

    @Test func emptyTurnGetsFallbackText() {
        var r = ChatReducer(messageId: "m")
        r.finish()
        #expect(r.message.isEmpty)
        #expect(!r.message.content.isEmpty)
    }
}
