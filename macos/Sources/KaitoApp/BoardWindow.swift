import AppKit
import KaitoCore
import SwiftUI

// Ventana del Kaito Kanban: tablero de cuatro columnas y panel de tarea (como un ticket de Jira, pero en local).

@MainActor
final class BoardNav: ObservableObject {
    @Published var selected: String?
}

@MainActor
final class BoardWindowController {
    static let shared = BoardWindowController()
    private let nav = BoardNav()
    private var window: NSWindow?

    /// Abre el tablero (o el panel de `taskId`).
    func show(taskId: String? = nil) {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 680),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            w.title = "Kaito Kanban"
            w.isReleasedWhenClosed = false
            w.contentViewController = NSHostingController(rootView: BoardView(nav: nav).environmentObject(AppModel.shared))
            w.setContentSize(NSSize(width: 1100, height: 680))
            w.contentMinSize = NSSize(width: 760, height: 460)
            w.center()
            window = w
        }
        nav.selected = taskId
        AppModel.shared.refreshLocal()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

@MainActor
struct BoardView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var nav: BoardNav
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let issue = model.localRepoPick {
                RepoPicker(issue: issue)
            }
            if let id = nav.selected, let task = model.board.first(where: { $0.id == id }) {
                TaskPanel(task: task) { nav.selected = nil }
                    .id(task.id)
            } else {
                header
                columns
            }
        }
        .padding(16)
        .frame(minWidth: 760, minHeight: 460)
    }

    private var header: some View {
        let doing = model.board.filter { $0.state == "doing" }.count
        return HStack(spacing: 10) {
            Text("Kaito Kanban").font(.title2.weight(.bold))
            Text("\(model.board.count) tareas · \(doing) en curso").foregroundStyle(.secondary)
            Spacer()
            TextField("Nueva tarea…", text: $text)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 320)
                .onSubmit(add)
            Button("Añadir", action: add)
                .disabled(trimmed(text).isEmpty)
        }
    }

    private func add() {
        if model.addBoardTask(text) != nil { text = "" }
    }

    private var columns: some View {
        let cols = Board.columns(model.board)
        return HStack(alignment: .top, spacing: 12) {
            ForEach(Board.states, id: \.self) { s in
                BoardColumn(state: s, tasks: cols[s] ?? []) { nav.selected = $0 }
            }
        }
    }
}

@MainActor
struct BoardColumn: View {
    @EnvironmentObject var model: AppModel
    let state: String
    let tasks: [BoardTask]
    let open: (String) -> Void
    @State private var targeted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle().fill(BoardStyle.color(state)).frame(width: 9, height: 9)
                Text(Board.stateNames[state] ?? state).font(.callout.weight(.semibold))
                Text("\(tasks.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 4)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if tasks.isEmpty {
                        Text("Sin tareas").font(.callout).foregroundStyle(.secondary).padding(4)
                    }
                    ForEach(tasks) { t in
                        BoardCard(task: t, open: open)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.secondary.opacity(targeted ? 0.18 : 0.08)))
        .dropDestination(for: String.self) { ids, _ in
            let valid = ids.filter { id in Finish.isLocalKey(id) && model.board.contains { $0.id == id && $0.state != state } }
            for id in valid { model.moveBoardTask(id, to: state) }
            return !valid.isEmpty
        } isTargeted: { targeted = $0 }
    }
}

@MainActor
struct BoardCard: View {
    @EnvironmentObject var model: AppModel
    let task: BoardTask
    let open: (String) -> Void

