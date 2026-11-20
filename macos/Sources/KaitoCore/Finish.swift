import Foundation

/// Commit de `git log --format=%h %s`.
public struct Commit: Equatable, Sendable {
    public var sha: String
    public var subject: String
    public init(sha: String, subject: String) { self.sha = sha; self.subject = subject }
}

/// Estado git del trabajo de un agente (detectWork de finish.js) y el repo donde se encontró.
public struct Work: Equatable, Sendable {
    public var repo: String
    public var head: String
    public var branch: String?
    public var commits: [Commit]
    public var upstream: String?
    public var pushed: Bool
    public var remote: String?
    public var ts: Double

    public init(repo: String, head: String, branch: String?, commits: [Commit], upstream: String?, pushed: Bool, remote: String?, ts: Double) {
        self.repo = repo; self.head = head; self.branch = branch; self.commits = commits
        self.upstream = upstream; self.pushed = pushed; self.remote = remote; self.ts = ts
    }
}

/// Línea de la tarjeta "listo" (warn = naranja; quote = cita del último mensaje).
public struct FinishLine: Equatable, Sendable, Hashable {
    public var text: String
    public var warn: Bool
    public var quote: Bool
    public init(text: String, warn: Bool, quote: Bool = false) { self.text = text; self.warn = warn; self.quote = quote }
}

/// Rama de un ticket encontrada con `Finish.findTicketBranches`: local, remota (seguimiento, sin red) o ambas.
public struct TicketBranch: Equatable, Sendable {
    public var repo: String
    public var branch: String
    public var local: Bool
    public var remote: Bool
    public var ts: Double
    public var upstream: String?
    public init(repo: String = "", branch: String, local: Bool, remote: Bool, ts: Double, upstream: String? = nil) {
        self.repo = repo; self.branch = branch; self.local = local; self.remote = remote; self.ts = ts; self.upstream = upstream
    }
}

/// Ejecuta git con argv (sin shell) y tiempo máximo. Devuelve stdout recortado o nil si falla.
public enum Git {
    public static let timeout: TimeInterval = 10

    public static var bin: String {
        Shell.which("git", dirs: ["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin", "/bin"]) ?? "/usr/bin/git"
    }

    public static func run(_ repo: String, _ args: [String], timeout: TimeInterval = timeout) -> String? {
        var env = ProcessInfo.processInfo.environment
        env["GIT_TERMINAL_PROMPT"] = "0"
        env["GIT_OPTIONAL_LOCKS"] = "0"
        let r = Shell.run([bin, "-C", repo] + args, env: env, timeout: timeout)
        guard r.status == 0, !r.timedOut else { return nil }
        return trimmed(r.out)
    }
}

/// Port de finish.js: ¿ha dejado commits el agente de un ticket? ¿está subida la rama?
public enum Finish {
    static let maxAgeMs: Double = 7 * 24 * 3600 * 1000
    static let logMax = 50
    static let protected: Set<String> = ["main", "master", "develop"]
    public static let doneMinMs: Double = 3 * 60 * 1000 // aviso de "terminó" solo tras trabajar al menos esto
    public static let sinceSlackMs: Double = 60 * 1000 // el inicio de "trabajando" se detecta con retraso
    static let transcriptMax = 2 * 1024 * 1024
    static let reposMax = 40
    static let transcriptReposMax = 8

    static let remoteURLRE = Regex("^(?:ssh|git\\+ssh|git|https?)://(?:[^@/]+@)?([^/:]+)(?::\\d*)?/(.+?)(?:\\.git)?/*$", caseInsensitive: true)
    static let remoteScpRE = Regex("^(?:[^@/:]+@)?([^/:]+):(?!/)/?(.+?)(?:\\.git)?/*$")

