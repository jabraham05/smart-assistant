import Foundation

struct ChatStep: Identifiable, Equatable, Sendable {
    enum Status: Sendable { case running, done, error }
    let id: String
    let label: String
    var status: Status
}

struct ChatMessage: Identifiable, Equatable, Sendable {
    enum Role: Sendable { case user, assistant }
    let id: String
    let role: Role
    var content: String
    var createdAt = Date()
    var steps: [ChatStep] = []
    var isEmpty = false
}

/// Port of chat-ui/src/lib/message-reducer.ts's *logic* (not its code).
/// Kept pure so it's unit-testable without a server.
struct ChatReducer {
    /// attempt:iteration:name -> index of that tool call's still-running step.
    private var openSteps: [String: Int] = [:]
    /// The slow-turn opener, kept so a retry can restore it.
    private var ackText = ""
    private(set) var message: ChatMessage

    init(messageId: String) {
        message = ChatMessage(id: messageId, role: .assistant, content: "")
    }

    mutating func apply(_ event: StreamEvent) {
        switch event.type {
        case .item, .ack:
            // Only the AI Agent node's tokens are reply text. "ack" (a
            // server-sent opener for slow turns) renders as the start of the
            // same reply, exactly as the web client does.
            if event.metadata?.nodeName == "AI Agent", let content = event.content {
                message.content += content
                if event.type == .ack { ackText += content }
            }

        case .trace:
            switch event.trace {
            case .retry:
                // The backend discards the previous attempt's text on retry,
                // but already streamed it - drop it here too or the two
                // attempts render as one garbled double reply. The ack is
                // not part of an attempt, so it survives (seen live: wiping
                // it made the opener vanish mid-turn).
                message.content = ackText
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
        if message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            message.content = "No response was generated for that message — try asking again."
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
