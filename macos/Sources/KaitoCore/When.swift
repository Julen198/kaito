import Foundation

/// Parser de fechas/horas en español (port de when.js: parseWhen y shortLabel).
public struct WhenResult: Equatable {
    public let date: Date
    public let clean: String
    public let label: String
}

public enum When {
    static let days = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]
    static let dayRE = "(?:domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)"
    static let defaultHour = 9

    static let relRE = Regex("\\ben\\s+(\\d+(?:[.,]\\d+)?|una?|media)\\s*(h(?:oras?)?|min(?:utos?)?)(?![a-záéíóúñ])", caseInsensitive: true)
    static let dayMatchRE = Regex("\\b(pasado\\s+ma[ñn]ana|ma[ñn]ana|hoy|(?:el\\s+|este\\s+|pr[oó]ximo\\s+)?(\(dayRE)))\\b", caseInsensitive: true)
    static let timeRE = Regex("\\ba\\s+(?:las?)\\s+(una|\\d{1,2})(?:[:.h](\\d{2}))?(?:\\s+y\\s+(media|cuarto)|\\s+menos\\s+(cuarto))?(?:\\s+de\\s+la\\s+(ma[ñn]ana|tarde|noche))?(?![\\d:])", caseInsensitive: true)

    static func pad(_ n: Int) -> String { n < 10 ? "0\(n)" : "\(n)" }

    static func hhmm(_ d: Date, _ cal: Calendar) -> String {
        let c = cal.dateComponents([.hour, .minute], from: d)
        return "\(pad(c.hour ?? 0)):\(pad(c.minute ?? 0))"
    }

    static func cap(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

    /// 0 = domingo (como Date.getDay de JS).
    static func weekday(_ d: Date, _ cal: Calendar) -> Int { cal.component(.weekday, from: d) - 1 }

    static func dayDiff(_ date: Date, _ now: Date, _ cal: Calendar) -> Int {
        cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: date)).day ?? 0
    }

    /// "20 min", "2 h", "1 h 05 min"
    static func relative(_ seconds: Double) -> String {
        let mins = max(0, Int((seconds / 60).rounded()))
        if mins < 60 { return "\(mins) min" }
        let h = mins / 60, m = mins % 60
        return m > 0 ? "\(h) h \(pad(m)) min" : "\(h) h"
    }

    /// Etiqueta corta para listas: "hoy 17:30", "mañana 09:00", "lun 24 10:00".
    public static func shortLabel(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let diff = dayDiff(date, now, calendar)
        if diff == 0 { return "hoy \(hhmm(date, calendar))" }
        if diff == 1 { return "mañana \(hhmm(date, calendar))" }
        if diff < 0 { return "vencido \(hhmm(date, calendar))" }
        let day = calendar.component(.day, from: date)
        return "\(days[weekday(date, calendar)].prefix(3)) \(day) \(hhmm(date, calendar))"
    }

    static func longLabel(_ date: Date, _ now: Date, _ cal: Calendar) -> String {
        let diff = dayDiff(date, now, cal)
        let t = hhmm(date, cal)
        if diff == 0 { return "Hoy a las \(t) (en \(relative(date.timeIntervalSince(now))))" }
        if diff == 1 { return "Mañana a las \(t)" }
        if diff == 2 { return "Pasado mañana a las \(t)" }
        return "\(cap(days[weekday(date, cal)])) \(cal.component(.day, from: date)) a las \(t)"
    }

    static let stripEdgesRE = Regex("^[\\s,;:.\\-–]+|[\\s,;:.\\-–]+$")
    static let stripLeadRE = Regex("^(?:para|que)\\s+(?=\\S)", caseInsensitive: true)
    static let stripTailRE = Regex("\\s+(?:para|el|a|de|y)$", caseInsensitive: true)
    static let spacesRE = Regex("\\s+")

    /// Elimina los fragmentos [start, end) (UTF-16) y limpia conectores sueltos.
    static func strip(_ text: String, _ ranges: [(Int, Int)]) -> String {
        var out = text as NSString
        for (s, e) in ranges.sorted(by: { $0.0 > $1.0 }) {
            out = (out.substring(to: s) + " " + out.substring(from: e)) as NSString
        }
        var r = spacesRE.replace(out as String, with: " ")
        r = stripEdgesRE.replace(r, with: "")
        r = stripLeadRE.replaceFirst(r, with: "")
        r = stripTailRE.replaceFirst(r, with: "")
        return trimmed(r)
    }

    /// Día `days` desde hoy a la hora h:m (hora local).
    static func at(_ now: Date, days: Int, hour: Int, minute: Int, _ cal: Calendar) -> Date {
        let base = cal.date(byAdding: .day, value: days, to: cal.startOfDay(for: now)) ?? now
        if let d = cal.date(bySettingHour: hour, minute: minute, second: 0, of: base) { return d }
        return base.addingTimeInterval(Double(hour * 3600 + minute * 60))
    }

    /// Interpreta "llamar a Iker en 20 min", "mañana a las 9", "el lunes a las 10"... nil si no hay cuándo.
    public static func parse(_ text: String?, now: Date = Date(), calendar cal: Calendar = .current) -> WhenResult? {
        let src = text ?? ""
        var ranges: [(Int, Int)] = []

        // 1) Relativo: "en 20 min", "en 2 horas", "en media hora", "en una hora"
        if let rel = relRE.firstMatch(src) {
            let q = plainText(rel[1] ?? "")
            let n: Double
            if q == "media" { n = 0.5 } else if q == "un" || q == "una" { n = 1 } else {
                n = Double(q.replacingOccurrences(of: ",", with: ".")) ?? 0
            }
            let unit = (rel[2] ?? "").lowercased()
            let mult: Double = unit.hasPrefix("h") ? 60 : 1
            if n > 0 {
                ranges.append((rel.start, rel.end))
                let date = now.addingTimeInterval((n * mult * 60).rounded())
                return WhenResult(date: date, clean: strip(src, ranges), label: longLabel(date, now, cal))
            }
        }

        // 2) Día
        var dayOffset: Int? = nil
        var weekdayWanted: Int? = nil
        if let dm = dayMatchRE.firstMatch(src) {
            let w = plainText(dm[1] ?? "")
            if w.hasPrefix("pasado") {
                dayOffset = 2
            } else if w == "manana" {
                dayOffset = 1
            } else if w == "hoy" {
                dayOffset = 0
            } else {
                let name = plainText(dm[2] ?? "")
                weekdayWanted = days.firstIndex { plainText($0) == name }
            }
            ranges.append((dm.start, dm.end))
        }

        // 3) Hora: "a las 17:30", "a las 5 y media", "a la una", "a las 9 de la noche"
        var hour: Int? = nil
        var minute = 0
        if let tm = timeRE.firstMatch(src) {
            var h = plainText(tm[1] ?? "") == "una" ? 1 : Int(tm[1] ?? "") ?? 0
            minute = tm[2].flatMap { Int($0) } ?? 0
            if let q = tm[3] { minute = plainText(q) == "media" ? 30 : 15 }
            if tm[4] != nil {
                minute = 45
                h -= 1
            }
            let part = plainText(tm[5] ?? "")
            if (part == "tarde" || part == "noche") && h < 12 { h += 12 }
            if h > 23 || minute > 59 {
                hour = nil
            } else {
                hour = h
                ranges.append((tm.start, tm.end))
            }
        }

        if hour == nil && dayOffset == nil && weekdayWanted == nil { return nil }
        if hour == nil && dayOffset == 0 { return nil } // "hoy" sin hora

        let h = hour ?? defaultHour
        let m = hour == nil ? 0 : minute
        var date: Date
        if let off = dayOffset {
            date = at(now, days: off, hour: h, minute: m, cal)
        } else if let wd = weekdayWanted {
            date = at(now, days: 0, hour: h, minute: m, cal)
            for i in 0...7 {
                date = at(now, days: i, hour: h, minute: m, cal)
                if weekday(date, cal) == wd && date > now { break }
            }
        } else {
            date = at(now, days: 0, hour: h, minute: m, cal)
            if date <= now { date = at(now, days: 1, hour: h, minute: m, cal) }
        }
        return WhenResult(date: date, clean: strip(src, ranges), label: longLabel(date, now, cal))
    }
}
