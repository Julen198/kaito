// Código compartido entre extension.js (gnome-shell) y prefs.js (proceso gjs aparte).
// Solo puede importar módulos gi:// y locales puros: nada de resource:///org/gnome/shell/.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';

import {parseTail, ticketFromHead} from './agents.js';
import {normalizeWorkHours, snoozeMinutesOr} from './quiet.js';
import {gitInstructions, migrateTodos, newTask, splitExisting} from './board.js';
import {normalizeInbox} from './inbox.js';
import {USAGE_COLORS, usageColor, formatReset, opencodeProvider, normalizePanelProvider} from './usage.js';
import {
    detectProviders, searchDirs, normalizeProviderToggles, matchAgentProcess, dedupeProcesses,
    parseRolloutMeta, parseCodexTail, codexStatus, rolloutId,
} from './providers.js';

Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

export const DEFAULTS = {agentWindowMinutes: 10, liveSeconds: 60, refreshSeconds: 30, jiraMax: 20};
const STATE_MAX_AGE_S = 24 * 3600;
export const PRESETS = [
    {id: 'open', title: 'Mis tickets abiertos',
        jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'},
    {id: 'progress', title: 'Solo en curso',
        jql: 'assignee=currentUser() AND statusCategory="In Progress" ORDER BY updated DESC'},
    {id: 'sprint', title: 'Sprint actual',
        jql: 'assignee=currentUser() AND sprint in openSprints() AND resolution=Unresolved ORDER BY rank'},
    {id: 'custom', title: 'Consulta JQL propia', jql: null},
];
export const DEFAULT_JQL = PRESETS[0].jql;
export const CONF_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'kaito']);
// Migración única desde el nombre antiguo (~/.config/focuser): copia, no mueve.
{
    const oldDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'focuser']);
    if (!GLib.file_test(CONF_DIR, GLib.FileTest.EXISTS) && GLib.file_test(oldDir, GLib.FileTest.IS_DIR)) {
        GLib.mkdir_with_parents(CONF_DIR, 0o755);
        for (const f of ['config.json', 'todos.json', 'notes.json', 'reminders.json']) {
            try {
                Gio.File.new_for_path(GLib.build_filenamev([oldDir, f]))
                    .copy(Gio.File.new_for_path(GLib.build_filenamev([CONF_DIR, f])), Gio.FileCopyFlags.NONE, null, null);
            } catch (_e) { /* el fichero antiguo puede no existir */ }
        }
    }
}
export const TODOS_PATH = GLib.build_filenamev([CONF_DIR, 'todos.json']);
export const NOTES_PATH = GLib.build_filenamev([CONF_DIR, 'notes.json']);
export const REMINDERS_PATH = GLib.build_filenamev([CONF_DIR, 'reminders.json']);
export const CONFIG_PATH = GLib.build_filenamev([CONF_DIR, 'config.json']);
// Tareas programadas (tasks.js): definición en config, historial de ejecuciones en datos.
export const TASKS_PATH = GLib.build_filenamev([CONF_DIR, 'tasks.json']);
export const TASK_RUNS_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'kaito', 'task-runs']);
// Estados escritos por hooks/kaito-hook.py (mismo criterio: XDG_CACHE_HOME o ~/.cache).
export const STATE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'kaito', 'state']);
export const CLAUDE_PROJECTS = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects']);

export const CLAUDE_SESSIONS = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'sessions']);
export const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'kaito']);
export const DISMISSED_PATH = GLib.build_filenamev([CACHE_DIR, 'dismissed.json']);
export const PROMPTS_DIR = GLib.build_filenamev([CACHE_DIR, 'prompts']);
// Respuestas a PermissionRequest que lee hooks/kaito-hook.py.
export const DECISIONS_DIR = GLib.build_filenamev([CACHE_DIR, 'decisions']);
export const CLAUDE_USAGE_PATH = GLib.build_filenamev([CACHE_DIR, 'claude-usage.json']); // lo escribe hooks/kaito-statusline.py
export const CODEX_SESSIONS = GLib.build_filenamev([GLib.get_home_dir(), '.codex', 'sessions']);
export const DAILY_PATH = GLib.build_filenamev([CACHE_DIR, 'daily.json']);
export const WARP_LAUNCH_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'warp-terminal', 'launch_configurations']);
// Tab Configs de Warp (sustituyen a las launch configurations): warp://tab_config/<nombre> abre una
// PESTAÑA nueva en la ventana activa (o una ventana si no hay ninguna). https://docs.warp.dev/terminal/windows/tab-configs
export const WARP_TAB_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'warp-terminal', 'tab_configs']);
// auto: exacta (ptyxis >= 52, gnome-terminal) > warp > ptyxis < 52 > kgx · ptyxis/gnome-terminal/kgx: pestaña ·
// warp: pestaña (Tab Config) · warp-window: ventana nueva (launch configuration, el modo antiguo).
export const TERMINALS = ['auto', 'ptyxis', 'gnome-terminal', 'kgx', 'warp', 'warp-window'];
const WARP_TAB_KEEP_S = 10 * 60; // los .toml de kaito se borran pasado esto (salen en el menú + de Warp)
export const PTYXIS_FLATPAK = 'app.devsuite.Ptyxis';

const TAIL_BYTES = 64 * 1024;
const HEAD_BYTES = 256 * 1024; // el primer mensaje puede ir tras adjuntos de SessionStart

// secret-tool guarda con el esquema genérico de libsecret; con DONT_MATCH_NAME
// la búsqueda ignora el nombre del esquema y casa solo por atributos.
export const JIRA_SCHEMA = new Secret.Schema('org.freedesktop.Secret.Generic',
    Secret.SchemaFlags.DONT_MATCH_NAME, {service: Secret.SchemaAttributeType.STRING});

export function readJson(path, fallback) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : fallback;
    } catch (_e) {
        return fallback;
    }
}

export function writeJson(path, data) {
    GLib.mkdir_with_parents(CONF_DIR, 0o755);
    GLib.file_set_contents(path, JSON.stringify(data, null, 2));
}

export const REPO_ROOT_CANDIDATES = ['Documentos', 'Documents', 'dev', 'code', 'projects', 'src'];

/** Carpetas de código habituales que existan en $HOME (si ninguna, ~/Documentos como antes). */
export function defaultRepoRoots(home = GLib.get_home_dir(), isDir = p => GLib.file_test(p, GLib.FileTest.IS_DIR)) {
    const found = REPO_ROOT_CANDIDATES.map(d => GLib.build_filenamev([home, d])).filter(isDir);
    return found.length ? found : [GLib.build_filenamev([home, 'Documentos'])];
}

