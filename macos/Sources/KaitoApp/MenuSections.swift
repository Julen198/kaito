import AppKit
import KaitoCore
import SwiftUI

// MARK: - Uso (anillos de 5 h y semana por proveedor)

@MainActor
struct UsageRing: View {
    let window: UsageWindowView
    let caption: String

    static func color(_ level: String) -> Color {
        switch level {
        case "crit": return Color(red: 0.898, green: 0.286, blue: 0.227) // #E5493A
        case "warn": return Color(red: 1.0, green: 0.639, blue: 0.282) // #FFA348
        default: return Color(red: 0.357, green: 0.784, blue: 0.686) // #5BC8AF
        }
    }

    /// "5 h 42% · se reinicia 14:30" → "se reinicia 14:30".
    var detail: String {
        window.label.components(separatedBy: " · ").dropFirst().joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                Circle().stroke(Color.secondary.opacity(0.2), lineWidth: 5)
                Circle()
                    .trim(from: 0, to: CGFloat(max(0, min(100, window.pct)) / 100))
                    .stroke(Self.color(window.level), style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text("\(Int(window.pct.rounded()))%")
                    .font(.system(size: 10, weight: .semibold).monospacedDigit())
            }
            .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 1) {
                Text(caption).font(.caption.weight(.semibold))
                Text(detail.isEmpty ? " " : detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .help(window.label)
    }
}

@MainActor
struct UsageSection: View {
    @EnvironmentObject var model: AppModel

    static func badgeColor(_ id: String) -> Color {
        id == "codex" ? Color(red: 0.30, green: 0.45, blue: 0.95) : Color(red: 0.85, green: 0.47, blue: 0.34)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Uso").font(.subheadline.weight(.semibold))
                Spacer()
            }
            ForEach(model.usage) { u in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(u.name)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Self.badgeColor(u.id)))
                        Spacer()
                        if !u.view.age.isEmpty {
                            Text(u.view.age).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    HStack(spacing: 16) {
                        if let five = u.view.five { UsageRing(window: five, caption: "5 h") }
                        if let week = u.view.week { UsageRing(window: week, caption: "Semana") }
                        Spacer(minLength: 0)
                    }
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.06)))
            }
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
                EmptyRow(text: "Sin tareas: créalas en la captura rápida (pestaña Tarea)")
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
