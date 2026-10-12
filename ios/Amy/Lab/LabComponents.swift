import SwiftUI

// Shared building blocks so every Amy Lab screen reads the same way:
// plain-language labels (never raw status codes), one badge style, one
// loading / error / empty pattern.

/// How a status should read and look.
struct StatusStyle {
    let label: String
    let color: Color

    /// Known statuses across projects, coding tasks, proposals, skills and
    /// growth; anything new still reads cleanly ("some_state" -> "Some state").
    static func of(_ raw: String) -> StatusStyle {
        switch raw {
        case "proposed", "pending", "observed", "scored":
            StatusStyle(label: raw == "scored" ? "Scored" : raw == "observed" ? "Observed" : "Awaiting review", color: .orange)
        case "approved", "active":
            StatusStyle(label: raw == "active" ? "Active" : "Approved", color: .blue)
        case "running", "researching", "in_progress":
            StatusStyle(label: "In progress", color: .blue)
        case "done", "complete", "completed", "success", "merged":
            StatusStyle(label: "Done", color: .green)
        case "rejected", "dismissed":
            StatusStyle(label: "Declined", color: .secondary)
        case "dormant", "abandoned", "inactive", "deferred":
            StatusStyle(label: raw == "abandoned" ? "Abandoned" : "Paused", color: .secondary)
        case "needs_review_failed":
            StatusStyle(label: "Needs attention", color: .red)
        case "resource_limit_reached":
            StatusStyle(label: "Hit resource limit", color: .red)
        case "failed", "error":
            StatusStyle(label: "Failed", color: .red)
        default:
            StatusStyle(label: humanize(raw), color: .secondary)
        }
    }

    static func humanize(_ raw: String) -> String {
        let words = raw.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}

struct StatusBadge: View {
    let status: String

    var body: some View {
        let style = StatusStyle.of(status)
        Text(style.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(style.color)
            .background(style.color.opacity(0.14), in: Capsule())
    }
}

/// Small neutral tag (category, kind, origin).
struct Tag: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .foregroundStyle(.secondary)
            .background(Color.secondary.opacity(0.12), in: Capsule())
    }
}

/// "3 days ago" from an ISO timestamp; empty when unparseable.
struct RelativeTime: View {
    let iso: String?

    var body: some View {
        if let iso, let date = ISODate.parse(iso) {
            Text(date, format: .relative(presentation: .named))
        }
    }
}

/// A titled block of long-form text on a detail screen, rendered as
/// markdown when it parses, selectable.
struct DetailBlock: View {
    let title: String
    let text: String

    var body: some View {
        Section(title) {
            Text(Self.render(text))
                .font(.callout)
                .textSelection(.enabled)
                .padding(.vertical, 4)
        }
    }

    static func render(_ raw: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: raw.trimmingCharacters(in: .whitespacesAndNewlines), options: options))
            ?? AttributedString(raw)
    }
}

/// Approve / decline pair with a confirmation, used by every review item.
struct DecisionButtons: View {
    let approveLabel: String
    let declineLabel: String
    let onDecide: (Bool) async -> Void
    @State private var pending: Bool?
    @State private var working = false

    init(approve: String = "Approve", decline: String = "Decline", onDecide: @escaping (Bool) async -> Void) {
        approveLabel = approve
        declineLabel = decline
        self.onDecide = onDecide
    }

    var body: some View {
        HStack(spacing: 12) {
            Button {
                pending = true
            } label: {
                Text(approveLabel).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)

            Button(role: .destructive) {
                pending = false
            } label: {
                Text(declineLabel).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
        }
        .controlSize(.large)
        .disabled(working)
        .confirmationDialog(pending == true ? "\(approveLabel)?" : "\(declineLabel)?",
                            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                            titleVisibility: .visible) {
            if let decision = pending {
                Button(decision ? approveLabel : declineLabel, role: decision ? nil : .destructive) {
                    Task {
                        working = true
                        await onDecide(decision)
                        working = false
                    }
                }
            }
        }
    }
}

/// Loads `T` once (and on pull-to-refresh), with consistent loading,
/// error and empty states. The content closure gets the loaded value.
struct Loaded<T: Sendable, Content: View>: View {
    @Environment(AppModel.self) private var model
    let load: @Sendable (APIClient) async throws -> T
    var isEmpty: (T) -> Bool = { _ in false }
    var emptyTitle = "Nothing here yet"
    var emptySymbol = "tray"
    var emptyMessage: String? = nil
    @ViewBuilder let content: (T, _ reload: @escaping () async -> Void) -> Content

    @State private var value: T?
    @State private var errorText: String?

    var body: some View {
        Group {
            if let value {
                if isEmpty(value) {
                    ContentUnavailableView {
                        Label(emptyTitle, systemImage: emptySymbol)
                    } description: {
                        if let emptyMessage { Text(emptyMessage) }
                    }
                } else {
                    content(value, reload)
                }
            } else if let errorText {
                ContentUnavailableView {
                    Label("Couldn't load", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(errorText)
                } actions: {
                    Button("Try again") { Task { await reload() } }
                }
            } else {
                ProgressView()
            }
        }
        .task { if value == nil { await reload() } }
        .refreshable { await reload() }
    }

    private func reload() async {
        do {
            value = try await load(model.client)
            errorText = nil
        } catch {
            model.handle(error)
            if value == nil { errorText = error.localizedDescription }
        }
    }
}
