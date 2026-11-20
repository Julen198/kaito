// Uso de los proveedores en anillos (0.5.0): modelo de cada fila, colores, fracciones y textos.
// Lógica pura (sin imports de gi ni de la shell): se prueba con node y gjs (usage.test.js). La lectura de
// ficheros está en common.js y el dibujo (St.DrawingArea + Cairo) en main.js.

export const USAGE_COLORS = {ok: '#5BC8AF', warn: '#FFA348', crit: '#E5493A'};
/** Anillos: tamaño de diseño (px lógicos), grosor del trazo y pista. El dibujo escala con el tamaño real. */
export const RING = {size: 36, stroke: 4.5};
export const MINI_RING = {size: 16, stroke: 2.5};
/** Anillo doble de cada columna: fuera la ventana de 5 h (más gruesa), dentro la semana. Radios al centro del trazo. */
export const DUAL_RING = {size: 56, outer: {r: 25, stroke: 4}, inner: {r: 18.5, stroke: 3}, dash: 3};
export const RING_TRACK = [1, 1, 1, 0.10];
export const DIM_OPACITY = 140; // .55 · 255: datos reiniciados o viejos
/** Proveedores con fila de uso, en este orden. */
export const USAGE_ORDER = ['claude', 'codex', 'gemini', 'opencode'];
export const PANEL_RING_PROVIDERS = ['claude', 'codex', 'none'];
export const PANEL_RING_LABELS = ['Claude (5 h)', 'Codex (5 h)', 'Ninguno'];

/**
 * Insignia del proveedor: inicial sobre su color si no hay icono instalado (bg/fg). En el centro del anillo
 * doble va una baldosa de 18 px (tile/tileFg) con el icono de la app o, si no hay, la inicial.
 */
export const BADGES = {
    claude: {name: 'Claude', letter: 'C', bg: '#D97757', fg: '#ffffff', tile: '#f6d3c0', tileFg: '#d6541a'},
    codex: {name: 'Codex', letter: 'X', bg: '#e8e8e8', fg: '#111111', tile: '#ffffff', tileFg: '#1e1e1e'},
    gemini: {name: 'Gemini', letter: 'G', bg: '#4C8DF6', fg: '#ffffff', tile: '#dbe7fd', tileFg: '#1a5fd6'},
    opencode: {name: 'OpenCode', letter: 'O', bg: '#2b2b2f', fg: '#ffffff', tile: '#1e1e1e', tileFg: '#deddda'},
};
/** Nombres de icono (tema de iconos: /usr/share/icons, ~/.local/share/icons) que instalan sus apps. */
export const BADGE_ICONS = {
    claude: ['claude-desktop', 'com.anthropic.Claude', 'claude', 'claude-code'],
    codex: ['codex', 'com.openai.Codex', 'openai-codex'],
    gemini: ['gemini-cli', 'google-gemini', 'gemini'],
    opencode: ['ai.opencode.desktop', 'opencode-desktop', 'opencode'],
};

const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** Verde < 70 %, naranja 70-90 %, rojo >= 90 %. */
export function usageColor(pct) {
    return pct >= 90 ? USAGE_COLORS.crit : pct >= 70 ? USAGE_COLORS.warn : USAGE_COLORS.ok;
}

/** Porcentaje -> fracción del anillo 0..1 (lo no numérico cuenta como 0). */
export function ringFraction(pct) {
    const n = Number(pct);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 0;
}

/** "#5BC8AF" o "#fff" -> [r, g, b] en 0..1 (Cairo); gris si no se entiende. */
export function hexRgb(hex) {
    let s = String(hex ?? '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(s))
        s = s.replace(/./g, c => c + c);
    if (!/^[0-9a-f]{6}$/i.test(s))
        return [0.5, 0.5, 0.5];
    return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255);
}

export const pctText = pct => `${Math.round(Number(pct) || 0)} %`;

/** "14:30" (hoy) o "lun 09:00" (otro día); con forceDay también hoy: "hoy 09:00". */
export function formatReset(resetsAt, nowS, forceDay = false) {
    const d = new Date(resetsAt * 1000);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const today = new Date(nowS * 1000);
    if (d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate())
        return forceDay ? `hoy ${hm}` : hm;
    return `${DOW[d.getDay()]} ${hm}`;
}

/** "hace 12 min", "hace 3 h", "hace 6 d" ("ahora" con menos de 1 min); '' sin fecha. */
export function shortAge(ts, nowS) {
    if (ts === null || ts === undefined || !Number.isFinite(Number(ts)))
        return '';
    const m = Math.max(0, Math.floor((nowS - ts) / 60));
    if (m < 1)
        return 'ahora';
    if (m < 60)
        return `hace ${m} min`;
    if (m < 48 * 60)
        return `hace ${Math.floor(m / 60)} h`;
    return `hace ${Math.floor(m / 1440)} d`;
}

/** Ventana de usageView ({pct, resetsAt, reset}) -> anillo {kind, pct, frac, color, text, dim}. */
export function ringModel(kind, win) {
    if (!win)
        return null;
    return {kind, pct: win.pct, frac: ringFraction(win.pct), color: usageColor(win.pct), text: pctText(win.pct), dim: !!win.reset};
}

/**
 * Nota corta a la derecha: "reinicia 14:50" si la ventana de 5 h sigue viva; si todo se reinició,
 * la antigüedad de los datos ("hace 6 d"); si solo queda la semana, cuándo se reinicia.
 */
