import XCTest
@testable import KaitoCore

/// Casos de kaito.test.js para finish.js (PR, log, deduplicado, tarjeta, transcript, ramas, git real).
final class FinishTests: XCTestCase {
    func testRemotes() {
        XCTAssertTrue(Finish.parseRemote("git@github.com:runnea/web.git")! == ("github.com", "runnea/web"))
        XCTAssertTrue(Finish.parseRemote("https://user:tok@github.com/runnea/web.git")! == ("github.com", "runnea/web"))
        XCTAssertTrue(Finish.parseRemote("ssh://git@gitlab.com:2222/grupo/sub/app.git/")! == ("gitlab.com", "grupo/sub/app"))
        XCTAssertNil(Finish.parseRemote("/srv/git/repo.git"))
        XCTAssertNil(Finish.parseRemote("file:///srv/repo.git"))
        XCTAssertEqual(Finish.prUrl(remote: "git@github.com:runnea/web.git", branch: "RUN-1-fix/x y"), "https://github.com/runnea/web/pull/new/RUN-1-fix/x%20y")
        XCTAssertEqual(Finish.prUrl(remote: "https://github.com/runnea/web", branch: "RUN-1"), "https://github.com/runnea/web/pull/new/RUN-1")
        XCTAssertEqual(Finish.prUrl(remote: "git@github.com-work:runnea/web.git", branch: "RUN-1"), "https://github.com/runnea/web/pull/new/RUN-1")
        XCTAssertEqual(Finish.prUrl(remote: "git@gitlab.com:g/sub/app.git", branch: "RUN-2"),
                       "https://gitlab.com/g/sub/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=RUN-2")
        XCTAssertEqual(Finish.prUrl(remote: "https://gitlab.empresa.es/g/app.git", branch: "RUN-2"),
                       "https://gitlab.empresa.es/g/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=RUN-2")
        XCTAssertEqual(Finish.prUrl(remote: "git@bitbucket.org:ws/app.git", branch: "RUN-3"), "https://bitbucket.org/ws/app/pull-requests/new?source=RUN-3&t=1")
        XCTAssertEqual(Finish.prUrl(remote: "https://julen@bitbucket.org/ws/app.git", branch: "a&b"), "https://bitbucket.org/ws/app/pull-requests/new?source=a%26b&t=1")
        XCTAssertNil(Finish.prUrl(remote: "git@github.com:o/r.git", branch: "main"))
        XCTAssertNil(Finish.prUrl(remote: "git@github.com:o/r.git", branch: nil))
        XCTAssertNil(Finish.prUrl(remote: "git@example.com:o/r.git", branch: "x"))
        XCTAssertNil(Finish.prUrl(remote: "git@notgithub.io:o/r.git", branch: "x"))
    }