/** Puro. "gembiratech" → https://gembiratech.atlassian.net; añade https:// y quita barras finales. */
export function normalizeJiraUrl(v) {
    let s = String(v ?? '').trim().replace(/\/+$/, '');
    if (!s)
        return '';
    if (!/^https?:\/\//i.test(s))
        s = `https://${s.includes('.') ? s : `${s}.atlassian.net`}`;
    return s;
}

/** Config con valores por defecto aplicados (numéricos validados). */
export function readConfig() {
    const raw = readJson(CONFIG_PATH, {}) ?? {};
    const cfg = {...raw};
    cfg.jiraBaseUrl = normalizeJiraUrl(raw.jiraBaseUrl);
    for (const [k, d] of Object.entries(DEFAULTS)) {
        const n = Number(raw[k]);
        cfg[k] = Number.isFinite(n) && n > 0 ? n : d;
    }
    cfg.notifyNeeds = raw.notifyNeeds !== false;
    cfg.notifyDone = raw.notifyDone !== false;
    cfg.autoReview = raw.autoReview !== false;
    const rm = Number(raw.reviewReminderMinutes);
    cfg.reviewReminderMinutes = Number.isFinite(rm) && rm >= 0 ? Math.round(rm) : 30;
    cfg.snoozeMinutes = snoozeMinutesOr(raw.snoozeMinutes);
    cfg.dailySummary = raw.dailySummary !== false;
    cfg.pinned = raw.pinned === true;
    cfg.showUsage = raw.showUsage !== false;
    cfg.usagePanelProvider = normalizePanelProvider(raw.usagePanelProvider);
    cfg.tasksEnabled = raw.tasksEnabled !== false;
    cfg.checkUpdates = raw.checkUpdates !== false;
    cfg.jiraEnabled = raw.jiraEnabled !== false;
    cfg.kanbanEnabled = raw.kanbanEnabled === true; // opcional: tablero de tareas
    cfg.inboxEnabled = raw.inboxEnabled === true; // opcional: panel de avisos
    cfg.workHours = normalizeWorkHours(raw.workHours);
    cfg.dndManual = raw.dndManual === true;
    for (const k of ['dndUntil', 'dndSkipUntil']) {
        const v = Number(raw[k]);
        cfg[k] = Number.isFinite(v) && v > 0 ? v : null;
    }
    cfg.dndSilenceReminders = raw.dndSilenceReminders === true;
    cfg.agentProviders = normalizeProviderToggles(raw.agentProviders);
    cfg.captureMode = ['reminder', 'jira', 'task'].includes(raw.captureMode) ? raw.captureMode : 'note';
    cfg.terminal = TERMINALS.includes(raw.terminal) ? raw.terminal : 'auto';
    cfg.jiraView = typeof raw.jiraView === 'string' && raw.jiraView ? raw.jiraView : 'mine';
    cfg.jiraViews = normalizeCustomViews(raw.jiraViews);
    cfg.jiraBuiltinViews = {...BUILTIN_VIEW_DEFAULTS, ...(raw.jiraBuiltinViews && typeof raw.jiraBuiltinViews === 'object' ? raw.jiraBuiltinViews : {})};
    cfg.jiraProjects = Array.isArray(raw.jiraProjects) ? raw.jiraProjects.filter(k => PROJECT_RE.test(String(k))) : [];
    cfg.jiraRepoByProject = raw.jiraRepoByProject && typeof raw.jiraRepoByProject === 'object'
        ? raw.jiraRepoByProject : {};
    cfg.repoRoots = Array.isArray(raw.repoRoots) && raw.repoRoots.every(r => typeof r === 'string') && raw.repoRoots.length
        ? raw.repoRoots : defaultRepoRoots();
    cfg.jiraRepoByIssue = raw.jiraRepoByIssue && typeof raw.jiraRepoByIssue === 'object'
        ? raw.jiraRepoByIssue : {};
    // Un preset guardado manda sobre el jiraJql copiado en su día (así se actualizan los presets).
    const preset = PRESETS.find(p => p.id === raw.jiraPreset && p.jql);
    if (preset)
        cfg.jiraJql = preset.jql;
    else if (typeof cfg.jiraJql !== 'string' || !cfg.jiraJql.trim())
        cfg.jiraJql = DEFAULT_JQL;
    return cfg;
}

/** Lectura-modificación-escritura: conserva las claves desconocidas. */
export function updateConfig(patch) {
    const raw = readJson(CONFIG_PATH, {}) ?? {};
    writeJson(CONFIG_PATH, {...raw, ...patch});
}

/**
 * Puro. Migración única del terminal: un 'warp' guardado (el antiguo valor por defecto) pasa a 'auto'
 * para que los agentes lanzados desde Kaito se abran en pestañas con foco exacto. Devuelve el parche o null.
 * Tras migrar (o si no había nada que migrar) se marca terminalMigrated: elegir Warp después se respeta.
 */
export function terminalMigration(raw) {
    if (!raw || typeof raw !== 'object' || raw.terminalMigrated)
        return null;
    return raw.terminal === 'warp' ? {terminal: 'auto', terminalMigrated: true} : {terminalMigrated: true};
}

/** Aplica terminalMigration a config.json (idempotente). Devuelve el parche aplicado o null. */
export function migrateTerminalOnce() {
    const raw = readJson(CONFIG_PATH, null);
    if (!raw)
        return null; // sin config todavía: 'auto' ya es el valor por defecto
    const patch = terminalMigration(raw);
    if (patch)
        updateConfig(patch);
    return patch;
}

// --- Notas y recordatorios (captura rápida) ---

export const readNotes = () => {
    const v = readJson(NOTES_PATH, []);
    return Array.isArray(v) ? v : [];
};

export const readReminders = () => {
    const v = readJson(REMINDERS_PATH, []);
    return Array.isArray(v) ? v : [];
};

export function addNote(text) {
    writeJson(NOTES_PATH, [...readNotes(), {text, ts: Date.now()}]);
}

export function addReminder(text, due) {
    const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    writeJson(REMINDERS_PATH, [...readReminders(), {id, text, due: due.toISOString(), done: false, snoozes: 0}]);
}

/** Lectura-modificación-escritura de un recordatorio por id. */
export function patchReminder(id, fn) {
    const list = readReminders();
    const r = list.find(x => x.id === id);
    if (!r)
        return;
    fn(r);
    writeJson(REMINDERS_PATH, list);
}

export function getToken() {
    return Secret.password_lookup(JIRA_SCHEMA, {service: 'jira'}, null);
}

export function storeToken(token) {
    return Secret.password_store(JIRA_SCHEMA, {service: 'jira'}, Secret.COLLECTION_DEFAULT,
        'Kaito Jira', token, null);
}

/** GET autenticado contra Jira; devuelve el JSON. Lanza Error con mensaje legible. */
export async function jiraGet(session, cfg, token, path) {
    const base = cfg.jiraBaseUrl.replace(/\/+$/, '');
    const msg = Soup.Message.new('GET', `${base}${path}`);
    const auth = GLib.base64_encode(new TextEncoder().encode(`${cfg.jiraEmail}:${token}`));
    msg.get_request_headers().append('Authorization', `Basic ${auth}`);
    msg.get_request_headers().append('Accept', 'application/json');
    const bytes = await session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    const status = msg.get_status();
    if (status === 401 || status === 403)
        throw new Error(`HTTP ${status}: credenciales no válidas`);
    if (status !== Soup.Status.OK) {
        let detail = '';
        try {
            detail = JSON.parse(new TextDecoder().decode(bytes.get_data())).errorMessages?.[0] ?? '';
        } catch (_e) { /* cuerpo no JSON */ }
        throw new Error(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
    }
    return JSON.parse(new TextDecoder().decode(bytes.get_data()));
}

// --- Vistas de Jira ---

export const BUILTIN_VIEWS = [
    {id: 'mine', name: 'Mías'},
    {id: 'unassigned', name: 'Sin asignar'},
    {id: 'sprint', name: 'Sprint'},
    {id: 'recent', name: 'Recientes'},
];
const BUILTIN_VIEW_DEFAULTS = {unassigned: true, sprint: true, recent: true};
const PROJECT_RE = /^[A-Z][A-Z0-9_]*$/;
const VIEW_ORDER = 'ORDER BY priority DESC, updated DESC';
export const RECENT_JQL = '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) ' +
    'AND updated >= -24h ORDER BY updated DESC';

/** Puro. Vistas propias válidas: [{id, name, jql, enabled}]. */
export function normalizeCustomViews(list) {
    if (!Array.isArray(list))
        return [];
    const seen = new Set();
    const out = [];
    for (const v of list) {
        if (!v || typeof v !== 'object')
            continue;
        const id = String(v.id ?? '').trim();
        if (!id || seen.has(id) || BUILTIN_VIEWS.some(b => b.id === id))
            continue;
        seen.add(id);
        out.push({id, name: String(v.name ?? '').trim(), jql: String(v.jql ?? '').trim(), enabled: v.enabled !== false});
    }
    return out;
}

/** Puro. Claves de proyecto distintas (ordenadas) de una lista de tickets. */
export function projectsFromIssues(issues) {
    return [...new Set((issues ?? []).map(i => projectOf(i.key)).filter(k => PROJECT_RE.test(k)))].sort();
}

/** Puro. JQL de una vista integrada ('mine' usa la JQL de Ajustes). null si faltan proyectos. */
export function viewJql(id, {projects = [], mineJql = DEFAULT_JQL} = {}) {
    const keys = projects.filter(k => PROJECT_RE.test(String(k)));
    const inProjects = keys.length ? `project in (${keys.map(k => `"${k}"`).join(', ')})` : null;
    switch (id) {
    case 'mine':
        return mineJql;
    case 'unassigned':
        return inProjects && `${inProjects} AND assignee is EMPTY AND statusCategory != Done ${VIEW_ORDER}`;
    case 'sprint':
        return inProjects && `${inProjects} AND sprint in openSprints() AND statusCategory != Done ${VIEW_ORDER}`;
    case 'recent':
        return RECENT_JQL;
    default:
        return null;
    }
}

/** Puro. Pestañas visibles en orden: [{id, name, custom, jql?}]. "Mías" siempre está. */
export function visibleViews(cfg) {
    const on = {...BUILTIN_VIEW_DEFAULTS, ...(cfg?.jiraBuiltinViews ?? {})};
    const out = BUILTIN_VIEWS.filter(v => v.id === 'mine' || on[v.id] !== false).map(v => ({...v, custom: false}));
    for (const v of normalizeCustomViews(cfg?.jiraViews)) {
        if (v.enabled && v.jql)
            out.push({id: v.id, name: v.name || 'Vista', custom: true, jql: v.jql});
    }
    return out;
}

/** Puro. "Julen Pérez García" -> "Julen P."; vacío -> "". */
export function shortName(name) {
    const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length)
        return '';
    return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[1][0].toUpperCase()}.`;
}

export const JIRA_PROJECTS_CACHE = GLib.build_filenamev([CACHE_DIR, 'jira-projects.json']);

/**
 * Proyectos para las vistas de equipo: los vistos en tus tickets (`seen`; se guardan en caché),
 * si no hay, los de la última caché y, si tampoco, `jiraProjects` de la config.
 */
export function resolveProjects(seen, cfg) {
    const cached = readJson(JIRA_PROJECTS_CACHE, null)?.projects;
    if (seen?.length) {
        const merged = [...new Set(seen)].filter(k => PROJECT_RE.test(k)).sort();
        if (JSON.stringify(merged) !== JSON.stringify(cached)) {
            try {
                GLib.mkdir_with_parents(CACHE_DIR, 0o755);
                GLib.file_set_contents(JIRA_PROJECTS_CACHE, JSON.stringify({projects: merged}));
            } catch (e) {
                console.warn(`kaito: caché de proyectos: ${e.message}`);
            }
        }
        return merged;
    }
    if (Array.isArray(cached) && cached.length)
        return cached.filter(k => PROJECT_RE.test(String(k)));
    return cfg?.jiraProjects ?? [];
}

const SEARCH_FIELDS = 'summary,status,priority,description,labels,components,updated,assignee,issuetype';

/** Puro. Ticket de la búsqueda de Jira -> objeto que pinta la extensión. */
export function mapSearchIssue(i) {
    const a = i.fields?.assignee;
    return {
        key: i.key,
        summary: i.fields?.summary ?? '',
        status: i.fields?.status?.name ?? '?',
        category: i.fields?.status?.statusCategory?.key ?? 'new',
        priority: i.fields?.priority ? {id: String(i.fields.priority.id ?? ''), name: i.fields.priority.name ?? ''} : null,
        labels: i.fields?.labels ?? [],
        components: (i.fields?.components ?? []).map(c => c.name ?? ''),
        updated: i.fields?.updated ?? null,
        assignee: a ? {accountId: a.accountId ?? null, displayName: a.displayName ?? ''} : null,
        issuetype: i.fields?.issuetype?.name ?? '',
        text: adfToText(i.fields?.description).slice(0, 2000), // ponytail: only used to rank repos
    };
}

/** Puro. Primeras `maxLines` líneas no vacías (máx. `maxChars` caracteres, con «…») de un texto plano. */
export function descriptionSnippet(text, maxLines = 4, maxChars = 300) {
    const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean);
    let out = lines.slice(0, maxLines).join('\n');
    const cut = lines.length > maxLines || out.length > maxChars;
    if (out.length > maxChars)
        out = out.slice(0, maxChars).trimEnd();
    return cut ? `${out}…` : out;
}

/** Puro. Línea del detalle: prioridad · estado · tipo · responsable (solo si no es `myId`). */
export function ticketDetailLine(issue, myId = null) {
    const a = issue?.assignee;
    const other = a && !(myId !== null && a.accountId === myId) ? shortName(a.displayName) : '';
    return [issue?.priority?.name, issue?.status, issue?.issuetype, other].filter(Boolean).join(' · ');
}

/** Devuelve {setup} si falta config/token, o {base, issues} de la JQL dada (ordenados con sortIssues). */
export async function fetchJiraJql(session, jql, max = null) {
    const cfg = readJson(CONFIG_PATH, null);
    if (!cfg?.jiraBaseUrl || !cfg?.jiraEmail)
        return {setup: 'Falta configurar Jira: abre Ajustes'};
    const token = await getToken();
    if (!token)
        return {setup: 'Sin token en el llavero: abre Ajustes'};
    const n = max ?? readConfig().jiraMax;
    const data = await jiraGet(session, cfg, token,
        `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${SEARCH_FIELDS}&maxResults=${n}`);
    return {base: cfg.jiraBaseUrl.replace(/\/+$/, ''), issues: sortIssues((data.issues ?? []).map(mapSearchIssue))};
}

/** Devuelve {setup} si falta config/token, o {base, issues} ("Mías": la JQL de Ajustes). */
export function fetchJira(session) {
    return fetchJiraJql(session, readConfig().jiraJql);
}

/** Comprobación para prefs: {displayName, count} o lanza Error legible. */
export async function checkJira(session) {
    const cfg = readJson(CONFIG_PATH, null);
    if (!cfg?.jiraBaseUrl || !cfg?.jiraEmail)
        throw new Error('Falta URL o email de Jira');
    const token = await getToken();
    if (!token)
        throw new Error('Sin token en el llavero');
    const me = await jiraGet(session, cfg, token, '/rest/api/3/myself');
    const {issues} = await fetchJira(session);
    return {displayName: me.displayName ?? cfg.jiraEmail, count: issues.length};
}

/** Lee solo los últimos TAIL_BYTES del fichero. */
function readTail(file, size) {
    const stream = file.read(null);
    try {
        if (size > TAIL_BYTES)
            stream.seek(size - TAIL_BYTES, GLib.SeekType.SET, null);
        return new TextDecoder().decode(stream.read_bytes(TAIL_BYTES, null).toArray());
    } finally {
        stream.close(null);
    }
}

/**
 * Sesiones de Claude Code con actividad en los últimos windowS segundos.
 * withInfo=false se salta el parseo del .jsonl (solo cuenta).
 * extraIds: ids de sesión (nombre del .jsonl sin extensión) que se incluyen aunque
 * queden fuera de la ventana (agentes que te necesitan).
 */
export function scanAgents(windowS, withInfo = true, extraIds = null) {
    const root = Gio.File.new_for_path(CLAUDE_PROJECTS);
    const now = GLib.get_real_time() / 1e6;
    const found = [];
    const attrs = 'standard::name,standard::type,standard::size,time::modified';
    let dirs;
    try {
        dirs = root.enumerate_children(attrs, Gio.FileQueryInfoFlags.NONE, null);
    } catch (_e) {
        return found;
    }
    for (const d of dirs) {
        if (d.get_file_type() !== Gio.FileType.DIRECTORY || d.get_name().includes('claude-mem-observer'))
            continue;
        const dir = root.get_child(d.get_name());
        try {
            for (const f of dir.enumerate_children(attrs, Gio.FileQueryInfoFlags.NONE, null)) {
                if (!f.get_name().endsWith('.jsonl'))
                    continue;
                const id = f.get_name().slice(0, -'.jsonl'.length);
                const age = Math.floor(now - f.get_modification_date_time().to_unix());
                if (age > windowS && !extraIds?.has(id))
                    continue;
                if (!withInfo) {
                    found.push({age});
                    continue;
                }
                try {
                    const info = parseTail(readTail(dir.get_child(f.get_name()), f.get_size()));
                    found.push({...info, id, age});
                } catch (e) {
                    console.error(`kaito: ${f.get_name()}: ${e.message}`);
                }
            }
        } catch (e) {
            console.error(`kaito: ${d.get_name()}: ${e.message}`);
        }
    }
    return found.sort((a, b) => a.age - b.age);
}

/** Estados de los hooks: {session_id: {state, message, cwd, ts}}. Borra los de más de 24 h. */
export function readAgentStates() {
    const out = {};
    const dir = Gio.File.new_for_path(STATE_DIR);
    const now = GLib.get_real_time() / 1e6;
    let files;
    try {
        files = dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
    } catch (_e) {
        return out;
    }
    for (const f of files) {
        const name = f.get_name();
        if (!name.endsWith('.json') || name.startsWith('.'))
            continue;
        const file = dir.get_child(name);
        const mtime = f.get_modification_date_time().to_unix();
        if (now - mtime > STATE_MAX_AGE_S) {
            try { file.delete(null); } catch (_e) { /* ya borrado */ }
            continue;
        }
        const st = readJson(file.get_path(), null);
        if (st && (st.state === 'needs' || st.state === 'done'))
            out[name.slice(0, -'.json'.length)] = {...st, ts: Number(st.ts) || mtime};
    }
    return out;
}

/** Sesiones CLI vivas del registro de Claude Code (~/.claude/sessions/<pid>.json); null si no existe. */
function readLiveSessions() {
    const dir = Gio.File.new_for_path(CLAUDE_SESSIONS);
    let files;
    try {
        files = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (_e) {
        return null;
    }
    const out = [];
    for (const f of files) {
        if (!/^\d+\.json$/.test(f.get_name()))
            continue;
        const s = readJson(dir.get_child(f.get_name()).get_path(), null);
        // sdk-ts / sdk-cli son herramientas en segundo plano, no sesiones del usuario.
        if (!s || s.entrypoint !== 'cli' || !s.sessionId || !Number.isInteger(s.pid))
            continue;
        // El fichero puede quedar huérfano tras un crash: el proceso debe seguir vivo.
        if (!Gio.File.new_for_path(`/proc/${s.pid}`).query_exists(null))
            continue;
        out.push(s);
    }
    return out;
}

const ticketCache = new Map(); // sessionId -> clave | null

/** Clave del ticket de Jira con el que Kaito lanzó la sesión (primer mensaje), o null. Cacheado. */
function sessionTicket(sessionId, file) {
    if (ticketCache.has(sessionId))
        return ticketCache.get(sessionId);
    let key;
    try {
        key = ticketFromHead(readHead(file, HEAD_BYTES));
    } catch (_e) {
        return null;
    }
    if (key !== undefined) // sin mensaje del usuario todavía: se vuelve a mirar en el próximo refresco
        ticketCache.set(sessionId, key);
    return key ?? null;
}

/** ~/.claude/projects/<cwd con todo lo no alfanumérico -> '-'>/<sessionId>.jsonl */
function transcriptFile(s) {
    const dirName = String(s.cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-');
    return Gio.File.new_for_path(GLib.build_filenamev([CLAUDE_PROJECTS, dirName, `${s.sessionId}.jsonl`]));
}

/**
 * Agentes activos + estado de los hooks. Fuente: registro de sesiones vivas
 * (entrypoint cli, pid vivo); busy => live. Sin registro, cae al escaneo por mtime.
 * Un agente en "needs" aparece aunque no esté en la lista; si no hay .jsonl, fila mínima.
 * Cada agente lleva `live` (bool).
 */
export function collectAgents(windowS, states, liveS = DEFAULTS.liveSeconds) {
    const needIds = new Set(Object.keys(states).filter(id => states[id].state === 'needs'));
    const sessions = readLiveSessions();
    const now = GLib.get_real_time() / 1e6;
    let agents;
    if (sessions === null) {
        agents = scanAgents(windowS, true, needIds);
        for (const a of agents) {
            a.live = a.age < liveS;
            a.activityMs = Math.floor((now - a.age) * 1000);
        }
    } else {
        agents = sessions.map(s => {
            const cwd = String(s.cwd ?? '');
            const base = cwd.split('/').filter(Boolean).pop() ?? null;
            const updated = Math.floor((Number(s.updatedAt) || Date.now()) / 1000);
            let info = {cwd: base, lastAction: null, lastText: null}, age = Math.max(0, Math.floor(now - updated));
            let activityMs = Number(s.updatedAt) || 0;
            let ticket = null;
            try {
                const f = transcriptFile(s);
                ticket = sessionTicket(s.sessionId, f);
                const q = f.query_info('standard::size,time::modified,time::modified-usec', Gio.FileQueryInfoFlags.NONE, null);
                info = {...parseTail(readTail(f, q.get_size())), cwd: base};
                const mt = q.get_modification_date_time();
                age = Math.max(0, Math.floor(now - mt.to_unix()));
                activityMs = Math.max(activityMs, mt.to_unix() * 1000 + Math.floor(mt.get_microsecond() / 1000));
            } catch (_e) { /* sin transcript todavía: fila sin acción */ }
            const live = s.status === 'busy' ? true : s.status === 'idle' ? false : age < liveS;
            return {...info, id: s.sessionId, pid: s.pid, age, live, activityMs, ticket, cwdPath: cwd || null};
        }).sort((a, b) => a.age - b.age);
    }
    const seen = new Set(agents.map(a => a.id));
    for (const a of agents) {
        const st = states[a.id];
        if (st) {
            a.state = st.state;
            a.message = st.message;
            a.hook = st; // estado completo del hook (tool, detail, request, waitUntil, ts)
        }
    }
    for (const id of needIds) {
        if (seen.has(id))
            continue;
        const st = states[id];
        agents.push({
            id, state: 'needs', message: st.message, lastAction: null, lastText: null, live: false, hook: st,
            ticket: null, cwdPath: st.cwd || null,
            cwd: String(st.cwd ?? '').split('/').filter(Boolean).pop() ?? null,
            age: Math.max(0, Math.floor(now - st.ts)), activityMs: Math.floor(st.ts * 1000),
        });
    }
    return agents;
}

// --- Agentes ocultados (×): {sessionId: dismissedAtMs} en ~/.cache/kaito/dismissed.json ---

export function readDismissed() {
    const v = readJson(DISMISSED_PATH, {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

export function writeDismissed(map) {
    GLib.mkdir_with_parents(CACHE_DIR, 0o755);
    GLib.file_set_contents(DISMISSED_PATH, JSON.stringify(map));
}

/**
 * Puro. Un agente ocultado vuelve cuando tiene actividad posterior al ocultado
 * (activityMs > dismissedAt) o entra en "needs". Se podan las entradas de sesiones
 * que ya no existen y las de agentes que han vuelto.
 * → {visible, dismissed (mapa nuevo), changed}
 */
export function applyDismissed(agents, dismissed) {
    const ids = new Set(agents.map(a => a.id));
    const next = {};
    const visible = [];
    for (const a of agents) {
        const at = Number(dismissed[a.id]);
        if (!Number.isFinite(at) || a.state === 'needs' || (Number(a.activityMs) || 0) > at) {
            visible.push(a);
            continue;
        }
        next[a.id] = at;
    }
    const changed = Object.keys(dismissed).length !== Object.keys(next).length
        || Object.keys(dismissed).some(id => !ids.has(id));
    return {visible, dismissed: next, changed};
}

// --- Responder a un agente ---

/** Puro. ¿La petición de permiso del agente sigue esperando la respuesta de Kaito? */
export function canDecide(agent, nowS = Date.now() / 1000) {
    const h = agent?.hook;
    return !!(h && agent.state === 'needs' && h.kind === 'permission' && h.request && Number(h.waitUntil) > nowS);
}

/** Deja la decisión (allow|deny) para el hook que espera en la sesión. */
export function writeDecision(sessionId, request, behavior) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || !['allow', 'deny'].includes(behavior))
        throw new Error('decisión no válida');
    GLib.mkdir_with_parents(DECISIONS_DIR, 0o700);
    GLib.file_set_contents(GLib.build_filenamev([DECISIONS_DIR, `${sessionId}.json`]),
        JSON.stringify({request, behavior}));
}

/** Puro. {clave de ticket: agente} de los agentes vinculados a un ticket (el más reciente gana). */
export function agentsByTicket(agents) {
    const out = {};
    for (const a of agents) {
        if (a.ticket && (!out[a.ticket] || a.age < out[a.ticket].age))
            out[a.ticket] = a;
    }
    return out;
}

// --- Resumen del día ---

/** Puro. Fecha local YYYY-MM-DD. */
export const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Puro. ¿Toca el resumen? Una vez por día natural, a partir de las 06:00. */
export function shouldShowDaily(lastDay, now) {
    return now.getHours() >= 6 && lastDay !== localDay(now);
}

export const readDailyDay = () => readJson(DAILY_PATH, {})?.lastShown ?? null;

export function writeDailyDay(day) {
    GLib.mkdir_with_parents(CACHE_DIR, 0o755);
    GLib.file_set_contents(DAILY_PATH, JSON.stringify({lastShown: day}));
}

const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const listKeys = (keys, max = 4) => keys.slice(0, max).join(', ') + (keys.length > max ? '…' : '');

/**
 * Puro. Hasta 3 líneas del resumen de la mañana (se omiten las vacías):
 * tickets en curso, recordatorios pendientes de hoy y agentes parados desde ayer.
 */
export function dailySummaryLines({issues = [], reminders = [], agents = [], now}) {
    const lines = [];
    const progress = issues.filter(i => i.category === 'indeterminate').map(i => i.key);
    if (progress.length)
        lines.push(`${progress.length} ${progress.length === 1 ? 'ticket en curso' : 'tickets en curso'}: ${listKeys(progress)}`);
    const today = localDay(now);
    const todays = reminders.filter(r => !r.done && r.due && localDay(new Date(r.due)) === today)
        .sort((a, b) => new Date(a.due) - new Date(b.due));
    if (todays.length) {
        const next = todays.find(r => new Date(r.due) >= now) ?? todays[0];
        lines.push(`${todays.length} ${todays.length === 1 ? 'recordatorio' : 'recordatorios'} hoy · ` +
            `el próximo a las ${hhmm(new Date(next.due))}: ${next.text}`);
    }
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const waiting = agents.filter(a => (a.state === 'needs' || !a.live) && Number(a.activityMs) > 0 && a.activityMs < midnight)
        .map(a => a.cwd ?? '?');
    if (waiting.length)
        lines.push(`${waiting.length} ${waiting.length === 1 ? 'agente esperando' : 'agentes esperando'} desde ayer: ${listKeys(waiting, 3)}`);
    return lines;
}

// --- Ir a la terminal del agente ---

/** Cadena de pids desde `pid` hacia arriba (incluido), leyendo PPid de /proc/<pid>/status. */
export function ancestorPids(pid, max = 32) {
    const out = [];
    let cur = pid;
    while (Number.isInteger(cur) && cur > 1 && out.length < max) {
        out.push(cur);
        const st = readText(`/proc/${cur}/status`);
        const m = st && /^PPid:\s*(\d+)/m.exec(st);
        cur = m ? Number(m[1]) : 0;
    }
    return out;
}

/** Variables de entorno de un proceso (/proc/<pid>/environ, separadas por NUL); {} si no se puede leer. */
export function readEnviron(pid) {
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/environ`);
        return ok ? parseEnviron(bytes) : {};
    } catch (_e) {
        return {};
    }
}

