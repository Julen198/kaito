import AppKit
import KaitoCore
import SwiftUI

/// Panel flotante que puede recibir teclado sin ser la ventana principal (estilo Spotlight).
final class KeyPanel: NSPanel {
    var onCancel: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { onCancel?() }
}

@MainActor
func makePanel(width: CGFloat) -> KeyPanel {
    let p = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: width, height: 120),
                     styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
                     backing: .buffered, defer: false)
    p.titleVisibility = .hidden
    p.titlebarAppearsTransparent = true
    p.standardWindowButton(.closeButton)?.isHidden = true
    p.standardWindowButton(.miniaturizeButton)?.isHidden = true
    p.standardWindowButton(.zoomButton)?.isHidden = true
    p.isMovableByWindowBackground = true
    p.level = .floating
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    return p
}

/// Pantalla bajo el ratón (o la principal).
@MainActor
func activeScreen() -> NSScreen? {
    let mouse = NSEvent.mouseLocation
    return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
}

// MARK: - Captura rápida

enum CaptureMode: String, CaseIterable, Identifiable {
    case note, reminder, jira, task
    var id: String { rawValue }
    var title: String {
        switch self {
        case .note: return "Nota"
        case .reminder: return "Recordatorio"
        case .jira: return "Jira"
        case .task: return "Tarea"
        }
    }
    var hint: String {
        switch self {
        case .note: return "Escribe una nota"
        case .reminder: return "Qué y cuándo: «llamar a Iker en 20 min»"
        case .jira: return "Qué pasa: «el chat de Nike en FR no carga los cupones, urgente»"
        case .task: return "Cuándo y qué: «cada lunes a las 9 revisa en BigQuery las ventas»"
        }
    }
}

enum JiraStage { case input, drafting, review, creating }

@MainActor
final class CaptureModel: ObservableObject {
    @Published var mode: CaptureMode = .note
    @Published var text = ""
    @Published var error: String?
    @Published var focusToken = 0

    @Published var stage: JiraStage = .input
    @Published var elapsed = 0
    @Published var summary = ""
    @Published var desc = ""
    @Published var kind = "Tarea"
    @Published var priority = "Medium"
    @Published var projects: [String] = []
    @Published var project = JiraDraft.defaultProject
    @Published var ctx: CreateContext?
    @Published var typeId: String?
    @Published var extraSel: [String: String] = [:]

    // Tarea programada: revisión antes de guardar.
    @Published var taskReview = false
    @Published var taskName = ""
    @Published var taskPrompt = ""
    @Published var taskCwd = ""
    @Published var taskTools = "readonly"
    @Published var taskKey = ""
    @Published var taskRule: TaskRule?
    @Published var taskLabel = ""

    var onClose: (() -> Void)?
    private var gen = 0
    private var tick: Timer?
    private var client: JiraClient?

    var app: AppModel { AppModel.shared }

    func reset() {
        gen += 1
        stopTick()
        let saved = app.config.raw["captureMode"]?.string ?? "note"
        mode = CaptureMode(rawValue: saved) ?? .note
        text = ""
        error = nil
        stage = .input
        ctx = nil
        typeId = nil
        extraSel = [:]
        projects = []
        taskReview = false
        focusToken += 1
    }

    func setMode(_ m: CaptureMode) {
        mode = m
        error = nil
        try? app.configStore.update(["captureMode": .string(m.rawValue)])
        focusToken += 1
    }

    var reminderPreview: String? {
        trimmed(text).isEmpty ? nil : When.parse(text)?.label
    }

    var taskPreview: String? {
        trimmed(text).isEmpty ? nil : When.parseSchedule(text)?.label
    }

    /// Texto → regla (español), nombre, carpeta y herramientas sugeridas; pasa a la revisión.
    func startTaskReview(_ t: String) {
        guard let s = When.parseSchedule(t) else {
            error = "Añade cuándo: «cada lunes a las 9», «todos los días a las 8», «mañana a las 10»"
            return
        }
        let prompt = s.clean.isEmpty ? t : s.clean
        let key = Tasks.extractKey(prompt)
        taskRule = s.rule
        taskLabel = s.label
        taskPrompt = prompt
        taskName = Tasks.taskName(prompt)
        taskKey = key ?? ""
        taskTools = Tasks.suggestTools(prompt, withTicket: key != nil)
        taskCwd = Tasks.resolveCwd(key: key, config: app.config, home: app.paths.home, isDir: FileUtil.isDir)
        error = nil
        taskReview = true
    }

