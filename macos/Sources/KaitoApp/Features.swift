import AppKit
import KaitoCore
import SwiftUI

/// Uso de un proveedor listo para pintar (anillos de 5 h y semana).
struct ProviderUsage: Identifiable, Equatable {
    let id: String
    let name: String
    let view: UsageView
}

/// Tarjeta "listo", resultado de tarea, avisos retenidos, resumen del día, terminado, No molestar,
/// tareas programadas y statusLine. Port del flujo de main.js (_checkDone, _onTicketFinish, _onTaskFinish…).
@MainActor
extension AppModel {
    static let doneMessage = "Terminó, esperando tu respuesta"

    /// Cada 30 s: No molestar (y vaciado de la cola), tareas que tocan, resumen del día y uso.
    func periodic() {
        quietTick()
        taskTick()
        maybeDaily()
        refreshUsage()
    }

    // MARK: agente que termina

    /// Aviso cuando un agente pasa de trabajar a parado (o el hook dice "done").
    func checkDone(_ list: [Agent]) {
        let now = Date()
        let prev = busySince
        var next: [String: Date] = [:]
        for a in list {
            let since = prev?[a.id]
            if a.live && a.state != "done" && a.state != "needs" {
                next[a.id] = since ?? now
            } else if let since, a.state == "needs" {
                next[a.id] = since // esperando un permiso no corta la tarea
            } else if let since {
                let ms = now.timeIntervalSince(since) * 1000
                if config.autoReview, a.ticket != nil, a.cwdPath != nil {
                    onTicketFinish(a, since: since, ms: ms)
                } else if ms >= Finish.doneMinMs && config.notifyDone {
                    notifyDone(a, mins: Int((ms / 60000).rounded()))
                }
            }
        }
        busySince = next
    }

    func notifyDone(_ a: Agent, mins: Int) {
        let title = "\(a.cwd ?? "?") terminó · \(mins) min"
        if deferNotice(key: "done:\(a.id)", text: title, action: ["type": "agent", "id": .string(a.id)]) { return }
        let body = AgentParsing.firstLine(a.lastText)
        Notifier.post(title: title, body: body.isEmpty ? Self.doneMessage : body)
    }

    func issueSummary(_ key: String) -> String {
        issues.values.joined().first(where: { $0.key == key })?.summary ?? ""
    }

