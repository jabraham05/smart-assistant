import Foundation

// Amy Lab endpoints. Every response is wrapped in a named key by chat-ui
// ({ skills }, { proposals }, ...), unwrapped here.
extension APIClient {
    private struct Wrapped<T: Decodable>: Decodable {
        let value: T
        init(from decoder: Decoder) throws {
            // Exactly one top-level key per response - take its value.
            let c = try decoder.container(keyedBy: AnyKey.self)
            guard let key = c.allKeys.first else {
                throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "empty object"))
            }
            value = try c.decode(T.self, forKey: key)
        }
    }

    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    private func getWrapped<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let wrapped: Wrapped<T> = try await get(path, query: query)
        return wrapped.value
    }

    private func statusQuery(_ status: String?) -> [URLQueryItem] {
        status.map { [URLQueryItem(name: "status", value: $0)] } ?? []
    }

    // MARK: Skills

    func skills() async throws -> [Skill] {
        try await getWrapped("api/skills")
    }

    func skillProposals(status: String? = nil) async throws -> [SkillProposal] {
        try await getWrapped("api/skill-proposals", query: statusQuery(status))
    }

    func reviewSkillProposal(id: Int, approve: Bool) async throws {
        try await write("api/skill-proposals/\(id)/\(approve ? "approve" : "reject")", method: "POST", body: [:])
    }

    // MARK: Growth

    func growthProposals(status: String? = nil) async throws -> [GrowthProposal] {
        try await getWrapped("api/growth/proposals", query: statusQuery(status))
    }

    func reviewGrowthProposal(id: Int, approve: Bool) async throws {
        try await write("api/growth/proposals/\(id)/\(approve ? "approve" : "reject")", method: "POST", body: [:])
    }

    func personaProposal() async throws -> PersonaProposal {
        try await get("api/growth/persona-proposal")
    }

    func reviewPersonaProposal(promote: Bool) async throws {
        try await write("api/growth/persona-proposal/\(promote ? "promote" : "dismiss")", method: "POST", body: [:])
    }

    func growthOpportunities(status: String? = nil) async throws -> [GrowthOpportunity] {
        try await getWrapped("api/growth/opportunities", query: statusQuery(status))
    }

    enum OpportunityAction: String { case promote, `defer`, dismiss }

    func actOnOpportunity(id: Int, _ action: OpportunityAction) async throws {
        try await write("api/growth/opportunities/\(id)/\(action.rawValue)", method: "POST", body: [:])
    }

    func learningPlans() async throws -> [LearningPlan] {
        try await getWrapped("api/growth/learning-plans")
    }

    func growthHistory(limit: Int = 50) async throws -> [GrowthHistoryEntry] {
        try await getWrapped("api/growth/history", query: [URLQueryItem(name: "limit", value: String(limit))])
    }

    func persona() async throws -> String {
        try await getWrapped("api/amy/persona")
    }

    // MARK: Projects & coding

    func labProjects(status: String? = nil) async throws -> [LabProject] {
        try await getWrapped("api/projects", query: statusQuery(status))
    }

    func reviewProject(id: Int, approve: Bool) async throws {
        try await write("api/projects/\(id)/\(approve ? "approve" : "reject")", method: "POST", body: [:])
    }

    func codingTasks() async throws -> [CodingTask] {
        try await getWrapped("api/coding-tasks")
    }

    func codingTaskLog(id: Int) async throws -> [CodingTaskLogEntry] {
        try await getWrapped("api/coding-tasks/\(id)/log")
    }
}
