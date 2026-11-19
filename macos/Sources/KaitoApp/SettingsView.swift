import AppKit
import KaitoCore
import SwiftUI

/// Ajustes: se guardan en ~/.config/kaito/config.json (mismas claves que Linux) y el token en el llavero.
@MainActor
struct SettingsView: View {
    @EnvironmentObject var model: AppModel

    @State private var jiraEnabled = true
    @State private var jiraBaseUrl = ""
    @State private var jiraEmail = ""
    @State private var token = ""
    @State private var hasToken = false
    @State private var preset = "open"
    @State private var customJql = ""
    @State private var showUnassigned = true
    @State private var showSprint = true
    @State private var showRecent = true
    @State private var projects = ""
    @State private var refreshSeconds = 30
    @State private var jiraMax = 20
    @State private var agentWindowMinutes = 10
    @State private var terminal = "auto"
    @State private var hotkey = "ctrl+alt+space"
    @State private var providers: [String: Bool] = [:]
    @State private var repoRoots = ""
    @State private var checkUpdates = true
    @State private var launchAtLogin = false
    @State private var status: String?
    @State private var testing = false

    var body: some View {
        TabView {
            general.tabItem { Label("General", systemImage: "gearshape") }
            jira.tabItem { Label("Jira", systemImage: "ticket") }
            agents.tabItem { Label("Agentes", systemImage: "sparkles") }
        }
        .padding(16)
        .frame(width: 520)
        .onAppear {
            load()
            NSApp.activate(ignoringOtherApps: true)
        }
        .safeAreaInset(edge: .bottom) {
            HStack {
                if let status { Text(status).font(.callout).foregroundStyle(.secondary).lineLimit(2) }
                Spacer()
                Button("Guardar") { save() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(.top, 8)
        }
    }

    private var general: some View {
        Form {
            Picker("Terminal", selection: $terminal) {
                Text("Automática (iTerm2 si está abierto; si no, Terminal)").tag("auto")
                Text("Terminal").tag("terminal")
                Text("iTerm2").tag("iterm")
                Text("Warp (ventana nueva)").tag("warp")
            }
            Picker("Captura rápida", selection: $hotkey) {
                ForEach(KaitoConfig.captureHotkeys, id: \.self) { k in
                    Text(HotKey.labels[k] ?? k).tag(k)
                }
            }
            Text("⌃⌥Espacio coincide con «Seleccionar siguiente fuente de entrada» si tienes varias distribuciones de teclado; elige otro atajo o desactívalo en Ajustes del Sistema > Teclado > Atajos.")
                .font(.caption).foregroundStyle(.secondary)
            Toggle("Abrir al iniciar sesión", isOn: $launchAtLogin)
            Toggle("Avisar de nuevas versiones", isOn: $checkUpdates)
            HStack {
                Text("Versión \(model.version)").foregroundStyle(.secondary)
                Spacer()
                Button("Buscar actualizaciones") {
                    Task { await model.checkForUpdate(force: true) }
                }
            }
        }
        .formStyle(.grouped)
    }

    private var jira: some View {
        Form {
            Toggle("Mostrar Jira", isOn: $jiraEnabled)
            TextField("URL", text: $jiraBaseUrl, prompt: Text("https://tuempresa.atlassian.net"))
            TextField("Email", text: $jiraEmail)
            SecureField("API token", text: $token, prompt: Text(hasToken ? "Guardado en el llavero (déjalo vacío para conservarlo)" : "id.atlassian.com > Seguridad > API tokens"))
            Picker("Mías", selection: $preset) {
                ForEach(KaitoConfig.presets, id: \.id) { p in Text(p.title).tag(p.id) }
            }
            if preset == "custom" {
                TextField("JQL", text: $customJql, axis: .vertical)
            }
            Toggle("Pestaña Sin asignar", isOn: $showUnassigned)
            Toggle("Pestaña Sprint", isOn: $showSprint)
            Toggle("Pestaña Recientes", isOn: $showRecent)
            TextField("Proyectos (si no hay tickets tuyos)", text: $projects, prompt: Text("RUN, WEB"))
            Stepper("Refrescar cada \(refreshSeconds) s", value: $refreshSeconds, in: 15...3600, step: 15)
            Stepper("Máximo \(jiraMax) tickets por vista", value: $jiraMax, in: 5...100, step: 5)
            HStack {
                Spacer()
                Button(testing ? "Probando…" : "Probar conexión") { test() }
                    .disabled(testing)
            }
        }
        .formStyle(.grouped)
    }

    private var agents: some View {
        Form {
            Stepper("Ventana de agentes: \(agentWindowMinutes) min", value: $agentWindowMinutes, in: 1...240)
            Section("Proveedores") {
                ForEach(Providers.all.filter { $0.id != "claude" }, id: \.id) { p in
                    Toggle(p.title, isOn: Binding(get: { providers[p.id] ?? true }, set: { providers[p.id] = $0 }))
                }
            }
            TextField("Carpetas de repos (separadas por comas)", text: $repoRoots, axis: .vertical)
            Text("Los hooks de Claude Code (~/.claude/settings.json) los instala install-mac.sh: sin ellos no se ve «te necesita» ni «terminó».")
                .font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
    }

    private func load() {
        let c = model.configStore.read()
        jiraEnabled = c.jiraEnabled
        jiraBaseUrl = c.jiraBaseUrl
        jiraEmail = c.jiraEmail
        hasToken = Keychain.token() != nil
        token = ""
        preset = c.jiraPreset ?? (c.raw["jiraJql"]?.string.map { _ in "custom" } ?? "open")
        customJql = c.jiraJql
        showUnassigned = c.jiraBuiltinViews["unassigned"] != false
        showSprint = c.jiraBuiltinViews["sprint"] != false
        showRecent = c.jiraBuiltinViews["recent"] != false
        projects = c.jiraProjects.joined(separator: ", ")
        refreshSeconds = c.refreshSeconds
        jiraMax = c.jiraMax
        agentWindowMinutes = c.agentWindowMinutes
        terminal = c.terminal
        hotkey = c.captureHotkey
        providers = c.agentProviders
        repoRoots = c.repoRoots.joined(separator: ", ")
        checkUpdates = c.checkUpdates
        launchAtLogin = LoginItem.enabled
    }

    private func save() {
        var patch: [String: JSON] = [
            "jiraEnabled": .bool(jiraEnabled),
            "jiraBaseUrl": .string(trimmed(jiraBaseUrl)),
            "jiraEmail": .string(trimmed(jiraEmail)),
            "jiraPreset": .string(preset),
            "jiraBuiltinViews": ["unassigned": .bool(showUnassigned), "sprint": .bool(showSprint), "recent": .bool(showRecent)],
            "jiraProjects": .array(projects.split(whereSeparator: { $0 == "," || $0 == " " }).map { .string(String($0).uppercased()) }),
            "refreshSeconds": .number(Double(refreshSeconds)),
            "jiraMax": .number(Double(jiraMax)),
            "agentWindowMinutes": .number(Double(agentWindowMinutes)),
            "terminal": .string(terminal),
            "captureHotkey": .string(hotkey),
            "agentProviders": .object(providers.mapValues { .bool($0) }),
            "checkUpdates": .bool(checkUpdates),
        ]
        if preset == "custom" {
            patch["jiraJql"] = .string(trimmed(customJql))
        } else if let p = KaitoConfig.presets.first(where: { $0.id == preset }), let jql = p.jql {
            patch["jiraJql"] = .string(jql)
        }
        let roots = repoRoots.split(separator: ",").map { trimmed(String($0)) }.filter { !$0.isEmpty }
        patch["repoRoots"] = roots.isEmpty ? .null : .array(roots.map { .string($0) })
        do {
            try model.configStore.update(patch)
            if !trimmed(token).isEmpty {
                if !Keychain.setToken(trimmed(token)) { throw KaitoError.message("no se pudo guardar el token en el llavero") }
                token = ""
                hasToken = true
            }
            if launchAtLogin != LoginItem.enabled { try LoginItem.set(launchAtLogin) }
            status = "Guardado"
        } catch {
            status = "Error: \(error.localizedDescription)"
        }
        model.reloadConfig()
        model.refreshJira(force: true)
        model.refreshAgents()
    }

    private func test() {
        save()
        guard let client = model.jiraClient() else {
            status = model.jiraMessage
            return
        }
        testing = true
        let jql = model.config.jiraJql
        Task {
            do {
                let me = try await client.myself()
                let n = try await client.search(jql: jql, max: 50).count
                status = "Conectado como \(me["displayName"]?.text ?? jiraEmail): \(n) tickets en «Mías»"
            } catch {
                status = "Error: \(error.localizedDescription)"
            }
            testing = false
        }
    }
}
