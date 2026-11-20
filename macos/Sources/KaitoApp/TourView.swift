import AppKit
import KaitoCore
import SwiftUI

/// Estado del tour de bienvenida dentro del popover.
@MainActor
final class TourController: ObservableObject {
    @Published var welcome = false
    @Published var index: Int? = nil
    private(set) var steps: [TourStep] = []

    var current: TourStep? {
        guard let i = index, steps.indices.contains(i) else { return nil }
        return steps[i]
    }
    var active: Bool { welcome || current != nil }
    /// Zona resaltada (id del ancla), o nil si no hay paso en curso.
    var anchor: String? { current.map { Tour.anchor($0.id) } }

    /// Al abrir el popover: si aún no se vio el tour, ofrece la tarjeta de bienvenida.
    func checkStart(_ model: AppModel) {
        if !active && Tour.shouldStart(model.config) { welcome = true }
    }

    func begin(_ model: AppModel) {
        steps = Tour.steps(jira: model.config.jiraEnabled,
                           usage: model.config.showUsage && !model.usage.isEmpty,
                           tasks: model.config.tasksEnabled)
        welcome = false
        index = steps.isEmpty ? nil : 0
        if steps.isEmpty { finish(model) }
    }

    func next(_ model: AppModel) {
        guard let i = index else { return }
        if i + 1 >= steps.count { finish(model) } else { index = i + 1 }
    }

    func back() {
        if let i = index, i > 0 { index = i - 1 }
    }

    /// Terminar, saltar o "Ahora no": marca el tour como visto.
    func finish(_ model: AppModel) {
        welcome = false
        index = nil
        try? model.configStore.update(["tourDone": .bool(true)])
        model.reloadConfig()
        model.show(Tour.doneMessage)
    }
}

/// Atenúa las demás zonas y marca con un contorno la del paso actual.
struct TourHighlight: ViewModifier {
    let anchor: String
    @ObservedObject var tour: TourController

    func body(content: Content) -> some View {
        let current = tour.anchor
        content
            .opacity(current == nil || current == anchor ? 1 : 0.25)
            .overlay {
                if current == anchor {
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color(red: 0.47, green: 0.68, blue: 0.93), lineWidth: 2)
                        .padding(-4)
                        .allowsHitTesting(false)
                }
            }
            .id(anchor)
    }
}

extension View {
    func tourZone(_ anchor: String, _ tour: TourController) -> some View {
        modifier(TourHighlight(anchor: anchor, tour: tour))
    }
}

private func toneColor(_ tone: String) -> Color {
    switch tone {
    case "green": return Color(red: 0.34, green: 0.89, blue: 0.54)
    case "orange": return Color(red: 1.0, green: 0.64, blue: 0.28)
    case "purple": return Color(red: 0.75, green: 0.50, blue: 0.95)
    default: return Color(red: 0.47, green: 0.68, blue: 0.93)
    }
}

/// Tarjeta fija bajo la lista: bienvenida o paso N de M.
@MainActor
struct TourCard: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var tour: TourController

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if tour.welcome {
                Text(Tour.welcomeTitle).font(.headline)
                Text(Tour.welcomeText).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    Button("Ahora no") { tour.finish(model) }
                    Button("Ver el tour") { tour.begin(model) }
                        .keyboardShortcut(.defaultAction)
                }
            } else if let step = tour.current, let i = tour.index {
                Text("Paso \(i + 1) de \(tour.steps.count)").font(.caption).foregroundStyle(.secondary)
                Text(step.title).font(.headline)
                Text(step.text).font(.callout).fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(step.bullets.enumerated()), id: \.offset) { _, b in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Circle().fill(toneColor(b.tone)).frame(width: 6, height: 6)
                            (Text(b.bold).fontWeight(.semibold) + Text(" " + b.text))
                                .font(.caption)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                HStack(spacing: 8) {
                    HStack(spacing: 4) {
                        ForEach(0..<tour.steps.count, id: \.self) { n in
                            Circle().fill(n <= i ? Color.accentColor : Color.secondary.opacity(0.3)).frame(width: 6, height: 6)
                        }
                    }
                    Spacer()
                    Button("Saltar") { tour.finish(model) }.buttonStyle(.borderless)
                    if i > 0 { Button("Atrás") { tour.back() } }
                    Button(i + 1 == tour.steps.count ? "Terminar" : "Siguiente") { tour.next(model) }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.accentColor.opacity(0.5), lineWidth: 1))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}
