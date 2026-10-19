import Foundation

struct ChatStep: Identifiable, Equatable, Sendable {
    enum Status: Sendable { case running, done, error }
    let id: String
    let label: String
    var status: Status
}

/// A single assistant message's content. Always length 1 within one
/// ChatReducer's `message` - a `.report` block REPLACES the `.text` block
/// it was accumulating into (Feature A), it never coexists alongside it.
/// Feature B's multi-text beats are NOT multiple blocks inside one
/// message - they're separate ChatMessages (see `groupedWithPrevious`
/// below), because the tight-grouped visual design needs separate bubble
/// shapes, not blocks stacked in one bubble. ChatViewModel owns creating
/// those separate messages; ChatReducer only ever manages one.
enum ContentBlock: Equatable, Sendable {
    case text(String)
    case report(title: String, body: String)
}

struct ChatMessage: Identifiable, Equatable, Sendable {
    enum Role: Sendable { case user, assistant }
    let id: String
    let role: Role
    var blocks: [ContentBlock]
    var createdAt: Date
    var steps: [ChatStep]
    var isEmpty: Bool
    /// The stream was cut (app backgrounded, network dropped) while the
    /// server keeps working on the turn - waiting for it to land in history.
    var isPending: Bool
    /// The backend is retrying this reply (e.g. it failed a check); the
    /// previous attempt stays on screen until the new one starts arriving.
    var isRevising: Bool
    /// True for every beat after the first one in a multi-text reply
    /// (Feature B) - tells ChatView to use tight ~4pt spacing instead of
    /// the normal 12pt gap between distinct turns. Always false for
    /// historical/reloaded messages - Feature B's beat structure isn't
    /// persisted into chat history storage (see docs/agent-service.md's
    /// "Adaptive responses" section), so a reload never needs it true.
    var groupedWithPrevious: Bool

    init(
        id: String, role: Role, content: String = "", createdAt: Date = Date(), steps: [ChatStep] = [],
        isEmpty: Bool = false, isPending: Bool = false, isRevising: Bool = false, groupedWithPrevious: Bool = false
    ) {
        self.id = id
        self.role = role
        self.blocks = [.text(content)]
        self.createdAt = createdAt
        self.steps = steps
        self.isEmpty = isEmpty
        self.isPending = isPending
        self.isRevising = isRevising
        self.groupedWithPrevious = groupedWithPrevious
    }

    /// Back-compat plain-text view - joins every `.text` block (there's
    /// only ever one in practice, see ContentBlock's doc comment). A
    /// `.report` block contributes nothing here; read it via
    /// `spokenSummary`, or render it via its own card in ChatView.
    var content: String {
        blocks.reduce(into: "") { acc, block in
            if case let .text(s) = block { acc += s }
        }
    }

    /// What VoiceController should actually read aloud - the real text
    /// for a plain reply (Feature B's beats included; a multi-beat turn
    /// is several ChatMessages, and each one's own content is exactly
    /// what was said in that beat), or a short fixed intro instead of the
    /// full body for a report card, since reports are for reading on
    /// screen, not reading aloud.
    var spokenSummary: String {
        for block in blocks {
            if case let .report(title, _) = block {
                return "I've put together a report on \(title) — take a look on your phone."
            }
        }
        return content
    }
}

/// Port of chat-ui/src/lib/message-reducer.ts's *logic* (not its code).
/// Kept pure so it's unit-testable without a server.
struct ChatReducer {
    /// attempt:iteration:name -> index of that tool call's still-running step.
    private var openSteps: [String: Int] = [:]
    /// The slow-turn opener, kept so a retry can restore it.
    private var ackText = ""
    /// Set by a retry: the next reply text replaces the previous attempt.
    private var replaceOnNextText = false
    private(set) var message: ChatMessage

    init(messageId: String) {
        message = ChatMessage(id: messageId, role: .assistant, content: "")
    }

    /// Starts a fresh message - used both when Feature B's beat_end marker
    /// arrives (a new tightly-grouped bubble starts) and when a mid-turn
    /// retry arrives after beats have already split this turn into
    /// several messages (collapses back to one, reusing the original
    /// message's id so SwiftUI's identity-based diffing treats it as the
    /// same view updating, not a new one appearing). Resets steps/
    /// openSteps - tool-call chips are a per-beat display concern, tied
    /// to whichever beat was in flight when the call happened - but
    /// preserves ackText/replaceOnNextText, which describe the whole
    /// turn's retry bookkeeping, not just one beat.
    mutating func beginNewMessage(id: String, groupedWithPrevious: Bool = false) {
        message = ChatMessage(id: id, role: .assistant, content: "", groupedWithPrevious: groupedWithPrevious)
        openSteps = [:]
    }

