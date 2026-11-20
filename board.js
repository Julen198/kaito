// Tablero de tareas (opcional, kanbanEnabled): lógica pura sobre los pendientes de todos.json.
// Sin imports de gi ni de la shell: se prueba con node y gjs (board.test.js).
//
// Compatibilidad: todos.json sigue siendo una lista de {text, done}. El tablero añade campos opcionales
// {id: "K-<n>", state, priority, repo, description, created, updated} y mantiene `done` en sincronía con
// `state`, así la lista antigua de "Pendientes" sigue funcionando si se desactiva el tablero.

export const STATES = ['todo', 'doing', 'review', 'done'];
export const STATE_NAMES = {todo: 'Por hacer', doing: 'Haciendo', review: 'En revisión', done: 'Hecho'};
export const STATE_COLORS = {todo: '#9A9996', doing: '#5BC8AF', review: '#FFA348', done: '#78AEED'};
export const PRIORITIES = ['highest', 'high', 'medium', 'low'];
export const PRIORITY_GLYPHS = {
    highest: ['⇈', '#F15B50', 'Más alta'], high: ['↑', '#F2795B', 'Alta'],
    medium: ['=', '#FFAB00', 'Media'], low: ['↓', '#4C9AFF', 'Baja'],
};
export const DEFAULT_PRIORITY = 'medium';
export const LOCAL_KEY_RE = /^K-(\d+)$/;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const PRIO_RANK = {highest: 0, high: 1, medium: 2, low: 3};

export const isLocalKey = k => LOCAL_KEY_RE.test(String(k ?? ''));
const keyNum = k => Number(LOCAL_KEY_RE.exec(String(k ?? ''))?.[1] ?? 0);

/** Estado de un pendiente: el guardado si es válido; si no, el que se deduce de `done`. */
export function todoState(t) {
    return STATES.includes(t?.state) ? t.state : t?.done ? 'done' : 'todo';
}

/** Mayor n de los K-n de la lista (0 si no hay). */
export function maxKey(todos) {
    return (Array.isArray(todos) ? todos : []).reduce((m, t) => Math.max(m, keyNum(t?.id)), 0);
}

/**
 * Puro. Migra/sincroniza la lista: a cada pendiente sin id le da K-<n> (contador `seq`, persistido aparte
 * para no reutilizar números), estado (de `done`), prioridad media y fechas. Si `done` y `state` no casan,
 * manda `done` (es lo que escribe la lista antigua). Devuelve {todos, seq, changed}; no modifica la entrada.
 */
export function migrateTodos(raw, seq = 0, now = Date.now()) {
    let n = Math.max(Number(seq) || 0, maxKey(raw));
    let changed = false;
    const seen = new Set();
    const todos = (Array.isArray(raw) ? raw : []).filter(t => t && typeof t === 'object' && typeof t.text === 'string')
        .map(t0 => {
            const t = {...t0};
            if (!isLocalKey(t.id) || seen.has(t.id)) {
                t.id = `K-${++n}`;
                changed = true;
            }
            seen.add(t.id);
            let state = todoState(t);
            if (t.done === true && state !== 'done')
                state = 'done';
            else if (t.done !== true && state === 'done' && 'done' in t)
                state = 'todo';
            if (t.state !== state) {
                t.state = state;
                changed = true;
            }
            if (t.done !== (state === 'done')) {
                t.done = state === 'done';
                changed = true;
            }
            if (!PRIORITIES.includes(t.priority)) {
                t.priority = DEFAULT_PRIORITY;
                changed = true;
            }
            if (!Number.isFinite(Number(t.created)) || !t.created) {
                t.created = Number(t.ts) || now;
                changed = true;
            }
            if (!Number.isFinite(Number(t.updated)) || !t.updated) {
                t.updated = t.created;
                changed = true;
            }
            return t;
        });
    if ((Array.isArray(raw) ? raw.length : 0) !== todos.length)
        changed = true;
    return {todos, seq: n, changed};
}

/** Puro. Nueva tarea K-<seq+1>. Devuelve {task, seq}. */
export function newTask(todos, seq, {text, priority = DEFAULT_PRIORITY, repo = null, description = '', state = 'todo'}, now = Date.now()) {
    const n = Math.max(Number(seq) || 0, maxKey(todos)) + 1;
    const st = STATES.includes(state) ? state : 'todo';
    const task = {
        text: String(text ?? '').trim(), done: st === 'done', id: `K-${n}`, state: st,
        priority: PRIORITIES.includes(priority) ? priority : DEFAULT_PRIORITY,
        repo: repo || null, description: String(description ?? ''), created: now, updated: now,
    };
    return {task, seq: n};
}

/** Puro. Cambia el estado (y `done`) de una tarea. Devuelve la tarea nueva. */
export function withState(t, state, now = Date.now()) {
    const st = STATES.includes(state) ? state : todoState(t);
    return {...t, state: st, done: st === 'done', updated: now};
}

/** Puro. Estado vecino: dir = +1 (siguiente) o -1 (anterior); null en los extremos. */
export function stepState(state, dir) {
    const i = STATES.indexOf(state);
    const j = i + (dir > 0 ? 1 : -1);
    return i < 0 || j < 0 || j >= STATES.length ? null : STATES[j];
}

/** Puro. Siguiente prioridad en ciclo (para el chip). */
export function cyclePriority(p) {
    const i = PRIORITIES.indexOf(p);
    return PRIORITIES[(i < 0 ? PRIORITIES.indexOf(DEFAULT_PRIORITY) : i + 1) % PRIORITIES.length];
}

