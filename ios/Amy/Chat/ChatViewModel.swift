import Foundation
import Observation

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
            let page = try await client.messages(sessionId: sessionId, page: nextPage, size: Self.pageSize)
            nextPage += 1
            let known = Set(messages.map(\.id))
            // Order by timestamp, never by server order: a server without
            // the newest-first paging change returns oldest-first and
            // ignores page/size (seen live: the thread rendered backwards).
            let older = page
                .filter { !known.contains($0.id) }
                .map {
                    ChatMessage(id: $0.id, role: $0.peerId == "user" ? .user : .assistant,
                                content: $0.content, createdAt: ISODate.parse($0.createdAt) ?? .distantPast)
                }
                .sorted { $0.createdAt < $1.createdAt }
            // A full page with nothing new means the server isn't paging -
            // stop asking rather than refetch the same page forever.
            hasEarlier = page.count == Self.pageSize && !older.isEmpty
            messages.insert(contentsOf: older, at: 0)
        } catch {
            onError(error)
            errorText = "Couldn't load messages: \(error.localizedDescription)"
        }
    }

    func send(_ text: String, client: APIClient, onError: (Error) -> Void) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSending else { return }
        errorText = nil
        isSending = true
        defer { isSending = false }

        messages.append(ChatMessage(id: UUID().uuidString, role: .user, content: trimmed))
        var reducer = ChatReducer(messageId: UUID().uuidString)
        messages.append(reducer.message)
        let index = messages.count - 1

        do {
            for try await event in try await client.chat(message: trimmed, sessionId: sessionId) {
                reducer.apply(event)
                messages[index] = reducer.message
            }
            reducer.finish()
            messages[index] = reducer.message
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
}
