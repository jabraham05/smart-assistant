import Testing
@testable import Amy

@Suite struct VoiceCandidateTests {
    private func voice(_ id: String, _ lang: String, quality: Int = 1, novelty: Bool = false, personal: Bool = false) -> VoiceCandidate {
        VoiceCandidate(identifier: id, language: lang, quality: quality, isNovelty: novelty, isPersonal: personal)
    }

    @Test func prefersTheHighestQualityVoiceForTheLanguage() {
        let voices = [voice("default", "en-US", quality: 1), voice("premium", "en-US", quality: 3), voice("enhanced", "en-US", quality: 2)]
        #expect(VoiceCandidate.best(voices, for: "en-US")?.identifier == "premium")
    }

    @Test func exactRegionBeatsAnotherRegionOfTheSameLanguage() {
        let voices = [voice("uk-premium", "en-GB", quality: 3), voice("us-default", "en-US", quality: 1)]
        #expect(VoiceCandidate.best(voices, for: "en-US")?.identifier == "us-default")
    }

    @Test func fallsBackToAnotherRegionWhenNeeded() {
        #expect(VoiceCandidate.best([voice("uk", "en-GB")], for: "en-US")?.identifier == "uk")
    }

    @Test func skipsNoveltyAndPersonalVoices() {
        let voices = [voice("bells", "en-US", quality: 3, novelty: true),
                      voice("me", "en-US", quality: 3, personal: true),
                      voice("plain", "en-US", quality: 1)]
        #expect(VoiceCandidate.best(voices, for: "en-US")?.identifier == "plain")
    }

    @Test func otherLanguagesAreNeverPicked() {
        #expect(VoiceCandidate.best([voice("fr", "fr-FR", quality: 3)], for: "en-US") == nil)
    }
}