/** Puro. Bytes de /proc/<pid>/environ -> {VAR: valor}. */
export function parseEnviron(bytes) {
    const env = {};
    for (const kv of new TextDecoder().decode(bytes).split('\0')) {
        const i = kv.indexOf('=');
        if (i > 0)
            env[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return env;
}

// Procesos de la terminal (o por encima): ahí se deja de subir buscando PTYXIS_TAB / GNOME_TERMINAL_SCREEN,
// para no heredar la pestaña de otra terminal que lanzó a esta.
const TERMINAL_COMM_RE = /^(ptyxis|ptyxis-agent|gnome-terminal-|kgx|warp|flatpak-session-|systemd|gnome-shell)/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Puro. Pestaña exacta del agente a partir de la cadena de procesos [{pid, comm, env}] (del agente hacia
 * arriba, hasta la terminal). {kind: 'ptyxis'|'gnome-terminal', uuid} o null.
 */
export function terminalFocusTarget(chain) {
    for (const {comm, env} of chain ?? []) {
        if (comm && TERMINAL_COMM_RE.test(comm))
            break;
        const tab = env?.PTYXIS_TAB;
        if (tab && UUID_RE.test(tab))
            return {kind: 'ptyxis', uuid: tab};
        const screen = env?.GNOME_TERMINAL_SCREEN;
        const m = screen && /^\/org\/gnome\/Terminal\/screen\/([0-9a-fA-F_]+)$/.exec(screen);
        if (m && UUID_RE.test(m[1].replace(/_/g, '-')))
            return {kind: 'gnome-terminal', uuid: m[1].replace(/_/g, '-')};
    }
    return null;
}

/** Cadena [{pid, comm, env}] desde `pid` hacia arriba (lee /proc). */
export function processChain(pid, max = 16) {
    return ancestorPids(pid, max).map(p => ({pid: p, comm: (readText(`/proc/${p}/comm`) ?? '').trim(), env: readEnviron(p)}));
}

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch (_e) {
        return null;
    }
}

// --- Repos candidatos (cwd de sesiones recientes de Claude) ---

const SKIP_REPO = p => p.includes('/.claude-mem/') || p.includes('/.claude/worktrees') || p.includes('-worktrees-');

/** Primer `cwd` que aparezca en un trozo de .jsonl (líneas completas). */
export function cwdFromJsonl(text) {
    for (const line of text.split('\n')) {
        const i = line.indexOf('"cwd"');
        if (i < 0)
            continue;
        try {
            const cwd = JSON.parse(line).cwd;
            if (typeof cwd === 'string' && cwd.startsWith('/'))
                return cwd;
        } catch (_e) { /* línea cortada */ }
    }
    return null;
}

function readHead(file, bytes = TAIL_BYTES) {
    const stream = file.read(null);
    try {
        return new TextDecoder().decode(stream.read_bytes(bytes, null).toArray());
    } finally {
        stream.close(null);
    }
}

/** [{path, mtime}] de los cwd distintos de los últimos `days` días, más reciente primero. */
export function collectRepos(days = 30, max = Infinity) {
    const root = Gio.File.new_for_path(CLAUDE_PROJECTS);
    const minT = GLib.get_real_time() / 1e6 - days * 86400;
    const attrs = 'standard::name,standard::type,standard::size,time::modified';
    const best = new Map();
    let dirs;
    try {
        dirs = root.enumerate_children(attrs, Gio.FileQueryInfoFlags.NONE, null);
    } catch (_e) {
        return [];
    }
    for (const d of dirs) {
        const name = d.get_name();
        if (d.get_file_type() !== Gio.FileType.DIRECTORY || name.includes('claude-mem') || name.includes('-worktrees-'))
            continue;
        const dir = root.get_child(name);
        let newest = null;
        try {
            for (const f of dir.enumerate_children(attrs, Gio.FileQueryInfoFlags.NONE, null)) {
                if (!f.get_name().endsWith('.jsonl'))
                    continue;
                const t = f.get_modification_date_time().to_unix();
                if (t >= minT && (!newest || t > newest.t))
                    newest = {t, name: f.get_name(), size: f.get_size()};
            }
        } catch (_e) {
            continue;
        }
        if (!newest)
            continue;
        let cwd = null;
        try {
            const file = dir.get_child(newest.name);
            const tail = readTail(file, newest.size);
            cwd = cwdFromJsonl(newest.size > TAIL_BYTES ? tail.slice(tail.indexOf('\n') + 1) : tail)
                ?? cwdFromJsonl(readHead(file));
        } catch (_e) { /* ilegible */ }
        if (!cwd || SKIP_REPO(cwd) || !GLib.file_test(cwd, GLib.FileTest.IS_DIR))
            continue;
        if ((best.get(cwd) ?? 0) < newest.t)
            best.set(cwd, newest.t);
    }
    return [...best].sort((a, b) => b[1] - a[1]).slice(0, max).map(([path, mtime]) => ({path, mtime}));
}

// --- Prioridad de Jira ---

const PRIORITY_BY_ID = {1: 'highest', 2: 'high', 3: 'medium', 4: 'low', 5: 'lowest'};
const PRIORITY_BY_NAME = {
    'highest': 'highest', 'más alta': 'highest', 'mas alta': 'highest', 'blocker': 'highest', 'critical': 'highest',
    'high': 'high', 'alta': 'high', 'medium': 'medium', 'media': 'medium',
    'low': 'low', 'baja': 'low', 'lowest': 'lowest', 'más baja': 'lowest', 'mas baja': 'lowest', 'trivial': 'lowest',
};

const PRIORITY_ORDER = ['highest', 'high', 'medium', 'low', 'lowest'];
const BLOCKED_RE = /bloquead|blocked|esperando|waiting/i;

/** Puro. Grupo de orden: 0 en curso, 1 por hacer, 2 resto sin terminar (bloqueado/esperando), 3 hecho. */
export function statusGroup(issue) {
    if (issue.category === 'done')
        return 3;
    if (BLOCKED_RE.test(String(issue.status ?? '')))
        return 2;
    return issue.category === 'indeterminate' ? 0 : issue.category === 'new' ? 1 : 2;
}

/**
 * Puro. Ordena tickets: grupo de estado (statusGroup), luego prioridad (más alta primero, desconocida
 * al final), luego `updated` más reciente, y por último el orden de la API. No modifica la entrada.
 */
export function sortIssues(issues) {
    const prio = i => {
        const k = PRIORITY_ORDER.indexOf(priorityKind(i.priority));
        return k < 0 ? PRIORITY_ORDER.length : k;
    };
    const upd = i => {
        const t = Date.parse(i.updated ?? '');
        return Number.isFinite(t) ? t : -Infinity;
    };
    return issues.map((i, idx) => ({i, idx, g: statusGroup(i), p: prio(i), u: upd(i)}))
        .sort((a, b) => a.g - b.g || a.p - b.p || (b.u === a.u ? 0 : b.u > a.u ? 1 : -1) || a.idx - b.idx)
        .map(x => x.i);
}

/** {id, name} de Jira → 'highest'|'high'|'medium'|'low'|'lowest'|null. Por id 1-5; si no, por nombre. */
export function priorityKind(p) {
    if (!p)
        return null;
    return PRIORITY_BY_ID[String(p.id ?? '').trim()]
        ?? PRIORITY_BY_NAME[String(p.name ?? '').trim().toLowerCase()] ?? null;
}

// --- Mandar un ticket a Claude ---

export const PROMPT_MAX = 12000;
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
export const projectOf = key => String(key).split('-')[0];

/** ADF (Atlassian Document Format) → texto plano: recoge los nodos `text`; bloques separados por saltos. */
export function adfToText(node) {
    const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote', 'rule', 'tableRow', 'panel']);
    const walk = n => {
        if (!n || typeof n !== 'object')
            return '';
        if (Array.isArray(n))
            return n.map(walk).join('');
        if (n.type === 'text')
            return String(n.text ?? '');
        if (n.type === 'hardBreak')
            return '\n';
        if (n.type === 'mention' || n.type === 'emoji')
            return String(n.attrs?.text ?? '');
        const inner = walk(n.content ?? []);
        if (n.type === 'listItem')
            return `- ${inner.trim()}\n`;
        return BLOCKS.has(n.type) ? `${inner.trim()}\n` : inner;
    };
    if (typeof node === 'string')
        return node.trim();
    return walk(node).replace(/\n{3,}/g, '\n\n').trim();
}

const ISSUE_FIELDS = 'summary,description,status,priority,issuetype,parent,subtasks,issuelinks,labels,components,reporter,created,attachment,comment,customfield_10062';
const MAX_COMMENTS = 10;

/** Valor de un campo Jira cualquiera (string, {value|name}, array, ADF) → texto. */
const fieldText = v => {
    if (v == null)
        return '';
    if (Array.isArray(v))
        return v.map(fieldText).filter(Boolean).join(', ');
    if (typeof v === 'object')
        return v.type === 'doc' ? adfToText(v) : String(v.value ?? v.name ?? v.displayName ?? '');
    return String(v).trim();
};

/**
 * Puro. Campos de la issue (REST v3) → {meta, description, extra, comments}: cadenas de texto plano.
 * Sin emails (solo displayName); las secciones vacías se omiten.
 */
export function formatIssueDetail(fields) {
    const f = fields ?? {};
    const line = (label, v) => (v ? `${label}: ${v}` : '');
    const keySum = i => `${i.key} – ${i.fields?.summary ?? ''}`;
    const meta = [
        line('Tipo', fieldText(f.issuetype)),
        line('Estado', fieldText(f.status)),
        line('Prioridad', fieldText(f.priority)),
        line('Departamento', fieldText(f.customfield_10062)),
        line('Etiquetas', fieldText(f.labels)),
        line('Componentes', fieldText(f.components)),
        line('Padre/épica', f.parent?.key ? keySum(f.parent) : ''),
        line('Informador', f.reporter?.displayName ?? ''),
    ].filter(Boolean).join('\n');
    const list = (title, arr) => (arr.length ? `${title}:\n${arr.map(x => `- ${x}`).join('\n')}` : '');
    const extra = [
        list('Subtareas', (f.subtasks ?? []).map(t => `${keySum(t)} – ${fieldText(t.fields?.status)}`)),
        list('Tickets enlazados', (f.issuelinks ?? []).map(l => {
            const out = l.outwardIssue;
            const other = out ?? l.inwardIssue;
            return other ? `${out ? l.type?.outward : l.type?.inward ?? ''} ${keySum(other)}`.trim() : '';
        }).filter(Boolean)),
        list('Adjuntos', (f.attachment ?? []).map(a => a.filename).filter(Boolean)),
    ].filter(Boolean).join('\n\n');
    const comments = (f.comment?.comments ?? []).slice(-MAX_COMMENTS).map(c => {
        const body = adfToText(c.body ?? null);
        return body ? `- ${c.author?.displayName ?? '?'} (${String(c.created ?? '').slice(0, 10)}): ${body}` : '';
    }).filter(Boolean);
    return {meta, description: adfToText(f.description ?? null), extra, comments};
}

/** Detalle del ticket ({meta, description, extra, comments}) en una sola petición, o null. */
export async function fetchIssueDescription(session, key) {
    const cfg = readJson(CONFIG_PATH, null);
    if (!cfg?.jiraBaseUrl || !cfg?.jiraEmail || !KEY_RE.test(key))
        return null;
    const token = await getToken();
    if (!token)
        return null;
    const data = await jiraGet(session, cfg, token, `/rest/api/3/issue/${key}?fields=${ISSUE_FIELDS}`);
    return formatIssueDetail(data.fields);
}

const norm = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Puro. Tokens (>= 4 letras) del nombre de una carpeta: separa por - _ . espacio y camelCase. */
export function repoTokens(path) {
    const name = String(path).split('/').filter(Boolean).pop() ?? '';
    return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[-_.\s]+/).map(norm).filter(t => t.length >= 4);
}