    /// Agente de un ticket (o tarea K-n) que deja de trabajar. Con commits nuevos: mueve a revisión, recordatorio
    /// y tarjeta "listo". Sin commits: el aviso normal si trabajó >= 3 min. Una vez por sesión y HEAD.
    func onTicketFinish(_ a: Agent, since: Date, ms: Double) {
        guard let ticket = a.ticket else { return }
        let mins = Int((ms / 60000).rounded())
        let cfg = config
        let paths = self.paths
        let sinceS = ((since.timeIntervalSince1970 * 1000 - Finish.sinceSlackMs) / 1000).rounded(.down)
        let cwdPath = a.cwdPath
        let sessionId = a.id
        Task {
            let work = await Task.detached(priority: .utility) {
                Finish.findTicketWork(cwd: cwdPath, key: ticket, sinceS: sinceS, sessionId: sessionId, roots: cfg.repoRoots, paths: paths)
            }.value
            guard let work, !work.commits.isEmpty else {
                if ms >= Finish.doneMinMs && cfg.notifyDone { notifyDone(a, mins: mins) }
                return
            }
            let key = Finish.finishKey(a.id, work.head)
            do {
                if try !Finish.markFinished(key, paths: paths) { return }
            } catch {
                NSLog("kaito: finished.json: \(error.localizedDescription)")
            }
            let local = Finish.isLocalKey(ticket)
            let localText = local ? Finish.localTask(ticket, paths: paths)?["text"]?.string : nil
            let issue: JiraIssue? = local ? nil : issues.values.joined().first(where: { $0.key == ticket })
            let jira = cfg.jiraEnabled && !local
            var moved: String? = nil
            var reason: String? = nil
            if local {
                do {
                    moved = try Finish.moveLocalTaskToReview(ticket, paths: paths)
                    if moved == nil { reason = "la tarea ya no existe en el tablero" }
                } catch {
                    reason = error.localizedDescription
                }
                refreshLocal()
            } else if !jira {
                // sin Jira: tarjeta con lo de git, sin mover nada
            } else if let issue, JiraViews.reviewRE.test(issue.status) {
                reason = "ya estaba en \(issue.status)"
            } else if let client = jiraClient() {
                do {
                    if let t = JiraViews.pickTransition(try await client.transitions(ticket), kind: "review") {
                        try await client.applyTransition(ticket, id: t.id)
                        moved = t.to.isEmpty ? t.name : t.to
                    } else {
                        reason = "no hay transición a revisión o pruebas"
                    }
                } catch {
                    reason = error.localizedDescription
                }
            } else {
                reason = jiraMessage ?? "Jira sin configurar"
            }
            var remindAt: Date? = nil
            if cfg.reviewReminderMinutes > 0 {
                let due = Date().addingTimeInterval(Double(cfg.reviewReminderMinutes) * 60)
                if (try? data.addReminder(Finish.reviewReminderText(ticket, localText ?? issue?.summary ?? ""), due: due)) != nil {
                    remindAt = due
                    refreshLocal()
                }
            }
            let summary = localText ?? issue?.summary ?? issueSummary(ticket)
            let repoNote = work.repo != cwdPath ? " · en \(baseName(work.repo) ?? work.repo)" : ""
            let meta = "\(a.cwd ?? "?")\(repoNote) · \(mins) min"
            let title = "\(ticket) listo"
            if moved != nil && jira { refreshJira(force: true) }
            if deferNotice(key: "fin:\(key)", text: "\(title) · \(meta)", action: ["type": "agent", "id": .string(a.id)]) { return }
            var buttons: [CardButton] = []
            if work.pushed, let pr = Finish.prUrl(remote: work.remote, branch: work.branch), let url = URL(string: pr) {
                buttons.append(CardButton(title: "Abrir PR") { NSWorkspace.shared.open(url) })
            }
            if a.pid != nil {
                buttons.append(CardButton(title: "Ir al agente") { AppModel.shared.focus(a) })
            }
            if jira || local {
                buttons.append(CardButton(title: "Programar revisión") {
                    CapturePanelController.shared.showTask(prefill: "\(ticket): revisa que ")
                })
            }
            if jira {
                let lastText = a.lastText
                buttons.append(CardButton(title: "Comentar en Jira") {
                    CommentPanelController.shared.draft(key: ticket, summary: summary, repo: work.repo, lastText: lastText)
                })
            }
            NSSound(named: NSSound.Name("Glass"))?.play()
            NoticePanelController.shared.show(NoticeCard(
                id: "fin:\(key)", icon: "checkmark.seal.fill", tint: .green, meta: meta, title: title,
                lines: Finish.finishLines(work: work, moved: moved, reason: reason, lastText: a.lastText, remindAt: remindAt),
                buttons: buttons))
        }
    }

    /// Ir al agente desde el menú o una tarjeta; si es de un ticket de Jira, también comentar.
    func commentOnTicket(_ a: Agent) {
        guard let t = a.ticket else { return }
        CommentPanelController.shared.draft(key: t, summary: issueSummary(t), repo: a.cwdPath, lastText: a.lastText)
    }

    // MARK: No molestar

    /// Si hay silencio, guarda el aviso en la cola (quiet-queue.json) y devuelve true.
    @discardableResult
    func deferNotice(key: String, text: String, action: JSON? = nil) -> Bool {
        let q = Quiet.isQuiet(Date(), config: config)
        quiet = q
        guard q.quiet else { return false }
        let queue = Quiet.queuePush(Quiet.readQueue(paths: paths), QueuedNotice(key: key, text: text, action: action,
                                                                                at: (Date().timeIntervalSince1970 * 1000).rounded()))
        do { try Quiet.writeQueue(queue, paths: paths) } catch { NSLog("kaito: quiet-queue.json: \(error.localizedDescription)") }
        return true
    }

    /// Recalcula; si el silencio acabó con avisos en cola, una tarjeta "Mientras no estabas".
    func quietTick() {
        let q = Quiet.isQuiet(Date(), config: config)
        if q != quiet { quiet = q }
        guard !q.quiet, Date().timeIntervalSince(launchedAt) >= 5 else { return }
        let items = Quiet.readQueue(paths: paths)
        guard !items.isEmpty else { return }
        try? Quiet.writeQueue([], paths: paths)
        let shown = 8
        var lines = items.suffix(shown).map { FinishLine(text: "• \($0.text)", warn: false) }
        if items.count > shown { lines.append(FinishLine(text: "… y \(items.count - shown) más", warn: false)) }
        NoticePanelController.shared.show(NoticeCard(
            id: "queued", icon: "moon.zzz.fill", tint: .indigo, meta: "\(items.count) \(items.count == 1 ? "aviso" : "avisos")",
            title: "Mientras no estabas", lines: lines, buttons: []))
        checkReminders()
    }

