import Foundation

/// Resumen del día (port de dailySummaryLines/shouldShowDaily de common.js). Mismo daily.json que Linux.
public enum Daily {
    /// Fecha local YYYY-MM-DD.
    public static func localDay(_ d: Date, calendar cal: Calendar = .current) -> String {
        let c = cal.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Una vez por día natural, a partir de las 06:00.
    public static func shouldShow(lastDay: String?, now: Date, calendar cal: Calendar = .current) -> Bool {
        cal.component(.hour, from: now) >= 6 && lastDay != localDay(now, calendar: cal)
    }

    static func listKeys(_ keys: [String], _ max: Int = 4) -> String {
        keys.prefix(max).joined(separator: ", ") + (keys.count > max ? "…" : "")
    }

    /// Hasta 3 líneas: tickets en curso, recordatorios de hoy y agentes parados desde ayer.
    public static func lines(issues: [JiraIssue], reminders: [Reminder], agents: [Agent], now: Date, calendar cal: Calendar = .current) -> [String] {
        var out: [String] = []
        let progress = issues.filter { $0.category == "indeterminate" }.map(\.key)
        if !progress.isEmpty {
            out.append("\(progress.count) \(progress.count == 1 ? "ticket en curso" : "tickets en curso"): \(listKeys(progress))")
        }
        let today = localDay(now, calendar: cal)
        let todays = reminders.filter { !$0.done && localDay($0.due, calendar: cal) == today }.sorted { $0.due < $1.due }
        if !todays.isEmpty {
            let next = todays.first { $0.due >= now } ?? todays[0]
            let c = cal.dateComponents([.hour, .minute], from: next.due)
            out.append("\(todays.count) \(todays.count == 1 ? "recordatorio" : "recordatorios") hoy · " +
                "el próximo a las \(String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)): \(next.text)")
        }
        let midnightMs = cal.startOfDay(for: now).timeIntervalSince1970 * 1000
        let waiting = agents.filter { ($0.state == "needs" || !$0.live) && $0.activityMs > 0 && $0.activityMs < midnightMs }
            .map { $0.cwd ?? "?" }
        if !waiting.isEmpty {
            out.append("\(waiting.count) \(waiting.count == 1 ? "agente esperando" : "agentes esperando") desde ayer: \(listKeys(waiting, 3))")
        }
        return out
    }

    public static func readLastDay(paths: KaitoPaths = .default) -> String? {
        JSONFile.read(paths.dailyPath)?["lastShown"]?.string
    }

    public static func writeLastDay(_ day: String, paths: KaitoPaths = .default) throws {
        try JSONFile.write(paths.dailyPath, ["lastShown": .string(day)], pretty: false)
    }
}
