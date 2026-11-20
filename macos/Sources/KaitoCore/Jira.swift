import Foundation

public struct JiraPriority: Equatable, Sendable {
    public var id: String
    public var name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

public struct JiraUser: Equatable, Sendable {
    public var accountId: String?
    public var displayName: String
}

public struct JiraIssue: Identifiable, Equatable, Sendable {
    public var key: String
    public var summary: String = ""
    public var status: String = "?"
    public var category: String = "new" // new | indeterminate | done
    public var priority: JiraPriority? = nil
    public var labels: [String] = []
    public var components: [String] = []
    public var updated: String? = nil
    public var assignee: JiraUser? = nil
    public var text: String = "" // descripción en texto (solo para ordenar repos)
    public var id: String { key }

    public init(key: String) { self.key = key }
}

public struct JiraView: Equatable, Sendable {
    public var id: String
    public var name: String
    public var custom: Bool
    public var jql: String?
}

public struct JiraTransition: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var to: String
    public var category: String
}

public struct IssueDetail: Equatable, Sendable {
    public var meta = ""
    public var description = ""
    public var extra = ""
    public var comments: [String] = []
    public init() {}
}

public struct RankedRepo: Equatable, Sendable {
    public var path: String
    public var why: String? // branch | issue | match | project
    public var branch: TicketBranch? = nil // rama existente del ticket en este repo (why == "branch")
}

/// Vistas, orden y texto de Jira (port de las funciones puras de common.js).
public enum JiraViews {
    public static let builtin: [(id: String, name: String)] = [
        ("mine", "Mías"), ("unassigned", "Sin asignar"), ("sprint", "Sprint"), ("recent", "Recientes"),
    ]
    static let projectRE = Regex("^[A-Z][A-Z0-9_]*$")
    static let viewOrder = "ORDER BY priority DESC, updated DESC"
    public static let recentJql = "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) " +
        "AND updated >= -24h ORDER BY updated DESC"

    public static func projectOf(_ key: String) -> String { String(key.split(separator: "-", omittingEmptySubsequences: false).first ?? "") }

    public static func projectsFromIssues(_ issues: [JiraIssue]) -> [String] {
        Array(Set(issues.map { projectOf($0.key) }.filter { projectRE.test($0) })).sorted()
    }