    /// 'on' | 'hour' | 'tomorrow' | 'off' (mismas claves que dnd.js).
    func setQuiet(_ mode: String) {
        let now = Date()
        let nowMs = (now.timeIntervalSince1970 * 1000).rounded()
        var patch: [String: JSON]
        switch mode {
        case "hour": patch = ["dndManual": true, "dndUntil": .number(nowMs + 3600 * 1000), "dndSkipUntil": .null]
        case "tomorrow":
            let t = Quiet.untilTomorrow(now, config.workHours)
            patch = ["dndManual": true, "dndUntil": .number((t.timeIntervalSince1970 * 1000).rounded()), "dndSkipUntil": .null]
        case "on": patch = ["dndManual": true, "dndUntil": .null, "dndSkipUntil": .null]
        default:
            // Desactivar también vale fuera de horario: se ignora el horario hasta la próxima jornada.
            let sched = Quiet.isQuiet(now, workHours: config.workHours, dndManual: false, dndUntil: nil, dndSkipUntil: nil)
            patch = ["dndManual": false, "dndUntil": .null,
                     "dndSkipUntil": sched.quiet && sched.until != nil ? .number((sched.until!.timeIntervalSince1970 * 1000).rounded()) : .null]
        }
        do { try configStore.update(patch) } catch { show("No se pudo guardar No molestar: \(error.localizedDescription)") }
        reloadConfig()
        quietTick()
        checkReminders()
    }

    // MARK: resumen del día

    func maybeDaily() {
        guard config.dailySummary, !quiet.quiet else { return }
        if config.jiraEnabled && !jiraOK { return } // con Jira caído se reintenta en el siguiente repaso
        let now = Date()
        guard Daily.shouldShow(lastDay: Daily.readLastDay(paths: paths), now: now) else { return }
        do { try Daily.writeLastDay(Daily.localDay(now), paths: paths) } catch { return }
        let lines = Daily.lines(issues: issues["mine"] ?? [], reminders: reminders, agents: agents.filter { $0.state != "open" }, now: now)
        guard !lines.isEmpty else { return }
        NoticePanelController.shared.show(NoticeCard(
            id: "daily", icon: "sun.max.fill", tint: .orange, meta: nil, title: "Buenos días. Hoy tienes:",
            lines: lines.map { FinishLine(text: "• \($0)", warn: false) }, buttons: []))
    }

    // MARK: uso

    func refreshUsage() {
        guard config.showUsage else {
            if !usage.isEmpty { usage = [] }
            return
        }
        let paths = self.paths
        let reader = codexUsage
        let wanted = config.agentProviders["codex"] != false
        Task {
            let (claude, codex) = await Task.detached(priority: .utility) {
                (Usage.readClaudeUsage(paths: paths), wanted ? reader.read() : nil)
            }.value
            let now = Date().timeIntervalSince1970
            var out: [ProviderUsage] = []
            if let v = Usage.usageView(claude, nowS: now) { out.append(ProviderUsage(id: "claude", name: "Claude", view: v)) }
            if let v = Usage.usageView(codex, nowS: now) { out.append(ProviderUsage(id: "codex", name: "Codex", view: v)) }
            if out != usage { usage = out }
        }
    }

    // MARK: statusLine de Claude (datos de uso)

    var mergeSettingsScript: String { "\(paths.installedSrc)/hooks/merge-settings.py" }

    func refreshStatusLineState() {
        statusLineState = Usage.statusLineState(JSONFile.read(paths.claudeSettings))
    }

    /// Instala o quita la statusLine de Kaito con hooks/merge-settings.py (nunca pisa otra distinta).
    func setStatusLine(install: Bool) {
        let script = mergeSettingsScript
        guard FileUtil.exists(script) else {
            show("No encuentro \(script): reinstala Kaito con install-mac.sh")
            return
        }
        statusLineBusy = true
        let argv = ["/usr/bin/python3", script, install ? "install" : "uninstall", "--statusline-only", "--apply"]
        Task {
            let r = await Task.detached(priority: .userInitiated) { Shell.run(argv, timeout: 20) }.value
            statusLineBusy = false
            refreshStatusLineState()
            if r.status == 0 || r.status == 10 {
                if install && statusLineState == "other" {
                    show("Ya tienes otra statusLine en ~/.claude/settings.json: no se toca")
                } else {
                    show(install ? "Datos de uso de Claude instalados (se ven tras la próxima respuesta de Claude)" : "Datos de uso de Claude quitados")
                }
            } else {
                let last = trimmed(r.err).components(separatedBy: "\n").last ?? ""
                show("merge-settings.py falló: \(last.isEmpty ? "código \(r.status)" : last)")
            }
        }
    }

    // MARK: tareas programadas

    func isTaskPending(_ id: String) -> Bool {
        runningTaskId == id || taskQueue.contains { $0.id == id }
    }

