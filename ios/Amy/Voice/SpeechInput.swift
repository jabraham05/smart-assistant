import AVFoundation
import Speech

/// Push-to-talk speech-to-text. Runs entirely on the iPhone
/// (`requiresOnDeviceRecognition`) - audio never leaves the phone and the
/// home server only ever sees the resulting text.
@MainActor
final class SpeechInput {
    enum Failure: LocalizedError {
        case speechDenied, micDenied, unavailable, onDeviceUnsupported

        var errorDescription: String? {
            switch self {
            case .speechDenied: "Speech recognition is turned off for Amy. Enable it in Settings → Amy."
            case .micDenied: "Microphone access is turned off for Amy. Enable it in Settings → Amy."
            case .unavailable: "Speech recognition isn't available right now."
            case .onDeviceUnsupported: "On-device speech recognition isn't available for your language."
            }
        }
    }

    private let recognizer = SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var finished = false

    private(set) var transcript = ""
    var onTranscript: ((String) -> Void)?

    /// Asks for speech + microphone permission (prompts only the first time).
    static func authorize() async throws {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else { throw Failure.speechDenied }
        guard await AVAudioApplication.requestRecordPermission() else { throw Failure.micDenied }
    }

    func start() throws {
        guard let recognizer, recognizer.isAvailable else { throw Failure.unavailable }
        guard recognizer.supportsOnDeviceRecognition else { throw Failure.onDeviceUnsupported }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker])
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        request.addsPunctuation = true
        self.request = request
        transcript = ""
        finished = false

        let input = engine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0),
                         block: Self.tap(feeding: request))
        engine.prepare()
        try engine.start()

        task = recognizer.recognitionTask(with: request, resultHandler: Self.results { [weak self] text, isFinal in
            guard let self else { return }
            if let text {
                self.transcript = text
                self.onTranscript?(text)
            }
            if isFinal { self.finished = true }
        })
    }

    /// Stops listening and returns what was said (waits briefly for the
    /// recognizer's final pass, which often fixes up the last word).
    func stop() async -> String {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        for _ in 0..<15 where !finished {
            try? await Task.sleep(for: .milliseconds(100))
        }
        cancel()
        return transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func cancel() {
        if engine.isRunning {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
        }
        task?.cancel()
        task = nil
        request = nil
    }

    // Built outside the main actor on purpose: the tap runs on the audio
    // render thread and the result handler on a recognizer queue. A closure
    // created inside this @MainActor class would inherit main-actor
    // isolation, and Swift 6 traps when it's then called off the main thread.
    private nonisolated static func tap(feeding request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        nonisolated(unsafe) let request = request // append(_:) is documented thread-safe
        return { buffer, _ in request.append(buffer) }
    }

    private nonisolated static func results(
        _ deliver: @escaping @MainActor (String?, Bool) -> Void
    ) -> (SFSpeechRecognitionResult?, Error?) -> Void {
        { result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = (result?.isFinal ?? false) || error != nil
            Task { @MainActor in deliver(text, isFinal) }
        }
    }
}
