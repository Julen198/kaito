import XCTest
@testable import KaitoCore

/// Port de providers.test.js (procesos y rollouts sintéticos de Codex) + parseo de ps/lsof.
final class ProvidersTests: XCTestCase {
    func testMatchAgentProcess() {
        let m = Providers.matchAgentProcess
        XCTAssertEqual(m(["/h/.nvm/versions/node/v24/lib/node_modules/@openai/codex/vendor/x86_64/codex/codex"], "codex"), "codex")
        XCTAssertEqual(m(["node", "/h/.nvm/versions/node/v24/bin/codex"], "node"), "codex")
        XCTAssertEqual(m(["node", "--no-warnings", "/x/bin/codex.js", "resume"], "node"), "codex")
        XCTAssertNil(m(["codex", "app-server"], "codex"))
        XCTAssertNil(m(["codex", "exec", "haz algo"], "codex"))
        XCTAssertNil(m(["codex", "--version"], "codex"))
        XCTAssertEqual(m(["codex", "arregla el test"], "codex"), "codex")
        XCTAssertEqual(m(["/usr/bin/python3", "/h/.local/bin/aider", "--model", "x"], "python3"), "aider")
        XCTAssertEqual(m(["gemini"], "node"), "gemini")
        XCTAssertEqual(m(["/h/.opencode/bin/opencode"], "opencode"), "opencode")
        XCTAssertNil(m(["opencode", "serve"], "opencode"))
        XCTAssertEqual(m(["cursor-agent"], "cursor-agent"), "cursor")
        XCTAssertNil(m(["claude"], "claude"))
        XCTAssertNil(m(["vim", "codex.md"], "vim"))
        XCTAssertNil(m(["node", "/x/server.js"], "node"))
        XCTAssertNil(m([], ""))
        let d = Providers.dedupe([
            Providers.Proc(pid: 10, ppid: 1, provider: "codex"), Providers.Proc(pid: 11, ppid: 10, provider: "codex"),
            Providers.Proc(pid: 20, ppid: 1, provider: "codex"), Providers.Proc(pid: 30, ppid: 11, provider: "gemini"),
        ])
        XCTAssertEqual(d.map(\.pid), [11, 20, 30])
    }

    let T0 = 1_795_082_400_000.0 // 2026-11-19T10:00:00Z (ms)
    func iso(_ ms: Double) -> String { ISODate.string(Date(timeIntervalSince1970: ms / 1000)) }
    func L(_ t: Double, _ type: String, _ payload: JSON) -> String { J(["timestamp": .string(iso(t)), "type": .string(type), "payload": payload]) }
    var meta: String {
        L(T0, "session_meta", ["id": "01a1d46e-45e0-7080-ace5-3160f4268d49", "cwd": "/h/repo", "timestamp": .string(iso(T0)),
                               "base_instructions": .string(String(repeating: "x", count: 50))])
    }
    func cmd(_ t: Double, _ c: String) -> String {
        L(t, "event_msg", ["type": "item_completed", "item": ["type": "CommandExecution", "command": ["/bin/bash", "-lc", .string(c)], "aggregated_output": "SECRETO"]])
    }
    func msg(_ t: Double, _ text: String) -> String {
        L(t, "event_msg", ["type": "item_completed", "item": ["type": "AgentMessage", "phase": "commentary", "content": [["type": "Text", "text": .string(text)]]]])
    }
    func started(_ t: Double) -> String { L(t, "event_msg", ["type": "task_started", "turn_id": "t1", "started_at": .number(t / 1000)]) }
    func complete(_ t: Double, _ last: String) -> String { L(t, "event_msg", ["type": "task_complete", "turn_id": "t1", "last_agent_message": .string(last)]) }
    func tokens(_ t: Double) -> String { L(t, "event_msg", ["type": "token_count", "info": nil, "rate_limits": nil]) }

    func testRolloutMeta() {
        XCTAssertEqual(Providers.parseRolloutMeta(meta + "\n"), Providers.RolloutMeta(id: "01a1d46e-45e0-7080-ace5-3160f4268d49", cwd: "/h/repo", startedMs: T0))
        // Orden de claves de Codex: id, cwd, timestamp, base_instructions (la línea se corta en base_instructions).
        let cut = "{\"timestamp\":\"\(iso(T0))\",\"type\":\"session_meta\",\"payload\":{\"id\":\"01a1d46e-45e0-7080-ace5-3160f4268d49\",\"cwd\":\"/h/repo\",\"base_instructions\":\"xxxx"
        XCTAssertEqual(Providers.parseRolloutMeta(cut)?.cwd, "/h/repo")
        XCTAssertNil(Providers.parseRolloutMeta("{\"type\":\"event_msg\"}\n"))
        XCTAssertEqual(Providers.rolloutId("/h/.codex/sessions/2026/11/13/rollout-2026-11-13T11-22-39-01a1d46e-45e0-7080-ace5-3160f4268d49.jsonl"),
                       "01a1d46e-45e0-7080-ace5-3160f4268d49")
        XCTAssertNil(Providers.rolloutId("/x/otro.jsonl"))
    }

