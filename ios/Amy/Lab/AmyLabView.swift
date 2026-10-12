import SwiftUI

/// Amy Lab hub: what needs a decision, what Amy can do, what she's working
/// on, and how she's growing - each a tap away.
struct AmyLabView: View {
    @Environment(AppModel.self) private var model
    @State private var counts = LabCounts()

    var body: some View {
        List {
            Section {
                NavigationLink {
                    ReviewQueueView()
                } label: {
                    HubRow(title: "Review", subtitle: "Proposals waiting on your decision",
                           symbol: "tray.full", tint: .orange, count: counts.review, highlight: (counts.review ?? 0) > 0)
                }
            }

            Section("Abilities") {
                NavigationLink { SkillsView() } label: {
                    HubRow(title: "Skills", subtitle: "What Amy knows how to do",
                           symbol: "sparkles", tint: .purple, count: counts.skills)
                }
                NavigationLink { PersonaView() } label: {
                    HubRow(title: "Persona", subtitle: "How Amy talks and behaves",
                           symbol: "person.text.rectangle", tint: .pink)
                }
            }

            Section("Work") {
                NavigationLink { ProjectsView() } label: {
                    HubRow(title: "Projects", subtitle: "Research and coding projects",
                           symbol: "folder", tint: .blue, count: counts.activeProjects)
                }
                NavigationLink { CodingView() } label: {
                    HubRow(title: "Coding", subtitle: "Coding tasks and their progress",
                           symbol: "chevron.left.forwardslash.chevron.right", tint: .teal, count: counts.codingTasks)
                }
            }

            Section("Growth") {
                NavigationLink { GrowthView() } label: {
                    HubRow(title: "Growth", subtitle: "Ideas, learning plans and history",
                           symbol: "chart.line.uptrend.xyaxis", tint: .green)
                }
            }
        }
        .task { await loadCounts() }
        .refreshable { await loadCounts() }
    }

    private func loadCounts() async {
        let client = model.client
        // Independent services - one being down only blanks its own count.
        async let skills = try? client.skills()
        async let skillProposals = try? client.skillProposals(status: "proposed")
        async let growthProposals = try? client.growthProposals(status: "proposed")
        async let persona = try? client.personaProposal()
        async let projects = try? client.labProjects()
        async let coding = try? client.codingTasks()

        let (s, sp, gp, pp, pr, ct) = await (skills, skillProposals, growthProposals, persona, projects, coding)
        let proposedProjects = pr?.filter { $0.status == "proposed" }.count
        var review: Int?
        if sp != nil || gp != nil || pp != nil || pr != nil {
            review = (sp?.count ?? 0) + (gp?.count ?? 0) + (pp?.pending == true ? 1 : 0) + (proposedProjects ?? 0)
        }
        counts = LabCounts(
            review: review,
            skills: s?.filter(\.isActive).count,
            activeProjects: pr?.filter { $0.status == "active" }.count,
            codingTasks: ct?.count
        )
    }
}

struct LabCounts {
    var review: Int?
    var skills: Int?
    var activeProjects: Int?
    var codingTasks: Int?
}

private struct HubRow: View {
    let title: String
    let subtitle: String
    let symbol: String
    let tint: Color
    var count: Int?
    var highlight = false

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(tint.gradient, in: RoundedRectangle(cornerRadius: 7))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.medium))
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let count {
                Text("\(count)")
                    .font(.subheadline.weight(highlight ? .bold : .regular).monospacedDigit())
                    .foregroundStyle(highlight ? .white : .secondary)
                    .padding(.horizontal, highlight ? 8 : 0)
                    .padding(.vertical, highlight ? 2 : 0)
                    .background(highlight ? Color.orange : .clear, in: Capsule())
            }
        }
        .padding(.vertical, 4)
    }
}
