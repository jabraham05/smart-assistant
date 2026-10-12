import Foundation
import Observation

/// App-wide auth + server state. The token lives only in the Keychain; the
/// server URL isn't a secret, so UserDefaults is fine for it.
@MainActor
@Observable
final class AppModel {
    /// The real chat-ui deployment, reached over Tailscale (`tailscale serve`
    /// on the host terminates HTTPS with a real *.ts.net certificate). Works
    /// from anywhere the phone's Tailscale is connected; nothing is exposed
    /// to the public internet.
    static let defaultServerURL = "https://john-pc.tail69c697.ts.net"
    private static let serverURLKey = "serverURL"

    private(set) var token: String?
    var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: Self.serverURLKey) }
    }
    /// Set when a Keychain read/write fails, so it's visible instead of silent.
    var keychainError: String?

    private let keychain: KeychainStore

    init(keychain: KeychainStore = .token) {
        self.keychain = keychain
        serverURL = UserDefaults.standard.string(forKey: Self.serverURLKey) ?? Self.defaultServerURL
        do {
            token = try keychain.read()
        } catch {
            keychainError = "Couldn't read saved login (\(error))."
        }
    }

    var isLoggedIn: Bool { token != nil }

    var client: APIClient {
        APIClient(baseURL: URL(string: serverURL) ?? URL(string: Self.defaultServerURL)!, token: token)
    }

    func login(password: String) async throws {
        let newToken = try await client.login(password: password)
        try keychain.write(newToken)
        token = newToken
    }

    /// No server-side revocation exists (shared-secret design) - logging out
    /// means forgetting the token.
    func logout() {
        do {
            try keychain.delete()
        } catch {
            keychainError = "Couldn't clear saved login (\(error))."
        }
        token = nil
    }

    /// Any 401 means the 30-day token lapsed (there's no refresh flow) -
    /// drop it so the login screen comes back.
    func handle(_ error: Error) {
        if (error as? APIError) == .unauthorized { logout() }
    }
}
