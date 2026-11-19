import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Estado escrito por hooks/kaito-hook.py en ~/.cache/kaito/state/<session_id>.json.
public struct HookState: Equatable, Sendable {
    public var state: String // "needs" | "done"
    public var message: String
    public var cwd: String
    public var ts: Double // segundos
    public var kind: String?
    public var tool: String?
    public var detail: String?
    public var request: String?
    public var waitUntil: Double?

    public static func from(_ v: JSON, mtime: Double) -> HookState? {
        guard let st = v["state"]?.string, st == "needs" || st == "done" else { return nil }
        let ts = v["ts"]?.number ?? 0
        return HookState(state: st, message: v["message"]?.text ?? "", cwd: v["cwd"]?.text ?? "",
                         ts: ts > 0 ? ts : mtime, kind: v["kind"]?.string, tool: v["tool"]?.string,
                         detail: v["detail"]?.string, request: v["request"]?.string, waitUntil: v["waitUntil"]?.number)
    }
}

public struct Agent: Identifiable, Equatable, Sendable {
    public var id: String
    public var provider: String = "claude"
    public var pid: Int32? = nil
    public var cwd: String? = nil // nombre de la carpeta
    public var cwdPath: String? = nil
    public var age: Int = 0 // segundos desde la última actividad
    public var live: Bool = false
    public var state: String? = nil // needs | done | working | idle | open
    public var message: String? = nil
    public var lastAction: String? = nil
    public var lastText: String? = nil
    public var activityMs: Double = 0
    public var ticket: String? = nil
    public var hook: HookState? = nil

    public init(id: String) { self.id = id }

    public var needsYou: Bool { state == "needs" }
}

public struct TailInfo: Equatable {
    public var cwd: String?
    public var lastAction: String?
    public var lastText: String?
}

/// Lógica pura de agents.js.
public enum AgentParsing {
    static let lastTextMax = 2000

    static func actionFromMessage(_ e: JSON) -> String? {
        let content = e["message"]?["content"]
        if let s = content?.string { return trunc(s) }
        guard let arr = content?.array else { return nil }
        if let tool = arr.last(where: { $0["type"]?.string == "tool_use" }) {
            let input = tool["input"]
            let extra = input?["description"]?.string ?? input?["command"]?.string ?? ""
            return trunc("\(tool["name"]?.text ?? ""): \(extra)")
        }
        if let text = arr.last(where: { $0["type"]?.string == "text" && !trimmed($0["text"]?.string ?? "").isEmpty }) {
            return trunc(text["text"]?.string)
        }
        return nil
    }

    static func textFromMessage(_ e: JSON) -> String? {
        let content = e["message"]?["content"]
        if let s = content?.string {
            let t = trimmed(s)
            return t.isEmpty ? nil : t
        }
        guard let arr = content?.array else { return nil }
        if let text = arr.last(where: { $0["type"]?.string == "text" && !trimmed($0["text"]?.string ?? "").isEmpty }) {
            return trimmed(text["text"]?.string ?? "")
        }
        return nil
    }

    /// Texto de la cola de un .jsonl → {cwd, lastAction, lastText}. La primera línea se descarta (puede venir cortada).
    public static func parseTail(_ text: String) -> TailInfo {
        var lines = text.components(separatedBy: "\n")
        if !lines.isEmpty { lines.removeFirst() }
        var info = TailInfo()
        for line in lines.reversed() {
            if trimmed(line).isEmpty { continue }
            guard let e = JSON.parse(line), e.object != nil else { continue }
            if info.cwd == nil, let c = e["cwd"]?.string {
                info.cwd = baseName(c) ?? c
            }
            let isAssistant = e["type"]?.string == "assistant"
            if info.lastAction == nil && isAssistant { info.lastAction = actionFromMessage(e) }
            if info.lastText == nil && isAssistant {
                if let t = textFromMessage(e) { info.lastText = String(t.prefix(lastTextMax)) }
            }
            if info.cwd != nil && info.lastAction != nil && info.lastText != nil { break }
        }
        return info
    }

