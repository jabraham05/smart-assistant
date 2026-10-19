import Foundation
import Observation
import UIKit

@MainActor
@Observable
final class ChatViewModel {
    /// The app's one long-lived conversation with Amy - fixed, not a
    /// per-install UUID, so a reinstall or second device lands back in the
    /// same thread. The web PWA deliberately stays on its own sessions.
    static let mainThreadId = "amy-main"
    static let pageSize = 50

    let sessionId: String
    private(set) var messages: [ChatMessage] = []
    private(set) var isSending = false
    private(set) var isLoadingHistory = false
    private(set) var hasEarlier = true
    private(set) var didLoadInitial = false
    var errorText: String?

    private var nextPage = 1
    /// A turn whose stream was cut before it finished. agent-service runs
    /// turns to completion regardless of the connection, so the reply will
    /// show up in history - this is what we're waiting to see land.
    private var interrupted: (userText: String, sentAt: Date)?
    var isAwaitingInterruptedReply: Bool { interrupted != nil }

    init(sessionId: String) {
        self.sessionId = sessionId
    }

    /// Latest page. Only runs once per view model, so switching menu
    /// sections and back doesn't refetch (or interrupt a streaming reply).
    func loadInitial(client: APIClient, onError: (Error) -> Void) async {
        guard !didLoadInitial else { return }
        await loadPage(client: client, onError: onError)
        didLoadInitial = true
    }

    /// Next-older page, prepended. Returns the id that was at the top
    /// before, so the view can keep the reader's place.
    @discardableResult
    func loadEarlier(client: APIClient, onError: (Error) -> Void) async -> String? {
        guard didLoadInitial, hasEarlier, !isLoadingHistory else { return nil }
        let previousTop = messages.first?.id
        await loadPage(client: client, onError: onError)
        return previousTop
    }

    private func loadPage(client: APIClient, onError: (Error) -> Void) async {
        isLoadingHistory = true
        defer { isLoadingHistory = false }
        do {
            var older: [ChatMessage] = []
            // Pages are newest-first by page number, so every message sent
            // since the first load shifts older pages down by one - a page
            // can come back entirely made of messages already on screen.
            // Keep going until something new turns up or history ends.
            while older.isEmpty && hasEarlier {
                let page = try await client.messages(sessionId: sessionId, page: nextPage, size: Self.pageSize)
                nextPage += 1
                hasEarlier = page.count == Self.pageSize
                let known = Set(messages.map(\.id))
                older = Self.chronological(page).filter { !known.contains($0.id) }
            }
            messages.insert(contentsOf: older, at: 0)
        } catch {
            onError(error)
            errorText = "Couldn't load messages: \(error.localizedDescription)"
        }
    }

    /// `speakWith`: the message was spoken, so read the reply aloud as it
    /// streams (push-to-talk). Typed messages pass nil and stay silent.
    func send(_ text: String, client: APIClient, speakWith voice: VoiceController? = nil,
              onError: (Error) -> Void) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSending else { return }
        errorText = nil
        isSending = true
        defer { isSending = false }

        let sentAt = Date()
        messages.append(ChatMessage(id: UUID().uuidString, role: .user, content: trimmed, createdAt: sentAt))
        let turnMessageId = UUID().uuidString
        var reducer = ChatReducer(messageId: turnMessageId)
        messages.append(reducer.message)
        let turnStartIndex = messages.count - 1
        var index = turnStartIndex

        // Ask iOS for the usual grace period so switching apps mid-reply
        // doesn't suspend us and cut the stream straight away.
        let background = UIApplication.shared.beginBackgroundTask(withName: "amy-reply")
        defer { if background != .invalid { UIApplication.shared.endBackgroundTask(background) } }

