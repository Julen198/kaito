import AppKit
import KaitoCore
import SwiftUI

@main
@MainActor
struct KaitoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            MenuView()
                .environmentObject(model)
        } label: {
            MenuBarLabel(model: model)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environmentObject(model)
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            NSApp.setActivationPolicy(.accessory) // sin icono en el Dock (además de LSUIElement)
            AppModel.shared.start()
        }
    }
}

/// Icono y contadores de la barra de menús: agentes (trabajando o que te necesitan) · Jira · pendientes.
@MainActor
struct MenuBarLabel: View {
    @ObservedObject var model: AppModel

    var body: some View {
        let needs = model.needsCount
        let agentIcon = needs > 0 ? "exclamationmark.bubble.fill" : model.workingCount > 0 ? "sparkles" : "sparkle"
        let agentNum = needs > 0 ? needs : model.workingCount
        if model.config.jiraEnabled {
            Text("\(Image(systemName: agentIcon)) \(agentNum)  \(Image(systemName: "ticket")) \(model.jiraCount)  \(Image(systemName: "checklist")) \(model.todoCount)")
        } else {
            Text("\(Image(systemName: agentIcon)) \(agentNum)  \(Image(systemName: "checklist")) \(model.todoCount)")
        }
    }
}
