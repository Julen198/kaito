import Foundation

/// Ventana de uso: porcentaje 0-100 y fin (epoch s).
public struct UsageWindow: Equatable, Sendable {
    public var pct: Double
    public var resetsAt: Double?
    public init(pct: Double, resetsAt: Double?) { self.pct = pct; self.resetsAt = resetsAt }
}

/// Uso de un proveedor: momento del dato y ventanas de 5 h y semanal.
public struct UsageData: Equatable, Sendable {
    public var ts: Double?
    public var five: UsageWindow?
    public var week: UsageWindow?
    public init(ts: Double?, five: UsageWindow?, week: UsageWindow?) { self.ts = ts; self.five = five; self.week = week }
}

/// Ventana lista para pintar (anillo + etiqueta).
public struct UsageWindowView: Equatable, Sendable {
    public var pct: Double
    public var resetsAt: Double?
    public var reset: Bool
    public var label: String
    public var level: String // ok | warn | crit
}

public struct UsageView: Equatable, Sendable {
    public var five: UsageWindowView?
    public var week: UsageWindowView?
    public var age: String
    public var ts: Double? = nil
}

/// Port de las funciones de uso de common.js (statusLine de Claude y rollouts de Codex).
public enum Usage {
    public static let colors = ["ok": "#5BC8AF", "warn": "#FFA348", "crit": "#E5493A"]
    static let codexTailBytes = 256 * 1024
    static let codexMaxTry = 3
    static let codexRecheckS: Double = 60
    static let dow = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"]

    /// ok < 70 %, warn 70-90 %, crit >= 90 %.
    public static func level(_ pct: Double) -> String {
        pct >= 90 ? "crit" : pct >= 70 ? "warn" : "ok"
    }

    public static func clampPct(_ x: Double) -> Double { min(100, max(0, x)) }

    static let numRE = Regex("^\\s*\\d+(\\.\\d+)?\\s*$")

    /// Epoch en segundos desde segundos, milisegundos o ISO 8601; nil si no es válido.
    public static func toEpochS(_ v: JSON?) -> Double? {
        guard let v else { return nil }
        var n: Double
        switch v {
        case .number(let x): n = x
        case .string(let s):
            if numRE.test(s) {
                n = Double(trimmed(s)) ?? .nan
            } else {
                guard let d = ISODate.parse(trimmed(s)) else { return nil }
                n = d.timeIntervalSince1970
            }
        default: return nil
        }
        guard n.isFinite, n > 0 else { return nil }
        if n > 1e12 { n /= 1000 }
        return n
    }

    /// {pct, resetsAt}; nil si el porcentaje no es un número.
    public static func normWindow(_ pct: JSON?, _ resetsAt: JSON?) -> UsageWindow? {
        guard let p = pct, p != .null else { return nil }
        if case .string(let s) = p, trimmed(s).isEmpty { return nil }
        guard let n = p.number, n.isFinite else { return nil }
        return UsageWindow(pct: clampPct(n), resetsAt: toEpochS(resetsAt))
    }

    /// claude-usage.json → datos; nil si no hay ninguna ventana.
    public static func parseClaudeUsage(_ obj: JSON?) -> UsageData? {
        guard let rl = obj?["rate_limits"], rl.object != nil else { return nil }
        let five = normWindow(rl["five_hour"]?["used_percentage"], rl["five_hour"]?["resets_at"])
        let week = normWindow(rl["seven_day"]?["used_percentage"], rl["seven_day"]?["resets_at"])
        if five == nil && week == nil { return nil }
        return UsageData(ts: toEpochS(obj?["ts"]), five: five, week: week)
    }

    /// Reparte ventanas en 5 h / semana por window_minutes (300 / 10080); sin minutos, por posición.
    public static func pickWindows(_ list: [(UsageWindow, Double?)?]) -> (five: UsageWindow?, week: UsageWindow?) {
        var five: UsageWindow? = nil, week: UsageWindow? = nil
        for (i, w) in list.enumerated() {
            guard let (win, minutes) = w else { continue }
            let isFive: Bool
            if let m = minutes, m.isFinite, m > 0 { isFive = m <= 1440 } else { isFive = i == 0 }
            if isFive { if five == nil { five = win } } else if week == nil { week = win }
        }
        return (five, week)
    }

