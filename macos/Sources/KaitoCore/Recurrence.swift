import Foundation

/// Regla de una tarea programada (mismo JSON que when.js): kind daily|weekdays|weekly|hourly|interval|monthly|once.
public struct TaskRule: Equatable, Sendable {
    public var kind: String
    public var hour: Int?
    public var minute: Int?
    public var days: [Int]? // weekly: 0 = domingo … 6 = sábado
    public var minutes: Int? // interval
    public var day: Int? // monthly
    public var at: String? // once (ISO)

    public init(kind: String, hour: Int? = nil, minute: Int? = nil, days: [Int]? = nil, minutes: Int? = nil, day: Int? = nil, at: String? = nil) {
        self.kind = kind; self.hour = hour; self.minute = minute; self.days = days; self.minutes = minutes; self.day = day; self.at = at
    }

    public static func from(_ j: JSON?) -> TaskRule? {
        guard let j, let kind = j["kind"]?.string else { return nil }
        return TaskRule(kind: kind, hour: j["hour"]?.int, minute: j["minute"]?.int, days: j["days"]?.array?.compactMap(\.int),
                        minutes: j["minutes"]?.int, day: j["day"]?.int, at: j["at"]?.string)
    }

    public var json: JSON {
        var o: [String: JSON] = ["kind": .string(kind)]
        if let hour { o["hour"] = .number(Double(hour)) }
        if let minute { o["minute"] = .number(Double(minute)) }
        if let days { o["days"] = .array(days.map { .number(Double($0)) }) }
        if let minutes { o["minutes"] = .number(Double(minutes)) }
        if let day { o["day"] = .number(Double(day)) }
        if let at { o["at"] = .string(at) }
        return .object(o)
    }
}

public struct ScheduleResult: Equatable {
    public var rule: TaskRule
    public var clean: String
    public var label: String
    public var once: Bool
}

/// Recurrencias en español para tareas programadas (port de when.js: parseRecurrence, nextRun, parseSchedule…).
extension When {
    static let dayAbbr = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"]
    static let dayPluralRE = "(domingos?|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?)"
    public static let minIntervalMin = 15
    static let numWords = ["un": 1, "una": 1, "uno": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6, "ocho": 8, "doce": 12]

    static let intervalRE = Regex("\\bcada\\s+(?:(\\d+|una?|dos|tres|cuatro|cinco|seis|ocho|doce)\\s+)?(horas?|h|minutos?|min)\\b", caseInsensitive: true)
    static let weekdaysRE = Regex("\\b(?:de\\s+lunes\\s+a\\s+viernes|entre\\s+semana|(?:todos\\s+los\\s+|cada\\s+)?d[ií]as?\\s+laborables)\\b", caseInsensitive: true)
    static let monthlyRE = Regex("\\b(?:el\\s+)?(?:d[ií]a\\s+)?(\\d{1,2})\\s+de\\s+cada\\s+mes\\b|\\bcada\\s+d[ií]a\\s+(\\d{1,2})(?:\\s+del?\\s+mes)?\\b", caseInsensitive: true)
    static let dailyRE = Regex("\\b(?:todos\\s+los\\s+d[ií]as|cada\\s+d[ií]a|a\\s+diario|diariamente)\\b", caseInsensitive: true)
    static let weeklyRE = Regex("\\b(?:todos\\s+los|cada|los)\\s+\(dayPluralRE)((?:\\s*(?:,|y)\\s*(?:los\\s+)?\(dayPluralRE))*)", caseInsensitive: true)
    static let daySplitRE = Regex("\\s*(?:,|\\by\\b)\\s*")
    static let losRE = Regex("^los\\s+", caseInsensitive: true)
    static let digitsRE = Regex("^\\d+$")

    static func dayIndex(_ w: String) -> Int? {
        let p = plainText(w)
        let noS = p.hasSuffix("s") ? String(p.dropLast()) : p
        return days.firstIndex { plainText($0) == noS || plainText($0) == p }
    }