    func testLogDedupeLines() {
        XCTAssertEqual(Finish.parseLog("abc1234 RUN-1: hola mundo\n\nzzz basura\ndef5678 RUN-1: x  \n"),
                       [Commit(sha: "abc1234", subject: "RUN-1: hola mundo"), Commit(sha: "def5678", subject: "RUN-1: x")])
        XCTAssertEqual(Finish.parseLog(nil), [])
        let k = Finish.finishKey("s1", "abc")
        let m1 = Finish.markOnce([:], key: k, nowMs: 1000)
        let m2 = Finish.markOnce(m1.map, key: k, nowMs: 2000)
        let m3 = Finish.markOnce(m2.map.merging(["viejo": 1]) { $1 }, key: Finish.finishKey("s1", "def"), nowMs: 8 * 86400 * 1000)
        XCTAssertEqual([m1.fresh, m2.fresh, m3.fresh], [true, false, true])
        XCTAssertEqual(Array(m3.map.keys), ["s1:def"])

        let cal = Calendar.current
        let work = Work(repo: "/r", head: "h", branch: "RUN-12326-carreras-virtuales",
                        commits: [Commit(sha: "a", subject: "RUN-12326: carreras"), Commit(sha: "b", subject: "x")],
                        upstream: "origin/x", pushed: true, remote: nil, ts: 0)
        XCTAssertEqual(Finish.finishLines(work: work, moved: "Probando Desarrollo", reason: nil, lastText: "## Hecho\nresto",
                                          remindAt: cal.date(from: DateComponents(year: 2026, month: 11, day: 19, hour: 9, minute: 5))), [
            FinishLine(text: "Rama RUN-12326-carreras-virtuales · subida", warn: false),
            FinishLine(text: "2 commits nuevos · RUN-12326: carreras", warn: false),
            FinishLine(text: "Movido a Probando Desarrollo", warn: false),
            FinishLine(text: "Te recuerdo revisarlo a las 09:05", warn: false),
            FinishLine(text: "Hecho", warn: false, quote: true),
        ])
        var w2 = work
        w2.pushed = false
        w2.commits = [work.commits[0]]
        XCTAssertEqual(Finish.finishLines(work: w2, moved: nil, reason: "HTTP 403", lastText: nil, remindAt: nil).map { "\($0.text)|\($0.warn)" },
                       ["Rama RUN-12326-carreras-virtuales · sin subir|true", "1 commit nuevo · RUN-12326: carreras|false", "No se ha movido: HTTP 403|true"])
        XCTAssertEqual([Finish.reviewReminderText("RUN-1", "Arreglar x"), Finish.reviewReminderText("RUN-1", "")], ["Revisar RUN-1 · Arreglar x", "Revisar RUN-1"])
    }

    func testTranscript() {
        func tu(_ input: JSON) -> String {
            JSON.object(["type": "assistant", "message": ["content": [["type": "text", "text": "cd /no/esto"], ["type": "tool_use", "name": "x", "input": input]]]]).serialized()
        }
        let jsonl = [tu(["command": "cd /srv/a && git status"]), "linea {cortada", JSON.object(["type": "user", "message": ["content": "cd /no"]]).serialized(),
                     tu(["file_path": "/srv/b/src/x.js"]), tu(["command": "git -C '/srv/c d' log; cd ~/w/e | cat"]), tu(["command": "cd rel && ls"]),
                     tu(["file_path": "/srv/a/y.js"])].joined(separator: "\n")
        XCTAssertEqual(Finish.pathsFromTranscript(jsonl, home: "/home/u"), ["/srv/a/y.js", "/home/u/w/e", "/srv/c d", "/srv/b/src/x.js", "/srv/a"])
        XCTAssertEqual(Finish.pathsFromTranscript("", home: "/h"), [])
        let dirs: Set<String> = ["/srv", "/srv/a", "/srv/b", "/srv/b/src"]
        XCTAssertEqual(Finish.dirsFromPaths(["/srv/a/y.js", "/srv/b/src/x.js", "/srv/a", "/srv/zz/q/f.js", "/nada/f"], isDir: { dirs.contains($0) }),
                       ["/srv/a", "/srv/b/src", "/srv"])
        let refs = "main 100\nrun-5-Algo 300\nfeature/RUN-5-b 200\nRUN-5-viejo 10\nRUN-50-otro 400\nbasura\n"
        XCTAssertEqual(Finish.ticketBranches(refs, key: "RUN-5", sinceS: 100).map { "\($0.branch)@\(Int($0.ts))" }, ["run-5-Algo@300", "feature/RUN-5-b@200"])
    }

