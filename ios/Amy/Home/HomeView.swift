import SwiftUI

@MainActor
@Observable
final class HomeViewModel {
    private(set) var summary: HomeSummary?
    private(set) var activity: [HomeActivityItem] = []
    private(set) var pendingProjects: [Project] = []
    private(set) var isLoading = false
    var errorText: String?

    var openTodos: [TaskContext] { (summary?.openTasks ?? []).filter { !$0.isDone } }

    func load(client: APIClient, onError: (Error) -> Void) async {
        isLoading = true
        defer { isLoading = false }
        // Independent sources (event-bus vs knowledge-engine) - one being
        // down shouldn't blank the whole screen.
        async let summaryResult = capture { try await client.homeSummary() }
        async let activityResult = capture { try await client.homeActivity() }
        async let projectsResult = capture { try await client.projects(status: "proposed") }
        let (s, a, p) = await (summaryResult, activityResult, projectsResult)

        var failures: [String] = []
        switch s {
        case .success(let v): summary = v
        case .failure(let e): onError(e); failures.append("Goals & tasks: \(e.localizedDescription)")
        }
        switch a {
        case .success(let v): activity = v
        case .failure(let e): onError(e); failures.append("Activity: \(e.localizedDescription)")
        }
        switch p {
        case .success(let v): pendingProjects = v.filter { $0.status == "proposed" }
        case .failure(let e): onError(e); failures.append("Approvals: \(e.localizedDescription)")
        }
        errorText = failures.isEmpty ? nil : failures.joined(separator: "\n")
    }

    /// Runs a mutation, then reloads so the screen reflects server truth.
    func perform(_ action: () async throws -> Void, client: APIClient, onError: (Error) -> Void) async {
        do {
            try await action()
        } catch {
            onError(error)
            errorText = "That didn't save: \(error.localizedDescription)"
            return
        }
        await load(client: client, onError: onError)
    }
}

private func capture<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, Error> {
    do { return .success(try await body()) } catch { return .failure(error) }
}

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var vm = HomeViewModel()
    @State private var newTodo = ""
    @State private var editingTodo: TaskContext?
    @State private var editingGoal: Goal?

    var body: some View {
        List {
            if let errorText = vm.errorText {
                Section { Label(errorText, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
            }

            if !vm.pendingProjects.isEmpty {
                Section("Needs your approval") {
                    ForEach(vm.pendingProjects) { project in
                        ApprovalRow(project: project,
                                    onApprove: { run { try await model.client.approveProject(id: project.id) } },
                                    onReject: { run { try await model.client.rejectProject(id: project.id) } })
                    }
                }
            }

            Section {
                HStack {
                    TextField("Add a todo…", text: $newTodo)
                        .submitLabel(.done)
                        .onSubmit(addTodo)
                        .accessibilityIdentifier("newTodoField")
                    if !newTodo.trimmingCharacters(in: .whitespaces).isEmpty {
                        Button("Add", action: addTodo).buttonStyle(.borderless)
                    }
                }
                ForEach(vm.openTodos) { task in
                    NavigationLink(value: task) {
                        TodoRow(task: task) {
                            run { try await model.client.updateTodo(id: task.id, status: "done") }
                        }
                    }
                    .swipeActions(edge: .leading) {
                        Button("Done", systemImage: "checkmark") {
                            run { try await model.client.updateTodo(id: task.id, status: "done") }
                        }
                        .tint(.green)
                    }
                    .swipeActions(edge: .trailing) {
                        Button("Edit", systemImage: "pencil") { editingTodo = task }
                    }
                }
                if vm.summary != nil && vm.openTodos.isEmpty {
                    Text("Nothing on your list.").foregroundStyle(.secondary)
                }
            } header: {
                SectionHeader(title: "Todos", count: vm.openTodos.count)
            }

            Section {
                ForEach(vm.summary?.goals ?? []) { goal in
                    Button { editingGoal = goal } label: { GoalRow(goal: goal) }
                        .buttonStyle(.plain)
                }
                if let summary = vm.summary, summary.goals.isEmpty {
                    Text("No active goals.").foregroundStyle(.secondary)
                }
            } header: {
                SectionHeader(title: "Goals", count: vm.summary?.goals.count ?? 0)
            }

            Section {
                if let summary = vm.summary {
                    if !summary.calendarConfigured {
                        Text("Calendar isn't configured.").foregroundStyle(.secondary)
                    } else if summary.upcomingEvents.isEmpty {
                        Text("Nothing on the calendar this week.").foregroundStyle(.secondary)
                    }
                    ForEach(summary.upcomingEvents) { EventRow(event: $0) }
                }
            } header: {
                SectionHeader(title: "Upcoming", count: vm.summary?.upcomingEvents.count ?? 0)
            }

            Section {
                ForEach(vm.activity) { item in
                    if let taskId = item.taskContextId {
                        NavigationLink(value: TaskLink(id: taskId)) { ActivityRow(item: item) }
                    } else {
                        ActivityRow(item: item)
                    }
                }
                if !vm.isLoading && vm.activity.isEmpty {
                    Text("Nothing recent.").foregroundStyle(.secondary)
                }
            } header: {
                SectionHeader(title: "Activity", count: vm.activity.count)
            }
        }
        .overlay {
            if vm.isLoading && vm.summary == nil { ProgressView() }
        }
        .navigationDestination(for: TaskContext.self) { TaskDetailView(taskId: $0.id) }
        .navigationDestination(for: TaskLink.self) { TaskDetailView(taskId: $0.id) }
        .refreshable { await vm.load(client: model.client, onError: model.handle) }
        .task { await vm.load(client: model.client, onError: model.handle) }
        .sheet(item: $editingTodo) { task in
            EditTextSheet(title: "Edit todo", fields: [("Todo", task.objective)]) { values in
                run { try await model.client.updateTodo(id: task.id, objective: values[0]) }
            }
        }
        .sheet(item: $editingGoal) { goal in
            EditTextSheet(title: "Edit goal",
                          fields: [("Title", goal.title), ("Description", goal.description ?? "")]) { values in
                run { try await model.client.updateGoal(id: goal.id, title: values[0], description: values[1]) }
            }
        }
    }

    private func addTodo() {
        let objective = newTodo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !objective.isEmpty else { return }
        newTodo = ""
        run { try await model.client.createTodo(objective: objective) }
    }

    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        Task { await vm.perform(action, client: model.client, onError: model.handle) }
    }
}

