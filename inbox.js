// Panel de avisos (opcional, inboxEnabled): lógica pura del almacén (~/.cache/kaito/inbox.json) y de
// cómo sale cada aviso según el modo (trabajando, No molestar, fuera de horario).
// Sin imports de gi ni de la shell: se prueba con node y gjs (board.test.js).

export const INBOX_MAX = 100;
export const INBOX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const KINDS = ['needs', 'reminder', 'done', 'finished', 'task', 'update'];

/**
 * Puro. Cómo sale un aviso: 'interrupt' (tarjeta/notificación que se queda o modal de respuesta),
 * 'brief' (notificación de GNOME que se va sola) o 'panel' (solo el panel y el contador).
 * Siempre se guarda en el panel salvo 'none'. q: estado de No molestar {quiet, reason}.
 * - needs: interrumpe, también con No molestar manual; fuera de horario espera en el panel (punto naranja).
 * - reminder: lo decide ReminderManager como siempre (sin sonido con No molestar, retenido si se pide).
 * - done / finished / task: aviso breve; con cualquier silencio, solo panel.
 * - update: solo panel (y el punto azul de siempre).
 */
export function inboxRoute(kind, q = null) {
    const quiet = !!q?.quiet;
    switch (kind) {
    case 'needs':
        return quiet && q.reason === 'schedule' ? 'panel' : 'interrupt';
    case 'reminder':
        return 'interrupt';
    case 'done':
    case 'finished':
    case 'task':
        return quiet ? 'panel' : 'brief';
    case 'update':
        return 'panel';
    default:
        return 'none';
    }
}

const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : v == null ? null : String(v).slice(0, max));

/** Puro. Aviso saneado (o null si no vale). */
export function normalizeItem(it, now = Date.now()) {
    if (!it || typeof it !== 'object' || typeof it.id !== 'string' || !it.id || typeof it.title !== 'string')
        return null;
    const ts = Number(it.ts);
    return {
        id: it.id.slice(0, 300),
        kind: KINDS.includes(it.kind) ? it.kind : 'done',
        agentId: str(it.agentId, 200),
        provider: str(it.provider, 40),
        repo: str(it.repo, 200),
        title: it.title.slice(0, 300),
        body: str(it.body) ?? '',
        cmd: str(it.cmd, 1000),
        actions: (Array.isArray(it.actions) ? it.actions : [])
            .filter(a => a && typeof a.label === 'string' && a.action && typeof a.action === 'object')
            .slice(0, 4).map(a => ({label: a.label.slice(0, 60), action: a.action})),
        ts: Number.isFinite(ts) && ts > 0 ? ts : now,
        read: it.read === true,
        resolved: typeof it.resolved === 'string' && it.resolved ? it.resolved.slice(0, 300) : null,
    };
}

/** Puro. Quita los de más de 7 días y deja como mucho `max`, los más nuevos primero. */
export function pruneInbox(list, now = Date.now(), max = INBOX_MAX) {
    return (Array.isArray(list) ? list : []).filter(x => x && now - x.ts < INBOX_MAX_AGE_MS)
        .sort((a, b) => b.ts - a.ts).slice(0, max);
}

/** Puro. Lista leída de disco → avisos válidos, sin ids repetidos (gana el más nuevo), podada. */
export function normalizeInbox(raw, now = Date.now(), max = INBOX_MAX) {
    const byId = new Map();
    for (const r of Array.isArray(raw) ? raw : []) {
        const it = normalizeItem(r, now);
        if (it && (!byId.has(it.id) || byId.get(it.id).ts <= it.ts))
            byId.set(it.id, it);
    }
    return pruneInbox([...byId.values()], now, max);
}

/**
 * Puro. Añade (o sustituye, mismo id) un aviso: pasa arriba como no leído y sin resolver.
 * Devuelve la lista nueva (no modifica la de entrada).
 */
export function inboxPush(list, item, now = Date.now(), max = INBOX_MAX) {
    const it = normalizeItem({...item, ts: item?.ts ?? now, read: false, resolved: null}, now);
    if (!it)
        return pruneInbox(list, now, max);
    return pruneInbox([it, ...(Array.isArray(list) ? list : []).filter(x => x?.id !== it.id)], now, max);
}

export const unreadCount = list => (Array.isArray(list) ? list : []).filter(x => !x.read).length;
export const markAllRead = list => (Array.isArray(list) ? list : []).map(x => (x.read ? x : {...x, read: true}));

/** Puro. Marca un aviso como resuelto con un texto ("Permitido · sigue trabajando"). */
export function resolveItem(list, id, text) {
    return (Array.isArray(list) ? list : []).map(x => (x.id === id ? {...x, resolved: String(text), read: true} : x));
}

/** Puro. ¿Hay un "te necesita" sin resolver? (punto naranja del icono). */
export const pendingNeeds = list => (Array.isArray(list) ? list : []).some(x => x.kind === 'needs' && !x.resolved);

/** Puro. Clave de grupo: el agente; si no hay, la fuente (tarea, recordatorios, Kaito). */
export function groupKey(it) {
    if (it.agentId)
        return `agent:${it.agentId}`;
    if (it.kind === 'task')
        return `task:${it.repo ?? it.title}`;
    return it.kind === 'reminder' ? 'reminders' : 'kaito';
}

/** Puro. Grupos [{key, items (nuevo primero), latest}] ordenados por el aviso más nuevo. */
export function groupInbox(list) {
    const groups = new Map();
    for (const it of [...(Array.isArray(list) ? list : [])].sort((a, b) => b.ts - a.ts)) {
        const k = groupKey(it);
        if (!groups.has(k))
            groups.set(k, {key: k, items: [], latest: it});
        groups.get(k).items.push(it);
    }
    return [...groups.values()];
}

/** Puro. "Kaito" → "KA", "mp_kontan" → "MK", "stats-dashboard" → "SD". */
export function initials(name) {
    const parts = String(name ?? '').split(/[^A-Za-z0-9ÁÉÍÓÚÑáéíóúñ]+/).filter(Boolean);
    if (!parts.length)
        return '?';
    if (parts.length === 1)
        return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Puro. "ahora", "hace 6 min", "hace 2 h", "hace 3 d". */
export function agoLabel(ts, now = Date.now()) {
    const s = Math.max(0, Math.floor((now - ts) / 1000));
    if (s < 60)
        return 'ahora';
    if (s < 3600)
        return `hace ${Math.floor(s / 60)} min`;
    if (s < 86400)
        return `hace ${Math.floor(s / 3600)} h`;
    return `hace ${Math.floor(s / 86400)} d`;
}

/** Puro. Minutos de "No molestar" del pie: pasos de 15 entre 15 y 240. */
export const clampDndMinutes = m => Math.min(240, Math.max(15, Math.round((Number(m) || 30) / 15) * 15));
