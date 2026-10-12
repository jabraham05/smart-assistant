import SwiftUI

struct GrowthView: View {
    enum Tab: String, CaseIterable, Identifiable {
        case ideas = "Ideas", learning = "Learning", history = "History"
        var id: String { rawValue }
    }

    @State private var tab: Tab = .ideas

    var body: some View {
        VStack(spacing: 0) {
            Picker("Section", selection: $tab) {
                ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)

            switch tab {
            case .ideas: IdeasList()
            case .learning: LearningPlansList()
            case .history: GrowthHistoryList()
            }
        }
        .navigationTitle("Growth")
    }
}

// MARK: - Ideas (growth opportunities)

private struct IdeasList: View {
    @Environment(AppModel.self) private var model
    @State private var errorText: String?

    var body: some View {
        Loaded(load: { try await $0.growthOpportunities() },
               isEmpty: \.isEmpty,
               emptyTitle: "No ideas yet",
               emptySymbol: "lightbulb",
               emptyMessage: "Patterns Amy notices in your conversations show up here.") { ideas, reload in
            let open = ideas.filter(\.isActionable).sorted { ($0.score ?? 0) > ($1.score ?? 0) }
            let closed = ideas.filter { !$0.isActionable }
            List {
                if let errorText {
                    Text(errorText).foregroundStyle(.red)
                }
                Section {
                    if open.isEmpty { Text("Nothing new to consider.").foregroundStyle(.secondary) }
                    ForEach(open) { idea in
                        IdeaRow(idea: idea)
                            .swipeActions(edge: .leading) {
                                Button("Promote", systemImage: "arrow.up.circle") { act(idea, .promote, reload) }
                                    .tint(.green)
                            }
                            .swipeActions(edge: .trailing) {
                                Button("Dismiss", systemImage: "xmark") { act(idea, .dismiss, reload) }
                                    .tint(.red)
                                Button("Later", systemImage: "clock") { act(idea, .`defer`, reload) }
                                    .tint(.orange)
                            }
                            .contextMenu {
                                Button("Turn into a proposal", systemImage: "arrow.up.circle") { act(idea, .promote, reload) }
                                Button("Revisit later", systemImage: "clock") { act(idea, .`defer`, reload) }
                                Button("Dismiss", systemImage: "xmark", role: .destructive) { act(idea, .dismiss, reload) }
                            }
                    }
                } header: {
                    Text("To consider")
                } footer: {
                    Text("Swipe right to turn an idea into a proposal, left to dismiss or revisit later.")
                }
                if !closed.isEmpty {
                    Section("Already handled") {
                        ForEach(closed) { IdeaRow(idea: $0) }
                    }
                }
            }
        }
    }

    private func act(_ idea: GrowthOpportunity, _ action: APIClient.OpportunityAction, _ reload: @escaping () async -> Void) {
        Task {
            do {
                try await model.client.actOnOpportunity(id: idea.id, action)
                errorText = nil
                await reload()
            } catch {
                model.handle(error)
                errorText = "That didn't go through: \(error.localizedDescription)"
            }
        }
    }
}

private struct IdeaRow: View {
    let idea: GrowthOpportunity

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(idea.title).font(.body.weight(.medium)).lineLimit(2)
                Spacer(minLength: 8)
                StatusBadge(status: idea.status)
            }
            Text(idea.description).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
            HStack(spacing: 10) {
                if let category = idea.category { Tag(text: StatusStyle.humanize(category)) }
                Text(idea.frequency == 1 ? "Seen once" : "Seen \(idea.frequency) times")
                RelativeTime(iso: idea.lastObservedAt)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Learning plans

private struct LearningPlansList: View {
    var body: some View {
        Loaded(load: { try await $0.learningPlans() },
               isEmpty: \.isEmpty,
               emptyTitle: "No learning plans",
               emptySymbol: "graduationcap",
               emptyMessage: "When you approve a growth proposal, Amy's plan to learn it appears here.") { plans, _ in
            List {
                ForEach(plans.sorted { $0.createdAt > $1.createdAt }) { plan in
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(plan.opportunityTitle ?? plan.goal).font(.headline).lineLimit(2)
                                Spacer(minLength: 8)
                                StatusBadge(status: plan.status)
                            }
                            if plan.opportunityTitle != nil {
                                Text(plan.goal).font(.subheadline).foregroundStyle(.secondary)
                            }
                            if !plan.steps.isEmpty {
                                ProgressView(value: Double(plan.completedSteps), total: Double(plan.steps.count)) {
                                    Text("\(plan.completedSteps) of \(plan.steps.count) steps done")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        .padding(.vertical, 4)
                        ForEach(Array(plan.steps.enumerated()), id: \.offset) { _, step in
                            Label {
                                Text(step.description).font(.subheadline)
                            } icon: {
                                Image(systemName: step.status == "completed" ? "checkmark.circle.fill"
                                      : step.status == "failed" ? "xmark.circle.fill" : "circle")
                                    .foregroundStyle(step.status == "completed" ? .green
                                                     : step.status == "failed" ? .red : .secondary)
                            }
                        }
                    }
                }
            }
        }
    }
}

// MARK: - History

private struct GrowthHistoryList: View {
    var body: some View {
        Loaded(load: { try await $0.growthHistory() },
               isEmpty: \.isEmpty,
               emptyTitle: "No history yet",
               emptySymbol: "clock.arrow.circlepath") { entries, _ in
            List(entries.sorted { $0.createdAt > $1.createdAt }) { entry in
                VStack(alignment: .leading, spacing: 4) {
                    Text(StatusStyle.humanize(entry.eventType)).font(.subheadline.weight(.medium))
                    if let title = entry.opportunityTitle {
                        Text(title).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                    }
                    HStack(spacing: 8) {
                        if let category = entry.proposalCategory { Tag(text: StatusStyle.humanize(category)) }
                        RelativeTime(iso: entry.createdAt).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 3)
            }
        }
    }
}