    static let ticketRE = Regex("^\\s*Trabaja en el ticket de Jira ([A-Z][A-Z0-9_]*-\\d+)")

    static func userText(_ e: JSON) -> String? {
        guard e["type"]?.string == "user", e["isMeta"]?.bool != true else { return nil }
        let c = e["message"]?["content"]
        if let s = c?.string { return s }
        guard let arr = c?.array, !arr.contains(where: { $0["type"]?.string == "tool_result" }) else { return nil }
        let t = arr.filter { $0["type"]?.string == "text" }.map { $0["text"]?.string ?? "" }.joined(separator: "\n")
        return t.isEmpty ? nil : t
    }

    public enum TicketHead: Equatable {
        case ticket(String)
        case none // primer mensaje que no es de Kaito
        case unknown // aún no hay mensaje del usuario (no cachear)
    }

    /// Cabeza de un .jsonl → clave del ticket si el primer mensaje del usuario es un prompt de Kaito.
    public static func ticketFromHead(_ text: String) -> TicketHead {
        for line in text.components(separatedBy: "\n") {
            if !line.contains("\"user\"") { continue }
            guard let e = JSON.parse(line), let t = userText(e) else { continue }
            if let m = ticketRE.firstMatch(t), let k = m[1] { return .ticket(k) }
            return .none
        }
        return .unknown
    }

    static let firstLineStripRE = Regex("^[#>*\\-\\s]+")

    /// Primera línea no vacía, sin marcas de markdown, recortada a n caracteres.
    public static func firstLine(_ text: String?, _ n: Int = 160) -> String {
        let line = (text ?? "").components(separatedBy: "\n")
            .map { trimmed(firstLineStripRE.replace($0, with: "")) }
            .first { !$0.isEmpty } ?? ""
        return line.count > n ? String(line.prefix(n - 1)) + "…" : line
    }

    public static func ago(_ seconds: Int) -> String {
        seconds < 60 ? "hace \(seconds)s" : "hace \(seconds / 60) min"
    }

    /// ~/.claude/projects/<cwd con todo lo no alfanumérico -> '-'>
    public static func projectDirName(_ cwd: String) -> String {
        String(cwd.unicodeScalars.map { ($0.isASCII && CharacterSet.alphanumerics.contains($0)) ? Character($0) : "-" })
    }

    /// Un agente ocultado vuelve con actividad posterior o al entrar en "needs". → (visibles, mapa podado, cambiado)
    public static func applyDismissed(_ agents: [Agent], _ dismissed: [String: Double]) -> (visible: [Agent], dismissed: [String: Double], changed: Bool) {
        let ids = Set(agents.map(\.id))
        var next: [String: Double] = [:]
        var visible: [Agent] = []
        for a in agents {
            guard let at = dismissed[a.id], a.state != "needs", a.activityMs <= at else {
                visible.append(a)
                continue
            }
            next[a.id] = at
        }
        let changed = dismissed.count != next.count || dismissed.keys.contains { !ids.contains($0) }
        return (visible, next, changed)
    }

    /// ¿La petición de permiso sigue esperando respuesta de Kaito?
    public static func canDecide(_ a: Agent, nowS: Double = Date().timeIntervalSince1970) -> Bool {
        guard let h = a.hook, a.state == "needs", h.kind == "permission", h.request != nil else { return false }
        return (h.waitUntil ?? 0) > nowS
    }

    /// {ticket: agente más reciente}.
    public static func agentsByTicket(_ agents: [Agent]) -> [String: Agent] {
        var out: [String: Agent] = [:]
        for a in agents {
            guard let t = a.ticket else { continue }
            if let cur = out[t], cur.age <= a.age { continue }
            out[t] = a
        }
        return out
    }
}

/// ¿Sigue vivo el proceso? (kill 0; EPERM = existe pero es de otro usuario).
public func processAlive(_ pid: Int32) -> Bool {
    if pid <= 0 { return false }
    if kill(pid, 0) == 0 { return true }
    return errno == EPERM
}

