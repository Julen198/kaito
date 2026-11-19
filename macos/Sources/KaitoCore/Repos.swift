import Foundation

/// Repos donde mandar un ticket a Claude: los cwd recientes de Claude Code + escaneo de carpetas de código.
public enum Repos {
    static func skip(_ p: String) -> Bool {
        p.contains("/.claude-mem/") || p.contains("/.claude/worktrees") || p.contains("-worktrees-")
    }

    /// Primer `cwd` absoluto que aparezca en un trozo de .jsonl.
    public static func cwdFromJsonl(_ text: String) -> String? {
        for line in text.components(separatedBy: "\n") where line.contains("\"cwd\"") {
            if let c = JSON.parse(line)?["cwd"]?.string, c.hasPrefix("/") { return c }
        }
        return nil
    }

    /// Cwd distintos de los últimos `days` días (más reciente primero).
    public static func collectRecent(paths: KaitoPaths = .default, days: Int = 30, now: Double = Date().timeIntervalSince1970) -> [String] {
        let minT = now - Double(days) * 86400
        var best: [String: Double] = [:]
        for d in FileUtil.list(paths.claudeProjects) where !d.contains("claude-mem") && !d.contains("-worktrees-") {
            let dir = "\(paths.claudeProjects)/\(d)"
            var newest: (t: Double, path: String)? = nil
            for f in FileUtil.list(dir) where f.hasSuffix(".jsonl") {
                let p = "\(dir)/\(f)"
                if let t = FileUtil.mtime(p), t >= minT, t > (newest?.t ?? -1) { newest = (t, p) }
            }
            guard let n = newest else { continue }
            var tail = FileUtil.readTail(n.path) ?? ""
            if FileUtil.size(n.path) > 64 * 1024, let nl = tail.firstIndex(of: "\n") { tail = String(tail[tail.index(after: nl)...]) }
            guard let cwd = cwdFromJsonl(tail) ?? cwdFromJsonl(FileUtil.readHead(n.path) ?? ""),
                  !skip(cwd), FileUtil.isDir(cwd) else { continue }
            if (best[cwd] ?? 0) < n.t { best[cwd] = n.t }
        }
        return best.sorted { $0.value > $1.value }.map(\.key)
    }

    /// Repos git (carpeta con `.git`) bajo `roots` hasta `maxDepth` niveles; acotado en carpetas y tiempo.
    public static func scan(roots: [String], home: String = NSHomeDirectory(), maxDepth: Int = 4, maxDirs: Int = 4000,
                            maxSeconds: Double = 0.4) -> [String] {
        let t0 = Date()
        var found = Set<String>()
        var visited = 0
        let fm = FileManager.default
        func walk(_ path: String, _ depth: Int) {
            visited += 1
            if visited > maxDirs || Date().timeIntervalSince(t0) > maxSeconds { return }
            guard let names = try? fm.contentsOfDirectory(atPath: path) else { return }
            if names.contains(".git") {
                found.insert(path)
                return
            }
            guard depth < maxDepth else { return }
            for name in names.sorted() where !name.hasPrefix(".") && name != "node_modules" && name != "vendor" {
                let p = "\(path)/\(name)"
                guard let attrs = try? fm.attributesOfItem(atPath: p),
                      attrs[.type] as? FileAttributeType == .typeDirectory else { continue } // sin seguir symlinks
                walk(p, depth + 1)
            }
        }
        for r in roots {
            let root = FileUtil.expandTilde(r, home: home)
            if root.hasPrefix("/") {
                let clean = root.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
                walk(clean.isEmpty ? "/" : clean, 0)
            }
        }
        return found.sorted()
    }

    /// Rama actual leyendo .git/HEAD (nil si no hay o HEAD desacoplado).
    public static func branch(_ repo: String) -> String? {
        guard let head = FileUtil.readText("\(repo)/.git/HEAD").map(trimmed), head.hasPrefix("ref: refs/heads/") else { return nil }
        return String(head.dropFirst(16))
    }
}

/// Comprobación de nuevas versiones en GitHub Releases.
public enum Updates {
    public static let repo = "Julen198/kaito"
    public static let latestURL = "https://api.github.com/repos/\(repo)/releases/latest"
    public static let installURL = "https://raw.githubusercontent.com/\(repo)/main/macos/install-mac.sh"
    public static let checkEvery: Double = 6 * 3600

    /// "v0.10.1" → [0, 10, 1].
    public static func parts(_ v: String) -> [Int] {
        var s = trimmed(v)
        if s.hasPrefix("v") || s.hasPrefix("V") { s.removeFirst() }
        return s.split(separator: "-").first.map { $0.split(separator: ".").map { Int($0) ?? 0 } } ?? []
    }

    /// ¿`latest` es más nueva que `current`?
    public static func isNewer(_ latest: String, than current: String) -> Bool {
        let a = parts(latest), b = parts(current)
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    public struct Release: Equatable, Sendable {
        public var tag: String
        public var hasMacAsset: Bool
        public var url: String
    }

    /// JSON de /releases/latest → versión y si trae Kaito-macOS.zip.
    public static func parseRelease(_ j: JSON?) -> Release? {
        guard let tag = j?["tag_name"]?.string, !tag.isEmpty else { return nil }
        let has = (j?["assets"]?.array ?? []).contains { $0["name"]?.string == "Kaito-macOS.zip" }
        return Release(tag: tag, hasMacAsset: has, url: j?["html_url"]?.string ?? "https://github.com/\(repo)/releases")
    }

    /// ¿Toca mirar? Como mucho cada 6 h.
    public static func shouldCheck(lastChecked: Double?, now: Double) -> Bool {
        guard let l = lastChecked else { return true }
        return now - l >= checkEvery || now < l
    }
}