    /// URL de un remoto → (host, path) sin credenciales, puerto ni .git; nil si no es remoto web.
    public static func parseRemote(_ url: String?) -> (host: String, path: String)? {
        let s = trimmed(url ?? "")
        guard let m = remoteURLRE.firstMatch(s) ?? remoteScpRE.firstMatch(s), let host = m[1], let p = m[2] else { return nil }
        let path = p.split(separator: "/").map(String.init)
        if path.count < 2 || path.contains(where: { $0 == "." || $0 == ".." }) { return nil }
        return (host.lowercased(), path.joined(separator: "/"))
    }

    static func forge(_ host: String) -> (kind: String, web: String)? {
        for (kind, saas) in [("github", "github.com"), ("gitlab", "gitlab.com"), ("bitbucket", "bitbucket.org")] {
            if host == saas || host.hasPrefix("\(saas)-") || host.hasPrefix("\(saas)_") { return (kind, saas) }
            if host.split(separator: ".", omittingEmptySubsequences: false).contains(where: { $0 == kind || $0.hasPrefix("\(kind)-") }) {
                return (kind, host)
            }
        }
        return nil
    }

    /// URL para abrir una PR/MR de `branch` (GitHub, GitLab, Bitbucket); nil si no aplica.
    public static func prUrl(remote: String?, branch: String?) -> String? {
        guard let r = parseRemote(remote), let f = forge(r.host), let branch, !branch.isEmpty, branch != "HEAD",
              !protected.contains(branch) else { return nil }
        let base = "https://\(f.web)/\(r.path)"
        let q = JiraClient.encode(branch)
        switch f.kind {
        case "github": return "\(base)/pull/new/\(branch.split(separator: "/", omittingEmptySubsequences: false).map { JiraClient.encode(String($0)) }.joined(separator: "/"))"
        case "gitlab": return "\(base)/-/merge_requests/new?merge_request%5Bsource_branch%5D=\(q)"
        default: return "\(base)/pull-requests/new?source=\(q)&t=1"
        }
    }

    static let shaRE = Regex("^[0-9a-f]{4,40}$")

    public static func parseLog(_ text: String?) -> [Commit] {
        (text ?? "").components(separatedBy: "\n").map(trimmed).filter { !$0.isEmpty }.map { l -> Commit in
            guard let i = l.firstIndex(of: " ") else { return Commit(sha: l, subject: "") }
            return Commit(sha: String(l[..<i]), subject: trimmed(String(l[l.index(after: i)...])))
        }.filter { shaRE.test($0.sha) }
    }

    public static func finishKey(_ sessionId: String, _ head: String) -> String { "\(sessionId):\(head)" }

    /// ¿Primera vez que vemos `key`? → (fresh, mapa con la clave y sin entradas de más de 7 días).
    public static func markOnce(_ map: [String: Double], key: String, nowMs: Double) -> (fresh: Bool, map: [String: Double]) {
        var next = map.filter { $0.value.isFinite && nowMs - $0.value < maxAgeMs }
        let fresh = next[key] == nil
        if fresh { next[key] = nowMs }
        return (fresh, next)
    }

    /// Anota la clave en ~/.cache/kaito/finished.json; true si no estaba (hay que avisar).
    public static func markFinished(_ key: String, paths: KaitoPaths = .default, nowMs: Double = Date().timeIntervalSince1970 * 1000) throws -> Bool {
        let prev = (JSONFile.read(paths.finishedPath)?.object ?? [:]).compactMapValues { $0.number }
        let r = markOnce(prev, key: key, nowMs: nowMs)
        if r.fresh { try JSONFile.write(paths.finishedPath, .object(r.map.mapValues { .number($0) }), pretty: false) }
        return r.fresh
    }

