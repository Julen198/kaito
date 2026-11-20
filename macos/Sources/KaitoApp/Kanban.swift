import AppKit
import KaitoCore
import SwiftUI

// Kaito Kanban: tablero local (todos.json) para quien no usa Jira. Sección del menú + acciones del modelo.
// La ventana del tablero y el panel de tarea están en BoardWindow.swift.

extension AppModel {
    func addBoardTask(_ text: String) -> BoardTask? {
        let t = trimmed(text)
        guard !t.isEmpty else { return nil }
        do {
            let task = try boardStore.add(t)
            refreshLocal()
            return task
        } catch {
            show("No se pudo guardar: \(error.localizedDescription)")
            return nil
        }
    }

    /// Cambios de una tarea (estado, prioridad, título, descripción, repo) con aviso si falla.
    func patchBoardTask(_ id: String, _ fn: (inout [String: JSON]) -> Void) {
        do {
            if try !boardStore.patch(id, fn) { show("\(id) ya no existe en el tablero") }
        } catch {
            show("No se pudo guardar \(id): \(error.localizedDescription)")
        }
        refreshLocal()
    }

    func moveBoardTask(_ id: String, to state: String) {
        guard Board.states.contains(state) else { return }
        patchBoardTask(id) { o in
            o["state"] = .string(state)
            o["done"] = .bool(state == "done")
        }
    }

    func deleteBoardTask(_ id: String) {
        do { try boardStore.remove(id) } catch { show("No se pudo borrar \(id): \(error.localizedDescription)") }
        refreshLocal()
    }

    /// Reutiliza el selector de repo de Jira: la tarea viaja como un JiraIssue con clave K-<n>.
    func pickRepo(for t: BoardTask) {
        var i = JiraIssue(key: t.id)
        i.summary = t.text
        i.text = t.description
        beginRepoPick(i)
    }

    func sendLocalToClaude(_ key: String, repo: String) {
        guard let task = board.first(where: { $0.id == key }) else {
            show("\(key) ya no existe en el tablero")
            return
        }
        let cfg = config
        do {
            try configStore.update([
                "jiraRepoByIssue": .object(cfg.jiraRepoByIssue.merging([key: repo]) { $1 }.mapValues { .string($0) }),
            ])
            let prompt = Board.localTaskPrompt(task, repo: repo, branch: Repos.branch(repo))
            let promptPath = "\(paths.promptsDir)/\(key).txt"
            try FileUtil.writeText(promptPath, prompt, dirMode: 0o700)
            try Terminals.launchClaude(key: key, repo: repo, promptPath: promptPath, preference: cfg.terminal)
            show("\(key) enviada a Claude en \(baseName(repo) ?? repo)")
        } catch {
            show("No se pudo mandar \(key) a Claude: \(error.localizedDescription)")
            return
        }
        // Como un ticket "Por hacer" mandado a Claude: pasa a "Haciendo".
        patchBoardTask(key) { o in
            o["repo"] = .string(repo)
            if Board.state(of: .object(o)) == "todo" {
                o["state"] = "doing"
                o["done"] = false
            }
        }
    }

    /// El selector de repo abierto es de una tarea del tablero (no de un ticket de Jira).
    var localRepoPick: JiraIssue? {
        guard let i = repoPickIssue, Finish.isLocalKey(i.key) else { return nil }
        return i
    }
}

enum BoardStyle {
    static func color(_ state: String) -> Color {
        switch state {
        case "doing": return Color(red: 0.357, green: 0.784, blue: 0.686) // #5BC8AF
        case "review": return Color(red: 1.0, green: 0.639, blue: 0.282) // #FFA348
        case "done": return Color(red: 0.471, green: 0.682, blue: 0.929) // #78AEED
        default: return Color(red: 0.604, green: 0.6, blue: 0.588) // #9A9996
        }
    }
}

@MainActor
struct BoardPriorityIcon: View {
    let priority: String
    var body: some View {
        Group {
            switch priority {
            case "highest": Image(systemName: "chevron.up.2").foregroundStyle(.red)
            case "high": Image(systemName: "chevron.up").foregroundStyle(.orange)
            case "low": Image(systemName: "chevron.down").foregroundStyle(.blue)
            default: Image(systemName: "equal").foregroundStyle(.yellow)
            }
        }
        .accessibilityLabel("Prioridad \((Board.priorityNames[priority] ?? "Media").lowercased())")
    }
}

@MainActor
struct BoardStatePill: View {
    let state: String
    var body: some View {
        Text(Board.stateNames[state] ?? state)
            .font(.caption2)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Capsule().fill(BoardStyle.color(state).opacity(0.2)))
            .foregroundStyle(BoardStyle.color(state))
    }
}

/// Sección del menú cuando la organización es "Kaito Kanban": ocupa el sitio de Jira y de Pendientes.
@MainActor
struct KanbanSection: View {
    @EnvironmentObject var model: AppModel
    @State private var text = ""
    static let shown = 6

    var body: some View {
        let cols = Board.columns(model.board)
        let open = ["doing", "review", "todo"].flatMap { cols[$0] ?? [] }
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                SectionHeader(title: "Kaito Kanban", count: open.count)
                Button("Abrir tablero") { BoardWindowController.shared.show() }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
            HStack(spacing: 6) {
                ForEach(Board.states, id: \.self) { s in
                    VStack(alignment: .leading, spacing: 0) {
                        Text("\(cols[s]?.count ?? 0)").font(.callout.weight(.semibold).monospacedDigit()).foregroundStyle(BoardStyle.color(s))
                        Text(Board.stateNames[s] ?? s).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.08)))
                }
            }
            if let issue = model.localRepoPick {
                RepoPicker(issue: issue)
            } else {
                TextField("Nueva tarea", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        if model.addBoardTask(text) != nil { text = "" }
                    }
                if open.isEmpty { EmptyRow(text: "Sin tareas abiertas") }
                ForEach(open.prefix(Self.shown)) { t in
                    KanbanRow(task: t)
                }
                if open.count > Self.shown {
                    EmptyRow(text: "y \(open.count - Self.shown) más en el tablero")
                }
            }
        }
    }
}

@MainActor
struct KanbanRow: View {
    @EnvironmentObject var model: AppModel
    let task: BoardTask
    @State private var hover = false

    var agent: Agent? { AgentParsing.agentsByTicket(model.agents)[task.id] }

    var body: some View {
        HStack(spacing: 6) {
            BoardPriorityIcon(priority: task.priority).font(.caption).frame(width: 14)
            Text(task.id).font(.caption.monospaced()).foregroundStyle(.secondary)
            Text(task.text).font(.callout).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            if let a = agent {
                Button {
                    model.focus(a)
                } label: {
                    Label(a.cwd ?? "?", systemImage: "terminal").font(.caption)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.teal)
                .help("Ir a la terminal de \(a.cwd ?? "agente")")
            } else {
                BoardStatePill(state: task.state)
            }
            Button {
                model.pickRepo(for: task)
            } label: {
                Image(systemName: "paperplane")
            }
            .buttonStyle(.borderless)
            .help("Mandar a Claude")
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 4)
        .background(RoundedRectangle(cornerRadius: 5).fill(hover ? Color.secondary.opacity(0.08) : .clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { BoardWindowController.shared.show(taskId: task.id) }
        .help("Abrir en el panel de Kaito")
    }
}
