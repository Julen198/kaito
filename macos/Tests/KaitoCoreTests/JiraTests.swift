import XCTest
@testable import KaitoCore

final class JiraTests: XCTestCase {
    func testAdfToText() {
        let adf: JSON = ["type": "doc", "version": 1, "content": [
            ["type": "paragraph", "content": [["type": "text", "text": "Hola "], ["type": "text", "text": "mundo", "marks": [["type": "strong"]]]]],
            ["type": "paragraph", "content": [["type": "text", "text": "línea 1"], ["type": "hardBreak"], ["type": "text", "text": "línea 2"]]],
            ["type": "bulletList", "content": [
                ["type": "listItem", "content": [["type": "paragraph", "content": [["type": "text", "text": "a"]]]]],
                ["type": "listItem", "content": [["type": "paragraph", "content": [["type": "text", "text": "b"]]]]],
            ]],
        ]]
        XCTAssertEqual(JiraViews.adfToText(adf), "Hola mundo\nlínea 1\nlínea 2\n- a\n- b")
        XCTAssertEqual(JiraViews.adfToText(nil), "")
        XCTAssertEqual(JiraViews.adfToText("texto v2"), "texto v2")
    }

    func testPriorityKind() {
        XCTAssertEqual(JiraViews.priorityKind(JiraPriority(id: "1", name: "Highest")), "highest")
        XCTAssertEqual(JiraViews.priorityKind(JiraPriority(id: "3", name: "x")), "medium")
        XCTAssertEqual(JiraViews.priorityKind(JiraPriority(id: "10001", name: "Más alta")), "highest")
        XCTAssertEqual(JiraViews.priorityKind(JiraPriority(id: "10002", name: "BAJA")), "low")
        XCTAssertEqual(JiraViews.priorityKind(JiraPriority(id: "10003", name: "Lowest")), "lowest")
        XCTAssertNil(JiraViews.priorityKind(JiraPriority(id: "99", name: "Rara")))
        XCTAssertNil(JiraViews.priorityKind(nil))
    }

    func I(_ key: String, _ cat: String, _ status: String, _ prio: String?, _ updated: String?) -> JiraIssue {
        var i = JiraIssue(key: key)
        i.category = cat
        i.status = status
        i.priority = prio.map { JiraPriority(id: $0, name: "") }
        i.updated = updated
        return i
    }

    func testSortIssues() {
        let list = [
            I("DONE", "done", "Hecho", "1", "2026-11-19T10:00:00.000+0100"),
            I("NEW-LOW", "new", "Por hacer", "4", "2026-11-19T10:00:00.000+0100"),
            I("BLOCK", "indeterminate", "Bloqueado", "1", "2026-11-19T10:00:00.000+0100"),
            I("PROG-MED-OLD", "indeterminate", "En curso", "3", "2026-11-01T10:00:00.000+0100"),
            I("NEW-HIGH", "new", "Por hacer", "2", nil),
            I("PROG-MED-NEW", "indeterminate", "En curso", "3", "2026-11-18T10:00:00.000+0100"),
            I("WAIT", "new", "Esperando cliente", "5", nil),
            I("PROG-NOPRIO", "indeterminate", "Haciendo", nil, "2026-11-19T10:00:00.000+0100"),
            I("PROG-HIGHEST", "indeterminate", "Probando", "1", nil),
            I("OTHER", "undefined", "Raro", "3", nil),
            I("PROG-MED-NEW-2", "indeterminate", "En curso", "3", "2026-11-18T10:00:00.000+0100"),
        ]
        XCTAssertEqual(JiraViews.sortIssues(list).map(\.key), ["PROG-HIGHEST", "PROG-MED-NEW", "PROG-MED-NEW-2", "PROG-MED-OLD", "PROG-NOPRIO",
                                                               "NEW-HIGH", "NEW-LOW", "BLOCK", "OTHER", "WAIT", "DONE"])
        XCTAssertEqual(JiraViews.statusGroup(I("x", "indeterminate", "Waiting for QA", nil, nil)), 2)
        XCTAssertEqual(JiraViews.statusGroup(I("x", "done", "Blocked", nil, nil)), 3)
        XCTAssertEqual(JiraViews.sortIssues([I("A", "new", "x", nil, nil), I("B", "new", "x", nil, nil)]).map(\.key), ["A", "B"])
    }