/**
 * Puro. Ordena repos [{path}] (ya por recencia) para un ticket: 1) usado para este ticket, 2) nombre que
 * aparece en resumen/etiquetas/componentes (más coincidencias primero), 3) usado en el proyecto, 4) recencia; antes de todo, repos con rama del ticket (`branches`: {ruta: match}).
 * Devuelve [{path, why}] con why 'branch' | 'issue' | 'match' | 'project' | null (solo el primero se marca en la UI).
 */
export function rankRepos(issue, repos, cfg, exists = () => true, branches = {}) {
    const byIssue = cfg.jiraRepoByIssue?.[issue.key];
    const byProject = cfg.jiraRepoByProject?.[projectOf(issue.key)];
    const text = norm([issue.summary, issue.text ?? '', ...(issue.labels ?? []), ...(issue.components ?? [])].join(' '));
    const paths = [...new Set([byIssue, byProject, ...Object.keys(branches ?? {}), ...repos.map(r => r.path)]
        .filter(p => typeof p === 'string' && p.startsWith('/') && exists(p)))];
    const scored = paths.map((path, i) => {
        const hits = repoTokens(path).filter(t => text.includes(t)).length;
        const rank = branches?.[path] ? 4 : path === byIssue ? 3 : hits ? 2 : path === byProject ? 1 : 0;
        return {path, i, hits, rank, why: ['branch', 'issue', 'match', 'project'][4 - rank] ?? null};
    });
    scored.sort((a, b) => b.rank - a.rank || b.hits - a.hits || a.i - b.i);
    return scored.map(({path, why}) => ({path, why, ...(branches?.[path] ? {branch: branches[path]} : {})}));
}

