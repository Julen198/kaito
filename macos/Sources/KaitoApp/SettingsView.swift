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
    @State private var notifyDone = true
    @State private var autoReview = true
    @State private var reviewReminderMinutes = 30
    @State private var dailySummary = true
    @State private var showUsage = true
    @State private var tasksEnabled = true
    @State private var whEnabled = false
    @State private var whDays: Set<Int> = [1, 2, 3, 4, 5]
    @State private var whStart = "09:00"
    @State private var whEnd = "18:00"
    @State private var dndSilenceReminders = false

    static let dayLetters = ["L", "M", "X", "J", "V", "S", "D"] // lunes = 1 … domingo = 7

    var body: some View {
        // Alto fijo y botón dentro del VStack: con safeAreaInset «Guardar» quedaba fuera de la ventana
        // y los formularios (sin altura ideal) salían recortados.
        VStack(spacing: 8) {
            TabView {
                general.tabItem { Label("General", systemImage: "gearshape") }
                jira.tabItem { Label("Jira", systemImage: "ticket") }
                agents.tabItem { Label("Agentes", systemImage: "sparkles") }
                notices.tabItem { Label("Avisos", systemImage: "bell") }
            }
            HStack {
                if let status { Text(status).font(.callout).foregroundStyle(.secondary).lineLimit(2) }
                Spacer()
                Button("Guardar") { save() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 560, height: 520)
        .onAppear {
            load()
            NSApp.activate(ignoringOtherApps: true)
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

    private var notices: some View {
        Form {
            Section("Avisos") {
                Toggle("Avisar cuando un agente termina (tras 3 min o más trabajando)", isOn: $notifyDone)
                Toggle("Ticket terminado con commits: moverlo a revisión y tarjeta «listo»", isOn: $autoReview)
                Stepper(reviewReminderMinutes == 0 ? "Sin recordatorio de revisión" : "Recordar revisarlo a los \(reviewReminderMinutes) min",
                        value: $reviewReminderMinutes, in: 0...240, step: 5)
                Toggle("Resumen del día (a partir de las 06:00)", isOn: $dailySummary)
                Toggle("Tareas programadas", isOn: $tasksEnabled)
            }
            Section("Uso") {
                Toggle("Mostrar el uso de Claude y Codex (5 h y semana)", isOn: $showUsage)
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Datos de uso de Claude")
                        Text(statusLineText).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.statusLineBusy { ProgressView().controlSize(.small) }
                    if model.statusLineState == "kaito" {
                        Button("Quitar") { model.setStatusLine(install: false) }.disabled(model.statusLineBusy)
                    } else {
                        Button("Instalar") { model.setStatusLine(install: true) }
                            .disabled(model.statusLineBusy || model.statusLineState == "other")
                    }
                }
            }
            Section("No molestar") {
                Toggle("Horario de trabajo (fuera de él, No molestar)", isOn: $whEnabled)
                HStack(spacing: 4) {
                    ForEach(1...7, id: \.self) { d in
                        Toggle(Self.dayLetters[d - 1], isOn: Binding(get: { whDays.contains(d) }, set: { on in
                            if on { whDays.insert(d) } else { whDays.remove(d) }
                        }))
                        .toggleStyle(.button)
                    }
                }
                .disabled(!whEnabled)
                HStack {
                    TextField("Empieza", text: $whStart, prompt: Text("09:00")).frame(width: 140)
                    TextField("Acaba", text: $whEnd, prompt: Text("18:00")).frame(width: 140)
                }
                .disabled(!whEnabled)
                Toggle("Retener también los recordatorios", isOn: $dndSilenceReminders)
                Text("Mientras dure, los avisos (terminado, «listo», tareas) se guardan y salen juntos en «Mientras no estabas».")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .onAppear { model.refreshStatusLineState() }
    }

    private var statusLineText: String {
        switch model.statusLineState {
        case "kaito": return "Instalada: la statusLine de Kaito guarda los límites de 5 h y semana"
        case "other": return "Ya tienes otra statusLine en ~/.claude/settings.json: no se toca"
        default: return "Añade la statusLine de Kaito a ~/.claude/settings.json"
        }
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
        notifyDone = c.notifyDone
        autoReview = c.autoReview
        reviewReminderMinutes = c.reviewReminderMinutes
        dailySummary = c.dailySummary
        showUsage = c.showUsage
        tasksEnabled = c.tasksEnabled
        whEnabled = c.workHours.enabled
        whDays = Set(c.workHours.days)
        whStart = c.workHours.start
        whEnd = c.workHours.end
        dndSilenceReminders = c.dndSilenceReminders
    }

    private var workHoursJSON: JSON {
        let days: [JSON] = whDays.sorted().map { JSON.number(Double($0)) }
        let raw: JSON = .object(["enabled": .bool(whEnabled), "days": .array(days),
                                 "start": .string(trimmed(whStart)), "end": .string(trimmed(whEnd))])
        return WorkHours.normalize(raw).json
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
            "notifyDone": .bool(notifyDone),
            "autoReview": .bool(autoReview),
            "reviewReminderMinutes": .number(Double(reviewReminderMinutes)),
            "dailySummary": .bool(dailySummary),
            "showUsage": .bool(showUsage),
            "tasksEnabled": .bool(tasksEnabled),
            "dndSilenceReminders": .bool(dndSilenceReminders),
            "workHours": workHoursJSON,
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
        model.refreshUsage()
        model.quietTick()
        model.checkReminders()
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
