import Foundation

// Swift ports of chat-ui/src/types/chat.ts - only the shapes Milestone 1
// (chat) actually uses. Field names match the wire format exactly.

enum ISODate {
    /// Honcho timestamps come with or without fractional seconds.
    static func parse(_ s: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}

struct LoginResponse: Decodable, Sendable {
    let ok: Bool
    let token: String
}

/// EnrichedSession - GET /api/sessions.
struct ChatSession: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let isActive: Bool?
    let createdAt: String
    let origin: String
    let lastMessageAt: String
    let preview: String

    enum CodingKeys: String, CodingKey {
        case id, origin, lastMessageAt, preview
        case isActive = "is_active"
        case createdAt = "created_at"
    }
}

/// HonchoMessage - GET /api/sessions/[id]/messages.
struct HistoryMessage: Decodable, Sendable {
    let id: String
    let content: String
    let peerId: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, content
        case peerId = "peer_id"
        case createdAt = "created_at"
    }
}

/// N8nStreamEvent - one NDJSON line of POST /api/chat. Decoding is
/// deliberately lenient (optional metadata fields, unknown types/trace kinds
/// kept as `.other`) so a backend addition degrades to "ignored" rather than
/// "the whole turn fails to decode."
/// ReportBlockPayload - the JSON object inside a `type:"block"` event's
/// `content` string when `blockType == "report"` (agent-service's
/// response_blocks.build_report_block). `blockType` itself isn't a field
/// here - BlockPayload below branches on it before decoding the rest.
struct ReportBlockPayload: Decodable, Sendable, Equatable {
    let title: String
    let body: String
}

/// BlockPayload - the two `type:"block"` shapes agent-service's
/// response_blocks.py emits (docs/agent-service.md's "Adaptive responses"
/// section). `.beatEnd` carries no data: the beat's own text already
/// arrived as ordinary `item` deltas before the marker - it's a pure
/// "finalize the current bubble, a new one starts now" signal. Any other
/// blockType degrades to `.other` rather than failing to decode, same
/// forward-compatibility posture as StreamEvent.Kind's `.other(String)`.
enum BlockPayload: Sendable, Equatable {
    case report(ReportBlockPayload)
    case beatEnd
    case other(String)
}

struct StreamEvent: Decodable, Sendable {
    enum Kind: Sendable, Equatable {
        case begin, item, end, error, trace, ack, block
        case other(String)
    }

    struct Metadata: Decodable, Sendable {
        let nodeId: String?
        let nodeName: String?
        let timestamp: Double?
    }

    private struct BlockEnvelope: Decodable {
        let blockType: String
    }

    let type: Kind
    let content: String?
    let trace: TraceEvent?
    let block: BlockPayload?
    let metadata: Metadata?

    enum CodingKeys: String, CodingKey { case type, content, trace, metadata }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try c.decode(String.self, forKey: .type)
        switch raw {
        case "begin": type = .begin
        case "item": type = .item
        case "end": type = .end
        case "error": type = .error
        case "trace": type = .trace
        case "ack": type = .ack
        case "block": type = .block
        default: type = .other(raw)
        }
        content = try c.decodeIfPresent(String.self, forKey: .content)
        trace = try? c.decodeIfPresent(TraceEvent.self, forKey: .trace)
        metadata = try? c.decodeIfPresent(Metadata.self, forKey: .metadata)

        if type == .block, let content, let data = content.data(using: .utf8),
           let envelope = try? JSONDecoder().decode(BlockEnvelope.self, from: data) {
            switch envelope.blockType {
            case "report":
                block = (try? JSONDecoder().decode(ReportBlockPayload.self, from: data)).map(BlockPayload.report)
            case "beat_end":
                block = .beatEnd
            default:
                block = .other(envelope.blockType)
            }
        } else {
            block = nil
        }
    }
}

/// ChatTraceEvent - only the kinds the reducer acts on are decoded in full.
enum TraceEvent: Decodable, Sendable, Equatable {
    case toolCall(attempt: Int, iteration: Int, name: String)
    case toolResult(attempt: Int, iteration: Int, name: String, isError: Bool)
    case retry(attempt: Int, reason: String)
    case other(String)

    enum CodingKeys: String, CodingKey { case kind, attempt, iteration, name, isError, reason }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        switch kind {
        case "tool_call":
            self = .toolCall(
                attempt: try c.decode(Int.self, forKey: .attempt),
                iteration: try c.decode(Int.self, forKey: .iteration),
                name: try c.decode(String.self, forKey: .name))
        case "tool_result":
            self = .toolResult(
                attempt: try c.decode(Int.self, forKey: .attempt),
                iteration: try c.decode(Int.self, forKey: .iteration),
                name: try c.decode(String.self, forKey: .name),
                isError: try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false)
        case "retry":
            self = .retry(
                attempt: try c.decodeIfPresent(Int.self, forKey: .attempt) ?? 0,
                reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "")
        default:
            self = .other(kind)
        }
    }
}