    func testBranchRefsAndPromptVariant() {
        let T = "\t"
        let txt = ["refs/heads/main\(T)100\(T)", "refs/heads/RUN-5-a\(T)300\(T)origin/RUN-5-a", "refs/remotes/origin/RUN-5-a\(T)250\(T)",
                   "refs/remotes/origin/HEAD\(T)100\(T)", "refs/remotes/origin/feature/run-5-b\(T)200\(T)", "refs/heads/RUN-50-x\(T)400\(T)",
                   "refs/remotes/origin/XRUN-5\(T)500\(T)", "basura"].joined(separator: "\n")
        let got = Finish.parseBranchRefs(txt, key: "RUN-5")
        XCTAssertEqual(got, [TicketBranch(branch: "RUN-5-a", local: true, remote: true, ts: 300, upstream: "origin/RUN-5-a"),
                             TicketBranch(branch: "feature/run-5-b", local: false, remote: true, ts: 200)])
        XCTAssertEqual(Finish.parseBranchRefs(txt, key: ""), [])
        XCTAssertEqual(Finish.parseWorktrees("worktree /a\nHEAD x\nbranch refs/heads/main\n\nworktree /b\nbranch refs/heads/RUN-1-x\n"), ["main": "/a", "RUN-1-x": "/b"])
        // prompt
        var issue = JiraIssue(key: "RUN-123"); issue.summary = "x"
        let NOW = 1_000_000_000.0
        let here = TicketBranch(repo: "/h/kontan", branch: "RUN-123-login", local: true, remote: true, ts: NOW - 3 * 86400)
        let p = JiraViews.buildPrompt(issue, base: "b", detail: nil, repo: "/h/kontan", existing: here, now: NOW)
        XCTAssertTrue(p.contains("Git: Ya existe la rama `RUN-123-login` para este ticket en este repo (último commit hace 3 d, subida a origin). "))
        XCTAssertTrue(p.contains("Cámbiate a ella (git switch RUN-123-login; si solo está en origin: git switch --track origin/RUN-123-login) y continúa ahí; no crees otra rama. "))
        XCTAssertTrue(p.hasSuffix("con mensajes que empiecen por \"RUN-123: \". Al terminar deja todo commiteado (git status limpio) y sube la rama a origin con `git push -u origin RUN-123-login`. Nunca hagas push a main, master ni develop, nunca uses force-push y no abras PR.\n"))
        XCTAssertFalse(p.contains("crea una llamada") || p.contains("Ojo:"))
        XCTAssertTrue(JiraViews.gitParagraph(key: "RUN-123", branch: "x", here: TicketBranch(branch: "b", local: true, remote: false, ts: NOW), now: NOW).contains("hace menos de 1 min, solo local)"))
        XCTAssertTrue(JiraViews.gitParagraph(key: "RUN-123", branch: "x", here: TicketBranch(branch: "b", local: false, remote: true, ts: NOW), now: NOW).contains("solo en origin)"))
        let o = JiraViews.buildPrompt(issue, base: "b", detail: nil, repo: "/h/otro", existing: here, now: NOW)
        XCTAssertTrue(o.contains("Ojo: hay una rama de este ticket en kontan (RUN-123-login).\nGit: trabaja en una rama propia"))
        XCTAssertEqual(JiraViews.buildPrompt(issue, base: "b", detail: nil, repo: "/h/kontan", existing: nil), JiraViews.buildPrompt(issue, base: "b", detail: nil, repo: "/h/kontan"))
        XCTAssertEqual([JiraViews.relAgo(NOW - 600, now: NOW), JiraViews.relAgo(NOW - 7300, now: NOW)], ["hace 10 min", "hace 2 h"])
        // ranking
        let r = JiraViews.rankRepos(issue, repos: ["/h/a", "/h/b"], byIssue: ["RUN-123": "/h/a"], byProject: [:],
                                    branches: ["/h/b": here, "/w/c": here])
        XCTAssertEqual(r.map { "\($0.path):\($0.why ?? "null")" }, ["/h/b:branch", "/w/c:branch", "/h/a:issue"])
        XCTAssertEqual(r[0].branch, here)
    }