    public static func finishLines(work: Work, moved: String?, reason: String?, lastText: String?, remindAt: Date?,
                                   calendar cal: Calendar = .current) -> [FinishLine] {
        var lines: [FinishLine] = []
        let n = work.commits.count
        lines.append(FinishLine(text: "Rama \(work.branch ?? "(sin rama)") · \(work.pushed ? "subida" : "sin subir")", warn: !work.pushed))
        if n > 0 { lines.append(FinishLine(text: "\(n) \(n == 1 ? "commit nuevo" : "commits nuevos") · \(work.commits[0].subject)", warn: false)) }
        lines.append(moved.map { FinishLine(text: "Movido a \($0)", warn: false) }
            ?? FinishLine(text: "No se ha movido: \(reason ?? "sin transición de revisión")", warn: true))
        if let r = remindAt {
            let c = cal.dateComponents([.hour, .minute], from: r)
            lines.append(FinishLine(text: String(format: "Te recuerdo revisarlo a las %02d:%02d", c.hour ?? 0, c.minute ?? 0), warn: false))
        }
        let last = AgentParsing.firstLine(lastText)
        if !last.isEmpty { lines.append(FinishLine(text: last, warn: false, quote: true)) }
        return lines
    }

    public static func reviewReminderText(_ key: String, _ summary: String?) -> String {
        guard let s = summary, !s.isEmpty else { return "Revisar \(key)" }
        return "Revisar \(key) · \(s)"
    }

    // MARK: dónde se hizo el trabajo

    static let cdRE = Regex("(?:^|[;&|\\s(])(?:cd|git\\s+-C)\\s+(\"[^\"]+\"|'[^']+'|[^\\s;&|)]+)")
    static let unquoteRE = Regex("^([\"'])(.*)\\1$")

    /// Rutas absolutas con las que trabajó el agente, de la más reciente a la más antigua.
    public static func pathsFromTranscript(_ text: String, home: String = NSHomeDirectory()) -> [String] {
        var out: [String] = []
        func add(_ p: String?) {
            guard let p else { return }
            var q = trimmed(p)
            if q == "~" || q.hasPrefix("~/") { q = home + q.dropFirst() }
            if q.hasPrefix("/") && !q.contains("\n") && q.utf16.count < 1024 { out.append(q) }
        }
        for line in text.components(separatedBy: "\n") where line.contains("tool_use") {
            guard let o = JSON.parse(line) else { continue }
            for c in o["message"]?["content"]?.array ?? [] {
                guard c["type"]?.string == "tool_use", let input = c["input"], input.object != nil else { continue }
                add(input["file_path"]?.string)
                add(input["notebook_path"]?.string)
                if let cmd = input["command"]?.string {
                    for m in cdRE.matches(cmd) { add(m[1].map { unquoteRE.replace($0, with: "$2") }) }
                }
            }
        }
        var seen = Set<String>()
        return out.reversed().filter { seen.insert($0).inserted }
    }

    static func parentDir(_ p: String) -> String {
        guard let i = p.lastIndex(of: "/") else { return "/" }
        let d = String(p[..<i])
        return d.isEmpty ? "/" : d
    }

    /// Rutas → carpetas candidatas (un fichero → su carpeta), sin repetir.
    public static func dirsFromPaths(_ paths: [String], isDir: (String) -> Bool = FileUtil.isDir) -> [String] {
        var dirs: [String] = []
        for p in paths {
            var d = isDir(p) ? p : parentDir(p)
            var i = 0
            while i < 8 && d.count > 1 && !isDir(d) {
                d = parentDir(d)
                i += 1
            }
            while d.count > 1 && d.hasSuffix("/") { d.removeLast() }
            if d.count > 1 && isDir(d) && !dirs.contains(d) { dirs.append(d) }
        }
        return dirs
    }

