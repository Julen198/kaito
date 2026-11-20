import Testing
import Foundation
@testable import KaitoCore

@Suite struct TourTests {
    @Test func stepsSkipHiddenSections() {
        let full = Tour.steps(jira: true, usage: true, tasks: true).map(\.id)
        #expect(full == ["usage", "agents", "board", "todos", "reminders", "tasks", "notes", "create", "settings"])
        let min = Tour.steps(jira: false, usage: false, tasks: false).map(\.id)
        #expect(min == ["agents", "todos", "reminders", "notes", "create", "settings"])
    }

    @Test func tourDoneDefaultsFalse() {
        #expect(Tour.shouldStart(KaitoConfig.from(nil)))
        #expect(!Tour.shouldStart(KaitoConfig.from(.object(["tourDone": .bool(true)]))))
        #expect(Tour.shouldStart(KaitoConfig.from(.object(["tourDone": .bool(false)]))))
    }

    @Test func anchors() {
        #expect(Tour.anchor("create") == "footer")
        #expect(Tour.anchor("notes") == "notes")
    }

    @Test func columnLine() {
        func w(_ p: Double, reset: Bool = false) -> UsageWindowView {
            UsageWindowView(pct: p, resetsAt: nil, reset: reset, label: "", level: "ok")
        }
        let now = 1_000_000_000.0
        let live = UsageView(five: w(29), week: w(65), age: "", ts: now - 60)
        #expect(Usage.columnLine(live, nowS: now).text == "29 % · 65 %")
        #expect(!Usage.columnLine(live, nowS: now).stale)
        let old = UsageView(five: w(0, reset: true), week: w(0, reset: true), age: "", ts: now - 7 * 86400)
        let r = Usage.columnLine(old, nowS: now)
        #expect(r.text == "hace 7 d" && r.stale)
        let onlyFive = UsageView(five: w(10), week: nil, age: "", ts: nil)
        #expect(Usage.columnLine(onlyFive, nowS: now).text == "10 % · –")
    }

    @Test func resetNote() {
        let now = 1_000_000_000.0
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let f = UsageWindowView(pct: 5, resetsAt: now + 600, reset: false, label: "", level: "ok")
        let v = UsageView(five: f, week: nil, age: "")
        let note = Usage.resetNote([(name: "Claude", view: v)], nowS: now, calendar: cal)
        #expect(note?.hasPrefix("Claude reinicia ") == true)
        let stale = UsageWindowView(pct: 0, resetsAt: now - 5, reset: true, label: "", level: "ok")
        #expect(Usage.resetNote([(name: "X", view: UsageView(five: stale, week: nil, age: ""))], nowS: now) == nil)
    }
}
