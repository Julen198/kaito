import AppKit
import KaitoCore
import SwiftUI

// MARK: - Uso (una fila de columnas: anillo doble 5 h / semana por proveedor)

enum UsageColors {
    static func level(_ level: String) -> Color {
        switch level {
        case "crit": return Color(red: 0.898, green: 0.286, blue: 0.227) // #E5493A
        case "warn": return Color(red: 1.0, green: 0.639, blue: 0.282) // #FFA348
        default: return Color(red: 0.357, green: 0.784, blue: 0.686) // #5BC8AF
        }
    }

    static func tile(_ id: String) -> (bg: Color, fg: Color, symbol: String) {
        switch id {
        case "codex": return (.white, Color(white: 0.12), "hexagon")
        case "claude": return (Color(red: 0.965, green: 0.827, blue: 0.753), Color(red: 0.84, green: 0.33, blue: 0.10), "asterisk")
        default: return (Color(white: 0.12), Color(white: 0.87), "chevron.left.forwardslash.chevron.right")
        }
    }
}

/// Anillo doble: fuera 5 h (grueso), dentro semana (fino), con el logo pequeño en el centro.
@MainActor
struct UsageDoubleRing: View {
    let id: String
    let five: UsageWindowView?
    let week: UsageWindowView?

    private func ring(_ w: UsageWindowView?, size: CGFloat, line: CGFloat) -> some View {
        ZStack {
            Circle().stroke(Color.secondary.opacity(0.2), lineWidth: line)
            if let w {
                Circle()
                    .trim(from: 0, to: CGFloat(max(0, min(100, w.pct)) / 100))
                    .stroke(UsageColors.level(w.level), style: StrokeStyle(lineWidth: line, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
        }
        .frame(width: size, height: size)
    }

    var body: some View {
        let t = UsageColors.tile(id)
        ZStack {
            ring(five, size: 50, line: 5)
            ring(week, size: 37, line: 3.5)
            RoundedRectangle(cornerRadius: 5).fill(t.bg)
                .frame(width: 18, height: 18)
                .overlay(Image(systemName: t.symbol).font(.system(size: 11, weight: .semibold)).foregroundStyle(t.fg))
        }
        .frame(width: 56, height: 56)
    }
}

@MainActor
struct UsageSection: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        let now = Date().timeIntervalSince1970
        let note = Usage.resetNote(model.usage.map { (name: $0.name, view: $0.view) }, nowS: now)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Uso").font(.subheadline.weight(.semibold))
                Spacer()
                if let note { Text(note).font(.caption).foregroundStyle(.secondary) }
            }
            HStack(alignment: .top, spacing: 6) {
                ForEach(model.usage) { u in
                    let line = Usage.columnLine(u.view, nowS: now)
                    VStack(spacing: 4) {
                        UsageDoubleRing(id: u.id, five: u.view.five, week: u.view.week)
                        Text(u.name).font(.caption.weight(.semibold)).lineLimit(1)
                        Text(line.text).font(.caption2.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .frame(maxWidth: .infinity)
                    .opacity(line.stale ? 0.55 : 1)
                    .help([u.view.five?.label, u.view.week?.label, u.view.age].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n"))
                }
            }
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.06)))
        }
    }
}

// MARK: - Tareas programadas

@MainActor
struct TasksSection: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        let list = model.tasks.filter { !$0.done }
        VStack(alignment: .leading, spacing: 4) {
            SectionHeader(title: "Tareas programadas", count: list.count)
            if list.isEmpty {
                EmptyRow(text: "Sin tareas: créalas en la captura rápida (pestaña Tarea programada)")
            }
            ForEach(list) { t in
                TaskRow(task: t)
            }
        }
    }
}

@MainActor
struct TaskRow: View {
    @EnvironmentObject var model: AppModel
    let task: ScheduledTask

    var status: String {
        if model.runningTaskId == task.id { return "Ejecutando…" }
        if model.isTaskPending(task.id) { return "En cola" }
        if !task.enabled { return "Pausada" }
        return task.nextRun.map { "Próxima: \(When.nextLabel($0))" } ?? "Sin próxima ejecución"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: task.lastOk == false ? "exclamationmark.triangle" : "clock")
                .foregroundStyle(task.lastOk == false ? Color.orange : Color.secondary)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(task.name).font(.callout.weight(.semibold)).lineLimit(1)
                    if let k = task.key { Text(k).font(.caption).foregroundStyle(.secondary) }
                }
                Text("\(When.ruleLabel(task.rule)) · \(status)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if let s = task.lastSummary, !s.isEmpty {
                    Text(s).font(.caption).foregroundStyle(task.lastOk == false ? Color.orange : Color.secondary).lineLimit(2)
                }
            }
            Spacer()
            if model.runningTaskId == task.id {
                ProgressView().controlSize(.small)
            }
            Menu {
                Button("Ejecutar ahora") { model.runTaskNow(task.id) }
                    .disabled(model.isTaskPending(task.id))
                Button(task.enabled ? "Pausar" : "Reanudar") { model.toggleTask(task) }
                Button("Ver último resultado") { model.openTaskResult(task) }
                Divider()
                Button("Borrar") { model.deleteTask(task) }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
        .padding(.vertical, 2)
    }
}

// MARK: - No molestar

@MainActor
struct QuietMenu: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Menu {
            if model.quiet.quiet {
                Button("Desactivar") { model.setQuiet("off") }
                Divider()
            }
            Button("No molestar 1 h") { model.setQuiet("hour") }
            Button("Hasta mañana") { model.setQuiet("tomorrow") }
            Button("Hasta que lo desactive") { model.setQuiet("on") }
        } label: {
            Image(systemName: model.quiet.quiet ? "moon.fill" : "moon")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(model.quiet.quiet ? Quiet.quietLabel(model.quiet, now: Date()) : "No molestar")
    }
}
