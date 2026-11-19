// Proveedores de agentes (Claude Code, Codex, Gemini…): detección y lectura de sesiones de Codex.
// Lógica pura (sin imports de gi ni de la shell): se prueba con node y gjs. Las sondas reales están en common.js.

/**
 * level: 'full' (hooks: estado, te necesita, Permitir/Denegar) · 'sessions' (trabajando/parado y última acción) ·
 * 'process' (sesión abierta y carpeta). bins: nombres del ejecutable (y del script si va con node/python/bun).
 */
export const PROVIDERS = [
    {id: 'claude', name: 'Claude', title: 'Claude Code', level: 'full', bins: ['claude']},
    {id: 'codex', name: 'Codex', title: 'Codex', level: 'sessions', bins: ['codex']},
    {id: 'gemini', name: 'Gemini', title: 'Gemini CLI', level: 'process', bins: ['gemini']},
    {id: 'opencode', name: 'OpenCode', title: 'OpenCode', level: 'process', bins: ['opencode']},
    {id: 'aider', name: 'Aider', title: 'Aider', level: 'process', bins: ['aider']},
    {id: 'cursor', name: 'Cursor', title: 'Cursor Agent', level: 'process', bins: ['cursor-agent']},
];
export const PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map(p => [p.id, p]));

export const LEVEL_TEXT = {
    full: 'Completo: estado, te necesita, Permitir/Denegar',
    sessions: 'Sesiones: trabajando/parado y última acción',
    process: 'Básico: sesión abierta y carpeta',
};

/**
 * Carpetas donde buscar los ejecutables: $PATH y las habituales de instaladores de usuario (la shell de GNOME
 * no hereda el PATH de ~/.bashrc). nvmBins: carpetas ~/.nvm/versions/node/<v>/bin ya listadas.
 */
export function searchDirs(home, envPath = '', nvmBins = []) {
    const dirs = [...String(envPath ?? '').split(':'),
        `${home}/.local/bin`, `${home}/.npm-global/bin`, `${home}/.bun/bin`, `${home}/.opencode/bin`,
        `${home}/.cargo/bin`, `${home}/.volta/bin`, ...nvmBins, '/usr/local/bin', '/usr/bin'];
    return [...new Set(dirs.filter(d => d && d.startsWith('/')))];
}

/** Puro. probe(bin) → ruta o null. → [{...proveedor, path, installed}] en el orden de PROVIDERS. */
export function detectProviders(probe) {
    return PROVIDERS.map(p => {
        let path = null;
        for (const b of p.bins) {
            try {
                path = probe(b) ?? null;
            } catch (_e) {
                path = null;
            }
            if (path)
                break;
        }
        return {...p, path, installed: !!path};
    });
}

/** Puro. Config agentProviders → {id: bool}; todo activado por defecto. */
export function normalizeProviderToggles(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return Object.fromEntries(PROVIDERS.map(p => [p.id, r[p.id] !== false]));
}

const INTERPRETERS = /^(node|nodejs|bun|deno|python3?(\.\d+)?|uv|npx)$/;
// Subcomandos que no son una sesión interactiva (servidores, utilidades, ejecuciones en segundo plano).
const NOT_SESSION = {
    codex: new Set(['app-server', 'exec-server', 'exec', 'e', 'mcp', 'mcp-server', 'remote-control', 'login', 'logout',
        'completion', 'sandbox', 'debug', 'doctor', 'update', 'features', 'apply', 'a', 'cloud', 'review', 'help', '--help', '-h', '--version', '-V']),
    gemini: new Set(['mcp', '--help', '-h', '--version', '-v']),
    opencode: new Set(['serve', 'web', 'mcp', 'auth', 'upgrade', 'models', 'stats', 'export', 'import', 'github', 'acp', '--help', '-h', '--version', '-v']),
    aider: new Set(['--help', '-h', '--version']),
    cursor: new Set(['--help', '-h', '--version', '-v', 'login', 'logout', 'status', 'mcp', 'update']),
};
const base = s => String(s ?? '').split('/').pop().replace(/\.(m?js|cjs|py)$/, '');

/**
 * Puro. Proveedor (id, sin 'claude': Claude se lee de su registro de sesiones) de un proceso a partir de su
 * cmdline (argv) y comm; null si no es una sesión de agente. Con node/python/bun se mira el script.
 */
export function matchAgentProcess(argv, comm = '') {
    if (!Array.isArray(argv) || !argv.length)
        return null;
    let i = 0;
    if (INTERPRETERS.test(base(argv[0]))) {
        i = 1;
        while (i < argv.length && String(argv[i]).startsWith('-'))
            i++; // node --no-warnings script.js
    }
    const name = base(argv[i]) || base(comm);
    const p = PROVIDERS.find(x => x.id !== 'claude' && x.bins.some(b => b === name));
    if (!p)
        return null;
    const sub = argv.slice(i + 1).find(a => !String(a).startsWith('-')) ?? '';
    const flag = argv.slice(i + 1).find(a => NOT_SESSION[p.id]?.has(a) && String(a).startsWith('-'));
    if (flag || NOT_SESSION[p.id]?.has(sub))
        return null;
    return p.id;
}

/**
 * Puro. De [{pid, ppid, provider}] quita los que tienen un descendiente directo del mismo proveedor
 * (el lanzador de node que arranca el binario nativo): queda uno por sesión, el que abre el rollout.
 */
export function dedupeProcesses(list) {
    const parents = new Set(list.map(p => `${p.provider}:${p.ppid}`));
    return list.filter(p => !parents.has(`${p.provider}:${p.pid}`));
}

