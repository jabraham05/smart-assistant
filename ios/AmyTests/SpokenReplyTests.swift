import Testing
@testable import Amy

@Suite struct SpokenReplyTests {
    @Test func speaksOnlyCompletedSentencesAsTheReplyStreams() {
        var r = SpokenReply()
        #expect(r.update("Hello there") == .speak([]))
        #expect(r.update("Hello there. How are") == .speak(["Hello there."]))
        #expect(r.update("Hello there. How are you? I'm") == .speak(["How are you?"]))
        #expect(r.finish() == ["I'm"])
    }

    @Test func decimalsAndAbbreviationsDontSplit() {
        var r = SpokenReply()
        #expect(r.update("It costs 3.50 today.") == .speak([]))
        #expect(r.finish() == ["It costs 3.50 today."])
    }

    @Test func lineBreaksSeparateListItems() {
        var r = SpokenReply()
        #expect(r.update("Options:\n- **Fast** route\n- Slow route\n") ==
                .speak(["Options:", "Fast route", "Slow route"]))
    }

    @Test func aRetryRestartsInsteadOfAppending() {
        var r = SpokenReply()
        _ = r.update("Give me a moment. Wrong answer. ")
        // Backend retry: content reset to the ack, then the new attempt.
        #expect(r.update("Give me a moment. Right") == .restart(["Give me a moment."]))
        #expect(r.finish() == ["Right"])
    }

    @Test func markdownLinksAndUrlsAreCleanedUp() {
        #expect(SpokenReply.speakable("See [the docs](https://x.y/z) or https://a.b now") == "See the docs or  now")
        #expect(SpokenReply.speakable("## Heading") == "Heading")
        #expect(SpokenReply.speakable("`code` and _italics_") == "code and italics")
    }

    @Test func punctuationOnlyFragmentsAreSkipped() {
        #expect(SpokenReply.speakable("---") == nil)
        #expect(SpokenReply.speakable("  \n ") == nil)
    }
}
