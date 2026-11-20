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
        let moon = model.quiet.quiet ? Text("  \(Image(systemName: "moon.fill"))") : Text("")
        let agentIcon = needs > 0 ? "exclamationmark.bubble.fill" : model.workingCount > 0 ? "sparkles" : "sparkle"
        let agentNum = needs > 0 ? needs : model.workingCount
        let text = model.config.jiraEnabled
            ? Text("\(Image(systemName: agentIcon)) \(agentNum)  \(Image(systemName: "ticket")) \(model.jiraCount)  \(Image(systemName: "checklist")) \(model.todoCount)") + moon
            : Text("\(Image(systemName: agentIcon)) \(agentNum)  \(Image(systemName: "checklist")) \(model.todoCount)") + moon
        // La barra de menús descarta los símbolos intercalados en un Text (se veía «0 0 0»):
        // se dibuja a una imagen plantilla, que sí respeta.
        if let image = Self.render(text) {
            Image(nsImage: image)
        } else {
            text
        }
    }

    static func render(_ text: Text) -> NSImage? {
        let renderer = ImageRenderer(content: text.font(.system(size: 13, weight: .medium)))
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2
        let image = renderer.nsImage
        image?.isTemplate = true
        return image
    }
}
