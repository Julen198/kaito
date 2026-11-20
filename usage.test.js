// Ejecutar: node usage.test.js  (o gjs -m usage.test.js). Lógica pura de los anillos de uso.
import {
    usageColor, ringFraction, hexRgb, pctText, formatReset, shortAge, ringModel, usageNote, usageTooltip,
    opencodeProvider, opencodeNote, usageRows, panelRing, normalizePanelProvider, BADGES, USAGE_COLORS,
    usageLine, usageHeadNote, DUAL_RING,
} from './usage.js';

let n = 0;
function eq(a, b, msg) {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
    if (x !== y)
        throw new Error(`${msg}\n  esperado: ${y}\n  obtenido: ${x}`);
    n++;
}

const at = (h, m, day = 19) => new Date(2026, 10, day, h, m).getTime() / 1000;
const NOW = at(12, 0);

// Colores y fracciones
eq([0, 69.9, 70, 89.9, 90, 100].map(usageColor), ['#5BC8AF', '#5BC8AF', '#FFA348', '#FFA348', '#E5493A', '#E5493A'], 'umbrales de color');
eq([ringFraction(0), ringFraction(42), ringFraction(100), ringFraction(130), ringFraction(-5), ringFraction(null), ringFraction('x')],
    [0, 0.42, 1, 1, 0, 0, 0], 'fracción del anillo');
eq(hexRgb('#ffffff'), [1, 1, 1], 'hex blanco');
eq(hexRgb('#000'), [0, 0, 0], 'hex corto');
eq(hexRgb('#5BC8AF').map(v => Math.round(v * 255)), [0x5B, 0xC8, 0xAF], 'hex del verde');
eq(hexRgb('nada'), [0.5, 0.5, 0.5], 'hex inválido -> gris');
eq([pctText(42.4), pctText(99.6), pctText(null)], ['42 %', '100 %', '0 %'], 'texto del porcentaje');

// Fechas y antigüedad
eq(formatReset(at(14, 50), NOW), '14:50', 'reinicio hoy');
eq(formatReset(at(9, 0), NOW, true), 'hoy 09:00', 'reinicio hoy con día');
eq(formatReset(at(9, 0, 23), NOW), `${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][new Date(2026, 10, 23).getDay()]} 09:00`, 'reinicio otro día');
eq([shortAge(NOW - 20, NOW), shortAge(NOW - 720, NOW), shortAge(NOW - 3 * 3600, NOW), shortAge(NOW - 6 * 86400, NOW), shortAge(null, NOW)],
    ['ahora', 'hace 12 min', 'hace 3 h', 'hace 6 d', ''], 'antigüedad corta');

// Anillo de una ventana
eq(ringModel('five', {pct: 95, resetsAt: at(14, 50), reset: false}),
    {kind: 'five', pct: 95, frac: 0.95, color: USAGE_COLORS.crit, text: '95 %', dim: false}, 'anillo rojo');
eq(ringModel('week', {pct: 0, resetsAt: NOW - 60, reset: true}).dim, true, 'ventana reiniciada atenuada');
eq(ringModel('five', null), null, 'sin ventana, sin anillo');

// Nota de la derecha
const live = {ts: NOW - 60, five: {pct: 42, resetsAt: at(14, 50), reset: false}, week: {pct: 18, resetsAt: at(9, 0, 23), reset: false}};
eq(usageNote(live, NOW), 'reinicia 14:50', 'nota: reinicio de 5 h');
const old = {ts: NOW - 6 * 86400, five: {pct: 0, resetsAt: NOW - 3600, reset: true}, week: {pct: 0, resetsAt: NOW - 60, reset: true}};
eq(usageNote(old, NOW), 'hace 6 d', 'nota: datos viejos');
eq(usageNote({ts: null, five: null, week: {pct: 30, resetsAt: at(9, 0), reset: false}}, NOW), 'reinicia hoy 09:00', 'nota: solo semana');
eq(usageNote({ts: null, five: {pct: 30, resetsAt: null, reset: false}, week: null}, NOW), '', 'nota: sin fechas');
eq(usageNote(null, NOW), '', 'nota: sin datos');
eq(usageTooltip('Claude', live, NOW).startsWith('Claude · 5 h 42 %, se reinicia 14:50 · semana 18 %, '), true, 'tooltip');
eq(usageTooltip('Codex', old, NOW), 'Codex · 5 h 0 %, reiniciado · semana 0 %, reiniciado', 'tooltip reiniciado');

// OpenCode
eq(opencodeProvider({model: 'anthropic/claude-sonnet-4'}, {recent: [{providerID: 'openai'}]}), 'anthropic', 'opencode: model de la config manda');
eq(opencodeProvider({}, {recent: [{providerID: 'openai', modelID: 'x'}]}), 'openai', 'opencode: último modelo usado');
eq([opencodeProvider(null, null), opencodeProvider({model: 'sin-barra'}, {recent: 'x'})], [null, null], 'opencode: sin datos');
eq([opencodeNote('anthropic'), opencodeNote('openai'), opencodeNote('acme'), opencodeNote(null)],
    ['usa tu Claude', 'usa tu OpenAI', 'usa acme', 'sin límites propios'], 'opencode: nota');