    func createTask() {
        guard let rule = taskRule else { return }
        let name = collapseSpaces(taskName), prompt = trimmed(taskPrompt), cwd = trimmed(taskCwd)
        guard !prompt.isEmpty else {
            error = "Falta qué tiene que hacer"
            return
        }
        guard FileUtil.isDir(Tasks.expandHome(cwd.isEmpty ? "~" : cwd, home: app.paths.home)) else {
            error = "La carpeta \(cwd) no existe"
            return
        }
        let key = trimmed(taskKey).uppercased()
        if let msg = app.addTask(name: name.isEmpty ? Tasks.taskName(prompt) : name, prompt: prompt, cwd: cwd.isEmpty ? "~" : cwd,
                                 rule: rule, tools: taskTools, key: JiraViews.keyRE.test(key) ? key : nil) {
            app.show(msg)
            onClose?()
        }
    }

    var currentType: IssueTypeRef? {
        guard let ctx else { return nil }
        if let id = typeId, let t = ctx.types.first(where: { $0.id == id }) { return t }
        return JiraDraft.matchIssueType(kind, types: ctx.types)
    }

    func submit() {
        let t = trimmed(text)
        guard !t.isEmpty else { return }
        switch mode {
        case .note:
            app.addNote(t)
            app.show("Nota guardada")
            onClose?()
        case .reminder:
            if let label = app.addReminder(t) {
                app.show("Recordatorio: \(label)")
                onClose?()
            } else {
                error = "Añade cuándo: «en 20 min», «a las 17:30», «mañana»"
            }
        case .jira:
            if stage == .input { startDraft(t) }
        case .task:
            if !taskReview { startTaskReview(t) }
        }
    }

    // MARK: Jira

    private func stopTick() {
        tick?.invalidate()
        tick = nil
    }

