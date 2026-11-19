import AppKit
import KaitoCore
import SwiftUI

/// Ventana del icono de la barra de menús: Agentes, Jira, Pendientes, Recordatorios, Notas.
@MainActor
struct MenuView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    AgentsSection()
                    if model.config.jiraEnabled { JiraSection() }
                    TodosSection()
                    RemindersSection()
                    NotesSection()
                }
                .padding(12)
            }
            .frame(maxHeight: 560)
            if let f = model.flash {
                Divider()
                Text(f)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            }
            Divider()
            footer
        }
        .frame(width: 440)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Kaito").font(.headline)
            Spacer()
            if let u = model.update {
                Button {
                    model.runUpdate()
                } label: {
                    Label("Actualizar a \(u.tag)", systemImage: "arrow.down.circle")
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.tint)
            }
            Button {
                model.refreshAgents()
                model.refreshJira(force: true)
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("Actualizar")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var footer: some View {
        HStack {
            Button {
                CapturePanelController.shared.show()
            } label: {
                Label("Captura rápida", systemImage: "square.and.pencil")
            }
            .buttonStyle(.borderless)
            if let k = HotKey.labels[model.config.captureHotkey], model.config.captureHotkey != "off" {
                Text(k).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            SettingsLink {
                Image(systemName: "gearshape")
            }
            .buttonStyle(.borderless)
            .help("Ajustes")
            Button {
                NSApp.terminate(nil)
            } label: {
                Image(systemName: "power")
            }
            .buttonStyle(.borderless)
            .help("Salir de Kaito")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

/// Cabecera de sección con contador.
@MainActor
struct SectionHeader: View {
    let title: String
    let count: Int
    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.subheadline.weight(.semibold))
            Text("\(count)")
                .font(.caption.monospacedDigit())
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(Capsule().fill(Color.secondary.opacity(0.15)))
            Spacer()
        }
    }
}

@MainActor
struct EmptyRow: View {
    let text: String
    var body: some View {
        Text(text).font(.callout).foregroundStyle(.secondary).padding(.vertical, 2)
    }
}

/// Punto de estado; late mientras el agente trabaja.
@MainActor
struct StatusDot: View {
    let color: Color
    let pulsing: Bool
    @State private var on = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 9, height: 9)
            .opacity(pulsing && on ? 0.3 : 1)
            .animation(pulsing ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true) : .default, value: on)
            .onAppear { on = pulsing }
            .onChange(of: pulsing) { _, p in on = p }
    }
}

// MARK: - Agentes

@MainActor
struct AgentsSection: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader(title: "Agentes", count: model.agents.count)
            if model.agents.isEmpty {
                EmptyRow(text: "Sin agentes activos")
            }
            ForEach(model.agents) { a in
                AgentRow(agent: a)
            }
        }
    }
}

@MainActor
struct AgentRow: View {
    @EnvironmentObject var model: AppModel
    let agent: Agent
    @State private var hover = false

    var color: Color {
        switch agent.state {
        case "needs": return .orange
        case "done": return .blue
        default: return agent.live ? .green : .gray
        }
    }

    var subtitle: String {
        if agent.needsYou { return agent.message ?? "Te necesita" }
        if agent.state == "done" {
            let t = AgentParsing.firstLine(agent.lastText, 120)
            return t.isEmpty ? (agent.message ?? "Terminó") : t
        }
        return agent.lastAction ?? (agent.live ? "Trabajando…" : "Sesión abierta")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                StatusDot(color: color, pulsing: agent.live && !agent.needsYou)
                    .padding(.top, 4)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(agent.cwd ?? "?").font(.callout.weight(.semibold))
                        if agent.provider != "claude" {
                            Text(Providers.byId(agent.provider)?.name ?? agent.provider)
                                .font(.caption2)
                                .padding(.horizontal, 4)
                                .background(Capsule().stroke(Color.secondary.opacity(0.5)))
                        }
                        if let t = agent.ticket {
                            Text(t).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(AgentParsing.ago(agent.age)).font(.caption).foregroundStyle(.secondary)
                    }
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(agent.needsYou ? Color.orange : Color.secondary)
                        .lineLimit(2)
                }
                if hover {
                    Button {
                        model.dismiss(agent)
                    } label: {
                        Image(systemName: "xmark").font(.caption)
                    }
                    .buttonStyle(.borderless)
                    .help("Ocultar hasta que vuelva a tener actividad")
                }
            }
            if AgentParsing.canDecide(agent) {
                HStack {
                    if let d = agent.hook?.detail, !d.isEmpty {
                        Text(d).font(.caption.monospaced()).lineLimit(2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Denegar") { model.decide(agent, allow: false) }
                    Button("Permitir") { model.decide(agent, allow: true) }
                        .keyboardShortcut(.defaultAction)
                }
                .controlSize(.small)
                .padding(.leading, 17)
            }
        }
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 6).fill(agent.needsYou ? Color.orange.opacity(0.12) : hover ? Color.secondary.opacity(0.08) : .clear))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { model.focus(agent) }
        .help("Ir a su terminal")
    }
}

