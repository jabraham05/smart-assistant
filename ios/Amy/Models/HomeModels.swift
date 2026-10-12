import Foundation

// Swift ports of the Home dashboard shapes in chat-ui/src/types/chat.ts
// and lib/knowledge-engine-client.ts. Field names match the wire format.

struct Goal: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let title: String
    let description: String?
    let status: String

    enum CodingKeys: String, CodingKey { case id, title, description, status }
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
}

struct ProjectsResponse: Decodable, Sendable {
    let projects: [Project]
}