    func taskTick() {
        guard config.tasksEnabled else { return }
        for t in Tasks.dueTasks(taskStore.read()) { enqueueTask(t.id, manual: false) }
    }

    func runTaskNow(_ id: String) {
        if !enqueueTask(id, manual: true) { show("Esa tarea ya está en marcha") }
    }

    @discardableResult
    func enqueueTask(_ id: String, manual: Bool) -> Bool {
        guard !isTaskPending(id) else { return false }
        taskQueue.append((id, manual))
        drainTasks()
        return true
    }

    /// Una tarea cada vez. La próxima ejecución se recalcula también si falla.
    func drainTasks() {
        guard runningTaskId == nil, !taskQueue.isEmpty else { return }
        let (id, manual) = taskQueue.removeFirst()
        guard let task = taskStore.read().first(where: { $0.id == id }), manual || (task.enabled && !task.done) else {
            drainTasks()
            return
        }
        runningTaskId = id
        let cfg = config
        let client = cfg.jiraEnabled && task.key != nil ? jiraClient() : nil
        let paths = self.paths
        Task {
            let run = await TaskRunner.run(task, config: cfg, client: client, paths: paths)
            do { try taskStore.writeRun(id, run) } catch { NSLog("kaito: historial de \(id): \(error.localizedDescription)") }
            let updated = try? taskStore.patch(id) {
                Tasks.afterRun($0, finished: run.finished ?? Date(), ok: run.ok, summary: run.summary, manual: manual)
            }
            runningTaskId = nil
            refreshLocal()
            onTaskFinish(updated ?? task, run)
            drainTasks()
        }
    }

    func onTaskFinish(_ task: ScheduledTask, _ run: TaskRun) {
        let title = "Tarea «\(task.name)» · \(run.ok ? "terminada" : "falló")"
        if deferNotice(key: "task:\(task.id)", text: title, action: ["type": "task", "id": .string(task.id)]) { return }
        var buttons = [CardButton(title: "Ver completo") { AppModel.shared.openTaskResult(task, run) }]
        if let key = task.key, config.jiraEnabled {
            buttons.append(CardButton(title: "Comentar en Jira") {
                CommentPanelController.shared.prefill(key: key, text: Tasks.findingsComment(taskName: task.name, run: run))
            })
        }
        NoticePanelController.shared.show(NoticeCard(
            id: "task:\(task.id)", icon: run.ok ? "clock.badge.checkmark" : "exclamationmark.triangle.fill", tint: run.ok ? .teal : .orange,
            meta: ["Tarea programada", task.key].compactMap { $0 }.joined(separator: " · "), title: title,
            lines: run.summary.isEmpty ? [] : [FinishLine(text: run.summary, warn: !run.ok)], buttons: buttons))
    }

    func openTaskResult(_ task: ScheduledTask, _ run: TaskRun? = nil) {
        guard let r = run ?? taskStore.readLastRun(task.id) else {
            show("«\(task.name)» aún no se ha ejecutado")
            return
        }
        var parts = ["\(When.ruleLabel(task.rule)) · \(When.shortLabel(r.started))", r.ok ? "" : "Error: \(r.error ?? r.summary)", r.result]
        if !r.queries.isEmpty { parts.append("Consultas:\n" + r.queries.map { "- \($0)" }.joined(separator: "\n")) }
        if !r.denials.isEmpty { parts.append("Denegado: \(r.denials.joined(separator: ", "))") }
        TextWindowController.show(title: "Tarea «\(task.name)»", text: parts.filter { !$0.isEmpty }.joined(separator: "\n\n"))
    }

    func toggleTask(_ t: ScheduledTask) {
        do { try taskStore.patch(t.id) { Tasks.setEnabled($0, !$0.enabled) } } catch { show("No se pudo guardar: \(error.localizedDescription)") }
        refreshLocal()
    }

    func deleteTask(_ t: ScheduledTask) {
        do { try taskStore.delete(t.id) } catch { show("No se pudo borrar: \(error.localizedDescription)") }
        refreshLocal()
    }

    /// Alta desde la captura. Devuelve el texto de confirmación.
    func addTask(name: String, prompt: String, cwd: String, rule: TaskRule, tools: String, key: String?) -> String? {
        let t = Tasks.newTask(name: name, prompt: prompt, cwd: cwd, rule: rule, tools: tools, key: key)
        do { try taskStore.add(t) } catch {
            show("No se pudo guardar la tarea: \(error.localizedDescription)")
            return nil
        }
        refreshLocal()
        return t.nextRun.map { "Tarea «\(name)» · próxima \(When.nextLabel($0))" } ?? "Tarea «\(name)» guardada"
    }
}