    /// Línea de rollout de Codex → datos; nil si no es un token_count con rate_limits.
    public static func parseCodexLine(_ line: String) -> UsageData? {
        guard let o = JSON.parse(line), o["type"]?.string == "event_msg", o["payload"]?["type"]?.string == "token_count",
              let rl = o["payload"]?["rate_limits"], rl.object != nil else { return nil }
        let ts = toEpochS(o["timestamp"])
        func win(_ w: JSON?) -> (UsageWindow, Double?)? {
            guard let w, w.object != nil else { return nil }
            var reset = toEpochS(w["resets_at"])
            if reset == nil, let ts, let rel = w["resets_in_seconds"]?.number, rel.isFinite { reset = ts + rel }
            guard let n = normWindow(w["used_percent"], reset.map { .number($0) }) else { return nil }
            return (n, w["window_minutes"]?.number)
        }
        let picked = pickWindows([win(rl["primary"]), win(rl["secondary"])])
        if picked.five == nil && picked.week == nil { return nil }
        return UsageData(ts: ts, five: picked.five, week: picked.week)
    }

    /// Última línea token_count con límites (de atrás hacia delante).
    public static func lastCodexUsage(_ text: String) -> UsageData? {
        for line in text.components(separatedBy: "\n").reversed() where line.contains("\"token_count\"") {
            if let u = parseCodexLine(line) { return u }
        }
        return nil
    }

    /// Ventana vencida (resetsAt < ahora) = 0 % "reiniciado".
    public static func applyStaleness(_ w: UsageWindow?, nowS: Double) -> (pct: Double, resetsAt: Double?, reset: Bool)? {
        guard let w else { return nil }
        let reset = w.resetsAt.map { $0 < nowS } ?? false
        return (reset ? 0 : w.pct, w.resetsAt, reset)
    }

    /// "14:30" (hoy) o "lun 09:00"; con forceDay también hoy: "hoy 09:00".
    public static func formatReset(_ resetsAt: Double, nowS: Double, forceDay: Bool = false, calendar cal: Calendar = .current) -> String {
        let d = Date(timeIntervalSince1970: resetsAt)
        let c = cal.dateComponents([.hour, .minute, .weekday], from: d)
        let hm = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        if cal.isDate(d, inSameDayAs: Date(timeIntervalSince1970: nowS)) { return forceDay ? "hoy \(hm)" : hm }
        return "\(dow[(c.weekday ?? 1) - 1]) \(hm)"
    }

    /// "5 h 42% · se reinicia 14:30", "Semana 18% · lun 09:00", "5 h 0% · reiniciado".
    public static func usageLabel(_ kind: String, pct: Double, resetsAt: Double?, reset: Bool, nowS: Double,
                                  calendar cal: Calendar = .current) -> String {
        let head = "\(kind == "five" ? "5 h" : "Semana") \(Int(pct.rounded()))%"
        if reset { return "\(head) · reiniciado" }
        guard let r = resetsAt else { return head }
        return "\(head) · \(kind == "five" ? "se reinicia " : "")\(formatReset(r, nowS: nowS, forceDay: kind == "week", calendar: cal))"
    }

    /// "actualizado hace 12 min" (o "actualizado ahora").
    public static func ageLabel(_ ts: Double?, nowS: Double) -> String {
        guard let ts else { return "" }
        let m = max(0, Int(((nowS - ts) / 60).rounded(.down)))
        if m < 1 { return "actualizado ahora" }
        if m < 60 { return "actualizado hace \(m) min" }
        if m < 48 * 60 { return "actualizado hace \(m / 60) h" }
        return "actualizado hace \(m / 1440) d"
    }

    public static func usageView(_ u: UsageData?, nowS: Double, calendar cal: Calendar = .current) -> UsageView? {
        guard let u else { return nil }
        func mk(_ kind: String, _ w: UsageWindow?) -> UsageWindowView? {
            guard let a = applyStaleness(w, nowS: nowS) else { return nil }
            return UsageWindowView(pct: a.pct, resetsAt: a.resetsAt, reset: a.reset,
                                   label: usageLabel(kind, pct: a.pct, resetsAt: a.resetsAt, reset: a.reset, nowS: nowS, calendar: cal),
                                   level: level(a.pct))
        }
        let five = mk("five", u.five), week = mk("week", u.week)
        if five == nil && week == nil { return nil }
        return UsageView(five: five, week: week, age: ageLabel(u.ts, nowS: nowS), ts: u.ts)
    }