    func testViews() {
        XCTAssertEqual(JiraViews.viewJql("unassigned", projects: ["RUN", "WEB"]),
                       "project in (\"RUN\", \"WEB\") AND assignee is EMPTY AND statusCategory != Done ORDER BY priority DESC, updated DESC")
        XCTAssertEqual(JiraViews.viewJql("sprint", projects: ["RUN"]),
                       "project in (\"RUN\") AND sprint in openSprints() AND statusCategory != Done ORDER BY priority DESC, updated DESC")
        XCTAssertEqual(JiraViews.viewJql("recent"), "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -24h ORDER BY updated DESC")
        XCTAssertEqual(JiraViews.viewJql("mine", mineJql: "x = y"), "x = y")
        XCTAssertNil(JiraViews.viewJql("unassigned", projects: []))
        XCTAssertNil(JiraViews.viewJql("sprint"))
        XCTAssertEqual(JiraViews.viewJql("unassigned", projects: ["RUN", "bad\"); DROP", "A1"]),
                       "project in (\"RUN\", \"A1\") AND assignee is EMPTY AND statusCategory != Done ORDER BY priority DESC, updated DESC")
        XCTAssertNil(JiraViews.viewJql("otra", projects: ["RUN"]))
        var a = JiraIssue(key: "WEB-2"); var b = JiraIssue(key: "RUN-1"); let c = JiraIssue(key: "RUN-9"); let d = JiraIssue(key: "raro")
        a.summary = ""; b.summary = ""
        XCTAssertEqual(JiraViews.projectsFromIssues([a, b, c, d]), ["RUN", "WEB"])
        let custom = KaitoConfig.normalizeCustomViews([["id": "c1", "name": " Bugs ", "jql": " type = Bug ", "enabled": false], ["id": "c1", "name": "dup"], ["id": "mine"], nil, ["name": "sin id"]])
        XCTAssertEqual(custom, [CustomView(id: "c1", name: "Bugs", jql: "type = Bug", enabled: false)])
        XCTAssertEqual(KaitoConfig.normalizeCustomViews("x"), [])
        XCTAssertEqual(JiraViews.visibleViews(builtinOn: [:], custom: []).map(\.id), ["mine", "unassigned", "sprint", "recent"])
        let vv = JiraViews.visibleViews(builtinOn: ["sprint": false, "recent": false], custom: [
            CustomView(id: "c1", name: "Bugs", jql: "type = Bug", enabled: true), CustomView(id: "c2", name: "Off", jql: "x", enabled: false),
            CustomView(id: "c3", name: "Vacía", jql: "", enabled: true)])
        XCTAssertEqual(vv.map(\.id), ["mine", "unassigned", "c1"])
        XCTAssertEqual(vv.map(\.custom), [false, false, true])
        XCTAssertEqual(JiraViews.visibleViews(builtinOn: ["mine": false], custom: [])[0].id, "mine")
        XCTAssertEqual(["Julen Pérez García", "ana", "  ", nil, "josé  maría"].map { JiraViews.shortName($0) }, ["Julen P.", "ana", "", "", "josé M."])
    }

    func testMapSearchIssue() {
        let i = JiraViews.mapSearchIssue(["key": "RUN-1", "fields": ["summary": "s", "status": ["name": "En curso", "statusCategory": ["key": "indeterminate"]],
                                                                     "assignee": ["accountId": "a1", "displayName": "Ana B"], "priority": ["id": "2", "name": "High"]]])
        XCTAssertEqual(i.assignee, JiraUser(accountId: "a1", displayName: "Ana B"))
        XCTAssertEqual(i.category, "indeterminate")
        XCTAssertEqual(i.priority, JiraPriority(id: "2", name: "High"))
        XCTAssertNil(JiraViews.mapSearchIssue(["key": "RUN-2", "fields": [:]]).assignee)
    }

    func adfP(_ t: String) -> JSON { ["type": "doc", "version": 1, "content": [["type": "paragraph", "content": [["type": "text", "text": .string(t)]]]]] }