    /// `for-each-ref --format=%(refname:short) %(committerdate:unix)` → ramas con `key` en el nombre y commit >= sinceS.
    public static func ticketBranches(_ text: String?, key: String, sinceS: Double) -> [(branch: String, ts: Double)] {
        guard !key.isEmpty else { return [] }
        let re = Regex("(?<![a-z0-9])\(NSRegularExpression.escapedPattern(for: key))(?!\\d)", caseInsensitive: true)
        var found: [(branch: String, ts: Double)] = []
        for l in (text ?? "").components(separatedBy: "\n") {
            guard let i = l.lastIndex(of: " "), i > l.startIndex else { continue }
            let branch = trimmed(String(l[..<i]))
            guard let ts = Double(trimmed(String(l[l.index(after: i)...]))), ts.isFinite, ts >= sinceS, re.test(branch) else { continue }
            found.append((branch, ts))
        }
        return found.enumerated().sorted { $0.element.ts != $1.element.ts ? $0.element.ts > $1.element.ts : $0.offset < $1.offset }.map(\.element)
    }

    static func keyRegex(_ key: String) -> Regex? {
        key.isEmpty ? nil : Regex("(?<![a-z0-9])\(NSRegularExpression.escapedPattern(for: key))(?!\\d)", caseInsensitive: true)
    }

    /// `for-each-ref --format=%(refname)<TAB>%(committerdate:unix)<TAB>%(upstream:short) refs/heads refs/remotes` → ramas con
    /// `key` en el nombre (RUN-5 no casa con RUN-50), local y remota del mismo nombre fusionadas, la más reciente primero.
    /// Omite `<remoto>/HEAD`.
    public static func parseBranchRefs(_ text: String?, key: String) -> [TicketBranch] {
        guard let re = keyRegex(key) else { return [] }
        var by: [String: TicketBranch] = [:]
        var order: [String] = []
        for l in (text ?? "").components(separatedBy: "\n") {
            let f = l.components(separatedBy: "\t")
            guard f.count >= 2, let ts = Double(trimmed(f[1])), ts.isFinite else { continue }
            let ref = f[0]
            let name: String, isLocal: Bool
            if ref.hasPrefix("refs/heads/") {
                name = String(ref.dropFirst(11)); isLocal = true
            } else if ref.hasPrefix("refs/remotes/") {
                let rest = String(ref.dropFirst(13))
                guard let slash = rest.firstIndex(of: "/") else { continue }
                name = String(rest[rest.index(after: slash)...]); isLocal = false
                if name == "HEAD" { continue }
            } else { continue }
            guard !name.isEmpty, re.test(name) else { continue }
            var e = by[name] ?? TicketBranch(branch: name, local: false, remote: false, ts: 0)
            if by[name] == nil { order.append(name) }
            if isLocal { e.local = true } else { e.remote = true }
            e.ts = max(e.ts, ts)
            if isLocal, f.count > 2, !trimmed(f[2]).isEmpty { e.upstream = trimmed(f[2]) }
            by[name] = e
        }
        return order.compactMap { by[$0] }.enumerated()
            .sorted { $0.element.ts != $1.element.ts ? $0.element.ts > $1.element.ts : $0.offset < $1.offset }.map(\.element)
    }

    /// `git worktree list --porcelain` → rama → ruta del worktree donde está activa.
    public static func parseWorktrees(_ text: String?) -> [String: String] {
        var out: [String: String] = [:]
        var path: String? = nil
        for l in (text ?? "").components(separatedBy: "\n") {
            if l.hasPrefix("worktree ") { path = String(l.dropFirst(9)) }
            else if l.hasPrefix("branch refs/heads/"), let path { out[String(l.dropFirst(18))] = path }
        }
        return out
    }

