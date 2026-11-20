import Foundation

/// Tarea del Kaito Kanban (todos.json con los campos opcionales del tablero).
public struct BoardTask: Identifiable, Equatable, Sendable {
    public var id: String // K-<n>
    public var text: String
    public var state: String // todo | doing | review | done
    public var priority: String // highest | high | medium | low
    public var repo: String?
    public var description: String
    public var created: Double // ms
    public var updated: Double // ms
}

/// Lógica pura del tablero: port de board.js (mismos ficheros y campos que la extensión de Linux).
public enum Board {
    public static let states = ["todo", "doing", "review", "done"]
    public static let stateNames = ["todo": "Por hacer", "doing": "Haciendo", "review": "En revisión", "done": "Hecho"]
    public static let priorities = ["highest", "high", "medium", "low"]
    public static let priorityNames = ["highest": "Más alta", "high": "Alta", "medium": "Media", "low": "Baja"]
    public static let defaultPriority = "medium"
    public static let maxTitle = 200

    static func keyNum(_ k: String?) -> Int {
        guard let k, Finish.isLocalKey(k) else { return 0 }
        return Int(k.dropFirst(2)) ?? 0
    }

    /// Estado de un pendiente: el guardado si es válido; si no, el que se deduce de `done`.
    public static func state(of t: JSON) -> String {
        if let s = t["state"]?.string, states.contains(s) { return s }
        return t["done"]?.bool == true ? "done" : "todo"
    }

    public static func maxKey(_ todos: [JSON]) -> Int {
        todos.reduce(0) { max($0, keyNum($1["id"]?.string)) }
    }

    private static func ts(_ v: JSON?) -> Double? {
        guard let n = v?.number, n.isFinite, n != 0 else { return nil }
        return n
    }

    /// Migra/sincroniza la lista: id K-<n> (contador `seq`, que no reutiliza números), estado, prioridad y fechas.
    /// Si `done` y `state` no casan, manda `done` (es lo que escribe la lista de Pendientes).
    public static func migrate(_ raw: [JSON], seq: Int = 0, now: Double) -> (todos: [JSON], seq: Int, changed: Bool) {
        var n = max(seq, maxKey(raw))
        var changed = false
        var seen = Set<String>()
        var out: [JSON] = []
        for v in raw {
            guard var o = v.object, case .string = o["text"] ?? .null else {
                changed = true
                continue
            }
            var id = o["id"]?.string ?? ""
            if !Finish.isLocalKey(id) || seen.contains(id) {
                n += 1
                id = "K-\(n)"
                o["id"] = .string(id)
                changed = true
            }
            seen.insert(id)
            var st = state(of: .object(o))
            let done = o["done"]?.bool
            if done == true && st != "done" {
                st = "done"
            } else if done != true && st == "done" && o["done"] != nil {
                st = "todo"
            }
            if o["state"]?.string != st {
                o["state"] = .string(st)
                changed = true
            }
            if done != (st == "done") {
                o["done"] = .bool(st == "done")
                changed = true
            }
            if !priorities.contains(o["priority"]?.string ?? "") {
                o["priority"] = .string(defaultPriority)
                changed = true
            }
            if ts(o["created"]) == nil {
                o["created"] = .number(ts(o["ts"]) ?? now)
                changed = true
            }
            if ts(o["updated"]) == nil {
                o["updated"] = o["created"]
                changed = true
            }
            out.append(.object(o))
        }
        return (out, n, changed)
    }

    /// Nueva tarea K-<seq+1> en "Por hacer".
    public static func newTask(_ todos: [JSON], seq: Int, text: String, priority: String = defaultPriority,
                               description: String = "", now: Double) -> (task: JSON, seq: Int) {
        let n = max(seq, maxKey(todos)) + 1
        // Diccionario tipado y casos explícitos: el literal mixto de JSON atasca al comprobador de tipos.
        var o: [String: JSON] = [:]
        o["text"] = JSON.string(String(trimmed(text).prefix(maxTitle)))
        o["done"] = JSON.bool(false)
        o["id"] = JSON.string("K-\(n)")
        o["state"] = JSON.string("todo")
        o["priority"] = JSON.string(priorities.contains(priority) ? priority : defaultPriority)
        o["repo"] = JSON.null
        o["description"] = JSON.string(description)
        o["created"] = JSON.number(now)
        o["updated"] = JSON.number(now)
        return (JSON.object(o), n)
    }

    public static func task(_ v: JSON) -> BoardTask? {
        guard let id = v["id"]?.string, Finish.isLocalKey(id), let text = v["text"]?.string else { return nil }
        let p = v["priority"]?.string ?? ""
        let created = ts(v["created"]) ?? 0
        return BoardTask(id: id, text: text, state: state(of: v), priority: priorities.contains(p) ? p : defaultPriority,
                         repo: v["repo"]?.string, description: v["description"]?.string ?? "",
                         created: created, updated: ts(v["updated"]) ?? created)
    }