    func startDraft(_ t: String) {
        guard let client = app.jiraClient() else {
            error = app.jiraMessage
            return
        }
        self.client = client
        gen += 1
        let g = gen
        stage = .drafting
        error = nil
        elapsed = 0
        tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            Task { @MainActor in CapturePanelController.shared.model.elapsed += 1 }
        }
        if ctx == nil { Task { await prepare(client, project: nil, gen: g) } }
        let bin = app.config.claudeBin
        Task {
            do {
                let d = try await ClaudeCLI.draft(t, claudeBin: bin)
                guard g == gen, stage == .drafting else { return }
                stopTick()
                summary = d.summary
                desc = d.description
                kind = d.issuetype
                priority = d.priority
                typeId = nil
                stage = .review
            } catch {
                guard g == gen, stage == .drafting else { return }
                stopTick()
                self.error = error.localizedDescription
                stage = .input
                focusToken += 1
            }
        }
    }

    func cancelDraft() {
        gen += 1
        stopTick()
        stage = .input
        focusToken += 1
    }

    /// Proyecto por defecto, contexto del proyecto (tipos, prioridades, campos obligatorios) y valores de esos campos.
    func prepare(_ client: JiraClient, project wanted: String?, gen g: Int) async {
        let cfg = app.config
        do {
            if projects.isEmpty {
                let keys = (try? await client.projectStats())?.keys ?? []
                projects = JiraDraft.projectCandidates(keys, def: cfg.jiraCreateProject ?? JiraDraft.defaultProject)
            }
            let p = wanted ?? (cfg.jiraCreateProject.flatMap { projects.contains($0) ? $0 : nil } ?? projects.first ?? JiraDraft.defaultProject)
            project = p
            let c = try await client.createContext(p)
            guard g == gen || wanted != nil else { return }
            ctx = c
            let fields = c.extras.values.flatMap { $0 }
            var issues: [JSON] = []
            if !fields.isEmpty { issues = (try? await client.projectStats(fieldIds: Array(Set(fields.map(\.fieldId)))))?.issues ?? [] }
            var sel: [String: String] = [:]
            for f in fields {
                let opts = Set(f.options.map(\.id))
                if let s = cfg.jiraCreateFields[p]?[f.fieldId], opts.contains(s) {
                    sel[f.fieldId] = s
                } else if let m = JiraDraft.mostUsedOption(issues, project: p, fieldId: f.fieldId), opts.contains(m) {
                    sel[f.fieldId] = m
                } else {
                    sel[f.fieldId] = f.options.first?.id
                }
            }
            extraSel = sel
        } catch {
            if stage != .drafting { self.error = "Jira: \(error.localizedDescription)" }
        }
    }

    func changeProject(_ p: String) {
        guard let client, p != project else { return }
        ctx = nil
        typeId = nil
        Task { await prepare(client, project: p, gen: gen) }
    }

    func back() {
        stage = .input
        error = nil
        focusToken += 1
    }

    func create() {
        guard let client, stage == .review else { return }
        let s = collapseSpaces(summary)
        guard !s.isEmpty else {
            error = "Falta el resumen"
            return
        }
        stage = .creating
        error = nil
        let cfg = app.config
        Task {
            do {
                let c: CreateContext
                if let existing = ctx {
                    c = existing
                } else {
                    c = try await client.createContext(project)
                }
                ctx = c
                guard let type = currentType else { throw KaitoError.message("El proyecto \(project) no tiene tipos de ticket disponibles") }
                let fields = c.extras[type.id] ?? []
                var extras: [String: JSON] = [:]
                var sel: [String: String] = [:]
                for f in fields {
                    let id = extraSel[f.fieldId] ?? f.options.first?.id ?? ""
                    extras[f.fieldId] = JiraDraft.fieldValue(f, optionId: id)
                    sel[f.fieldId] = id
                }
                let (key, url) = try await client.createIssue(project: project, summary: s, description: desc, issueType: type,
                                                             priorityName: priority, extras: extras)
                var allFields = cfg.raw["jiraCreateFields"]?.object ?? [:]
                allFields[project] = .object(sel.mapValues { .string($0) })
                try? app.configStore.update(["jiraCreateProject": .string(project), "jiraCreateFields": .object(allFields)])
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url, forType: .string)
                // Los tickets nacen en "Por Asignar": pasarlos a "Por Hacer <Departamento>". Si falla, el ticket ya existe.
                let dept = fields.first { $0.name.range(of: "departament", options: .caseInsensitive) != nil }
                    .flatMap { f in f.options.first { $0.id == sel[f.fieldId] }?.value } ?? ""
                var msg = "\(key) creado: \(s)"
                do {
                    let r = try await client.moveToReady(key, department: dept, re: JiraViews.readyRegex(cfg.jiraCreateStatus))
                    msg = r.ready ? "\(key) creado en \(r.status): \(s)" : "\(key) creado (sigue en \(r.status))"
                } catch {
                    msg = "\(key) creado · no se pudo mover a Por Hacer: \(error.localizedDescription)"
                }
                Notifier.post(title: "Kaito", body: msg)
                app.show("\(msg) (enlace copiado)")
                app.refreshJira(force: true)
                onClose?()
            } catch {
                self.error = error.localizedDescription
                stage = .review
            }
        }
    }
}

