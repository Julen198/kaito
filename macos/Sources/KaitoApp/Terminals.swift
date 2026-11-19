import AppKit
import KaitoCore

/// Ir a la terminal de un agente y abrir Claude en una terminal (AppleScript: necesita permiso de Automatización).
enum Terminals {
    /// Ejecuta AppleScript en el hilo principal. → (ok, resultado o error).
    @MainActor
    @discardableResult
    static func runAppleScript(_ source: String) -> (ok: Bool, result: String) {
        var err: NSDictionary?
        guard let script = NSAppleScript(source: source) else { return (false, "AppleScript no válido") }
        let out = script.executeAndReturnError(&err)
        if let err {
            let msg = err[NSAppleScript.errorMessage] as? String ?? "\(err)"
            NSLog("kaito: AppleScript: \(msg)")
            return (false, msg)
        }
        return (true, out.stringValue ?? "")
    }

    static func ppid(of pid: Int32) -> Int32? {
        Int32(trimmed(Shell.run(["/bin/ps", "-o", "ppid=", "-p", "\(pid)"], timeout: 3).out))
    }

    /// App gráfica (terminal) que aloja el proceso: el primer antecesor que sea una app normal.
    static func hostApp(for pid: Int32) -> NSRunningApplication? {
        var cur: Int32? = pid
        for _ in 0..<32 {
            guard let p = cur, p > 1 else { return nil }
            if let app = NSRunningApplication(processIdentifier: p), app.activationPolicy == .regular { return app }
            cur = ppid(of: p)
        }
        return nil
    }

    static func running(_ bundleId: String) -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
    }

    /// Enfoca la pestaña exacta en Terminal/iTerm2 (por tty); en otras terminales, activa la app.
    @MainActor
    static func focus(pid: Int32) -> Bool {
        let tty = TerminalScripts.ttyPath(Shell.run(["/bin/ps", "-o", "tty=", "-p", "\(pid)"], timeout: 3).out)
        let host = hostApp(for: pid)
        let bundle = host?.bundleIdentifier
        if let tty {
            if bundle == TerminalScripts.itermBundle || (bundle == nil && running(TerminalScripts.itermBundle) != nil) {
                if runAppleScript(TerminalScripts.focusITerm(tty: tty)).result == "ok" { return true }
            }
            if bundle == TerminalScripts.terminalBundle || (bundle == nil && running(TerminalScripts.terminalBundle) != nil) {
                if runAppleScript(TerminalScripts.focusTerminal(tty: tty)).result == "ok" { return true }
            }
        }
        if let host {
            return host.activate()
        }
        return false
    }

    /// Ejecuta un comando en una terminal visible según la preferencia (auto|terminal|iterm|warp → Terminal).
    @MainActor
    static func runInTerminal(_ command: String, preference: String) throws {
        let which = TerminalScripts.resolve(preference, itermRunning: running(TerminalScripts.itermBundle) != nil)
        let script = which == "iterm" ? TerminalScripts.runInITerm(command) : TerminalScripts.runInTerminal(command)
        let r = runAppleScript(script)
        if !r.ok { throw KaitoError.message(r.result) }
    }

    /// Abre Claude con el prompt del ticket en el repo.
    @MainActor
    static func launchClaude(key: String, repo: String, promptPath: String, preference: String) throws {
        guard repo.hasPrefix("/"), FileUtil.isDir(repo) else { throw KaitoError.message("no existe \(repo)") }
        let which = TerminalScripts.resolve(preference, itermRunning: running(TerminalScripts.itermBundle) != nil)
        if which == "warp" {
            let paths = KaitoPaths.default
            let name = "kaito-\(key).yaml"
            try FileUtil.writeText("\(paths.warpLaunchDir)/\(name)",
                                   JiraViews.warpLaunchYaml(key: key, repo: repo, promptPath: promptPath))
            guard let url = URL(string: "warp://launch/\(name)") else { throw KaitoError.message("URL de Warp no válida") }
            if !NSWorkspace.shared.open(url) { throw KaitoError.message("No se pudo abrir Warp") }
            return
        }
        try runInTerminal(TerminalScripts.claudeLaunchCommand(repo: repo, promptPath: promptPath), preference: which)
    }
}