const SCAN_SKIP = new Set(['node_modules', 'vendor']);

/**
 * Busca repos git (carpeta con entrada `.git`, dir o fichero) bajo `roots` hasta `maxDepth` niveles.
 * No entra en dot-dirs, node_modules, vendor, symlinks ni dentro de un repo encontrado. Acotado por
 * `maxDirs` y `maxMs` para no bloquear la shell. Devuelve [{path, mtime: 0}] ordenado por ruta.
 */
export function scanRepos(roots, maxDepth = 4, maxDirs = 4000, maxMs = 400) {
    const home = GLib.get_home_dir();
    const t0 = GLib.get_monotonic_time();
    const found = new Set();
    let visited = 0;
    const walk = (path, depth) => {
        if (++visited > maxDirs || (GLib.get_monotonic_time() - t0) / 1000 > maxMs)
            return;
        const subs = [];
        try {
            const en = Gio.File.new_for_path(path).enumerate_children(
                'standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            for (const c of en) {
                const name = c.get_name();
                if (name === '.git') {
                    found.add(path);
                    return;
                }
                if (c.get_file_type() === Gio.FileType.DIRECTORY && !name.startsWith('.') && !SCAN_SKIP.has(name))
                    subs.push(name);
            }
        } catch (_e) {
            return;
        }
        if (depth < maxDepth)
            for (const name of subs.sort())
                walk(`${path}/${name}`, depth + 1);
    };
    for (const r of roots) {
        const root = r === '~' ? home : r.startsWith('~/') ? home + r.slice(1) : r;
        if (root.startsWith('/'))
            walk(root.replace(/\/+$/, '') || '/', 0);
    }
    return [...found].sort().map(path => ({path, mtime: 0}));
}

/**
 * Puro. Filtra repos [{path}] conservando el orden: todos los términos (separados por espacios) deben
 * aparecer, sin mayúsculas ni acentos, en el nombre de la carpeta o en la ruta completa.
 */
export function filterRepos(list, query) {
    const terms = norm(query).split(/\s+/).filter(Boolean);
    if (!terms.length)
        return list;
    return list.filter(r => {
        const hay = norm(r.path);
        return terms.every(t => hay.includes(t));
    });
}

/** Rama actual leyendo .git/HEAD (null si no hay, es un worktree o está en HEAD desacoplado). */
export function repoBranch(repo) {
    try {
        const head = new TextDecoder().decode(GLib.file_get_contents(`${repo}/.git/HEAD`)[1]).trim();
        return head.startsWith('ref: refs/heads/') ? head.slice(16) : null;
    } catch (_e) {
        return null;
    }
}

/**
 * Puro. Prompt para Claude con todo el ticket (límite PROMPT_MAX: primero se recortan los comentarios
 * más antiguos y luego la descripción). `detail` es el resultado de formatIssueDetail, un string
 * (solo descripción) o null.
 */
export function buildPrompt(issue, base, detail, repo = null, branch = null, existing = null) {
    const d = typeof detail === 'string' ? {description: detail} : detail ?? {};
    const comments = [...d.comments ?? []];
    let description = d.description ?? '';
    const little = description.length < 200 && comments.length === 0;
    const build = () => {
        let s = `Trabaja en el ticket de Jira ${issue.key}: ${issue.summary}\n${base}/browse/${issue.key}\n`;
        if (repo)
            s += `Repo de trabajo: ${repo.split('/').filter(Boolean).pop() ?? repo} (${repo})${branch ? `, rama ${branch}` : ''}\n`;
        s += 'Todo el contenido del ticket está abajo; no intentes abrir el enlace de Jira (requiere login).\n';
        if (little)
            s += 'El ticket tiene poco detalle: antes de cambiar código, explora el repo, resume lo que entiendes y pregúntame lo que falte.\n';
        const {here, other} = splitExisting(repo, existing);
        s += other + gitInstructions(issue.key, `${issue.key}-<resumen-corto>`, here);
        const blocks = [d.meta, description && `Descripción:\n${description}`, d.extra,
            comments.length && `Comentarios:\n${comments.join('\n')}`].filter(Boolean);
        return blocks.length ? `${s}\n${blocks.join('\n\n')}\n` : s;
    };
    let out = build();
    while (out.length > PROMPT_MAX && comments.length) {
        comments.shift();
        out = build();
    }
    if (out.length > PROMPT_MAX && description) {
        description = `${description.slice(0, Math.max(0, description.length - (out.length - PROMPT_MAX) - 1))}…`;
        out = build();
    }
    return out;
}

/** Comillas simples de shell POSIX. */
export const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Puro. Launch configuration de Warp (YAML; las cadenas van como JSON, que es YAML válido). */
export function warpLaunchYaml(key, repo, promptPath) {
    const q = JSON.stringify;
    return [
        '---',
        `name: ${q(`kaito-${key}`)}`,
        'windows:',
        '  - tabs:',
        `      - title: ${q(key)}`,
        '        layout:',
        `          cwd: ${q(repo)}`,
        '          commands:',
        `            - exec: ${q(`claude "$(cat ${shQuote(promptPath)})"`)}`,
        '',
    ].join('\n');
}

/** Puro. Cadena básica TOML (JSON es casi TOML; DEL no se admite sin escapar). */
const tomlStr = v => JSON.stringify(String(v)).replace(/\x7f/g, '\\u007f');

/**
 * Puro. Tab Config de Warp (TOML): una pestaña con un panel de terminal en `repo` que lanza Claude.
 * Sin [params]: así Warp no pregunta nada al abrirla.
 */
export function warpTabToml(key, repo, promptPath) {
    return [
        `name = ${tomlStr(`kaito ${key}`)}`,
        `title = ${tomlStr(key)}`,
        '',
        '[[panes]]',
        'id = "claude"',
        'type = "terminal"',
        `directory = ${tomlStr(repo)}`,
        `commands = [${tomlStr(`claude "$(cat ${shQuote(promptPath)})"`)}]`,
        'is_focused = true',
        '',
    ].join('\n');
}

/** Puro. Comando de shell que arranca Claude con el prompt del fichero (el ticket nunca va en argv). */
export const claudeCommand = promptPath => `claude "$(cat ${shQuote(promptPath)})"`;

/**
 * Puro. argv para ptyxis (pestaña en la ventana activa); el texto del ticket solo vive en el fichero del prompt.
 * Con `flatpak`, se lanza `flatpak run app.devsuite.Ptyxis` con los mismos argumentos.
 */
export function ptyxisArgv(repo, promptPath, title = null, flatpak = false) {
    return [...(flatpak ? ['flatpak', 'run', PTYXIS_FLATPAK] : ['ptyxis']), '--tab', '-d', repo,
        ...(title ? ['-T', title] : []), '--', 'bash', '-lc', claudeCommand(promptPath)];
}