/// Lectura de agentes de Claude Code: registro de sesiones vivas + transcripts + estados de los hooks.
public final class ClaudeAgents: @unchecked Sendable {
    static let stateMaxAge: Double = 24 * 3600
    static let tailBytes = 64 * 1024
    static let headBytes = 256 * 1024

    public let paths: KaitoPaths
    public var isAlive: (Int32) -> Bool
    private var ticketCache: [String: String?] = [:]
    private let lock = NSLock()

    public init(paths: KaitoPaths = .default, isAlive: @escaping (Int32) -> Bool = processAlive) {
        self.paths = paths
        self.isAlive = isAlive
    }

    /// {session_id: estado}. Borra los de más de 24 h.
    public func readStates(now: Double = Date().timeIntervalSince1970) -> [String: HookState] {
        var out: [String: HookState] = [:]
        for name in FileUtil.list(paths.stateDir) where name.hasSuffix(".json") && !name.hasPrefix(".") {
            let path = "\(paths.stateDir)/\(name)"
            let mtime = FileUtil.mtime(path) ?? now
            if now - mtime > Self.stateMaxAge {
                try? FileManager.default.removeItem(atPath: path)
                continue
            }
            if let v = JSONFile.read(path), let st = HookState.from(v, mtime: mtime) {
                out[String(name.dropLast(5))] = st
            }
        }
        return out
    }

    struct LiveSession {
        let pid: Int32
        let sessionId: String
        let cwd: String
        let status: String?
        let updatedAt: Double?
    }

    /// Sesiones CLI vivas (~/.claude/sessions/<pid>.json); nil si no existe el registro.
    func readLiveSessions() -> [LiveSession]? {
        guard FileUtil.isDir(paths.claudeSessions) else { return nil }
        var out: [LiveSession] = []
        for name in FileUtil.list(paths.claudeSessions) {
            guard name.hasSuffix(".json"), Int(name.dropLast(5)) != nil else { continue }
            guard let s = JSONFile.read("\(paths.claudeSessions)/\(name)") else { continue }
            // sdk-ts / sdk-cli son herramientas en segundo plano, no sesiones del usuario.
            guard s["entrypoint"]?.string == "cli", let sid = s["sessionId"]?.string, !sid.isEmpty,
                  let pid = s["pid"]?.int else { continue }
            guard isAlive(Int32(pid)) else { continue } // huérfano tras un crash
            out.append(LiveSession(pid: Int32(pid), sessionId: sid, cwd: s["cwd"]?.string ?? "",
                                   status: s["status"]?.string, updatedAt: s["updatedAt"]?.number))
        }
        return out
    }

    func sessionTicket(_ sessionId: String, _ file: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        if let c = ticketCache[sessionId] { return c }
        guard let head = FileUtil.readHead(file, bytes: Self.headBytes) else { return nil }
        switch AgentParsing.ticketFromHead(head) {
        case .ticket(let k):
            ticketCache[sessionId] = .some(k)
            return k
        case .none:
            ticketCache[sessionId] = .some(nil)
            return nil
        case .unknown:
            return nil
        }
    }

    /// Escaneo por mtime (sin registro de sesiones).
    func scanByMtime(windowS: Int, extraIds: Set<String>, now: Double) -> [Agent] {
        var found: [Agent] = []
        for d in FileUtil.list(paths.claudeProjects) where !d.contains("claude-mem-observer") {
            let dir = "\(paths.claudeProjects)/\(d)"
            guard FileUtil.isDir(dir) else { continue }
            for f in FileUtil.list(dir) where f.hasSuffix(".jsonl") {
                let id = String(f.dropLast(6))
                let path = "\(dir)/\(f)"
                let mt = FileUtil.mtime(path) ?? 0
                let age = Int(now - mt)
                if age > windowS && !extraIds.contains(id) { continue }
                var a = Agent(id: id)
                let info = AgentParsing.parseTail(FileUtil.readTail(path, bytes: Self.tailBytes) ?? "")
                a.cwd = info.cwd
                a.lastAction = info.lastAction
                a.lastText = info.lastText
                a.age = max(0, age)
                a.activityMs = mt * 1000
                found.append(a)
            }
        }
        return found.sorted { $0.age < $1.age }
    }

