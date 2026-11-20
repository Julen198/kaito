// Parser de fechas/horas en español. Módulo puro (sin gi://), ejecutable con node.
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DAY_RE = '(?:domingo|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado)';
const DEFAULT_HOUR = 9;

const pad = n => String(n).padStart(2, '0');
const hhmm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const plain = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dayDiff(date, now) {
    return Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
}

/** "20 min", "2 h", "1 h 05 min" */
function relative(ms) {
    const mins = Math.max(0, Math.round(ms / 60000));
    if (mins < 60)
        return `${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h} h ${pad(m)} min` : `${h} h`;
}

/** Etiqueta corta para listas: "hoy 17:30", "mañana 09:00", "lun 24 10:00". */
export function shortLabel(date, now = new Date()) {
    const diff = dayDiff(date, now);
    if (diff === 0)
        return `hoy ${hhmm(date)}`;
    if (diff === 1)
        return `mañana ${hhmm(date)}`;
    if (diff < 0)
        return `vencido ${hhmm(date)}`;
    return `${DAYS[date.getDay()].slice(0, 3)} ${date.getDate()} ${hhmm(date)}`;
}

function longLabel(date, now) {
    const diff = dayDiff(date, now);
    const t = hhmm(date);
    if (diff === 0)
        return `Hoy a las ${t} (en ${relative(date - now)})`;
    if (diff === 1)
        return `Mañana a las ${t}`;
    if (diff === 2)
        return `Pasado mañana a las ${t}`;
    return `${cap(DAYS[date.getDay()])} ${date.getDate()} a las ${t}`;
}

/** Elimina el fragmento [start, end) y limpia conectores sueltos. */
function strip(text, ranges) {
    let out = text;
    for (const [s, e] of [...ranges].sort((a, b) => b[0] - a[0]))
        out = out.slice(0, s) + ' ' + out.slice(e);
    return out.replace(/\s+/g, ' ')
        .replace(/^[\s,;:.\-–]+|[\s,;:.\-–]+$/g, '')
        .replace(/^(?:para|que)\s+(?=\S)/i, '')
        .replace(/\s+(?:para|el|a|de|y)$/i, '')
        .trim();
}

/**
 * Interpreta "llamar a Iker en 20 min", "mañana a las 9", "el lunes a las 10"...
 * @returns {{date: Date, clean: string, label: string} | null}
 */