@MainActor
struct CaptureView: View {
    @ObservedObject var model: CaptureModel
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("", selection: Binding(get: { model.mode }, set: { model.setMode($0) })) {
                ForEach(CaptureMode.allCases) { m in Text(m.title).tag(m) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(model.stage != .input || model.taskReview)

            if model.mode == .jira && (model.stage == .review || model.stage == .creating) {
                review
            } else if model.mode == .task && model.taskReview {
                taskReview
            } else {
                TextField(model.mode.hint, text: $model.text)
                    .textFieldStyle(.plain)
                    .font(.system(size: 20))
                    .focused($focused)
                    .disabled(model.stage == .drafting)
                    .onSubmit { model.submit() }
                footer
            }
            if let e = model.error {
                Text(e).font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(width: 640)
        .onAppear { focused = true }
        .onChange(of: model.focusToken) { _, _ in focused = true }
        .onExitCommand {
            if model.stage == .drafting {
                model.cancelDraft()
            } else if model.stage == .review {
                model.back()
            } else if model.taskReview {
                model.taskReview = false
                model.focusToken += 1
            } else {
                model.onClose?()
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        HStack(spacing: 8) {
            switch model.mode {
            case .note:
                Text("Se guarda en Notas, en el menú de Kaito").foregroundStyle(.secondary)
            case .reminder:
                Image(systemName: "alarm").foregroundStyle(model.reminderPreview == nil ? Color.secondary : Color.teal)
                Text(model.reminderPreview ?? "Añade cuándo: «en 20 min», «a las 17:30», «mañana»")
                    .foregroundStyle(model.reminderPreview == nil ? Color.secondary : Color.primary)
            case .task:
                Image(systemName: "clock").foregroundStyle(model.taskPreview == nil ? Color.secondary : Color.teal)
                Text(model.taskPreview ?? "Añade cuándo: «cada lunes a las 9», «todos los días a las 8», «mañana a las 10»")
                    .foregroundStyle(model.taskPreview == nil ? Color.secondary : Color.primary)
            case .jira:
                if model.stage == .drafting {
                    ProgressView().controlSize(.small)
                    Text("Redactando el ticket con Claude… \(model.elapsed) s").foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancelar") { model.cancelDraft() }
                } else {
                    Text("Enter: borrador con IA (Claude) · revisas antes de crear").foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text("Enter guardar · Esc cerrar").font(.caption).foregroundStyle(.tertiary)
        }
        .font(.callout)
    }

    private var taskReview: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Nombre de la tarea", text: $model.taskName)
                .textFieldStyle(.plain)
                .font(.system(size: 18, weight: .semibold))
            HStack(spacing: 6) {
                Image(systemName: "clock").foregroundStyle(.teal)
                Text(model.taskLabel).font(.callout)
            }
            TextEditor(text: $model.taskPrompt)
                .font(.callout)
                .frame(height: 120)
                .scrollContentBackground(.hidden)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.08)))
            HStack {
                TextField("Carpeta de trabajo", text: $model.taskCwd)
                    .textFieldStyle(.roundedBorder)
                TextField("Ticket (opcional)", text: $model.taskKey)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 140)
            }
            Picker("Herramientas", selection: $model.taskTools) {
                ForEach(Tasks.tools, id: \.self) { t in Text(Tasks.toolsLabel[t] ?? t).tag(t) }
            }
            .frame(width: 360)
            Text("Claude en modo headless con herramientas de solo lectura (sin editar ni ejecutar comandos); con BigQuery solo SELECT.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Volver") {
                    model.taskReview = false
                    model.focusToken += 1
                }
                Spacer()
                Button("Crear tarea") { model.createTask() }
                    .keyboardShortcut(.return, modifiers: .command)
            }
        }
    }

    private var review: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Resumen del ticket", text: $model.summary)
                .textFieldStyle(.plain)
                .font(.system(size: 18, weight: .semibold))
            TextEditor(text: $model.desc)
                .font(.callout)
                .frame(height: 170)
                .scrollContentBackground(.hidden)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.08)))
            HStack {
                Picker("Proyecto", selection: Binding(get: { model.project }, set: { model.changeProject($0) })) {
                    ForEach(model.projects.isEmpty ? [model.project] : model.projects, id: \.self) { Text($0).tag($0) }
                }
                .frame(width: 170)
                Picker("Tipo", selection: Binding(get: { model.currentType?.id ?? "" }, set: { model.typeId = $0 })) {
                    if model.ctx == nil { Text("Cargando…").tag("") }
                    ForEach(model.ctx?.types.filter { !$0.subtask } ?? []) { t in Text(t.name).tag(t.id) }
                }
                .frame(width: 170)
                Picker("Prioridad", selection: $model.priority) {
                    ForEach(JiraDraft.priorities, id: \.self) { p in Text(JiraDraft.priorityES[p] ?? p).tag(p) }
                }
                .frame(width: 180)
            }
            if let type = model.currentType, let fields = model.ctx?.extras[type.id], !fields.isEmpty {
                HStack {
                    ForEach(fields) { f in
                        Picker(f.name, selection: Binding(get: { model.extraSel[f.fieldId] ?? f.options.first?.id ?? "" },
                                                          set: { model.extraSel[f.fieldId] = $0 })) {
                            ForEach(f.options) { o in Text(o.value).tag(o.id) }
                        }
                        .frame(maxWidth: 260)
                    }
                }
            }
            HStack {
                Button("Volver") { model.back() }
                Spacer()
                if model.stage == .creating { ProgressView().controlSize(.small) }
                Button("Crear ticket") { model.create() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(model.stage == .creating || model.ctx == nil)
            }
        }
    }
}