    /// Appends to the message's current text block, or starts one if the
    /// current block is a `.report` (shouldn't normally happen after a
    /// report has replaced it - a report is only ever emitted right before
    /// `end` - but degrades safely rather than silently dropping text).
    private mutating func appendText(_ text: String) {
        let lastIndex = message.blocks.count - 1
        if case let .text(existing) = message.blocks[lastIndex] {
            message.blocks[lastIndex] = .text(existing + text)
        } else {
            message.blocks.append(.text(text))
        }
    }

    mutating func apply(_ event: StreamEvent) {
        switch event.type {
        case .item, .ack:
            // Only the AI Agent node's tokens are reply text. "ack" (a
            // server-sent opener for slow turns) renders as the start of the
            // same reply, exactly as the web client does.
            if event.metadata?.nodeName == "AI Agent", let content = event.content {
                if event.type == .ack {
                    ackText += content
                } else if replaceOnNextText {
                    // First text of the retried attempt: swap it in for the
                    // previous attempt now, not when the retry was announced.
                    message.blocks = [.text(ackText)]
                    replaceOnNextText = false
                    message.isRevising = false
                }
                appendText(content)
            }

        case .block:
            // Feature A: a report block replaces the text block it was
            // accumulating into. Feature B's beat_end marker carries no
            // data for THIS message - it's a "finalize this one, a new
            // message starts now" signal ChatViewModel acts on directly
            // from the raw event (it owns the one-message-per-beat
            // lifecycle), not something ChatReducer mutates itself.
            if let block = event.block, case let .report(payload) = block {
                message.blocks = [.report(title: payload.title, body: payload.body)]
            }

        case .trace:
            switch event.trace {
            case .retry:
                // The backend discards the previous attempt's text and
                // retries. Wiping it immediately left the bubble blank (or
                // just the ack) for however long the retry took - seen live
                // as a reply that "disappears, then comes back". Keep it on
                // screen, marked as being revised, and replace it when the
                // retry's first text arrives. If the retry produces nothing,
                // the server keeps the first attempt too, so it stays.
                replaceOnNextText = true
                message.isRevising = true
            case let .toolCall(attempt, iteration, name):
                let key = "\(attempt):\(iteration):\(name)"
                openSteps[key] = message.steps.count
                message.steps.append(ChatStep(id: key, label: Self.label(forTool: name), status: .running))
            case let .toolResult(attempt, iteration, name, isError):
                let key = "\(attempt):\(iteration):\(name)"
                if let idx = openSteps.removeValue(forKey: key), message.steps.indices.contains(idx) {
                    message.steps[idx].status = isError ? .error : .done
                }
            case .other, .none:
                break
            }

        case .error:
            message.steps.append(ChatStep(id: "error-\(message.steps.count)", label: "Something went wrong", status: .error))

        case .begin, .end, .other:
            break
        }
    }

    /// Called once the stream closes. A turn can legitimately end with zero
    /// AI Agent tokens (known backend gap) - show something, not a blank bubble.
    mutating func finish() {
        message.isRevising = false
        replaceOnNextText = false
        let hasReport = message.blocks.contains { if case .report = $0 { return true }; return false }
        if !hasReport && message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            message.blocks = [.text("No response was generated for that message — try asking again.")]
            message.isEmpty = true
        }
        for i in message.steps.indices where message.steps[i].status == .running {
            message.steps[i].status = .done
        }
    }

    // chat-ui/src/lib/step-classifier.ts
    static func label(forTool name: String) -> String {
        let labels: [String: String] = [
            "calculate": "Calculating",
            "weather_get": "Checking the weather",
            "memory_recall": "Recalling a memory",
            "spotify_control": "Controlling Spotify",
            "calendar_event": "Managing your calendar",
            "skill_propose": "Proposing a new skill",
            "code_task": "Starting a coding task",
            "code_task_status": "Checking coding task status",
            "dashboard_control": "Adjusting the dashboard",
            "web_search": "Searching the web",
            "knowledge_search": "Searching my knowledge base",
            "knowledge_ingest": "Saving to my knowledge base",
            "research_task": "Starting research",
            "research_task_status": "Checking research progress",
            "goal_manage": "Updating your goals",
        ]
        return labels[name] ?? "Calling \(name)"
    }
}
