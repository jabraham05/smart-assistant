import Foundation

// Swift ports of the Home dashboard shapes in chat-ui/src/types/chat.ts
// and lib/knowledge-engine-client.ts. Field names match the wire format.

// Postgres BIGINT/BIGSERIAL ids arrive as JSON *strings* ("12") from
// node-postgres, even though the TS types say `number` (seen live: goals[0].id
// and taskContextId both failed to decode as Int). Accept either.
extension KeyedDecodingContainer {
    func decodeLenientInt(forKey key: Key) throws -> Int {
        if let i = try? decode(Int.self, forKey: key) { return i }
        let s = try decode(String.self, forKey: key)
        guard let i = Int(s) else {
            throw DecodingError.dataCorruptedError(forKey: key, in: self, debugDescription: "not an integer: \(s)")
        }
        return i
    }

    func decodeLenientIntIfPresent(forKey key: Key) throws -> Int? {
        guard contains(key), try !decodeNil(forKey: key) else { return nil }
        return try decodeLenientInt(forKey: key)
    }
}

struct Goal: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let title: String
    let description: String?
    let status: String

    enum CodingKeys: String, CodingKey { case id, title, description, status }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeLenientInt(forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "active"
    }
}

/// TaskContext - both Amy's tasks and the user's todos (`source`).
struct TaskContext: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let objective: String
    let domain: String?
    let status: String
    let nextAction: String?
    let source: String

    enum CodingKeys: String, CodingKey {
        case id, objective, domain, status, source
        case nextAction = "next_action"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeLenientInt(forKey: .id)
        objective = try c.decode(String.self, forKey: .objective)
        domain = try c.decodeIfPresent(String.self, forKey: .domain)
        status = try c.decode(String.self, forKey: .status)
        nextAction = try c.decodeIfPresent(String.self, forKey: .nextAction)
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "amy"
    }

    var isDone: Bool { status == "done" }
    var isMine: Bool { source == "user" }
}

struct UpcomingEvent: Decodable, Identifiable, Hashable, Sendable {
    struct Start: Decodable, Hashable, Sendable {
        let dateTime: String?
        let date: String?
    }
    let id: String
    let summary: String?
    let start: Start?

    /// All-day events only carry `date` (yyyy-MM-dd); timed ones `dateTime`.
    var startDate: (date: Date, allDay: Bool)? {
        if let dt = start?.dateTime, let d = ISODate.parse(dt) { return (d, false) }
        if let day = start?.date {
            let f = DateFormatter()
            f.calendar = Calendar(identifier: .gregorian)
            f.dateFormat = "yyyy-MM-dd"
            if let d = f.date(from: day) { return (d, true) }
        }
        return nil
    }
}

struct HomeSummary: Decodable, Sendable {
    let goals: [Goal]
    let openTasks: [TaskContext]
    let calendarConfigured: Bool
    let upcomingEvents: [UpcomingEvent]
}

struct HomeActivityItem: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let category: String // research | project | task | goal
    let summary: String
    let occurredAt: String
    let taskContextId: Int?

    enum CodingKeys: String, CodingKey { case id, category, summary, occurredAt, taskContextId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        category = try c.decode(String.self, forKey: .category)
        summary = try c.decode(String.self, forKey: .summary)
        occurredAt = try c.decode(String.self, forKey: .occurredAt)
        taskContextId = try c.decodeLenientIntIfPresent(forKey: .taskContextId)
    }
}

struct TaskActivityItem: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let kind: String // note | step | event
    let summary: String
    let occurredAt: String
}

struct TaskContextActivity: Decodable, Sendable {
    let taskContext: TaskContext
    let items: [TaskActivityItem]
}

/// knowledge-engine Project - only what Home's approval row needs.
struct Project: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let title: String
    let rationale: String
    let status: String
    let activityType: String

    enum CodingKeys: String, CodingKey {
        case id, title, rationale, status
        case activityType = "activity_type"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeLenientInt(forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        rationale = try c.decodeIfPresent(String.self, forKey: .rationale) ?? ""
        status = try c.decode(String.self, forKey: .status)
        activityType = try c.decodeIfPresent(String.self, forKey: .activityType) ?? "research"
    }
}

struct ProjectsResponse: Decodable, Sendable {
    let projects: [Project]
}
