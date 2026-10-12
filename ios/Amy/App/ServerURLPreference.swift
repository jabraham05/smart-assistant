import Foundation

/// The server URL setting stores only a deliberate *override*. Seen live:
/// the field saved on every change, so the old LAN default got pinned on
/// the phone as if chosen - when the default moved to Tailscale, that
/// install kept using plain HTTP to 192.168.86.24 and failed off Wi-Fi.
enum ServerURLPreference {
    static let key = "serverURL"

    /// Built-in defaults that have since been retired. A stored value equal
    /// to one of these was never a real choice - it's dropped on load.
    static let retiredDefaults: Set<String> = [
        "http://192.168.86.24:3000",
        "http://192.168.86.24:3002",
    ]

    static func load(default defaultURL: String, from defaults: UserDefaults = .standard) -> String {
        guard let stored = defaults.string(forKey: key) else { return defaultURL }
        let value = normalized(stored)
        if value.isEmpty || value == normalized(defaultURL) || retiredDefaults.contains(value) {
            defaults.removeObject(forKey: key)
            return defaultURL
        }
        return value
    }

    static func save(_ url: String, default defaultURL: String, to defaults: UserDefaults = .standard) {
        let value = normalized(url)
        if value.isEmpty || value == normalized(defaultURL) {
            // Following the default - store nothing, so a future default
            // change reaches this install too.
            defaults.removeObject(forKey: key)
        } else {
            defaults.set(value, forKey: key)
        }
    }

    static func normalized(_ url: String) -> String {
        var s = url.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