    static func toNum(_ s: String) -> Int? {
        digitsRE.test(s) ? Int(s) : numWords[plainText(s)]
    }

    /// "a las 9:30" → (hour, minute, rango) — misma gramática que parse.
    static func parseTime(_ src: String) -> (hour: Int, minute: Int, range: (Int, Int))? {
        guard let tm = timeRE.firstMatch(src) else { return nil }
        var h = plainText(tm[1] ?? "") == "una" ? 1 : Int(tm[1] ?? "") ?? 0
        var minute = tm[2].flatMap { Int($0) } ?? 0
        if let q = tm[3] { minute = plainText(q) == "media" ? 30 : 15 }
        if tm[4] != nil {
            minute = 45
            h -= 1
        }
        let part = plainText(tm[5] ?? "")
        if (part == "tarde" || part == "noche") && h < 12 { h += 12 }
        if h > 23 || h < 0 || minute > 59 { return nil }
        return (h, minute, (tm.start, tm.end))
    }

    /// Texto legible de una regla: "Cada lunes a las 09:00".
    public static func ruleLabel(_ rule: TaskRule?, calendar cal: Calendar = .current) -> String {
        guard let rule else { return "?" }
        let t = "\(pad(rule.hour ?? 0)):\(pad(rule.minute ?? 0))"
        switch rule.kind {
        case "daily": return "Todos los días a las \(t)"
        case "weekdays": return "De lunes a viernes a las \(t)"
        case "weekly":
            let names = (rule.days ?? []).compactMap { $0 >= 0 && $0 < 7 ? days[$0] : nil }
            guard let last = names.last else { return "?" }
            let list = names.count > 1 ? "\(names.dropLast().joined(separator: ", ")) y \(last)" : last
            return "Cada \(list) a las \(t)"
        case "hourly": return "Cada hora"
        case "interval":
            let m = rule.minutes ?? minIntervalMin
            return m % 60 == 0 ? "Cada \(m / 60 == 1 ? "hora" : "\(m / 60) horas")" : "Cada \(m) min"
        case "monthly": return "El día \(rule.day ?? 1) de cada mes a las \(t)"
        case "once":
            guard let d = ISODate.parse(rule.at) else { return "?" }
            return "Una vez: \(days[weekday(d, cal)]) \(cal.component(.day, from: d)) a las \(hhmm(d, cal))"
        default: return "?"
        }
    }

    /// "todos los días a las 9", "cada lunes a las 10", "de lunes a viernes a las 8", "cada hora", "cada 2 horas",
    /// "cada 30 minutos" (mínimo 15), "el día 1 de cada mes a las 9". Sin hora → 09:00.
    public static func parseRecurrence(_ text: String?) -> ScheduleResult? {
        let src = text ?? ""
        var ranges: [(Int, Int)] = []

        if let iv = intervalRE.firstMatch(src) {
            let n = iv[1].map { toNum($0) } ?? 1
            let hours = (iv[2] ?? "").lowercased().hasPrefix("h")
            if let n, n > 0 {
                ranges.append((iv.start, iv.end))
                let rule = hours && n == 1 ? TaskRule(kind: "hourly") : TaskRule(kind: "interval", minutes: max(minIntervalMin, hours ? n * 60 : n))
                return ScheduleResult(rule: rule, clean: strip(src, ranges), label: ruleLabel(rule), once: false)
            }
        }

        let time = parseTime(src)
        let h = time?.hour ?? defaultHour, m = time?.minute ?? 0
        var rule: TaskRule? = nil
        if let wd = weekdaysRE.firstMatch(src) {
            ranges.append((wd.start, wd.end))
            rule = TaskRule(kind: "weekdays", hour: h, minute: m)
        } else if let mo = monthlyRE.firstMatch(src) {
            if let day = Int(mo[1] ?? mo[2] ?? ""), day >= 1, day <= 31 {
                ranges.append((mo.start, mo.end))
                rule = TaskRule(kind: "monthly", hour: h, minute: m, day: day)
            }
        } else if let dl = dailyRE.firstMatch(src) {
            ranges.append((dl.start, dl.end))
            rule = TaskRule(kind: "daily", hour: h, minute: m)
        } else if let wk = weeklyRE.firstMatch(src) {
            let rest = (wk[2] ?? "")
            let parts = [wk[1] ?? ""] + daySplitRE.replace(rest, with: "\u{1}").components(separatedBy: "\u{1}")
            let words = parts.map { trimmed(losRE.replace($0, with: "")) }.filter { !$0.isEmpty }
            let idx = Array(Set(words.compactMap(dayIndex))).sorted()
            if !idx.isEmpty {
                ranges.append((wk.start, wk.end))
                rule = TaskRule(kind: "weekly", hour: h, minute: m, days: idx)
            }
        }
        guard let rule else { return nil }
        if let time { ranges.append(time.range) }
        return ScheduleResult(rule: rule, clean: strip(src, ranges), label: ruleLabel(rule), once: false)
    }

