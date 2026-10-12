import SwiftUI

struct SkillsView: View {
    var body: some View {
        Loaded(load: { try await $0.skills() },
               isEmpty: \.isEmpty,
               emptyTitle: "No skills yet",
               emptySymbol: "sparkles",
               emptyMessage: "Skills appear here once Amy learns them and you approve.") { skills, _ in
            let active = skills.filter(\.isActive)
            let other = skills.filter { !$0.isActive }
            List {
                Section {
                    ForEach(active) { SkillLink(skill: $0) }
                } header: {
                    Text("Active")
                } footer: {
                    Text("Amy uses these when they're relevant to what you ask.")
                }
                if !other.isEmpty {
                    Section("Not in use") {
                        ForEach(other) { SkillLink(skill: $0) }
                    }
                }
            }
        }
        .navigationTitle("Skills")
    }
}

private struct SkillLink: View {
    let skill: Skill

    var body: some View {
        NavigationLink {
            SkillDetail(skill: skill)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(SkillName.display(skill.name)).font(.body.weight(.medium))
                    if skill.kind == "tool_idea" { Tag(text: "Tool idea") }
                }
                Text(skill.description).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            .padding(.vertical, 3)
        }
    }
}

private struct SkillDetail: View {
    let skill: Skill

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(SkillName.display(skill.name)).font(.title3.weight(.semibold))
                    Text(skill.description).font(.subheadline).foregroundStyle(.secondary)
                    HStack(spacing: 8) {
                        StatusBadge(status: skill.status)
                        Tag(text: skill.kind == "tool_idea" ? "Tool idea" : "Instructions")
                    }
                }
                .padding(.vertical, 4)
            }
            if let instructions = skill.instructions, !instructions.isEmpty {
                DetailBlock(title: "How Amy does it", text: instructions)
            }
        }
        .navigationTitle("Skill")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct PersonaView: View {
    var body: some View {
        Loaded(load: { try await $0.persona() },
               isEmpty: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty },
               emptyTitle: "No persona set",
               emptySymbol: "person.text.rectangle") { prompt, _ in
            List {
                Section {
                    Text("This is the guidance Amy follows for her tone and behaviour. Changes arrive as proposals in Review.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                DetailBlock(title: "Persona", text: prompt)
            }
        }
        .navigationTitle("Persona")
    }
}
