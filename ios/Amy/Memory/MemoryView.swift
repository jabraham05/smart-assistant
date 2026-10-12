import SwiftUI

/// Memory hub: what Amy knows about you, what she remembers, and her
/// knowledge base - searchable and readable.
struct MemoryView: View {
    @State private var query = ""
    @State private var submittedQuery = ""

    var body: some View {
        List {
            Section {
                NavigationLink { AboutYouView() } label: {
                    MemoryRow(title: "About you", subtitle: "What Amy knows and how you like to work",
                              symbol: "person.crop.circle", tint: .blue)
                }
            }
            Section("Remembered") {
                NavigationLink { EntitiesView() } label: {
                    MemoryRow(title: "People, facts & more", subtitle: "Things Amy keeps track of",
                              symbol: "brain", tint: .purple)
                }
                NavigationLink { KnowledgeFilesView() } label: {
                    MemoryRow(title: "Files", subtitle: "Amy's knowledge base documents",
                              symbol: "doc.text", tint: .indigo)
                }
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search Amy's knowledge")
        .onSubmit(of: .search) { submittedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines) }
        .navigationDestination(isPresented: Binding(get: { !submittedQuery.isEmpty },
                                                    set: { if !$0 { submittedQuery = "" } })) {
            KnowledgeSearchResults(query: submittedQuery)
        }
    }
}

private struct MemoryRow: View {
    let title: String
    let subtitle: String
    let symbol: String
    let tint: Color

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
        }
        .padding(.vertical, 4)
    }
}

// MARK: - About you

private struct AboutYouView: View {
    var body: some View {
        Loaded(load: { try await $0.userProfile() },
               isEmpty: { $0.userCard.isEmpty && $0.userCardForAmy.isEmpty },
               emptyTitle: "Nothing yet",
               emptySymbol: "person.crop.circle",
               emptyMessage: "As you talk, Amy builds up a picture of you here.") { profile, _ in
            List {
                if !profile.userCard.isEmpty {
                    Section {
                        ForEach(Array(profile.userCard.enumerated()), id: \.offset) { _, line in
                            FactRow(text: line)
                        }
                    } header: {
                        Text("What Amy knows about you")
                    }
                }
                if !profile.userCardForAmy.isEmpty {
                    Section {
                        ForEach(Array(profile.userCardForAmy.enumerated()), id: \.offset) { _, line in
                            FactRow(text: line)
                        }
                    } header: {
                        Text("How you like Amy to work")
                    }
                }
            }
        }
        .navigationTitle("About you")
    }
}

private struct FactRow: View {
    let text: String

    var body: some View {
        Text(DetailBlock.render(text))
            .font(.callout)
            .textSelection(.enabled)
            .padding(.vertical, 2)
    }
}

// MARK: - Entities

enum EntityKind {
    static func label(_ type: String) -> String {
        switch type {
        case "project": "Projects"
        case "user_fact": "Facts about you"
        case "preference": "Preferences"
        case "learning": "Things Amy learned"
        case "decision": "Decisions"
        case "document": "Documents"
        case "person": "People"
        default: StatusStyle.humanize(type) + "s"
        }
    }

    static func symbol(_ type: String) -> String {
        switch type {
        case "project": "folder"
        case "user_fact": "person.text.rectangle"
        case "preference": "heart"
        case "learning": "lightbulb"
        case "decision": "checkmark.seal"
        case "document": "doc.text"
        case "person": "person"
        default: "circle.grid.2x2"
        }
    }
}

private struct EntitiesView: View {
    var body: some View {
        Loaded(load: { try await $0.entities() },
               isEmpty: \.isEmpty,
               emptyTitle: "Nothing remembered yet",
               emptySymbol: "brain") { entities, _ in
            let groups = Dictionary(grouping: entities, by: \.type)
                .map { (type: $0.key, items: $0.value.sorted { $0.updatedAt > $1.updatedAt }) }
                .sorted { $0.items.count > $1.items.count }
            List {
                ForEach(groups, id: \.type) { group in
                    Section {
                        ForEach(group.items) { entity in
                            NavigationLink {
                                EntityDetailView(entity: entity)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(entity.name).font(.body.weight(.medium)).lineLimit(2)
                                    if let description = entity.description, !description.isEmpty {
                                        Text(description).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                    RelativeTime(iso: entity.updatedAt).font(.caption).foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 3)
                            }
                        }
                    } header: {
                        Label(EntityKind.label(group.type), systemImage: EntityKind.symbol(group.type))
                    }
                }
            }
        }
        .navigationTitle("Remembered")
    }
}

private struct EntityDetailView: View {
    let entity: Entity

    var body: some View {
        Loaded(load: { [id = entity.id] in try await $0.entity(id: id) }) { detail, _ in
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(detail.name).font(.title3.weight(.semibold))
                        if let description = detail.description, !description.isEmpty {
                            Text(description).font(.subheadline).foregroundStyle(.secondary)
                        }
                        HStack(spacing: 8) {
                            Tag(text: EntityKind.label(detail.type))
                            if let status = detail.status { StatusBadge(status: status) }
                        }
                    }
                    .padding(.vertical, 4)
                }
                if let content = detail.content, !content.isEmpty {
                    MarkdownSection(title: "Details", markdown: content)
                }
                Section {
                    LabeledContent("First noted") { RelativeTime(iso: detail.createdAt) }
                    LabeledContent("Last updated") { RelativeTime(iso: detail.updatedAt) }
                }
            }
        }
        .navigationTitle(EntityKind.label(entity.type))
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Knowledge search

