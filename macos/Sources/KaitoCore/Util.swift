import Foundation

/// Rutas compartidas con la versión de Linux y con hooks/kaito-hook.py (mismo criterio XDG: variable o ~/.config, ~/.cache).
public struct KaitoPaths: Sendable {
    public var home: String
    public var configHome: String
    public var cacheHome: String
    public var dataHome: String

    public init(home: String = NSHomeDirectory(), env: [String: String] = ProcessInfo.processInfo.environment) {
        self.home = home
        let cfg = env["XDG_CONFIG_HOME"].flatMap { $0.hasPrefix("/") ? $0 : nil }
        let cache = env["XDG_CACHE_HOME"].flatMap { $0.hasPrefix("/") ? $0 : nil }
        let data = env["XDG_DATA_HOME"].flatMap { $0.hasPrefix("/") ? $0 : nil }
        configHome = cfg ?? "\(home)/.config"
        cacheHome = cache ?? "\(home)/.cache"
        dataHome = data ?? "\(home)/.local/share"
    }

    public static let `default` = KaitoPaths()

    public var confDir: String { "\(configHome)/kaito" }
    public var configPath: String { "\(confDir)/config.json" }
    public var todosPath: String { "\(confDir)/todos.json" }
    public var kanbanPath: String { "\(confDir)/kanban.json" } // {seq}: contador de ids K-<n>
    public var notesPath: String { "\(confDir)/notes.json" }
    public var remindersPath: String { "\(confDir)/reminders.json" }
    public var cacheDir: String { "\(cacheHome)/kaito" }
    public var stateDir: String { "\(cacheDir)/state" }
    public var promptsDir: String { "\(cacheDir)/prompts" }
    public var decisionsDir: String { "\(cacheDir)/decisions" }
    public var dismissedPath: String { "\(cacheDir)/dismissed.json" }
    public var jiraProjectsCache: String { "\(cacheDir)/jira-projects.json" }
    public var macUpdatePath: String { "\(cacheDir)/mac-update.json" }
    public var finishedPath: String { "\(cacheDir)/finished.json" }
    public var claudeUsagePath: String { "\(cacheDir)/claude-usage.json" } // lo escribe hooks/kaito-statusline.py
    public var dailyPath: String { "\(cacheDir)/daily.json" }
    public var quietQueuePath: String { "\(cacheDir)/quiet-queue.json" }
    public var tasksPath: String { "\(confDir)/tasks.json" }
    public var taskRunsDir: String { "\(dataHome)/kaito/task-runs" }
    public var claudeJson: String { "\(home)/.claude.json" }
    /// Código instalado por install-mac.sh (hooks/ con merge-settings.py y kaito-statusline.py).
    public var installedSrc: String { "\(home)/.local/share/kaito-src" } // ruta fija en install-mac.sh
    public var claudeProjects: String { "\(home)/.claude/projects" }
    public var claudeSessions: String { "\(home)/.claude/sessions" }
    public var claudeSettings: String { "\(home)/.claude/settings.json" }
    public var codexSessions: String { "\(home)/.codex/sessions" }
    public var warpLaunchDir: String { "\(home)/.warp/launch_configurations" }
}

// MARK: - Texto

/// Minúsculas sin tildes (como `plain` de los .js).
public func plainText(_ s: String) -> String {
    let lower = s.lowercased().decomposedStringWithCanonicalMapping
    var out = String.UnicodeScalarView()
    for u in lower.unicodeScalars where !(0x300...0x36F).contains(u.value) {
        out.append(u)
    }
    return String(out)
}

/// Espacios colapsados y recorte a n caracteres con "…".
public func trunc(_ s: String?, _ n: Int = 60) -> String {
    let t = collapseSpaces(s ?? "")
    return t.count > n ? String(t.prefix(n - 1)) + "…" : t
}

