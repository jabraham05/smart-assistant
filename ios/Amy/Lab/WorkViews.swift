import SwiftUI

// MARK: - Projects

struct ProjectsView: View {
    enum Filter: String, CaseIterable, Identifiable {
        case active = "Active", proposed = "Proposed", done = "Done", all = "All"
        var id: String { rawValue }

        func includes(_ p: LabProject) -> Bool {
            switch self {
            case .active: p.status == "active"
            case .proposed: p.status == "proposed"
            case .done: p.status == "done"
            case .all: true
            }
        }
    }

    @State private var filter: Filter = .active

    var body: some View {
        Loaded(load: { try await $0.labProjects() },
               isEmpty: \.isEmpty,
               emptyTitle: "No projects yet",
               emptySymbol: "folder",
               emptyMessage: "Research and coding projects Amy proposes will show up here.") { projects, reload in
            let shown = projects.filter(filter.includes).sorted { $0.createdAt > $1.createdAt }
            List {
                Section {
                    Picker("Show", selection: $filter) {
                        ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                Section {
                    if shown.isEmpty {
                        Text("No \(filter.rawValue.lowercased()) projects.").foregroundStyle(.secondary)
                    }
                    ForEach(shown) { project in
                        NavigationLink {
                            ProjectDetail(project: project, onDecided: reload)
                        } label: {
                            ProjectRow(project: project)
                        }
                    }
                }
            }
        }
        .navigationTitle("Projects")
    }
}

private struct ProjectRow: View {
    let project: LabProject

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(project.title).font(.body.weight(.medium)).lineLimit(2)
                Spacer(minLength: 8)
                StatusBadge(status: project.status)
            }
            Text(project.rationale).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            HStack(spacing: 8) {
                Label(StatusStyle.humanize(project.activityType),
                      systemImage: project.activityType == "coding" ? "chevron.left.forwardslash.chevron.right" : "magnifyingglass")
                    .labelStyle(.titleAndIcon)
                RelativeTime(iso: project.createdAt)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Coding

struct CodingView: View {
    var body: some View {
        Loaded(load: { try await $0.codingTasks() },
               isEmpty: \.isEmpty,
               emptyTitle: "No coding tasks",
               emptySymbol: "chevron.left.forwardslash.chevron.right",
               emptyMessage: "When Amy writes code for you, the tasks show up here.") { tasks, _ in
            let sorted = tasks.sorted { $0.updatedAt > $1.updatedAt }
            let attention = sorted.filter { ["needs_review_failed", "resource_limit_reached"].contains($0.status) }
            let rest = sorted.filter { !attention.contains($0) }
            List {
                if !attention.isEmpty {
                    Section("Needs attention") {
                        ForEach(attention) { CodingLink(task: $0) }
                    }
                }
                Section(attention.isEmpty ? "" : "Other tasks") {
                    ForEach(rest) { CodingLink(task: $0) }
                }
            }
        }
        .navigationTitle("Coding")
    }
}

private struct CodingLink: View {
    let task: CodingTask

    var body: some View {
        NavigationLink {
            CodingTaskDetail(task: task)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(task.taskDescription).font(.body.weight(.medium)).lineLimit(2)
                    Spacer(minLength: 8)
                    StatusBadge(status: task.status)
                }
                HStack(spacing: 8) {
                    if let repo = RepoName.of(task.targetRepoUrl) {
                        Label(repo, systemImage: "shippingbox")
                    }
                    if task.prUrl != nil {
                        Label("PR", systemImage: "arrow.triangle.pull")
                    }
                    RelativeTime(iso: task.updatedAt)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }
}

private struct CodingTaskDetail: View {
    let task: CodingTask

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(task.taskDescription).font(.title3.weight(.semibold))
                    HStack(spacing: 8) {
                        StatusBadge(status: task.status)
                        if task.attemptCount > 1 { Tag(text: "\(task.attemptCount) attempts") }
                    }
                }
                .padding(.vertical, 4)
            }
            Section("Details") {
                if let repo = RepoName.of(task.targetRepoUrl) {
                    LabeledContent("Repository", value: repo)
                }
                if let latest = task.latestStatus, !latest.isEmpty {
                    LabeledContent("Latest") { Text(StatusStyle.humanize(latest)).multilineTextAlignment(.trailing) }
                }
                LabeledContent("Started") { RelativeTime(iso: task.createdAt) }
                LabeledContent("Updated") { RelativeTime(iso: task.updatedAt) }
                if let pr = task.prUrl, let url = URL(string: pr) {
                    Link(destination: url) { Label("Open pull request", systemImage: "arrow.up.right.square") }
                }
            }
            if let reason = task.reviewerReason, !reason.isEmpty {
                DetailBlock(title: "Reviewer notes", text: reason)
            }
            TaskLogSection(taskId: task.id)
        }
        .navigationTitle("Coding task")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// The task's step-by-step history, newest last, each step expandable.
private struct TaskLogSection: View {
    @Environment(AppModel.self) private var model
    let taskId: Int
    @State private var log: [CodingTaskLogEntry]?
    @State private var errorText: String?

    var body: some View {
        Section("Timeline") {
            if let errorText {
                Text(errorText).foregroundStyle(.red)
            } else if let log {
                if log.isEmpty { Text("No steps recorded yet.").foregroundStyle(.secondary) }
                ForEach(log.sorted { $0.createdAt < $1.createdAt }) { entry in
                    DisclosureGroup {
                        if let error = entry.errorMessage, !error.isEmpty {
                            Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                        }
                        Text(entry.content)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .lineLimit(40)
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: entry.status == "error" ? "xmark.circle.fill" : "checkmark.circle.fill")
                                .foregroundStyle(entry.status == "error" ? .red : .green)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(StatusStyle.humanize(entry.phase)).font(.subheadline.weight(.medium))
                                HStack(spacing: 6) {
                                    if let attempt = entry.attemptNumber { Text("Attempt \(attempt)") }
                                    RelativeTime(iso: entry.createdAt)
                                }
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } else {
                ProgressView()
            }
        }
        .task {
            do {
                log = try await model.client.codingTaskLog(id: taskId)
            } catch {
                model.handle(error)
                errorText = "Couldn't load the timeline: \(error.localizedDescription)"
            }
        }
    }
}

enum RepoName {
    /// "https://github.com/owner/repo(.git)" -> "owner/repo"
    static func of(_ url: String?) -> String? {
        guard let url, let parsed = URL(string: url) else { return nil }
        let parts = parsed.path.split(separator: "/").map(String.init)
        guard parts.count >= 2 else { return parsed.host }
        return "\(parts[0])/\(parts[1].replacingOccurrences(of: ".git", with: ""))"
    }
}
