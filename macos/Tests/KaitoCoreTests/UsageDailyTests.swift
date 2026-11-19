import XCTest
@testable import KaitoCore

/// Casos de kaito.test.js: uso de Claude/Codex y resumen del día.
final class UsageDailyTests: XCTestCase {
    let cal = Calendar.current

    func at(_ d: Int, _ h: Int, _ m: Int) -> Double {
        cal.date(from: DateComponents(year: 2026, month: 11, day: d, hour: h, minute: m))!.timeIntervalSince1970
    }

    func testLevelsAndEpoch() {
        XCTAssertEqual([0, 69.9, 70, 89.9, 90, 100].map(Usage.level), ["ok", "ok", "warn", "warn", "crit", "crit"])
        XCTAssertEqual(Usage.colors["crit"], "#E5493A")
        XCTAssertEqual(Usage.toEpochS(1800000000), 1800000000)
        XCTAssertEqual(Usage.toEpochS(1800000000000), 1800000000)
        XCTAssertEqual(Usage.toEpochS("1800000000"), 1800000000)
        XCTAssertEqual(Usage.toEpochS("2026-11-13T11:05:39.352Z")!, 1794567939.352, accuracy: 0.001)
        XCTAssertNil(Usage.toEpochS(nil))
        XCTAssertNil(Usage.toEpochS("x"))
        XCTAssertNil(Usage.toEpochS(0))
    }

    func testClaude() {
        XCTAssertEqual(Usage.parseClaudeUsage(["ts": 1000, "rate_limits": ["five_hour": ["used_percentage": 42.5, "resets_at": 2000],
                                                                             "seven_day": ["used_percentage": 18, "resets_at": 3000]]]),
                       UsageData(ts: 1000, five: UsageWindow(pct: 42.5, resetsAt: 2000), week: UsageWindow(pct: 18, resetsAt: 3000)))
        XCTAssertEqual(Usage.parseClaudeUsage(["ts": 1, "rate_limits": ["seven_day": ["used_percentage": 5]]]),
                       UsageData(ts: 1, five: nil, week: UsageWindow(pct: 5, resetsAt: nil)))
        XCTAssertNil(Usage.parseClaudeUsage(nil))
        XCTAssertNil(Usage.parseClaudeUsage(["ts": 1, "rate_limits": nil]))
        XCTAssertNil(Usage.parseClaudeUsage(["rate_limits": [:]]))
        XCTAssertNil(Usage.parseClaudeUsage(["rate_limits": ["five_hour": ["used_percentage": "x"]]]))
        XCTAssertEqual(Usage.parseClaudeUsage(["ts": 1, "rate_limits": ["five_hour": ["used_percentage": 250, "resets_at": 5]]])?.five?.pct, 100)
    }

    func cxLine(_ rl: JSON, ts: String = "2026-11-13T11:05:39.352Z") -> String {
        JSON.object(["timestamp": .string(ts), "type": "event_msg", "payload": ["type": "token_count", "info": nil, "rate_limits": rl]]).serialized()
    }

