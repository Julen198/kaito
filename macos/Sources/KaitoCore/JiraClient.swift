import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct CreateContext: Sendable {
    public var project: String
    public var types: [IssueTypeRef]
    public var priorities: [JiraPriority]
    public var accountId: String?
    public var extras: [String: [ExtraField]] // por id de tipo
}

/// Cliente REST de Jira Cloud (Basic auth email:token) sobre URLSession.
public final class JiraClient: @unchecked Sendable {
    public let base: String
    let email: String
    let token: String
    let session: URLSession
    private var myselfCache: JSON?
    private var ctxCache: [String: CreateContext] = [:]
    private let lock = NSLock()

    public init(baseUrl: String, email: String, token: String, session: URLSession = .shared) {
        base = baseUrl.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        self.email = email
        self.token = token
        self.session = session
    }

    /// Acceso síncrono a las cachés (NSLock no se puede usar directamente en funciones async).
    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    static let searchFields = "summary,status,priority,description,labels,components,updated,assignee"
    static let issueFields = "summary,description,status,priority,issuetype,parent,subtasks,issuelinks,labels,components,reporter,created,attachment,comment,customfield_10062"

    public static func encode(_ s: String) -> String {
        // Igual que encodeURIComponent: solo ASCII sin reservar.
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    static func checkKey(_ key: String) throws {
        guard JiraViews.keyRE.test(key) else { throw KaitoError.message("clave no válida: \(key)") }
    }

    /// Petición; devuelve (status, cuerpo JSON) sin lanzar por códigos HTTP.
    public func send(_ method: String, _ path: String, body: JSON? = nil) async throws -> (Int, JSON?) {
        guard let url = URL(string: base + path) else { throw KaitoError.message("URL de Jira no válida") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 30
        let auth = Data("\(email):\(token)".utf8).base64EncodedString()
        req.setValue("Basic \(auth)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data(body.serialized().utf8)
        }
        let (data, status): (Data, Int) = try await withCheckedThrowingContinuation { cont in
            session.dataTask(with: req) { data, resp, err in
                if let err {
                    cont.resume(throwing: err)
                } else {
                    cont.resume(returning: (data ?? Data(), (resp as? HTTPURLResponse)?.statusCode ?? 0))
                }
            }.resume()
        }
        return (status, data.isEmpty ? nil : JSON.parse(data))
    }

    /// GET autenticado; lanza con mensaje legible.
    public func get(_ path: String) async throws -> JSON {
        let (status, body) = try await send("GET", path)
        if status == 401 || status == 403 { throw KaitoError.message("HTTP \(status): credenciales no válidas") }
        guard status == 200 else {
            let detail = body?["errorMessages"]?[0]?.text ?? ""
            throw KaitoError.message(detail.isEmpty ? "HTTP \(status)" : "HTTP \(status): \(detail)")
        }
        return body ?? .null
    }

    public func search(jql: String, max: Int) async throws -> [JiraIssue] {
        let data = try await get("/rest/api/3/search/jql?jql=\(Self.encode(jql))&fields=\(Self.searchFields)&maxResults=\(max)")
        return JiraViews.sortIssues((data["issues"]?.array ?? []).map(JiraViews.mapSearchIssue))
    }

    public func myself() async throws -> JSON {
        if let cached = withLock({ myselfCache }) { return cached }
        let me = try await get("/rest/api/3/myself")
        withLock { myselfCache = me }
        return me
    }

    public func issueDetail(_ key: String) async throws -> IssueDetail {
        try Self.checkKey(key)
        let d = try await get("/rest/api/3/issue/\(key)?fields=\(Self.issueFields)")
        return JiraViews.formatIssueDetail(d["fields"])
    }

    public func transitions(_ key: String) async throws -> [JiraTransition] {
        try Self.checkKey(key)
        return JiraViews.normalizeTransitions(try await get("/rest/api/3/issue/\(key)/transitions"))
    }

    public func applyTransition(_ key: String, id: String) async throws {
        try Self.checkKey(key)
        let (status, body) = try await send("POST", "/rest/api/3/issue/\(key)/transitions", body: ["transition": ["id": .string(id)]])
        guard (200..<300).contains(status) else { throw KaitoError.message(JiraDraft.jiraErrorText(body, status: status)) }
    }

    public func assign(_ key: String, accountId: String) async throws {
        try Self.checkKey(key)
        let (status, body) = try await send("PUT", "/rest/api/3/issue/\(key)/assignee", body: ["accountId": .string(accountId)])
        guard (200..<300).contains(status) else { throw KaitoError.message(JiraDraft.jiraErrorText(body, status: status)) }
    }

    public func assignToMe(_ key: String) async throws {
        guard let id = try await myself()["accountId"]?.string else { throw KaitoError.message("sin accountId") }
        try await assign(key, accountId: id)
    }

    /// {summary, status, category} de un ticket.
    public func basics(_ key: String) async throws -> (summary: String, status: String, category: String) {
        try Self.checkKey(key)
        let d = try await get("/rest/api/3/issue/\(key)?fields=summary,status")
        return (d["fields"]?["summary"]?.text ?? "", d["fields"]?["status"]?["name"]?.text ?? "",
                d["fields"]?["status"]?["statusCategory"]?["key"]?.text ?? "")
    }

    /// Proyectos de tus tickets (claves) y los tickets con los campos pedidos.
    public func projectStats(fieldIds: [String] = []) async throws -> (keys: [String], issues: [JSON]) {
        let jql = Self.encode("assignee = currentUser() ORDER BY updated DESC")
        let fields = (["project"] + fieldIds).joined(separator: ",")
        let data = try await get("/rest/api/3/search/jql?jql=\(jql)&fields=\(fields)&maxResults=100")
        let issues = data["issues"]?.array ?? []
        return (issues.map { $0["key"]?.text ?? "" }, issues)
    }

    /// Tipos, prioridades, tu accountId y campos obligatorios extra por tipo. Cacheado por proyecto.
    public func createContext(_ project: String) async throws -> CreateContext {
        if let cached = withLock({ ctxCache[project] }) { return cached }
        let p = Self.encode(project)
        let typesRes = try await get("/rest/api/3/issue/createmeta/\(p)/issuetypes?maxResults=50")
        let prios = (try? await get("/rest/api/3/priority"))?.array ?? []
        let me = try? await myself()
        let types = (typesRes["issueTypes"]?.array ?? typesRes["values"]?.array ?? []).map {
            IssueTypeRef(id: $0["id"]?.text ?? "", name: $0["name"]?.text ?? "", subtask: $0["subtask"]?.bool == true)
        }
        var extras: [String: [ExtraField]] = [:]
        for t in types where !t.subtask {
            if let f = try? await get("/rest/api/3/issue/createmeta/\(p)/issuetypes/\(t.id)?maxResults=100") {
                extras[t.id] = JiraDraft.extraRequiredFields(f["fields"]?.array ?? f["values"]?.array ?? [])
            } else {
                extras[t.id] = []
            }
        }
        let ctx = CreateContext(project: project, types: types,
                                priorities: prios.map { JiraPriority(id: $0["id"]?.text ?? "", name: $0["name"]?.text ?? "") },
                                accountId: me?["accountId"]?.string, extras: extras)
        withLock { ctxCache[project] = ctx }
        return ctx
    }

    /// Crea el ticket. Si Jira rechaza la prioridad o el responsable, reintenta sin ellos. → (clave, url)
    public func createIssue(project: String, summary: String, description: String, issueType: IssueTypeRef,
                            priorityName: String?, extras: [String: JSON]) async throws -> (key: String, url: String) {
        let ctx = try await createContext(project)
        var priority: String? = priorityName.map { JiraDraft.matchPriority($0, priorities: ctx.priorities) ?? JiraDraft.priorityIds[$0] ?? "3" }
        var accountId = ctx.accountId
        for _ in 0..<3 {
            let payload = JiraDraft.buildIssuePayload(project: project, summary: summary, description: description,
                                                      issueType: issueType, priorityId: priority, accountId: accountId, extras: extras)
            let (status, body) = try await send("POST", "/rest/api/3/issue", body: payload)
            if (200..<300).contains(status), let key = body?["key"]?.string {
                return (key, "\(base)/browse/\(key)")
            }
            if status == 401 || status == 403 { throw KaitoError.message("HTTP \(status): credenciales o permisos no válidos") }
            let errs = body?["errors"]?.object ?? [:]
            if status == 400 && priority != nil && errs["priority"] != nil {
                priority = nil
                continue
            }
            if status == 400 && accountId != nil && errs["assignee"] != nil {
                accountId = nil
                continue
            }
            throw KaitoError.message(JiraDraft.jiraErrorText(body, status: status))
        }
        throw KaitoError.message("Jira rechazó el ticket")
    }

    /// Tras crear: si no está en un estado "listo", aplica la transición a "Por Hacer <Departamento>".
    public func moveToReady(_ key: String, department: String = "", re: Regex = JiraViews.readyRE) async throws -> (status: String, moved: Bool, ready: Bool) {
        let cur = try await basics(key)
        if re.test(trimmed(cur.status)) { return (cur.status, false, true) }
        guard let t = JiraViews.pickReadyTransition(try await transitions(key), department: department, re: re) else {
            return (cur.status, false, false)
        }
        try await applyTransition(key, id: t.id)
        return (t.to, true, true)
    }
}

/// Ejecuta `claude -p` (borradores de tickets), como runClaude de jiradraft.js.
public enum ClaudeCLI {
    /// Ruta del binario: config.claudeBin, PATH, ~/.local/bin, ~/.claude/local, Homebrew.
    public static func find(claudeBin: String?, home: String = NSHomeDirectory()) -> String? {
        if let b = claudeBin, !b.isEmpty {
            let p = FileUtil.expandTilde(b, home: home)
            if FileUtil.isExecutable(p) { return p }
        }
        return Shell.which("claude", dirs: Shell.searchDirs(home: home))
    }

    /// Entorno para el subproceso: PATH completo (las apps gráficas no heredan el de la shell) y sin variables de una sesión anidada.
    public static func environment(home: String = NSHomeDirectory()) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = Shell.searchDirs(home: home).joined(separator: ":")
        env["HOME"] = home
        for v in ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION"] {
            env.removeValue(forKey: v)
        }
        return env
    }

