import Foundation
import Testing
@testable import Amy

private func meta(_ node: String = "AI Agent") -> String {
    #"{"nodeId":"n1","nodeName":"\#(node)","itemIndex":0,"runIndex":0,"timestamp":1}"#
}

private func event(_ json: String) throws -> StreamEvent {
    try JSONDecoder().decode(StreamEvent.self, from: Data(json.utf8))
}

/// Feature B: ChatReducer.beginNewMessage is the mechanism ChatViewModel's
/// send() loop relies on both to start a new tightly-grouped bubble on a
/// live `block`/`beat_end` marker, and to collapse a mid-turn retry back
/// to one bubble after beats have already split a reply. ChatViewModel's
/// own multi-message loop isn't covered here - APIClient has no fake/
/// injectable seam in this codebase yet, so that needs the manual,
/// against-a-real-dev-backend pass called out in the handoff plan; this
/// file covers the reducer-level mechanics that loop depends on.
@Suite struct BeatStreamTests {
    @Test func beginNewMessageStartsAFreshBubble() throws {
        var r = ChatReducer(messageId: "m1")
        r.apply(try event(#"{"type":"item","content":"beat one","metadata":\#(meta())}"#))
        #expect(r.message.content == "beat one")

        r.beginNewMessage(id: "m2", groupedWithPrevious: true)

        #expect(r.message.id == "m2")
        #expect(r.message.content == "")
        #expect(r.message.groupedWithPrevious)
        #expect(r.message.steps.isEmpty)
    }

    @Test func beginNewMessageDefaultsToNotGrouped() throws {
        // The retry-collapse case reuses this same method but without
        // grouping - the collapsed bubble is beat 1 again, not a new
        // tightly-grouped continuation of a discarded one.
        var r = ChatReducer(messageId: "m1")
        r.beginNewMessage(id: "m1")
        #expect(!r.message.groupedWithPrevious)
    }

    @Test func stepsDoNotCarryOverToANewBeat() throws {
        var r = ChatReducer(messageId: "m1")
        r.apply(try event(
            #"{"type":"trace","trace":{"kind":"tool_call","attempt":0,"iteration":0,"name":"weather_get","args":{}},"metadata":\#(meta())}"#
        ))
        #expect(r.message.steps.count == 1)

        r.beginNewMessage(id: "m2", groupedWithPrevious: true)
        #expect(r.message.steps.isEmpty)

        // A tool result for the OLD step (keyed by attempt:iteration:name,
        // tracked separately from `message.steps`) must not resurrect it
        // on the new, unrelated message.
        r.apply(try event(
            #"{"type":"trace","trace":{"kind":"tool_result","attempt":0,"iteration":0,"name":"weather_get","result":"ok","isError":false},"metadata":\#(meta())}"#
        ))
        #expect(r.message.steps.isEmpty)
    }

    /// The scenario ChatViewModel's retry-collapse branch produces: a beat
    /// already started (simulating a live beat_end having fired), then a
    /// safety-net retry arrives - the turn's ack text must still be there
    /// to restore once the retry's own text starts arriving, exactly as it
    /// would for a plain single-bubble retry with no beats involved (see
    /// StreamingTests.swift's retryKeepsTheAck).
    @Test func retryAfterBeginNewMessageStillRestoresTheAck() throws {
        var r = ChatReducer(messageId: "m1")
        r.apply(try event(#"{"type":"ack","content":"On it.\n\n","metadata":\#(meta())}"#))
        r.apply(try event(#"{"type":"item","content":"beat one","metadata":\#(meta())}"#))

        // ChatViewModel starting a new beat bubble mid-turn.
        r.beginNewMessage(id: "m2", groupedWithPrevious: true)
        r.apply(try event(#"{"type":"item","content":"bad continuation","metadata":\#(meta())}"#))

        // ChatViewModel's retry-collapse: reuse the turn's original id.
        r.beginNewMessage(id: "m1")
        r.apply(try event(
            #"{"type":"trace","trace":{"kind":"retry","attempt":2,"reason":"fabricated_id"},"metadata":\#(meta())}"#
        ))
        #expect(r.message.isRevising)
        r.apply(try event(#"{"type":"item","content":"good","metadata":\#(meta())}"#))

        #expect(r.message.id == "m1")
        #expect(r.message.content == "On it.\n\ngood")
        #expect(!r.message.isRevising)
    }
}