/** Puro. argv para GNOME Terminal (pestaña nueva en la ventana activa). */
export function gnomeTerminalArgv(repo, promptPath, title = null) {
    return ['gnome-terminal', '--tab', `--working-directory=${repo}`, ...(title ? [`--title=${title}`] : []),
        '--', 'bash', '-lc', claudeCommand(promptPath)];
}

/** Puro. argv para Consola (kgx): pestaña en la ventana activa. */
export function kgxArgv(repo, promptPath, title = null) {
    return ['kgx', '--tab', `--working-directory=${repo}`, ...(title ? [`--title=${title}`] : []),
        '--', 'bash', '-lc', claudeCommand(promptPath)];
}

/** ¿Está instalado el flatpak de Ptyxis? (equivale a `flatpak info app.devsuite.Ptyxis`, sin lanzar nada). */
export function hasPtyxisFlatpak() {
    const roots = [GLib.build_filenamev([GLib.get_user_data_dir(), 'flatpak', 'app']), '/var/lib/flatpak/app'];
    return !!GLib.find_program_in_path('flatpak') &&
        roots.some(r => GLib.file_test(GLib.build_filenamev([r, PTYXIS_FLATPAK, 'current']), GLib.FileTest.EXISTS));
}

const _ptyxisVersionCache = new Map();

/** Versión de Ptyxis (`ptyxis --version` o, con `flatpak`, `flatpak run app.devsuite.Ptyxis --version`), o null. No lanza; cacheada por proceso. */
export function ptyxisVersion(flatpak = false) {
    const key = !!flatpak;
    if (_ptyxisVersionCache.has(key))
        return _ptyxisVersionCache.get(key);
    let v = null;
    try {
        const argv = key ? ['flatpak', 'run', PTYXIS_FLATPAK, '--version'] : ['ptyxis', '--version'];
        const [ok, out] = GLib.spawn_sync(null, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
        v = ok ? (new TextDecoder().decode(out).trim() || null) : null;
    } catch (_e) {
        v = null;
    }
    _ptyxisVersionCache.set(key, v);
    return v;
}

const defaultProbe = {
    has: cmd => !!GLib.find_program_in_path(cmd),
    ptyxisFlatpak: hasPtyxisFlatpak,
    ptyxisVersion,
};

/**
 * Terminal concreto para `terminal`. 'auto' prefiere las que permiten volver a la pestaña exacta del agente,
 * luego Warp y por último el resto. Orden: 1) Ptyxis (nativo o flatpak) con versión >= 52 (exporta PTYXIS_TAB),
 * 2) GNOME Terminal, 3) Warp (warp-terminal; pestaña en la ventana existente, foco solo de ventana),
 * 4) Ptyxis < 52 o de versión desconocida (solo ventana), 5) kgx (solo ventana).
 * Devuelve {id, flatpak} o null si 'auto' no encuentra ninguno. Los valores explícitos no cambian.
 * `probe` ({has(cmd), ptyxisFlatpak(), ptyxisVersion(flatpak)}) permite probarlo sin depender del sistema.
 */
export function resolveTerminal(terminal, probe = defaultProbe) {
    if (terminal && terminal !== 'auto' && TERMINALS.includes(terminal))
        return {id: terminal, flatpak: terminal === 'ptyxis' && !probe.has('ptyxis') && probe.ptyxisFlatpak()};
    let ptyxis = null;
    if (probe.has('ptyxis'))
        ptyxis = {id: 'ptyxis', flatpak: false};
    else if (probe.ptyxisFlatpak())
        ptyxis = {id: 'ptyxis', flatpak: true};
    if (ptyxis && ptyxisExportsTab(probe.ptyxisVersion?.(ptyxis.flatpak)))
        return ptyxis;
    if (probe.has('gnome-terminal'))
        return {id: 'gnome-terminal', flatpak: false};
    if (probe.has('warp-terminal'))
        return {id: 'warp', flatpak: false};
    if (ptyxis)
        return ptyxis;
    if (probe.has('kgx'))
        return {id: 'kgx', flatpak: false};
    return null;
}

/** Puro. ¿Esta versión de Ptyxis exporta PTYXIS_TAB a sus shells? (desde Ptyxis 52). */
export function ptyxisExportsTab(version) {
    const m = /(\d+)(?:\.|\b)/.exec(String(version ?? ''));
    return !!m && Number(m[1]) >= 52;
}

/** Puro. Nivel de foco al volver al agente: 'tab' (pestaña exacta) o 'window' (solo ventana). */
export function terminalFocusLevel(id, ptyxisVersion = null) {
    if (id === 'gnome-terminal')
        return 'tab';
    if (id === 'ptyxis')
        return ptyxisExportsTab(ptyxisVersion) ? 'tab' : 'window';
    return 'window';
}

/** Borra los kaito-*.toml antiguos (Warp los lista en su menú +); conserva `keep`. */
function pruneWarpTabs(keep) {
    const dir = Gio.File.new_for_path(WARP_TAB_DIR);
    const now = GLib.get_real_time() / 1e6;
    try {
        for (const f of dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null)) {
            const name = f.get_name();
            if (name !== keep && /^kaito-.*\.toml$/.test(name) && now - f.get_modification_date_time().to_unix() > WARP_TAB_KEEP_S)
                dir.get_child(name).delete(null);
        }
    } catch (e) {
        console.warn(`kaito: limpiando tab_configs: ${e.message}`);
    }
}

/** Abre la URI con un pequeño margen para que Warp vea el fichero recién escrito. */
const _uriTimers = new Set();
const openUriSoon = uri => {
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        _uriTimers.delete(id);
        try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
        } catch (e) {
            console.warn(`kaito: no se pudo abrir ${uri}: ${e.message}`);
        }
        return GLib.SOURCE_REMOVE;
    });
    _uriTimers.add(id);
    return id;
};

/** Cancela las aperturas pendientes (al desactivar o recargar la extensión). */
export function cancelPendingUris() {
    for (const id of _uriTimers)
        GLib.source_remove(id);
    _uriTimers.clear();
}

/**
 * Escribe el prompt y abre Claude en la terminal elegida (`terminal` de la config; 'auto' por defecto):
 * - ptyxis / gnome-terminal / kgx: pestaña nueva en la ventana activa (argv, sin shell intermedio).
 * - warp: Tab Config + warp://tab_config/<nombre> → pestaña nueva en la ventana activa de Warp.
 * - warp-window: launch configuration + warp://launch/<fichero> → ventana nueva (comportamiento antiguo).
 * `launch` permite sustituir el arranque real (tests); `probe`, la detección de 'auto'.
 * `prompt`: prompt ya construido (tareas K-<n> del tablero); sin él se construye el del ticket de Jira.
 * Devuelve {terminal, promptPath, yamlPath?|tomlPath?, uri?, argv?}.
 */
export function sendIssueToClaude({issue, base, description, repo, terminal, prompt = null, existing = null}, launch = null, probe = defaultProbe) {
    if (!KEY_RE.test(issue.key))
        throw new Error(`clave no válida: ${issue.key}`);
    if (!repo.startsWith('/') || !GLib.file_test(repo, GLib.FileTest.IS_DIR))
        throw new Error(`no existe ${repo}`);
    const term = resolveTerminal(terminal ?? 'auto', probe);
    if (!term)
        throw new Error('no hay ninguna terminal compatible (ptyxis, gnome-terminal, kgx o warp)');
    GLib.mkdir_with_parents(PROMPTS_DIR, 0o700);
    const promptPath = GLib.build_filenamev([PROMPTS_DIR, `${issue.key}.txt`]);
    // `prompt`: texto ya hecho (tareas locales del tablero, board.js localTaskPrompt); si no, el del ticket.
    GLib.file_set_contents(promptPath, prompt ?? buildPrompt(issue, base, description, repo, repoBranch(repo), existing));
    const openUri = launch ?? (o => openUriSoon(o.uri));
    if (term.id === 'warp') {
        GLib.mkdir_with_parents(WARP_TAB_DIR, 0o755);
        const stem = `kaito-${issue.key}`;
        const tomlPath = GLib.build_filenamev([WARP_TAB_DIR, `${stem}.toml`]);
        GLib.file_set_contents(tomlPath, warpTabToml(issue.key, repo, promptPath));
        pruneWarpTabs(`${stem}.toml`);
        const uri = `warp://tab_config/${stem}`;
        openUri({uri});
        return {terminal: term.id, promptPath, tomlPath, uri};
    }
    if (term.id === 'warp-window') {
        GLib.mkdir_with_parents(WARP_LAUNCH_DIR, 0o755);
        const name = `kaito-${issue.key}.yaml`;
        const yamlPath = GLib.build_filenamev([WARP_LAUNCH_DIR, name]);
        GLib.file_set_contents(yamlPath, warpLaunchYaml(issue.key, repo, promptPath));
        const uri = `warp://launch/${name}`;
        openUri({uri});
        return {terminal: term.id, promptPath, yamlPath, uri};
    }
    const argv = term.id === 'gnome-terminal' ? gnomeTerminalArgv(repo, promptPath, issue.key)
        : term.id === 'kgx' ? kgxArgv(repo, promptPath, issue.key)
            : ptyxisArgv(repo, promptPath, issue.key, term.flatpak);
    (launch ?? (() => Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE)))({argv});
    return {terminal: term.id, promptPath, argv};
}

// --- Uso de Claude (statusLine) y Codex (rollouts): límites de 5 h y semanales ---

export {USAGE_COLORS, usageColor, formatReset};
const CODEX_TAIL_BYTES = 256 * 1024;
const CODEX_MAX_DAYS = 7; // carpetas de fecha recientes que se miran
const CODEX_MAX_TRY = 3; // ficheros (del más nuevo al más viejo) que se leen buscando datos
const CODEX_RECHECK_S = 60;

export const clampPct = x => Math.min(100, Math.max(0, Number(x)));

/** Epoch en segundos desde segundos, milisegundos o ISO 8601; null si no es válido. */
export function toEpochS(v) {
    let n = typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v)
        : typeof v === 'string' ? Date.parse(v) / 1000 : Number(v);
    if (v === null || v === undefined || typeof v === 'boolean' || !Number.isFinite(n) || n <= 0)
        return null;
    if (n > 1e12)
        n /= 1000;
    return n;
}

/** Ventana {pct 0-100, resetsAt epoch s | null}; null si el porcentaje no es un número. */
export function normWindow(pct, resetsAt) {
    if (pct === null || pct === undefined || pct === '' || !Number.isFinite(Number(pct)))
        return null;
    return {pct: clampPct(pct), resetsAt: toEpochS(resetsAt)};
}

/** Contenido de claude-usage.json -> {ts, five, week}; null si no hay ninguna ventana. */
export function parseClaudeUsage(obj) {
    const rl = obj?.rate_limits;
    if (!rl || typeof rl !== 'object')
        return null;
    const five = normWindow(rl.five_hour?.used_percentage, rl.five_hour?.resets_at);
    const week = normWindow(rl.seven_day?.used_percentage, rl.seven_day?.resets_at);
    if (!five && !week)
        return null;
    return {ts: toEpochS(obj.ts), five, week};
}

