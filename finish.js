// Cuando un agente lanzado con un ticket termina: ¿ha dejado commits? ¿está subida la rama?
// Lógica pura (URL de PR, parseo, deduplicado, líneas de la tarjeta) + lectura de git sin shell.
// Solo gi:// y módulos locales: se prueba con gjs (kaito.test.js).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {CACHE_DIR, CLAUDE_PROJECTS, collectRepos, readJson, scanRepos} from './common.js';
import {firstLine} from './agents.js';
import {git} from './jiradraft.js';

export const FINISHED_PATH = GLib.build_filenamev([CACHE_DIR, 'finished.json']);
const FINISHED_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const LOG_MAX = 50;
const PROTECTED = new Set(['main', 'master', 'develop']);

/**
 * Puro. URL de un remoto git → {host, path} (sin credenciales, puerto ni .git), o null.
 * Admite scp (git@host:o/r.git), ssh://, git+ssh://, git://, http(s)://.
 */
export function parseRemote(url) {
    const s = String(url ?? '').trim();
    let m = /^(?:ssh|git\+ssh|git|https?):\/\/(?:[^@/]+@)?([^/:]+)(?::\d*)?\/(.+?)(?:\.git)?\/*$/i.exec(s);
    if (!m)
        m = /^(?:[^@/:]+@)?([^/:]+):(?!\/)\/?(.+?)(?:\.git)?\/*$/.exec(s);
    if (!m)
        return null;
    const path = m[2].split('/').filter(Boolean);
    if (path.length < 2 || path.some(p => p === '.' || p === '..'))
        return null;
    return {host: m[1].toLowerCase(), path: path.join('/')};
}

/** Puro. Proveedor y host web: los alias ssh tipo github.com-trabajo se llevan a github.com. */
function forge(host) {
    for (const [kind, saas] of [['github', 'github.com'], ['gitlab', 'gitlab.com'], ['bitbucket', 'bitbucket.org']]) {
        if (host === saas || host.startsWith(`${saas}-`) || host.startsWith(`${saas}_`))
            return {kind, web: saas};
        if (host.split('.').some(p => p === kind || p.startsWith(`${kind}-`)))
            return {kind, web: host}; // autoalojado (github.empresa.com, gitlab.empresa.com…)
    }
    return null;
}

/**
 * Puro. URL para abrir una PR/MR de `branch` en GitHub, GitLab o Bitbucket a partir del remoto
 * origin; null si el remoto no es de esos, no hay rama o es main/master/develop.
 */
export function prUrl(remote, branch) {
    const r = parseRemote(remote);
    const f = r && forge(r.host);
    if (!f || !branch || branch === 'HEAD' || PROTECTED.has(branch))
        return null;
    const base = `https://${f.web}/${r.path}`;
    const q = encodeURIComponent(branch);
    if (f.kind === 'github')
        return `${base}/pull/new/${branch.split('/').map(encodeURIComponent).join('/')}`;
    if (f.kind === 'gitlab')
        return `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${q}`;
    return `${base}/pull-requests/new?source=${q}&t=1`;
}

/** Puro. Salida de `git log --format=%h %s` → [{sha, subject}]. */
export function parseLog(text) {
    return String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const i = l.indexOf(' ');
        return i < 0 ? {sha: l, subject: ''} : {sha: l.slice(0, i), subject: l.slice(i + 1).trim()};
    }).filter(c => /^[0-9a-f]{4,40}$/.test(c.sha));
}

/** Puro. Clave de deduplicado: una tarjeta por sesión y HEAD. */
export const finishKey = (sessionId, head) => `${sessionId}:${head}`;

/**
 * Puro. ¿Es la primera vez que vemos `key`? Devuelve {fresh, map} con la clave anotada y
 * las entradas de más de 7 días podadas (no modifica `map`).
 */
export function markOnce(map, key, nowMs) {
    const next = {};
    for (const [k, t] of Object.entries(map ?? {})) {
        if (Number.isFinite(Number(t)) && nowMs - Number(t) < FINISHED_MAX_AGE_MS)
            next[k] = Number(t);
    }
    const fresh = !(key in next);
    if (fresh)
        next[key] = nowMs;
    return {fresh, map: next};
}

/** Anota la clave en ~/.cache/kaito/finished.json; true si no estaba (hay que avisar). */
export function markFinished(key) {
    const prev = readJson(FINISHED_PATH, {});
    const {fresh, map} = markOnce(prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}, key, Date.now());
    if (fresh) {
        GLib.mkdir_with_parents(CACHE_DIR, 0o755);
        GLib.file_set_contents(FINISHED_PATH, JSON.stringify(map));
    }
    return fresh;
}

const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Puro. Líneas de la tarjeta "listo": [{text, warn}] (warn = naranja).
 * work: {branch, pushed, commits}; moved: estado destino o null; reason: por qué no se movió.
 */
