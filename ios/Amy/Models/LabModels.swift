import Foundation

// Swift ports of the Amy Lab shapes: chat-ui/src/lib/growth-client.ts,
// skills-registry-client.ts, knowledge-engine-client.ts and
// coding-orchestrator-client.ts. Field names match the wire format.

struct Skill: Decodable, Identifiable, Hashable, Sendable {
    let name: String
    let description: String
    let kind: String // instruction | tool_idea
    let status: String
    let instructions: String?
    var id: String { name }
    var isActive: Bool { status == "active" }
}

struct SkillProposal: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let kind: String // instruction | tool_idea
    let name: String
    let description: String
    let reason: String
    let instructions: String?
    let toolIdeaDetails: String?
    let status: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, kind, name, description, reason, instructions, status
        case toolIdeaDetails = "tool_idea_details"
        case createdAt = "created_at"
    }
}

struct GrowthProposal: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let category: String // knowledge | skill | behavior | tool
    let proposedAction: String
    let rationale: String
    let approvalTier: String
    let status: String
    let createdAt: String
    let opportunityTitle: String?
    let currentText: String?
    let proposedText: String?

    enum CodingKeys: String, CodingKey {
        case id, category, rationale, status
        case proposedAction = "proposed_action"
        case approvalTier = "approval_tier"
        case createdAt = "created_at"
        case opportunityTitle = "opportunity_title"
        case currentText = "current_text"
        case proposedText = "proposed_text"
    }
}

struct PersonaProposal: Decodable, Sendable {
    let pending: Bool
    let name: String?
    let systemPrompt: String?
    let proposedSystemPrompt: String?
    let proposedReason: String?
    let proposedAt: String?

    enum CodingKeys: String, CodingKey {
        case pending, name
        case systemPrompt = "system_prompt"
        case proposedSystemPrompt = "proposed_system_prompt"
        case proposedReason = "proposed_reason"
        case proposedAt = "proposed_at"
    }
}

struct GrowthOpportunity: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let title: String
    let description: String
    let category: String?
    let frequency: Int
    let score: Double?
    let status: String // observed | scored | proposed | rejected | dormant
    let lastObservedAt: String

    enum CodingKeys: String, CodingKey {
        case id, title, description, category, frequency, score, status
        case lastObservedAt = "last_observed_at"
    }

    /// Promote / defer / dismiss only make sense before a proposal exists.
    var isActionable: Bool { status == "observed" || status == "scored" }
}

struct LearningPlan: Decodable, Identifiable, Hashable, Sendable {
    struct Step: Decodable, Hashable, Sendable {
        let description: String
        let status: String // pending | completed | failed
    }
    let id: Int
    let goal: String
    let steps: [Step]
    let status: String // active | complete | abandoned
    let createdAt: String
    let opportunityTitle: String?

    enum CodingKeys: String, CodingKey {
        case id, goal, steps, status
        case createdAt = "created_at"
        case opportunityTitle = "opportunity_title"
    }

    var completedSteps: Int { steps.filter { $0.status == "completed" }.count }
}

struct GrowthHistoryEntry: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let eventType: String
    let createdAt: String
    let opportunityTitle: String?
    let proposalCategory: String?

    enum CodingKeys: String, CodingKey {
        case id
        case eventType = "event_type"
        case createdAt = "created_at"
        case opportunityTitle = "opportunity_title"
        case proposalCategory = "proposal_category"
    }
}

/// knowledge-engine project - research or coding work Amy proposes and runs.
struct LabProject: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let title: String
    let rationale: String
    let domain: String?
    let status: String // proposed | active | done | rejected
    let origin: String
    let activityType: String // research | coding
    let researchQueueStatus: String?
    let codingTaskStatus: String?
    let codingTaskPrUrl: String?
    let createdAt: String
    let approvedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, rationale, domain, status, origin
        case activityType = "activity_type"
        case researchQueueStatus = "research_queue_status"
        case codingTaskStatus = "coding_task_status"
        case codingTaskPrUrl = "coding_task_pr_url"
        case createdAt = "created_at"
        case approvedAt = "approved_at"
    }
}

struct CodingTask: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let taskDescription: String
    let targetRepoUrl: String?
    let status: String // running | proposed | needs_review_failed | resource_limit_reached
    let latestStatus: String?
    let attemptCount: Int
    let reviewerReason: String?
    let prUrl: String?
    let createdAt: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, status
        case taskDescription = "task_description"
        case targetRepoUrl = "target_repo_url"
        case latestStatus = "latest_status"
        case attemptCount = "attempt_count"
        case reviewerReason = "reviewer_reason"
        case prUrl = "pr_url"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct CodingTaskLogEntry: Decodable, Identifiable, Hashable, Sendable {
    let id: Int
    let attemptNumber: Int?
    let phase: String
    let status: String // success | error
    let errorMessage: String?
    let content: String
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, phase, status, content
        case attemptNumber = "attempt_number"
        case errorMessage = "error_message"
        case createdAt = "created_at"
    }
}
