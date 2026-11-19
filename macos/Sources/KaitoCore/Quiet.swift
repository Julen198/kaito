import Foundation

/// Horario de trabajo (config.json → workHours), como quiet.js. days: lunes = 1 … domingo = 7.
public struct WorkHours: Equatable, Sendable {
    public var enabled: Bool
    public var days: [Int]
    public var start: String
    public var end: String

    public init(enabled: Bool = false, days: [Int] = [1, 2, 3, 4, 5], start: String = "09:00", end: String = "18:00") {
        self.enabled = enabled; self.days = days; self.start = start; self.end = end
    }

    public static let `default` = WorkHours()

    /// workHours saneado (valores por defecto en lo que falte o sea inválido).
    public static func normalize(_ raw: JSON?) -> WorkHours {
        let r = raw?.object ?? [:]
        var days = Self.default.days
        if let arr = r["days"]?.array {
            var seen = Set<Int>()
            days = arr.compactMap { v -> Int? in
                guard let n = v.number, n.rounded() == n, n >= 1, n <= 7 else { return nil }
                return Int(n)
            }.filter { seen.insert($0).inserted }.sorted()
        }
        let s = Quiet.parseHHMM(r["start"]?.string).map(Quiet.fmtHHMM) ?? Self.default.start
        let e = Quiet.parseHHMM(r["end"]?.string).map(Quiet.fmtHHMM) ?? Self.default.end
        return WorkHours(enabled: r["enabled"]?.bool == true, days: days, start: s, end: e)
    }

    public var json: JSON {
        ["enabled": .bool(enabled), "days": .array(days.map { .number(Double($0)) }), "start": .string(start), "end": .string(end)]
    }
}

/// Estado de "No molestar": reason 'manual' | 'schedule' | nil.
public struct QuietState: Equatable, Sendable {
    public var quiet: Bool
    public var reason: String?
    public var until: Date?
    public init(quiet: Bool, reason: String?, until: Date?) { self.quiet = quiet; self.reason = reason; self.until = until }
}

/// Aviso retenido mientras hay silencio ("Mientras no estabas"): mismo formato que quiet-queue.json de Linux.
public struct QueuedNotice: Equatable, Sendable {
    public var key: String
    public var text: String
    public var action: JSON?
    public var at: Double // ms

    public init(key: String, text: String, action: JSON? = nil, at: Double) {
        self.key = key; self.text = text; self.action = action; self.at = at
    }

    public var json: JSON {
        var o: [String: JSON] = ["key": .string(key), "text": .string(text), "at": .number(at)]
        if let action { o["action"] = action }
        return .object(o)
    }
}

/// Port de quiet.js. Horas locales (Calendar), así los cambios de horario no descuadran.
public enum Quiet {
    public static let queueMax = 30
    static let dow = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"]
    static let hhmmRE = Regex("^([01]?\\d|2[0-3]):([0-5]\\d)$")

    /// "09:30" → 570; nil si no es una hora válida.
    public static func parseHHMM(_ s: String?) -> Int? {
        guard let m = hhmmRE.firstMatch(trimmed(s ?? "")), let h = Int(m[1] ?? ""), let mi = Int(m[2] ?? "") else { return nil }
        return h * 60 + mi
    }

    public static func fmtHHMM(_ min: Int) -> String {
        String(format: "%02d:%02d", min / 60, min % 60)
    }

    /// Lunes = 1 … domingo = 7.
    public static func isoDay(_ d: Date, _ cal: Calendar = .current) -> Int {
        let w = cal.component(.weekday, from: d) // 1 = domingo
        return w == 1 ? 7 : w - 1
    }

    static func atLocal(_ d: Date, _ offsetDays: Int, _ min: Int, _ cal: Calendar) -> Date {
        When.at(d, days: offsetDays, hour: min / 60, minute: min % 60, cal)
    }

    public static func inWorkHours(_ now: Date, _ wh: WorkHours, calendar cal: Calendar = .current) -> Bool {
        guard let s = parseHHMM(wh.start), let e = parseHHMM(wh.end) else { return false }
        let days = Set(wh.days)
        let c = cal.dateComponents([.hour, .minute], from: now)
        let m = (c.hour ?? 0) * 60 + (c.minute ?? 0)
        let today = isoDay(now, cal)
        let yesterday = today == 1 ? 7 : today - 1
        if s == e { return days.contains(today) }
        if s < e { return days.contains(today) && m >= s && m < e }
        return (days.contains(today) && m >= s) || (days.contains(yesterday) && m < e)
    }

    /// Próximo inicio de jornada estrictamente posterior a `now`.
    public static func nextWorkStart(_ now: Date, _ wh: WorkHours, calendar cal: Calendar = .current) -> Date? {
        guard let s = parseHHMM(wh.start), !wh.days.isEmpty else { return nil }
        let days = Set(wh.days)
        for i in 0...8 {
            let c = atLocal(now, i, s, cal)
            if c > now && days.contains(isoDay(c, cal)) { return c }
        }
        return nil
    }