struct TaskLink: Hashable { let id: Int }

private struct SectionHeader: View {
    let title: String
    let count: Int

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            if count > 0 { Text("\(count)").monospacedDigit() }
        }
    }
}

private struct ApprovalRow: View {
    let project: Project
    let onApprove: () -> Void
    let onReject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(project.activityType.capitalized)
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color.orange.opacity(0.15), in: Capsule())
                    .foregroundStyle(.orange)
                Spacer()
            }
            Text(project.title).font(.headline)
            Text(project.rationale).font(.subheadline).foregroundStyle(.secondary)
            HStack {
                Button("Approve", action: onApprove).buttonStyle(.borderedProminent)
                Button("Reject", role: .destructive, action: onReject).buttonStyle(.bordered)
            }
            .controlSize(.small)
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }
}

private struct TodoRow: View {
    let task: TaskContext
    let onDone: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: onDone) {
                Image(systemName: "circle").font(.title3).foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Mark done")
            VStack(alignment: .leading, spacing: 4) {
                Text(task.objective)
                HStack(spacing: 6) {
                    Text(task.isMine ? "you" : "amy")
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(task.isMine ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.15),
                                    in: Capsule())
                    if let next = task.nextAction, !next.isEmpty {
                        Text("Next: \(next)").font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

private struct GoalRow: View {
    let goal: Goal

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(goal.title)
            Text(goal.description?.isEmpty == false ? goal.description! : "Add a description…")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }
}

private struct EventRow: View {
    let event: UpcomingEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(event.summary ?? "(untitled event)")
            if let start = event.startDate {
                Text(start.allDay
                     ? start.date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
                     : start.date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute()))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

struct ActivityRow: View {
    let item: HomeActivityItem

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.summary).font(.subheadline)
                if let date = ISODate.parse(item.occurredAt) {
                    Text(date, format: .relative(presentation: .named))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var icon: String {
        switch item.category {
        case "research": "magnifyingglass"
        case "project": "flask"
        case "task": "checklist"
        case "goal": "target"
        default: "circle"
        }
    }
}

/// Small edit form for one or more text fields; calls back with the new values.
private struct EditTextSheet: View {
    let title: String
    let onSave: ([String]) -> Void
    @State private var values: [String]
    private let labels: [String]
    @Environment(\.dismiss) private var dismiss

    init(title: String, fields: [(String, String)], onSave: @escaping ([String]) -> Void) {
        self.title = title
        self.onSave = onSave
        labels = fields.map(\.0)
        _values = State(initialValue: fields.map(\.1))
    }

    var body: some View {
        NavigationStack {
            Form {
                ForEach(labels.indices, id: \.self) { i in
                    Section(labels[i]) {
                        TextField(labels[i], text: $values[i], axis: .vertical).lineLimit(1...6)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) })
                        dismiss()
                    }
                    .disabled(values.first?.trimmingCharacters(in: .whitespaces).isEmpty ?? true)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