export function finishLines({work, moved = null, reason = null, lastText = null, remindAt = null}) {
    const lines = [];
    const n = work.commits?.length ?? 0;
    lines.push({text: `Rama ${work.branch ?? '(sin rama)'} · ${work.pushed ? 'subida' : 'sin subir'}`, warn: !work.pushed});
    if (n)
        lines.push({text: `${n} ${n === 1 ? 'commit nuevo' : 'commits nuevos'} · ${work.commits[0].subject}`, warn: false});
    lines.push(moved ? {text: `Movido a ${moved}`, warn: false}
        : {text: `No se ha movido: ${reason ?? 'sin transición de revisión'}`, warn: true});
    if (remindAt)
        lines.push({text: `Te recuerdo revisarlo a las ${hhmm(remindAt)}`, warn: false});
    const last = firstLine(lastText);
    if (last)
        lines.push({text: last, warn: false, quote: true});
    return lines;
}

/** Puro. Texto del recordatorio para revisar el ticket. */
export const reviewReminderText = (key, summary) => (summary ? `Revisar ${key} · ${summary}` : `Revisar ${key}`);

/**
 * Lee el estado git de `cwd` (argv, sin shell): {head, branch, commits, upstream, pushed, remote, ts},
 * o null si no es un repo. commits = los de la rama con fecha >= sinceS (epoch en segundos).
 * `branch` (opcional): rama local concreta en vez de HEAD. ts = fecha (epoch s) de su último commit.
 */
export async function detectWork(cwd, sinceS, cancellable = null, branch = null) {
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || !GLib.file_test(cwd, GLib.FileTest.IS_DIR))
        return null;
    const rev = branch ? `refs/heads/${branch}` : 'HEAD';
    const head = await git(cwd, ['rev-parse', rev], cancellable);
    if (!head)
        return null;
    const ref = branch ?? await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], cancellable);
    const log = await git(cwd, ['log', `--since=@${Math.floor(sinceS)}`, '--format=%h %s', '--no-merges',
        `--max-count=${LOG_MAX}`, rev], cancellable);
    const up = branch ? `${branch}@{u}` : '@{u}';
    const upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', up], cancellable);
    const ahead = upstream ? await git(cwd, ['rev-list', '--count', `${up}..${rev}`], cancellable) : null;
    const remote = await git(cwd, ['remote', 'get-url', 'origin'], cancellable);
    const ts = Number(await git(cwd, ['log', '-1', '--format=%ct', rev], cancellable)) || 0;
    return {
        head, branch: ref && ref !== 'HEAD' ? ref : null, commits: parseLog(log),
        upstream: upstream || null, pushed: !!upstream && ahead === '0', remote: remote || null, ts,
    };
}

// --- Dónde se hizo el trabajo: el agente puede haber cambiado de repo respecto a su cwd ---

const TRANSCRIPT_MAX = 2 * 1024 * 1024;
const REPOS_MAX = 40;
const TRANSCRIPT_REPOS_MAX = 8;