    func testCodex() {
        let cxTs = Usage.toEpochS("2026-11-13T11:05:39.352Z")!
        XCTAssertEqual(Usage.parseCodexLine(cxLine(["primary": ["used_percent": 13, "window_minutes": 300, "resets_at": 1794583396],
                                                    "secondary": ["used_percent": 2, "window_minutes": 10080, "resets_at": 1795170196]])),
                       UsageData(ts: cxTs, five: UsageWindow(pct: 13, resetsAt: 1794583396), week: UsageWindow(pct: 2, resetsAt: 1795170196)))
        XCTAssertEqual(Usage.parseCodexLine(cxLine(["primary": ["used_percent": 40, "window_minutes": 10080, "resets_at": 7], "secondary": nil])),
                       UsageData(ts: cxTs, five: nil, week: UsageWindow(pct: 40, resetsAt: 7)))
        XCTAssertEqual(Usage.parseCodexLine(cxLine(["primary": ["used_percent": 40, "window_minutes": 10080, "resets_at": 7],
                                                    "secondary": ["used_percent": 9, "window_minutes": 300, "resets_at": 8]])),
                       UsageData(ts: cxTs, five: UsageWindow(pct: 9, resetsAt: 8), week: UsageWindow(pct: 40, resetsAt: 7)))
        XCTAssertEqual(Usage.parseCodexLine(cxLine(["primary": ["used_percent": 10, "window_minutes": 300, "resets_in_seconds": 600]]))!.five!.resetsAt!,
                       cxTs + 600, accuracy: 0.001)
        XCTAssertEqual(Usage.parseCodexLine(cxLine(["primary": ["used_percent": 10, "resets_at": 5], "secondary": ["used_percent": 20, "resets_at": 6]])),
                       UsageData(ts: cxTs, five: UsageWindow(pct: 10, resetsAt: 5), week: UsageWindow(pct: 20, resetsAt: 6)))
        XCTAssertNil(Usage.parseCodexLine(cxLine(nil)))
        XCTAssertNil(Usage.parseCodexLine(cxLine(["primary": nil, "secondary": nil])))
        XCTAssertNil(Usage.parseCodexLine("no json"))
        XCTAssertNil(Usage.parseCodexLine(JSON.object(["type": "event_msg", "payload": ["type": "agent_message", "rate_limits": ["primary": ["used_percent": 1]]]]).serialized()))
        let text = [cxLine(["primary": ["used_percent": 1, "window_minutes": 300, "resets_at": 1]]), "{\"type\":\"token_count\",\"basura\"",
                    cxLine(["primary": ["used_percent": 7, "window_minutes": 300, "resets_at": 2]]), cxLine(nil), "{\"x\":1}"].joined(separator: "\n")
        XCTAssertEqual(Usage.lastCodexUsage(text)?.five?.pct, 7)
        XCTAssertNil(Usage.lastCodexUsage("{\"x\":1}\n"))
    }

    func testLabels() {
        let now = at(19, 10, 0)
        XCTAssertTrue(Usage.applyStaleness(UsageWindow(pct: 80, resetsAt: now - 1), nowS: now)! == (0, now - 1, true))
        XCTAssertTrue(Usage.applyStaleness(UsageWindow(pct: 80, resetsAt: now + 1), nowS: now)! == (80, now + 1, false))
        XCTAssertFalse(Usage.applyStaleness(UsageWindow(pct: 80, resetsAt: nil), nowS: now)!.reset)
        XCTAssertNil(Usage.applyStaleness(nil, nowS: now))
        XCTAssertEqual(Usage.formatReset(at(19, 14, 30), nowS: now), "14:30")
        XCTAssertEqual(Usage.formatReset(at(19, 9, 5), nowS: now, forceDay: true), "hoy 09:05")
        XCTAssertEqual(Usage.formatReset(at(23, 9, 0), nowS: now), "lun 09:00")
        XCTAssertEqual(Usage.usageLabel("five", pct: 42.4, resetsAt: at(19, 14, 30), reset: false, nowS: now), "5 h 42% · se reinicia 14:30")
        XCTAssertEqual(Usage.usageLabel("week", pct: 18, resetsAt: at(23, 9, 0), reset: false, nowS: now), "Semana 18% · lun 09:00")
        XCTAssertEqual(Usage.usageLabel("five", pct: 0, resetsAt: now - 5, reset: true, nowS: now), "5 h 0% · reiniciado")
        XCTAssertEqual(Usage.usageLabel("week", pct: 3, resetsAt: nil, reset: false, nowS: now), "Semana 3%")
        XCTAssertEqual([now - 10, now - 12 * 60, now - 3 * 3600, now - 3 * 86400].map { Usage.ageLabel($0, nowS: now) } + [Usage.ageLabel(nil, nowS: now)],
                       ["actualizado ahora", "actualizado hace 12 min", "actualizado hace 3 h", "actualizado hace 3 d", ""])
        let uv = Usage.usageView(UsageData(ts: now - 720, five: UsageWindow(pct: 95, resetsAt: at(19, 14, 30)), week: UsageWindow(pct: 50, resetsAt: now - 60)), nowS: now)!
        XCTAssertEqual([uv.age, uv.five!.level, uv.five!.label, uv.week!.level, uv.week!.label],
                       ["actualizado hace 12 min", "crit", "5 h 95% · se reinicia 14:30", "ok", "Semana 0% · reiniciado"])
        XCTAssertEqual(uv.week?.pct, 0)
        XCTAssertNil(Usage.usageView(nil, nowS: now))
        XCTAssertNil(Usage.usageView(UsageData(ts: 1, five: nil, week: nil), nowS: now))
    }