    /// JQL de una vista integrada ('mine' usa la JQL de Ajustes). nil si faltan proyectos.
    public static func viewJql(_ id: String, projects: [String] = [], mineJql: String = KaitoConfig.defaultJql) -> String? {
        let keys = projects.filter { projectRE.test($0) }
        let inProjects = keys.isEmpty ? nil : "project in (\(keys.map { "\"\($0)\"" }.joined(separator: ", ")))"
        switch id {
        case "mine": return mineJql
        case "unassigned": return inProjects.map { "\($0) AND assignee is EMPTY AND statusCategory != Done \(viewOrder)" }
        case "sprint": return inProjects.map { "\($0) AND sprint in openSprints() AND statusCategory != Done \(viewOrder)" }
        case "recent": return recentJql
        default: return nil
        }
    }

    /// Pestañas visibles en orden. "Mías" siempre está.
    public static func visibleViews(builtinOn: [String: Bool], custom: [CustomView]) -> [JiraView] {
        var on: [String: Bool] = ["unassigned": true, "sprint": true, "recent": true]
        for (k, v) in builtinOn { on[k] = v }
        var out = builtin.filter { $0.id == "mine" || on[$0.id] != false }.map { JiraView(id: $0.id, name: $0.name, custom: false, jql: nil) }
        for v in custom where v.enabled && !v.jql.isEmpty {
            out.append(JiraView(id: v.id, name: v.name.isEmpty ? "Vista" : v.name, custom: true, jql: v.jql))
        }
        return out
    }

    public static func visibleViews(_ cfg: KaitoConfig) -> [JiraView] {
        visibleViews(builtinOn: cfg.jiraBuiltinViews, custom: cfg.jiraViews)
    }

    /// "Julen Pérez García" -> "Julen P.".
    public static func shortName(_ name: String?) -> String {
        let parts = (name ?? "").split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard let first = parts.first else { return "" }
        return parts.count == 1 ? first : "\(first) \(parts[1].prefix(1).uppercased())."
    }

    // MARK: prioridad y orden

    static let priorityById = ["1": "highest", "2": "high", "3": "medium", "4": "low", "5": "lowest"]
    static let priorityByName = [
        "highest": "highest", "más alta": "highest", "mas alta": "highest", "blocker": "highest", "critical": "highest",
        "high": "high", "alta": "high", "medium": "medium", "media": "medium",
        "low": "low", "baja": "low", "lowest": "lowest", "más baja": "lowest", "mas baja": "lowest", "trivial": "lowest",
    ]
    static let priorityOrder = ["highest", "high", "medium", "low", "lowest"]
    static let blockedRE = Regex("bloquead|blocked|esperando|waiting", caseInsensitive: true)

    /// 'highest'|'high'|'medium'|'low'|'lowest'|nil. Por id 1-5; si no, por nombre.
    public static func priorityKind(_ p: JiraPriority?) -> String? {
        guard let p else { return nil }
        return priorityById[trimmed(p.id)] ?? priorityByName[trimmed(p.name).lowercased()]
    }

    /// 0 en curso, 1 por hacer, 2 resto sin terminar (bloqueado/esperando), 3 hecho.
    public static func statusGroup(_ i: JiraIssue) -> Int {
        if i.category == "done" { return 3 }
        if blockedRE.test(i.status) { return 2 }
        return i.category == "indeterminate" ? 0 : i.category == "new" ? 1 : 2
    }

    /// Grupo de estado, prioridad, `updated` más reciente y orden de la API.
    public static func sortIssues(_ issues: [JiraIssue]) -> [JiraIssue] {
        let items = issues.enumerated().map { idx, i -> (JiraIssue, Int, Int, Int, Double) in
            let k = priorityKind(i.priority).flatMap { priorityOrder.firstIndex(of: $0) } ?? priorityOrder.count
            let u = ISODate.parse(i.updated)?.timeIntervalSince1970 ?? -Double.infinity
            return (i, idx, statusGroup(i), k, u)
        }
        return items.sorted { a, b in
            if a.2 != b.2 { return a.2 < b.2 }
            if a.3 != b.3 { return a.3 < b.3 }
            if a.4 != b.4 { return a.4 > b.4 }
            return a.1 < b.1
        }.map(\.0)
    }

    // MARK: ADF y detalle

    static let adfBlocks: Set<String> = ["paragraph", "heading", "listItem", "codeBlock", "blockquote", "rule", "tableRow", "panel"]

    /// ADF → texto plano.
    public static func adfToText(_ node: JSON?) -> String {
        guard let node else { return "" }
        if let s = node.string { return trimmed(s) }
        func walk(_ n: JSON) -> String {
            if let arr = n.array { return arr.map(walk).joined() }
            guard n.object != nil else { return "" }
            let type = n["type"]?.string ?? ""
            if type == "text" { return n["text"]?.text ?? "" }
            if type == "hardBreak" { return "\n" }
            if type == "mention" || type == "emoji" { return n["attrs"]?["text"]?.text ?? "" }
            let inner = walk(n["content"] ?? .array([]))
            if type == "listItem" { return "- \(trimmed(inner))\n" }
            return adfBlocks.contains(type) ? "\(trimmed(inner))\n" : inner
        }
        return trimmed(Regex("\\n{3,}").replace(walk(node), with: "\n\n"))
    }

    static func fieldText(_ v: JSON?) -> String {
        guard let v, !v.isNull else { return "" }
        if let arr = v.array { return arr.map { fieldText($0) }.filter { !$0.isEmpty }.joined(separator: ", ") }
        if v.object != nil {
            if v["type"]?.string == "doc" { return adfToText(v) }
            return (v["value"] ?? v["name"] ?? v["displayName"])?.text ?? ""
        }
        return trimmed(v.text)
    }

    static let maxComments = 10

    /// Campos (REST v3) → {meta, description, extra, comments}. Sin emails (solo displayName).
    public static func formatIssueDetail(_ fields: JSON?) -> IssueDetail {
        let f = fields ?? .object([:])
        func line(_ label: String, _ v: String) -> String { v.isEmpty ? "" : "\(label): \(v)" }
        func keySum(_ i: JSON) -> String { "\(i["key"]?.text ?? "") – \(i["fields"]?["summary"]?.text ?? "")" }
        var d = IssueDetail()
        d.meta = [
            line("Tipo", fieldText(f["issuetype"])),
            line("Estado", fieldText(f["status"])),
            line("Prioridad", fieldText(f["priority"])),
            line("Departamento", fieldText(f["customfield_10062"])),
            line("Etiquetas", fieldText(f["labels"])),
            line("Componentes", fieldText(f["components"])),
            line("Padre/épica", f["parent"]?["key"]?.string != nil ? keySum(f["parent"]!) : ""),
            line("Informador", f["reporter"]?["displayName"]?.text ?? ""),
        ].filter { !$0.isEmpty }.joined(separator: "\n")
        func list(_ title: String, _ arr: [String]) -> String {
            arr.isEmpty ? "" : "\(title):\n" + arr.map { "- \($0)" }.joined(separator: "\n")
        }
        let links: [String] = (f["issuelinks"]?.array ?? []).compactMap { l in
            let out = l["outwardIssue"]
            guard let other = out ?? l["inwardIssue"] else { return nil }
            let rel = out != nil ? (l["type"]?["outward"]?.text ?? "") : (l["type"]?["inward"]?.text ?? "")
            return trimmed("\(rel) \(keySum(other))")
        }.filter { !$0.isEmpty }
        d.extra = [
            list("Subtareas", (f["subtasks"]?.array ?? []).map { "\(keySum($0)) – \(fieldText($0["fields"]?["status"]))" }),
            list("Tickets enlazados", links),
            list("Adjuntos", (f["attachment"]?.array ?? []).compactMap { $0["filename"]?.string }.filter { !$0.isEmpty }),
        ].filter { !$0.isEmpty }.joined(separator: "\n\n")
        d.comments = (f["comment"]?["comments"]?.array ?? []).suffix(maxComments).compactMap { c in
            let body = adfToText(c["body"])
            guard !body.isEmpty else { return nil }
            return "- \(c["author"]?["displayName"]?.text ?? "?") (\(String((c["created"]?.text ?? "").prefix(10)))): \(body)"
        }
        d.description = adfToText(f["description"])
        return d
    }

    /// Ticket de /search/jql → JiraIssue.
    public static func mapSearchIssue(_ i: JSON) -> JiraIssue {
        var out = JiraIssue(key: i["key"]?.text ?? "")
        let f = i["fields"]
        out.summary = f?["summary"]?.text ?? ""
        out.status = f?["status"]?["name"]?.string ?? "?"
        out.category = f?["status"]?["statusCategory"]?["key"]?.string ?? "new"
        if let p = f?["priority"], p.object != nil {
            out.priority = JiraPriority(id: p["id"]?.text ?? "", name: p["name"]?.text ?? "")
        }
        out.labels = (f?["labels"]?.array ?? []).compactMap { $0.string }
        out.components = (f?["components"]?.array ?? []).map { $0["name"]?.text ?? "" }
        out.updated = f?["updated"]?.string
        if let a = f?["assignee"], a.object != nil {
            out.assignee = JiraUser(accountId: a["accountId"]?.string, displayName: a["displayName"]?.text ?? "")
        }
        out.text = String(adfToText(f?["description"]).prefix(2000))
        return out
    }

    // MARK: prompt para Claude

    public static let promptMax = 12000
    public static let keyRE = Regex("^[A-Z][A-Z0-9_]*-\\d+$")

    /// "hace 5 min" / "hace 3 h" / "hace 2 d" a partir de un timestamp unix (s).
    public static func relAgo(_ ts: Double, now: Double = Date().timeIntervalSince1970) -> String {
        let d = max(0, now - ts)
        if !d.isFinite { return "hace tiempo" }
        if d < 60 { return "hace menos de 1 min" }
        if d < 3600 { return "hace \(Int(d / 60)) min" }
        if d < 86400 { return "hace \(Int(d / 3600)) h" }
        return "hace \(Int(d / 86400)) d"
    }

    /// `here`: la rama existente está en `repo`; `other`: línea "Ojo: ..." si está en otro repo.
    public static func splitExisting(repo: String?, existing: TicketBranch?) -> (here: TicketBranch?, other: String) {
        guard let e = existing, !e.branch.isEmpty else { return (nil, "") }
        if e.repo == repo { return (e, "") }
        return (nil, "Ojo: hay una rama de este ticket en \(baseName(e.repo) ?? e.repo) (\(e.branch)).\n")
    }

    /// Párrafo de Git del prompt; con `here` (rama ya existente del ticket en el repo) se continúa en ella.
    public static func gitParagraph(key: String, branch: String, here: TicketBranch? = nil, now: Double = Date().timeIntervalSince1970) -> String {
        let tail = "Haz commits pequeños a medida que completes partes, con mensajes que empiecen por \"\(key): \". " +
            "Al terminar deja todo commiteado (git status limpio) y sube la rama a origin con " +
            "`git push -u origin <rama>`. Nunca hagas push a main, master ni develop, nunca uses force-push " +
            "y no abras PR.\n"
        guard let h = here else {
            return "Git: trabaja en una rama propia (si estás en main, master o develop, crea una llamada \(branch)). " + tail
        }
        let b = h.branch
        let where_ = h.local && h.remote ? "subida a origin" : h.local ? "solo local" : "solo en origin"
        return "Git: Ya existe la rama `\(b)` para este ticket en este repo (último commit \(relAgo(h.ts, now: now)), \(where_)). " +
            "Cámbiate a ella (git switch \(b); si solo está en origin: git switch --track origin/\(b)) y continúa ahí; " +
            "no crees otra rama. " + tail.replacingOccurrences(of: "<rama>", with: b)
    }

    /// Prompt con todo el ticket (límite promptMax: se recortan primero los comentarios antiguos y luego la descripción).
    public static func buildPrompt(_ issue: JiraIssue, base: String, detail: IssueDetail?, repo: String? = nil, branch: String? = nil,
                                   existing: TicketBranch? = nil, now: Double = Date().timeIntervalSince1970) -> String {
        let (here, other) = splitExisting(repo: repo, existing: existing)
        let d = detail ?? IssueDetail()
        var comments = d.comments
        var description = d.description
        let little = description.count < 200 && comments.isEmpty
        func build() -> String {
            var s = "Trabaja en el ticket de Jira \(issue.key): \(issue.summary)\n\(base)/browse/\(issue.key)\n"
            if let repo {
                s += "Repo de trabajo: \(baseName(repo) ?? repo) (\(repo))\(branch.map { ", rama \($0)" } ?? "")\n"
            }
            s += "Todo el contenido del ticket está abajo; no intentes abrir el enlace de Jira (requiere login).\n"
            if little {
                s += "El ticket tiene poco detalle: antes de cambiar código, explora el repo, resume lo que entiendes y pregúntame lo que falte.\n"
            }
            s += other + gitParagraph(key: issue.key, branch: "\(issue.key)-<resumen-corto>", here: here, now: now)
            let blocks = [d.meta, description.isEmpty ? "" : "Descripción:\n\(description)", d.extra,
                          comments.isEmpty ? "" : "Comentarios:\n\(comments.joined(separator: "\n"))"].filter { !$0.isEmpty }
            return blocks.isEmpty ? s : "\(s)\n\(blocks.joined(separator: "\n\n"))\n"
        }
        var out = build()
        while out.count > promptMax && !comments.isEmpty {
            comments.removeFirst()
            out = build()
        }
        if out.count > promptMax && !description.isEmpty {
            let keep = max(0, description.count - (out.count - promptMax) - 1)
            description = String(description.prefix(keep)) + "…"
            out = build()
        }
        return out
    }

    /// Launch configuration de Warp (YAML; las cadenas van como JSON, que es YAML válido).
    public static func warpLaunchYaml(key: String, repo: String, promptPath: String) -> String {
        func q(_ s: String) -> String { JSON.string(s).serialized() }
        return [
            "---",
            "name: \(q("kaito-\(key)"))",
            "windows:",
            "  - tabs:",
            "      - title: \(q(key))",
            "        layout:",
            "          cwd: \(q(repo))",
            "          commands:",
            "            - exec: \(q(claudeCommand(promptPath: promptPath)))",
            "",
        ].joined(separator: "\n")
    }

    /// Comando de shell que arranca Claude con el prompt del fichero (el ticket nunca va en argv).
    public static func claudeCommand(promptPath: String) -> String {
        "claude \"$(cat \(shQuote(promptPath)))\""
    }

    // MARK: repos

    /// Tokens (>= 4 letras) del nombre de una carpeta: separa por - _ . espacio y camelCase.
    public static func repoTokens(_ path: String) -> [String] {
        let name = baseName(path) ?? ""
        let spaced = Regex("([a-z0-9])([A-Z])").replace(name, with: "$1 $2")
        return Regex("[-_.\\s]+").replace(spaced, with: " ").split(separator: " ").map { plainText(String($0)) }.filter { $0.count >= 4 }
    }

    /// Ordena repos para un ticket: usado para este ticket > nombre que aparece en el ticket > usado en el proyecto > recencia.
    public static func rankRepos(_ issue: JiraIssue, repos: [String], byIssue: [String: String], byProject: [String: String],
                                 exists: (String) -> Bool = { _ in true }, branches: [String: TicketBranch] = [:]) -> [RankedRepo] {
        let bi = byIssue[issue.key]
        let bp = byProject[projectOf(issue.key)]
        let text = plainText(([issue.summary, issue.text] + issue.labels + issue.components).joined(separator: " "))
        var seen = Set<String>()
        let paths = ([bi, bp].compactMap { $0 } + branches.keys.sorted() + repos).filter { $0.hasPrefix("/") && exists($0) && seen.insert($0).inserted }
        let scored = paths.enumerated().map { i, path -> (String, Int, Int, Int) in
            let hits = repoTokens(path).filter { text.contains($0) }.count
            let rank = branches[path] != nil ? 4 : path == bi ? 3 : hits > 0 ? 2 : path == bp ? 1 : 0
            return (path, i, hits, rank)
        }
        let whys = [4: "branch", 3: "issue", 2: "match", 1: "project"]
        return scored.sorted { a, b in
            if a.3 != b.3 { return a.3 > b.3 }
            if a.2 != b.2 { return a.2 > b.2 }
            return a.1 < b.1
        }.map { RankedRepo(path: $0.0, why: whys[$0.3], branch: branches[$0.0]) }
    }

    /// Filtra rutas: todos los términos deben aparecer (sin mayúsculas ni tildes) en la ruta.
    public static func filterRepos(_ list: [String], query: String) -> [String] {
        let terms = plainText(query).split(whereSeparator: { $0.isWhitespace }).map(String.init)
        if terms.isEmpty { return list }
        return list.filter { p in
            let hay = plainText(p)
            return terms.allSatisfy { hay.contains($0) }
        }
    }

    // MARK: transiciones

    public static func normalizeTransitions(_ body: JSON?) -> [JiraTransition] {
        (body?["transitions"]?.array ?? []).compactMap { t in
            let id = t["id"]?.text ?? ""
            guard !id.isEmpty else { return nil }
            return JiraTransition(id: id, name: t["name"]?.text ?? "",
                                  to: t["to"]?["name"]?.text ?? t["name"]?.text ?? "",
                                  category: t["to"]?["statusCategory"]?["key"]?.text ?? "")
        }
    }

    static let startRE = Regex("haciendo|in progress|en curso", caseInsensitive: true)
    public static let reviewRE = Regex("revis|review|probando|test", caseInsensitive: true)
    public static let readyRE = Regex("^(por hacer\\b|backlog\\b|to ?do$)", caseInsensitive: true)

    /// 'start': primera hacia "indeterminate" (prefiere haciendo/in progress/en curso). 'review': revis/review/probando/test.
    public static func pickTransition(_ list: [JiraTransition]?, kind: String) -> JiraTransition? {
        let l = list ?? []
        func hit(_ re: Regex) -> (JiraTransition) -> Bool { { re.test($0.to) || re.test($0.name) } }
        if kind == "start" {
            let prog = l.filter { $0.category == "indeterminate" }
            return prog.first(where: hit(startRE)) ?? prog.first
        }
        if kind == "review" { return l.first(where: hit(reviewRE)) }
        return nil
    }

    /// Regex de estado "listo" desde la config (jiraCreateStatus); por defecto readyRE.
    public static func readyRegex(_ text: String?) -> Regex {
        guard let t = text.map(trimmed), !t.isEmpty,
              (try? NSRegularExpression(pattern: t, options: [.caseInsensitive])) != nil else { return readyRE }
        return Regex(t, caseInsensitive: true)
    }

    /// Transición cuyo destino case con `re`; prefiere la que contenga `department`.
    public static func pickReadyTransition(_ list: [JiraTransition]?, department: String = "", re: Regex = readyRE) -> JiraTransition? {
        let hits = (list ?? []).filter { re.test(trimmed($0.to)) }
        let dep = plainText(department)
        if !dep.isEmpty, let t = hits.first(where: { plainText($0.to).contains(dep) }) { return t }
        return hits.first
    }
}
