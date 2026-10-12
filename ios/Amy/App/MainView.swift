import SwiftUI

enum AppSection: String, CaseIterable, Identifiable {
    case chat, home, lab, memory, settings
    var id: String { rawValue }

    var title: String {
        switch self {
        case .chat: "Amy"
        case .home: "Home"
        case .lab: "Amy Lab"
        case .memory: "Memory"
        case .settings: "Settings"
        }
    }

    var icon: String {
        switch self {
        case .chat: "bubble.left.and.text.bubble.right"
        case .home: "house"
        case .lab: "flask"
        case .memory: "brain"
        case .settings: "gearshape"
        }
    }
}

/// Logged-in shell: the main thread is home base; everything else lives
/// behind a ChatGPT-style slide-out menu.
struct MainView: View {
    @State private var section: AppSection = .chat
    @State private var menuOpen = false
    @GestureState private var dragX: CGFloat = 0
    /// Owned here, not by ChatView, so leaving the thread for another
    /// section (mid-reply even) and coming back keeps it intact.
    @State private var thread = ChatViewModel(sessionId: ChatViewModel.mainThreadId)

    private let menuWidth: CGFloat = 290

    var body: some View {
        ZStack(alignment: .leading) {
            NavigationStack {
                content
                    .navigationTitle(section.title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button { setMenu(open: true) } label: {
                                Image(systemName: "line.3.horizontal")
                            }
                            .accessibilityIdentifier("menuButton")
                            .accessibilityLabel("Menu")
                        }
                    }
            }
            .id(section) // fresh navigation stack per section

            // Edge swipe to open, like ChatGPT/Slack.
            Color.clear
                .frame(width: 16)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 10).onEnded { value in
                    if value.translation.width > 60 { setMenu(open: true) }
                })

            if menuOpen || dragX != 0 {
                Color.black.opacity(0.3 * progress)
                    .ignoresSafeArea()
                    .onTapGesture { setMenu(open: false) }
            }

            SideMenu(selection: section) { picked in
                section = picked
                setMenu(open: false)
            }
            .frame(width: menuWidth)
            .offset(x: menuOffset)
            .gesture(
                DragGesture()
                    .updating($dragX) { value, state, _ in state = min(0, value.translation.width) }
                    .onEnded { value in if value.translation.width < -80 { setMenu(open: false) } }
            )
        }
    }

    @ViewBuilder private var content: some View {
        switch section {
        case .chat: ChatView(viewModel: thread)
        case .home: HomeView()
        case .lab: AmyLabView()
        case .memory: ComingSoonView(section: .memory, detail: "What Amy knows - people, places and knowledge search.")
        case .settings: SettingsView()
        }
    }

    private var menuOffset: CGFloat {
        (menuOpen ? 0 : -menuWidth - 20) + dragX
    }

    private var progress: Double {
        menuOpen ? max(0, 1 + dragX / menuWidth) : 0
    }

    private func setMenu(open: Bool) {
        withAnimation(.snappy(duration: 0.25)) { menuOpen = open }
    }
}

private struct SideMenu: View {
    let selection: AppSection
    let onSelect: (AppSection) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Amy")
                .font(.largeTitle.bold())
                .padding(.horizontal, 20)
                .padding(.bottom, 16)
            ForEach(AppSection.allCases.filter { $0 != .settings }) { item in
                row(item)
            }
            Spacer()
            Divider().padding(.horizontal, 20)
            row(.settings)
        }
        .padding(.vertical, 24)
        .frame(maxHeight: .infinity, alignment: .top)
        // Raised surface - plain systemBackground is the same black as the
        // page behind it in dark mode, so the drawer had no edge.
        .background(Color(.secondarySystemBackground))
        .shadow(color: .black.opacity(0.15), radius: 12, x: 4)
    }

    private func row(_ item: AppSection) -> some View {
        Button { onSelect(item) } label: {
            Label(item == .chat ? "Chat" : item.title, systemImage: item.icon)
                .font(.headline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(item == selection ? Color.accentColor.opacity(0.12) : .clear,
                            in: RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal, 8)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("menu-\(item.rawValue)")
    }
}

private struct ComingSoonView: View {
    let section: AppSection
    let detail: String

    var body: some View {
        ContentUnavailableView(section.title, systemImage: section.icon,
                               description: Text("\(detail)\nComing soon."))
    }
}