    var agent: Agent? { AgentParsing.agentsByTicket(model.agents)[task.id] }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                BoardPriorityIcon(priority: task.priority).font(.caption).padding(.top, 3)
                Text(task.text)
                    .strikethrough(task.state == "done")
                    .foregroundStyle(task.state == "done" ? Color.secondary : Color.primary)
                    .lineLimit(3)
                Spacer(minLength: 0)
            }
            HStack(spacing: 6) {
                Text(task.id).font(.caption.monospaced()).foregroundStyle(.secondary)
                if let repo = task.repo {
                    Text(baseName(repo) ?? repo)
                        .font(.caption2)
                        .padding(.horizontal, 5)
                        .background(RoundedRectangle(cornerRadius: 4).fill(Color.secondary.opacity(0.15)))
                }
                if let a = agent {
                    Label(a.live ? "Trabajando" : "Sesión abierta", systemImage: "terminal").font(.caption2).foregroundStyle(.teal)
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
        .contentShape(Rectangle())
        .onTapGesture { open(task.id) }
        .draggable(task.id)
        .contextMenu {
            Button("Abrir") { open(task.id) }
            Menu("Mover a") {
                ForEach(Board.states.filter { $0 != task.state }, id: \.self) { s in
                    Button(Board.stateNames[s] ?? s) { model.moveBoardTask(task.id, to: s) }
                }
            }
            Button("Mandar a Claude") { model.pickRepo(for: task) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .help("Abrir \(task.id) · arrastra para cambiar de columna")
    }
}

/// Panel de una tarea: título y descripción a la izquierda; estado, prioridad, repo y acciones a la derecha.
@MainActor
struct TaskPanel: View {
    @EnvironmentObject var model: AppModel
    let task: BoardTask
    let back: () -> Void
    @State private var title = ""
    @State private var desc = ""
    @State private var confirmDelete = false

    var agent: Agent? { AgentParsing.agentsByTicket(model.agents)[task.id] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Button {
                    save()
                    back()
                } label: {
                    Label("Kaito Kanban", systemImage: "chevron.left")
                }
                .buttonStyle(.borderless)
                .keyboardShortcut(.cancelAction)
                Text(task.id).font(.callout.monospaced()).foregroundStyle(.secondary)
                Spacer()
                Text("⌘S guardar · Esc volver").font(.caption).foregroundStyle(.tertiary)
            }
            HStack(alignment: .top, spacing: 20) {
                main
                side.frame(width: 250)
            }
        }
        .onAppear {
            title = task.text
            desc = task.description
        }
        .onDisappear(perform: save)
        .confirmationDialog("¿Eliminar \(task.id)?", isPresented: $confirmDelete) {
            Button("Eliminar", role: .destructive) {
                let id = task.id
                back()
                model.deleteBoardTask(id)
            }
        } message: {
            Text("«\(task.text)» se borra del tablero. No se puede deshacer.")
        }
    }

    private var main: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Título", text: $title)
                .textFieldStyle(.plain)
                .font(.system(size: 22, weight: .bold))
                .onSubmit(save)
            Text("Descripción").font(.callout.weight(.semibold))
            TextEditor(text: $desc)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(6)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
                .frame(minHeight: 140)
            if let a = agent {
                HStack(spacing: 8) {
                    StatusDot(color: a.needsYou ? .orange : a.live ? .green : .gray, pulsing: a.live && !a.needsYou)
                    Text(a.needsYou ? "Claude te necesita" : a.live ? "Claude trabajando en \(a.cwd ?? "?")" : "Sesión abierta en \(a.cwd ?? "?")")
                    Spacer()
                    Button("Ir al agente") { model.focus(a) }
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.08)))
            }
        }
    }

    private var side: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Estado", selection: Binding(get: { task.state }, set: { model.moveBoardTask(task.id, to: $0) })) {
                ForEach(Board.states, id: \.self) { s in Text(Board.stateNames[s] ?? s).tag(s) }
            }
            Picker("Prioridad", selection: Binding(get: { task.priority }, set: { p in
                model.patchBoardTask(task.id) { $0["priority"] = .string(p) }
            })) {
                ForEach(Board.priorities, id: \.self) { p in Text(Board.priorityNames[p] ?? p).tag(p) }
            }
            LabeledContent("Repo") {
                Text(task.repo.map { baseName($0) ?? $0 } ?? "Sin elegir").foregroundStyle(task.repo == nil ? .secondary : .primary)
            }
            if task.created > 0 {
                LabeledContent("Creada") {
                    Text(Date(timeIntervalSince1970: task.created / 1000).formatted(date: .abbreviated, time: .shortened))
                }
            }
            Spacer(minLength: 0)
            Button {
                save()
                model.pickRepo(for: task)
            } label: {
                Label("Mandar \(task.id) a Claude", systemImage: "paperplane").frame(maxWidth: .infinity)
            }
            Button {
                save()
            } label: {
                Text("Guardar").frame(maxWidth: .infinity)
            }
            .keyboardShortcut("s", modifiers: .command)
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                Text("Eliminar").frame(maxWidth: .infinity)
            }
        }
    }

    /// Guarda título y descripción si cambiaron; un título vacío no se guarda.
    private func save() {
        let t = String(trimmed(title).prefix(Board.maxTitle))
        guard model.board.contains(where: { $0.id == task.id }) else { return }
        guard !t.isEmpty else {
            title = task.text
            return
        }
        if t == task.text && desc == task.description { return }
        model.patchBoardTask(task.id) { o in
            o["text"] = .string(t)
            o["description"] = .string(desc)
        }
    }
}
