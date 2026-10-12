import Foundation

// Swift ports of the Memory shapes: chat-ui/src/lib/chat-orchestrator-client.ts
// (UserProfile) and knowledge-engine-client.ts (Entity, search, files).

struct UserProfile: Decodable, Sendable {
    /// What Amy has learned about the user.
    let userCard: [String]
    /// How the user wants Amy to work with them.
    let userCardForAmy: [String]
}

/// A durable thing Amy remembers - a person, fact, preference, project...
/// `id` is a text id (not a BIGINT), so it stays a String.
struct Entity: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let type: String
    let name: String
    let description: String?
    let status: String?
    let createdAt: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, type, name, description, status
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct EntityDetail: Decodable, Sendable {
    let id: String
    let type: String
    let name: String
    let description: String?
    let status: String?
    let createdAt: String
    let updatedAt: String
    /// The entity's write-up (its backing markdown file), if it has one.
    let content: String?

    enum CodingKeys: String, CodingKey {
        case id, type, name, description, status, content
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

struct KnowledgeResult: Decodable, Hashable, Sendable {
    let content: String
    let documentTitle: String
    let domain: String
    let pageNumber: Int?
    let sectionPath: String?
    let heading: String?
    let score: Double
}

struct KnowledgeFile: Decodable, Identifiable, Hashable, Sendable {
    let relativePath: String
    let size: Int
    let mtime: String
    var id: String { relativePath }

    var fileName: String { (relativePath as NSString).lastPathComponent }
    var folder: String? {
        let dir = (relativePath as NSString).deletingLastPathComponent
        return dir.isEmpty ? nil : dir
    }
}