    /// "hace 5 min" / "hace 3 h" / "hace 7 d".
    public static func agoShort(_ ts: Double, nowS: Double) -> String {
        let m = max(0, Int(((nowS - ts) / 60).rounded(.down)))
        if m < 60 { return "hace \(max(1, m)) min" }
        if m < 48 * 60 { return "hace \(m / 60) h" }
        return "hace \(m / 1440) d"
    }

    /// Línea bajo el anillo: "29 % · 65 %", o "hace 7 d" (stale) si el dato es de hace más de 1 h y ambas ventanas ya se reiniciaron.
    public static func columnLine(_ v: UsageView, nowS: Double) -> (text: String, stale: Bool) {
        let wins = [v.five, v.week].compactMap { $0 }
        if let ts = v.ts, !wins.isEmpty, wins.allSatisfy({ $0.reset }), nowS - ts >= 3600 {
            return (agoShort(ts, nowS: nowS), true)
        }
        func p(_ w: UsageWindowView?) -> String { w.map { "\(Int($0.pct.rounded())) %" } ?? "–" }
        return ("\(p(v.five)) · \(p(v.week))", false)
    }

    /// Nota de la cabecera: "Claude reinicia 16:30" (primer proveedor con 5 h vigente y fecha de reinicio futura).
    public static func resetNote(_ items: [(name: String, view: UsageView)], nowS: Double, calendar cal: Calendar = .current) -> String? {
        for it in items {
            if let f = it.view.five, !f.reset, let r = f.resetsAt, r > nowS {
                return "\(it.name) reinicia \(formatReset(r, nowS: nowS, calendar: cal))"
            }
        }
        return nil
    }

    public static func readClaudeUsage(paths: KaitoPaths = .default) -> UsageData? {
        parseClaudeUsage(JSONFile.read(paths.claudeUsagePath))
    }

    /// Uso de Codex del rollout más reciente con límites. Como mucho una búsqueda cada 60 s y sin releer
    /// si el fichero más nuevo no ha cambiado. Solo se guardan números, nunca la conversación.
    public final class CodexReader: @unchecked Sendable {
        private var checked = -Double.infinity
        private var key: String?
        private var usage: UsageData?
        private let lock = NSLock()
        public let root: String

        public init(root: String) { self.root = root }

        public func read(nowMono: Double = ProcessInfo.processInfo.systemUptime) -> UsageData? {
            lock.lock()
            defer { lock.unlock() }
            if nowMono - checked < codexRecheckS { return usage }
            checked = nowMono
            let files = Providers.recentRollouts(root: root)
            let k = files.first.map { "\($0.path)|\($0.mtime)|\($0.size)" }
            if k == key { return usage }
            key = k
            usage = nil
            for f in files.prefix(codexMaxTry) {
                guard var text = FileUtil.readTail(f.path, bytes: codexTailBytes) else { continue }
                if f.size > codexTailBytes, let nl = text.firstIndex(of: "\n") { text = String(text[text.index(after: nl)...]) }
                if let u = lastCodexUsage(text) {
                    usage = u
                    break
                }
            }
            return usage
        }
    }

    /// Primer token (la ruta) de un comando de shell, sin comillas simples/dobles.
    static func commandScript(_ command: String) -> String {
        let c = trimmed(command)
        if let q = c.first, q == "'" || q == "\"" {
            let rest = c.dropFirst()
            return String(rest.prefix { $0 != q })
        }
        return String(c.prefix { !$0.isWhitespace })
    }

    /// statusLine de ~/.claude/settings.json: "none" (no hay), "kaito" (la de Kaito) u "other" (otra: no se toca).
    public static func statusLineState(_ settings: JSON?) -> String {
        guard let sl = settings?["statusLine"], sl != .null else { return "none" }
        let script = commandScript(sl["command"]?.string ?? "")
        return (script as NSString).lastPathComponent == "kaito-statusline.py" ? "kaito" : "other"
    }
}