private struct KnowledgeSearchResults: View {
    let query: String

    var body: some View {
        Loaded(load: { [query] in try await $0.searchKnowledge(query) },
               isEmpty: \.isEmpty,
               emptyTitle: "No matches",
               emptySymbol: "magnifyingglass",
               emptyMessage: "Nothing in Amy's knowledge base matches \"\(query)\".") { results, _ in
            List(Array(results.enumerated()), id: \.offset) { _, result in
                VStack(alignment: .leading, spacing: 6) {
                    Text(result.heading ?? result.documentTitle).font(.headline).lineLimit(2)
                    Text(result.content.trimmingCharacters(in: .whitespacesAndNewlines))
                        .font(.subheadline)
                        .lineLimit(6)
                        .textSelection(.enabled)
                    HStack(spacing: 8) {
                        Label(result.documentTitle, systemImage: "doc.text").lineLimit(1)
                        if let page = result.pageNumber { Text("p. \(page)") }
                        Tag(text: StatusStyle.humanize(result.domain))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }
        }
        .navigationTitle(query)
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Files

private struct KnowledgeFilesView: View {
    var body: some View {
        Loaded(load: { try await $0.knowledgeFiles() },
               isEmpty: \.isEmpty,
               emptyTitle: "No files yet",
               emptySymbol: "doc.text") { files, _ in
            let groups = Dictionary(grouping: files, by: { $0.folder ?? "" })
                .map { (folder: $0.key, files: $0.value.sorted { $0.mtime > $1.mtime }) }
                .sorted { $0.folder < $1.folder }
            List {
                ForEach(groups, id: \.folder) { group in
                    Section(group.folder.isEmpty ? "Files" : StatusStyle.humanize(group.folder)) {
                        ForEach(group.files) { file in
                            NavigationLink {
                                KnowledgeFileView(file: file)
                            } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(FileTitle.of(file.fileName)).font(.body.weight(.medium)).lineLimit(2)
                                    HStack(spacing: 8) {
                                        Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
                                        RelativeTime(iso: file.mtime)
                                    }
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 2)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Files")
    }
}

private struct KnowledgeFileView: View {
    let file: KnowledgeFile

    var body: some View {
        Loaded(load: { [path = file.relativePath] in try await $0.knowledgeFileContent(path: path) }) { content, _ in
            List {
                MarkdownSection(title: nil, markdown: content)
            }
        }
        .navigationTitle(FileTitle.of(file.fileName))
        .navigationBarTitleDisplayMode(.inline)
    }
}

enum FileTitle {
    /// "2026-10-03-shellfish-free-recipes.md" -> "2026-10-03 shellfish free recipes"
    static func of(_ fileName: String) -> String {
        let base = (fileName as NSString).deletingPathExtension
        return StatusStyle.humanize(base)
    }
}

/// Renders a markdown document readably: headings as headings, paragraphs
/// and list items as text, YAML frontmatter dropped.
struct MarkdownSection: View {
    let title: String?
    let markdown: String

    var body: some View {
        let blocks = MarkdownBlocks.parse(markdown)
        Section {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let level, let text):
                    Text(DetailBlock.render(text))
                        .font(level <= 1 ? .title3.weight(.semibold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                        .padding(.top, 4)
                case .paragraph(let text):
                    Text(DetailBlock.render(text)).font(.callout).textSelection(.enabled)
                case .bullet(let text):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(.secondary)
                        Text(DetailBlock.render(text)).font(.callout).textSelection(.enabled)
                    }
                case .code(let text):
                    Text(text).font(.caption.monospaced()).textSelection(.enabled)
                }
            }
        } header: {
            if let title { Text(title) }
        }
    }
}

enum MarkdownBlock: Equatable {
    case heading(Int, String)
    case paragraph(String)
    case bullet(String)
    case code(String)
}

enum MarkdownBlocks {
    static func parse(_ markdown: String) -> [MarkdownBlock] {
        var lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        // Drop YAML frontmatter.
        if lines.first?.trimmingCharacters(in: .whitespaces) == "---",
           let end = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) {
            lines = Array(lines[(end + 1)...])
        }

        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var code: [String]?

        func flushParagraph() {
            let text = paragraph.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            if !text.isEmpty { blocks.append(.paragraph(text)) }
            paragraph = []
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if let open = code {
                    blocks.append(.code(open.joined(separator: "\n")))
                    code = nil
                } else {
                    flushParagraph()
                    code = []
                }
                continue
            }
            if code != nil { code?.append(line); continue }

            if trimmed.isEmpty {
                flushParagraph()
            } else if let hashes = trimmed.firstIndex(where: { $0 != "#" }), hashes > trimmed.startIndex,
                      trimmed[hashes] == " " {
                flushParagraph()
                let level = trimmed.distance(from: trimmed.startIndex, to: hashes)
                blocks.append(.heading(level, String(trimmed[hashes...]).trimmingCharacters(in: .whitespaces)))
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") {
                flushParagraph()
                blocks.append(.bullet(String(trimmed.dropFirst(2))))
            } else {
                paragraph.append(trimmed)
            }
        }
        flushParagraph()
        if let open = code { blocks.append(.code(open.joined(separator: "\n"))) }
        return blocks
    }
}
