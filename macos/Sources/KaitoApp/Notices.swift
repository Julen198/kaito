import AppKit
import KaitoCore
import SwiftUI

// MARK: - Tarjetas en pantalla ("listo", tarea, resumen del día, Mientras no estabas)

struct CardButton: Identifiable {
    let id = UUID()
    let title: String
    let action: () -> Void
}

struct NoticeCard: Identifiable {
    let id: String
    let icon: String
    let tint: Color
    let meta: String?
    let title: String
    let lines: [FinishLine]
    let buttons: [CardButton]
}

/// Mismo estilo que la tarjeta de recordatorios: icono, título, líneas y botones; "Entendido" la cierra.
@MainActor
struct NoticeCardView: View {
    let card: NoticeCard
    let onClose: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: card.icon).font(.title2).foregroundStyle(card.tint)
            VStack(alignment: .leading, spacing: 4) {
                if let meta = card.meta, !meta.isEmpty {
                    Text(meta).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(card.title).font(.headline).lineLimit(3)
                ForEach(Array(card.lines.enumerated()), id: \.offset) { _, l in
                    Text(l.quote ? "«\(l.text)»" : l.text)
                        .font(l.quote ? Font.callout.italic() : Font.callout)
                        .foregroundStyle(l.warn ? Color.orange : l.quote ? Color.secondary : Color.primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 6) {
                    Spacer(minLength: 0)
                    ForEach(card.buttons) { b in
                        Button(b.title) { b.action() }
                    }
                    Button("Entendido") { onClose() }
                        .keyboardShortcut(.defaultAction)
                }
                .controlSize(.small)
                .padding(.top, 4)
            }
        }
        .padding(14)
        .frame(width: 460, alignment: .leading)
    }
}

@MainActor
struct NoticeStack: View {
    let cards: [NoticeCard]
    let onClose: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(cards.enumerated()), id: \.element.id) { i, c in
                if i > 0 { Divider() }
                NoticeCardView(card: c) { onClose(c.id) }
            }
        }
    }
}

/// Panel flotante arriba a la derecha con las tarjetas (como mucho 4; la nueva arriba). Sin robar el foco.
@MainActor
final class NoticePanelController {
    static let shared = NoticePanelController()
    static let maxCards = 4
    private var panel: KeyPanel?
    private(set) var cards: [NoticeCard] = []

    func show(_ card: NoticeCard) {
        cards.removeAll { $0.id == card.id }
        cards.insert(card, at: 0)
        if cards.count > Self.maxCards { cards.removeLast(cards.count - Self.maxCards) }
        render()
    }

    func dismiss(_ id: String) {
        cards.removeAll { $0.id == id }
        render()
    }

    private func render() {
        if cards.isEmpty {
            panel?.orderOut(nil)
            return
        }
        if panel == nil {
            let p = makePanel(width: 460)
            p.level = .statusBar
            p.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
            panel = p
        }
        guard let p = panel else { return }
        let host = NSHostingView(rootView: NoticeStack(cards: cards) { id in NoticePanelController.shared.dismiss(id) })
        p.contentView = host
        p.setContentSize(host.fittingSize)
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            p.setFrameTopLeftPoint(NSPoint(x: f.maxX - p.frame.width - 12, y: f.maxY - 12))
        }
        p.orderFrontRegardless()
    }
}

// MARK: - "Ver completo"

@MainActor
enum TextWindowController {
    private static var windows: [NSWindow] = []

    static func show(title: String, text: String) {
        let view = ScrollView {
            Text(text)
                .font(.body)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
        }
        .frame(minWidth: 520, idealWidth: 640, minHeight: 360, idealHeight: 480)
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 480),
                         styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        w.title = title
        w.isReleasedWhenClosed = false
        w.contentViewController = NSHostingController(rootView: view)
        w.setContentSize(NSSize(width: 640, height: 480))
        w.center()
        windows.removeAll { !$0.isVisible }
        windows.append(w)
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
    }
}

// MARK: - Comentar en Jira (borrador con Claude, editable, publicar a mano)