// MARK: - Pendientes

@MainActor
struct TodosSection: View {
    @EnvironmentObject var model: AppModel
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionHeader(title: "Pendientes", count: model.todoCount)
            TextField("Añadir pendiente", text: $text)
                .textFieldStyle(.roundedBorder)
                .onSubmit {
                    model.addTodo(text)
                    text = ""
                }
            let pending = model.todos.filter { !$0.done }
            if pending.isEmpty { EmptyRow(text: "Nada pendiente") }
            ForEach(pending) { t in
                HStack(spacing: 8) {
                    Button {
                        model.toggleTodo(t)
                    } label: {
                        Image(systemName: "circle")
                    }
                    .buttonStyle(.borderless)
                    .help("Hecho")
                    Text(t.text).font(.callout).lineLimit(2)
                    Spacer()
                }
            }
            if model.todos.contains(where: \.done) {
                Button("Borrar los hechos") { model.clearDoneTodos() }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
        }
    }
}

// MARK: - Recordatorios

@MainActor
struct RemindersSection: View {
    @EnvironmentObject var model: AppModel
    @State private var text = ""
    @State private var hint: String?

    var body: some View {
        let list = model.reminders.filter { !$0.done }.sorted { $0.due < $1.due }
        VStack(alignment: .leading, spacing: 4) {
            SectionHeader(title: "Recordatorios", count: list.count)
            TextField("Qué y cuándo: «llamar a Iker en 20 min»", text: $text)
                .textFieldStyle(.roundedBorder)
                .onChange(of: text) { _, v in
                    hint = trimmed(v).isEmpty ? nil : (When.parse(v)?.label ?? "Añade cuándo: «en 20 min», «a las 17:30», «mañana»")
                }
                .onSubmit {
                    if let label = model.addReminder(text) {
                        model.show("Recordatorio: \(label)")
                        text = ""
                    }
                }
            if let hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
            if list.isEmpty { EmptyRow(text: "Sin recordatorios") }
            ForEach(list) { r in
                HStack(spacing: 8) {
                    Image(systemName: "alarm").foregroundStyle(.secondary)
                    Text(When.shortLabel(r.due)).font(.caption.monospacedDigit()).foregroundStyle(r.due < Date() ? Color.orange : Color.secondary)
                    Text(r.text).font(.callout).lineLimit(2)
                    Spacer()
                    Button {
                        model.completeReminder(r.id)
                    } label: {
                        Image(systemName: "checkmark")
                    }
                    .buttonStyle(.borderless)
                    .help("Hecho")
                }
            }
        }
    }
}

// MARK: - Notas

@MainActor
struct NotesSection: View {
    @EnvironmentObject var model: AppModel
    static let shown = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionHeader(title: "Notas", count: model.notes.count)
            if model.notes.isEmpty { EmptyRow(text: "Sin notas") }
            ForEach(Array(model.notes.suffix(Self.shown).reversed())) { n in
                HStack(spacing: 8) {
                    Text(n.text).font(.callout).lineLimit(3)
                    Spacer()
                    Button {
                        model.removeNote(n)
                    } label: {
                        Image(systemName: "trash").font(.caption)
                    }
                    .buttonStyle(.borderless)
                    .help("Borrar")
                }
                .contentShape(Rectangle())
                .onTapGesture { model.copy(n.text) }
                .help("Copiar")
            }
        }
    }
}
