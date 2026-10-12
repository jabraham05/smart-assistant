import Foundation
import Testing
@testable import Amy

@Suite struct ServerURLPreferenceTests {
    let defaultURL = "https://host.tailnet.ts.net"

    private func freshDefaults() -> UserDefaults {
        let name = "ServerURLPreferenceTests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    @Test func nothingStoredFollowsTheDefault() {
        #expect(ServerURLPreference.load(default: defaultURL, from: freshDefaults()) == defaultURL)
    }

    @Test func aRetiredDefaultIsDroppedOnLoad() {
        let d = freshDefaults()
        d.set("http://192.168.86.24:3000", forKey: ServerURLPreference.key)
        #expect(ServerURLPreference.load(default: defaultURL, from: d) == defaultURL)
        #expect(d.string(forKey: ServerURLPreference.key) == nil)
    }

    @Test func savingTheDefaultStoresNothing() {
        let d = freshDefaults()
        ServerURLPreference.save(defaultURL + "/", default: defaultURL, to: d)
        #expect(d.string(forKey: ServerURLPreference.key) == nil)
    }

    @Test func aRealOverrideIsKeptNormalized() {
        let d = freshDefaults()
        ServerURLPreference.save("  https://other.ts.net/ ", default: defaultURL, to: d)
        #expect(ServerURLPreference.load(default: defaultURL, from: d) == "https://other.ts.net")
    }
}
