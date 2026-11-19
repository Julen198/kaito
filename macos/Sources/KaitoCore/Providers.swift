import Foundation

public struct Provider: Sendable {
    public let id: String
    public let name: String
    public let title: String
    public let level: String
    public let bins: [String]
}

/// Port de providers.js: detección de procesos de agentes (no Claude) y lectura de rollouts de Codex.
public enum Providers {
    public static let all: [Provider] = [
        Provider(id: "claude", name: "Claude", title: "Claude Code", level: "full", bins: ["claude"]),
        Provider(id: "codex", name: "Codex", title: "Codex", level: "sessions", bins: ["codex"]),
        Provider(id: "gemini", name: "Gemini", title: "Gemini CLI", level: "process", bins: ["gemini"]),
        Provider(id: "opencode", name: "OpenCode", title: "OpenCode", level: "process", bins: ["opencode"]),
        Provider(id: "aider", name: "Aider", title: "Aider", level: "process", bins: ["aider"]),
        Provider(id: "cursor", name: "Cursor", title: "Cursor Agent", level: "process", bins: ["cursor-agent"]),
    ]

    public static func byId(_ id: String) -> Provider? { all.first { $0.id == id } }

    static let interpreters = Regex("^(node|nodejs|bun|deno|python3?(\\.\\d+)?|uv|npx)$")
    static let notSession: [String: Set<String>] = [
        "codex": ["app-server", "exec-server", "exec", "e", "mcp", "mcp-server", "remote-control", "login", "logout",
                  "completion", "sandbox", "debug", "doctor", "update", "features", "apply", "a", "cloud", "review", "help", "--help", "-h", "--version", "-V"],
        "gemini": ["mcp", "--help", "-h", "--version", "-v"],
        "opencode": ["serve", "web", "mcp", "auth", "upgrade", "models", "stats", "export", "import", "github", "acp", "--help", "-h", "--version", "-v"],
        "aider": ["--help", "-h", "--version"],
        "cursor": ["--help", "-h", "--version", "-v", "login", "logout", "status", "mcp", "update"],
    ]
    static let extRE = Regex("\\.(m?js|cjs|py)$")

    static func base(_ s: String?) -> String {
        let last = (s ?? "").split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        return extRE.replace(last, with: "")
    }

    /// Proveedor (sin 'claude') de un proceso por su argv y comm; nil si no es una sesión de agente.
    public static func matchAgentProcess(_ argv: [String], comm: String = "") -> String? {
        guard !argv.isEmpty else { return nil }
        var i = 0
        if interpreters.test(base(argv[0])) {
            i = 1
            while i < argv.count && argv[i].hasPrefix("-") { i += 1 }
        }
        var name = i < argv.count ? base(argv[i]) : ""
        if name.isEmpty { name = base(comm) }
        guard let p = all.first(where: { $0.id != "claude" && $0.bins.contains(name) }) else { return nil }
        let rest = i + 1 < argv.count ? Array(argv[(i + 1)...]) : []
        let sub = rest.first { !$0.hasPrefix("-") } ?? ""
        let ns = notSession[p.id] ?? []
        let flag = rest.first { ns.contains($0) && $0.hasPrefix("-") }
        if flag != nil || ns.contains(sub) { return nil }
        return p.id
    }

    public struct Proc: Equatable, Sendable {
        public var pid: Int32
        public var ppid: Int32
        public var provider: String
        public var cwd: String?
        public var startMs: Double?
        public init(pid: Int32, ppid: Int32, provider: String, cwd: String? = nil, startMs: Double? = nil) {
            self.pid = pid; self.ppid = ppid; self.provider = provider; self.cwd = cwd; self.startMs = startMs
        }
    }

    /// Quita los procesos con un hijo directo del mismo proveedor (lanzador node → binario nativo).
    public static func dedupe(_ list: [Proc]) -> [Proc] {
        let parents = Set(list.map { "\($0.provider):\($0.ppid)" })
        return list.filter { !parents.contains("\($0.provider):\($0.pid)") }
    }

    static let firstLineStripRE = Regex("^[#>*\\-\\s]+")

    static func firstLineOf(_ s: String?, _ n: Int) -> String {
        let l = (s ?? "").components(separatedBy: "\n").map { trimmed(firstLineStripRE.replace($0, with: "")) }.first { !$0.isEmpty } ?? ""
        return trunc(l, n)
    }

    public struct RolloutMeta: Equatable, Sendable {
        public var id: String?
        public var cwd: String?
        public var startedMs: Double?
    }

    static let cwdRE = Regex("\"cwd\":\"((?:[^\"\\\\]|\\\\.)*)\"")
    static let idRE = Regex("\"id\":\"([0-9a-f-]{36})\"")

    /// Cabecera de un rollout (línea session_meta) → {id, cwd, startedMs}.
    public static func parseRolloutMeta(_ text: String) -> RolloutMeta? {
        for line in text.components(separatedBy: "\n").prefix(5) where line.contains("session_meta") {
            if let o = JSON.parse(line), o.object != nil {
                if o["type"]?.string == "session_meta", let p = o["payload"], p.object != nil {
                    let ts = ISODate.parse(p["timestamp"]?.string ?? o["timestamp"]?.string)
                    let id = p["id"]?.text ?? p["session_id"]?.text ?? ""
                    return RolloutMeta(id: id.isEmpty ? nil : id, cwd: p["cwd"]?.string, startedMs: ts.map { $0.timeIntervalSince1970 * 1000 })
                }
            } else if let m = cwdRE.firstMatch(line), let raw = m[1], let cwd = JSON.parse("\"\(raw)\"")?.string {
                // Línea cortada (base_instructions es largo): basta con la clave cwd.
                return RolloutMeta(id: idRE.firstMatch(line)?[1], cwd: cwd, startedMs: nil)
            }
        }
        return nil
    }

