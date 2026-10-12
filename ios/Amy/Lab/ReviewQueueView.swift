import SwiftUI

/// One inbox for everything Amy is waiting on you to decide.
struct ReviewQueue: Sendable {
    var persona: PersonaProposal?
    var growth: [GrowthProposal]
    var skills: [SkillProposal]
    var projects: [LabProject]

    var isEmpty: Bool { persona == nil && growth.isEmpty && skills.isEmpty && projects.isEmpty }

    static func load(_ client: APIClient) async throws -> ReviewQueue {
        async let persona = client.personaProposal()
        async let growth = client.growthProposals(status: "proposed")
        async let skills = client.skillProposals(status: "proposed")
        async let projects = client.labProjects(status: "proposed")
        let p = try await persona
        return ReviewQueue(persona: p.pending ? p : nil,
                           growth: try await growth,
                           skills: try await skills,
                           projects: try await projects)
    }
}

struct ReviewQueueView: View {
    var body: some View {
        Loaded(load: ReviewQueue.load,
               isEmpty: \.isEmpty,
               emptyTitle: "All caught up",
               emptySymbol: "checkmark.circle",
               emptyMessage: "Nothing is waiting on your decision.") { queue, reload in
            List {
                if let persona = queue.persona {
                    Section("Persona change") {
                        NavigationLink {
                            PersonaProposalDetail(proposal: persona, onDecided: reload)
                        } label: {
                            ReviewRow(title: "Update to Amy's persona",
                                      summary: persona.proposedReason ?? "Amy suggests a change to how she talks and behaves.",
                                      tag: "Persona", date: persona.proposedAt)
                        }
                    }
                }
                if !queue.growth.isEmpty {
                    Section("Growth proposals") {
                        ForEach(queue.growth) { proposal in
                            NavigationLink {
                                GrowthProposalDetail(proposal: proposal, onDecided: reload)
                            } label: {
                                ReviewRow(title: proposal.opportunityTitle ?? proposal.proposedAction,
                                          summary: proposal.rationale,
                                          tag: StatusStyle.humanize(proposal.category), date: proposal.createdAt)
                            }
                        }
                    }
                }
                if !queue.skills.isEmpty {
                    Section("New skills") {
                        ForEach(queue.skills) { proposal in
                            NavigationLink {
                                SkillProposalDetail(proposal: proposal, onDecided: reload)
                            } label: {
                                ReviewRow(title: SkillName.display(proposal.name), summary: proposal.description,
                                          tag: proposal.kind == "tool_idea" ? "Tool idea" : "Skill", date: proposal.createdAt)
                            }
                        }
                    }
                }
                if !queue.projects.isEmpty {
                    Section("Projects") {
                        ForEach(queue.projects) { project in
                            NavigationLink {
                                ProjectDetail(project: project, onDecided: reload)
                            } label: {
                                ReviewRow(title: project.title, summary: project.rationale,
                                          tag: StatusStyle.humanize(project.activityType), date: project.createdAt)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Review")
    }
}

private struct ReviewRow: View {
    let title: String
    let summary: String
    let tag: String
    let date: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline).lineLimit(2)
            Text(summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
            HStack(spacing: 8) {
                Tag(text: tag)
                RelativeTime(iso: date).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Detail screens

/// Runs a decision, then goes back and refreshes the list it came from.
private struct DecisionFooter: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var approve = "Approve"
    var decline = "Decline"
    let decide: @Sendable (APIClient, Bool) async throws -> Void
    let onDecided: () async -> Void
    @State private var errorText: String?

    var body: some View {
        Section {
            DecisionButtons(approve: approve, decline: decline) { approved in
                do {
                    try await decide(model.client, approved)
                    await onDecided()
                    dismiss()
                } catch {
                    model.handle(error)
                    errorText = "That didn't go through: \(error.localizedDescription)"
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        } footer: {
            if let errorText { Text(errorText).foregroundStyle(.red) }
        }
    }
}

struct GrowthProposalDetail: View {
    let proposal: GrowthProposal
    let onDecided: () async -> Void

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(proposal.opportunityTitle ?? "Growth proposal").font(.title3.weight(.semibold))
                    HStack {
                        Tag(text: StatusStyle.humanize(proposal.category))
                        RelativeTime(iso: proposal.createdAt).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }
            DetailBlock(title: "What Amy wants to do", text: proposal.proposedAction)
            DetailBlock(title: "Why", text: proposal.rationale)
            if let current = proposal.currentText, !current.isEmpty {
                DetailBlock(title: "Current", text: current)
            }
            if let proposed = proposal.proposedText, !proposed.isEmpty {
                DetailBlock(title: "Proposed", text: proposed)
            }
            DecisionFooter(decide: { try await $0.reviewGrowthProposal(id: proposal.id, approve: $1) },
                           onDecided: onDecided)
        }
        .navigationTitle("Proposal")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct SkillProposalDetail: View {
    let proposal: SkillProposal
    let onDecided: () async -> Void

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(SkillName.display(proposal.name)).font(.title3.weight(.semibold))
                    Text(proposal.description).font(.subheadline).foregroundStyle(.secondary)
                    Tag(text: proposal.kind == "tool_idea" ? "Tool idea" : "Skill")
                }
                .padding(.vertical, 4)
            }
            DetailBlock(title: "Why Amy wants it", text: proposal.reason)
            if let instructions = proposal.instructions, !instructions.isEmpty {
                DetailBlock(title: "How she'd do it", text: instructions)
            }
            if let details = proposal.toolIdeaDetails, !details.isEmpty {
                DetailBlock(title: "Tool details", text: details)
            }
            DecisionFooter(decide: { try await $0.reviewSkillProposal(id: proposal.id, approve: $1) },
                           onDecided: onDecided)
        }
        .navigationTitle("New skill")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct PersonaProposalDetail: View {
    let proposal: PersonaProposal
    let onDecided: () async -> Void

    var body: some View {
        List {
            if let reason = proposal.proposedReason {
                DetailBlock(title: "Why", text: reason)
            }
            if let proposed = proposal.proposedSystemPrompt {
                DetailBlock(title: "Proposed persona", text: proposed)
            }
            if let current = proposal.systemPrompt {
                DetailBlock(title: "Current persona", text: current)
            }
            DecisionFooter(approve: "Apply change", decline: "Dismiss",
                           decide: { try await $0.reviewPersonaProposal(promote: $1) },
                           onDecided: onDecided)
        }
        .navigationTitle("Persona change")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Shared by Review and Projects.
struct ProjectDetail: View {
    let project: LabProject
    var onDecided: (() async -> Void)?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(project.title).font(.title3.weight(.semibold))
                    HStack(spacing: 8) {
                        StatusBadge(status: project.status)
                        Tag(text: StatusStyle.humanize(project.activityType))
                        if let domain = project.domain { Tag(text: StatusStyle.humanize(domain)) }
                    }
                }
                .padding(.vertical, 4)
            }
            DetailBlock(title: "Why", text: project.rationale)
            Section("Progress") {
                if let research = project.researchQueueStatus {
                    LabeledContent("Research") { StatusBadge(status: research) }
                }
                if let coding = project.codingTaskStatus {
                    LabeledContent("Coding") { StatusBadge(status: coding) }
                }
                if let pr = project.codingTaskPrUrl, let url = URL(string: pr) {
                    Link(destination: url) { Label("Open pull request", systemImage: "arrow.up.right.square") }
                }
                LabeledContent("Proposed") { RelativeTime(iso: project.createdAt) }
                if let approved = project.approvedAt {
                    LabeledContent("Approved") { RelativeTime(iso: approved) }
                }
            }
            if project.status == "proposed", let onDecided {
                DecisionFooter(decide: { try await $0.reviewProject(id: project.id, approve: $1) },
                               onDecided: onDecided)
            }
        }
        .navigationTitle("Project")
        .navigationBarTitleDisplayMode(.inline)
    }
}

enum SkillName {
    /// "morning-briefing" -> "Morning briefing"
    static func display(_ slug: String) -> String {
        StatusStyle.humanize(slug)
    }
}