/**
 * Reparte ventanas [{pct, resetsAt, windowMin}] en {five, week} por window_minutes
 * (300 / 10080); sin minutos se usa la posición (primera = 5 h, segunda = semana).
 */
export function pickWindows(list) {
    const out = {five: null, week: null};
    list.forEach((w, i) => {
        if (!w)
            return;
        const m = Number(w.windowMin);
        const hasMin = w.windowMin !== null && w.windowMin !== undefined && Number.isFinite(m) && m > 0;
        const kind = hasMin ? (m <= 1440 ? 'five' : 'week') : (i === 0 ? 'five' : 'week');
        out[kind] ??= {pct: w.pct, resetsAt: w.resetsAt};
    });
    return out;
}

/** Línea de rollout de Codex -> {ts, five, week}; null si no es un token_count con rate_limits. */
export function parseCodexLine(line) {
    let o;
    try {
        o = JSON.parse(line);
    } catch (_e) {
        return null;
    }
    const rl = o?.type === 'event_msg' && o.payload?.type === 'token_count' ? o.payload.rate_limits : null;
    if (!rl || typeof rl !== 'object')
        return null;
    const ts = toEpochS(o.timestamp);
    const win = w => {
        if (!w || typeof w !== 'object')
            return null;
        let reset = toEpochS(w.resets_at);
        const rel = Number(w.resets_in_seconds);
        if (reset === null && ts !== null && w.resets_in_seconds !== null && Number.isFinite(rel))
            reset = ts + rel;
        const n = normWindow(w.used_percent, reset);
        return n && {...n, windowMin: w.window_minutes};
    };
    const picked = pickWindows([win(rl.primary), win(rl.secondary)]);
    if (!picked.five && !picked.week)
        return null;
    return {ts, ...picked};
}

/** Última línea token_count con límites de un texto de rollout (de atrás hacia delante). */
export function lastCodexUsage(text) {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"token_count"'))
            continue;
        const u = parseCodexLine(lines[i]);
        if (u)
            return u;
    }
    return null;
}

/** Ventana vencida (resetsAt < ahora) = 0 % "reiniciado". */
export function applyStaleness(win, nowS) {
    if (!win)
        return null;
    const reset = win.resetsAt !== null && win.resetsAt < nowS;
    return {pct: reset ? 0 : win.pct, resetsAt: win.resetsAt, reset};
}

/** "5 h 42% · se reinicia 14:30", "Semana 18% · lun 09:00", "5 h 0% · reiniciado". */
export function usageLabel(kind, win, nowS) {
    const name = kind === 'five' ? '5 h' : 'Semana';
    const head = `${name} ${Math.round(win.pct)}%`;
    if (win.reset)
        return `${head} · reiniciado`;
    if (win.resetsAt === null)
        return head;
    const when = formatReset(win.resetsAt, nowS, kind === 'week');
    return `${head} · ${kind === 'five' ? 'se reinicia ' : ''}${when}`;
}

/** "actualizado hace 12 min" (o "ahora" con menos de 1 min). */
export function ageLabel(ts, nowS) {
    if (ts === null || ts === undefined)
        return '';
    const m = Math.max(0, Math.floor((nowS - ts) / 60));
    if (m < 1)
        return 'actualizado ahora';
    if (m < 60)
        return `actualizado hace ${m} min`;
    if (m < 48 * 60)
        return `actualizado hace ${Math.floor(m / 60)} h`;
    return `actualizado hace ${Math.floor(m / 1440)} d`;
}

/** Datos de un proveedor -> vista para pintar: {age, five, week} con staleness aplicada. */
export function usageView(u, nowS) {
    if (!u)
        return null;
    const mk = (kind, w) => {
        const a = applyStaleness(w, nowS);
        return a && {...a, label: usageLabel(kind, a, nowS), color: usageColor(a.pct)};
    };
    const five = mk('five', u.five), week = mk('week', u.week);
    return five || week ? {five, week, age: ageLabel(u.ts, nowS), ts: u.ts ?? null} : null;
}

export function readClaudeUsage(path = CLAUDE_USAGE_PATH) {
    return parseClaudeUsage(readJson(path, null));
}

/** JSON con comentarios de línea (opencode.jsonc): se quitan las líneas que empiezan por //. Solo lectura. */
function readJsonc(path) {
    const t = readBytesText(path);
    if (t === null)
        return null;
    try {
        return JSON.parse(t.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n'));
    } catch (_e) {
        return null;
    }
}

const opencodeCache = {t: -Infinity, id: null};
/** Proveedor del modelo de OpenCode (su config o el último modelo usado); solo lectura, caché de 60 s. */
export function readOpencodeProvider(nowMono = GLib.get_monotonic_time() / 1e6) {
    if (nowMono - opencodeCache.t < 60)
        return opencodeCache.id;
    const conf = GLib.build_filenamev([GLib.get_user_config_dir(), 'opencode']);
    const config = readJsonc(GLib.build_filenamev([conf, 'opencode.json'])) ?? readJsonc(GLib.build_filenamev([conf, 'opencode.jsonc']));
    const stateDir = GLib.getenv('XDG_STATE_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.local', 'state']);
    const state = readJsonc(GLib.build_filenamev([stateDir, 'opencode', 'model.json']));
    opencodeCache.id = opencodeProvider(config, state);
    opencodeCache.t = nowMono;
    return opencodeCache.id;
}

/** Ficheros rollout-*.jsonl recientes [{path, mtime, size}], del más nuevo al más viejo. */
function recentRollouts(root) {
    const sub = (dir, re) => {
        try {
            const it = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
            const names = [];
            for (const i of it) {
                if (i.get_file_type() === Gio.FileType.DIRECTORY && re.test(i.get_name()))
                    names.push(i.get_name());
            }
            return names.sort().reverse();
        } catch (_e) {
            return [];
        }
    };
    const days = [];
    outer: for (const y of sub(root, /^\d{4}$/)) {
        for (const m of sub(`${root}/${y}`, /^\d{2}$/)) {
            for (const d of sub(`${root}/${y}/${m}`, /^\d{2}$/)) {
                days.push(`${root}/${y}/${m}/${d}`);
                if (days.length >= CODEX_MAX_DAYS)
                    break outer;
            }
        }
    }
    const files = [];
    for (const dir of days) {
        try {
            const it = Gio.File.new_for_path(dir).enumerate_children(
                'standard::name,standard::size,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            for (const i of it) {
                const n = i.get_name();
                if (n.startsWith('rollout-') && n.endsWith('.jsonl'))
                    files.push({path: `${dir}/${n}`, mtime: i.get_modification_date_time().to_unix(), size: i.get_size()});
            }
        } catch (_e) { /* carpeta ilegible */ }
    }
    return files.sort((a, b) => b.mtime - a.mtime);
}

/** Últimos 256 KB del fichero como texto (se descarta la primera línea, que puede venir cortada). */
function readCodexTail(path, size) {
    const stream = Gio.File.new_for_path(path).read(null);
    try {
        const start = Math.max(0, size - CODEX_TAIL_BYTES);
        if (start > 0)
            stream.seek(start, GLib.SeekType.SET, null);
        const bytes = stream.read_bytes(CODEX_TAIL_BYTES, null).toArray();
        let text = new TextDecoder().decode(bytes);
        if (start > 0)
            text = text.slice(text.indexOf('\n') + 1);
        return text;
    } finally {
        stream.close(null);
    }
}

const codexCache = {checked: -Infinity, key: null, usage: null};

/**
 * Uso de Codex del rollout más reciente que traiga límites. Como mucho una búsqueda cada 60 s;
 * si el fichero más nuevo no ha cambiado (ruta + mtime + tamaño) no se vuelve a leer.
 * Solo se conservan números: nunca el contenido de la conversación.
 */
export function readCodexUsage(root = CODEX_SESSIONS, cache = codexCache, nowMono = GLib.get_monotonic_time() / 1e6) {
    if (nowMono - cache.checked < CODEX_RECHECK_S)
        return cache.usage;
    cache.checked = nowMono;
    const files = recentRollouts(root);
    const key = files.length ? `${files[0].path}|${files[0].mtime}|${files[0].size}` : null;
    if (key === cache.key)
        return cache.usage;
    cache.key = key;
    cache.usage = null;
    for (const f of files.slice(0, CODEX_MAX_TRY)) {
        try {
            const u = lastCodexUsage(readCodexTail(f.path, f.size));
            if (u) {
                cache.usage = u;
                break;
            }
        } catch (e) {
            console.warn(`kaito: rollout de Codex ilegible: ${e.message}`);
        }
    }
    return cache.usage;
}

// --- Actualizaciones (bin/kaito check/update; los usa updates.js) ---

const ANSI_RE = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex

/** {version, relogin, updated} de la línea final de `kaito update` con KAITO_UPDATE_FROM_SHELL=1. */
export function parseUpdateMarker(out) {
    const m = /^kaito-update: version=(\S+) relogin=([01]) updated=([01])\s*$/m.exec(String(out ?? ''));
    return m ? {version: m[1], relogin: m[2] === '1', updated: m[3] === '1'} : null;
}

/** Primera línea de error útil de la salida de `kaito update` (sin colores). */
export function firstErrorLine(out) {
    const lines = String(out ?? '').replace(ANSI_RE, '').split('\n').map(l => l.trim()).filter(Boolean);
    const bad = lines.find(l => l.startsWith('✗')) ?? lines.find(l => /error|fatal|falló/i.test(l)) ?? lines.at(-1);
    return (bad ?? 'error desconocido').replace(/^✗\s*/, '');
}

/** {behind, latest} de `kaito check --json`; null si no se pudo comprobar. */
export function parseCheck(out) {
    try {
        const j = JSON.parse(String(out ?? '').trim().split('\n').at(-1));
        if (j.error || !Number.isFinite(Number(j.behind)))
            return null;
        const changes = (Array.isArray(j.changes) ? j.changes : []).filter(c => typeof c === 'string' && c.trim()).slice(0, 5);
        return {behind: Number(j.behind), latest: j.latest ?? null, current: j.current ?? null, changes};
    } catch {
        return null;
    }
}