    static let rolloutIdRE = Regex("rollout-[\\dT-]+?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.jsonl$")

    public static func rolloutId(_ path: String) -> String? {
        rolloutIdRE.firstMatch(path)?[1]
    }

    static func actionOf(_ o: JSON) -> String? {
        guard let p = o["payload"], p.object != nil else { return nil }
        let type = o["type"]?.string
        if type == "event_msg" && p["type"]?.string == "item_completed" {
            let it = p["item"] ?? .object([:])
            switch it["type"]?.string {
            case "CommandExecution":
                let c = it["command"]?.array?.last?.string ?? it["command"]?.string
                guard let c else { return nil }
                return trunc("$ " + (c.components(separatedBy: "\n").first ?? ""))
            case "FileChange":
                let files = Array((it["changes"]?.object ?? [:]).keys)
                return files.count == 1 ? trunc("Edit " + (files[0].split(separator: "/").last.map(String.init) ?? files[0])) : "Edit \(files.count) ficheros"
            case "AgentMessage":
                let t = (it["content"]?.array ?? []).compactMap { $0["text"]?.string }.joined(separator: "\n")
                return trimmed(t).isEmpty ? nil : firstLineOf(t, 60)
            case "Extension":
                return it["kind"]?.string.map { trunc($0) }
            default:
                return nil
            }
        }
        if type == "event_msg" && p["type"]?.string == "agent_message", let m = p["message"]?.string {
            return firstLineOf(m, 60)
        }
        if type == "response_item", ["function_call", "custom_tool_call"].contains(p["type"]?.string ?? ""), let n = p["name"]?.string, !n.isEmpty {
            return trunc(n)
        }
        return nil
    }

    public struct CodexTail: Equatable, Sendable {
        public var lastAction: String?
        public var lastText: String?
        public var turnOpen = false
        public var lastStartMs: Double?
        public var lastCompleteMs: Double?
        public var lastEventMs: Double?
        public init() {}
    }

    /// Cola de un rollout de Codex → acción, último texto final y si hay un turno abierto.
    public static func parseCodexTail(_ text: String) -> CodexTail {
        var out = CodexTail()
        var turnSeen = false
        for line in text.components(separatedBy: "\n").reversed() {
            if trimmed(line).isEmpty { continue }
            guard let o = JSON.parse(line), o.object != nil else { continue }
            let ts = ISODate.parse(o["timestamp"]?.string).map { $0.timeIntervalSince1970 * 1000 }
            if out.lastEventMs == nil, let ts { out.lastEventMs = ts }
            if o["type"]?.string == "event_msg", let p = o["payload"], !turnSeen {
                let pt = p["type"]?.string
                if pt == "task_started" {
                    turnSeen = true
                    out.turnOpen = true
                    out.lastStartMs = ts
                } else if pt == "task_complete" || pt == "turn_aborted" {
                    turnSeen = true
                    out.lastCompleteMs = ts
                    if pt == "task_complete", let m = p["last_agent_message"]?.string, out.lastText == nil {
                        let l = firstLineOf(m, 160)
                        out.lastText = l.isEmpty ? nil : l
                    }
                }
            }
            if out.lastAction == nil { out.lastAction = actionOf(o) }
            if turnSeen && out.lastAction != nil { break }
        }
        return out
    }

    /// Estado de una sesión de Codex → (live, state: working|done|idle).
    public static func codexStatus(tail: CodexTail, mtimeMs: Double, nowMs: Double, liveS: Double = 60, staleS: Double = 15 * 60,
                                   hook: HookState? = nil) -> (live: Bool, state: String) {
        let age = (nowMs - mtimeMs) / 1000
        let hookTs = (hook?.ts ?? .nan) * 1000
        let doneByHook = hook?.state == "done" && hookTs.isFinite && hookTs >= (tail.lastStartMs ?? 0)
        if doneByHook && hookTs >= mtimeMs - 2000 { return (false, "done") }
        let turnKnown = tail.lastStartMs != nil || tail.lastCompleteMs != nil || tail.turnOpen
        if tail.turnOpen ? age < staleS : (!turnKnown && age < liveS) { return (true, "working") }
        return (false, doneByHook || tail.lastCompleteMs != nil ? "done" : "idle")
    }

    public struct RolloutFile: Equatable, Sendable {
        public var path: String
        public var mtime: Double
        public var size: Int
    }

    /// rollout-*.jsonl de los últimos días (~/.codex/sessions/AAAA/MM/DD), del más nuevo al más viejo.
    public static func recentRollouts(root: String, maxDays: Int = 7) -> [RolloutFile] {
        func sub(_ dir: String, _ re: Regex) -> [String] {
            FileUtil.list(dir).filter { re.test($0) && FileUtil.isDir("\(dir)/\($0)") }.sorted().reversed()
        }
        let y4 = Regex("^\\d{4}$"), d2 = Regex("^\\d{2}$")
        var days: [String] = []
        outer: for y in sub(root, y4) {
            for m in sub("\(root)/\(y)", d2) {
                for d in sub("\(root)/\(y)/\(m)", d2) {
                    days.append("\(root)/\(y)/\(m)/\(d)")
                    if days.count >= maxDays { break outer }
                }
            }
        }
        var files: [RolloutFile] = []
        for dir in days {
            for n in FileUtil.list(dir) where n.hasPrefix("rollout-") && n.hasSuffix(".jsonl") {
                let p = "\(dir)/\(n)"
                files.append(RolloutFile(path: p, mtime: FileUtil.mtime(p) ?? 0, size: FileUtil.size(p)))
            }
        }
        return files.sorted { $0.mtime > $1.mtime }
    }
}
