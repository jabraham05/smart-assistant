import Foundation

extension APIClient {
    private struct EntitiesResponse: Decodable { let entities: [Entity] }
    private struct SearchResponse: Decodable { let results: [KnowledgeResult] }
    private struct FilesResponse: Decodable { let files: [KnowledgeFile] }
    private struct ContentResponse: Decodable { let content: String }

    func userProfile() async throws -> UserProfile {
        try await get("api/amy/user-profile")
    }

    func entities() async throws -> [Entity] {
        let response: EntitiesResponse = try await get("api/entities")
        return response.entities
    }

    func entity(id: String) async throws -> EntityDetail {
        try await get("api/entities/\(id)")
    }

    func searchKnowledge(_ query: String, topK: Int = 10) async throws -> [KnowledgeResult] {
        let response: SearchResponse = try await post("api/knowledge-search", body: SearchBody(query: query, topK: topK))
        return response.results
    }

    func knowledgeFiles() async throws -> [KnowledgeFile] {
        let response: FilesResponse = try await get("api/knowledge-files")
        return response.files
    }

    func knowledgeFileContent(path: String) async throws -> String {
        let response: ContentResponse = try await get("api/knowledge-files/content",
                                                      query: [URLQueryItem(name: "path", value: path)])
        return response.content
    }

    private struct SearchBody: Encodable, Sendable {
        let query: String
        let topK: Int
    }
}
