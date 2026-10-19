import SwiftUI

/// Feature A's full-screen report reader - presented as a sheet from a
/// ReportCardView tap (see ChatView.swift). A large hero header (title +
/// "Report · {date}" byline) inside the scrolling content, not a plain
/// navigationTitle - reads as an article, not another settings-style
/// detail screen. Pure reading surface for Phase 1: no share/export
/// action, no navigation bar at all - dismiss is swipe-down only, via the
/// presentation detent/drag indicator the caller already applies.
///
/// `ScrollView`, not `List` - MarkdownSection (MemoryView.swift) renders
/// fine as a plain `Section` outside a List/Form (both already internal,
/// not private - no need to relocate them), but a List's own row/grouping
/// chrome would fight the custom hero header this view wants above it.
struct ReportReaderView: View {
    let title: String
    let bodyText: String
    let createdAt: Date

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.largeTitle.weight(.bold))
                    Text("Report · \(createdAt.formatted(date: .abbreviated, time: .omitted))")
                        .font(.subheadline)
                        .foregroundStyle(.teal)
                }
                MarkdownSection(title: nil, markdown: bodyText)
            }
            .padding()
        }
    }
}