    func testFindTicketBranchesGit() throws {
        guard FileManager.default.isExecutableFile(atPath: Git.bin) else { throw XCTSkip("sin git") }
        let tmp = NSTemporaryDirectory() + "kaito-fb-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        let id = ["-c", "user.name=t", "-c", "user.email=t@t"]
        func g(_ dir: String, _ a: [String]) { _ = Git.run(dir, id + a) }
        let origin = "\(tmp)/origin.git", a = "\(tmp)/a", b = "\(tmp)/b"
        for d in [origin, a, b] { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
        g(origin, ["init", "-q", "--bare", "-b", "main"])
        for d in [a, b] { g(d, ["init", "-q", "-b", "main"]); g(d, ["commit", "-q", "--allow-empty", "-m", "i"]) }
        g(a, ["switch", "-q", "-c", "run-77-cards"])
        g(a, ["switch", "-q", "main"])
        g(b, ["remote", "add", "origin", origin])
        g(b, ["branch", "RUN-77-y"]); g(b, ["push", "-q", "origin", "RUN-77-y"]); g(b, ["branch", "-q", "-D", "RUN-77-y"])
        let got = Finish.findTicketBranches(key: "RUN-77", repos: [a, b, "/no/existe"])
        XCTAssertEqual(Set(got.map { "\($0.repo)|\($0.branch)|\($0.local)|\($0.remote)" }),
                       ["\(a)|run-77-cards|true|false", "\(b)|RUN-77-y|false|true"])
        XCTAssertEqual(Finish.findTicketBranches(key: "RUN-7", repos: [a, b]), [])
        let wt = "\(tmp)/wt"
        g(a, ["worktree", "add", "-q", wt, "run-77-cards"])
        XCTAssertEqual(Finish.findTicketBranches(key: "RUN-77", repos: [a]).map(\.repo).map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path },
                       [URL(fileURLWithPath: wt).resolvingSymlinksInPath().path])
    }

    func testTicketFromHeadLocalTask() {
        let line = JSON.object(["type": "user", "message": ["content": "Trabaja en la tarea K-3: arreglar algo"]]).serialized()
        XCTAssertEqual(AgentParsing.ticketFromHead(line), .ticket("K-3"))
        XCTAssertTrue(Finish.isLocalKey("K-3"))
        XCTAssertFalse(Finish.isLocalKey("RUN-3"))
    }

    func testLocalTaskReview() throws {
        let home = NSTemporaryDirectory() + "kaito-k-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: home) }
        let paths = KaitoPaths(home: home, env: [:])
        try JSONFile.write(paths.todosPath, [["id": "K-1", "text": "a", "state": "doing", "done": false, "extra": 1], ["id": "K-2", "text": "b", "done": true]])
        XCTAssertEqual(try Finish.moveLocalTaskToReview("K-1", paths: paths, nowMs: 5), "En revisión")
        XCTAssertEqual(try Finish.moveLocalTaskToReview("K-2", paths: paths), "Hecho")
        XCTAssertNil(try Finish.moveLocalTaskToReview("K-9", paths: paths))
        let t = Finish.localTask("K-1", paths: paths)
        XCTAssertEqual(t?["state"]?.string, "review")
        XCTAssertEqual(t?["extra"]?.int, 1)
        XCTAssertEqual(t?["updated"]?.int, 5)
    }

    // MARK: git real (se salta si no hay git)

    func sh(_ cwd: String, _ args: [String], env extra: [String: String] = [:], home: String) throws -> String {
        var env = ["GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
                   "HOME": home, "GIT_CONFIG_NOSYSTEM": "1", "PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"]
        env.merge(extra) { $1 }
        let r = Shell.run([Git.bin] + args, cwd: cwd, env: env, timeout: 30)
        if r.status != 0 { throw KaitoError.message("git \(args.joined(separator: " ")): \(r.err)") }
        return trimmed(r.out)
    }