    /// Columnas del tablero: por prioridad y luego la más reciente; "Hecho", la más reciente primero.
    public static func columns(_ tasks: [BoardTask]) -> [String: [BoardTask]] {
        func rank(_ t: BoardTask) -> Int { priorities.firstIndex(of: t.priority) ?? 2 }
        var cols: [String: [BoardTask]] = [:]
        for s in states {
            cols[s] = tasks.filter { $0.state == s }.sorted { a, b in
                if s != "done" && rank(a) != rank(b) { return rank(a) < rank(b) }
                return a.updated > b.updated
            }
        }
        return cols
    }

    /// "Exportar informe de ventas" → "exportar-informe-de-ventas" (máx. `max` caracteres).
    public static func taskSlug(_ title: String, max: Int = 40) -> String {
        let folded = title.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil).lowercased()
        let parts = folded.split(whereSeparator: { !($0.isASCII && ($0.isLetter || $0.isNumber)) })
        let s = String(parts.joined(separator: "-").prefix(max)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return s.isEmpty ? "tarea" : s
    }

    /// Prompt para mandar una tarea local a Claude (lo reconoce AgentParsing.ticketFromHead).
    public static func localTaskPrompt(_ t: BoardTask, repo: String? = nil, branch: String? = nil) -> String {
        var s = "Trabaja en la tarea \(t.id): \(trimmed(t.text))\n"
        let desc = trimmed(t.description)
        if !desc.isEmpty { s += "\(desc)\n" }
        if let repo {
            s += "Repo de trabajo: \(baseName(repo) ?? repo) (\(repo))\(branch.map { ", rama \($0)" } ?? "")\n"
        }
        if desc.isEmpty {
            s += "La tarea tiene poco detalle: antes de cambiar código, explora el repo, resume lo que entiendes y pregúntame lo que falte.\n"
        }
        s += "Git: trabaja en una rama propia (si estás en main, master o develop, crea una llamada \(t.id)-\(taskSlug(t.text))). " +
            "Haz commits pequeños a medida que completes partes, con mensajes que empiecen por \"\(t.id): \". " +
            "Al terminar deja todo commiteado (git status limpio) y sube la rama a origin con " +
            "`git push -u origin <rama>`. Nunca hagas push a main, master ni develop, nunca uses force-push " +
            "y no abras PR.\n"
        return s
    }
}

/// todos.json como tablero (y kanban.json con el contador de ids), conservando campos desconocidos.
public struct BoardStore: Sendable {
    public let paths: KaitoPaths

    public init(paths: KaitoPaths = .default) { self.paths = paths }

    private func seq() -> Int { JSONFile.read(paths.kanbanPath)?["seq"]?.int ?? 0 }

    /// Lista migrada; escribe solo si algo cambió.
    func readRaw(now: Double) throws -> [JSON] {
        let raw = JSONFile.read(paths.todosPath)?.array ?? []
        let s = seq()
        let r = Board.migrate(raw, seq: s, now: now)
        if r.changed { try JSONFile.write(paths.todosPath, .array(r.todos)) }
        if r.seq != s { try JSONFile.write(paths.kanbanPath, JSON.object(["seq": JSON.number(Double(r.seq))])) }
        return r.todos
    }

    public func tasks(now: Date = Date()) throws -> [BoardTask] {
        try readRaw(now: (now.timeIntervalSince1970 * 1000).rounded()).compactMap(Board.task)
    }

    @discardableResult
    public func add(_ text: String, now: Date = Date()) throws -> BoardTask? {
        let ms = (now.timeIntervalSince1970 * 1000).rounded()
        let todos = try readRaw(now: ms)
        let r = Board.newTask(todos, seq: seq(), text: text, now: ms)
        try JSONFile.write(paths.todosPath, .array(todos + [r.task]))
        try JSONFile.write(paths.kanbanPath, JSON.object(["seq": JSON.number(Double(r.seq))]))
        return Board.task(r.task)
    }

    /// Lectura-modificación-escritura de una tarea por id; actualiza `updated`. false si no existe.
    @discardableResult
    public func patch(_ id: String, now: Date = Date(), _ fn: (inout [String: JSON]) -> Void) throws -> Bool {
        let ms = (now.timeIntervalSince1970 * 1000).rounded()
        var todos = try readRaw(now: ms)
        guard let i = todos.firstIndex(where: { $0["id"]?.string == id }), var o = todos[i].object else { return false }
        let before = o
        fn(&o)
        if o == before { return true }
        o["updated"] = .number(ms)
        todos[i] = .object(o)
        try JSONFile.write(paths.todosPath, .array(todos))
        return true
    }

    @discardableResult
    public func setState(_ id: String, _ state: String, now: Date = Date()) throws -> Bool {
        guard Board.states.contains(state) else { return false }
        return try patch(id, now: now) { o in
            o["state"] = JSON.string(state)
            o["done"] = JSON.bool(state == "done")
        }
    }

    public func remove(_ id: String) throws {
        let todos = try readRaw(now: (Date().timeIntervalSince1970 * 1000).rounded())
        try JSONFile.write(paths.todosPath, .array(todos.filter { $0["id"]?.string != id }))
    }
}