export function usageNote(view, nowS) {
    if (!view)
        return '';
    const {five, week} = view;
    if (five && !five.reset && five.resetsAt !== null && five.resetsAt !== undefined)
        return `reinicia ${formatReset(five.resetsAt, nowS)}`;
    if ((five && five.reset) || (week && week.reset) || (!five && !week)) {
        const age = shortAge(view.ts, nowS);
        if (age)
            return age;
    }
    if (week && !week.reset && week.resetsAt !== null && week.resetsAt !== undefined)
        return `reinicia ${formatReset(week.resetsAt, nowS, true)}`;
    return '';
}

/** Texto largo (accesible y al pasar el ratón): "Claude · 5 h 42 %, se reinicia 14:50 · semana 18 %, lun 09:00". */
export function usageTooltip(name, view, nowS) {
    const parts = [name];
    for (const [k, title] of [['five', '5 h'], ['week', 'semana']]) {
        const w = view?.[k];
        if (!w)
            continue;
        const when = w.reset ? 'reiniciado' : w.resetsAt !== null && w.resetsAt !== undefined
            ? `${k === 'five' ? 'se reinicia ' : ''}${formatReset(w.resetsAt, nowS, k === 'week')}` : '';
        parts.push(`${title} ${pctText(w.pct)}${when ? `, ${when}` : ''}`);
    }
    return parts.join(' · ');
}

/** Ids de proveedor de OpenCode -> nota de su fila (no tiene límites propios). */
const OPENCODE_NOTES = {
    anthropic: 'usa tu Claude', openai: 'usa tu OpenAI', google: 'usa tu Gemini', 'github-copilot': 'usa tu Copilot',
    opencode: 'usa OpenCode Zen', 'opencode-go': 'usa OpenCode Go', ollama: 'modelo local', lmstudio: 'modelo local',
};

/**
 * Proveedor del modelo de OpenCode: `model` ("anthropic/claude-…") de su config o, si no, el último usado
 * (state/opencode/model.json: {recent: [{providerID}]}). null si no se sabe.
 */
export function opencodeProvider(config, state) {
    const m = typeof config?.model === 'string' ? config.model : '';
    if (m.includes('/'))
        return m.split('/')[0] || null;
    const r = Array.isArray(state?.recent) ? state.recent.find(x => typeof x?.providerID === 'string' && x.providerID) : null;
    return r ? r.providerID : null;
}

export function opencodeNote(providerId) {
    if (!providerId)
        return 'sin límites propios';
    return OPENCODE_NOTES[providerId] ?? `usa ${providerId}`;
}

/**
 * Línea corta bajo el nombre de cada columna: "29 % · 65 %" (5 h · semana; "–" si falta una ventana) con
 * datos vivos; la nota ("hace 7 d", "usa tu OpenAI", "sin datos de límite") si están viejos o no hay límites.
 */
export function usageLine(row) {
    if (!row)
        return '';
    const rings = row.rings ?? [];
    if (row.dim || !rings.some(Boolean))
        return row.note ?? '';
    return rings.slice(0, 2).map(r => r ? pctText(r.pct) : '–').join(' · ');
}

/** Nota de la cabecera "Uso": el primer reinicio vivo con su proveedor ("Claude reinicia 16:30"); '' si no hay. */
export function usageHeadNote(rows) {
    const r = (rows ?? []).find(x => !x.dim && x.rings?.some(Boolean) && /^reinicia /.test(x.note ?? ''));
    return r ? `${r.name} ${r.note}` : '';
}

/**
 * Columnas de la sección "Uso". views: {claude, codex} de usageView (null sin datos); enabled: agentProviders;
 * installed: {gemini, opencode} (Claude y Codex cuentan como instalados si hay datos suyos).
 * -> [{id, name, badge, rings: [anillo 5 h, anillo semana], note, line, limits, dim, tooltip}]
 * limits: false si el proveedor no tiene límites legibles (anillo con pista discontinua y columna atenuada).
 */
export function usageRows({views = {}, enabled = {}, installed = {}, opencode = null} = {}, nowS) {
    const rows = [];
    for (const id of USAGE_ORDER) {
        if (enabled[id] === false)
            continue;
        const badge = BADGES[id];
        if (id === 'claude' || id === 'codex') {
            const v = views[id];
            if (!v)
                continue;
            const rings = [ringModel('five', v.five), ringModel('week', v.week)];
            const present = rings.filter(Boolean);
            const row = {
                id, name: badge.name, badge, rings, note: usageNote(v, nowS), limits: true,
                dim: present.length > 0 && present.every(r => r.dim), tooltip: usageTooltip(badge.name, v, nowS),
            };
            row.line = usageLine(row);
            rows.push(row);
        } else if (installed[id]) {
            // Gemini CLI no guarda en local su cuota (es del servidor): no se inventa ningún número.
            const note = id === 'gemini' ? 'sin datos de límite' : opencodeNote(opencode);
            rows.push({id, name: badge.name, badge, rings: [], note, line: note, limits: false, dim: false, tooltip: `${badge.name} · ${note}`});
        }
    }
    return rows;
}

/** Mini anillo del panel: ventana de 5 h del proveedor elegido; null si no hay o es 'none'. */
export function panelRing(views, provider = 'claude') {
    if (!PANEL_RING_PROVIDERS.includes(provider) || provider === 'none')
        return null;
    const w = views?.[provider]?.five;
    if (!w)
        return null;
    const r = ringModel('five', w);
    return {...r, label: `${BADGES[provider].name} 5 h ${r.text}`};
}

/** Config usagePanelProvider: 'claude' (por defecto), 'codex' o 'none'. */
export const normalizePanelProvider = v => PANEL_RING_PROVIDERS.includes(v) ? v : 'claude';