export function parseWhen(text, now = new Date()) {
    const src = String(text ?? '');
    const ranges = [];
    const take = m => ranges.push([m.index, m.index + m[0].length]);

    // 1) Relativo: "en 20 min", "en 2 horas", "en media hora", "en una hora"
    const rel = /\ben\s+(\d+(?:[.,]\d+)?|una?|media)\s*(h(?:oras?)?|min(?:utos?)?)(?![a-záéíóúñ])/i.exec(src);
    if (rel) {
        const q = plain(rel[1]);
        const n = q === 'media' ? 0.5 : /^una?$/.test(q) ? 1 : parseFloat(q.replace(',', '.'));
        const mult = /^h/i.test(rel[2]) ? 60 : 1;
        if (n > 0) {
            take(rel);
            const date = new Date(now.getTime() + Math.round(n * mult * 60000));
            return {date, clean: strip(src, ranges), label: longLabel(date, now)};
        }
    }

    // 2) Día
    let dayOffset = null, weekday = null;
    const dayRe = new RegExp(`\\b(pasado\\s+ma[ñn]ana|ma[ñn]ana|hoy|(?:el\\s+|este\\s+|pr[oó]ximo\\s+)?(${DAY_RE}))\\b`, 'i');
    const dm = dayRe.exec(src);
    if (dm) {
        const w = plain(dm[1]);
        if (/^pasado/.test(w))
            dayOffset = 2;
        else if (/^manana$/.test(w))
            dayOffset = 1;
        else if (w === 'hoy')
            dayOffset = 0;
        else
            weekday = DAYS.findIndex(d => plain(d) === plain(dm[2]));
        take(dm);
    }

    // 3) Hora: "a las 17:30", "a las 5 y media", "a la una", "a las 9 de la noche"
    let hour = null, minute = 0;
    const tm = /\ba\s+(?:las?)\s+(una|\d{1,2})(?:[:.h](\d{2}))?(?:\s+y\s+(media|cuarto)|\s+menos\s+(cuarto))?(?:\s+de\s+la\s+(ma[ñn]ana|tarde|noche))?(?![\d:])/i.exec(src);
    if (tm) {
        hour = plain(tm[1]) === 'una' ? 1 : parseInt(tm[1], 10);
        minute = tm[2] ? parseInt(tm[2], 10) : 0;
        if (tm[3])
            minute = plain(tm[3]) === 'media' ? 30 : 15;
        if (tm[4]) {
            minute = 45;
            hour -= 1;
        }
        const part = tm[5] ? plain(tm[5]) : '';
        if ((part === 'tarde' || part === 'noche') && hour < 12)
            hour += 12;
        if (hour > 23 || minute > 59)
            hour = null;
        else
            take(tm);
    }

    if (hour === null && dayOffset === null && weekday === null)
        return null;
    if (hour === null && dayOffset === 0)
        return null; // "hoy" sin hora: no hay a qué hora avisar

    const h = hour ?? DEFAULT_HOUR, m = hour === null ? 0 : minute;
    const at = days => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, m, 0, 0);
    let date;
    if (dayOffset !== null) {
        date = at(dayOffset);
    } else if (weekday !== null) {
        for (let i = 0; i <= 7; i++) {
            date = at(i);
            if (date.getDay() === weekday && date > now)
                break;
        }
    } else {
        date = at(0);
        if (date <= now)
            date = at(1); // "a las 9" ya pasado hoy: mañana
    }
    return {date, clean: strip(src, ranges), label: longLabel(date, now)};
}

// --- Tareas programadas: recurrencias ---

const DAY_ABBR = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const DAY_PLURAL_RE = '(domingos?|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?)';
export const MIN_INTERVAL_MIN = 15;
const TIME_RE = /\ba\s+(?:las?)\s+(una|\d{1,2})(?:[:.h](\d{2}))?(?:\s+y\s+(media|cuarto)|\s+menos\s+(cuarto))?(?:\s+de\s+la\s+(ma[ñn]ana|tarde|noche))?(?![\d:])/i;
const NUM_WORDS = {un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, ocho: 8, doce: 12};

const dayIndex = w => DAYS.findIndex(d => plain(d) === plain(w).replace(/s$/, '') || plain(d) === plain(w));
const toNum = s => (/^\d+$/.test(s) ? parseInt(s, 10) : NUM_WORDS[plain(s)] ?? NaN);

/** "a las 9:30" → {hour, minute, range} | null (misma gramática que parseWhen). */
function parseTime(src) {
    const tm = TIME_RE.exec(src);
    if (!tm)
        return null;
    let hour = plain(tm[1]) === 'una' ? 1 : parseInt(tm[1], 10);
    let minute = tm[2] ? parseInt(tm[2], 10) : 0;
    if (tm[3])
        minute = plain(tm[3]) === 'media' ? 30 : 15;
    if (tm[4]) {
        minute = 45;
        hour -= 1;
    }
    const part = tm[5] ? plain(tm[5]) : '';
    if ((part === 'tarde' || part === 'noche') && hour < 12)
        hour += 12;
    if (hour > 23 || hour < 0 || minute > 59)
        return null;
    return {hour, minute, range: [tm.index, tm.index + tm[0].length]};
}

const at2 = (h, m) => `${pad(h)}:${pad(m)}`;

