import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var password = ""
    @State private var isLoggingIn = false
    @State private var errorText: String?
    @State private var serverStatus: ServerStatus = .unknown

    enum ServerStatus { case unknown, checking, reachable, unreachable }

    var body: some View {
        @Bindable var model = model
        NavigationStack {
            Form {
                Section {
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .onSubmit { Task { await logIn() } }
                        .accessibilityIdentifier("passwordField")
                } footer: {
                    if let errorText {
                        Text(errorText).foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        Task { await logIn() }
                    } label: {
                        HStack {
                            Text("Log in")
                            if isLoggingIn { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(password.isEmpty || isLoggingIn)
                    .accessibilityIdentifier("loginButton")
                }

                Section("Server") {
                    TextField("Server URL", text: $model.serverURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await checkServer() } }
                    HStack {
                        statusLabel
                        Spacer()
                        Button("Check") { Task { await checkServer() } }
                    }
                }

                if let keychainError = model.keychainError {
                    Section { Text(keychainError).foregroundStyle(.orange) }
                }
            }
            .navigationTitle("Amy")
            .task { await checkServer() }
        }
    }

    @ViewBuilder private var statusLabel: some View {
        switch serverStatus {
        case .unknown: Label("Not checked", systemImage: "circle.dashed").foregroundStyle(.secondary)
        case .checking: Label("Checking…", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(.secondary)
        case .reachable: Label("Reachable", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .unreachable: Label("Can't reach server", systemImage: "xmark.octagon.fill").foregroundStyle(.red)
        }
    }

    private func checkServer() async {
        serverStatus = .checking
        let ok = (try? await model.client.health()) ?? false
        serverStatus = ok ? .reachable : .unreachable
    }

    private func logIn() async {
        guard !password.isEmpty, !isLoggingIn else { return }
        isLoggingIn = true
        errorText = nil
        defer { isLoggingIn = false }
        do {
            try await model.login(password: password)
            password = ""
        } catch APIError.unauthorized {
            errorText = "Incorrect password."
        } catch let error as URLError {
            errorText = "Can't reach the server (\(error.code.rawValue)). Check the URL and that you're on the home network."
        } catch {
            errorText = error.localizedDescription
        }
    }
}