    /// Ramas (locales y de seguimiento remoto; sin red) de `key` en `repos` (máx. 40, `perRepo` s por llamada a git). Si la rama
    /// está activa en otro worktree, el resultado apunta a ese worktree. Bloqueante: llamar fuera del hilo principal.
    public static func findTicketBranches(key: String, repos: [String], perRepo: TimeInterval = 3) -> [TicketBranch] {
        guard keyRegex(key) != nil else { return [] }
        var seen = Set<String>()
        let list = repos.filter { $0.hasPrefix("/") && seen.insert($0).inserted }.prefix(reposMax)
        let lock = NSLock()
        var found: [String: TicketBranch] = [:]
        let items = Array(list)
        DispatchQueue.concurrentPerform(iterations: items.count) { i in
            let repo = items[i]
            let refs = Git.run(repo, ["for-each-ref", "--format=%(refname)%09%(committerdate:unix)%09%(upstream:short)", "refs/heads", "refs/remotes"], timeout: perRepo)
            let hits = parseBranchRefs(refs, key: key)
            guard !hits.isEmpty else { return }
            let wts = parseWorktrees(Git.run(repo, ["worktree", "list", "--porcelain"], timeout: perRepo))
            lock.lock(); defer { lock.unlock() }
            for var h in hits {
                let at = wts[h.branch] ?? repo
                h.repo = at
                let k = "\(at)\u{0}\(h.branch)"
                if let p = found[k] {
                    h.local = h.local || p.local; h.remote = h.remote || p.remote; h.ts = max(h.ts, p.ts)
                    h.upstream = h.upstream ?? p.upstream
                }
                found[k] = h
            }
        }
        return found.values.sorted { $0.ts != $1.ts ? $0.ts > $1.ts : $0.repo + $0.branch < $1.repo + $1.branch }
    }

