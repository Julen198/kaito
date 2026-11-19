import AppKit
import KaitoCore
import SwiftUI

@MainActor
struct JiraSection: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        let list = model.issues[model.jiraView] ?? []
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader(title: "Jira", count: list.count)
            if model.views.count > 1 {
                Picker("", selection: Binding(get: { model.jiraView }, set: { model.selectView($0) })) {
                    ForEach(model.views, id: \.id) { v in
                        Text(v.name).tag(v.id)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            if let issue = model.repoPickIssue {
                RepoPicker(issue: issue)
            } else {
                if let msg = model.jiraMessage { EmptyRow(text: msg) }
                if model.jiraLoading { ProgressView().controlSize(.small) }
                if list.isEmpty && model.jiraMessage == nil && !model.jiraLoading {
                    EmptyRow(text: emptyText)
                }
                ForEach(list) { i in
                    IssueRow(issue: i, view: model.jiraView)
                }
            }
        }
    }

    var emptyText: String {
        if (model.jiraView == "unassigned" || model.jiraView == "sprint") && model.issues[model.jiraView] == nil {
            return "Sin proyectos: añade jiraProjects en Ajustes"
        }
        return "Sin tickets"
    }
}

/// Flecha de prioridad (como los iconos priority-*.svg de Linux).
@MainActor
struct PriorityIcon: View {
    let priority: JiraPriority?
    var body: some View {
        switch JiraViews.priorityKind(priority) ?? "" {
        case "highest": Image(systemName: "chevron.up.2").foregroundStyle(.red)
        case "high": Image(systemName: "chevron.up").foregroundStyle(.orange)
        case "medium": Image(systemName: "equal").foregroundStyle(.yellow)
        case "low": Image(systemName: "chevron.down").foregroundStyle(.blue)
        case "lowest": Image(systemName: "chevron.down.2").foregroundStyle(.blue)
        default: Image(systemName: "circle.dotted").foregroundStyle(.secondary)
        }
    }
}

@MainActor
struct StatusPill: View {
    let issue: JiraIssue
    var color: Color {
        switch issue.category {
        case "indeterminate": return .blue
        case "done": return .green
        default: return .gray
        }
    }
    var body: some View {
        Text(issue.status)
            .font(.caption2)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.18)))
            .foregroundStyle(color)
    }
}

@MainActor
struct IssueRow: View {
    @EnvironmentObject var model: AppModel
    let issue: JiraIssue
    let view: String
    @State private var hover = false

    var agent: Agent? { AgentParsing.agentsByTicket(model.agents)[issue.key] }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                PriorityIcon(priority: issue.priority).font(.caption).frame(width: 14)
                Text(issue.key).font(.caption.monospaced()).foregroundStyle(.secondary)
                Text(issue.summary).font(.callout).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                if view == "sprint" {
                    Text(JiraViews.shortName(issue.assignee?.displayName).isEmpty ? "Sin asignar" : JiraViews.shortName(issue.assignee?.displayName))
                        .font(.caption).foregroundStyle(.secondary)
                }
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
                    StatusPill(issue: issue)
                }
                if model.canAssign(issue, view: view) {
                    Button("Asignarme") { model.assignToMe(issue) }
                        .buttonStyle(.borderless)
                        .font(.caption)
                }
                Button {
                    model.toggleTransitions(issue)
                } label: {
                    Image(systemName: model.expandedKey == issue.key ? "chevron.up" : "chevron.down")
                }
                .buttonStyle(.borderless)
                .help("Cambiar estado")
                Button {
                    model.beginRepoPick(issue)
                } label: {
                    Image(systemName: "paperplane")
                }
                .buttonStyle(.borderless)
                .help("Mandar a Claude")
            }
            .contentShape(Rectangle())
            .onTapGesture { model.openIssue(issue) }
            .help("Abrir en el navegador")
            if model.expandedKey == issue.key {
                MoveRow(issue: issue)
            }
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 4)
        .background(RoundedRectangle(cornerRadius: 5).fill(hover ? Color.secondary.opacity(0.08) : .clear))
        .onHover { hover = $0 }
    }
}

/// "Mover a": transiciones del ticket.
@MainActor
struct MoveRow: View {
    @EnvironmentObject var model: AppModel
    let issue: JiraIssue

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Mover a").font(.caption).foregroundStyle(.secondary)
            if model.transitionsLoading {
                Text("Cargando…").font(.caption).foregroundStyle(.secondary)
            } else if model.transitions.isEmpty && model.transitionNote == nil {
                Text("Sin transiciones disponibles").font(.caption).foregroundStyle(.secondary)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 6)], alignment: .leading, spacing: 6) {
                ForEach(model.transitions) { t in
                    Button(t.to.isEmpty ? t.name : t.to) { model.applyTransition(issue, t) }
                        .controlSize(.small)
                }
            }
            if let n = model.transitionNote {
                Text(n).font(.caption).foregroundStyle(.orange)
            }
        }
        .padding(.leading, 20)
    }
}

/// Elegir repo para "Mandar a Claude": sugeridos arriba, búsqueda por texto.
@MainActor
struct RepoPicker: View {
    @EnvironmentObject var model: AppModel
    let issue: JiraIssue
    @State private var query = ""
    static let choices = 8

    var body: some View {
        let filtered = JiraViews.filterRepos(model.allRepos, query: query)
        let why = Dictionary(uniqueKeysWithValues: model.repoChoices.map { ($0.path, $0.why) })
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Mandar \(issue.key) a Claude").font(.callout.weight(.semibold))
                Spacer()
                Button("Cancelar") { model.repoPickIssue = nil }
                    .buttonStyle(.borderless)
            }
            TextField("Buscar repo", text: $query)
                .textFieldStyle(.roundedBorder)
                .onSubmit {
                    if let first = filtered.first { model.sendToClaude(issue, repo: first) }
                }
            if model.repoChoices.isEmpty {
                ProgressView().controlSize(.small)
            } else if filtered.isEmpty {
                EmptyRow(text: "Ningún repo coincide")
            }
            ForEach(Array(filtered.prefix(query.isEmpty ? Self.choices : 30).enumerated()), id: \.element) { idx, path in
                Button {
                    model.sendToClaude(issue, repo: path)
                } label: {
                    HStack {
                        Image(systemName: "folder")
                        Text(baseName(path) ?? path).font(.callout)
                        Text(tilde(path)).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        if idx == 0, let w = why[path] ?? nil {
                            Text(w == "issue" ? "usado en este ticket" : w == "match" ? "coincide" : "del proyecto")
                                .font(.caption2).foregroundStyle(.teal)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.08)))
    }

    func tilde(_ p: String) -> String {
        let home = NSHomeDirectory()
        return p.hasPrefix(home) ? "~" + p.dropFirst(home.count) : p
    }
}