        var streamStarted = false
        voice?.beginReply()
        do {
            for try await event in try await client.chat(message: trimmed, sessionId: sessionId) {
                streamStarted = true

                // Feature B: a mid-turn safety-net retry after this reply
                // has already split into several beat bubbles - the whole
                // attempt is being redone, so collapse back to one bubble
                // first, same semantics as a plain single-bubble retry
                // (ChatReducer.apply's own .retry handling, called below,
                // still sets isRevising/replaceOnNextText on it).
                if event.type == .trace, case .retry = event.trace, index > turnStartIndex {
                    messages.removeSubrange((turnStartIndex + 1)...index)
                    index = turnStartIndex
                    reducer.beginNewMessage(id: turnMessageId)
                }

                // Feature B: this beat is done - commit it as-is, then
                // start a new, tightly-grouped bubble for whatever comes
                // next. Carries no content of its own (the beat's text
                // already arrived via ordinary "item" events above).
                if event.type == .block, event.block == .beatEnd {
                    messages[index] = reducer.message
                    reducer.beginNewMessage(id: UUID().uuidString, groupedWithPrevious: true)
                    messages.append(reducer.message)
                    index = messages.count - 1
                    continue
                }

                reducer.apply(event)
                messages[index] = reducer.message
                voice?.replyChanged(reducer.message.spokenSummary)
            }
            reducer.finish()
            if index > turnStartIndex && reducer.message.isEmpty {
                // A trailing beat_end with nothing after it before the
                // stream ended - finish()'s "no response" fallback is
                // right for a turn that produced nothing at all, but wrong
                // here: earlier beats already carried the real reply, so
                // drop this dangling empty bubble instead of appending a
                // confusing fallback message after a perfectly good reply.
                messages.remove(at: index)
            } else {
                messages[index] = reducer.message
                voice?.replyChanged(reducer.message.spokenSummary)
            }
            voice?.replyFinished()
        } catch where streamStarted && Self.isConnectionCut(error) {
            // At least one event arrived, so the server has the turn - and
            // it runs to completion regardless of us (detached turns). Show
            // what arrived and wait for the full reply to land in history.
            // (A failure before any event may mean the request never got
            // there; that's a plain error below, not something to wait on.)
            var partial = reducer.message
            partial.isPending = true
            messages[index] = partial
            voice?.replyFinished()
            interrupted = (trimmed, sentAt)
        } catch {
            onError(error)
            if reducer.message.content.isEmpty {
                messages.remove(at: index)
            } else {
                messages[index] = reducer.message
            }
            errorText = "Message failed: \(error.localizedDescription)"
        }
    }

    /// Re-reads the latest page and makes the tail of the thread match the
    /// server: picks up a reply that finished while the stream was cut, and
    /// anything else that landed while the app was away.
    func syncLatest(client: APIClient, onError: (Error) -> Void) async {
        guard didLoadInitial, !isSending else { return }
        let page: [HistoryMessage]
        do {
            page = try await client.messages(sessionId: sessionId, page: 1, size: Self.pageSize)
        } catch {
            onError(error)
            return
        }
        let latest = Self.chronological(page)
        guard !latest.isEmpty else { return }

        // Keep older pages already scrolled into view; the server's copy
        // replaces everything from the first message it also returned
        // onward. Split by identity, not timestamp - a turn's two
        // messages share one timestamp.
        let latestIds = Set(latest.map(\.id))
        let settled = messages.filter { !$0.isPending }
        let boundary = settled.firstIndex { latestIds.contains($0.id) } ?? settled.endIndex
        let older = Array(settled[..<boundary])
        var merged = older + latest

        if let pending = interrupted {
            // store_turn writes the user message and reply together, so the
            // turn has landed once our message shows up in history.
            let landed = latest.contains {
                $0.role == .user && $0.content == pending.userText && $0.createdAt >= pending.sentAt.addingTimeInterval(-120)
            }
            if landed {
                interrupted = nil
            } else {
                // Not stored yet - keep the local message + placeholder at the end.
                merged += messages.suffix(2)
            }
        }
        messages = merged
    }

    /// Polls for an interrupted turn's reply while the app is in the
    /// foreground. Slow turns (research, coding) can take a few minutes.
    func awaitInterruptedReply(client: APIClient, onError: (Error) -> Void) async {
        let deadline = Date().addingTimeInterval(300)
        while interrupted != nil && Date() < deadline && !Task.isCancelled {
            await syncLatest(client: client, onError: onError)
            if interrupted == nil { return }
            try? await Task.sleep(for: .seconds(4))
        }
        if interrupted != nil {
            interrupted = nil
            for i in messages.indices where messages[i].isPending { messages[i].isPending = false }
            errorText = "Amy's reply didn't arrive. Pull to refresh, or ask again."
        }
    }

    /// A history page in display order. Pages come newest-first, and the
    /// server's order is the truth: store_turn writes the user message and
    /// Amy's reply in one batch, so they share a timestamp and sorting by
    /// time put the reply above the message (seen live).
    nonisolated static func chronological(_ page: [HistoryMessage]) -> [ChatMessage] {
        page.reversed().map {
            ChatMessage(id: $0.id, role: $0.peerId == "user" ? .user : .assistant,
                        content: $0.content, createdAt: ISODate.parse($0.createdAt) ?? .distantPast)
        }
    }

    private static func isConnectionCut(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        guard let urlError = error as? URLError else { return false }
        switch urlError.code {
        case .networkConnectionLost, .notConnectedToInternet, .cancelled, .timedOut,
             .backgroundSessionWasDisconnected:
            return true
        default:
            return false
        }
    }
}