@MainActor
final class CommentModel: ObservableObject {
    @Published var key = ""
    @Published var text = ""
    @Published var drafting = false
    @Published var posting = false
    @Published var elapsed = 0
    @Published var error: String?
    var onClose: (() -> Void)?
    private var gen = 0
    private var tick: Timer?

    private func stopTick() {
        tick?.invalidate()
        tick = nil
    }

    func prefill(key: String, text: String) {
        gen += 1
        stopTick()
        self.key = key
        self.text = text
        drafting = false
        posting = false
        error = nil
    }

    /// Borrador con `claude -p` a partir del git del repo y el último mensaje del agente (como jiradraft.js).
    func draft(key: String, summary: String, repo: String?, lastText: String?) {
        prefill(key: key, text: "")
        drafting = true
        elapsed = 0
        let g = gen
        tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            Task { @MainActor in CommentPanelController.shared.model.elapsed += 1 }
        }
        let bin = AppModel.shared.config.claudeBin
        Task {
            let git = await Task.detached(priority: .userInitiated) { JiraDraft.gitContext(repo) }.value
            let ctx = JiraDraft.CommentContext(key: key, summary: summary, lastText: lastText, branch: git.branch, log: git.log, diffstat: git.diffstat)
            do {
                let t = try await ClaudeCLI.draftComment(ctx, claudeBin: bin)
                guard g == gen else { return }
                text = t
            } catch {
                guard g == gen else { return }
                self.error = error.localizedDescription
            }
            stopTick()
            drafting = false
        }
    }

    func publish() {
        let body = trimmed(text)
        guard !body.isEmpty, !drafting, !posting else { return }
        guard let client = AppModel.shared.jiraClient() else {
            error = AppModel.shared.jiraMessage
            return
        }
        posting = true
        error = nil
        let k = key
        Task {
            do {
                try await client.postComment(k, text: body)
                AppModel.shared.show("Comentario publicado en \(k)")
                posting = false
                onClose?()
            } catch {
                posting = false
                self.error = "No se pudo publicar: \(error.localizedDescription)"
            }
        }
    }

    func cancel() {
        gen += 1
        stopTick()
        drafting = false
        onClose?()
    }
}

@MainActor
struct CommentView: View {
    @ObservedObject var model: CommentModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Comentario para \(model.key)").font(.headline)
            if model.drafting {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Redactando con Claude… \(model.elapsed) s").foregroundStyle(.secondary)
                }
                .font(.callout)
            }
            TextEditor(text: $model.text)
                .font(.callout)
                .frame(height: 240)
                .scrollContentBackground(.hidden)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.08)))
                .disabled(model.drafting || model.posting)
            if let e = model.error {
                Text(e).font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Text("Revisa el texto: no se publica nada hasta que pulses Publicar.").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Cancelar") { model.cancel() }
                if model.posting { ProgressView().controlSize(.small) }
                Button("Publicar en Jira") { model.publish() }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(model.drafting || model.posting || trimmed(model.text).isEmpty)
            }
        }
        .padding(16)
        .frame(width: 600)
        .onExitCommand { model.cancel() }
    }
}

@MainActor
final class CommentPanelController {
    static let shared = CommentPanelController()
    let model = CommentModel()
    private var panel: KeyPanel?

    func draft(key: String, summary: String, repo: String?, lastText: String?) {
        open()
        model.draft(key: key, summary: summary, repo: repo, lastText: lastText)
    }

    func prefill(key: String, text: String) {
        open()
        model.prefill(key: key, text: text)
    }

    private func open() {
        if panel == nil {
            let p = makePanel(width: 600)
            let hc = NSHostingController(rootView: CommentView(model: model))
            hc.sizingOptions = [.preferredContentSize]
            p.contentViewController = hc
            p.onCancel = { [weak self] in self?.model.cancel() }
            model.onClose = { [weak self] in self?.panel?.orderOut(nil) }
            panel = p
        }
        guard let p = panel else { return }
        if let screen = activeScreen() {
            let f = screen.visibleFrame
            p.setFrameTopLeftPoint(NSPoint(x: f.midX - p.frame.width / 2, y: f.maxY - 110))
        }
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
    }
}