// Filas
const views = {claude: live, codex: old};
const all = {claude: true, codex: true, gemini: true, opencode: true};
let rows = usageRows({views, enabled: all, installed: {gemini: true, opencode: true}, opencode: 'anthropic'}, NOW);
eq(rows.map(r => r.id), ['claude', 'codex', 'gemini', 'opencode'], 'filas: orden');
eq(rows[0].rings.map(r => r.text), ['42 %', '18 %'], 'filas: anillos de Claude');
eq([rows[0].note, rows[0].dim, rows[0].badge.letter], ['reinicia 14:50', false, 'C'], 'filas: Claude');
eq([rows[1].note, rows[1].dim, rows[1].badge.bg], ['hace 6 d', true, '#e8e8e8'], 'filas: Codex viejo atenuado');
eq([rows[2].rings, rows[2].note], [[], 'sin datos de límite'], 'filas: Gemini sin números inventados');
eq([rows[3].rings, rows[3].note], [[], 'usa tu Claude'], 'filas: OpenCode');
rows = usageRows({views: {claude: null, codex: live}, enabled: {...all, codex: false}, installed: {gemini: false, opencode: true}}, NOW);
eq(rows.map(r => r.id), ['opencode'], 'filas: sin datos de Claude, Codex desactivado, Gemini no instalado');
eq(rows[0].note, 'sin límites propios', 'filas: OpenCode sin proveedor');
rows = usageRows({views: {claude: {ts: NOW, five: null, week: live.week}}, enabled: all}, NOW);
eq([rows.length, rows[0].rings[0], rows[0].rings[1].text], [1, null, '18 %'], 'filas: solo semana (hueco para 5 h)');
eq(usageRows({views: {claude: live}, enabled: {...all, claude: false}}, NOW), [], 'filas: Claude desactivado');
eq(usageRows(undefined, NOW), [], 'filas: sin argumentos');
eq(Object.keys(BADGES), ['claude', 'codex', 'gemini', 'opencode'], 'insignias');
eq(Object.values(BADGES).every(b => /^#[0-9a-f]{6}$/i.test(b.tile) && /^#[0-9a-f]{6}$/i.test(b.tileFg)), true, 'baldosas del anillo');

// Columnas: línea corta y nota de la cabecera
rows = usageRows({views, enabled: all, installed: {gemini: true, opencode: true}, opencode: 'openai'}, NOW);
eq(rows.map(r => r.line), ['42 % · 18 %', 'hace 6 d', 'sin datos de límite', 'usa tu OpenAI'], 'columnas: línea corta');
eq(rows.map(r => r.limits), [true, true, false, false], 'columnas: con límites propios');
eq(usageHeadNote(rows), 'Claude reinicia 14:50', 'cabecera: reinicio de Claude');
eq(usageHeadNote(rows.slice(1)), '', 'cabecera: sin reinicios vivos (Codex viejo)');
eq(usageHeadNote([{...rows[1], dim: false, note: 'reinicia 15:10'}]), 'Codex reinicia 15:10', 'cabecera: Codex');
eq(usageHeadNote(undefined), '', 'cabecera: sin filas');
eq(usageLine({rings: [null, {pct: 30.4}], note: 'reinicia hoy 09:00', dim: false}), '– · 30 %', 'línea: solo semana');
eq(usageLine({rings: [{pct: 99.6}, null], note: '', dim: false}), '100 % · –', 'línea: solo 5 h');
eq([usageLine(null), usageLine({rings: [], note: 'x'})], ['', 'x'], 'línea: sin datos');
eq(DUAL_RING.outer.r > DUAL_RING.inner.r && DUAL_RING.outer.stroke > DUAL_RING.inner.stroke
    && DUAL_RING.outer.r + DUAL_RING.outer.stroke / 2 <= DUAL_RING.size / 2
    && DUAL_RING.inner.r + DUAL_RING.inner.stroke / 2 < DUAL_RING.outer.r - DUAL_RING.outer.stroke / 2, true, 'anillo doble: geometría');

// Anillo del panel
eq(panelRing(views, 'claude').label, 'Claude 5 h 42 %', 'panel: Claude');
eq([panelRing(views, 'codex').text, panelRing(views, 'codex').dim], ['0 %', true], 'panel: Codex reiniciado');
eq([panelRing(views, 'none'), panelRing({}, 'claude'), panelRing(views, 'gemini')], [null, null, null], 'panel: nada');
eq([normalizePanelProvider('codex'), normalizePanelProvider('none'), normalizePanelProvider('x'), normalizePanelProvider(undefined)],
    ['codex', 'none', 'claude', 'claude'], 'usagePanelProvider');

const msg = `usage.test.js: ${n} comprobaciones OK`;
if (typeof print === 'function')
    print(msg);
else
    console.log(msg);
