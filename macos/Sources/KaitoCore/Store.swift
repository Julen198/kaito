import Foundation

public struct Todo: Identifiable, Equatable, Sendable {
    public let index: Int
    public let text: String
    public let done: Bool
    public var id: String { "\(index):\(text)" }
}

public struct Note: Identifiable, Equatable, Sendable {
    public let index: Int
    public let text: String
    public let ts: Double // ms
    public var id: String { "\(index):\(ts)" }
}

public struct Reminder: Identifiable, Equatable, Sendable {
    public let id: String
    public let text: String
    public let due: Date
    public let done: Bool
    public let snoozes: Int
}

/// Pendientes, notas y recordatorios: mismos JSON que la extensión de Linux
/// (todos.json [{text, done}], notes.json [{text, ts}], reminders.json [{id, text, due, done, snoozes}]).
/// Se lee y reescribe la lista completa conservando campos desconocidos.
public struct DataStore: Sendable {
    public static let snoozeSeconds: Double = 10 * 60
    public let paths: KaitoPaths

    public init(paths: KaitoPaths = .default) { self.paths = paths }

    private func readList(_ path: String) -> [JSON] {
        JSONFile.read(path)?.array ?? []
    }

    private func writeList(_ path: String, _ list: [JSON]) throws {
        try JSONFile.write(path, .array(list))
    }

    // MARK: pendientes

    public func todos() -> [Todo] {
        readList(paths.todosPath).enumerated().compactMap { i, v in
            guard v.object != nil else { return nil }
            return Todo(index: i, text: v["text"]?.text ?? "", done: v["done"]?.bool == true)
        }
    }

    public func addTodo(_ text: String) throws {
        var list = readList(paths.todosPath)
        list.append(["text": .string(text), "done": false])
        try writeList(paths.todosPath, list)
    }

    /// Marca (o desmarca) un pendiente. Comprueba el texto por si el fichero cambió entre medias.
    public func setTodo(_ todo: Todo, done: Bool) throws {
        var list = readList(paths.todosPath)
        guard todo.index < list.count, var o = list[todo.index].object, o["text"]?.text == todo.text else { return }
        o["done"] = .bool(done)
        list[todo.index] = .object(o)
        try writeList(paths.todosPath, list)
    }

    public func removeTodo(_ todo: Todo) throws {
        var list = readList(paths.todosPath)
        guard todo.index < list.count, list[todo.index]["text"]?.text == todo.text else { return }
        list.remove(at: todo.index)
        try writeList(paths.todosPath, list)
    }

    // MARK: notas

    public func notes() -> [Note] {
        readList(paths.notesPath).enumerated().compactMap { i, v in
            guard v.object != nil else { return nil }
            return Note(index: i, text: v["text"]?.text ?? "", ts: v["ts"]?.number ?? 0)
        }
    }

    public func addNote(_ text: String, now: Date = Date()) throws {
        var list = readList(paths.notesPath)
        list.append(["text": .string(text), "ts": .number((now.timeIntervalSince1970 * 1000).rounded())])
        try writeList(paths.notesPath, list)
    }

    public func removeNote(_ note: Note) throws {
        var list = readList(paths.notesPath)
        guard note.index < list.count, list[note.index]["text"]?.text == note.text else { return }
        list.remove(at: note.index)
        try writeList(paths.notesPath, list)
    }

    // MARK: recordatorios

    public func reminders() -> [Reminder] {
        readList(paths.remindersPath).compactMap { v in
            guard let id = v["id"]?.string, let due = ISODate.parse(v["due"]?.string) else { return nil }
            return Reminder(id: id, text: v["text"]?.text ?? "", due: due, done: v["done"]?.bool == true,
                            snoozes: v["snoozes"]?.int ?? 0)
        }
    }

    /// Pendientes de avisar (no hechos y vencidos), del más antiguo al más nuevo.
    public func dueReminders(now: Date = Date()) -> [Reminder] {
        reminders().filter { !$0.done && $0.due <= now }.sorted { $0.due < $1.due }
    }

    /// Id como en common.js: Date.now() en base 36 + aleatorio (0..1295) en base 36.
    public static func newReminderId(now: Date = Date()) -> String {
        String(Int64(now.timeIntervalSince1970 * 1000), radix: 36) + String(Int.random(in: 0..<1296), radix: 36)
    }

    @discardableResult
    public func addReminder(_ text: String, due: Date, now: Date = Date()) throws -> String {
        var list = readList(paths.remindersPath)
        let id = Self.newReminderId(now: now)
        list.append(["id": .string(id), "text": .string(text), "due": .string(ISODate.string(due)), "done": false, "snoozes": 0])
        try writeList(paths.remindersPath, list)
        return id
    }

    /// Lectura-modificación-escritura de un recordatorio por id.
    public func patchReminder(_ id: String, _ fn: (inout [String: JSON]) -> Void) throws {
        var list = readList(paths.remindersPath)
        guard let i = list.firstIndex(where: { $0["id"]?.string == id }), var o = list[i].object else { return }
        fn(&o)
        list[i] = .object(o)
        try writeList(paths.remindersPath, list)
    }

    public func snoozeReminder(_ id: String, now: Date = Date()) throws {
        try patchReminder(id) { o in
            o["due"] = .string(ISODate.string(now.addingTimeInterval(Self.snoozeSeconds)))
            o["snoozes"] = .number(Double((o["snoozes"]?.int ?? 0) + 1))
        }
    }

    /// Pospone hasta `until` (opciones largas de la tarjeta) y cuenta una vez más.
    public func snoozeReminder(_ id: String, until: Date) throws {
        try patchReminder(id) { o in
            o["due"] = .string(ISODate.string(until))
            o["snoozes"] = .number(Double((o["snoozes"]?.int ?? 0) + 1))
        }
    }

    public func completeReminder(_ id: String) throws {
        try patchReminder(id) { $0["done"] = true }
    }
}
