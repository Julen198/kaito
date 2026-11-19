import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Ejecución de procesos (sin shell) y sondas de procesos con ps/lsof (macOS; también funcionan en Linux).
public enum Shell {
    /// Ejecuta argv y devuelve (código, stdout, stderr). Bloqueante: no llamar desde el hilo principal con comandos lentos.
    @discardableResult
    public static func run(_ argv: [String], stdin: String? = nil, cwd: String? = nil, env: [String: String]? = nil,
                           timeout: TimeInterval? = nil) -> (status: Int32, out: String, err: String, timedOut: Bool) {
        guard let exe = argv.first else { return (-1, "", "sin comando", false) }
        let p = Process()
        if exe.hasPrefix("/") {
            p.executableURL = URL(fileURLWithPath: exe)
            p.arguments = Array(argv.dropFirst())
        } else {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            p.arguments = argv
        }
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        if let env { p.environment = env }
        let outPipe = Pipe(), errPipe = Pipe(), inPipe = Pipe()
        p.standardOutput = outPipe
        p.standardError = errPipe
        p.standardInput = stdin == nil ? FileHandle.nullDevice : inPipe
        do {
            try p.run()
        } catch {
            return (-1, "", error.localizedDescription, false)
        }
        // Lectores en paralelo para que no se bloquee con salidas grandes.
        final class Box: @unchecked Sendable { var data = Data() }
        let outBox = Box(), errBox = Box()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            outBox.data = outPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        DispatchQueue.global().async {
            errBox.data = errPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        if let stdin {
            DispatchQueue.global().async {
                inPipe.fileHandleForWriting.write(stdin.data(using: .utf8) ?? Data())
                try? inPipe.fileHandleForWriting.close()
            }
        }
        var timedOut = false
        if let timeout {
            let deadline = Date().addingTimeInterval(timeout)
            while p.isRunning && Date() < deadline { usleep(50_000) }
            if p.isRunning {
                timedOut = true
                p.terminate()
                usleep(300_000)
                if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            }
        }
        p.waitUntilExit()
        group.wait()
        return (p.terminationStatus, String(decoding: outBox.data, as: UTF8.self), String(decoding: errBox.data, as: UTF8.self), timedOut)
    }

    /// Busca un ejecutable en las carpetas dadas.
    public static func which(_ name: String, dirs: [String]) -> String? {
        for d in dirs {
            let p = "\(d)/\(name)"
            if FileUtil.isExecutable(p) { return p }
        }
        return nil
    }

    /// PATH útil para apps gráficas de macOS (que no heredan el de la shell).
    public static func searchDirs(home: String, envPath: String? = ProcessInfo.processInfo.environment["PATH"]) -> [String] {
        var nvm: [String] = []
        let nvmRoot = "\(home)/.nvm/versions/node"
        for v in FileUtil.list(nvmRoot).sorted().reversed() { nvm.append("\(nvmRoot)/\(v)/bin") }
        let dirs = (envPath ?? "").split(separator: ":").map(String.init) + [
            "\(home)/.local/bin", "\(home)/.claude/local", "\(home)/.npm-global/bin", "\(home)/.bun/bin", "\(home)/.opencode/bin",
            "\(home)/.cargo/bin", "\(home)/.volta/bin"] + nvm + ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
        var seen = Set<String>()
        return dirs.filter { $0.hasPrefix("/") && seen.insert($0).inserted }
    }
}

public struct PsEntry: Equatable, Sendable {
    public var pid: Int32
    public var ppid: Int32
    public var elapsedS: Int
    public var argv: [String]
}

/// Sondas de procesos. Por defecto `ps`/`lsof`; inyectable en pruebas.
public protocol ProcessProbe {
    func list() -> [PsEntry]
    func cwd(of pid: Int32) -> String?
    func openFiles(of pid: Int32) -> [String]
}

public struct PsProbe: ProcessProbe {
    public init() {}

    /// "[[dd-]hh:]mm:ss" → segundos.
    public static func parseEtime(_ s: String) -> Int {
        var days = 0
        var rest = Substring(s)
        if let dash = rest.firstIndex(of: "-") {
            days = Int(rest[..<dash]) ?? 0
            rest = rest[rest.index(after: dash)...]
        }
        let parts = rest.split(separator: ":").map { Int($0) ?? 0 }
        var secs = 0
        for p in parts { secs = secs * 60 + p }
        return days * 86400 + secs
    }

    /// Salida de `ps -axww -o pid=,ppid=,etime=,args=` → entradas.
    public static func parse(_ out: String) -> [PsEntry] {
        out.split(separator: "\n").compactMap { line in
            let f = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
            guard f.count == 4, let pid = Int32(f[0]), let ppid = Int32(f[1]) else { return nil }
            return PsEntry(pid: pid, ppid: ppid, elapsedS: parseEtime(String(f[2])),
                           argv: f[3].split(separator: " ").map(String.init))
        }
    }

    /// Salida de `lsof -Fn` → rutas (líneas "n/ruta").
    public static func parseLsofNames(_ out: String) -> [String] {
        out.split(separator: "\n").compactMap { $0.hasPrefix("n/") ? String($0.dropFirst()) : nil }
    }