/** Puro. Cuerpo de la notificación de versión nueva: hasta `max` asuntos de commit (y "… y N más"). */
export function changelogBody(changes, max = 3) {
    const list = (Array.isArray(changes) ? changes : []).map(c => String(c ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!list.length)
        return 'Pulsa Actualizar para instalarla';
    const cut = s => (s.length > 90 ? `${s.slice(0, 89)}…` : s);
    const lines = list.slice(0, max).map(c => `• ${cut(c)}`);
    if (list.length > max)
        lines.push(`… y ${list.length - max} más`);
    return lines.join('\n');
}

// --- Aviso de actualización (una notificación por versión) ---

export const UPDATE_STATE_PATH = GLib.build_filenamev([CACHE_DIR, 'update.json']);

export const readUpdateState = () => {
    const v = readJson(UPDATE_STATE_PATH, {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
};

export function writeUpdateState(patch) {
    GLib.mkdir_with_parents(CACHE_DIR, 0o755);
    GLib.file_set_contents(UPDATE_STATE_PATH, JSON.stringify({...readUpdateState(), ...patch}));
}

// --- No molestar: cola de avisos "Mientras no estabas" ---

export const QUIET_QUEUE_PATH = GLib.build_filenamev([CACHE_DIR, 'quiet-queue.json']);

export function readQuietQueue() {
    const v = readJson(QUIET_QUEUE_PATH, []);
    return Array.isArray(v) ? v : [];
}

export function writeQuietQueue(queue) {
    GLib.mkdir_with_parents(CACHE_DIR, 0o755);
    GLib.file_set_contents(QUIET_QUEUE_PATH, JSON.stringify(queue));
}

// --- Tablero de tareas (board.js): todos.json ampliado + contador K-<n> en kanban.json ---

export const KANBAN_PATH = GLib.build_filenamev([CONF_DIR, 'kanban.json']);
// `kaito kanban` toca este fichero; la extensión lo vigila y abre el tablero.
export const OPEN_KANBAN_PATH = GLib.build_filenamev([CACHE_DIR, 'open-kanban']);

export function readTodos() {
    const v = readJson(TODOS_PATH, []);
    return Array.isArray(v) ? v : [];
}

/** Pendientes migrados a tareas (ids K-<n>, estado, prioridad); escribe solo si algo cambió. */
export function readBoard() {
    const raw = readTodos();
    const seq = Number(readJson(KANBAN_PATH, {})?.seq) || 0;
    const r = migrateTodos(raw, seq);
    if (r.changed)
        writeJson(TODOS_PATH, r.todos);
    if (r.seq !== seq)
        writeJson(KANBAN_PATH, {seq: r.seq});
    return r.todos;
}

/** Lectura-modificación-escritura de una tarea por id (fn recibe una copia y devuelve la nueva, o null para borrarla). */
export function patchBoardTask(id, fn) {
    const todos = readBoard();
    const i = todos.findIndex(t => t.id === id);
    if (i < 0)
        return null;
    const next = fn({...todos[i]});
    if (next && JSON.stringify(next) === JSON.stringify(todos[i]))
        return next; // sin cambios: no se reescribe (el monitor de todos.json repintaría por nada)
    if (next)
        todos[i] = next;
    else
        todos.splice(i, 1);
    writeJson(TODOS_PATH, todos);
    return next;
}

/** Añade una tarea nueva (K-<n>) y devuelve la tarea. */
export function addBoardTask(fields) {
    const todos = readBoard();
    const seq = Number(readJson(KANBAN_PATH, {})?.seq) || 0;
    const {task, seq: n} = newTask(todos, seq, fields);
    writeJson(TODOS_PATH, [...todos, task]);
    writeJson(KANBAN_PATH, {seq: n});
    return task;
}

// --- Panel de avisos (inbox.js): ~/.cache/kaito/inbox.json ---

export const INBOX_PATH = GLib.build_filenamev([CACHE_DIR, 'inbox.json']);

export const readInbox = () => normalizeInbox(readJson(INBOX_PATH, []));

export function writeInbox(list) {
    GLib.mkdir_with_parents(CACHE_DIR, 0o755);
    GLib.file_set_contents(INBOX_PATH, JSON.stringify(list));
}

// --- Proveedores de agentes (providers.js): ejecutables instalados y sesiones vivas ---

const PROVIDERS_RECHECK_S = 300;
const providersCache = {t: -Infinity, list: null};

/** Carpetas bin de nvm (~/.nvm/versions/node/<v>/bin), la versión más nueva primero. */
function nvmBins(home) {
    const root = GLib.build_filenamev([home, '.nvm', 'versions', 'node']);
    const out = [];
    try {
        for (const i of Gio.File.new_for_path(root).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null))
            out.push(i.get_name());
    } catch (_e) { /* sin nvm */ }
    const ver = n => n.replace(/^v/, '').split('.').map(Number);
    out.sort((a, b) => {
        const [x, y] = [ver(a), ver(b)];
        return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]);
    });
    return out.map(n => GLib.build_filenamev([root, n, 'bin']));
}

/** Ruta de un ejecutable en las carpetas de searchDirs, o null. */
export function findAgentBin(bin, dirs = null) {
    dirs ??= searchDirs(GLib.get_home_dir(), GLib.getenv('PATH') ?? '', nvmBins(GLib.get_home_dir()));
    for (const d of dirs) {
        const p = GLib.build_filenamev([d, bin]);
        if (GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE) && !GLib.file_test(p, GLib.FileTest.IS_DIR))
            return p;
    }
    return null;
}

/** Proveedores conocidos con su ruta (cacheado 5 min; force para Ajustes). */
export function installedProviders(force = false, nowMono = GLib.get_monotonic_time() / 1e6) {
    if (!force && providersCache.list && nowMono - providersCache.t < PROVIDERS_RECHECK_S)
        return providersCache.list;
    const dirs = searchDirs(GLib.get_home_dir(), GLib.getenv('PATH') ?? '', nvmBins(GLib.get_home_dir()));
    providersCache.list = detectProviders(b => findAgentBin(b, dirs));
    providersCache.t = nowMono;
    return providersCache.list;
}

const readBytesText = path => {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch (_e) {
        return null;
    }
};

/**
 * Procesos de agentes que no son Claude [{pid, ppid, provider, cwd, startMs}] (solo los propios: el cwd de los
 * ajenos no se puede leer). providers: ids a buscar.
 */
export function scanAgentProcesses(providers) {
    const want = new Set(providers);
    const found = [];
    if (!want.size)
        return found;
    let en;
    try {
        en = Gio.File.new_for_path('/proc').enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (_e) {
        return found;
    }
    for (const info of en) {
        const name = info.get_name();
        if (!/^\d+$/.test(name))
            continue;
        const cmd = readBytesText(`/proc/${name}/cmdline`);
        if (!cmd)
            continue; // hilo del kernel o proceso ya terminado
        const argv = cmd.split('\0').filter((a, i, all) => a !== '' || i < all.length - 1);
        const provider = matchAgentProcess(argv, '');
        if (!provider || !want.has(provider))
            continue;
        let cwd;
        try {
            cwd = GLib.file_read_link(`/proc/${name}/cwd`);
        } catch (_e) {
            continue; // de otro usuario
        }
        const ppid = Number(/^PPid:\s*(\d+)/m.exec(readBytesText(`/proc/${name}/status`) ?? '')?.[1]) || 0;
        let startMs = null;
        try {
            const q = Gio.File.new_for_path(`/proc/${name}`).query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
            startMs = q.get_modification_date_time().to_unix() * 1000;
        } catch (_e) { /* terminó entre medias */ }
        found.push({pid: Number(name), ppid, provider, cwd, startMs});
    }
    return dedupeProcesses(found);
}

/** Rollout de Codex abierto por el proceso (/proc/<pid>/fd), o null. */
function rolloutFromFds(pid) {
    let en;
    try {
        en = Gio.File.new_for_path(`/proc/${pid}/fd`).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (_e) {
        return null;
    }
    for (const info of en) {
        let target;
        try {
            target = GLib.file_read_link(`/proc/${pid}/fd/${info.get_name()}`);
        } catch (_e) {
            continue;
        }
        if (target.startsWith(`${CODEX_SESSIONS}/`) && /\/rollout-[^/]*\.jsonl$/.test(target))
            return target;
    }
    return null;
}

const rolloutMetaCache = new Map(); // ruta -> {id, cwd}

function rolloutMeta(path) {
    if (rolloutMetaCache.has(path))
        return rolloutMetaCache.get(path);
    let meta = null;
    try {
        meta = parseRolloutMeta(readHead(Gio.File.new_for_path(path)));
    } catch (_e) { /* ilegible */ }
    if (meta) {
        if (rolloutMetaCache.size > 200)
            rolloutMetaCache.clear();
        rolloutMetaCache.set(path, meta);
    }
    return meta;
}

/** Rollout de una sesión de Codex: el que tiene abierto; si no, el más nuevo de su carpeta posterior al arranque. */
export function codexRolloutFor(proc, rollouts = null) {
    const fd = rolloutFromFds(proc.pid);
    if (fd)
        return {path: fd, how: 'fd'};
    for (const f of rollouts ?? recentRollouts(CODEX_SESSIONS)) {
        if (proc.startMs && f.mtime * 1000 < proc.startMs - 5000)
            break; // más viejo que el proceso: de otra sesión
        if (rolloutMeta(f.path)?.cwd === proc.cwd)
            return {path: f.path, how: 'cwd'};
    }
    return null;
}

const baseName = p => String(p ?? '').split('/').filter(Boolean).pop() ?? null;

/**
 * Agentes de proveedores que no son Claude, con la forma de collectAgents: {id, provider, pid, cwd, cwdPath, age,
 * live, state, lastAction, lastText, activityMs}. Codex: estado por su rollout (y el hook de notify); los demás:
 * solo proceso (state 'open').
 */
export function collectOtherAgents(providers, states = {}, liveS = DEFAULTS.liveSeconds) {
    const procs = scanAgentProcesses(providers);
    if (!procs.length)
        return [];
    const nowMs = Date.now();
    const rollouts = procs.some(p => p.provider === 'codex') ? recentRollouts(CODEX_SESSIONS) : [];
    const used = new Set();
    return procs.map(p => {
        const a = {
            id: `${p.provider}-pid${p.pid}`, provider: p.provider, pid: p.pid, cwd: baseName(p.cwd), cwdPath: p.cwd,
            age: p.startMs ? Math.max(0, Math.floor((nowMs - p.startMs) / 1000)) : 0, live: false, state: 'open',
            lastAction: null, lastText: null, activityMs: p.startMs ?? 0, ticket: null,
        };
        if (p.provider !== 'codex')
            return a;
        const r = codexRolloutFor(p, rollouts.filter(f => !used.has(f.path)));
        if (!r)
            return {...a, state: 'idle'};
        used.add(r.path);
        try {
            const q = Gio.File.new_for_path(r.path).query_info('standard::size,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            const mtimeMs = q.get_modification_date_time().to_unix() * 1000;
            const tail = parseCodexTail(readCodexTail(r.path, q.get_size()));
            const sid = rolloutId(r.path) ?? rolloutMeta(r.path)?.id ?? `pid${p.pid}`;
            const hook = states[`codex-${sid}`] ?? Object.entries(states).find(([k, s]) => k.startsWith('codex-cwd-') && s.cwd === p.cwd)?.[1] ?? null;
            const st = codexStatus({tail, mtimeMs, nowMs, liveS, hook});
            const msg = st.state === 'done' && hook?.message ? hook.message : null;
            return {
                ...a, id: `codex-${sid}`, live: st.live, state: st.state, lastAction: tail.lastAction,
                lastText: tail.lastText ?? msg, age: Math.max(0, Math.floor((nowMs - mtimeMs) / 1000)),
                activityMs: Math.max(mtimeMs, a.activityMs), rollout: r.how,
            };
        } catch (e) {
            console.warn(`kaito: rollout de Codex ${r.path}: ${e.message}`);
            return {...a, state: 'idle'};
        }
    });
}