    /// Estado git de `cwd` (o de la rama local `branch`); nil si no es un repo. commits = los de fecha >= sinceS.
    public static func detectWork(_ cwd: String, sinceS: Double, branch: String? = nil) -> Work? {
        guard cwd.hasPrefix("/"), FileUtil.isDir(cwd) else { return nil }
        let rev = branch.map { "refs/heads/\($0)" } ?? "HEAD"
        guard let head = Git.run(cwd, ["rev-parse", rev]), !head.isEmpty else { return nil }
        let ref = branch ?? Git.run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
        let log = Git.run(cwd, ["log", "--since=@\(Int(sinceS.rounded(.down)))", "--format=%h %s", "--no-merges", "--max-count=\(logMax)", rev])
        let up = branch.map { "\($0)@{u}" } ?? "@{u}"
        let upstream = Git.run(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", up]).flatMap { $0.isEmpty ? nil : $0 }
        let ahead = upstream != nil ? Git.run(cwd, ["rev-list", "--count", "\(up)..\(rev)"]) : nil
        let remote = Git.run(cwd, ["remote", "get-url", "origin"]).flatMap { $0.isEmpty ? nil : $0 }
        let ts = Double(Git.run(cwd, ["log", "-1", "--format=%ct", rev]) ?? "") ?? 0
        return Work(repo: cwd, head: head, branch: ref.flatMap { $0.isEmpty || $0 == "HEAD" ? nil : $0 }, commits: parseLog(log),
                    upstream: upstream, pushed: upstream != nil && ahead == "0", remote: remote, ts: ts)
    }

    static func ticketWorkIn(_ repo: String, key: String, sinceS: Double) -> Work? {
        let refs = Git.run(repo, ["for-each-ref", "--format=%(refname:short) %(committerdate:unix)", "refs/heads"])
        for b in ticketBranches(refs, key: key, sinceS: sinceS) {
            if var w = detectWork(repo, sinceS: sinceS, branch: b.branch), !w.commits.isEmpty {
                w.repo = repo
                return w
            }
        }
        return nil
    }

    static func readTranscript(_ path: String) -> String {
        let size = FileUtil.size(path)
        guard var text = FileUtil.readTail(path, bytes: transcriptMax) else { return "" }
        if size > transcriptMax, let nl = text.firstIndex(of: "\n") { text = String(text[text.index(after: nl)...]) }
        return text
    }

    /// ¿Dónde trabajó el agente de `key`? cwd (ramas del ticket o su rama con commits nuevos), repos del
    /// transcript y, si nada, los repos conocidos. Bloqueante (git): llamar fuera del hilo principal.
    /// `deadline`: a partir de ahí no se prueban más repos.
    public static func findTicketWork(cwd: String?, key: String, sinceS: Double, sessionId: String? = nil, roots: [String] = [],
                                      paths: KaitoPaths = .default, knownRepos: (() -> [String])? = nil,
                                      deadline: Date = Date().addingTimeInterval(90)) -> Work? {
        var tried = Set<String>()
        func ok() -> Bool { Date() < deadline }
        func top(_ dir: String) -> String? {
            guard let t = Git.run(dir, ["rev-parse", "--show-toplevel"]), !t.isEmpty, !tried.contains(t) else { return nil }
            return t
        }
        var fallback: Work? = nil
        if let cwd, cwd.hasPrefix("/"), let root = top(cwd) {
            tried.insert(root)
            if let w = ticketWorkIn(root, key: key, sinceS: sinceS) { return w }
            if var cur = detectWork(cwd, sinceS: sinceS), !cur.commits.isEmpty {
                cur.repo = root
                fallback = cur
            }
        }
        guard ok() else { return nil }
        if let sessionId, let cwd {
            let file = "\(paths.claudeProjects)/\(AgentParsing.projectDirName(cwd))/\(sessionId).jsonl"
            var n = 0
            for d in dirsFromPaths(pathsFromTranscript(readTranscript(file), home: paths.home)) {
                if !ok() || n >= transcriptReposMax { break }
                guard let root = top(d) else { continue }
                tried.insert(root)
                n += 1
                if let w = ticketWorkIn(root, key: key, sinceS: sinceS) { return w }
            }
        }
        if fallback != nil || !ok() { return fallback }
        let repos = knownRepos?() ?? {
            var seen = Set<String>()
            return (Array(Repos.collectRecent(paths: paths).prefix(reposMax)) + Repos.scan(roots: roots, home: paths.home))
                .filter { seen.insert($0).inserted }
        }()
        for r in repos.prefix(reposMax) {
            if !ok() { return nil }
            if tried.contains(r) { continue }
            tried.insert(r)
            if let w = ticketWorkIn(r, key: key, sinceS: sinceS) { return w }
        }
        return nil
    }

    // MARK: tareas K-<n> del tablero (todos.json)

    public static let localKeyRE = Regex("^K-(\\d+)$")
    public static func isLocalKey(_ k: String?) -> Bool { localKeyRE.test(k ?? "") }

    /// Tarea K-<n> de todos.json, o nil.
    public static func localTask(_ key: String, paths: KaitoPaths = .default) -> JSON? {
        guard isLocalKey(key) else { return nil }
        return (JSONFile.read(paths.todosPath)?.array ?? []).first { $0["id"]?.string == key }
    }

    /// Pasa la tarea K-<n> a "review" (salvo que ya esté en revisión o hecha), como withState de board.js.
    /// Devuelve el nombre del estado resultante o nil si la tarea no existe.
    public static func moveLocalTaskToReview(_ key: String, paths: KaitoPaths = .default, nowMs: Double = Date().timeIntervalSince1970 * 1000) throws -> String? {
        var list = JSONFile.read(paths.todosPath)?.array ?? []
        guard let i = list.firstIndex(where: { $0["id"]?.string == key }), var o = list[i].object else { return nil }
        let states = ["todo", "doing", "review", "done"]
        let cur = states.contains(o["state"]?.string ?? "") ? o["state"]!.string! : (o["done"]?.bool == true ? "done" : "todo")
        let names = ["todo": "Por hacer", "doing": "Haciendo", "review": "En revisión", "done": "Hecho"]
        if cur == "done" || cur == "review" { return names[cur] }
        o["state"] = "review"
        o["done"] = false
        o["updated"] = .number(nowMs.rounded())
        list[i] = .object(o)
        try JSONFile.write(paths.todosPath, .array(list))
        return names["review"]
    }
}
