import Foundation
import Observation
import UIKit

/// Push-to-talk voice for the chat: hold to talk, release to send, and
/// Amy's reply is read aloud sentence by sentence as it streams in.
/// Only replies to *spoken* messages are read aloud - typing stays silent.
@MainActor
@Observable
final class VoiceController {
    enum Phase: Equatable { case idle, starting, listening, speaking }

    private(set) var phase: Phase = .idle
    /// What's been heard so far while the mic button is held.
    private(set) var liveTranscript = ""
    var errorText: String?

    static let readAloudKey = "readRepliesAloud"
    var readRepliesAloud: Bool {
        get { UserDefaults.standard.object(forKey: Self.readAloudKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: Self.readAloudKey) }
    }

    private let input = SpeechInput()
    private let output = SpeechOutput()
    private var reply = SpokenReply()
    private var starting: Task<Bool, Never>?
    private let haptics = UIImpactFeedbackGenerator(style: .medium)

    init() {
        input.onTranscript = { [weak self] in self?.liveTranscript = $0 }
        output.onFinished = { [weak self] in
            if self?.phase == .speaking { self?.phase = .idle }
        }
    }

    // MARK: Listening

    /// Mic button pressed.
    func startListening() {
        guard phase != .starting, phase != .listening else { return }
        output.stop() // talking over Amy cuts her off
        errorText = nil
        liveTranscript = ""
        phase = .starting
        starting = Task {
            do {
                try await SpeechInput.authorize()
                try input.start()
                phase = .listening
                haptics.impactOccurred()
                return true
            } catch {
                errorText = error.localizedDescription
                phase = .idle
                return false
            }
        }
    }

    /// Mic button released: returns what was said, or nil if nothing was
    /// (including the first press, spent answering the permission prompts).
    func finishListening() async -> String? {
        guard let starting else { return nil }
        self.starting = nil
        guard await starting.value else { return nil }
        let text = await input.stop()
        haptics.impactOccurred(intensity: 0.6)
        phase = .idle
        liveTranscript = ""
        return text.isEmpty ? nil : text
    }

    func cancelListening() {
        starting?.cancel()
        starting = nil
        input.cancel()
        liveTranscript = ""
        if phase != .speaking { phase = .idle }
    }

    // MARK: Speaking a streamed reply

    func beginReply() {
        reply = SpokenReply()
    }

    /// Call with the reply's full text whenever it changes.
    func replyChanged(_ text: String) {
        guard readRepliesAloud else { return }
        switch reply.update(text) {
        case .speak(let sentences):
            say(sentences)
        case .restart(let sentences):
            // A backend retry replaced the reply - don't finish reading the
            // discarded attempt.
            output.stop()
            say(sentences)
        }
    }

    func replyFinished() {
        guard readRepliesAloud else { return }
        say(reply.finish())
    }

    func stopSpeaking() {
        output.stop()
        if phase == .speaking { phase = .idle }
    }

    private func say(_ sentences: [String]) {
        guard !sentences.isEmpty else { return }
        output.speak(sentences)
        if phase == .idle { phase = .speaking }
    }
}
