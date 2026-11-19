// Cuando un agente lanzado con un ticket termina: ¿ha dejado commits? ¿está subida la rama?
// Lógica pura (URL de PR, parseo, deduplicado, líneas de la tarjeta) + lectura de git sin shell.
// Solo gi:// y módulos locales: se prueba con gjs (kaito.test.js).
import GLib from 'gi://GLib';

import {CACHE_DIR, readJson} from './common.js';
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
 * Lee el estado git de `cwd` (argv, sin shell): {head, branch, commits, upstream, pushed, remote},
 * o null si no es un repo. commits = los de HEAD con fecha >= sinceS (epoch en segundos).
 */
export async function detectWork(cwd, sinceS, cancellable = null) {
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || !GLib.file_test(cwd, GLib.FileTest.IS_DIR))
        return null;
    const head = await git(cwd, ['rev-parse', 'HEAD'], cancellable);
    if (!head)
        return null;
    const ref = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], cancellable);
    const log = await git(cwd, ['log', `--since=@${Math.floor(sinceS)}`, '--format=%h %s', '--no-merges',
        `--max-count=${LOG_MAX}`, 'HEAD'], cancellable);
    const upstream = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cancellable);
    const ahead = upstream ? await git(cwd, ['rev-list', '--count', '@{u}..HEAD'], cancellable) : null;
    const remote = await git(cwd, ['remote', 'get-url', 'origin'], cancellable);
    return {
        head, branch: ref && ref !== 'HEAD' ? ref : null, commits: parseLog(log),
        upstream: upstream || null, pushed: !!upstream && ahead === '0', remote: remote || null,
    };
}
