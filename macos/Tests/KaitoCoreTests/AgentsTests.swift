import XCTest
@testable import KaitoCore

func J(_ v: JSON) -> String { v.serialized() }

final class AgentsTests: XCTestCase {
    func testParseTail() {
        let tail = ["cortada",
                    J(["type": "assistant", "cwd": "/h/repo", "message": ["content": [["type": "text", "text": "Hecho: tests en verde.\nRama RUN-1-x"]]]]),
                    J(["type": "assistant", "message": ["content": [["type": "tool_use", "name": "Bash", "input": ["command": "ls"]]]]])].joined(separator: "\n")
        let t = AgentParsing.parseTail(tail)
        XCTAssertEqual(t.cwd, "repo")
        XCTAssertEqual(t.lastAction, "Bash: ls")
        XCTAssertEqual(t.lastText, "Hecho: tests en verde.\nRama RUN-1-x")
        XCTAssertNil(AgentParsing.parseTail("x\n" + J(["type": "user", "message": ["content": "hola"]])).lastText)
    }

    func testFirstLine() {
        XCTAssertEqual(AgentParsing.firstLine("\n## Hecho\n- algo"), "Hecho")
        XCTAssertEqual(AgentParsing.firstLine(String(repeating: "x", count: 200), 10).count, 10)
        XCTAssertEqual(AgentParsing.ago(30), "hace 30s")
        XCTAssertEqual(AgentParsing.ago(130), "hace 2 min")
    }

    func testTicketFromHead() {
        func head(_ e: JSON...) -> String { e.map(J).joined(separator: "\n") }
        let meta: JSON = ["type": "user", "isMeta": true, "message": ["content": "Trabaja en el ticket de Jira RUN-9: no"]]
        XCTAssertEqual(AgentParsing.ticketFromHead(head(["type": "attachment"], meta,
            ["type": "user", "message": ["content": "Trabaja en el ticket de Jira RUN-12326: Arreglar x\nhttps://…"]])), .ticket("RUN-12326"))
        XCTAssertEqual(AgentParsing.ticketFromHead(head(["type": "user", "message": ["content": [["type": "text", "text": "Trabaja en el ticket de Jira AB_2-7: y"]]]])), .ticket("AB_2-7"))
        XCTAssertEqual(AgentParsing.ticketFromHead(head(["type": "user", "message": ["content": "otra cosa. Trabaja en el ticket de Jira RUN-1: x"]])), .none)
        XCTAssertEqual(AgentParsing.ticketFromHead(head(["type": "attachment"], meta)), .unknown)
        XCTAssertEqual(AgentParsing.ticketFromHead("{\"type\":\"user\",\"message\":{\"content\":\"Trabaja en el ti"), .unknown)
    }

    func testApplyDismissed() {
        let T = 1_000_000.0
        func a(_ id: String, _ ms: Double, _ st: String? = nil) -> Agent {
            var x = Agent(id: id)
            x.activityMs = ms
            x.state = st
            return x
        }
        let agents = [a("a", T - 10), a("b", T + 10), a("c", T - 10, "needs"), a("d", T - 10)]
        let r = AgentParsing.applyDismissed(agents, ["a": T, "b": T, "c": T, "gone": T])
        XCTAssertEqual(r.visible.map(\.id), ["b", "c", "d"])
        XCTAssertEqual(r.dismissed, ["a": T])
        XCTAssertTrue(r.changed)
        let r2 = AgentParsing.applyDismissed(agents, ["a": T])
        XCTAssertFalse(r2.changed)
        XCTAssertEqual(r2.visible.count, 3)
    }

    func testCanDecideAndByTicket() {
        var a = Agent(id: "x")
        a.state = "needs"
        a.hook = HookState(state: "needs", message: "", cwd: "", ts: 1, kind: "permission", request: "r1", waitUntil: 1000)
        XCTAssertTrue(AgentParsing.canDecide(a, nowS: 999))
        XCTAssertFalse(AgentParsing.canDecide(a, nowS: 1001))
        a.state = "done"
        XCTAssertFalse(AgentParsing.canDecide(a, nowS: 999))
        var x = Agent(id: "a"); x.ticket = "RUN-1"; x.age = 50
        var y = Agent(id: "b"); y.ticket = "RUN-1"; y.age = 5
        var z = Agent(id: "c"); z.age = 1
        XCTAssertEqual(AgentParsing.agentsByTicket([x, y, z]).mapValues(\.id), ["RUN-1": "b"])
    }

    func testProjectDirName() {
        XCTAssertEqual(AgentParsing.projectDirName("/Users/ana/my repo.x"), "-Users-ana-my-repo-x")
    }

    /// Registro de sesiones + transcript + estado del hook en un HOME temporal.
    func testCollectFromRegistry() throws {
        let home = NSTemporaryDirectory() + "kaito-test-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: home) }
        let paths = KaitoPaths(home: home, env: [:])
        let cwd = "/Users/ana/Documents/web"
        try JSONFile.write("\(paths.claudeSessions)/4242.json",
                           ["pid": 4242, "sessionId": "s1", "cwd": .string(cwd), "entrypoint": "cli", "status": "busy", "updatedAt": 1000])
        try JSONFile.write("\(paths.claudeSessions)/4243.json",
                           ["pid": 4243, "sessionId": "s2", "cwd": "/x", "entrypoint": "sdk-ts"])
        let dir = "\(paths.claudeProjects)/\(AgentParsing.projectDirName(cwd))"
        let lines = [J(["type": "user", "message": ["content": "Trabaja en el ticket de Jira RUN-7: algo"]]),
                     J(["type": "assistant", "cwd": .string(cwd), "message": ["content": [["type": "tool_use", "name": "Edit", "input": ["description": "cambia x"]]]]])]
        try FileUtil.writeText("\(dir)/s1.jsonl", lines.joined(separator: "\n") + "\n")
        try JSONFile.write("\(paths.stateDir)/s1.json", ["state": "needs", "message": "Pide permiso", "cwd": .string(cwd), "ts": .number(Date().timeIntervalSince1970)])
        try JSONFile.write("\(paths.stateDir)/ghost.json", ["state": "needs", "message": "Otra", "cwd": "/y/z", "ts": .number(Date().timeIntervalSince1970)])
        let ca = ClaudeAgents(paths: paths, isAlive: { $0 == 4242 })
        let states = ca.readStates()
        XCTAssertEqual(Set(states.keys), ["s1", "ghost"])
        let agents = ca.collect(windowS: 600, states: states)
        XCTAssertEqual(agents.map(\.id), ["s1", "ghost"])
        XCTAssertEqual(agents[0].cwd, "web")
        XCTAssertEqual(agents[0].ticket, "RUN-7")
        XCTAssertEqual(agents[0].lastAction, "Edit: cambia x")
        XCTAssertEqual(agents[0].state, "needs")
        XCTAssertTrue(agents[0].live)
        XCTAssertEqual(agents[1].cwd, "z")
    }
}