/** Puro. Texto legible de una regla: "Cada lunes a las 09:00". */
export function ruleLabel(rule) {
    const t = rule ? at2(rule.hour ?? 0, rule.minute ?? 0) : '';
    switch (rule?.kind) {
    case 'daily':
        return `Todos los días a las ${t}`;
    case 'weekdays':
        return `De lunes a viernes a las ${t}`;
    case 'weekly': {
        const names = rule.days.map(d => DAYS[d]);
        const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}` : names[0];
        return `Cada ${list} a las ${t}`;
    }
    case 'hourly':
        return 'Cada hora';
    case 'interval':
        return rule.minutes % 60 === 0
            ? `Cada ${rule.minutes / 60 === 1 ? 'hora' : `${rule.minutes / 60} horas`}`
            : `Cada ${rule.minutes} min`;
    case 'monthly':
        return `El día ${rule.day} de cada mes a las ${t}`;
    case 'once': {
        const d = new Date(rule.at);
        return `Una vez: ${DAYS[d.getDay()]} ${d.getDate()} a las ${hhmm(d)}`;
    }
    default:
        return '?';
    }
}

/**
 * Puro. Recurrencias en español: "todos los días a las 9", "cada lunes a las 10", "de lunes a viernes a las 8",
 * "cada hora", "cada 2 horas", "cada 30 minutos" (mínimo 15), "el día 1 de cada mes a las 9".
 * Sin hora (diarias/semanales/mensuales) → 09:00.
 * @returns {{rule: object, clean: string, label: string} | null}
 */
export function parseRecurrence(text, _now = new Date()) {
    const src = String(text ?? '');
    const ranges = [];
    const take = m => ranges.push([m.index, m.index + m[0].length]);
    let rule = null;

    // Intervalos: "cada hora", "cada 2 horas", "cada 30 min".
    const iv = /\bcada\s+(?:(\d+|una?|dos|tres|cuatro|cinco|seis|ocho|doce)\s+)?(horas?|h|minutos?|min)\b/i.exec(src);
    if (iv) {
        const n = iv[1] ? toNum(iv[1]) : 1;
        const hours = /^h/i.test(iv[2]);
        if (Number.isFinite(n) && n > 0) {
            take(iv);
            if (hours && n === 1)
                rule = {kind: 'hourly'};
            else
                rule = {kind: 'interval', minutes: Math.max(MIN_INTERVAL_MIN, hours ? n * 60 : n)};
            return {rule, clean: strip(src, ranges), label: ruleLabel(rule)};
        }
    }

    const time = parseTime(src);
    const hm = {hour: time?.hour ?? DEFAULT_HOUR, minute: time ? time.minute : 0};

    const wd = /\b(?:de\s+lunes\s+a\s+viernes|entre\s+semana|(?:todos\s+los\s+|cada\s+)?d[ií]as?\s+laborables)\b/i.exec(src);
    const mo = /\b(?:el\s+)?(?:d[ií]a\s+)?(\d{1,2})\s+de\s+cada\s+mes\b|\bcada\s+d[ií]a\s+(\d{1,2})(?:\s+del?\s+mes)?\b/i.exec(src);
    const dl = /\b(?:todos\s+los\s+d[ií]as|cada\s+d[ií]a|a\s+diario|diariamente)\b/i.exec(src);
    const wk = new RegExp(`\\b(?:todos\\s+los|cada|los)\\s+${DAY_PLURAL_RE}((?:\\s*(?:,|y)\\s*(?:los\\s+)?${DAY_PLURAL_RE})*)`, 'i').exec(src);
    if (wd) {
        take(wd);
        rule = {kind: 'weekdays', ...hm};
    } else if (mo) {
        const day = parseInt(mo[1] ?? mo[2], 10);
        if (day >= 1 && day <= 31) {
            take(mo);
            rule = {kind: 'monthly', day, ...hm};
        }
    } else if (dl) {
        take(dl);
        rule = {kind: 'daily', ...hm};
    } else if (wk) {
        const words = [wk[1], ...(wk[2] ?? '').split(/\s*(?:,|\by\b)\s*/)]
            .map(w => w.replace(/^los\s+/i, '').trim()).filter(Boolean);
        const days = [...new Set(words.map(dayIndex).filter(i => i >= 0))].sort((a, b) => a - b);
        if (days.length) {
            take(wk);
            rule = {kind: 'weekly', days, ...hm};
        }
    }
    if (!rule)
        return null;
    if (time)
        ranges.push(time.range);
    return {rule, clean: strip(src, ranges), label: ruleLabel(rule)};
}

const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

/**
 * Puro. Próxima ejecución estrictamente posterior a `after` (hora local; los cambios de horario se
 * resuelven con el constructor de Date, que normaliza las horas inexistentes). null si no hay más.
 */
export function nextRun(rule, after = new Date()) {
    const a = new Date(after);
    const y = a.getFullYear(), mo = a.getMonth(), d = a.getDate();
    const h = rule?.hour ?? 0, m = rule?.minute ?? 0;
    const dayAt = off => new Date(y, mo, d + off, h, m, 0, 0);
    const scanDays = ok => {
        for (let i = 0; i <= 8; i++) {
            const t = dayAt(i);
            if (t > a && ok(t.getDay()))
                return t;
        }
        return null;
    };
    switch (rule?.kind) {
    case 'once': {
        const t = new Date(rule.at);
        return t > a ? t : null;
    }
    case 'daily':
        return scanDays(() => true);
    case 'weekdays':
        return scanDays(w => w >= 1 && w <= 5);
    case 'weekly':
        return Array.isArray(rule.days) && rule.days.length ? scanDays(w => rule.days.includes(w)) : null;
    case 'hourly':
        return new Date(y, mo, d, a.getHours() + 1, 0, 0, 0);
    case 'interval':
        return new Date(a.getTime() + Math.max(MIN_INTERVAL_MIN, Number(rule.minutes) || 0) * 60000);
    case 'monthly':
        for (let i = 0; i <= 2; i++) {
            const yy = y + Math.floor((mo + i) / 12), mm = (mo + i) % 12;
            const t = new Date(yy, mm, Math.min(rule.day, daysInMonth(yy, mm)), h, m, 0, 0);
            if (t > a)
                return t;
        }
        return null;
    default:
        return null;
    }
}

/**
 * Puro. Recurrencia o, si no, una sola vez (parseWhen) → {rule, clean, label, once}.
 * La regla 'once' guarda la fecha en ISO.
 */
export function parseSchedule(text, now = new Date()) {
    const r = parseRecurrence(text, now);
    if (r)
        return {...r, once: false};
    const w = parseWhen(text, now);
    if (!w)
        return null;
    return {rule: {kind: 'once', at: w.date.toISOString()}, clean: w.clean, label: w.label, once: true};
}

/** "lun 09:00" para la lista de tareas (hoy/mañana como shortLabel). */
export function nextLabel(date, now = new Date()) {
    if (!date)
        return '';
    const diff = dayDiff(date, now);
    if (diff === 0)
        return `hoy ${hhmm(date)}`;
    if (diff === 1)
        return `mañana ${hhmm(date)}`;
    return diff > 0 && diff < 7 ? `${DAY_ABBR[date.getDay()]} ${hhmm(date)}` : `${DAY_ABBR[date.getDay()]} ${date.getDate()} ${hhmm(date)}`;
}

/**
 * Puro. Un paso de la animación "máquina de escribir" del placeholder.
 * state {i, n, del}: ejemplo, letras visibles, borrando. → {state, text, delay(ms)}
 */
export function typewriterStep(examples, state = {i: 0, n: 0, del: false}) {
    let {i, n, del} = state;
    const len = examples[i].length;
    let delay;
    if (!del) {
        n = Math.min(n + 1, len);
        delay = n >= len ? 1600 : 55;
        if (n >= len)
            del = true;
    } else {
        n = Math.max(n - 1, 0);
        delay = 30;
        if (n <= 0) {
            del = false;
            i = (i + 1) % examples.length;
            delay = 400;
        }
    }
    return {state: {i, n, del}, text: examples[state.i].slice(0, n), delay};
}