    func testCodexReaderOnDisk() throws {
        let root = NSTemporaryDirectory() + "kaito-cx-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: root) }
        let dir = "\(root)/2026/11/13"
        try FileUtil.writeText("\(dir)/rollout-2026-11-13T10-00-00-a.jsonl", cxLine(["primary": ["used_percent": 21, "window_minutes": 300, "resets_at": 9]]) + "\n")
        let newer = "\(dir)/rollout-2026-11-13T11-00-00-b.jsonl"
        try FileUtil.writeText(newer, "{\"x\":1}\n")
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(60)], ofItemAtPath: newer)
        let r = Usage.CodexReader(root: root)
        XCTAssertEqual(r.read(nowMono: 1000)?.five?.pct, 21) // el más nuevo sin datos → el anterior
        XCTAssertEqual(r.read(nowMono: 1001)?.five?.pct, 21) // caché
    }

    func testStatusLineState() {
        XCTAssertEqual(Usage.statusLineState(nil), "none")
        XCTAssertEqual(Usage.statusLineState(["hooks": [:]]), "none")
        XCTAssertEqual(Usage.statusLineState(["statusLine": ["type": "command", "command": "'/Users/a b/.local/share/kaito-src/hooks/kaito-statusline.py'"]]), "kaito")
        XCTAssertEqual(Usage.statusLineState(["statusLine": ["type": "command", "command": "/h/hooks/kaito-statusline.py --x"]]), "kaito")
        XCTAssertEqual(Usage.statusLineState(["statusLine": ["type": "command", "command": "~/.claude/mi-linea.sh"]]), "other")
        XCTAssertEqual(Usage.statusLineState(["statusLine": "raro"]), "other")
    }

    func testDaily() {
        let d = { (dd: Int, h: Int, m: Int) in self.cal.date(from: DateComponents(year: 2026, month: 11, day: dd, hour: h, minute: m))! }
        let now = d(19, 8, 30)
        XCTAssertEqual(Daily.localDay(now), "2026-11-19")
        XCTAssertTrue(Daily.shouldShow(lastDay: nil, now: now))
        XCTAssertFalse(Daily.shouldShow(lastDay: "2026-11-19", now: now))
        XCTAssertFalse(Daily.shouldShow(lastDay: "2026-11-18", now: d(19, 5, 59)))
        XCTAssertTrue(Daily.shouldShow(lastDay: "2026-11-18", now: d(19, 6, 0)))
        func issue(_ k: String, _ c: String) -> JiraIssue {
            var i = JiraIssue(key: k)
            i.category = c
            return i
        }
        func rem(_ t: String, _ due: Date, done: Bool = false) -> Reminder { Reminder(id: t, text: t, due: due, done: done, snoozes: 0) }
        func agent(_ cwd: String, live: Bool, state: String? = nil, _ when: Date) -> Agent {
            var a = Agent(id: cwd)
            a.cwd = cwd
            a.live = live
            a.state = state
            a.activityMs = when.timeIntervalSince1970 * 1000
            return a
        }
        let lines = Daily.lines(
            issues: [issue("RUN-1", "indeterminate"), issue("RUN-2", "new"), issue("RUN-3", "indeterminate")],
            reminders: [rem("pasado", d(19, 7, 0)), rem("llamar a Iker", d(19, 10, 30)), rem("luego", d(19, 17, 0)),
                        rem("hecho", d(19, 9, 0), done: true), rem("mañana", d(20, 9, 0))],
            agents: [agent("kaito", live: false, d(18, 20, 0)), agent("web", live: false, state: "needs", d(18, 23, 0)),
                     agent("hoy", live: false, d(19, 7, 0)), agent("vivo", live: true, d(18, 7, 0))],
            now: now)
        XCTAssertEqual(lines, ["2 tickets en curso: RUN-1, RUN-3", "3 recordatorios hoy · el próximo a las 10:30: llamar a Iker",
                               "2 agentes esperando desde ayer: kaito, web"])
        XCTAssertEqual(Daily.lines(issues: [], reminders: [], agents: [], now: now), [])
        XCTAssertEqual(Daily.lines(issues: [issue("A-1", "indeterminate")], reminders: [], agents: [], now: now), ["1 ticket en curso: A-1"])
    }
}