    func testDetectAndFind() throws {
        guard FileUtil.isExecutable(Git.bin) else { throw XCTSkip("sin git") }
        let tmp = NSTemporaryDirectory() + "kaito-git-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tmp) }
        let origin = "\(tmp)/origin.git", repo = "\(tmp)/repo"
        _ = try sh(tmp, ["init", "-q", "--bare", "-b", "main", origin], home: tmp)
        _ = try sh(tmp, ["init", "-q", "-b", "main", repo], home: tmp)
        _ = try sh(repo, ["remote", "add", "origin", origin], home: tmp)
        try FileUtil.writeText("\(repo)/a.txt", "1")
        _ = try sh(repo, ["add", "."], home: tmp)
        let old = Int(Date().timeIntervalSince1970) - 7200
        _ = try sh(repo, ["commit", "-q", "-m", "inicial", "--date=@\(old) +0000"], env: ["GIT_COMMITTER_DATE": "@\(old) +0000"], home: tmp)
        _ = try sh(repo, ["push", "-q", "-u", "origin", "main"], home: tmp)
        _ = try sh(repo, ["switch", "-q", "-c", "RUN-9-algo"], home: tmp)
        let since = Date().timeIntervalSince1970 - 60
        var wk = Finish.detectWork(repo, sinceS: since)!
        XCTAssertEqual(wk.branch, "RUN-9-algo")
        XCTAssertEqual(wk.commits.count, 0)
        XCTAssertNil(wk.upstream)
        XCTAssertFalse(wk.pushed)
        try FileUtil.writeText("\(repo)/a.txt", "2")
        _ = try sh(repo, ["commit", "-q", "-am", "RUN-9: cambio"], home: tmp)
        wk = Finish.detectWork(repo, sinceS: since)!
        XCTAssertEqual(wk.commits.map(\.subject), ["RUN-9: cambio"])
        XCTAssertEqual(wk.remote, origin)
        XCTAssertEqual(wk.head, try sh(repo, ["rev-parse", "HEAD"], home: tmp))
        _ = try sh(repo, ["push", "-q", "-u", "origin", "RUN-9-algo"], home: tmp)
        wk = Finish.detectWork(repo, sinceS: since)!
        XCTAssertEqual(wk.upstream, "origin/RUN-9-algo")
        XCTAssertTrue(wk.pushed)
        XCTAssertNil(Finish.detectWork(tmp, sinceS: since))
        XCTAssertNil(Finish.detectWork("relativo", sinceS: since))

        // El agente trabajó en otro repo: rama del ticket en repo2, encontrada por el transcript.
        let repo2 = "\(tmp)/otro", solo = "\(tmp)/solo"
        for r in [repo2, solo] {
            _ = try sh(tmp, ["init", "-q", "-b", "main", r], home: tmp)
            try FileUtil.writeText("\(r)/b.txt", "1")
            _ = try sh(r, ["add", "."], home: tmp)
            _ = try sh(r, ["commit", "-q", "-m", "inicial", "--date=@\(old) +0000"], env: ["GIT_COMMITTER_DATE": "@\(old) +0000"], home: tmp)
        }
        _ = try sh(repo2, ["switch", "-q", "-c", "run-77-cards"], home: tmp)
        try FileUtil.writeText("\(repo2)/b.txt", "2")
        _ = try sh(repo2, ["commit", "-q", "-am", "RUN-77: cards"], home: tmp)
        _ = try sh(repo2, ["switch", "-q", "main"], home: tmp)
        let paths = KaitoPaths(home: "\(tmp)/h", env: [:])
        XCTAssertNil(Finish.findTicketWork(cwd: solo, key: "RUN-77", sinceS: since, paths: paths, knownRepos: { [] }))
        let line = JSON.object(["type": "assistant", "message": ["content": [["type": "tool_use", "name": "Edit", "input": ["file_path": .string("\(repo2)/b.txt")]]]]]).serialized()
        try FileUtil.writeText("\(paths.claudeProjects)/\(AgentParsing.projectDirName(solo))/sess-1.jsonl", line + "\n")
        let found = Finish.findTicketWork(cwd: solo, key: "RUN-77", sinceS: since, sessionId: "sess-1", paths: paths, knownRepos: { [] })
        XCTAssertEqual(found?.branch, "run-77-cards")
        XCTAssertEqual(found?.commits.map(\.subject), ["RUN-77: cards"])
        XCTAssertEqual(found.map { URL(fileURLWithPath: $0.repo).resolvingSymlinksInPath().path }, URL(fileURLWithPath: repo2).resolvingSymlinksInPath().path)
        // Sin transcript: por la lista de repos conocidos.
        XCTAssertEqual(Finish.findTicketWork(cwd: solo, key: "RUN-77", sinceS: since, paths: paths, knownRepos: { [repo2] })?.branch, "run-77-cards")
    }
}

private func == (a: (host: String, path: String), b: (String, String)) -> Bool { a.host == b.0 && a.path == b.1 }
