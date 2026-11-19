import XCTest
@testable import KaitoCore

/// Mismos casos que quiet.test.js (con Europe/Madrid para el DST).
final class QuietTests: XCTestCase {
    var cal: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Europe/Madrid")!
        return c
    }()

    func D(_ y: Int, _ mo: Int, _ d: Int, _ h: Int = 0, _ mi: Int = 0) -> Date {
        cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!
    }

    let WH = WorkHours(enabled: true, days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00")

    func q(_ now: Date, _ wh: WorkHours = WorkHours(), manual: Bool = false, until: Double? = nil, skip: Double? = nil) -> QuietState {
        Quiet.isQuiet(now, workHours: wh, dndManual: manual, dndUntil: until, dndSkipUntil: skip, calendar: cal)
    }

    func ms(_ d: Date) -> Double { d.timeIntervalSince1970 * 1000 }

    func testHours() {
        XCTAssertEqual(["09:00", "9:05", "23:59", "24:00", "9h", ""].map { Quiet.parseHHMM($0) }, [540, 545, 1439, nil, nil, nil])
        XCTAssertEqual(WorkHours.normalize(nil), WorkHours(enabled: false, days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00"))
        XCTAssertEqual(WorkHours.normalize(["enabled": true, "days": [7, 1, 1, 9, "x", 3], "start": "8:30", "end": "mal"]),
                       WorkHours(enabled: true, days: [1, 3, 7], start: "08:30", end: "18:00"))
    }

    func testSchedule() {
        XCTAssertTrue(Quiet.inWorkHours(D(2026, 11, 16, 9, 0), WH, calendar: cal))
        XCTAssertTrue(Quiet.inWorkHours(D(2026, 11, 16, 17, 59), WH, calendar: cal))
        XCTAssertFalse(Quiet.inWorkHours(D(2026, 11, 16, 18, 0), WH, calendar: cal))
        XCTAssertFalse(Quiet.inWorkHours(D(2026, 11, 16, 8, 59), WH, calendar: cal))
        XCTAssertFalse(Quiet.inWorkHours(D(2026, 11, 21, 12, 0), WH, calendar: cal))

        XCTAssertEqual(q(D(2026, 11, 16, 12, 0), WH), QuietState(quiet: false, reason: nil, until: nil))
        let fri = q(D(2026, 11, 20, 19, 0), WH)
        XCTAssertEqual(fri, QuietState(quiet: true, reason: "schedule", until: D(2026, 11, 23, 9, 0)))
        XCTAssertEqual(Quiet.quietLabel(fri, now: D(2026, 11, 20, 19, 0), calendar: cal), "Fuera de horario hasta lun 09:00")
        let early = q(D(2026, 11, 17, 7, 0), WH)
        XCTAssertEqual(early.until, D(2026, 11, 17, 9, 0))
        XCTAssertEqual(Quiet.quietLabel(early, now: D(2026, 11, 17, 7, 0), calendar: cal), "Fuera de horario hasta las 09:00")
        XCTAssertEqual(Quiet.quietLabel(q(D(2026, 11, 17, 20, 0), WH), now: D(2026, 11, 17, 20, 0), calendar: cal),
                       "Fuera de horario hasta mañana 09:00")
        var off = WH
        off.enabled = false
        XCTAssertFalse(q(D(2026, 11, 21, 12, 0), off).quiet)
        var none = WH
        none.days = []
        XCTAssertEqual(q(D(2026, 11, 21, 12, 0), none), QuietState(quiet: true, reason: "schedule", until: nil))
    }

    func testNight() {
        let N = WorkHours(enabled: true, days: [1, 2, 3, 4, 5], start: "22:00", end: "06:00")
        XCTAssertTrue(Quiet.inWorkHours(D(2026, 11, 16, 23, 0), N, calendar: cal))
        XCTAssertTrue(Quiet.inWorkHours(D(2026, 11, 17, 5, 59), N, calendar: cal))
        XCTAssertFalse(Quiet.inWorkHours(D(2026, 11, 17, 6, 0), N, calendar: cal))
        XCTAssertFalse(Quiet.inWorkHours(D(2026, 11, 16, 3, 0), N, calendar: cal))
        XCTAssertTrue(Quiet.inWorkHours(D(2026, 11, 21, 3, 0), N, calendar: cal))
        XCTAssertFalse(Quiet.inWorkHours(D(2026, 11, 21, 23, 0), N, calendar: cal))
        XCTAssertEqual(q(D(2026, 11, 17, 12, 0), N).until, D(2026, 11, 17, 22, 0))
        var whole = WH
        whole.start = "00:00"
        whole.end = "00:00"
        XCTAssertTrue(Quiet.inWorkHours(D(2026, 11, 16, 3, 0), whole, calendar: cal))
    }

    func testDST() {
        let sat = D(2026, 3, 28, 20, 0)
        XCTAssertEqual(Quiet.nextWorkStart(sat, WH, calendar: cal), D(2026, 3, 30, 9, 0))
        XCTAssertEqual(cal.component(.hour, from: Quiet.nextWorkStart(sat, WH, calendar: cal)!), 9)
        XCTAssertEqual(cal.component(.hour, from: Quiet.nextWorkStart(D(2026, 10, 24, 20, 0), WH, calendar: cal)!), 9)
        XCTAssertFalse(q(D(2026, 3, 30, 9, 30), WH).quiet)
    }

    func testManual() {
        let now = D(2026, 11, 16, 12, 0)
        let m = q(now, WH, manual: true)
        XCTAssertEqual(m, QuietState(quiet: true, reason: "manual", until: nil))
        XCTAssertEqual(Quiet.quietLabel(m, now: now, calendar: cal), "No molestar")
        let h = q(now, manual: true, until: ms(now) + 3600e3)
        XCTAssertEqual(h.until, now.addingTimeInterval(3600))
        XCTAssertEqual(Quiet.quietLabel(h, now: now, calendar: cal), "No molestar hasta las 13:00")
        XCTAssertFalse(q(now, manual: true, until: ms(now) - 1).quiet)
        XCTAssertEqual(q(D(2026, 11, 16, 20, 0), WH, manual: true, until: ms(now) - 1).reason, "schedule")
        let eve = D(2026, 11, 16, 20, 0)
        XCTAssertFalse(q(eve, WH, skip: ms(D(2026, 11, 17, 9, 0))).quiet)
        XCTAssertTrue(q(eve, WH, skip: ms(eve) - 1).quiet)
    }

    func testUntilTomorrow() {
        XCTAssertEqual(Quiet.untilTomorrow(D(2026, 11, 16, 15, 0), WH, calendar: cal), D(2026, 11, 17, 9, 0))
        XCTAssertEqual(Quiet.untilTomorrow(D(2026, 11, 20, 15, 0), WH, calendar: cal), D(2026, 11, 23, 9, 0))
        XCTAssertEqual(Quiet.untilTomorrow(D(2026, 11, 17, 7, 0), WH, calendar: cal), D(2026, 11, 18, 9, 0))
        XCTAssertEqual(Quiet.untilTomorrow(D(2026, 11, 21, 15, 0), WorkHours.normalize(["days": []]), calendar: cal), D(2026, 11, 22, 9, 0))
        XCTAssertEqual(Quiet.whenLabel(D(2026, 11, 25, 9, 0), now: D(2026, 11, 16, 12, 0), calendar: cal), "mié 09:00")
    }

    func testQueue() {
        var queue: [QueuedNotice] = []
        queue = Quiet.queuePush(queue, QueuedNotice(key: "a", text: "A", at: 1))
        queue = Quiet.queuePush(queue, QueuedNotice(key: "b", text: "B", at: 2))
        queue = Quiet.queuePush(queue, QueuedNotice(key: "a", text: "A2", at: 3))
        XCTAssertEqual(queue.map { "\($0.key):\($0.text)" }, ["b:B", "a:A2"])
        XCTAssertEqual(Quiet.queuePush(queue, QueuedNotice(key: "", text: "sin key", at: 1)), queue)
        for i in 0..<40 { queue = Quiet.queuePush(queue, QueuedNotice(key: "k\(i)", text: "t\(i)", at: Double(10 + i))) }
        XCTAssertEqual([queue.count], [Quiet.queueMax])
        XCTAssertEqual(queue.first?.key, "k10")
        XCTAssertEqual(queue.last?.key, "k39")
        XCTAssertEqual(Quiet.normalizeQueue([["key": "x", "text": "X", "at": 5], nil, "basura", ["key": "x", "text": "X2", "at": 6], ["key": "y"]]),
                       [QueuedNotice(key: "x", text: "X2", at: 6)])
        XCTAssertEqual(Quiet.normalizeQueue(["no": "lista"]), [])
    }

    func testConfigKeys() {
        let c = KaitoConfig.from(["dndManual": true, "dndUntil": 123, "dndSkipUntil": -1, "reviewReminderMinutes": 0,
                                  "workHours": ["enabled": true], "notifyDone": false, "showUsage": false], home: "/h", isDir: { _ in false })
        XCTAssertEqual([c.dndManual, c.notifyDone, c.showUsage, c.autoReview, c.dailySummary], [true, false, false, true, true])
        XCTAssertEqual(c.dndUntil, 123)
        XCTAssertNil(c.dndSkipUntil)
        XCTAssertEqual(c.reviewReminderMinutes, 0)
        XCTAssertEqual(KaitoConfig.from(nil, home: "/h", isDir: { _ in false }).reviewReminderMinutes, 30)
        XCTAssertTrue(c.workHours.enabled)
    }
}