    /// Próxima ejecución estrictamente posterior a `after` (hora local). nil si no hay más.
    public static func nextRun(_ rule: TaskRule?, after a: Date, calendar cal: Calendar = .current) -> Date? {
        guard let rule else { return nil }
        let h = rule.hour ?? 0, m = rule.minute ?? 0
        func scanDays(_ ok: (Int) -> Bool) -> Date? {
            for i in 0...8 {
                let t = at(a, days: i, hour: h, minute: m, cal)
                if t > a && ok(weekday(t, cal)) { return t }
            }
            return nil
        }
        switch rule.kind {
        case "once":
            guard let t = ISODate.parse(rule.at) else { return nil }
            return t > a ? t : nil
        case "daily": return scanDays { _ in true }
        case "weekdays": return scanDays { $0 >= 1 && $0 <= 5 }
        case "weekly":
            guard let d = rule.days, !d.isEmpty else { return nil }
            return scanDays { d.contains($0) }
        case "hourly":
            let start = cal.date(bySettingHour: cal.component(.hour, from: a), minute: 0, second: 0, of: a) ?? a
            return cal.date(byAdding: .hour, value: 1, to: start)
        case "interval":
            return a.addingTimeInterval(Double(max(minIntervalMin, rule.minutes ?? 0)) * 60)
        case "monthly":
            guard let day = rule.day else { return nil }
            let first = cal.date(from: cal.dateComponents([.year, .month], from: a)) ?? a
            for i in 0...2 {
                guard let month = cal.date(byAdding: .month, value: i, to: first),
                      let range = cal.range(of: .day, in: .month, for: month) else { continue }
                var c = cal.dateComponents([.year, .month], from: month)
                c.day = min(day, range.count)
                c.hour = h
                c.minute = m
                c.second = 0
                if let t = cal.date(from: c), t > a { return t }
            }
            return nil
        default: return nil
        }
    }

    /// Recurrencia o, si no, una sola vez (parse). La regla 'once' guarda la fecha en ISO.
    public static func parseSchedule(_ text: String?, now: Date = Date(), calendar cal: Calendar = .current) -> ScheduleResult? {
        if let r = parseRecurrence(text) { return r }
        guard let w = parse(text, now: now, calendar: cal) else { return nil }
        return ScheduleResult(rule: TaskRule(kind: "once", at: ISODate.string(w.date)), clean: w.clean, label: w.label, once: true)
    }

    /// "lun 09:00" para la lista de tareas (hoy/mañana como shortLabel).
    public static func nextLabel(_ date: Date?, now: Date = Date(), calendar cal: Calendar = .current) -> String {
        guard let date else { return "" }
        let diff = dayDiff(date, now, cal)
        if diff == 0 { return "hoy \(hhmm(date, cal))" }
        if diff == 1 { return "mañana \(hhmm(date, cal))" }
        let abbr = dayAbbr[weekday(date, cal)]
        return diff > 0 && diff < 7 ? "\(abbr) \(hhmm(date, cal))" : "\(abbr) \(cal.component(.day, from: date)) \(hhmm(date, cal))"
    }
}
