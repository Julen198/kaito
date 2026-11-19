import XCTest
@testable import KaitoCore

final class StoreTests: XCTestCase {
    var home = ""
    var paths: KaitoPaths { KaitoPaths(home: home, env: [:]) }

    override func setUp() {
        home = NSTemporaryDirectory() + "kaito-store-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: home)
    }

    func testPathsXdg() {
        XCTAssertEqual(KaitoPaths(home: "/Users/a", env: [:]).stateDir, "/Users/a/.cache/kaito/state")
        XCTAssertEqual(KaitoPaths(home: "/Users/a", env: ["XDG_CONFIG_HOME": "/c", "XDG_CACHE_HOME": "rel"]).configPath, "/c/kaito/config.json")
        XCTAssertEqual(KaitoPaths(home: "/Users/a", env: ["XDG_CACHE_HOME": "rel"]).cacheDir, "/Users/a/.cache/kaito")
    }

    func testTodosNotesKeepUnknownFields() throws {
        try FileUtil.writeText(paths.todosPath, "[{\"text\":\"a\",\"done\":false,\"extra\":1},{\"text\":\"b\",\"done\":true}]")
        let s = DataStore(paths: paths)
        XCTAssertEqual(s.todos().map(\.text), ["a", "b"])
        try s.setTodo(s.todos()[0], done: true)
        try s.addTodo("c")
        let raw = JSONFile.read(paths.todosPath)
        XCTAssertEqual(raw?[0], ["text": "a", "done": true, "extra": 1])
        XCTAssertEqual(raw?[2], ["text": "c", "done": false])
        try s.addNote("nota", now: Date(timeIntervalSince1970: 1.5))
        XCTAssertEqual(JSONFile.read(paths.notesPath)?[0], ["text": "nota", "ts": 1500])
        XCTAssertTrue(FileUtil.readText(paths.notesPath)?.contains("\"ts\" : 1500") == true || FileUtil.readText(paths.notesPath)?.contains("\"ts\": 1500") == true)
    }

    func testReminders() throws {
        let s = DataStore(paths: paths)
        let now = Date(timeIntervalSince1970: 1_795_082_400)
        let id = try s.addReminder("llamar", due: now.addingTimeInterval(-60), now: now)
        try s.addReminder("luego", due: now.addingTimeInterval(3600), now: now)
        XCTAssertEqual(s.dueReminders(now: now).map(\.id), [id])
        XCTAssertEqual(JSONFile.read(paths.remindersPath)?[0]?["due"], "2026-11-19T09:59:00.000Z")
        try s.snoozeReminder(id, now: now)
        XCTAssertEqual(s.dueReminders(now: now), [])
        XCTAssertEqual(s.reminders().first?.snoozes, 1)
        try s.completeReminder(id)
        XCTAssertTrue(s.reminders().first?.done == true)
        XCTAssertEqual(ISODate.parse("2026-11-19T10:00:00.000+0100")?.timeIntervalSince1970, 1_795_078_800)
    }

    func testConfig() throws {
        let store = ConfigStore(paths: paths)
        var c = store.read()
        XCTAssertEqual(c.refreshSeconds, 30)
        XCTAssertEqual(c.terminal, "auto")
        XCTAssertEqual(c.jiraJql, KaitoConfig.defaultJql)
        try FileUtil.writeText(paths.configPath, "{\"refreshSeconds\": -1, \"terminal\": \"ptyxis\", \"jiraPreset\": \"progress\", \"jiraJql\": \"x\", \"desconocida\": [1], \"jiraEnabled\": false, \"agentProviders\": {\"codex\": false}}")
        c = store.read()
        XCTAssertEqual(c.refreshSeconds, 30)
        XCTAssertEqual(c.terminal, "auto")
        XCTAssertEqual(c.jiraJql, KaitoConfig.presets[1].jql)
        XCTAssertFalse(c.jiraEnabled)
        XCTAssertEqual(c.agentProviders["codex"], false)
        XCTAssertEqual(c.agentProviders["gemini"], true)
        try store.update(["terminal": "iterm", "jiraPreset": nil])
        let raw = JSONFile.read(paths.configPath)
        XCTAssertEqual(raw?["desconocida"], [1])
        XCTAssertNil(raw?["jiraPreset"])
        XCTAssertEqual(store.read().terminal, "iterm")
        XCTAssertEqual(store.read().jiraJql, "x")
        XCTAssertEqual(KaitoConfig.defaultRepoRoots(home: "/h", isDir: { $0 == "/h/dev" }), ["/h/dev"])
    }

    func testUpdates() {
        XCTAssertTrue(Updates.isNewer("v0.5.0", than: "0.4.1"))
        XCTAssertTrue(Updates.isNewer("0.10.0", than: "0.9.9"))
        XCTAssertFalse(Updates.isNewer("v0.4.1", than: "0.4.1"))
        XCTAssertFalse(Updates.isNewer("0.4", than: "0.4.1"))
        XCTAssertEqual(Updates.parseRelease(["tag_name": "v0.5.0", "assets": [["name": "Kaito-macOS.zip"]], "html_url": "u"]),
                       Updates.Release(tag: "v0.5.0", hasMacAsset: true, url: "u"))
        XCTAssertNil(Updates.parseRelease(["message": "Not Found"]))
        XCTAssertTrue(Updates.shouldCheck(lastChecked: nil, now: 10))
        XCTAssertFalse(Updates.shouldCheck(lastChecked: 0, now: 3600))
        XCTAssertTrue(Updates.shouldCheck(lastChecked: 0, now: 6 * 3600))
    }

    func testJsonRoundTrip() {
        let v: JSON = ["a": [1, 2.5, "x", true, nil], "b": ["c": "d/e"]]
        XCTAssertEqual(JSON.parse(v.serialized()), v)
        XCTAssertEqual(JSON.string("a/\"b\"").serialized(), "\"a/\\\"b\\\"\"")
        XCTAssertEqual(JSON.parse("1")?.number, 1)
    }
}