    func testCodexTail() {
        let working = ["{\"cortada", meta, started(T0 + 1000), msg(T0 + 2000, "Voy a mirar los tests"),
                       cmd(T0 + 3000, "npm test -- --watch=false\necho segunda línea")].joined(separator: "\n")
        var tail = Providers.parseCodexTail(working)
        XCTAssertTrue(tail.turnOpen)
        XCTAssertEqual(tail.lastAction, "$ npm test -- --watch=false")
        XCTAssertNil(tail.lastText)
        XCTAssertEqual(tail.lastStartMs, T0 + 1000)
        XCTAssertEqual(tail.lastEventMs, T0 + 3000)
        XCTAssertTrue(Providers.codexStatus(tail: tail, mtimeMs: T0 + 3000, nowMs: T0 + 200_000) == (true, "working"))
        XCTAssertTrue(Providers.codexStatus(tail: tail, mtimeMs: T0 + 3000, nowMs: T0 + 3_600_000) == (false, "idle"))

        let longAnswer = "## Hecho\n" + String(repeating: "Arreglé el fallo del login y añadí pruebas. ", count: 10) + "\nSegunda línea con detalles"
        let done = [meta, started(T0 + 1000), cmd(T0 + 2000, "git diff"), msg(T0 + 3000, "Listo"), complete(T0 + 4000, longAnswer), tokens(T0 + 4100)].joined(separator: "\n")
        tail = Providers.parseCodexTail(done)
        XCTAssertFalse(tail.turnOpen)
        XCTAssertEqual(tail.lastAction, "Listo")
        XCTAssertEqual(tail.lastCompleteMs, T0 + 4000)
        XCTAssertLessThanOrEqual(tail.lastText?.count ?? 999, 160)
        XCTAssertTrue(tail.lastText?.hasPrefix("Hecho") == true)
        XCTAssertFalse(tail.lastText?.contains("Segunda") == true)
        XCTAssertTrue(Providers.codexStatus(tail: tail, mtimeMs: T0 + 4100, nowMs: T0 + 5000) == (false, "done"))

        let edits = [meta, started(T0), L(T0 + 1, "event_msg", ["type": "item_completed", "item": ["type": "FileChange", "changes": ["/h/repo/a.js": [:], "/h/repo/b.js": [:]]]])].joined(separator: "\n")
        XCTAssertEqual(Providers.parseCodexTail(edits).lastAction, "Edit 2 ficheros")
        let old = [L(T0, "response_item", ["type": "function_call", "name": "shell", "arguments": "{}"]),
                   L(T0 + 1, "event_msg", ["type": "agent_message", "message": "Revisando\nmás"])].joined(separator: "\n")
        tail = Providers.parseCodexTail(old)
        XCTAssertEqual(tail.lastAction, "Revisando")
        XCTAssertFalse(tail.turnOpen)
        XCTAssertEqual(Providers.codexStatus(tail: tail, mtimeMs: T0, nowMs: T0 + 30_000, liveS: 60).state, "working")
        XCTAssertEqual(Providers.codexStatus(tail: tail, mtimeMs: T0, nowMs: T0 + 90_000, liveS: 60).state, "idle")
        XCTAssertEqual(Providers.parseCodexTail(""), Providers.CodexTail())

        tail = Providers.parseCodexTail(working)
        let hookAfter = HookState(state: "done", message: "", cwd: "", ts: (T0 + 5000) / 1000)
        let hookBefore = HookState(state: "done", message: "", cwd: "", ts: (T0 - 60000) / 1000)
        XCTAssertEqual(Providers.codexStatus(tail: tail, mtimeMs: T0 + 3000, nowMs: T0 + 10000, hook: hookAfter).state, "done")
        XCTAssertEqual(Providers.codexStatus(tail: tail, mtimeMs: T0 + 3000, nowMs: T0 + 10000, hook: hookBefore).state, "working")
    }

    func testPsAndLsof() {
        XCTAssertEqual(PsProbe.parseEtime("05:03"), 303)
        XCTAssertEqual(PsProbe.parseEtime("01:00:00"), 3600)
        XCTAssertEqual(PsProbe.parseEtime("2-00:00:01"), 172_801)
        let out = "  101     1   10:00 /opt/homebrew/bin/codex arregla\n 102 101 01:02:03 node /x/codex.js\nbasura\n"
        let ps = PsProbe.parse(out)
        XCTAssertEqual(ps.count, 2)
        XCTAssertEqual(ps[0], PsEntry(pid: 101, ppid: 1, elapsedS: 600, argv: ["/opt/homebrew/bin/codex", "arregla"]))
        XCTAssertEqual(ps[1].argv, ["node", "/x/codex.js"])
        XCTAssertEqual(PsProbe.parseLsofNames("p101\nfcwd\nn/Users/ana/web\n"), ["/Users/ana/web"])
    }

    struct FakeProbe: ProcessProbe {
        var entries: [PsEntry]
        var cwds: [Int32: String]
        func list() -> [PsEntry] { entries }
        func cwd(of pid: Int32) -> String? { cwds[pid] }
        func openFiles(of pid: Int32) -> [String] { [] }
    }

    func testOtherAgentsProcessOnly() {
        let probe = FakeProbe(entries: [PsEntry(pid: 5, ppid: 1, elapsedS: 30, argv: ["gemini"]),
                                        PsEntry(pid: 6, ppid: 1, elapsedS: 30, argv: ["vim"]),
                                        PsEntry(pid: 7, ppid: 1, elapsedS: 30, argv: ["aider"])],
                              cwds: [5: "/Users/ana/web"])
        let o = OtherAgents(paths: KaitoPaths(home: "/nonexistent", env: [:]), probe: probe)
        let agents = o.collect(providers: ["gemini", "aider"], states: [:])
        XCTAssertEqual(agents.map(\.id), ["gemini-pid5"]) // aider sin cwd legible: fuera
        XCTAssertEqual(agents[0].cwd, "web")
        XCTAssertEqual(agents[0].state, "open")
    }
}
