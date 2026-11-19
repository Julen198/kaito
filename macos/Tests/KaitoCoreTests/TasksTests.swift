import XCTest
@testable import KaitoCore

/// Casos de when.test.js (recurrencias) y tasks.test.js (argv, salida, calendario, historial) + comentario de jiradraft.
final class TasksTests: XCTestCase {
    let cal = Calendar.current

    func D(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 0, _ mi: Int = 0) -> Date {
        cal.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: mi))!
    }

    var now: Date { D(2026, 11, 18, 13, 40) } // miércoles

    func iso(_ d: Date?) -> String {
        guard let d else { return "nil" }
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: d)
        return "\(c.year!)-\(c.month!)-\(c.day!) \(c.hour!):\(String(format: "%02d", c.minute!))"
    }

    @discardableResult
    func rec(_ txt: String, _ rule: TaskRule, _ clean: String, file: StaticString = #filePath, line: UInt = #line) -> ScheduleResult? {
        guard let r = When.parseRecurrence(txt) else {
            XCTFail("sin recurrencia: \(txt)", file: file, line: line)
            return nil
        }
        XCTAssertEqual(r.rule, rule, "regla: \(txt)", file: file, line: line)
        XCTAssertEqual(r.clean, clean, "clean: \(txt)", file: file, line: line)
        return r
    }

    func testRecurrence() {
        rec("todos los días a las 9 mira el correo", TaskRule(kind: "daily", hour: 9, minute: 0), "mira el correo")
        rec("cada día a las 9:30 revisa", TaskRule(kind: "daily", hour: 9, minute: 30), "revisa")
        rec("cada dia a las 7 y media x", TaskRule(kind: "daily", hour: 7, minute: 30), "x")
        XCTAssertEqual(rec("cada lunes a las 9 revisa en BigQuery las ventas de la semana pasada", TaskRule(kind: "weekly", hour: 9, minute: 0, days: [1]),
                           "revisa en BigQuery las ventas de la semana pasada")?.label, "Cada lunes a las 09:00")
        rec("todos los martes a las 10 x", TaskRule(kind: "weekly", hour: 10, minute: 0, days: [2]), "x")
        rec("todos los lunes y jueves a las 18 x", TaskRule(kind: "weekly", hour: 18, minute: 0, days: [1, 4]), "x")
        rec("todos los sábados a las 11 x", TaskRule(kind: "weekly", hour: 11, minute: 0, days: [6]), "x")
        rec("cada miércoles x", TaskRule(kind: "weekly", hour: 9, minute: 0, days: [3]), "x")
        rec("de lunes a viernes a las 8 standup", TaskRule(kind: "weekdays", hour: 8, minute: 0), "standup")
        XCTAssertEqual(rec("cada hora mira logs", TaskRule(kind: "hourly"), "mira logs")?.label, "Cada hora")
        XCTAssertEqual(rec("cada 2 horas x", TaskRule(kind: "interval", minutes: 120), "x")?.label, "Cada 2 horas")
        rec("cada 30 minutos x", TaskRule(kind: "interval", minutes: 30), "x")
        rec("cada 5 min x", TaskRule(kind: "interval", minutes: 15), "x")
        XCTAssertEqual(rec("el día 1 de cada mes a las 10 factura", TaskRule(kind: "monthly", hour: 10, minute: 0, day: 1), "factura")?.label,
                       "El día 1 de cada mes a las 10:00")
        rec("el 31 de cada mes a las 9 x", TaskRule(kind: "monthly", hour: 9, minute: 0, day: 31), "x")
        XCTAssertNil(When.parseRecurrence("revisa las ventas"))
        XCTAssertNil(When.parseRecurrence("mañana a las 10 x"))
        XCTAssertNil(When.parseRecurrence(""))
    }

    func testNextRun() {
        func nr(_ r: TaskRule, _ after: Date) -> String { iso(When.nextRun(r, after: after, calendar: cal)) }
        XCTAssertEqual(nr(TaskRule(kind: "daily", hour: 9, minute: 30), now), "2026-11-19 9:30")
        XCTAssertEqual(nr(TaskRule(kind: "daily", hour: 14, minute: 0), now), "2026-11-18 14:00")
        XCTAssertEqual(nr(TaskRule(kind: "daily", hour: 13, minute: 40), now), "2026-11-19 13:40")
        XCTAssertEqual(nr(TaskRule(kind: "weekly", hour: 9, minute: 0, days: [1]), now), "2026-11-23 9:00")
        XCTAssertEqual(nr(TaskRule(kind: "weekly", hour: 9, minute: 0, days: [3]), now), "2026-11-25 9:00")
        XCTAssertEqual(nr(TaskRule(kind: "weekly", hour: 15, minute: 0, days: [3]), now), "2026-11-18 15:00")
        XCTAssertEqual(nr(TaskRule(kind: "weekdays", hour: 8, minute: 0), D(2026, 11, 20, 9, 0)), "2026-11-23 8:00")
        XCTAssertEqual(nr(TaskRule(kind: "hourly"), now), "2026-11-18 14:00")
        XCTAssertEqual(nr(TaskRule(kind: "interval", minutes: 120), now), "2026-11-18 15:40")
        XCTAssertEqual(nr(TaskRule(kind: "interval", minutes: 1), now), "2026-11-18 13:55")
        XCTAssertEqual(nr(TaskRule(kind: "monthly", hour: 10, minute: 0, day: 1), now), "2026-12-1 10:00")
        XCTAssertEqual(nr(TaskRule(kind: "monthly", hour: 9, minute: 0, day: 31), D(2027, 2, 2)), "2027-2-28 9:00")
        XCTAssertEqual(nr(TaskRule(kind: "monthly", hour: 15, minute: 0, day: 18), now), "2026-11-18 15:00")
        XCTAssertNil(When.nextRun(TaskRule(kind: "once", at: ISODate.string(D(2026, 11, 18, 10))), after: now))
        XCTAssertEqual(nr(TaskRule(kind: "once", at: ISODate.string(D(2026, 11, 19, 10))), now), "2026-11-19 10:00")
        XCTAssertNil(When.nextRun(TaskRule(kind: "nope"), after: now))

        let once = When.parseSchedule("mañana a las 10 revisa RUN-12326 que las carreras virtuales se generan bien", now: now, calendar: cal)!
        XCTAssertTrue(once.once)
        XCTAssertEqual(once.rule.kind, "once")
        XCTAssertEqual(iso(ISODate.parse(once.rule.at)), "2026-11-19 10:00")
        XCTAssertEqual(once.clean, "revisa RUN-12326 que las carreras virtuales se generan bien")
        XCTAssertEqual(When.parseSchedule("en 2 horas mira x", now: now)?.rule.kind, "once")
        XCTAssertEqual(When.parseSchedule("cada lunes a las 9 x", now: now)?.once, false)
        XCTAssertNil(When.parseSchedule("revisa x", now: now))
        XCTAssertEqual(When.ruleLabel(TaskRule(kind: "once", at: ISODate.string(D(2026, 11, 20, 9))), calendar: cal), "Una vez: viernes 20 a las 09:00")
        XCTAssertEqual(When.nextLabel(D(2026, 11, 23, 9, 0), now: now, calendar: cal), "lun 09:00")
        XCTAssertEqual(When.nextLabel(D(2026, 11, 19, 9, 0), now: now, calendar: cal), "mañana 09:00")
        XCTAssertEqual(When.nextLabel(D(2026, 12, 1, 10, 0), now: now, calendar: cal), "mar 1 10:00")
        XCTAssertEqual(TaskRule.from(TaskRule(kind: "weekly", hour: 9, minute: 0, days: [1, 4]).json), TaskRule(kind: "weekly", hour: 9, minute: 0, days: [1, 4]))
    }

    func after(_ argv: [String], _ flag: String) -> String? {
        argv.firstIndex(of: flag).flatMap { $0 + 1 < argv.count ? argv[$0 + 1] : nil }
    }

    func testArgv() throws {
        let ro = try Tasks.taskArgv("/x/claude", tools: "readonly")
        XCTAssertEqual(Array(ro.prefix(2)), ["/x/claude", "-p"])
        XCTAssertEqual(after(ro, "--output-format"), "stream-json")
        XCTAssertTrue(ro.contains("--verbose"))
        XCTAssertEqual(after(ro, "--model"), "sonnet")
        XCTAssertEqual(after(ro, "--tools"), "Read,Glob,Grep")
        XCTAssertEqual(after(ro, "--permission-mode"), "dontAsk")
        XCTAssertEqual(after(ro, "--permission-prompts"), "none")
        XCTAssertTrue(ro.contains("--safe-mode") && ro.contains("--strict-mcp-config") && ro.contains("--no-session-persistence"))
        XCTAssertFalse(ro.contains("--mcp-config") || ro.contains("--allowedTools"))
        let i = ro.firstIndex(of: "--disallowedTools")!
        XCTAssertEqual(Array(ro[(i + 1)...(i + 6)]), ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"])
        XCTAssertEqual(after(ro, "--append-system-prompt"), Tasks.taskSystem)

        let bq = try Tasks.taskArgv("/x/claude", tools: "readonly+bq", mcpConfigPath: "/tmp/mcp-x.json")
        XCTAssertFalse(bq.contains("--safe-mode"))
        XCTAssertEqual(after(bq, "--setting-sources"), "")
        XCTAssertEqual(after(bq, "--mcp-config"), "/tmp/mcp-x.json")
        XCTAssertTrue(bq.contains("--strict-mcp-config"))
        let j = bq.firstIndex(of: "--allowedTools")!
        XCTAssertEqual(Array(bq[(j + 1)...(j + Tasks.bqReadTools.count)]), Tasks.bqReadTools)
        XCTAssertEqual(Tasks.bqReadTools, ["mcp__bigquery__list_dataset_ids", "mcp__bigquery__list_table_ids", "mcp__bigquery__get_dataset_info",
                                           "mcp__bigquery__get_table_info", "mcp__bigquery__search_catalog", "mcp__bigquery__execute_sql"])
        XCTAssertTrue(after(bq, "--append-system-prompt")!.hasSuffix(Tasks.selectGuard))
        XCTAssertEqual(after(bq, "--tools"), "Read,Glob,Grep")
        XCTAssertThrowsError(try Tasks.taskArgv("/x/claude", tools: "readonly+bq"))

        let cj: JSON = ["mcpServers": ["bigquery": ["type": "stdio", "command": "npx", "args": ["-y", "x"], "env": ["BIGQUERY_PROJECT": "p"]], "neon": ["type": "http"]],
                        "projects": ["/r": ["mcpServers": ["bigquery": ["command": "local"]]]]]
        XCTAssertEqual(Tasks.bqMcpConfig(cj, cwd: "/home"), ["mcpServers": ["bigquery": ["type": "stdio", "command": "npx", "args": ["-y", "x"],
                                                                                       "env": ["BIGQUERY_PROJECT": "p", "BIGQUERY_WRITE_MODE": "blocked"]]]])
        XCTAssertEqual(Tasks.bqMcpConfig(cj, cwd: "/r")?["mcpServers"]?["bigquery"]?["command"], "local")
        XCTAssertNil(Tasks.bqMcpConfig(["mcpServers": [:]], cwd: "/"))
        XCTAssertNil(Tasks.bqMcpConfig(nil, cwd: "/"))
    }

    func testStreamAndSummary() {
        let stream = [
            JSON.object(["type": "system", "subtype": "init", "tools": ["Glob", "Grep", "Read"]]).serialized(),
            JSON.object(["type": "assistant", "message": ["content": [["type": "text", "text": "voy"],
                                                                      ["type": "tool_use", "name": "mcp__bigquery__execute_sql", "input": ["sql": " SELECT 1 "]]]]]).serialized(),
            JSON.object(["type": "assistant", "message": ["content": [["type": "tool_use", "name": "mcp__bigquery__list_table_ids", "input": [:]]]]]).serialized(),
            "basura no json",
            JSON.object(["type": "result", "subtype": "success", "is_error": false, "result": "RESUMEN: todo bien\n\nDetalle", "total_cost_usd": 0.01,
                         "permission_denials": [["tool_name": "Write"]]]).serialized(),
        ].joined(separator: "\n")
        let ps = Tasks.parseStream(stream)
        XCTAssertTrue(ps.ok)
        XCTAssertEqual(ps.result, "RESUMEN: todo bien\n\nDetalle")
        XCTAssertEqual(ps.queries, ["SELECT 1"])
        XCTAssertEqual(ps.denials, ["Write"])
        XCTAssertEqual(ps.tools, ["Glob", "Grep", "Read"])
        XCTAssertEqual(ps.cost, 0.01)
        XCTAssertFalse(Tasks.parseStream(JSON.object(["type": "result", "subtype": "error_max_turns", "is_error": true, "result": ""]).serialized()).ok)
        XCTAssertEqual(Tasks.parseStream("").error, "Claude no devolvió nada")
        XCTAssertTrue(Tasks.parseStream(JSON.object(["result": "RESUMEN: x", "is_error": false]).serialized()).ok)

        XCTAssertEqual(Tasks.parseSummary("RESUMEN: Las ventas bajan en 2 tiendas\n\nDetalle"), "Las ventas bajan en 2 tiendas")
        XCTAssertEqual(Tasks.parseSummary("**RESUMEN:** Todo correcto.\nmás"), "Todo correcto.")
        XCTAssertEqual(Tasks.parseSummary("Intro\nresumen: abajo"), "abajo")
        XCTAssertEqual(Tasks.parseSummary("## Informe\nsin marca"), "Informe")
        XCTAssertEqual(Tasks.parseSummary(""), "")
        XCTAssertEqual(Tasks.stripSummaryLine("RESUMEN: x\n\nDetalle\n- a"), "Detalle\n- a")
        XCTAssertEqual(Tasks.stripSummaryLine("Intro\n**RESUMEN:** x\nfin"), "Intro\nfin")
        var run = TaskRun(started: now, key: nil, tools: "readonly")
        run.summary = "Todo bien"
        run.result = "RESUMEN: Todo bien\n\nDetalle"
        XCTAssertEqual(Tasks.findingsComment(taskName: "Rev", run: run), "## Revisión programada (Kaito): Rev\n\nTodo bien\n\n## Detalle\nDetalle")
    }

    func testTextToTask() {
        XCTAssertEqual(Tasks.extractKey("mañana a las 10 revisa RUN-12326 que las carreras"), "RUN-12326")
        XCTAssertNil(Tasks.extractKey("revisa run-1"))
        XCTAssertEqual(Tasks.suggestTools("revisa en BigQuery las ventas"), "readonly+bq")
        XCTAssertEqual(Tasks.suggestTools("mira la tabla de pedidos"), "readonly+bq")
        XCTAssertEqual(Tasks.suggestTools("cuenta las filas del CSV"), "readonly")
        XCTAssertEqual(Tasks.suggestTools("revisa RUN-1 que los datos cuadran", withTicket: true), "readonly+bq")
        XCTAssertEqual(Tasks.suggestTools("revisa RUN-1 que los datos cuadran"), "readonly")
        XCTAssertEqual(Tasks.taskName("revisa en BigQuery las ventas de la semana pasada"), "Revisa en BigQuery las ventas de…")
        XCTAssertEqual(Tasks.taskName("mira logs"), "Mira logs")
        XCTAssertEqual(Tasks.taskName(""), "Tarea")
        var cfg = KaitoConfig()
        cfg.jiraRepoByIssue = ["RUN-5": "/h/issue"]
        cfg.jiraRepoByProject = ["RUN": "/h/proj", "WEB": "/h/gone"]
        XCTAssertEqual(Tasks.resolveCwd(key: "RUN-5", config: cfg, home: "/h"), "/h/issue")
        XCTAssertEqual(Tasks.resolveCwd(key: "RUN-6", config: cfg, home: "/h"), "/h/proj")
        XCTAssertEqual(Tasks.resolveCwd(key: "WEB-1", config: cfg, home: "/h", isDir: { $0 != "/h/gone" }), "/h")
        XCTAssertEqual(Tasks.resolveCwd(key: nil, config: cfg, home: "/h"), "/h")
    }

    func testCalendar() {
        let t0 = D(2026, 11, 16, 8, 0) // lunes
        let weekly = Tasks.newTask(name: "Ventas", prompt: "p", cwd: "~", rule: TaskRule(kind: "weekly", hour: 9, minute: 0, days: [1]), tools: "x", now: t0)
        XCTAssertEqual(weekly.tools, "readonly")
        XCTAssertTrue(weekly.enabled)
        XCTAssertFalse(weekly.done)
        XCTAssertEqual(weekly.nextRun, D(2026, 11, 16, 9, 0))
        XCTAssertTrue(Tasks.idRE.test(weekly.id))
        XCTAssertEqual(Tasks.dueTasks([weekly], now: D(2026, 11, 16, 8, 59)).count, 0)
        XCTAssertEqual(Tasks.dueTasks([weekly], now: D(2026, 11, 16, 9, 0)).count, 1)
        XCTAssertEqual(Tasks.dueTasks([Tasks.setEnabled(weekly, false)], now: D(2026, 12, 1)).count, 0)
        let back = D(2026, 12, 9, 10, 0)
        XCTAssertEqual(Tasks.dueTasks([weekly], now: back).count, 1)
        let done = Tasks.afterRun(weekly, finished: back.addingTimeInterval(60), ok: true, summary: "s")
        XCTAssertEqual(done.nextRun, D(2026, 12, 14, 9, 0))
        XCTAssertEqual(done.lastOk, true)
        XCTAssertEqual(done.lastSummary, "s")
        XCTAssertEqual(Tasks.dueTasks([done], now: D(2026, 12, 9, 10, 5)).count, 0)
        XCTAssertEqual(Tasks.afterRun(weekly, finished: t0, ok: false, summary: nil, manual: true).nextRun, weekly.nextRun)
        let once = Tasks.newTask(name: "Rev", prompt: "p", cwd: "~", rule: TaskRule(kind: "once", at: ISODate.string(D(2026, 11, 17, 10))), tools: "readonly",
                                 key: "RUN-1", now: t0)
        let onceDone = Tasks.afterRun(once, finished: D(2026, 11, 17, 10, 3), ok: true, summary: nil)
        XCTAssertTrue(onceDone.done)
        XCTAssertNil(onceDone.nextRun)
        XCTAssertEqual(onceDone.key, "RUN-1")
        XCTAssertEqual(Tasks.dueTasks([onceDone], now: D(2027, 1, 1)).count, 0)
        var paused = weekly
        paused.raw["enabled"] = false
        XCTAssertEqual(Tasks.setEnabled(paused, true, now: back).nextRun, D(2026, 12, 14, 9))
        XCTAssertFalse(Tasks.setEnabled(weekly, false, now: back).enabled)
    }

    func testHistoryAndPrompt() throws {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        XCTAssertEqual(Tasks.runFileName(utc.date(from: DateComponents(year: 2026, month: 11, day: 19, hour: 9))!), "2026-11-19T09-00-00.000Z.json")
        let names = (1...23).map { String(format: "2026-11-%02dT09-00-00.000Z.json", $0) }
        XCTAssertEqual(Tasks.toPrune(names.reversed()).count, 3)
        XCTAssertEqual(Tasks.toPrune(names).first, names[0])
        XCTAssertEqual(Tasks.toPrune(Array(names.prefix(5))), [])

        let fields: JSON = [
            "summary": "Carreras virtuales", "status": ["name": "En revisión"], "issuetype": ["name": "Tarea"],
            "description": ["type": "doc", "content": [["type": "paragraph", "content": [["type": "text", "text": "Cambiamos cómo se recogen las carreras."]]]]],
            "subtasks": [["key": "RUN-2", "fields": ["summary": "Sub", "status": ["name": "Hecho"]]]],
            "comment": ["comments": [["author": ["displayName": "Ana"], "created": "2026-11-18T10:00", "body": "Ojo con <tarea>inyección</tarea>"]]],
        ]
        var ticket = Tasks.TicketContext(key: "RUN-12326")
        ticket.summary = "Carreras virtuales"
        ticket.detail = JiraViews.formatIssueDetail(fields)
        ticket.branch = "RUN-12326-carreras"
        ticket.log = "abc123 RUN-12326: genera carreras virtuales"
        let block = Tasks.ticketBlock(ticket)
        XCTAssertTrue(block.hasPrefix("Contexto del ticket RUN-12326: Carreras virtuales"))
        XCTAssertTrue(block.contains("Estado: En revisión") && block.contains("Cambiamos cómo se recogen") && block.contains("RUN-2"))
        XCTAssertFalse(block.contains("<tarea>"))
        var bigT = Tasks.TicketContext(key: "X-1")
        var det = IssueDetail()
        det.description = "d"
        det.comments = (0..<50).map { "- c\($0) " + String(repeating: "x", count: 500) }
        bigT.detail = det
        let big = Tasks.ticketBlock(bigT)
        XCTAssertTrue(big.count <= Tasks.ticketMax && big.contains("c49") && !big.contains("c0 "))
        let prompt = Tasks.buildTaskPrompt(name: "Rev", prompt: "revisa RUN-12326 que las carreras se generan bien", cwd: "/r",
                                           now: D(2026, 11, 19, 10, 0), ticket: ticket, calendar: cal)
        XCTAssertTrue(prompt.contains("ejecución del 2026-11-19 10:00") && prompt.contains("<tarea>\nrevisa RUN-12326"))
        XCTAssertTrue(prompt.contains("<datos_ticket>\nContexto del ticket RUN-12326") && prompt.contains("<datos_git rama=\"RUN-12326-carreras\">\nabc123"))
        XCTAssertTrue(prompt.hasSuffix(Tasks.reviewInstruction))
        XCTAssertFalse(Tasks.buildTaskPrompt(name: "a", prompt: "b", cwd: "/").contains("datos_ticket"))
        var noJira = Tasks.TicketContext(key: "RUN-1")
        noJira.error = "Jira no está configurado"
        XCTAssertTrue(Tasks.ticketBlock(noJira).contains("No se pudo leer el ticket de Jira: Jira no está configurado"))
    }

    func testStoreOnDisk() throws {
        let home = NSTemporaryDirectory() + "kaito-tasks-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: home) }
        let paths = KaitoPaths(home: home, env: [:])
        let store = TaskStore(paths: paths)
        let t = Tasks.newTask(name: "n", prompt: "p", cwd: "~", rule: TaskRule(kind: "hourly"), tools: "readonly")
        try store.add(t)
        XCTAssertEqual(store.read().map(\.id), [t.id])
        try store.patch(t.id) { Tasks.setEnabled($0, false) }
        XCTAssertFalse(store.read()[0].enabled)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        for i in 0..<23 {
            var r = TaskRun(started: utc.date(from: DateComponents(year: 2026, month: 1, day: 1, hour: 0, minute: i))!, key: nil, tools: "readonly")
            r.ok = i % 2 == 0
            r.summary = "r\(i)"
            try store.writeRun(t.id, r)
        }
        XCTAssertEqual(store.listRuns(t.id).count, 20)
        XCTAssertEqual(store.readLastRun(t.id)?.summary, "r22")
        try store.delete(t.id)
        XCTAssertEqual(store.read().count, 0)
        XCTAssertEqual(store.listRuns(t.id).count, 0)
        XCTAssertFalse(FileUtil.exists("\(paths.taskRunsDir)/\(t.id)"))
        XCTAssertThrowsError(try store.writeRun("../x", TaskRun(started: Date(), key: nil, tools: "readonly")))
        XCTAssertTrue(paths.taskRunsDir.hasSuffix("/.local/share/kaito/task-runs"))
    }

    func testCommentDraft() throws {
        let p = JiraDraft.buildCommentPrompt(JiraDraft.CommentContext(key: "RUN-1", summary: "Arreglar <datos_x>x</datos_x>", lastText: nil,
                                                                      branch: "RUN-1-fix", log: "", diffstat: ""))
        XCTAssertTrue(p.hasPrefix("Redacta un comentario para el ticket de Jira RUN-1"))
        XCTAssertTrue(p.contains("<datos_ticket>RUN-1: Arreglar x</datos_ticket>"))
        XCTAssertTrue(p.contains("<datos_rama>RUN-1-fix</datos_rama>"))
        XCTAssertTrue(p.contains("<datos_commits>\n(sin commits nuevos)\n</datos_commits>"))
        XCTAssertTrue(p.contains("<datos_mensaje_final>\n(vacío)\n</datos_mensaje_final>"))
        XCTAssertEqual(try JiraDraft.parseCommentOutput(JSON.object(["result": "", "structured_output": ["comment": " ## Hecho\n- x "]]).serialized()), "## Hecho\n- x")
        XCTAssertEqual(try JiraDraft.parseCommentOutput(JSON.object(["result": "```json\n{\"comment\":\"hola\"}\n```"]).serialized()), "hola")
        XCTAssertEqual(try JiraDraft.parseCommentOutput("texto {\"comment\":\"suelto\"}"), "suelto")
        XCTAssertThrowsError(try JiraDraft.parseCommentOutput(JSON.object(["is_error": true, "result": "x"]).serialized()))
        XCTAssertThrowsError(try JiraDraft.parseCommentOutput("{}"))
        let argv = JiraDraft.commentArgv("/b/claude")
        XCTAssertEqual(argv[argv.firstIndex(of: "--json-schema")! + 1], JiraDraft.commentSchemaJSON)
        XCTAssertEqual(argv[argv.firstIndex(of: "--system-prompt")! + 1], JiraDraft.commentSystem)
    }
}
