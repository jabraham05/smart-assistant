import AVFoundation

/// Reads text aloud on the iPhone with the best voice installed - no server
/// work at all. Download an Enhanced or Premium voice in Settings →
/// Accessibility → Read & Speak → Voices and it's picked up automatically.
@MainActor
final class SpeechOutput: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var queued = 0
    /// Called when everything queued has been spoken (or stopped).
    var onFinished: (() -> Void)?

    var isSpeaking: Bool { queued > 0 }

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ sentences: [String]) {
        guard !sentences.isEmpty else { return }
        if queued == 0 { activateSession() }
        let voice = Self.bestVoice()
        for sentence in sentences {
            let utterance = AVSpeechUtterance(string: sentence)
            utterance.voice = voice
            utterance.prefersAssistiveTechnologySettings = true
            queued += 1
            synthesizer.speak(utterance)
        }
    }

    func stop() {
        guard queued > 0 || synthesizer.isSpeaking else { return }
        synthesizer.stopSpeaking(at: .immediate)
        // didCancel arrives per utterance; settle now so the UI updates at once.
        queued = 0
        finish()
    }

    private func utteranceEnded() {
        guard queued > 0 else { return }
        queued -= 1
        if queued == 0 { finish() }
    }

    private func finish() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        onFinished?()
    }

    /// Spoken-audio playback: keeps going when the phone locks (background
    /// audio mode) and lowers music instead of stopping it.
    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.utteranceEnded() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.utteranceEnded() }
    }

    // MARK: Voice choice

    static func bestVoice(language: String = Locale.preferredLanguages.first ?? "en-US") -> AVSpeechSynthesisVoice? {
        let candidates = AVSpeechSynthesisVoice.speechVoices().map {
            VoiceCandidate(identifier: $0.identifier, language: $0.language,
                           quality: $0.quality.rawValue,
                           isNovelty: $0.voiceTraits.contains(.isNoveltyVoice),
                           isPersonal: $0.voiceTraits.contains(.isPersonalVoice))
        }
        guard let pick = VoiceCandidate.best(candidates, for: language) else {
            return AVSpeechSynthesisVoice(language: language)
        }
        return AVSpeechSynthesisVoice(identifier: pick.identifier)
    }
}

/// Pure voice-ranking logic (unit-tested): same language region first,
/// then highest quality (premium > enhanced > default), no novelty voices
/// (robots, bells) and never the user's own Personal Voice.
struct VoiceCandidate: Equatable {
    let identifier: String
    let language: String
    let quality: Int
    let isNovelty: Bool
    let isPersonal: Bool

    static func best(_ voices: [VoiceCandidate], for language: String) -> VoiceCandidate? {
        let base = language.split(separator: "-").first.map(String.init) ?? language
        let usable = voices.filter { !$0.isNovelty && !$0.isPersonal && $0.language.hasPrefix(base) }
        return usable.max { a, b in
            let aExact = a.language == language, bExact = b.language == language
            if aExact != bExact { return !aExact }
            return a.quality < b.quality
        }
    }
}
