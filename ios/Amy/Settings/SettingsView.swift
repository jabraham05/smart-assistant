import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @AppStorage(Appearance.storageKey) private var appearance: Appearance = .system

    var body: some View {
        @Bindable var model = model
        Form {
            Section("Appearance") {
                Picker("Appearance", selection: $appearance) {
                    ForEach(Appearance.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("appearancePicker")
            }
            Section("Conversations") {
                NavigationLink("Past conversations") { PastConversationsView() }
            }
            Section("Server") {
                TextField("Server URL", text: $model.serverURL)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            Section {
                Button("Log out", role: .destructive) { model.logout() }
            }
        }
    }
}

/// Read-only archive of the older per-session chats (web, Discord, CLI).
/// The main thread itself is excluded - it's the Chat screen.
struct PastConversationsView: View {
    @Environment(AppModel.self) private var model
    @State private var sessions: [ChatSession] = []
    @State private var isLoading = true
    @State private var errorText: String?

    var body: some View {
        List {
            if let errorText {
                Text(errorText).foregroundStyle(.red)
            }
            ForEach(sessions) { session in
                NavigationLink {
                    PastConversationView(session: session)
                } label: {
                    SessionRow(session: session)
                }
            }
        }
        .overlay {
            if isLoading && sessions.isEmpty {
                ProgressView()
            } else if sessions.isEmpty && errorText == nil {
                ContentUnavailableView("No past conversations", systemImage: "archivebox")
            }
        }
        .navigationTitle("Past conversations")
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            sessions = try await model.client.sessions()
                .filter { $0.id != ChatViewModel.mainThreadId }
                .sorted { $0.lastMessageAt > $1.lastMessageAt }
            errorText = nil
        } catch {
            model.handle(error)
            errorText = "Couldn't load conversations: \(error.localizedDescription)"
        }
    }
}

private struct PastConversationView: View {
    let session: ChatSession
    @State private var viewModel: ChatViewModel

    init(session: ChatSession) {
        self.session = session
        _viewModel = State(initialValue: ChatViewModel(sessionId: session.id))
    }

    var body: some View {
        ChatView(viewModel: viewModel, readOnly: true)
            .navigationTitle(session.preview.isEmpty ? "Conversation" : session.preview)
            .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SessionRow: View {
    let session: ChatSession

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(session.preview.isEmpty ? "Conversation" : session.preview)
                    .lineLimit(2)
                Spacer()
                Text(session.origin)
                    .font(.caption2)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
            }
            if let date = ISODate.parse(session.lastMessageAt) {
                Text(date, format: .relative(presentation: .named))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
