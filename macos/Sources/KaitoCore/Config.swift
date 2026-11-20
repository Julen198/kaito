import Foundation

public struct JiraPreset: Sendable {
    public let id: String
    public let title: String
    public let jql: String?
}

public struct CustomView: Equatable, Sendable {
    public var id: String
    public var name: String
    public var jql: String
    public var enabled: Bool
}

/// Config de ~/.config/kaito/config.json con valores por defecto (mismas claves que la versión de Linux).
public struct KaitoConfig: Sendable {
    public static let presets: [JiraPreset] = [
        JiraPreset(id: "open", title: "Mis tickets abiertos",
                   jql: "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC"),
        JiraPreset(id: "progress", title: "Solo en curso",
                   jql: "assignee=currentUser() AND statusCategory=\"In Progress\" ORDER BY updated DESC"),
        JiraPreset(id: "sprint", title: "Sprint actual",
                   jql: "assignee=currentUser() AND sprint in openSprints() AND resolution=Unresolved ORDER BY rank"),
        JiraPreset(id: "custom", title: "Consulta JQL propia", jql: nil),
    ]
    public static let defaultJql = presets[0].jql!
    /// Terminales de macOS. 'auto': iTerm2 si está abierto; si no, Terminal.
    public static let terminals = ["auto", "terminal", "iterm", "warp"]
    public static let captureHotkeys = ["ctrl+alt+space", "ctrl+alt+k", "ctrl+shift+space", "cmd+shift+k", "off"]
    public static let repoRootCandidates = ["Documentos", "Documents", "dev", "code", "projects", "src", "Developer"]

    public var raw: [String: JSON] = [:]
    public var agentWindowMinutes = 10
    public var liveSeconds = 60
    public var refreshSeconds = 30
    public var jiraMax = 20
    public var jiraEnabled = true
    public var jiraBaseUrl = ""
    public var jiraEmail = ""
    public var jiraJql = KaitoConfig.defaultJql
    public var jiraPreset: String? = nil
    public var jiraView = "mine"
    public var jiraViews: [CustomView] = []
    public var jiraBuiltinViews: [String: Bool] = ["unassigned": true, "sprint": true, "recent": true]
    public var jiraProjects: [String] = []
    public var jiraRepoByProject: [String: String] = [:]
    public var jiraRepoByIssue: [String: String] = [:]
    public var repoRoots: [String] = []
    public var terminal = "auto"
    public var agentProviders: [String: Bool] = [:]
    public var captureHotkey = "ctrl+alt+space"
    public var checkUpdates = true
    public var claudeBin: String? = nil
    public var jiraCreateProject: String? = nil
    public var jiraCreateStatus: String? = nil
    public var jiraCreateFields: [String: [String: String]] = [:]
    // Avisos, tareas, uso y "No molestar" (mismas claves y valores por defecto que readConfig de common.js).
    public var notifyDone = true
    public var autoReview = true
    public var reviewReminderMinutes = 30
    public var dailySummary = true
    public var snoozeMinutes = 10 // 5, 10, 15, 30 o 60
    public var showUsage = true
    public var tasksEnabled = true
    public var workHours = WorkHours.default
    public var dndManual = false
    public var dndUntil: Double? = nil // epoch ms
    public var dndSkipUntil: Double? = nil // epoch ms
    public var dndSilenceReminders = false
    public var bqMcpServer: String? = nil
    /// El tour de bienvenida ya se vio (o se saltó).
    public var tourDone = false

    public init() {}

    public var jiraConfigured: Bool { !jiraBaseUrl.isEmpty && !jiraEmail.isEmpty }
    public var jiraBase: String { jiraBaseUrl.replacingOccurrences(of: "/+$", with: "", options: .regularExpression) }

    static let projectRE = Regex("^[A-Z][A-Z0-9_]*$")

    public static func defaultRepoRoots(home: String, isDir: (String) -> Bool = FileUtil.isDir) -> [String] {
        let found = repoRootCandidates.map { "\(home)/\($0)" }.filter(isDir)
        return found.isEmpty ? ["\(home)/Documents"] : found
    }