public func collapseSpaces(_ s: String) -> String {
    s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

public func trimmed(_ s: String) -> String {
    s.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// Último componente no vacío de una ruta ("/a/b/" -> "b").
public func baseName(_ path: String?) -> String? {
    guard let p = path else { return nil }
    return p.split(separator: "/").last.map(String.init)
}

/// Comillas simples de shell POSIX.
public func shQuote(_ s: String) -> String {
    "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

// MARK: - Expresiones regulares (NSRegularExpression funciona igual en macOS y Linux)

public struct RegexMatch {
    public let range: NSRange
    public let groups: [String?]
    public subscript(i: Int) -> String? { i < groups.count ? groups[i] : nil }
    public var start: Int { range.location }
    public var end: Int { range.location + range.length }
}

public final class Regex: @unchecked Sendable {
    public let re: NSRegularExpression

    public init(_ pattern: String, caseInsensitive: Bool = false, multiline: Bool = false) {
        var opts: NSRegularExpression.Options = []
        if caseInsensitive { opts.insert(.caseInsensitive) }
        if multiline { opts.insert(.anchorsMatchLines) }
        // Patrones fijos del código: un fallo aquí es un error de programación.
        re = try! NSRegularExpression(pattern: pattern, options: opts)
    }

    public func firstMatch(_ s: String) -> RegexMatch? {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, options: [], range: NSRange(location: 0, length: ns.length)) else { return nil }
        return Self.convert(m, ns)
    }

    public func matches(_ s: String) -> [RegexMatch] {
        let ns = s as NSString
        return re.matches(in: s, options: [], range: NSRange(location: 0, length: ns.length)).map { Self.convert($0, ns) }
    }

    public func test(_ s: String) -> Bool {
        firstMatch(s) != nil
    }

    public func replace(_ s: String, with template: String) -> String {
        let ns = s as NSString
        return re.stringByReplacingMatches(in: s, options: [], range: NSRange(location: 0, length: ns.length), withTemplate: template)
    }

    /// Reemplaza solo la primera coincidencia (como String.replace de JS sin /g).
    public func replaceFirst(_ s: String, with template: String) -> String {
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, options: [], range: NSRange(location: 0, length: ns.length)) else { return s }
        let rep = re.replacementString(for: m, in: s, offset: 0, template: template)
        return ns.replacingCharacters(in: m.range, with: rep)
    }

    private static func convert(_ m: NSTextCheckingResult, _ ns: NSString) -> RegexMatch {
        var groups: [String?] = []
        for i in 0..<m.numberOfRanges {
            let r = m.range(at: i)
            groups.append(r.location == NSNotFound ? nil : ns.substring(with: r))
        }
        return RegexMatch(range: m.range, groups: groups)
    }
}

// MARK: - Ficheros

public enum FileUtil {
    public static func exists(_ path: String) -> Bool {
        FileManager.default.fileExists(atPath: path)
    }

    public static func isDir(_ path: String) -> Bool {
        var d: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &d) && d.boolValue
    }

    public static func isExecutable(_ path: String) -> Bool {
        !isDir(path) && FileManager.default.isExecutableFile(atPath: path)
    }

    public static func list(_ dir: String) -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
    }

    public static func size(_ path: String) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.intValue ?? 0
    }

    /// mtime en segundos (con fracción), o nil.
    public static func mtime(_ path: String) -> Double? {
        ((try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date)?.timeIntervalSince1970
    }

    /// Últimos `bytes` del fichero como texto (UTF-8 con pérdidas).
    public static func readTail(_ path: String, bytes: Int = 64 * 1024) -> String? {
        guard let h = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? h.close() }
        let size = h.seekToEndOfFile()
        let start = size > UInt64(bytes) ? size - UInt64(bytes) : 0
        h.seek(toFileOffset: start)
        let data = h.readDataToEndOfFile()
        return String(decoding: data, as: UTF8.self)
    }

    /// Primeros `bytes` del fichero como texto.
    public static func readHead(_ path: String, bytes: Int = 64 * 1024) -> String? {
        guard let h = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? h.close() }
        return String(decoding: h.readData(ofLength: bytes), as: UTF8.self)
    }

    public static func readText(_ path: String) -> String? {
        guard let d = FileManager.default.contents(atPath: path) else { return nil }
        return String(decoding: d, as: UTF8.self)
    }

    public static func writeText(_ path: String, _ text: String, dirMode: Int = 0o755) throws {
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: dirMode])
        try text.write(toFile: path, atomically: true, encoding: .utf8)
    }

    /// "~/x" -> "$HOME/x".
    public static func expandTilde(_ p: String, home: String = NSHomeDirectory()) -> String {
        if p == "~" { return home }
        if p.hasPrefix("~/") { return home + p.dropFirst(1) }
        return p
    }
}

// MARK: - Fechas ISO (formato de Date.toISOString de JS)

public enum ISODate {
    private static func formatter(_ fmt: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = fmt
        return f
    }

    /// "2026-11-18T13:00:00.000Z"
    public static func string(_ d: Date) -> String {
        formatter("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").string(from: d)
    }

    public static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        if let d = formatter("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").date(from: s) { return d }
        if let d = formatter("yyyy-MM-dd'T'HH:mm:ss'Z'").date(from: s) { return d }
        // Jira: "2026-11-19T10:00:00.000+0100"
        let z = DateFormatter()
        z.locale = Locale(identifier: "en_US_POSIX")
        for fmt in ["yyyy-MM-dd'T'HH:mm:ss.SSSZ", "yyyy-MM-dd'T'HH:mm:ssZ", "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX", "yyyy-MM-dd'T'HH:mm:ssXXXXX"] {
            z.dateFormat = fmt
            if let d = z.date(from: s) { return d }
        }
        return nil
    }
}
