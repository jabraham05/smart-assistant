import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) private var model
    let viewModel: ChatViewModel
    /// Past conversations are view-only - the main thread is the one place to talk.
    var readOnly = false
    @State private var draft = ""
    @FocusState private var inputFocused: Bool
    @Environment(\.scenePhase) private var scenePhase
    @Environment(VoiceController.self) private var voice
    @State private var micHeld = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Not LazyVStack: with estimated row heights, scrolling to the
                // bottom right after history loads landed past the content
                // (seen live: an empty-looking thread that was really
                // scrolled out of view). History arrives in 50-message pages
                // anyway, so eager layout costs little.
                VStack(spacing: 12) {
                    topOfThread(proxy: proxy)
                    ForEach(Array(viewModel.messages.enumerated()), id: \.element.id) { index, message in
                        if Self.startsNewDay(at: index, in: viewModel.messages) {
                            DaySeparator(date: message.createdAt)
                        }
                        MessageBubble(message: message,
                                      isStreaming: viewModel.isSending && message.id == viewModel.messages.last?.id)
                            .id(message.id)
                    }
                    if let errorText = viewModel.errorText {
                        Text(errorText)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            // Follow new/streaming content at the bottom - keyed on the last
            // message only, so prepending older history doesn't yank the view.
            .onChange(of: viewModel.messages.last) {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .task {
                await viewModel.loadInitial(client: model.client, onError: model.handle)
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            // Back from the background: catch up on anything that finished
            // (or arrived) while the app was suspended.
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active, !readOnly else { return }
                Task { await viewModel.syncLatest(client: model.client, onError: model.handle) }
            }
            // An interrupted reply: poll until it lands. Cancelled
            // automatically when the view goes away.
            .task(id: viewModel.isAwaitingInterruptedReply) {
                guard viewModel.isAwaitingInterruptedReply else { return }
                await viewModel.awaitInterruptedReply(client: model.client, onError: model.handle)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if !readOnly { inputBar }
        }
    }

    @ViewBuilder private func topOfThread(proxy: ScrollViewProxy) -> some View {
        if viewModel.isLoadingHistory {
            ProgressView().padding()
        } else if viewModel.didLoadInitial && viewModel.hasEarlier {
            // Reaching the top pulls in the next-older page, then restores
            // the reader's place instead of jumping.
            Color.clear.frame(height: 1)
                .onAppear {
                    Task {
                        if let anchor = await viewModel.loadEarlier(client: model.client, onError: model.handle) {
                            proxy.scrollTo(anchor, anchor: .top)
                        }
                    }
                }
        } else if viewModel.didLoadInitial && viewModel.messages.isEmpty && !readOnly {
            ContentUnavailableView("Say hi to Amy", systemImage: "bubble.left.and.text.bubble.right",
                                   description: Text("This is your conversation with Amy."))
                .padding(.top, 80)
        }
    }

    private var inputBar: some View {
        VStack(spacing: 6) {
            if voice.phase == .speaking {
                Button {
                    voice.stopSpeaking()
                } label: {
                    Label("Amy is speaking · Stop", systemImage: "speaker.wave.2.fill")
                        .font(.footnote.weight(.medium))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(.thinMaterial, in: Capsule())
                }
                .buttonStyle(.plain)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityIdentifier("stopSpeakingButton")
            }
            if let voiceError = voice.errorText {
                Text(voiceError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Group {
                    if isListening {
                        Text(voice.liveTranscript.isEmpty ? "Listening…" : voice.liveTranscript)
                            .foregroundStyle(voice.liveTranscript.isEmpty ? .secondary : .primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lineLimit(1...6)
                    } else {
                        TextField("Message Amy", text: $draft, axis: .vertical)
                            .lineLimit(1...6)
                            .focused($inputFocused)
                            .accessibilityIdentifier("messageField")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                .overlay {
                    if isListening {
                        RoundedRectangle(cornerRadius: 18).strokeBorder(Color.red.opacity(0.6), lineWidth: 1.5)
                    }
                }

                if draftIsEmpty {
                    micButton
                } else {
                    Button {
                        let text = draft
                        draft = ""
                        Task { await viewModel.send(text, client: model.client, onError: model.handle) }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
                    }
                    .disabled(viewModel.isSending)
                    .accessibilityIdentifier("sendButton")
                }
            }
        }
        .animation(.snappy(duration: 0.2), value: voice.phase)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var draftIsEmpty: Bool {
        draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var isListening: Bool {
        voice.phase == .listening || voice.phase == .starting
    }

    /// Hold to talk, release to send. A press-and-hold rather than a tap
    /// toggle so the mic is only ever live while your finger is on it.
    private var micButton: some View {
        Image(systemName: isListening ? "mic.circle.fill" : "mic.circle")
            .font(.system(size: 32))
            .foregroundStyle(isListening ? Color.red : Color.accentColor)
            .symbolEffect(.pulse, isActive: voice.phase == .listening)
            .opacity(viewModel.isSending ? 0.4 : 1)
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !viewModel.isSending, !micHeld else { return }
                        micHeld = true
                        inputFocused = false
                        voice.startListening()
                    }
                    .onEnded { _ in
                        guard micHeld else { return }
                        micHeld = false
                        Task {
                            guard let spoken = await voice.finishListening() else { return }
                            await viewModel.send(spoken, client: model.client, speakWith: voice, onError: model.handle)
                        }
                    }
            )
            .accessibilityLabel("Hold to talk")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("micButton")
    }

    static func startsNewDay(at index: Int, in messages: [ChatMessage]) -> Bool {
        guard index > 0 else { return true }
        return !Calendar.current.isDate(messages[index].createdAt, inSameDayAs: messages[index - 1].createdAt)
    }
}

private struct DaySeparator: View {
    let date: Date

    var body: some View {
        Text(label)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.top, 8)
    }

    private var label: String {
        let calendar = Calendar.current
        if date == .distantPast { return "Earlier" }
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        let sameYear = calendar.isDate(date, equalTo: .now, toGranularity: .year)
        return date.formatted(sameYear ? .dateTime.weekday(.wide).month().day() : .dateTime.month().day().year())
    }
}

private struct MessageBubble: View {
    let message: ChatMessage
    let isStreaming: Bool

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 48) }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(message.steps) { step in
                    StepChip(step: step)
                }
                if message.content.isEmpty && isStreaming {
                    TypingIndicator()
                } else if !message.content.isEmpty {
                    Text(Self.render(message.content))
                        .textSelection(.enabled)
                        .foregroundStyle(message.isEmpty || message.isRevising ? .secondary : .primary)
                        .italic(message.isEmpty)
                        .animation(.easeInOut(duration: 0.2), value: message.isRevising)
                }
                if message.isRevising {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Amy is double-checking this reply…")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                if message.isPending {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Amy is finishing this reply…")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(message.role == .user ? Color.accentColor.opacity(0.18) : Color(.secondarySystemBackground),
                        in: RoundedRectangle(cornerRadius: 18))
            if message.role == .assistant { Spacer(minLength: 48) }
        }
    }

    /// Inline markdown (bold, italics, links, code) with line breaks kept.
    /// Mid-stream text is often half-formed markdown, so fall back to plain.
    static func render(_ raw: String) -> AttributedString {
        // The slow-turn "ack" ends in blank lines before the real reply
        // streams in - trimmed so the bubble doesn't sit there half empty.
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

private struct StepChip: View {
    let step: ChatStep

    var body: some View {
        HStack(spacing: 6) {
            switch step.status {
            case .running: ProgressView().controlSize(.mini)
            case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            case .error: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
            Text(step.label)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

private struct TypingIndicator: View {
    var body: some View {
        Image(systemName: "ellipsis")
            .font(.title3)
            .foregroundStyle(.secondary)
            .symbolEffect(.variableColor.iterative, options: .repeating)
            .padding(.vertical, 4)
            .accessibilityLabel("Amy is typing")
    }
}