const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Puro. ¿Casa la tarea con la búsqueda? Todas las palabras en id, título, descripción o repo. */
export function matchesQuery(t, query) {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    if (!terms.length)
        return true;
    const repo = String(t?.repo ?? '');
    const hay = fold([t?.id, t?.text, t?.description, repo, repo.split('/').filter(Boolean).pop()].join(' '));
    return terms.every(x => hay.includes(x));
}

/**
 * Puro. Columnas del tablero: {todo, doing, review, done} con las tareas que casan con `query`,
 * por prioridad y luego la más reciente primero.
 */
export function boardColumns(todos, query = '') {
    const cols = {todo: [], doing: [], review: [], done: []};
    for (const t of Array.isArray(todos) ? todos : []) {
        if (t && typeof t.text === 'string' && matchesQuery(t, query))
            cols[todoState(t)].push(t);
    }
    const rank = t => PRIO_RANK[t.priority] ?? PRIO_RANK[DEFAULT_PRIORITY];
    for (const k of STATES) {
        cols[k].sort((a, b) => k === 'done'
            ? (Number(b.updated) || 0) - (Number(a.updated) || 0)
            : rank(a) - rank(b) || (Number(b.updated) || 0) - (Number(a.updated) || 0));
    }
    return cols;
}

/** Puro. {open, doneWeek}: abiertas (no hechas) y hechas en los últimos 7 días. */
export function boardCounts(todos, now = Date.now()) {
    let open = 0, doneWeek = 0;
    for (const t of Array.isArray(todos) ? todos : []) {
        if (!t || typeof t.text !== 'string')
            continue;
        if (todoState(t) !== 'done')
            open++;
        else if (now - (Number(t.updated) || 0) < WEEK_MS)
            doneWeek++;
    }
    return {open, doneWeek};
}

/** Puro. "Exportar informe de ventas" → "exportar-informe-de-ventas" (máx. `max` caracteres). */
export function taskSlug(title, max = 40) {
    const s = fold(title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return (s.slice(0, max).replace(/-+$/, '') || 'tarea');
}

/** Puro. "hace 5 min" / "hace 3 h" / "hace 2 d" a partir de un timestamp unix (s). */
export function relAgo(ts, now = Date.now() / 1000) {
    const d = Math.max(0, now - Number(ts));
    if (!Number.isFinite(d))
        return 'hace tiempo';
    if (d < 60)
        return 'hace menos de 1 min';
    if (d < 3600)
        return `hace ${Math.floor(d / 60)} min`;
    if (d < 86400)
        return `hace ${Math.floor(d / 3600)} h`;
    return `hace ${Math.floor(d / 86400)} d`;
}

/**
 * Puro. `existing` = {repo, branch, local, remote, ts} (findTicketBranches) y `repo` el elegido →
 * {here, other}: `here` si la rama está en ese repo; `other` (línea "Ojo: ...") si está en otro.
 */
export function splitExisting(repo, existing) {
    if (!existing?.branch)
        return {here: null, other: ''};
    if (existing.repo === repo)
        return {here: existing, other: ''};
    const name = String(existing.repo ?? '').split('/').filter(Boolean).pop() ?? existing.repo;
    return {here: null, other: `Ojo: hay una rama de este ticket en ${name} (${existing.branch}).\n`};
}

/**
 * Puro. Párrafo de Git del prompt (el mismo para tickets de Jira y tareas locales).
 * `branch`: nombre sugerido de la rama (p. ej. "RUN-1-<resumen-corto>" o "K-3-arreglar-login").
 * `here`: rama ya existente del ticket en este repo ({branch, local, remote, ts}): se continúa en ella.
 */
export function gitInstructions(key, branch, here = null, now = Date.now() / 1000) {
    const tail = 'Haz commits pequeños a medida que completes partes, con mensajes que empiecen por ' +
        `"${key}: ". Al terminar deja todo commiteado (git status limpio) y sube la rama a origin con ` +
        '`git push -u origin <rama>`. Nunca hagas push a main, master ni develop, nunca uses force-push ' +
        'y no abras PR.\n';
    if (!here?.branch)
        return `Git: trabaja en una rama propia (si estás en main, master o develop, crea una llamada ${branch}). ${tail}`;
    const b = here.branch;
    const where = here.local && here.remote ? 'subida a origin' : here.local ? 'solo local' : 'solo en origin';
    return `Git: Ya existe la rama \`${b}\` para este ticket en este repo (último commit ${relAgo(here.ts, now)}, ${where}). ` +
        `Cámbiate a ella (git switch ${b}; si solo está en origin: git switch --track origin/${b}) y continúa ahí; ` +
        `no crees otra rama. ${tail.replace('<rama>', b)}`;
}

/** Puro. Prompt para mandar una tarea local a Claude (lo reconoce agents.js ticketFromHead). */
export function localTaskPrompt(task, repo = null, branch = null, existing = null) {
    let s = `Trabaja en la tarea ${task.id}: ${String(task.text ?? '').trim()}\n`;
    const desc = String(task.description ?? '').trim();
    if (desc)
        s += `${desc}\n`;
    if (repo)
        s += `Repo de trabajo: ${repo.split('/').filter(Boolean).pop() ?? repo} (${repo})${branch ? `, rama ${branch}` : ''}\n`;
    if (!desc)
        s += 'La tarea tiene poco detalle: antes de cambiar código, explora el repo, resume lo que entiendes y pregúntame lo que falte.\n';
    const {here, other} = splitExisting(repo, existing);
    s += other + gitInstructions(task.id, `${task.id}-${taskSlug(task.text)}`, here);
    return s;
}