    func testPromptAndDetail() {
        var issue = JiraIssue(key: "RUN-123")
        issue.summary = "Arreglar \"login\"; $(rm -rf /)"
        let NOTE = "Todo el contenido del ticket está abajo; no intentes abrir el enlace de Jira (requiere login).\n"
        let LITTLE = "El ticket tiene poco detalle: antes de cambiar código, explora el repo, resume lo que entiendes y pregúntame lo que falte.\n"
        let head = "Trabaja en el ticket de Jira RUN-123: Arreglar \"login\"; $(rm -rf /)\nhttps://x.atlassian.net/browse/RUN-123\n"
        let GIT = "Git: trabaja en una rama propia (si estás en main, master o develop, crea una llamada RUN-123-<resumen-corto>). Haz commits pequeños a medida que completes partes, con mensajes que empiecen por \"RUN-123: \". Al terminar deja todo commiteado (git status limpio) y sube la rama a origin con `git push -u origin <rama>`. Nunca hagas push a main, master ni develop, nunca uses force-push y no abras PR.\n"
        XCTAssertEqual(JiraViews.buildPrompt(issue, base: "https://x.atlassian.net", detail: nil), head + NOTE + LITTLE + GIT)
        var big = IssueDetail(); big.description = String(repeating: "x", count: 20000)
        XCTAssertLessThanOrEqual(JiraViews.buildPrompt(issue, base: "b", detail: big).count, JiraViews.promptMax)
        var mid = IssueDetail(); mid.description = String(repeating: "x", count: 300)
        XCTAssertFalse(JiraViews.buildPrompt(issue, base: "b", detail: mid).contains("poco detalle"))

        let fake: JSON = [
            "issuetype": ["name": "Bug"], "status": ["name": "En curso"], "priority": ["name": "High"],
            "customfield_10062": ["value": "Tecnología"], "labels": ["a", "b"], "components": [["name": "web"]],
            "parent": ["key": "RUN-1", "fields": ["summary": "Épica"]],
            "reporter": ["displayName": "Ana", "emailAddress": "ana@secreto.com"],
            "description": adfP(String(repeating: "d", count: 250)),
            "subtasks": [["key": "RUN-124", "fields": ["summary": "Sub", "status": ["name": "Hecho"]]]],
            "issuelinks": [["type": ["outward": "bloquea", "inward": "es bloqueado por"], "outwardIssue": ["key": "RUN-9", "fields": ["summary": "Otro"]]]],
            "attachment": [["filename": "log.txt", "content": "https://secreto/log"]],
            "comment": ["comments": .array((0..<12).map { i in ["author": ["displayName": "Bob", "emailAddress": "b@x.com"], "created": "2026-01-01T10:00:00.000+0100", "body": adfP("c\(i)")] })],
        ]
        let det = JiraViews.formatIssueDetail(fake)
        XCTAssertEqual(det.meta, "Tipo: Bug\nEstado: En curso\nPrioridad: High\nDepartamento: Tecnología\nEtiquetas: a, b\nComponentes: web\nPadre/épica: RUN-1 – Épica\nInformador: Ana")
        XCTAssertEqual(det.extra, "Subtareas:\n- RUN-124 – Sub – Hecho\n\nTickets enlazados:\n- bloquea RUN-9 – Otro\n\nAdjuntos:\n- log.txt")
        XCTAssertEqual(det.comments.count, 10)
        XCTAssertEqual(det.comments.first, "- Bob (2026-01-01): c2")
        XCTAssertEqual(det.comments.last, "- Bob (2026-01-01): c11")
        let full = JiraViews.buildPrompt(issue, base: "b", detail: det)
        XCTAssertFalse(full.contains("poco detalle"))
        XCTAssertFalse(full.contains("@"))
        XCTAssertFalse(full.contains("secreto"))
        XCTAssertTrue(full.contains("Comentarios:\n- Bob"))
        var many = det
        many.comments = (0..<10).map { "- c\($0) " + String(repeating: "y", count: 2000) }
        let cut = JiraViews.buildPrompt(issue, base: "b", detail: many)
        XCTAssertLessThanOrEqual(cut.count, JiraViews.promptMax)
        XCTAssertFalse(cut.contains("c0 "))
        XCTAssertTrue(cut.contains("c9 "))
        XCTAssertEqual(JiraViews.formatIssueDetail([:]), IssueDetail())
        XCTAssertEqual(JiraViews.buildPrompt(issue, base: "b", detail: nil, repo: "/home/u/kontan-web", branch: "main").components(separatedBy: "\n")[2],
                       "Repo de trabajo: kontan-web (/home/u/kontan-web), rama main")
    }

    func testRepos() {
        XCTAssertEqual(JiraViews.repoTokens("/h/kontanApp_api-v2"), ["kontan"])
        let rr = ["/h/runnea-web", "/h/kontan-ra", "/h/otro", "/h/proj"]
        var ri = JiraIssue(key: "RUN-5")
        ri.summary = "Carreras virtuales en el antiguo Kontan"
        func order(_ bi: [String: String], _ bp: [String: String], _ i: JiraIssue? = nil) -> [String] {
            JiraViews.rankRepos(i ?? ri, repos: rr, byIssue: bi, byProject: bp).map { "\($0.path.dropFirst(3)):\($0.why ?? "null")" }
        }
        XCTAssertEqual(order([:], [:]), ["kontan-ra:match", "runnea-web:null", "otro:null", "proj:null"])
        XCTAssertEqual(Array(order([:], ["RUN": "/h/proj"]).prefix(2)), ["kontan-ra:match", "proj:project"])
        var nada = JiraIssue(key: "RUN-5"); nada.summary = "nada"
        XCTAssertEqual(order([:], ["RUN": "/h/proj"], nada)[0], "proj:project")
        XCTAssertEqual(order(["RUN-5": "/h/otro"], ["RUN": "/h/proj"])[0], "otro:issue")
        XCTAssertEqual(JiraViews.rankRepos(ri, repos: rr, byIssue: ["RUN-5": "/h/gone"], byProject: [:], exists: { $0 != "/h/gone" }).count, 4)

        let fr = ["/h/Documentos/runnea/acs_kontan", "/h/Documentos/personal/kaito", "/h/Ñandú/café"]
        XCTAssertEqual(JiraViews.filterRepos(fr, query: "").count, 3)
        XCTAssertEqual(JiraViews.filterRepos(fr, query: "ACS"), ["/h/Documentos/runnea/acs_kontan"])
        XCTAssertEqual(JiraViews.filterRepos(fr, query: "runnea kontan").count, 1)
        XCTAssertEqual(JiraViews.filterRepos(fr, query: "kontan kaito").count, 0)
        XCTAssertEqual(JiraViews.filterRepos(fr, query: "CAFE nandu").count, 1)
    }

