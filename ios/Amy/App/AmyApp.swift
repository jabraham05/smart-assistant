import SwiftUI

@main
struct AmyApp: App {
    @State private var model = AppModel()
    @AppStorage(Appearance.storageKey) private var appearance: Appearance = .system

    var body: some Scene {
        WindowGroup {
            Group {
                if model.isLoggedIn {
                    MainView()
                } else {
                    LoginView()
                }
            }
            .environment(model)
            .preferredColorScheme(appearance.colorScheme)
        }
    }
}

/// User override for light/dark; `.system` follows the phone's setting.
enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    static let storageKey = "appearance"
    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "System"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}
