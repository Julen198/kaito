import XCTest
@testable import KaitoCore

final class BoardTests: XCTestCase {
    var home = ""
    var paths: KaitoPaths { KaitoPaths(home: home, env: [:]) }

    override func setUp() {
        home = NSTemporaryDirectory() + "kaito-board-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(atPath: home)
    }

    func testMigrateGivesIdsAndSyncsDone() {
        // a; b: manda done; c: done=false manda; d: id repetido; y un valor que no es tarea.
        let raw = JSON.parse("""
        [{"text":"a","done":false},{"text":"b","done":true,"state":"doing"},
         {"text":"c","done":false,"state":"done","id":"K-7"},{"text":"d","id":"K-7"},"basura"]
        """)?.array ?? []
        let r = Board.migrate(raw, seq: 2, now: 1000)
        XCTAssertTrue(r.changed)
        XCTAssertEqual(r.todos.map { $0["id"]?.string }, ["K-8", "K-9", "K-7", "K-10"])
        XCTAssertEqual(r.todos.map { Board.state(of: $0) }, ["todo", "done", "todo", "todo"])
        XCTAssertEqual(r.todos[1]["done"]?.bool, true)
        XCTAssertEqual(r.todos[0]["priority"]?.string, "medium")
        XCTAssertEqual(r.todos[0]["created"]?.number, 1000)
        XCTAssertEqual(r.seq, 10)
        XCTAssertFalse(Board.migrate(r.todos, seq: r.seq, now: 2000).changed)
    }

    func testStoreAddPatchRemoveKeepsUnknownFields() throws {
        try FileUtil.writeText(paths.todosPath, "[{\"text\":\"viejo\",\"done\":false,\"extra\":1}]")
        let s = BoardStore(paths: paths)
        XCTAssertEqual(try s.tasks().map(\.id), ["K-1"])
        let t = try s.add("  nueva  ")
        XCTAssertEqual(t?.id, "K-2")
        XCTAssertEqual(t?.text, "nueva")
        XCTAssertEqual(t?.state, "todo")
        XCTAssertTrue(try s.setState("K-1", "done"))
        XCTAssertFalse(try s.setState("K-1", "nope"))
        XCTAssertFalse(try s.setState("K-99", "done"))
        let raw = JSONFile.read(paths.todosPath)
        XCTAssertEqual(raw?[0]?["extra"]?.number, 1)
        XCTAssertEqual(raw?[0]?["done"]?.bool, true)
        XCTAssertEqual(raw?[0]?["state"]?.string, "done")
        // La lista de Pendientes sigue leyendo el mismo fichero.
        XCTAssertEqual(DataStore(paths: paths).todos().map(\.done), [true, false])
        // Borrar la última no reutiliza su número.
        try s.remove("K-2")
        XCTAssertEqual(try s.add("otra")?.id, "K-3")
    }

    func testColumnsOrder() {
        func t(_ id: String, _ state: String, _ prio: String, _ updated: Double) -> BoardTask {
            BoardTask(id: id, text: id, state: state, priority: prio, repo: nil, description: "", created: 0, updated: updated)
        }
        let cols = Board.columns([t("K-1", "todo", "low", 9), t("K-2", "todo", "highest", 1), t("K-3", "todo", "highest", 5),
                                  t("K-4", "done", "low", 9), t("K-5", "done", "highest", 1)])
        XCTAssertEqual(cols["todo"]?.map(\.id), ["K-3", "K-2", "K-1"])
        XCTAssertEqual(cols["done"]?.map(\.id), ["K-4", "K-5"])
        XCTAssertEqual(cols["doing"], [])
    }

    func testSlugAndPrompt() {
        XCTAssertEqual(Board.taskSlug("Exportar informe de ventas"), "exportar-informe-de-ventas")
        XCTAssertEqual(Board.taskSlug("¡Sesión caída!"), "sesion-caida")
        XCTAssertEqual(Board.taskSlug("···"), "tarea")
        let t = BoardTask(id: "K-3", text: "Arreglar login", state: "todo", priority: "medium", repo: nil, description: "", created: 0, updated: 0)
        let p = Board.localTaskPrompt(t, repo: "/r/web", branch: "main")
        XCTAssertTrue(p.hasPrefix("Trabaja en la tarea K-3: Arreglar login\n"))
        XCTAssertTrue(p.contains("Repo de trabajo: web (/r/web), rama main"))
        XCTAssertTrue(p.contains("K-3-arreglar-login"))
        XCTAssertTrue(p.contains("poco detalle"))
    }

    func testOrganizeDefault() {
        func cfg(_ text: String) -> KaitoConfig { KaitoConfig.from(JSON.parse(text), home: home, isDir: { _ in false }) }
        let jira = "\"jiraBaseUrl\":\"https://x.atlassian.net\",\"jiraEmail\":\"a@b.c\""
        XCTAssertEqual(cfg("{}").organize, "kanban") // Jira sin configurar
        XCTAssertEqual(cfg("{\(jira)}").organize, "jira")
        XCTAssertEqual(cfg("{\"jiraEnabled\":false}").organize, "list")
        XCTAssertEqual(cfg("{\"jiraEnabled\":false,\"kanbanEnabled\":true}").organize, "kanban")
        XCTAssertEqual(cfg("{\"organize\":\"list\",\(jira)}").organize, "list")
        XCTAssertFalse(cfg("{\"organize\":\"kanban\",\"jiraEnabled\":true}").jiraEnabled)
    }
}