    /// Agentes activos + estado de los hooks (como collectAgents de common.js).
    public func collect(windowS: Int, states: [String: HookState], liveS: Int = 60, now: Double = Date().timeIntervalSince1970) -> [Agent] {
        let needIds = Set(states.filter { $0.value.state == "needs" }.map(\.key))
        var agents: [Agent]
        if let sessions = readLiveSessions() {
            agents = sessions.map { s in
                var a = Agent(id: s.sessionId)
                a.pid = s.pid
                a.cwd = baseName(s.cwd)
                a.cwdPath = s.cwd.isEmpty ? nil : s.cwd
                let updated = (s.updatedAt ?? now * 1000) / 1000
                a.age = max(0, Int(now - updated))
                a.activityMs = s.updatedAt ?? 0
                let file = "\(paths.claudeProjects)/\(AgentParsing.projectDirName(s.cwd))/\(s.sessionId).jsonl"
                if FileUtil.exists(file) {
                    a.ticket = sessionTicket(s.sessionId, file)
                    let info = AgentParsing.parseTail(FileUtil.readTail(file, bytes: Self.tailBytes) ?? "")
                    a.lastAction = info.lastAction
                    a.lastText = info.lastText
                    if let mt = FileUtil.mtime(file) {
                        a.age = max(0, Int(now - mt))
                        a.activityMs = max(a.activityMs, mt * 1000)
                    }
                }
                a.live = s.status == "busy" ? true : s.status == "idle" ? false : a.age < liveS
                a.state = a.live ? "working" : nil
                return a
            }.sorted { $0.age < $1.age }
        } else {
            agents = scanByMtime(windowS: windowS, extraIds: needIds, now: now)
            for i in agents.indices {
                agents[i].live = agents[i].age < liveS
                agents[i].state = agents[i].live ? "working" : nil
            }
        }
        let seen = Set(agents.map(\.id))
        for i in agents.indices {
            if let st = states[agents[i].id] {
                agents[i].state = st.state
                agents[i].message = st.message
                agents[i].hook = st
            }
        }
        for id in needIds.sorted() where !seen.contains(id) {
            guard let st = states[id] else { continue }
            var a = Agent(id: id)
            a.state = "needs"
            a.message = st.message
            a.hook = st
            a.cwdPath = st.cwd.isEmpty ? nil : st.cwd
            a.cwd = baseName(st.cwd)
            a.age = max(0, Int(now - st.ts))
            a.activityMs = st.ts * 1000
            agents.append(a)
        }
        return agents
    }

    // MARK: ocultados (×): {sessionId: dismissedAtMs} en ~/.cache/kaito/dismissed.json

    public func readDismissed() -> [String: Double] {
        (JSONFile.read(paths.dismissedPath)?.object ?? [:]).compactMapValues { $0.number }
    }

    public func writeDismissed(_ map: [String: Double]) {
        try? JSONFile.write(paths.dismissedPath, .object(map.mapValues { .number($0) }), pretty: false)
    }

    /// Respuesta (allow|deny) para el hook que espera en la sesión.
    public func writeDecision(sessionId: String, request: String, behavior: String) throws {
        guard Regex("^[A-Za-z0-9_-]+$").test(sessionId), ["allow", "deny"].contains(behavior) else {
            throw KaitoError.message("decisión no válida")
        }
        try JSONFile.write("\(paths.decisionsDir)/\(sessionId).json",
                           ["request": .string(request), "behavior": .string(behavior)], pretty: false, dirMode: 0o700)
    }
}

public enum KaitoError: Error, LocalizedError, Equatable {
    case message(String)
    public var errorDescription: String? {
        switch self { case .message(let m): return m }
    }
}