    /// Puro: config desde el JSON crudo (mismas validaciones que readConfig de common.js).
    public static func from(_ rawValue: JSON?, home: String = NSHomeDirectory(), isDir: (String) -> Bool = FileUtil.isDir) -> KaitoConfig {
        var c = KaitoConfig()
        let raw = rawValue?.object ?? [:]
        c.raw = raw
        func pos(_ k: String, _ d: Int) -> Int {
            if let n = raw[k]?.number, n.isFinite, n > 0 { return Int(n) }
            return d
        }
        c.agentWindowMinutes = pos("agentWindowMinutes", 10)
        c.liveSeconds = pos("liveSeconds", 60)
        c.refreshSeconds = pos("refreshSeconds", 30)
        c.jiraMax = pos("jiraMax", 20)
        c.jiraEnabled = raw["jiraEnabled"]?.bool != false
        c.checkUpdates = raw["checkUpdates"]?.bool != false
        c.jiraBaseUrl = raw["jiraBaseUrl"]?.string ?? ""
        c.jiraEmail = raw["jiraEmail"]?.string ?? ""
        c.terminal = terminals.contains(raw["terminal"]?.string ?? "") ? raw["terminal"]!.string! : "auto"
        c.captureHotkey = captureHotkeys.contains(raw["captureHotkey"]?.string ?? "") ? raw["captureHotkey"]!.string! : "ctrl+alt+space"
        if let v = raw["jiraView"]?.string, !v.isEmpty { c.jiraView = v }
        c.jiraViews = normalizeCustomViews(raw["jiraViews"])
        if let b = raw["jiraBuiltinViews"]?.object {
            for (k, v) in b { if let bb = v.bool { c.jiraBuiltinViews[k] = bb } }
        }
        c.jiraProjects = (raw["jiraProjects"]?.array ?? []).compactMap { $0.string }.filter { projectRE.test($0) }
        c.jiraRepoByProject = (raw["jiraRepoByProject"]?.object ?? [:]).compactMapValues { $0.string }
        c.jiraRepoByIssue = (raw["jiraRepoByIssue"]?.object ?? [:]).compactMapValues { $0.string }
        let roots = (raw["repoRoots"]?.array ?? []).compactMap { $0.string }
        c.repoRoots = !roots.isEmpty && roots.count == raw["repoRoots"]?.array?.count ? roots : defaultRepoRoots(home: home, isDir: isDir)
        var prov: [String: Bool] = [:]
        let rp = raw["agentProviders"]?.object ?? [:]
        for p in Providers.all { prov[p.id] = rp[p.id]?.bool != false }
        c.agentProviders = prov
        if let b = raw["claudeBin"]?.string, !trimmed(b).isEmpty { c.claudeBin = trimmed(b) }
        c.notifyDone = raw["notifyDone"]?.bool != false
        c.autoReview = raw["autoReview"]?.bool != false
        if let rm = raw["reviewReminderMinutes"]?.number, rm.isFinite, rm >= 0 { c.reviewReminderMinutes = Int(rm.rounded()) }
        c.dailySummary = raw["dailySummary"]?.bool != false
        c.snoozeMinutes = Snooze.minutesOr(raw["snoozeMinutes"]?.number)
        c.showUsage = raw["showUsage"]?.bool != false
        c.tasksEnabled = raw["tasksEnabled"]?.bool != false
        c.workHours = WorkHours.normalize(raw["workHours"])
        c.dndManual = raw["dndManual"]?.bool == true
        func epoch(_ k: String) -> Double? {
            guard let v = raw[k]?.number, v.isFinite, v > 0 else { return nil }
            return v
        }
        c.dndUntil = epoch("dndUntil")
        c.dndSkipUntil = epoch("dndSkipUntil")
        c.dndSilenceReminders = raw["dndSilenceReminders"]?.bool == true
        if let b = raw["bqMcpServer"]?.string, !trimmed(b).isEmpty { c.bqMcpServer = trimmed(b) }
        c.tourDone = raw["tourDone"]?.bool == true
        c.jiraCreateProject = raw["jiraCreateProject"]?.string
        c.jiraCreateStatus = raw["jiraCreateStatus"]?.string
        if let f = raw["jiraCreateFields"]?.object {
            for (p, v) in f { c.jiraCreateFields[p] = (v.object ?? [:]).compactMapValues { $0.string } }
        }
        // Un preset guardado manda sobre el jiraJql copiado en su día.
        c.jiraPreset = raw["jiraPreset"]?.string
        if let p = presets.first(where: { $0.id == c.jiraPreset && $0.jql != nil }) {
            c.jiraJql = p.jql!
        } else if let j = raw["jiraJql"]?.string, !trimmed(j).isEmpty {
            c.jiraJql = j
        } else {
            c.jiraJql = defaultJql
        }
        return c
    }

    public static func normalizeCustomViews(_ list: JSON?) -> [CustomView] {
        guard let arr = list?.array else { return [] }
        var seen = Set<String>()
        var out: [CustomView] = []
        for v in arr {
            guard v.object != nil else { continue }
            let id = trimmed(v["id"]?.text ?? "")
            if id.isEmpty || seen.contains(id) || JiraViews.builtin.contains(where: { $0.id == id }) { continue }
            seen.insert(id)
            out.append(CustomView(id: id, name: trimmed(v["name"]?.text ?? ""), jql: trimmed(v["jql"]?.text ?? ""),
                                  enabled: v["enabled"]?.bool != false))
        }
        return out
    }
}

/// Lectura/escritura de config.json conservando las claves desconocidas.
public struct ConfigStore: Sendable {
    public let paths: KaitoPaths

    public init(paths: KaitoPaths = .default) { self.paths = paths }

    public func read() -> KaitoConfig {
        KaitoConfig.from(JSONFile.read(paths.configPath), home: paths.home)
    }

    /// Lectura-modificación-escritura: conserva las claves desconocidas. Un valor .null borra la clave.
    public func update(_ patch: [String: JSON]) throws {
        var raw = JSONFile.read(paths.configPath)?.object ?? [:]
        for (k, v) in patch {
            if v == .null { raw.removeValue(forKey: k) } else { raw[k] = v }
        }
        try JSONFile.write(paths.configPath, .object(raw))
    }
}