    func testScanRepos() throws {
        let t = NSTemporaryDirectory() + "kaito-scan-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: t) }
        let fm = FileManager.default
        for p in ["a/.git", "b/sub/.git", "c/.git", "c/nested/.git", "node_modules/x/.git", ".hid/y/.git", "d/e/f/g/h/.git", "d/e/f/ok/.git", "plain/none"] {
            try fm.createDirectory(atPath: "\(t)/\(p)", withIntermediateDirectories: true)
        }
        try fm.createDirectory(atPath: "\(t)/w", withIntermediateDirectories: true)
        try "gitdir: x".write(toFile: "\(t)/w/.git", atomically: true, encoding: .utf8)
        let got = Repos.scan(roots: [t]).map { String($0.dropFirst(t.count + 1)) }
        XCTAssertEqual(got, ["a", "b/sub", "c", "d/e/f/ok", "w"])
    }

    func testTransitions() {
        let tr = JiraViews.normalizeTransitions(["transitions": [
            ["id": "11", "name": "Por Hacer", "to": ["name": "Por Hacer Desarrollo", "statusCategory": ["key": "new"]]],
            ["id": "21", "name": "Bloquear", "to": ["name": "Bloqueado", "statusCategory": ["key": "indeterminate"]]],
            ["id": "31", "name": "Empezar", "to": ["name": "Haciendo Desarrollo", "statusCategory": ["key": "indeterminate"]]],
            ["id": "41", "name": "A pruebas", "to": ["name": "Probando Desarrollo", "statusCategory": ["key": "indeterminate"]]],
            ["id": "51", "name": "Hecho", "to": ["name": "Hecho Desarrollo", "statusCategory": ["key": "done"]]],
            ["name": "sin id"],
        ]])
        XCTAssertEqual(tr.count, 5)
        XCTAssertEqual(tr[2], JiraTransition(id: "31", name: "Empezar", to: "Haciendo Desarrollo", category: "indeterminate"))
        XCTAssertEqual(JiraViews.pickTransition(tr, kind: "start")?.id, "31")
        XCTAssertEqual(JiraViews.pickTransition(tr.filter { $0.id != "31" }, kind: "start")?.id, "21")
        XCTAssertNil(JiraViews.pickTransition(tr.filter { $0.category != "indeterminate" }, kind: "start"))
        XCTAssertEqual(JiraViews.pickTransition([JiraTransition(id: "1", name: "Start progress", to: "In Progress", category: "indeterminate")], kind: "start")?.id, "1")
        XCTAssertEqual(JiraViews.pickTransition(tr, kind: "review")?.id, "41")
        XCTAssertEqual(JiraViews.pickTransition([JiraTransition(id: "2", name: "Send to review", to: "Code Review", category: "indeterminate")], kind: "review")?.id, "2")
        XCTAssertNil(JiraViews.pickTransition(tr.filter { $0.id != "41" }, kind: "review"))
        XCTAssertNil(JiraViews.pickTransition(nil, kind: "start"))
        XCTAssertEqual(JiraViews.pickReadyTransition(tr)?.id, "11")
        XCTAssertNil(JiraViews.pickReadyTransition(tr.filter { $0.id != "11" }))
    }

    func testWarpYaml() {
        XCTAssertEqual(shQuote("a'b"), "'a'\\''b'")
        let yaml = JiraViews.warpLaunchYaml(key: "RUN-123", repo: "/home/u/my repo", promptPath: "/home/u/.cache/kaito/prompts/RUN-123.txt")
        XCTAssertEqual(yaml, [
            "---",
            "name: \"kaito-RUN-123\"",
            "windows:",
            "  - tabs:",
            "      - title: \"RUN-123\"",
            "        layout:",
            "          cwd: \"/home/u/my repo\"",
            "          commands:",
            "            - exec: \"claude \\\"$(cat '/home/u/.cache/kaito/prompts/RUN-123.txt')\\\"\"",
            "",
        ].joined(separator: "\n"))
    }
}