@MainActor
final class CapturePanelController {
    static let shared = CapturePanelController()
    let model = CaptureModel()
    private var panel: KeyPanel?

    func toggle() {
        if panel?.isVisible == true { close() } else { show() }
    }

    func show() {
        if panel == nil {
            let p = makePanel(width: 640)
            let hc = NSHostingController(rootView: CaptureView(model: model))
            hc.sizingOptions = [.preferredContentSize]
            p.contentViewController = hc
            p.onCancel = { [weak self] in self?.close() }
            model.onClose = { [weak self] in self?.close() }
            panel = p
        }
        model.reset()
        guard let p = panel else { return }
        if let screen = activeScreen() {
            let f = screen.visibleFrame
            p.setFrameTopLeftPoint(NSPoint(x: f.midX - p.frame.width / 2, y: f.maxY - 110))
        }
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
    }

    func close() {
        panel?.orderOut(nil)
    }

    /// Captura en la pestaña Tarea con texto inicial (p. ej. "RUN-1: revisa que ").
    func showTask(prefill: String) {
        show()
        model.mode = .task
        model.text = prefill
        model.focusToken += 1
    }
}

// MARK: - Recordatorios en pantalla

@MainActor
struct ReminderCard: View {
    let reminders: [Reminder]
    let onSnooze: (String) -> Void
    let onDone: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(reminders) { r in
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: "alarm.fill").font(.title2).foregroundStyle(.orange)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(r.text.isEmpty ? "Recordatorio" : r.text).font(.headline).lineLimit(3)
                        Text(r.snoozes > 0 ? "\(When.shortLabel(r.due)) · pospuesto \(r.snoozes) \(r.snoozes == 1 ? "vez" : "veces")" : When.shortLabel(r.due))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    Button("Posponer 10 min") { onSnooze(r.id) }
                    Button("Hecho") { onDone(r.id) }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(16)
        .frame(width: 520)
    }
}

@MainActor
final class ReminderPanelController {
    static let shared = ReminderPanelController()
    weak var model: AppModel?
    private var panel: KeyPanel?
    private var shownIds: [String] = []
    private var announced = Set<String>()

    func update(with due: [Reminder], quiet: Bool = false) {
        let ids = due.map(\.id)
        if due.isEmpty {
            panel?.orderOut(nil)
            shownIds = []
            return
        }
        // Sonido y notificación solo para los que aparecen por primera vez (o vuelven tras posponer).
        let fresh = due.filter { !announced.contains("\($0.id)#\($0.snoozes)") }
        for r in fresh { announced.insert("\(r.id)#\(r.snoozes)") }
        if !fresh.isEmpty && !quiet {
            NSSound(named: NSSound.Name("Glass"))?.play()
            for r in fresh { Notifier.post(title: "Recordatorio", body: r.text) }
        }
        if ids == shownIds && panel?.isVisible == true { return }
        shownIds = ids
        let view = ReminderCard(reminders: due,
                                onSnooze: { id in AppModel.shared.snoozeReminder(id) },
                                onDone: { id in AppModel.shared.completeReminder(id) })
        if panel == nil {
            let p = makePanel(width: 520)
            p.level = .statusBar
            p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
            panel = p
        }
        guard let p = panel else { return }
        let host = NSHostingView(rootView: view)
        p.contentView = host
        p.setContentSize(host.fittingSize)
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            p.setFrameTopLeftPoint(NSPoint(x: f.midX - p.frame.width / 2, y: f.maxY - 12))
        }
        p.orderFrontRegardless() // sin robar el foco
    }
}