    /// ¿Silencio ahora? Epochs en ms (como config.json de Linux).
    public static func isQuiet(_ now: Date, workHours: WorkHours, dndManual: Bool, dndUntil: Double?, dndSkipUntil: Double?,
                               calendar cal: Calendar = .current) -> QuietState {
        let t = now.timeIntervalSince1970 * 1000
        if dndManual {
            if let u = dndUntil, u > 0 {
                if u > t { return QuietState(quiet: true, reason: "manual", until: Date(timeIntervalSince1970: u / 1000)) }
            } else {
                return QuietState(quiet: true, reason: "manual", until: nil)
            }
        }
        let skipping = (dndSkipUntil ?? 0) > t
        if workHours.enabled && !skipping && !inWorkHours(now, workHours, calendar: cal) {
            return QuietState(quiet: true, reason: "schedule", until: nextWorkStart(now, workHours, calendar: cal))
        }
        return QuietState(quiet: false, reason: nil, until: nil)
    }

    public static func isQuiet(_ now: Date, config c: KaitoConfig, calendar cal: Calendar = .current) -> QuietState {
        isQuiet(now, workHours: c.workHours, dndManual: c.dndManual, dndUntil: c.dndUntil, dndSkipUntil: c.dndSkipUntil, calendar: cal)
    }

    /// "las 18:30" (hoy), "mañana 09:00", "lun 09:00".
    public static func whenLabel(_ d: Date, now: Date, calendar cal: Calendar = .current) -> String {
        let c = cal.dateComponents([.hour, .minute], from: d)
        let hm = fmtHHMM((c.hour ?? 0) * 60 + (c.minute ?? 0))
        let diff = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: d)).day ?? 0
        if diff == 0 { return "las \(hm)" }
        if diff == 1 { return "mañana \(hm)" }
        return "\(dow[cal.component(.weekday, from: d) - 1]) \(hm)"
    }

    /// "Fuera de horario hasta lun 09:00", "No molestar hasta las 15:20", "No molestar".
    public static func quietLabel(_ q: QuietState?, now: Date, calendar cal: Calendar = .current) -> String {
        guard let q, q.quiet else { return "" }
        let head = q.reason == "schedule" ? "Fuera de horario" : "No molestar"
        return q.until.map { "\(head) hasta \(whenLabel($0, now: now, calendar: cal))" } ?? head
    }

    /// "Hasta mañana": próximo inicio de jornada (con o sin horario activado); mañana 09:00 por defecto.
    public static func untilTomorrow(_ now: Date, _ wh: WorkHours, calendar cal: Calendar = .current) -> Date {
        let next = wh.days.isEmpty ? nil : nextWorkStart(now, wh, calendar: cal)
        if let next, !cal.isDate(next, inSameDayAs: now) { return next }
        let s = parseHHMM(wh.start) ?? 9 * 60
        for i in 1...8 {
            let c = atLocal(now, i, s, cal)
            if wh.days.isEmpty || wh.days.contains(isoDay(c, cal)) { return c }
        }
        return atLocal(now, 1, s, cal)
    }

    /// Mismo key ⇒ se sustituye (y pasa al final); más de `max` ⇒ caen los más viejos.
    public static func queuePush(_ queue: [QueuedNotice], _ item: QueuedNotice, max: Int = queueMax) -> [QueuedNotice] {
        guard !item.key.isEmpty else { return queue }
        var rest = queue.filter { $0.key != item.key }
        rest.append(item)
        return Array(rest.suffix(max))
    }

    /// Cola leída de disco → solo entradas válidas, sin duplicados y como mucho `max`.
    public static func normalizeQueue(_ raw: JSON?, max: Int = queueMax, nowMs: Double = Date().timeIntervalSince1970 * 1000) -> [QueuedNotice] {
        var q: [QueuedNotice] = []
        for it in raw?.array ?? [] {
            guard let key = it["key"]?.string, !key.isEmpty, let text = it["text"]?.string else { continue }
            let at = it["at"]?.number ?? 0
            q = queuePush(q, QueuedNotice(key: key, text: text, action: it["action"], at: at != 0 ? at : nowMs), max: max)
        }
        return q
    }

    public static func readQueue(paths: KaitoPaths = .default) -> [QueuedNotice] {
        normalizeQueue(JSONFile.read(paths.quietQueuePath))
    }

    public static func writeQueue(_ q: [QueuedNotice], paths: KaitoPaths = .default) throws {
        try JSONFile.write(paths.quietQueuePath, .array(q.map(\.json)), pretty: false)
    }
}