/** Puro. Rutas absolutas con las que trabajó el agente, de la más reciente a la más antigua. */
export function pathsFromTranscript(text, home = GLib.get_home_dir()) {
    const out = [];
    const add = p => {
        if (typeof p !== 'string')
            return;
        let q = p.trim();
        if (q === '~' || q.startsWith('~/'))
            q = home + q.slice(1);
        if (q.startsWith('/') && !q.includes('\n') && q.length < 1024)
            out.push(q);
    };
    const unq = t => t.replace(/^(["'])(.*)\1$/, '$2');
    for (const line of String(text ?? '').split('\n')) {
        if (!line.includes('tool_use'))
            continue;
        let o;
        try {
            o = JSON.parse(line);
        } catch (_e) {
            continue; // línea cortada
        }
        const parts = Array.isArray(o?.message?.content) ? o.message.content : [];
        for (const c of parts) {
            if (c?.type !== 'tool_use' || !c.input || typeof c.input !== 'object')
                continue;
            add(c.input.file_path);
            add(c.input.notebook_path);
            if (typeof c.input.command === 'string') {
                const re = /(?:^|[;&|\s(])(?:cd|git\s+-C)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g;
                let m;
                while ((m = re.exec(c.input.command)) !== null)
                    add(unq(m[1]));
            }
        }
    }
    return [...new Set(out.reverse())];
}

/** Puro. Rutas → carpetas candidatas (un fichero → su carpeta), sin repetir ni anidar bajo otra ya vista. */
export function dirsFromPaths(paths, isDir) {
    const dirs = [];
    for (const p of paths) {
        let d = isDir(p) ? p : p.slice(0, p.lastIndexOf('/')) || '/';
        for (let i = 0; i < 8 && d.length > 1 && !isDir(d); i++)
            d = d.slice(0, d.lastIndexOf('/')) || '/';
        d = d.replace(/\/+$/, '');
        if (d.length > 1 && isDir(d) && !dirs.includes(d))
            dirs.push(d);
    }
    return dirs;
}

/**
 * Puro. Salida de `for-each-ref --format=%(refname:short) %(committerdate:unix)` → ramas cuyo nombre
 * contiene `key` (sin mayúsculas) con último commit >= sinceS, el más reciente primero: [{branch, ts}].
 */
export function ticketBranches(text, key, sinceS) {
    const k = String(key ?? '');
    if (!k)
        return [];
    const re = new RegExp(`(?<![a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`, 'i'); // RUN-5 no casa con RUN-50
    const found = [];
    for (const l of String(text ?? '').split('\n')) {
        const i = l.lastIndexOf(' ');
        if (i < 1)
            continue;
        const branch = l.slice(0, i).trim(), ts = Number(l.slice(i + 1));
        if (Number.isFinite(ts) && ts >= sinceS && re.test(branch))
            found.push({branch, ts});
    }
    return found.sort((a, b) => b.ts - a.ts);
}

async function readTranscript(path, cancellable) {
    try {
        const file = Gio.File.new_for_path(path);
        const size = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
        const stream = file.read(null);
        try {
            if (size > TRANSCRIPT_MAX)
                stream.seek(size - TRANSCRIPT_MAX, GLib.SeekType.SET, null);
            const bytes = await new Promise((resolve, reject) => stream.read_bytes_async(TRANSCRIPT_MAX, GLib.PRIORITY_DEFAULT, cancellable,
                (s, res) => {
                    try {
                        resolve(s.read_bytes_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }));
            const text = new TextDecoder().decode(bytes.toArray());
            return size > TRANSCRIPT_MAX ? text.slice(text.indexOf('\n') + 1) : text;
        } finally {
            stream.close(null);
        }
    } catch (_e) {
        return '';
    }
}

let repoCache = null; // {t, list, roots}
function knownRepos(roots) {
    const now = GLib.get_monotonic_time() / 1e6;
    if (!repoCache || now - repoCache.t > 300 || repoCache.roots !== JSON.stringify(roots)) {
        let list = [];
        try {
            list = collectRepos(30, REPOS_MAX).map(r => r.path);
            const seen = new Set(list);
            for (const r of scanRepos(roots))
                if (!seen.has(r.path))
                    list.push(r.path);
        } catch (e) {
            console.warn(`kaito: repos: ${e.message}`);
        }
        repoCache = {t: now, list, roots: JSON.stringify(roots)};
    }
    return repoCache.list;
}

/** Mejor rama del ticket en `repo` con commits desde sinceS, o null. */
async function ticketWorkIn(repo, key, sinceS, cancellable) {
    const refs = await git(repo, ['for-each-ref', '--format=%(refname:short) %(committerdate:unix)', 'refs/heads'], cancellable);
    for (const {branch} of ticketBranches(refs, key, sinceS)) {
        const work = await detectWork(repo, sinceS, cancellable, branch);
        if (work?.commits.length)
            return work;
    }
    return null;
}

/**
 * ¿Dónde trabajó el agente de `key`? Orden: cwd (ramas del ticket, o su rama actual con commits nuevos),
 * repos del transcript (se para en el primero con rama del ticket) y, si nada, todos los repos conocidos.
 * Devuelve {repo, ...detectWork} o null. `opts`: {sessionId, roots}.
 */
export async function findTicketWork(cwd, key, sinceS, cancellable = null, {sessionId = null, roots = []} = {}) {
    const tried = new Set();
    const ok = () => !cancellable?.is_cancelled();
    const top = async dir => {
        const t = await git(dir, ['rev-parse', '--show-toplevel'], cancellable);
        return t && !tried.has(t) ? t : null;
    };
    let fallback = null;
    if (typeof cwd === 'string' && cwd.startsWith('/')) {
        const root = await top(cwd);
        if (root) {
            tried.add(root);
            const w = await ticketWorkIn(root, key, sinceS, cancellable);
            if (w)
                return {repo: root, ...w};
            const cur = await detectWork(cwd, sinceS, cancellable);
            if (cur?.commits.length)
                fallback = {repo: root, ...cur};
        }
    }
    if (!ok())
        return null;
    if (sessionId && typeof cwd === 'string') {
        const file = GLib.build_filenamev([CLAUDE_PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`]);
        const isDir = p => GLib.file_test(p, GLib.FileTest.IS_DIR);
        const dirs = dirsFromPaths(pathsFromTranscript(await readTranscript(file, cancellable)), isDir);
        let n = 0;
        for (const d of dirs) {
            if (!ok() || n >= TRANSCRIPT_REPOS_MAX)
                break;
            const root = await top(d);
            if (!root)
                continue;
            tried.add(root);
            n++;
            const w = await ticketWorkIn(root, key, sinceS, cancellable);
            if (w)
                return {repo: root, ...w};
        }
    }
    if (fallback || !ok())
        return fallback;
    for (const r of knownRepos(roots).slice(0, REPOS_MAX)) {
        if (!ok())
            return null;
        if (tried.has(r))
            continue;
        tried.add(r);
        const w = await ticketWorkIn(r, key, sinceS, cancellable);
        if (w)
            return {repo: r, ...w};
    }
    return null;
}