    /// Lanza `claude -p` con el prompt por stdin (cwd $HOME). Devuelve stdout.
    public static func run(argv: [String], prompt: String, timeout: TimeInterval = JiraDraft.draftTimeout,
                           home: String = NSHomeDirectory()) async throws -> String {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                let r = Shell.run(argv, stdin: prompt, cwd: home, env: environment(home: home), timeout: timeout)
                if r.timedOut {
                    cont.resume(throwing: KaitoError.message("La IA no respondió en \(Int(timeout)) s"))
                } else if r.status != 0 && trimmed(r.out).isEmpty {
                    let last = trimmed(r.err).components(separatedBy: "\n").last ?? ""
                    cont.resume(throwing: KaitoError.message("claude terminó con error: \(String(last.prefix(200)))"))
                } else {
                    cont.resume(returning: r.out)
                }
            }
        }
    }

    public static func draft(_ text: String, claudeBin: String?) async throws -> Draft {
        guard let bin = find(claudeBin: claudeBin) else {
            throw KaitoError.message("No encuentro «claude»: define claudeBin en ~/.config/kaito/config.json")
        }
        return try JiraDraft.parseCliOutput(try await run(argv: JiraDraft.claudeArgv(bin), prompt: JiraDraft.buildDraftPrompt(text)))
    }
}
