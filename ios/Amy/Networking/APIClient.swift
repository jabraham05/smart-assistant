import Foundation
import OSLog

enum APIError: Error, Equatable, LocalizedError {
    case unauthorized
    case badStatus(Int)
    case invalidResponse
    case decoding(path: String, detail: String)

    var errorDescription: String? {
        switch self {
        case .unauthorized: "Your session has expired. Please log in again."
        case .badStatus(let code): "The server returned an error (\(code))."
        case .invalidResponse: "The server sent an unexpected response."
        case .decoding(let path, let detail): "Unexpected data from \(path): \(detail)"
        }
    }
}

private let log = Logger(subsystem: "com.jabraham.amy", category: "api")

/// Names the exact field that didn't match - "data couldn't be read" alone
/// says nothing about which model is out of sync with the server.
private func describe(_ error: DecodingError) -> String {
    func path(_ context: DecodingError.Context) -> String {
        context.codingPath.map { $0.intValue.map { "[\($0)]" } ?? $0.stringValue }.joined(separator: ".")
    }
    switch error {
    case .keyNotFound(let key, let ctx): return "missing '\(key.stringValue)' at \(path(ctx))"
    case .typeMismatch(let type, let ctx): return "expected \(type) at \(path(ctx))"
    case .valueNotFound(let type, let ctx): return "null \(type) at \(path(ctx))"
    case .dataCorrupted(let ctx): return "corrupted at \(path(ctx)): \(ctx.debugDescription)"
    @unknown default: return String(describing: error)
    }
}

/// The one place that knows the base URL and attaches the bearer token -
/// every request from every feature goes through here. Mirrors chat-ui's
/// API routes; never talks to internal services directly.
struct APIClient: Sendable {
    let baseURL: URL
    let token: String?
    var session: URLSession = .shared

    // MARK: - Endpoints

    func health() async throws -> Bool {
        let (_, response) = try await send(request(path: "api/health"), retryable: true)
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    func login(password: String) async throws -> String {
        var req = request(path: "api/auth/login", method: "POST")
        req.httpBody = try JSONEncoder().encode(["password": password])
        let (data, response) = try await send(req, retryable: true)
        try check(response)
        return try JSONDecoder().decode(LoginResponse.self, from: data).token
    }

    func sessions() async throws -> [ChatSession] {
        try await get("api/sessions")
    }

    /// One page of history, newest-first (page 1 = the latest `size` messages).
    func messages(sessionId: String, page: Int, size: Int) async throws -> [HistoryMessage] {
        try await get("api/sessions/\(sessionId)/messages", query: [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "size", value: String(size)),
        ])
    }

    /// POST /api/chat - returns the decoded NDJSON event stream.
    func chat(message: String, sessionId: String) async throws -> AsyncThrowingStream<StreamEvent, Error> {
        var req = request(path: "api/chat", method: "POST")
        req.httpBody = try JSONEncoder().encode(["message": message, "sessionId": sessionId])
        req.timeoutInterval = 300 // slow (research/coding) turns hold the stream open a while
        let (bytes, response) = try await sendStreaming(req)
        try check(response)
        return NDJSON.events(from: bytes)
    }

    // MARK: - Home

    func homeSummary() async throws -> HomeSummary {
        try await get("api/home")
    }

    func homeActivity(limit: Int = 20) async throws -> [HomeActivityItem] {
        try await get("api/home-activity", query: [URLQueryItem(name: "limit", value: String(limit))])
    }

    func taskActivity(id: Int) async throws -> TaskContextActivity {
        try await get("api/tasks/\(id)/activity")
    }

    func projects(status: String? = nil) async throws -> [Project] {
        let query = status.map { [URLQueryItem(name: "status", value: $0)] } ?? []
        let response: ProjectsResponse = try await get("api/projects", query: query)
        return response.projects
    }

    func createTodo(objective: String) async throws {
        try await write("api/todos", method: "POST", body: ["objective": .string(objective)])
    }

    func updateTodo(id: Int, objective: String? = nil, status: String? = nil) async throws {
        var body: [String: JSONScalar] = ["id": .int(id)]
        if let objective { body["objective"] = .string(objective) }
        if let status { body["status"] = .string(status) }
        try await write("api/todos", method: "PATCH", body: body)
    }

    func updateGoal(id: Int, title: String? = nil, description: String? = nil) async throws {
        var body: [String: JSONScalar] = ["id": .int(id)]
        if let title { body["title"] = .string(title) }
        if let description { body["description"] = .string(description) }
        try await write("api/goals", method: "PATCH", body: body)
    }

    func approveProject(id: Int) async throws {
        try await write("api/projects/\(id)/approve", method: "POST", body: [:])
    }

    func rejectProject(id: Int) async throws {
        try await write("api/projects/\(id)/reject", method: "POST", body: [:])
    }

    // MARK: - Plumbing

    enum JSONScalar: Encodable, Sendable {
        case string(String), int(Int)
        func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .string(let s): try c.encode(s)
            case .int(let i): try c.encode(i)
            }
        }
    }

    /// Mutations are never auto-retried after the request may have been
    /// sent - only when the connection was never made.
    private func write(_ path: String, method: String, body: [String: JSONScalar]) async throws {
        var req = request(path: path, method: method)
        req.httpBody = try JSONEncoder().encode(body)
        let (_, response) = try await send(req, retryable: false)
        try check(response)
    }

    private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let (data, response) = try await send(request(path: path, query: query), retryable: true)
        try check(response)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch let error as DecodingError {
            let detail = describe(error)
            log.error("decode \(path, privacy: .public) as \(String(describing: T.self), privacy: .public) failed: \(detail, privacy: .public)")
            throw APIError.decoding(path: path, detail: detail)
        }
    }

    private func request(path: String, method: String = "GET", query: [URLQueryItem] = []) -> URLRequest {
        var url = baseURL.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }
        var req = URLRequest(url: url)
        // Live data - never serve a cached copy (seen: cache_hit=true on history).
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.httpMethod = method
        req.timeoutInterval = 15
        if method != "GET" { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return req
    }

    private func check(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else { throw APIError.badStatus(http.statusCode) }
    }

    /// A phone hops between Wi-Fi and cellular and the tailnet may need a
    /// moment to (re)establish a path after the app wakes, so
    /// connection-level failures get a couple of quick retries.
    private func send(_ req: URLRequest, retryable: Bool) async throws -> (Data, URLResponse) {
        try await withConnectRetry(always: retryable) { try await session.data(for: req) }
    }

    private func sendStreaming(_ req: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
        // Not idempotent, so only retried when the connection was never
        // made (the request can't have reached the server).
        try await withConnectRetry(always: false) { try await session.bytes(for: req) }
    }

    private func withConnectRetry<T>(always: Bool, _ op: () async throws -> T) async throws -> T {
        var attempt = 0
        while true {
            do {
                return try await op()
            } catch let error as URLError where attempt < 2 && Self.isRetryable(error, always: always) {
                attempt += 1
                try await Task.sleep(for: .milliseconds(400 * attempt))
            }
        }
    }

    private static func isRetryable(_ error: URLError, always: Bool) -> Bool {
        switch error.code {
        case .cannotConnectToHost, .cannotFindHost, .notConnectedToInternet:
            return true
        case .networkConnectionLost, .timedOut:
            return always
        default:
            return false
        }
    }
}
