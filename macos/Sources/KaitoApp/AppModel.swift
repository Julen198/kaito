import AppKit
import KaitoCore
import SwiftUI

/// Estado de la app: agentes, Jira, pendientes, recordatorios y notas. Todo en el hilo principal;
/// lo que bloquea (ps/lsof, ficheros grandes, red) va en tareas en segundo plano.
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    let paths = KaitoPaths.default
    let configStore: ConfigStore
    let data: DataStore
    let claude: ClaudeAgents
    let others: OtherAgents

    @Published var config = KaitoConfig()
    @Published var agents: [Agent] = []
    @Published var todos: [Todo] = []
    @Published var notes: [Note] = []
    @Published var reminders: [Reminder] = []

    @Published var views: [JiraView] = []
    @Published var jiraView = "mine"
    @Published var issues: [String: [JiraIssue]] = [:]
    @Published var jiraMessage: String?
    @Published var jiraLoading = false
    @Published var jiraBase = ""
    @Published var myAccountId: String?

    /// Fila con "Cambiar estado" abierta.
    @Published var expandedKey: String?
    @Published var transitions: [JiraTransition] = []
    @Published var transitionsLoading = false
    @Published var transitionNote: String?

    /// "Mandar a Claude": ticket para el que se elige repo.
    @Published var repoPickIssue: JiraIssue?
    @Published var repoChoices: [RankedRepo] = []
    @Published var allRepos: [String] = []
    @Published var searchingBranches = false
    /// Ramas ya existentes del ticket del selector (resultado de la última búsqueda), por si se elige otro repo.
    var foundBranches: [TicketBranch] = []

    @Published var flash: String?
    @Published var update: Updates.Release?

    /// No molestar / fuera de horario, uso (anillos), tareas programadas y statusLine de Claude.
    @Published var quiet = QuietState(quiet: false, reason: nil, until: nil)
    @Published var usage: [ProviderUsage] = []
    @Published var tasks: [ScheduledTask] = []
    @Published var runningTaskId: String?
    @Published var statusLineState = "none" // none | kaito | other
    @Published var statusLineBusy = false

    let taskStore: TaskStore
    let codexUsage: Usage.CodexReader
    let launchedAt = Date()
    /// sessionId → desde cuándo trabaja; nil hasta la primera carga (no avisar de lo que ya estaba parado).
    var busySince: [String: Date]?
    var taskQueue: [(id: String, manual: Bool)] = []
    var jiraOK = false

    private var timers: [Timer] = []
    private var agentsBusy = false
    private var jiraBusy = false
    private var lastJiraFetch = Date.distantPast
    private var flashTask: Task<Void, Never>?
    private var started = false
    private var currentHotkey = ""

    var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    init() {
        configStore = ConfigStore(paths: paths)
        data = DataStore(paths: paths)
        claude = ClaudeAgents(paths: paths)
        others = OtherAgents(paths: paths)
        taskStore = TaskStore(paths: paths)
        codexUsage = Usage.CodexReader(root: paths.codexSessions)
    }

    // MARK: contadores

    var needsCount: Int { agents.filter(\.needsYou).count }
    var workingCount: Int { agents.filter(\.live).count }
    var jiraCount: Int { issues["mine"]?.count ?? 0 }
    var todoCount: Int { todos.filter { !$0.done }.count }

    // MARK: arranque y refrescos

    func start() {
        guard !started else { return }
        started = true
        reloadConfig()
        refreshLocal()
        refreshAgents()
        refreshJira(force: true)
        Notifier.setup()
        ReminderPanelController.shared.model = self
        checkReminders()
        Task { await checkForUpdate() }
        timers = [
            Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
                Task { @MainActor in AppModel.shared.refreshAgents() }
            },
            Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
                Task { @MainActor in
                    let m = AppModel.shared
                    m.refreshLocal()
                    m.checkReminders()
                    if Date().timeIntervalSince(m.lastJiraFetch) >= Double(m.config.refreshSeconds) { m.refreshJira() }
                }
            },
            Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { _ in
                Task { @MainActor in await AppModel.shared.checkForUpdate() }
            },
            Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
                Task { @MainActor in AppModel.shared.periodic() }
            },
            // Primer repaso a los pocos segundos (avisos retenidos, resumen del día, tareas vencidas).
            Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { _ in
                Task { @MainActor in AppModel.shared.periodic() }
            },
        ]
        refreshUsage()
        refreshStatusLineState()
    }

    func reloadConfig() {
        config = configStore.read()
        views = JiraViews.visibleViews(config)
        if !views.contains(where: { $0.id == jiraView }) {
            jiraView = views.contains(where: { $0.id == config.jiraView }) ? config.jiraView : "mine"
        }
        if currentHotkey != config.captureHotkey {
            currentHotkey = config.captureHotkey
            HotKey.shared.register(config.captureHotkey) {
                CapturePanelController.shared.toggle()
            }
        }
    }

    /// Ficheros locales (config, pendientes, notas, recordatorios). Baratos: en el hilo principal.
    func refreshLocal() {
        reloadConfig()
        let t = data.todos(), n = data.notes(), r = data.reminders(), k = taskStore.read()
        if t != todos { todos = t }
        if n != notes { notes = n }
        if r != reminders { reminders = r }
        if k != tasks { tasks = k }
        let q = Quiet.isQuiet(Date(), config: config)
        if q != quiet { quiet = q }
    }

    func refreshAgents() {
        guard !agentsBusy else { return }
        agentsBusy = true
        let cfg = config
        let claude = self.claude, others = self.others
        Task.detached(priority: .utility) {
            let states = claude.readStates()
            var list = claude.collect(windowS: cfg.agentWindowMinutes * 60, states: states, liveS: cfg.liveSeconds)
            let wanted = Set(cfg.agentProviders.filter { $0.value && $0.key != "claude" }.map(\.key))
            list += others.collect(providers: wanted, states: states, liveS: cfg.liveSeconds)
            let dismissed = claude.readDismissed()
            let r = AgentParsing.applyDismissed(list, dismissed)
            if r.changed { claude.writeDismissed(r.dismissed) }
            let visible = r.visible
            await MainActor.run {
                let m = AppModel.shared
                if m.agents != visible { m.agents = visible }
                m.agentsBusy = false
                m.checkDone(visible)
            }
        }
    }

    func dismiss(_ a: Agent) {
        var map = claude.readDismissed()
        map[a.id] = Date().timeIntervalSince1970 * 1000
        claude.writeDismissed(map)
        agents.removeAll { $0.id == a.id }
    }

    func decide(_ a: Agent, allow: Bool) {
        guard let req = a.hook?.request else { return }
        do {
            try claude.writeDecision(sessionId: a.id, request: req, behavior: allow ? "allow" : "deny")
            show(allow ? "Permitido" : "Denegado")
        } catch {
            show("No se pudo responder: \(error.localizedDescription)")
        }
    }

    func focus(_ a: Agent) {
        let ok = a.pid.map { Terminals.focus(pid: $0) } ?? false
        if !ok { show("No encuentro la terminal de \(a.cwd ?? "este agente")") }
    }

    // MARK: avisos dentro del menú

    func show(_ text: String) {
        flash = text
        flashTask?.cancel()
        flashTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if !Task.isCancelled { AppModel.shared.flash = nil }
        }
    }

    // MARK: Jira

    func jiraClient() -> JiraClient? {
        guard config.jiraConfigured else {
            jiraMessage = "Falta configurar Jira: abre Ajustes"
            return nil
        }
        guard let token = Keychain.token(), !token.isEmpty else {
            jiraMessage = "Sin token en el llavero: abre Ajustes"
            return nil
        }
        return JiraClient(baseUrl: config.jiraBaseUrl, email: config.jiraEmail, token: token)
    }

    /// Proyectos para las vistas de equipo: los de tus tickets (en caché) o los de la config.
    func resolveProjects(seen: [String]) -> [String] {
        let cachePath = paths.jiraProjectsCache
        let cached = (JSONFile.read(cachePath)?["projects"]?.array ?? []).compactMap(\.string)
        if !seen.isEmpty {
            if seen != cached { try? JSONFile.write(cachePath, ["projects": .array(seen.map { .string($0) })], pretty: false) }
            return seen
        }
        return cached.isEmpty ? config.jiraProjects : cached
    }

    func refreshJira(force: Bool = false) {
        guard config.jiraEnabled else {
            issues = [:]
            jiraMessage = nil
            return
        }
        guard !jiraBusy else { return }
        lastJiraFetch = Date()
        guard let client = jiraClient() else { return }
        jiraBusy = true
        jiraLoading = issues.isEmpty
        let cfg = config
        let viewList = views
        Task {
            defer {
                jiraBusy = false
                jiraLoading = false
            }
            do {
                let mine = try await client.search(jql: cfg.jiraJql, max: cfg.jiraMax)
                var out: [String: [JiraIssue]] = ["mine": mine]
                let projects = resolveProjects(seen: JiraViews.projectsFromIssues(mine))
                for v in viewList where v.id != "mine" {
                    let jql = v.custom ? v.jql : JiraViews.viewJql(v.id, projects: projects, mineJql: cfg.jiraJql)
                    guard let jql else { continue }
                    out[v.id] = (try? await client.search(jql: jql, max: cfg.jiraMax)) ?? issues[v.id] ?? []
                }
                issues = out
                jiraBase = client.base
                jiraMessage = nil
                jiraOK = true
                if myAccountId == nil { myAccountId = try? await client.myself()["accountId"]?.string }
            } catch {
                jiraMessage = "Jira: \(error.localizedDescription)"
                jiraOK = false
            }
        }
    }

    func selectView(_ id: String) {
        jiraView = id
        try? configStore.update(["jiraView": .string(id)])
    }

    func openIssue(_ i: JiraIssue) {
        guard let url = URL(string: "\(jiraBase)/browse/\(i.key)") else { return }
        NSWorkspace.shared.open(url)
    }

    func canAssign(_ i: JiraIssue, view: String) -> Bool {
        if view == "unassigned" { return true }
        if view == "sprint" { return i.assignee == nil || (myAccountId != nil && i.assignee?.accountId != myAccountId) }
        return false
    }

    func assignToMe(_ i: JiraIssue) {
        guard let client = jiraClient() else { return }
        Task {
            do {
                try await client.assignToMe(i.key)
                show("\(i.key) asignado a ti")
                refreshJira(force: true)
            } catch {
                show("No se pudo asignar \(i.key): \(error.localizedDescription)")
            }
        }
    }

    func toggleTransitions(_ i: JiraIssue) {
        if expandedKey == i.key {
            expandedKey = nil
            return
        }
        expandedKey = i.key
        transitions = []
        transitionNote = nil
        transitionsLoading = true
        guard let client = jiraClient() else { return }
        Task {
            do {
                let list = try await client.transitions(i.key)
                if expandedKey == i.key { transitions = list }
            } catch {
                transitionNote = "No se pudieron cargar los estados: \(error.localizedDescription)"
            }
            transitionsLoading = false
        }
    }

    func applyTransition(_ i: JiraIssue, _ t: JiraTransition) {
        guard let client = jiraClient() else { return }
        transitionNote = "Moviendo…"
        Task {
            do {
                try await client.applyTransition(i.key, id: t.id)
                transitionNote = nil
                expandedKey = nil
                show("\(i.key) movido a \(t.to.isEmpty ? t.name : t.to)")
                refreshJira(force: true)
            } catch {
                transitionNote = "No se pudo mover a \(t.to.isEmpty ? t.name : t.to): \(error.localizedDescription)"
            }
        }
    }

    // MARK: Mandar a Claude

    func beginRepoPick(_ i: JiraIssue) {
        repoPickIssue = i
        repoChoices = []
        let cfg = config
        let paths = self.paths
        Task.detached(priority: .userInitiated) {
            let recent = Repos.collectRecent(paths: paths)
            let scanned = Repos.scan(roots: cfg.repoRoots, home: paths.home)
            var seen = Set<String>()
            let all = (recent + scanned).filter { seen.insert($0).inserted }
            let ranked = JiraViews.rankRepos(i, repos: all, byIssue: cfg.jiraRepoByIssue, byProject: cfg.jiraRepoByProject,
                                             exists: FileUtil.isDir)
            await MainActor.run {
                let m = AppModel.shared
                guard m.repoPickIssue?.key == i.key else { return }
                m.repoChoices = ranked
                m.allRepos = ranked.map(\.path)
                m.searchingBranches = true
                m.foundBranches = []
            }
            // Busca sin bloquear si el ticket ya tiene rama en algún repo candidato.
            let found = Finish.findTicketBranches(key: i.key, repos: ranked.map(\.path))
            var byRepo: [String: TicketBranch] = [:]
            for f in found where byRepo[f.repo] == nil { byRepo[f.repo] = f }
            let reranked = JiraViews.rankRepos(i, repos: all, byIssue: cfg.jiraRepoByIssue, byProject: cfg.jiraRepoByProject,
                                               exists: FileUtil.isDir, branches: byRepo)
            await MainActor.run {
                let m = AppModel.shared
                guard m.repoPickIssue?.key == i.key else { return }
                m.foundBranches = found
                m.repoChoices = reranked
                m.allRepos = reranked.map(\.path)
                m.searchingBranches = false
            }
        }
    }

    func sendToClaude(_ issue: JiraIssue, repo: String) {
        repoPickIssue = nil
        let client = jiraClient()
        let base = jiraBase
        let cfg = config
        try? configStore.update([
            "jiraRepoByIssue": .object(cfg.jiraRepoByIssue.merging([issue.key: repo]) { $1 }.mapValues { .string($0) }),
            "jiraRepoByProject": .object(cfg.jiraRepoByProject.merging([JiraViews.projectOf(issue.key): repo]) { $1 }.mapValues { .string($0) }),
        ])
        let others = foundBranches
        Task {
            var detail: IssueDetail? = nil
            if let client { detail = try? await client.issueDetail(issue.key) }
            // Rama ya existente: la del repo elegido (consulta exacta) o, si no, la mejor de otro repo.
            let existing = await Task.detached { Finish.findTicketBranches(key: issue.key, repos: [repo]).first }.value
                ?? others.first(where: { $0.repo != repo })
            do {
                let prompt = JiraViews.buildPrompt(issue, base: base, detail: detail, repo: repo, branch: Repos.branch(repo), existing: existing)
                let promptPath = "\(paths.promptsDir)/\(issue.key).txt"
                try FileUtil.writeText(promptPath, prompt, dirMode: 0o700)
                try Terminals.launchClaude(key: issue.key, repo: repo, promptPath: promptPath, preference: cfg.terminal)
                show("\(issue.key) enviado a Claude en \(baseName(repo) ?? repo)")
            } catch {
                show("No se pudo mandar \(issue.key) a Claude: \(error.localizedDescription)")
                return
            }
            // Ticket "Por hacer" mandado a Claude: pasa a la primera transición "en curso".
            if issue.category == "new", let client {
                if let t = JiraViews.pickTransition(try? await client.transitions(issue.key), kind: "start") {
                    do {
                        try await client.applyTransition(issue.key, id: t.id)
                        Notifier.post(title: "Kaito", body: "\(issue.key) movido a \(t.to)")
                        refreshJira(force: true)
                    } catch {
                        NSLog("kaito: no se pudo mover \(issue.key): \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    // MARK: pendientes, recordatorios y notas

    func addTodo(_ text: String) {
        let t = trimmed(text)
        guard !t.isEmpty else { return }
        do { try data.addTodo(t) } catch { show("No se pudo guardar: \(error.localizedDescription)") }
        refreshLocal()
    }

    func toggleTodo(_ t: Todo) {
        try? data.setTodo(t, done: !t.done)
        refreshLocal()
    }

    func clearDoneTodos() {
        for t in data.todos().reversed() where t.done { try? data.removeTodo(t) }
        refreshLocal()
    }

    /// "llamar a Iker en 20 min" → recordatorio. Devuelve el texto de confirmación o nil si no hay cuándo.
    @discardableResult
    func addReminder(_ text: String) -> String? {
        guard let w = When.parse(text) else { return nil }
        let what = w.clean.isEmpty ? trimmed(text) : w.clean
        do {
            try data.addReminder(what, due: w.date)
        } catch {
            show("No se pudo guardar: \(error.localizedDescription)")
            return nil
        }
        refreshLocal()
        return w.label
    }

    func completeReminder(_ id: String) {
        try? data.completeReminder(id)
        refreshLocal()
        checkReminders()
    }

    /// option nil = el botón principal (snoozeMinutes de la config).
    func snoozeReminder(_ id: String, option: SnoozeOption? = nil) {
        let o = option ?? .minutes(config.snoozeMinutes)
        try? data.snoozeReminder(id, until: Snooze.until(o, now: Date()))
        refreshLocal()
        checkReminders()
    }

    /// Con No molestar: sin sonido ni notificación; si además dndSilenceReminders, se retienen hasta que acabe.
    func checkReminders() {
        let q = Quiet.isQuiet(Date(), config: config)
        if q.quiet && config.dndSilenceReminders {
            ReminderPanelController.shared.update(with: [], quiet: true)
            return
        }
        ReminderPanelController.shared.update(with: data.dueReminders(), quiet: q.quiet)
    }

    func addNote(_ text: String) {
        let t = trimmed(text)
        guard !t.isEmpty else { return }
        do { try data.addNote(t) } catch { show("No se pudo guardar: \(error.localizedDescription)") }
        refreshLocal()
    }

    func removeNote(_ n: Note) {
        try? data.removeNote(n)
        refreshLocal()
    }

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        show("Copiado")
    }

    // MARK: actualizaciones

    func checkForUpdate(force: Bool = false) async {
        guard config.checkUpdates || force else { return }
        let state = JSONFile.read(paths.macUpdatePath)
        let now = Date().timeIntervalSince1970
        if !force && !Updates.shouldCheck(lastChecked: state?["checkedAt"]?.number, now: now) {
            if let tag = state?["tag"]?.string, state?["hasMacAsset"]?.bool == true, Updates.isNewer(tag, than: version) {
                update = Updates.Release(tag: tag, hasMacAsset: true, url: state?["url"]?.string ?? "")
            }
            return
        }
        guard let url = URL(string: Updates.latestURL) else { return }
        var req = URLRequest(url: url)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Kaito-macOS", forHTTPHeaderField: "User-Agent")
        guard let res = try? await URLSession.shared.data(for: req), let rel = Updates.parseRelease(JSON.parse(res.0)) else { return }
        try? JSONFile.write(paths.macUpdatePath, ["checkedAt": .number(now), "tag": .string(rel.tag),
                                                  "hasMacAsset": .bool(rel.hasMacAsset), "url": .string(rel.url)], pretty: false)
        update = rel.hasMacAsset && Updates.isNewer(rel.tag, than: version) ? rel : nil
        if force && update == nil { show("Kaito \(version) está al día") }
    }

    /// Lanza el instalador en una terminal visible (descarga, sustituye la app y la vuelve a abrir).
    func runUpdate() {
        let cmd = "curl -fsSL \(Updates.installURL) | bash -s -- --update"
        do {
            try Terminals.runInTerminal(cmd, preference: config.terminal)
        } catch {
            show("No se pudo abrir la terminal: \(error.localizedDescription)")
        }
    }
}
