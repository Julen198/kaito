// "No molestar" y horario de trabajo. Lógica pura (sin imports de gi ni de la shell): se prueba con node y gjs.
// Todas las horas son locales (Date con componentes locales), así los cambios de horario (DST) no descuadran.

export const DEFAULT_WORK_HOURS = {enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00'};
export const QUEUE_MAX = 30;
const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "09:30" → 570 (minutos desde medianoche); null si no es una hora válida. */
export function parseHHMM(s) {
    const m = HHMM_RE.exec(String(s ?? '').trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 570 → "09:30". */
export const fmtHHMM = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Día ISO de la semana de una fecha local: lunes = 1 … domingo = 7. */
export const isoDay = d => d.getDay() === 0 ? 7 : d.getDay();

/** workHours de config.json saneado (valores por defecto en lo que falte o sea inválido). */
export function normalizeWorkHours(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const days = Array.isArray(r.days)
        ? [...new Set(r.days.map(Number).filter(d => Number.isInteger(d) && d >= 1 && d <= 7))].sort()
        : [...DEFAULT_WORK_HOURS.days];
    return {
        enabled: r.enabled === true,
        days,
        start: parseHHMM(r.start) !== null ? fmtHHMM(parseHHMM(r.start)) : DEFAULT_WORK_HOURS.start,
        end: parseHHMM(r.end) !== null ? fmtHHMM(parseHHMM(r.end)) : DEFAULT_WORK_HOURS.end,
    };
}

/** Fecha local del día de `d` (+ offset días) a la hora `min`. */
function atLocal(d, offsetDays, min) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays, Math.floor(min / 60), min % 60, 0, 0);
}

/**
 * ¿`now` cae dentro del horario de trabajo? Tramo nocturno (start > end, p. ej. 22:00–06:00): empieza el día
 * marcado y sigue hasta `end` del día siguiente. start === end: el día marcado entero.
 */
export function inWorkHours(now, wh) {
    const s = parseHHMM(wh.start), e = parseHHMM(wh.end);
    const days = new Set(wh.days);
    const m = now.getHours() * 60 + now.getMinutes();
    const today = isoDay(now);
    const yesterday = today === 1 ? 7 : today - 1;
    if (s === e)
        return days.has(today);
    if (s < e)
        return days.has(today) && m >= s && m < e;
    return (days.has(today) && m >= s) || (days.has(yesterday) && m < e);
}

/** Próximo inicio de jornada estrictamente posterior a `now`; null si no hay días marcados. */
export function nextWorkStart(now, wh) {
    const s = parseHHMM(wh.start);
    const days = new Set(wh.days);
    if (s === null || !days.size)
        return null;
    for (let i = 0; i <= 8; i++) {
        const c = atLocal(now, i, s);
        if (c > now && days.has(isoDay(c)))
            return c;
    }
    return null;
}

/**
 * ¿Silencio ahora? cfg: {workHours, dndManual, dndUntil, dndSkipUntil} (epochs en ms).
 * → {quiet, reason: 'manual'|'schedule'|null, until: Date|null}
 * - Manual: dndManual, hasta dndUntil (si lo hay y no ha pasado; pasado, ya no cuenta).
 * - Horario: fuera de la jornada (si workHours.enabled), hasta el próximo inicio; dndSkipUntil > ahora lo anula
 *   ("Desactivar" mientras se está fuera de horario).
 */
export function isQuiet(now, cfg = {}) {
    const t = now.getTime();
    const until = Number(cfg.dndUntil);
    if (cfg.dndManual === true && (!Number.isFinite(until) || until <= 0 || until > t))
        return {quiet: true, reason: 'manual', until: Number.isFinite(until) && until > 0 ? new Date(until) : null};
    const wh = normalizeWorkHours(cfg.workHours);
    const skip = Number(cfg.dndSkipUntil);
    if (wh.enabled && !(Number.isFinite(skip) && skip > t) && !inWorkHours(now, wh))
        return {quiet: true, reason: 'schedule', until: nextWorkStart(now, wh)};
    return {quiet: false, reason: null, until: null};
}

/** "las 18:30" (hoy), "mañana 09:00", "lun 09:00". */
export function whenLabel(d, now) {
    const hm = fmtHHMM(d.getHours() * 60 + d.getMinutes());
    const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayD = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((dayD - day0) / 86400000);
    if (diff === 0)
        return `las ${hm}`;
    if (diff === 1)
        return `mañana ${hm}`;
    return `${DOW[d.getDay()]} ${hm}`;
}

/** Texto para el menú: "Fuera de horario hasta lun 09:00", "No molestar hasta las 15:20", "No molestar". */
export function quietLabel(q, now) {
    if (!q?.quiet)
        return '';
    const head = q.reason === 'schedule' ? 'Fuera de horario' : 'No molestar';
    return q.until ? `${head} hasta ${whenLabel(q.until, now)}` : head;
}

/** "Hasta mañana": hasta el próximo inicio de jornada (con o sin horario activado), mañana 09:00 por defecto. */
export function untilTomorrow(now, workHours) {
    const wh = normalizeWorkHours(workHours);
    const next = wh.days.length ? nextWorkStart(now, wh) : null;
    // Si la jornada empieza hoy más tarde, "hasta mañana" sigue siendo mañana.
    if (next && (next.getDate() !== now.getDate() || next.getMonth() !== now.getMonth()))
        return next;
    const s = parseHHMM(wh.start) ?? 9 * 60;
    for (let i = 1; i <= 8; i++) {
        const c = atLocal(now, i, s);
        if (!wh.days.length || wh.days.includes(isoDay(c)))
            return c;
    }
    return atLocal(now, 1, s);
}

/**
 * Puro. Añade un aviso a la cola de "Mientras no estabas": item {key, text, action?, at}. Mismo key ⇒ se
 * sustituye (y pasa al final); más de `max` ⇒ caen los más viejos. Devuelve la cola nueva.
 */
export function queuePush(queue, item, max = QUEUE_MAX) {
    if (!item || typeof item.key !== 'string' || !item.key || typeof item.text !== 'string')
        return Array.isArray(queue) ? queue : [];
    const rest = (Array.isArray(queue) ? queue : []).filter(x => x?.key !== item.key);
    rest.push({...item, at: Number(item.at) || Date.now()});
    return rest.slice(-max);
}

/** Puro. Cola leída de disco → solo entradas válidas, sin duplicados y como mucho `max`. */
export function normalizeQueue(raw, max = QUEUE_MAX) {
    let q = [];
    for (const it of Array.isArray(raw) ? raw : [])
        q = queuePush(q, it, max);
    return q;
}
