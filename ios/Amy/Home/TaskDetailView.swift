import SwiftUI

/// Native twin of the PWA's /tasks/[id] page: one task's full trail of
/// notes, step transitions and tagged events.
struct TaskDetailView: View {
    @Environment(AppModel.self) private var model
    let taskId: Int
    @State private var detail: TaskContextActivity?
    @State private var errorText: String?

    var body: some View {
        List {
            if let errorText {
                Text(errorText).foregroundStyle(.red)
            }
            if let task = detail?.taskContext {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(task.objective).font(.title3.weight(.semibold))
                        HStack(spacing: 6) {
                            Badge(text: task.status.replacingOccurrences(of: "_", with: " "))
                            if let domain = task.domain { Badge(text: domain) }
                            Badge(text: task.isMine ? "you" : "amy")
                        }
                        if let next = task.nextAction, !next.isEmpty, !task.isDone {
                            Text("Next: \(next)").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            if let items = detail?.items {
                Section("History") {
                    if items.isEmpty {
                        Text("No activity yet.").foregroundStyle(.secondary)
                    }
                    ForEach(items) { item in
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: icon(for: item.kind)).foregroundStyle(.secondary).frame(width: 22)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.summary).font(.subheadline)
                                if let date = ISODate.parse(item.occurredAt) {
                                    Text(date.formatted(date: .abbreviated, time: .shortened))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .overlay { if detail == nil && errorText == nil { ProgressView() } }
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            detail = try await model.client.taskActivity(id: taskId)
            errorText = nil
        } catch APIError.badStatus(404) {
            errorText = "This task no longer exists."
        } catch {
            model.handle(error)
            errorText = "Couldn't load this task: \(error.localizedDescription)"
        }
    }

    private func icon(for kind: String) -> String {
        switch kind {
        case "note": "note.text"
        case "step": "arrow.triangle.branch"
        default: "bolt"
        }
    }
}

private struct Badge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(Color.secondary.opacity(0.15), in: Capsule())
    }
}