    public func list() -> [PsEntry] {
        Self.parse(Shell.run(["/bin/ps", "-axww", "-o", "pid=,ppid=,etime=,args="], timeout: 5).out)
    }

    public func cwd(of pid: Int32) -> String? {
        let lsof = FileUtil.isExecutable("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "/usr/bin/lsof"
        return Self.parseLsofNames(Shell.run([lsof, "-a", "-p", "\(pid)", "-d", "cwd", "-Fn"], timeout: 5).out).first
    }

    public func openFiles(of pid: Int32) -> [String] {
        let lsof = FileUtil.isExecutable("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "/usr/bin/lsof"
        return Self.parseLsofNames(Shell.run([lsof, "-p", "\(pid)", "-Fn"], timeout: 5).out)
    }
}

/// Agentes que no son Claude (Codex y procesos de otros proveedores), como collectOtherAgents de common.js.
public final class OtherAgents: @unchecked Sendable {
    public let paths: KaitoPaths
    public let probe: ProcessProbe
    private var metaCache: [String: Providers.RolloutMeta] = [:]

    public init(paths: KaitoPaths = .default, probe: ProcessProbe = PsProbe()) {
        self.paths = paths
        self.probe = probe
    }

    public func scan(providers: Set<String>, now: Date = Date()) -> [Providers.Proc] {
        guard !providers.isEmpty else { return [] }
        var found: [Providers.Proc] = []
        for e in probe.list() {
            guard let prov = Providers.matchAgentProcess(e.argv), providers.contains(prov) else { continue }
            guard let cwd = probe.cwd(of: e.pid) else { continue } // de otro usuario
            found.append(Providers.Proc(pid: e.pid, ppid: e.ppid, provider: prov, cwd: cwd,
                                        startMs: (now.timeIntervalSince1970 - Double(e.elapsedS)) * 1000))
        }
        return Providers.dedupe(found)
    }

    func meta(_ path: String) -> Providers.RolloutMeta? {
        if let m = metaCache[path] { return m }
        guard let head = FileUtil.readHead(path), let m = Providers.parseRolloutMeta(head) else { return nil }
        if metaCache.count > 200 { metaCache.removeAll() }
        metaCache[path] = m
        return m
    }

    func rollout(for p: Providers.Proc, rollouts: [Providers.RolloutFile]) -> String? {
        let prefix = paths.codexSessions + "/"
        if let fd = probe.openFiles(of: p.pid).first(where: { $0.hasPrefix(prefix) && $0.hasSuffix(".jsonl") && ($0 as NSString).lastPathComponent.hasPrefix("rollout-") }) {
            return fd
        }
        for f in rollouts {
            if let s = p.startMs, f.mtime * 1000 < s - 5000 { break }
            if meta(f.path)?.cwd == p.cwd { return f.path }
        }
        return nil
    }

    public func collect(providers: Set<String>, states: [String: HookState], liveS: Int = 60, now: Date = Date()) -> [Agent] {
        let procs = scan(providers: providers, now: now)
        guard !procs.isEmpty else { return [] }
        let nowMs = now.timeIntervalSince1970 * 1000
        var rollouts = procs.contains { $0.provider == "codex" } ? Providers.recentRollouts(root: paths.codexSessions) : []
        return procs.map { p in
            var a = Agent(id: "\(p.provider)-pid\(p.pid)")
            a.provider = p.provider
            a.pid = p.pid
            a.cwd = baseName(p.cwd)
            a.cwdPath = p.cwd
            a.age = p.startMs.map { max(0, Int((nowMs - $0) / 1000)) } ?? 0
            a.state = "open"
            a.activityMs = p.startMs ?? 0
            guard p.provider == "codex" else { return a }
            guard let path = rollout(for: p, rollouts: rollouts) else {
                a.state = "idle"
                return a
            }
            rollouts.removeAll { $0.path == path }
            let mtimeMs = (FileUtil.mtime(path) ?? 0) * 1000
            let tail = Providers.parseCodexTail(FileUtil.readTail(path, bytes: 256 * 1024).map { t in
                // La primera línea puede venir cortada.
                t.firstIndex(of: "\n").map { String(t[t.index(after: $0)...]) } ?? t
            } ?? "")
            let sid = Providers.rolloutId(path) ?? meta(path)?.id ?? "pid\(p.pid)"
            let hook = states["codex-\(sid)"] ?? states.first { $0.key.hasPrefix("codex-cwd-") && $0.value.cwd == p.cwd }?.value
            let st = Providers.codexStatus(tail: tail, mtimeMs: mtimeMs, nowMs: nowMs, liveS: Double(liveS), hook: hook)
            a.id = "codex-\(sid)"
            a.live = st.live
            a.state = st.state
            a.lastAction = tail.lastAction
            a.lastText = tail.lastText ?? (st.state == "done" ? hook?.message : nil)
            a.age = max(0, Int((nowMs - mtimeMs) / 1000))
            a.activityMs = max(mtimeMs, a.activityMs)
            return a
        }
    }
}