const trunc = (s, n = 60) => {
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const firstLineOf = (s, n) => trunc(String(s ?? '').split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '', n);

/** Puro. Cabecera de un rollout (primera línea session_meta) → {id, cwd, startedMs} o null. */
export function parseRolloutMeta(text) {
    for (const line of String(text ?? '').split('\n').slice(0, 5)) {
        if (!line.includes('session_meta'))
            continue;
        try {
            const o = JSON.parse(line);
            const p = o?.payload;
            if (o?.type === 'session_meta' && p && typeof p === 'object') {
                const startedMs = Date.parse(p.timestamp ?? o.timestamp);
                return {id: String(p.id ?? p.session_id ?? '') || null, cwd: typeof p.cwd === 'string' ? p.cwd : null,
                    startedMs: Number.isFinite(startedMs) ? startedMs : null};
            }
        } catch (_e) {
            // Línea cortada (base_instructions es largo): basta con la clave cwd, que no puede salir escapada.
            const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
            if (m) {
                try {
                    return {id: /"id":"([0-9a-f-]{36})"/.exec(line)?.[1] ?? null, cwd: JSON.parse(`"${m[1]}"`), startedMs: null};
                } catch (_e2) { /* escape raro */ }
            }
        }
    }
    return null;
}

/** Puro. Id de sesión del nombre del rollout (rollout-2026-11-13T11-22-39-<uuid>.jsonl), o null. */
export function rolloutId(path) {
    return /rollout-[\dT-]+?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(String(path))?.[1] ?? null;
}

/** Acción corta de un evento de Codex (versiones nuevas: item_completed; antiguas: function_call, agent_message). */
function actionOf(o) {
    const p = o?.payload;
    if (!p || typeof p !== 'object')
        return null;
    if (o.type === 'event_msg' && p.type === 'item_completed') {
        const it = p.item ?? {};
        if (it.type === 'CommandExecution') {
            const c = Array.isArray(it.command) ? it.command.at(-1) : it.command;
            return c ? trunc(`$ ${String(c).split('\n')[0]}`) : null;
        }
        if (it.type === 'FileChange') {
            const files = Object.keys(it.changes ?? {});
            return files.length === 1 ? trunc(`Edit ${files[0].split('/').pop()}`) : `Edit ${files.length} ficheros`;
        }
        if (it.type === 'AgentMessage') {
            const t = (it.content ?? []).filter(b => typeof b?.text === 'string').map(b => b.text).join('\n');
            return t.trim() ? firstLineOf(t, 60) : null;
        }
        if (it.type === 'Extension' && typeof it.kind === 'string')
            return trunc(it.kind);
        return null;
    }
    if (o.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string')
        return firstLineOf(p.message, 60);
    if (o.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call') && p.name)
        return trunc(String(p.name));
    return null;
}

/**
 * Puro. Cola de un rollout de Codex → {lastAction, lastText, turnOpen, lastStartMs, lastCompleteMs, lastEventMs}.
 * turnOpen: hay un task_started sin su task_complete/turn_aborted (Codex está trabajando). lastText: primera línea
 * (≤ 160) del último mensaje final. Solo texto corto: nunca se guarda el contenido de la conversación.
 */
export function parseCodexTail(text) {
    const lines = String(text ?? '').split('\n');
    const out = {lastAction: null, lastText: null, turnOpen: false, lastStartMs: null, lastCompleteMs: null, lastEventMs: null};
    let turnSeen = false;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.trim())
            continue;
        let o;
        try {
            o = JSON.parse(line);
        } catch (_e) {
            continue; // la primera puede venir cortada
        }
        const ts = Date.parse(o?.timestamp);
        if (out.lastEventMs === null && Number.isFinite(ts))
            out.lastEventMs = ts;
        const p = o?.payload;
        if (o?.type === 'event_msg' && p && !turnSeen) {
            if (p.type === 'task_started') {
                turnSeen = true;
                out.turnOpen = true;
                out.lastStartMs = Number.isFinite(ts) ? ts : null;
            } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
                turnSeen = true;
                out.lastCompleteMs = Number.isFinite(ts) ? ts : null;
                if (p.type === 'task_complete' && typeof p.last_agent_message === 'string' && out.lastText === null)
                    out.lastText = firstLineOf(p.last_agent_message, 160) || null;
            }
        }
        if (out.lastAction === null)
            out.lastAction = actionOf(o);
        if (turnSeen && out.lastAction !== null)
            break;
    }
    return out;
}

/**
 * Puro. Estado de una sesión de Codex: trabajando si hay un turno abierto reciente (< staleS) o el rollout cambió
 * hace menos de liveS; hook: estado "done" escrito por hooks/kaito-codex-notify.py (gana si es posterior).
 * → {live, state: 'working'|'done'|'idle'}
 */
export function codexStatus({tail, mtimeMs, nowMs, liveS = 60, staleS = 15 * 60, hook = null}) {
    const age = (nowMs - mtimeMs) / 1000;
    const hookTs = Number(hook?.ts) * 1000;
    const doneByHook = hook?.state === 'done' && Number.isFinite(hookTs) && hookTs >= (tail?.lastStartMs ?? 0);
    if (doneByHook && hookTs >= mtimeMs - 2000)
        return {live: false, state: 'done'};
    const turnKnown = !!(tail?.lastStartMs || tail?.lastCompleteMs || tail?.turnOpen);
    // Turno abierto: trabajando (salvo rollout parado hace mucho: Codex murió a mitad). Sin datos de turno: mtime.
    if (tail?.turnOpen ? age < staleS : !turnKnown && age < liveS)
        return {live: true, state: 'working'};
    return {live: false, state: doneByHook || tail?.lastCompleteMs ? 'done' : 'idle'};
}
