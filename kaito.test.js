// Ejecutar: gjs -m kaito.test.js
// (con XDG_CACHE_HOME/XDG_DATA_HOME en /tmp prueba también sendIssueToClaude, sin lanzar nada)
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import {
    adfToText, priorityKind, applyDismissed, warpLaunchYaml, ptyxisArgv, buildPrompt, shQuote,
    cwdFromJsonl, sendIssueToClaude, PROMPT_MAX, formatIssueDetail, rankRepos, repoTokens, scanRepos, filterRepos,
    usageColor, toEpochS, parseClaudeUsage, parseCodexLine, lastCodexUsage, pickWindows, applyStaleness, formatReset,
    usageLabel, ageLabel, usageView, readCodexUsage, readClaudeUsage,
    canDecide, agentsByTicket, shouldShowDaily, dailySummaryLines, localDay, warpTabToml, sortIssues, statusGroup,
    viewJql, visibleViews, normalizeCustomViews, projectsFromIssues, shortName, mapSearchIssue, RECENT_JQL,
    terminalMigration, resolveTerminal, gnomeTerminalArgv, kgxArgv, ptyxisExportsTab, terminalFocusLevel,
    terminalFocusTarget, parseEnviron, TERMINALS, parseUpdateMarker, firstErrorLine, parseCheck, changelogBody,
    readConfig, updateConfig, readQuietQueue, writeQuietQueue, readUpdateState, writeUpdateState, CONFIG_PATH, CLAUDE_PROJECTS,
    readBoard, readTodos, addBoardTask, patchBoardTask, readInbox, writeInbox, readJson, writeJson, TODOS_PATH, KANBAN_PATH,
} from './common.js';
import {localTaskPrompt} from './board.js';
import {inboxPush} from './inbox.js';
import {queuePush} from './quiet.js';
import {parseRemote, prUrl, parseLog, markOnce, finishKey, finishLines, reviewReminderText, detectWork,
    pathsFromTranscript, dirsFromPaths, ticketBranches, findTicketWork} from './finish.js';
import {parseTail, ticketFromHead, firstLine} from './agents.js';

let n = 0;
function eq(a, b, msg) {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
    if (x !== y)
        throw new Error(`${msg}\n  esperado: ${y}\n  obtenido: ${x}`);
    n++;
}

// ADF -> texto
const adf = {type: 'doc', version: 1, content: [
    {type: 'paragraph', content: [{type: 'text', text: 'Hola '}, {type: 'text', text: 'mundo', marks: [{type: 'strong'}]}]},
    {type: 'paragraph', content: [{type: 'text', text: 'línea 1'}, {type: 'hardBreak'}, {type: 'text', text: 'línea 2'}]},
    {type: 'bulletList', content: [
        {type: 'listItem', content: [{type: 'paragraph', content: [{type: 'text', text: 'a'}]}]},
        {type: 'listItem', content: [{type: 'paragraph', content: [{type: 'text', text: 'b'}]}]},
    ]},
]};
eq(adfToText(adf), 'Hola mundo\nlínea 1\nlínea 2\n- a\n- b', 'adfToText');
eq(adfToText(null), '', 'adfToText null');
eq(adfToText('texto v2'), 'texto v2', 'adfToText string');

// Prioridad
eq(priorityKind({id: '1', name: 'Highest'}), 'highest', 'id 1');
eq(priorityKind({id: '3', name: 'x'}), 'medium', 'id 3');
eq(priorityKind({id: '10001', name: 'Más alta'}), 'highest', 'nombre es');
eq(priorityKind({id: '10002', name: 'BAJA'}), 'low', 'nombre mayúsculas');
eq(priorityKind({id: '10003', name: 'Lowest'}), 'lowest', 'nombre en');
eq(priorityKind({id: '99', name: 'Rara'}), null, 'desconocida');
eq(priorityKind(null), null, 'sin prioridad');

// Ocultar agentes
const T = 1_000_000;
const agents = [
    {id: 'a', activityMs: T - 10},                  // oculto, sin actividad nueva
    {id: 'b', activityMs: T + 10},                  // actividad posterior -> vuelve
    {id: 'c', activityMs: T - 10, state: 'needs'},  // needs -> vuelve
    {id: 'd', activityMs: T - 10},                  // nunca ocultado
];
const r = applyDismissed(agents, {a: T, b: T, c: T, gone: T});
eq(r.visible.map(a => a.id), ['b', 'c', 'd'], 'visibles');
eq(r.dismissed, {a: T}, 'poda (b, c vuelven; gone no existe)');
eq(r.changed, true, 'changed');
const r2 = applyDismissed(agents, {a: T});
eq([r2.changed, r2.visible.length], [false, 3], 'sin cambios');

// Uso de Claude / Codex
eq([0, 69.9, 70, 89.9, 90, 100].map(usageColor), ['#5BC8AF', '#5BC8AF', '#FFA348', '#FFA348', '#E5493A', '#E5493A'], 'usageColor umbrales');
eq([toEpochS(1800000000), toEpochS(1800000000000), toEpochS('1800000000'), toEpochS('2026-11-13T11:05:39.352Z'), toEpochS(null), toEpochS('x'), toEpochS(0)],
    [1800000000, 1800000000, 1800000000, 1794567939.352, null, null, null], 'toEpochS');
eq(parseClaudeUsage({ts: 1000, rate_limits: {five_hour: {used_percentage: 42.5, resets_at: 2000}, seven_day: {used_percentage: 18, resets_at: 3000}}}),
    {ts: 1000, five: {pct: 42.5, resetsAt: 2000}, week: {pct: 18, resetsAt: 3000}}, 'parseClaudeUsage completo');
eq(parseClaudeUsage({ts: 1, rate_limits: {seven_day: {used_percentage: 5}}}),
    {ts: 1, five: null, week: {pct: 5, resetsAt: null}}, 'parseClaudeUsage solo semana');
eq([parseClaudeUsage(null), parseClaudeUsage({ts: 1, rate_limits: null}), parseClaudeUsage({rate_limits: {}}),
    parseClaudeUsage({rate_limits: {five_hour: {used_percentage: 'x'}}})], [null, null, null, null], 'parseClaudeUsage sin datos');
eq(parseClaudeUsage({ts: 1, rate_limits: {five_hour: {used_percentage: 250, resets_at: 5}}}).five.pct, 100, 'pct acotado a 100');

const cxLine = (rl, ts = '2026-11-13T11:05:39.352Z') => JSON.stringify({timestamp: ts, type: 'event_msg', payload: {type: 'token_count', info: null, rate_limits: rl}});
const cxTs = Date.parse('2026-11-13T11:05:39.352Z') / 1000;
eq(parseCodexLine(cxLine({primary: {used_percent: 13, window_minutes: 300, resets_at: 1794583396}, secondary: {used_percent: 2, window_minutes: 10080, resets_at: 1795170196}})),
    {ts: cxTs, five: {pct: 13, resetsAt: 1794583396}, week: {pct: 2, resetsAt: 1795170196}}, 'parseCodexLine');
eq(parseCodexLine(cxLine({primary: {used_percent: 40, window_minutes: 10080, resets_at: 7}, secondary: null})),
    {ts: cxTs, five: null, week: {pct: 40, resetsAt: 7}}, 'codex: solo semanal por window_minutes');
eq(parseCodexLine(cxLine({primary: {used_percent: 40, window_minutes: 10080, resets_at: 7}, secondary: {used_percent: 9, window_minutes: 300, resets_at: 8}})),
    {ts: cxTs, five: {pct: 9, resetsAt: 8}, week: {pct: 40, resetsAt: 7}}, 'codex: orden invertido');
eq(parseCodexLine(cxLine({primary: {used_percent: 10, window_minutes: 300, resets_in_seconds: 600}})).five.resetsAt, cxTs + 600, 'codex: resets_in_seconds');
eq(parseCodexLine(cxLine({primary: {used_percent: 10, resets_at: 5}, secondary: {used_percent: 20, resets_at: 6}})),
    {ts: cxTs, five: {pct: 10, resetsAt: 5}, week: {pct: 20, resetsAt: 6}}, 'codex: sin window_minutes -> posición');
eq([parseCodexLine(cxLine(null)), parseCodexLine(cxLine({primary: null, secondary: null})), parseCodexLine('no json'),
    parseCodexLine(JSON.stringify({type: 'event_msg', payload: {type: 'agent_message', rate_limits: {primary: {used_percent: 1}}}}))],
    [null, null, null, null], 'codex: líneas sin datos');
eq(pickWindows([null, {pct: 1, resetsAt: 2, windowMin: 300}]), {five: {pct: 1, resetsAt: 2}, week: null}, 'pickWindows tolera null');
const cxText = [cxLine({primary: {used_percent: 1, window_minutes: 300, resets_at: 1}}), '{"type":"token_count","basura"',
    cxLine({primary: {used_percent: 7, window_minutes: 300, resets_at: 2}}), cxLine(null), '{"x":1}'].join('\n');
eq(lastCodexUsage(cxText).five.pct, 7, 'lastCodexUsage: la última con límites');
eq(lastCodexUsage('{"x":1}\n'), null, 'lastCodexUsage: ninguna');

// Staleness y etiquetas (fechas locales: independientes de la zona horaria)
const at = (d, h, m) => new Date(2026, 10, d, h, m).getTime() / 1000;
const NOW = at(19, 10, 0);
eq(applyStaleness({pct: 80, resetsAt: NOW - 1}, NOW), {pct: 0, resetsAt: NOW - 1, reset: true}, 'staleness: vencida -> 0 %');
eq(applyStaleness({pct: 80, resetsAt: NOW + 1}, NOW), {pct: 80, resetsAt: NOW + 1, reset: false}, 'staleness: vigente');
eq(applyStaleness({pct: 80, resetsAt: null}, NOW).reset, false, 'staleness: sin reset conocido');
eq(applyStaleness(null, NOW), null, 'staleness null');
eq(formatReset(at(19, 14, 30), NOW), '14:30', 'formatReset hoy');
eq(formatReset(at(19, 9, 5), NOW, true), 'hoy 09:05', 'formatReset hoy forzando día');
const mon = new Date(2026, 10, 23, 9, 0);
eq(formatReset(mon.getTime() / 1000, NOW), `${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][mon.getDay()]} 09:00`, 'formatReset otro día');
eq(mon.getDay(), 1, 'el 23-11-2026 es lunes');
eq(usageLabel('five', {pct: 42.4, resetsAt: at(19, 14, 30), reset: false}, NOW), '5 h 42% · se reinicia 14:30', 'etiqueta 5 h');
eq(usageLabel('week', {pct: 18, resetsAt: mon.getTime() / 1000, reset: false}, NOW), 'Semana 18% · lun 09:00', 'etiqueta semana');
eq(usageLabel('five', {pct: 0, resetsAt: NOW - 5, reset: true}, NOW), '5 h 0% · reiniciado', 'etiqueta reiniciado');
eq(usageLabel('week', {pct: 3, resetsAt: null, reset: false}, NOW), 'Semana 3%', 'etiqueta sin reset');
eq([ageLabel(NOW - 10, NOW), ageLabel(NOW - 12 * 60, NOW), ageLabel(NOW - 3 * 3600, NOW), ageLabel(NOW - 3 * 86400, NOW), ageLabel(null, NOW)],
    ['actualizado ahora', 'actualizado hace 12 min', 'actualizado hace 3 h', 'actualizado hace 3 d', ''], 'ageLabel');
const uv = usageView({ts: NOW - 720, five: {pct: 95, resetsAt: at(19, 14, 30)}, week: {pct: 50, resetsAt: NOW - 60}}, NOW);
eq([uv.age, uv.five.color, uv.five.label, uv.week.pct, uv.week.color, uv.week.label],
    ['actualizado hace 12 min', '#E5493A', '5 h 95% · se reinicia 14:30', 0, '#5BC8AF', 'Semana 0% · reiniciado'], 'usageView');
eq([usageView(null, NOW), usageView({ts: 1, five: null, week: null}, NOW)], [null, null], 'usageView sin datos');

// Lectura de disco: rollouts de Codex (el más nuevo sin datos -> cae al anterior) y claude-usage.json
{
    const root = GLib.dir_make_tmp('kaito-usage-XXXXXX');
    const day = `${root}/codex/2026/11/13`;
    GLib.mkdir_with_parents(day, 0o755);
    GLib.mkdir_with_parents(`${root}/codex/2026/11/12`, 0o755);
    const put = (path, text, mtime) => {
        GLib.file_set_contents(path, text);
        Gio.File.new_for_path(path).set_attribute_uint64('time::modified', mtime, Gio.FileQueryInfoFlags.NONE, null);
    };
    const big = 'x'.repeat(300 * 1024); // fuerza la lectura parcial (se descarta la línea cortada)
    put(`${root}/codex/2026/11/12/rollout-a.jsonl`, `${cxLine({primary: {used_percent: 55, window_minutes: 300, resets_at: 9}})}\n`, 1000);
    put(`${day}/rollout-b.jsonl`, `${big}\n${cxLine({primary: {used_percent: 66, window_minutes: 300, resets_at: 9}})}\n${cxLine(null)}\n`, 2000);
    const cache = {checked: -Infinity, key: null, usage: null};
    eq(readCodexUsage(`${root}/codex`, cache, 0).five.pct, 66, 'readCodexUsage: último del fichero más nuevo (cola de 256 KB)');
    put(`${day}/rollout-b.jsonl`, 'sin datos\n', 3000);
    eq(readCodexUsage(`${root}/codex`, cache, 30).five.pct, 66, 'readCodexUsage: no relee antes de 60 s');
    eq(readCodexUsage(`${root}/codex`, cache, 61).five.pct, 55, 'readCodexUsage: sin datos -> fichero anterior');
    eq(readCodexUsage(`${root}/nada`, {checked: -Infinity, key: null, usage: null}, 0), null, 'readCodexUsage: sin carpeta');
    GLib.file_set_contents(`${root}/claude.json`, JSON.stringify({ts: 5, rate_limits: {five_hour: {used_percentage: 9, resets_at: 6}}}));
    eq(readClaudeUsage(`${root}/claude.json`).five.pct, 9, 'readClaudeUsage');
    eq(readClaudeUsage(`${root}/no-existe.json`), null, 'readClaudeUsage sin fichero');
}

// Prompt
const issue = {key: 'RUN-123', summary: 'Arreglar "login"; $(rm -rf /)'};
const NOTE = 'Todo el contenido del ticket está abajo; no intentes abrir el enlace de Jira (requiere login).\n';
const LITTLE = 'El ticket tiene poco detalle: antes de cambiar código, explora el repo, resume lo que entiendes y pregúntame lo que falte.\n';
const head = 'Trabaja en el ticket de Jira RUN-123: Arreglar "login"; $(rm -rf /)\nhttps://x.atlassian.net/browse/RUN-123\n';
const GIT = 'Git: trabaja en una rama propia (si estás en main, master o develop, crea una llamada RUN-123-<resumen-corto>). Haz commits pequeños a medida que completes partes, con mensajes que empiecen por "RUN-123: ". Al terminar deja todo commiteado (git status limpio) y sube la rama a origin con `git push -u origin <rama>`. Nunca hagas push a main, master ni develop, nunca uses force-push y no abras PR.\n';
eq(buildPrompt(issue, 'https://x.atlassian.net', null), head + NOTE + LITTLE + GIT, 'prompt');
eq(buildPrompt(issue, 'b', 'x'.repeat(20000)).length <= PROMPT_MAX, true, 'prompt recortado');
eq(buildPrompt(issue, 'b', 'x'.repeat(300)).includes('poco detalle'), false, 'descripción larga: sin aviso');

const adfP = t => ({type: 'doc', version: 1, content: [{type: 'paragraph', content: [{type: 'text', text: t}]}]});
const fake = {
    issuetype: {name: 'Bug'}, status: {name: 'En curso'}, priority: {name: 'High'},
    customfield_10062: {value: 'Tecnología'}, labels: ['a', 'b'], components: [{name: 'web'}],
    parent: {key: 'RUN-1', fields: {summary: 'Épica'}},
    reporter: {displayName: 'Ana', emailAddress: 'ana@secreto.com'},
    description: adfP('d'.repeat(250)),
    subtasks: [{key: 'RUN-124', fields: {summary: 'Sub', status: {name: 'Hecho'}}}],
    issuelinks: [{type: {outward: 'bloquea', inward: 'es bloqueado por'}, outwardIssue: {key: 'RUN-9', fields: {summary: 'Otro'}}}],
    attachment: [{filename: 'log.txt', content: 'https://secreto/log'}],
    comment: {comments: Array.from({length: 12}, (_, i) => ({author: {displayName: 'Bob', emailAddress: 'b@x.com'}, created: '2026-01-01T10:00:00.000+0100', body: adfP(`c${i}`)}))},
};
const det = formatIssueDetail(fake);
eq(det.meta, 'Tipo: Bug\nEstado: En curso\nPrioridad: High\nDepartamento: Tecnología\nEtiquetas: a, b\nComponentes: web\nPadre/épica: RUN-1 – Épica\nInformador: Ana', 'meta');
eq(det.extra, 'Subtareas:\n- RUN-124 – Sub – Hecho\n\nTickets enlazados:\n- bloquea RUN-9 – Otro\n\nAdjuntos:\n- log.txt', 'extra');
eq([det.comments.length, det.comments[0], det.comments[9]], [10, '- Bob (2026-01-01): c2', '- Bob (2026-01-01): c11'], 'comentarios');
const full = buildPrompt(issue, 'b', det);
eq([full.includes('poco detalle'), full.includes('@'), full.includes('secreto'), full.includes('Comentarios:\n- Bob')], [false, false, false, true], 'prompt detallado');
const big = buildPrompt(issue, 'b', {...det, comments: Array.from({length: 10}, (_, i) => `- c${i} ${'y'.repeat(2000)}`)});
eq([big.length <= PROMPT_MAX, big.includes('c0 '), big.includes('c9 ')], [true, false, true], 'recorta comentarios antiguos primero');
eq(formatIssueDetail({}), {meta: '', description: '', extra: '', comments: []}, 'detalle vacío');

eq(buildPrompt(issue, 'b', null, '/home/u/kontan-web', 'main').split('\n')[2], 'Repo de trabajo: kontan-web (/home/u/kontan-web), rama main', 'repo en prompt');

// Ranking de repos
eq(repoTokens('/h/kontanApp_api-v2'), ['kontan'], 'repoTokens (>= 4)');
const rr = [{path: '/h/runnea-web'}, {path: '/h/kontan-ra'}, {path: '/h/otro'}, {path: '/h/proj'}];
const ri = {key: 'RUN-5', summary: 'Carreras virtuales en el antiguo Kontan'};
const order = (cfg, i = ri) => rankRepos(i, rr, cfg).map(r => `${r.path.slice(3)}:${r.why}`);
eq(order({}), ['kontan-ra:match', 'runnea-web:null', 'otro:null', 'proj:null'], 'ranking: coincide primero');
eq(order({jiraRepoByProject: {RUN: '/h/proj'}}).slice(0, 2), ['kontan-ra:match', 'proj:project'], 'ranking: match > proyecto');
eq(order({jiraRepoByProject: {RUN: '/h/proj'}}, {key: 'RUN-5', summary: 'nada'})[0], 'proj:project', 'ranking: proyecto > recencia');
eq(order({jiraRepoByIssue: {'RUN-5': '/h/otro'}, jiraRepoByProject: {RUN: '/h/proj'}})[0], 'otro:issue', 'ranking: este ticket primero');
eq(rankRepos(ri, rr, {jiraRepoByIssue: {'RUN-5': '/h/gone'}}, p => p !== '/h/gone').length, 4, 'ranking: ignora rutas inexistentes');

// YAML de Warp y argv de ptyxis
eq(shQuote("a'b"), `'a'\\''b'`, 'shQuote');
const yaml = warpLaunchYaml('RUN-123', '/home/u/my repo', '/home/u/.cache/kaito/prompts/RUN-123.txt');
eq(yaml, [
    '---',
    'name: "kaito-RUN-123"',
    'windows:',
    '  - tabs:',
    '      - title: "RUN-123"',
    '        layout:',
    '          cwd: "/home/u/my repo"',
    '          commands:',
    '            - exec: "claude \\"$(cat \'/home/u/.cache/kaito/prompts/RUN-123.txt\')\\""',
    '',
].join('\n'), 'yaml');
eq(ptyxisArgv('/r', '/p.txt'), ['ptyxis', '--tab', '-d', '/r', '--', 'bash', '-lc', `claude "$(cat '/p.txt')"`], 'argv');
eq(ptyxisArgv('/r', '/p.txt', 'RUN-1').slice(0, 6), ['ptyxis', '--tab', '-d', '/r', '-T', 'RUN-1'], 'argv con título');
eq(warpTabToml('RUN-123', '/home/u/my "repo"', '/home/u/.cache/kaito/prompts/RUN-123.txt'), [
    'name = "kaito RUN-123"',
    'title = "RUN-123"',
    '',
    '[[panes]]',
    'id = "claude"',
    'type = "terminal"',
    'directory = "/home/u/my \\"repo\\""',
    'commands = ["claude \\"$(cat \'/home/u/.cache/kaito/prompts/RUN-123.txt\')\\""]',
    'is_focused = true',
    '',
].join('\n'), 'toml');
eq(warpTabToml('A-1', '/x\x7fy', '/p').includes('/x\\u007fy'), true, 'toml: DEL escapado');

// cwd de un .jsonl
eq(cwdFromJsonl('{"type":"x"}\n{"cwd":"/home/u/repo","x":1}\n'), '/home/u/repo', 'cwdFromJsonl');
eq(cwdFromJsonl('{"cwd":"rel"}\nbasura'), null, 'cwdFromJsonl relativo');

// Iconos de prioridad: SVG válidos
for (const k of ['highest', 'high', 'medium', 'low', 'lowest']) {
    const path = GLib.build_filenamev([GLib.path_get_dirname(import.meta.url.replace('file://', '')), 'icons', `priority-${k}.svg`]);
    eq(GdkPixbuf.Pixbuf.new_from_file(path).get_width(), 16, `svg ${k}`);
}

// sendIssueToClaude con lanzador falso, solo en un XDG temporal
if (GLib.getenv('XDG_CACHE_HOME')?.startsWith('/tmp') && GLib.getenv('XDG_DATA_HOME')?.startsWith('/tmp')) {
    const repo = GLib.dir_make_tmp('kaito-repo-XXXXXX');
    let got = null;
    const t = sendIssueToClaude({issue, base: 'https://x', description: 'desc', repo, terminal: 'warp'}, o => (got = o));
    eq(got.uri, 'warp://tab_config/kaito-RUN-123', 'uri warp pestaña');
    eq(t.tomlPath.endsWith('/warp-terminal/tab_configs/kaito-RUN-123.toml'), true, 'ruta toml');
    eq(new TextDecoder().decode(GLib.file_get_contents(t.tomlPath)[1]), warpTabToml('RUN-123', repo, t.promptPath), 'toml escrito');
    const w = sendIssueToClaude({issue, base: 'https://x', description: 'desc', repo, terminal: 'warp-window'}, o => (got = o));
    eq(got.uri, 'warp://launch/kaito-RUN-123.yaml', 'uri warp ventana');
    eq(new TextDecoder().decode(GLib.file_get_contents(w.yamlPath)[1]), warpLaunchYaml('RUN-123', repo, w.promptPath), 'yaml escrito');
    eq(new TextDecoder().decode(GLib.file_get_contents(w.promptPath)[1]), buildPrompt(issue, 'https://x', 'desc', repo, null), 'prompt escrito');
    const probe = (cmds, fp = false, ver = null) => ({has: c => cmds.includes(c), ptyxisFlatpak: () => fp, ptyxisVersion: () => ver});
    const p = sendIssueToClaude({issue, base: 'https://x', description: null, repo, terminal: 'ptyxis'}, o => (got = o), probe(['ptyxis']));
    eq(got.argv, ptyxisArgv(repo, p.promptPath, 'RUN-123'), 'argv ptyxis');
    eq(p.terminal, 'ptyxis', 'terminal resuelto');
    const au = sendIssueToClaude({issue, base: 'https://x', description: null, repo, terminal: 'auto'}, o => (got = o), probe(['warp-terminal'], true, 'Ptyxis 53.0'));
    eq([au.terminal, got.argv.slice(0, 4)], ['ptyxis', ['flatpak', 'run', 'app.devsuite.Ptyxis', '--tab']], 'auto: ptyxis flatpak 53 antes que warp');
    const gt = sendIssueToClaude({issue, base: 'https://x', description: null, repo, terminal: 'auto'}, o => (got = o), probe(['gnome-terminal', 'kgx']));
    eq(got.argv, gnomeTerminalArgv(repo, gt.promptPath, 'RUN-123'), 'auto: gnome-terminal');
    sendIssueToClaude({issue, base: 'https://x', description: null, repo, terminal: 'kgx'}, o => (got = o), probe([]));
    eq(got.argv[0], 'kgx', 'kgx explícito');
    const aw = sendIssueToClaude({issue, base: 'https://x', description: null, repo, terminal: 'auto'}, o => (got = o), probe(['warp-terminal']));
    eq([aw.terminal, got.uri], ['warp', 'warp://tab_config/kaito-RUN-123'], 'auto: solo warp');
    let none = false;
    try {
        sendIssueToClaude({issue, base: 'https://x', description: null, repo, terminal: 'auto'}, () => {}, probe([]));
    } catch (e) {
        none = /ninguna terminal/.test(e.message);
    }
    eq(none, true, 'auto sin terminales: error legible');
    let threw = false;
    try {
        sendIssueToClaude({issue: {key: 'bad; rm', summary: ''}, base: '', repo, terminal: 'warp'}, () => {});
    } catch (_e) {
        threw = true;
    }
    eq(threw, true, 'clave no válida');
    print(`ficheros: ${t.tomlPath} ${w.yamlPath} ${w.promptPath}`);
}

// --- Terminales: argv, auto, foco ---
eq(ptyxisArgv('/r', '/p.txt', 'K-1', true), ['flatpak', 'run', 'app.devsuite.Ptyxis', '--tab', '-d', '/r', '-T', 'K-1', '--', 'bash', '-lc', `claude "$(cat '/p.txt')"`], 'argv ptyxis flatpak');
eq(gnomeTerminalArgv('/my repo', "/p'x.txt", 'K-1'), ['gnome-terminal', '--tab', '--working-directory=/my repo', '--title=K-1', '--', 'bash', '-lc', `claude "$(cat '/p'\\''x.txt')"`], 'argv gnome-terminal');
eq(kgxArgv('/r', '/p.txt'), ['kgx', '--tab', '--working-directory=/r', '--', 'bash', '-lc', `claude "$(cat '/p.txt')"`], 'argv kgx');
eq(kgxArgv('/r', '/p.txt', 'K-2')[3], '--title=K-2', 'argv kgx título');
eq(TERMINALS, ['auto', 'ptyxis', 'gnome-terminal', 'kgx', 'warp', 'warp-window'], 'terminales');
{
    const pr = (cmds, fp = false, ver = null) => ({has: c => cmds.includes(c), ptyxisFlatpak: () => fp, ptyxisVersion: () => ver});
    eq(resolveTerminal('auto', pr(['ptyxis', 'gnome-terminal', 'warp-terminal'], false, 'Ptyxis 52.0')), {id: 'ptyxis', flatpak: false}, 'auto: ptyxis 52 nativo');
    eq(resolveTerminal('auto', pr(['ptyxis', 'warp-terminal'], false, 'Ptyxis 50.1')), {id: 'warp', flatpak: false}, 'auto: ptyxis 50 + warp -> warp');
    eq(resolveTerminal('auto', pr(['ptyxis', 'gnome-terminal'], false, 'Ptyxis 50.1')), {id: 'gnome-terminal', flatpak: false}, 'auto: ptyxis 50 + gnome-terminal');
    eq(resolveTerminal('auto', pr(['ptyxis'], false, 'Ptyxis 50.1')), {id: 'ptyxis', flatpak: false}, 'auto: ptyxis 50 solo');
    eq(resolveTerminal('auto', pr(['ptyxis'])), {id: 'ptyxis', flatpak: false}, 'auto: ptyxis versión desconocida solo');
    eq(resolveTerminal('auto', pr(['kgx', 'warp-terminal'])), {id: 'warp', flatpak: false}, 'auto: warp antes que kgx');
    eq(resolveTerminal('auto', pr(['kgx'])), {id: 'kgx', flatpak: false}, 'auto: kgx solo');
    eq(resolveTerminal('auto', pr([], true, 'Ptyxis 53.0')), {id: 'ptyxis', flatpak: true}, 'auto: ptyxis flatpak 53');
    eq(resolveTerminal('auto', pr([], true, 'Ptyxis 50.1')), {id: 'ptyxis', flatpak: true}, 'auto: ptyxis flatpak 50 solo');
    eq(resolveTerminal('auto', pr([])), null, 'auto: nada');
    eq(resolveTerminal('warp', pr(['ptyxis'])), {id: 'warp', flatpak: false}, 'explícito: warp');
    eq(resolveTerminal('ptyxis', pr([], true)), {id: 'ptyxis', flatpak: true}, 'explícito: ptyxis solo flatpak');
    eq(resolveTerminal('raro', pr(['kgx'])), {id: 'kgx', flatpak: false}, 'valor desconocido = auto');
}
eq(terminalMigration({terminal: 'warp'}), {terminal: 'auto', terminalMigrated: true}, 'migración: warp -> auto');
eq(terminalMigration({terminal: 'warp', terminalMigrated: true}), null, 'migración: una sola vez');
eq(terminalMigration({terminal: 'ptyxis'}), {terminalMigrated: true}, 'migración: otro terminal se respeta');
eq(terminalMigration({}), {terminalMigrated: true}, 'migración: sin terminal');
eq([ptyxisExportsTab('Ptyxis 50.1'), ptyxisExportsTab('Ptyxis 52.alpha'), ptyxisExportsTab('Ptyxis 53.0'), ptyxisExportsTab(null)], [false, true, true, false], 'PTYXIS_TAB por versión');
eq([terminalFocusLevel('gnome-terminal'), terminalFocusLevel('ptyxis', 'Ptyxis 50.1'), terminalFocusLevel('ptyxis', 'Ptyxis 52.0'), terminalFocusLevel('kgx'), terminalFocusLevel('warp')],
    ['tab', 'window', 'tab', 'window', 'window'], 'nivel de foco');
eq(parseEnviron(new TextEncoder().encode('A=1\0PTYXIS_TAB=x=y\0\0B=\0')), {A: '1', PTYXIS_TAB: 'x=y', B: ''}, 'parseEnviron');
{
    const U = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const env = o => ({comm: 'bash', env: o});
    eq(terminalFocusTarget([{comm: 'claude', env: {PTYXIS_TAB: U}}, env({})]), {kind: 'ptyxis', uuid: U}, 'foco: PTYXIS_TAB del agente');
    eq(terminalFocusTarget([{comm: 'claude', env: {}}, env({GNOME_TERMINAL_SCREEN: `/org/gnome/Terminal/screen/${U.replace(/-/g, '_')}`})]),
        {kind: 'gnome-terminal', uuid: U}, 'foco: pantalla de GNOME Terminal (subiendo)');
    eq(terminalFocusTarget([{comm: 'claude', env: {}}, {comm: 'ptyxis-agent', env: {}}, env({PTYXIS_TAB: U})]), null, 'foco: se para en la terminal');
    eq(terminalFocusTarget([{comm: 'claude', env: {PTYXIS_TAB: 'no-uuid'}}]), null, 'foco: uuid inválido');
    eq(terminalFocusTarget([{comm: 'claude', env: {GNOME_TERMINAL_SCREEN: '/otra/ruta/x'}}]), null, 'foco: ruta rara');
    eq(terminalFocusTarget([]), null, 'foco: sin cadena');
}

// --- Vistas de Jira ---
eq(viewJql('unassigned', {projects: ['RUN', 'WEB']}),
    'project in ("RUN", "WEB") AND assignee is EMPTY AND statusCategory != Done ORDER BY priority DESC, updated DESC', 'jql sin asignar');
eq(viewJql('sprint', {projects: ['RUN']}),
    'project in ("RUN") AND sprint in openSprints() AND statusCategory != Done ORDER BY priority DESC, updated DESC', 'jql sprint');
eq(viewJql('recent'), '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -24h ORDER BY updated DESC', 'jql recientes');
eq(viewJql('recent'), RECENT_JQL, 'jql recientes = constante');
eq(viewJql('mine', {mineJql: 'x = y'}), 'x = y', 'jql mías = la de Ajustes');
eq([viewJql('unassigned', {projects: []}), viewJql('sprint')], [null, null], 'sin proyectos: null');
eq(viewJql('unassigned', {projects: ['RUN', 'bad"); DROP', 'A1']}), 'project in ("RUN", "A1") AND assignee is EMPTY AND statusCategory != Done ORDER BY priority DESC, updated DESC', 'claves no válidas fuera');
eq(viewJql('otra', {projects: ['RUN']}), null, 'vista desconocida');
eq(projectsFromIssues([{key: 'WEB-2'}, {key: 'RUN-1'}, {key: 'RUN-9'}, {key: 'raro'}]), ['RUN', 'WEB'], 'proyectos distintos');
eq(normalizeCustomViews([{id: 'c1', name: ' Bugs ', jql: ' type = Bug ', enabled: false}, {id: 'c1', name: 'dup'}, {id: 'mine'}, null, {name: 'sin id'}]),
    [{id: 'c1', name: 'Bugs', jql: 'type = Bug', enabled: false}], 'vistas propias normalizadas');
eq(normalizeCustomViews('x'), [], 'vistas propias no lista');
eq(visibleViews({}).map(v => v.id), ['mine', 'unassigned', 'sprint', 'recent'], 'vistas por defecto');
eq(visibleViews({jiraBuiltinViews: {sprint: false, recent: false}, jiraViews: [
    {id: 'c1', name: 'Bugs', jql: 'type = Bug'}, {id: 'c2', name: 'Off', jql: 'x', enabled: false}, {id: 'c3', name: 'Vacía', jql: ''}]}).map(v => [v.id, v.custom]),
[['mine', false], ['unassigned', false], ['c1', true]], 'vistas: ocultas, propias activas con JQL');
eq(visibleViews({jiraBuiltinViews: {mine: false}})[0].id, 'mine', '"Mías" siempre');
eq([shortName('Julen Pérez García'), shortName('ana'), shortName('  '), shortName(null), shortName('josé  maría')], ['Julen P.', 'ana', '', '', 'josé M.'], 'nombre corto');
eq(mapSearchIssue({key: 'RUN-1', fields: {summary: 's', status: {name: 'En curso', statusCategory: {key: 'indeterminate'}}, assignee: {accountId: 'a1', displayName: 'Ana B'}}}).assignee,
    {accountId: 'a1', displayName: 'Ana B'}, 'responsable mapeado');
eq(mapSearchIssue({key: 'RUN-2', fields: {}}).assignee, null, 'sin responsable');
eq(sortIssues([mapSearchIssue({key: 'A-1', fields: {status: {statusCategory: {key: 'done'}}}}), mapSearchIssue({key: 'A-2', fields: {}})]).map(i => i.key), ['A-2', 'A-1'], 'sortIssues también en vistas');

// Filtro y escaneo de repos
const fr = [{path: '/h/Documentos/runnea/acs_kontan'}, {path: '/h/Documentos/personal/kaito'}, {path: '/h/Ñandú/café'}];
eq(filterRepos(fr, '').length, 3, 'filtro vacío');
eq(filterRepos(fr, 'ACS').map(r => r.path), ['/h/Documentos/runnea/acs_kontan'], 'filtro basename');
eq(filterRepos(fr, 'runnea kontan').length, 1, 'filtro: todos los términos');
eq(filterRepos(fr, 'kontan kaito').length, 0, 'filtro: falta un término');
eq(filterRepos(fr, 'CAFE nandu').length, 1, 'filtro sin acentos ni mayúsculas');
{
    const t = GLib.dir_make_tmp('kaito-scan-XXXXXX');
    const mk = p => GLib.mkdir_with_parents(`${t}/${p}`, 0o755);
    mk('a/.git'); mk('b/sub/.git'); mk('c/.git'); mk('c/nested/.git'); mk('node_modules/x/.git'); mk('.hid/y/.git');
    mk('d/e/f/g/h/.git'); mk('d/e/f/ok/.git'); mk('plain/none');
    GLib.mkdir_with_parents(`${t}/w`, 0o755); GLib.file_set_contents(`${t}/w/.git`, 'gitdir: x');
    const got = scanRepos([t]).map(r => r.path.slice(t.length + 1));
    eq(got, ['a', 'b/sub', 'c', 'd/e/f/ok', 'w'], 'scanRepos');
}

// parseTail: último texto del asistente
{
    const J = o => JSON.stringify(o);
    const tail = ['cortada', J({type: 'assistant', cwd: '/h/repo', message: {content: [{type: 'text', text: 'Hecho: tests en verde.\nRama RUN-1-x'}]}}),
        J({type: 'assistant', message: {content: [{type: 'tool_use', name: 'Bash', input: {command: 'ls'}}]}})].join('\n');
    const t = parseTail(tail);
    eq([t.cwd, t.lastAction, t.lastText], ['repo', 'Bash: ls', 'Hecho: tests en verde.\nRama RUN-1-x'], 'parseTail lastText');
    eq(parseTail('x\n' + J({type: 'user', message: {content: 'hola'}})).lastText, null, 'parseTail sin asistente');
    eq(firstLine('\n## Hecho\n- algo'), 'Hecho', 'firstLine');
    eq(firstLine('x'.repeat(200), 10).length, 10, 'firstLine recorta');

    // Ticket del primer mensaje del usuario
    const head = (...e) => e.map(J).join('\n');
    const meta = {type: 'user', isMeta: true, message: {content: 'Trabaja en el ticket de Jira RUN-9: no'}};
    eq(ticketFromHead(head({type: 'attachment'}, meta, {type: 'user', message: {content: 'Trabaja en el ticket de Jira RUN-12326: Arreglar x\nhttps://…'}})), 'RUN-12326', 'ticket del prompt');
    eq(ticketFromHead(head({type: 'user', message: {content: [{type: 'text', text: 'Trabaja en el ticket de Jira AB_2-7: y'}]}})), 'AB_2-7', 'ticket en bloques');
    eq(ticketFromHead(head({type: 'user', message: {content: 'otra cosa. Trabaja en el ticket de Jira RUN-1: x'}})), null, 'no es prompt de Kaito');
    eq(ticketFromHead(head({type: 'attachment'}, meta)), undefined, 'aún sin mensaje del usuario');
    eq(ticketFromHead('{"type":"user","message":{"content":"Trabaja en el ti'), undefined, 'línea cortada');
}

// Responder: ¿se puede decidir el permiso desde Kaito?
{
    const hook = {kind: 'permission', request: 'r1', waitUntil: 1000};
    eq(canDecide({state: 'needs', hook}, 999), true, 'canDecide');
    eq(canDecide({state: 'needs', hook}, 1001), false, 'canDecide caducado');
    eq(canDecide({state: 'needs', hook: {...hook, kind: undefined}}, 999), false, 'canDecide sin permiso');
    eq(canDecide({state: 'done', hook}, 999), false, 'canDecide no needs');
    eq(canDecide({state: 'needs'}, 0), false, 'canDecide sin hook');
    const bt = agentsByTicket([{id: 'a', ticket: 'RUN-1', age: 50}, {id: 'b', ticket: 'RUN-1', age: 5}, {id: 'c', ticket: null, age: 1}]);
    eq(Object.fromEntries(Object.entries(bt).map(([k, v]) => [k, v.id])), {'RUN-1': 'b'}, 'agentsByTicket');
}

// Resumen del día
{
    const now = new Date(2026, 10, 19, 8, 30);
    eq(localDay(now), '2026-11-19', 'localDay');
    eq(shouldShowDaily(null, now), true, 'daily: primera vez');
    eq(shouldShowDaily('2026-11-19', now), false, 'daily: ya mostrado hoy');
    eq(shouldShowDaily('2026-11-18', new Date(2026, 10, 19, 5, 59)), false, 'daily: antes de las 6');
    eq(shouldShowDaily('2026-11-18', new Date(2026, 10, 19, 6, 0)), true, 'daily: a las 6');
    const at = (h, m, d = 19) => new Date(2026, 10, d, h, m).toISOString();
    const lines = dailySummaryLines({
        now,
        issues: [{key: 'RUN-1', category: 'indeterminate'}, {key: 'RUN-2', category: 'new'}, {key: 'RUN-3', category: 'indeterminate'}],
        reminders: [{text: 'pasado', due: at(7, 0)}, {text: 'llamar a Iker', due: at(10, 30)}, {text: 'luego', due: at(17, 0)},
            {text: 'hecho', due: at(9, 0), done: true}, {text: 'mañana', due: at(9, 0, 20)}],
        agents: [{cwd: 'kaito', live: false, activityMs: new Date(2026, 10, 18, 20, 0).getTime()},
            {cwd: 'web', state: 'needs', live: false, activityMs: new Date(2026, 10, 18, 23, 0).getTime()},
            {cwd: 'hoy', live: false, activityMs: new Date(2026, 10, 19, 7, 0).getTime()},
            {cwd: 'vivo', live: true, activityMs: new Date(2026, 10, 18, 7, 0).getTime()}],
    });
    eq(lines, ['2 tickets en curso: RUN-1, RUN-3',
        '3 recordatorios hoy · el próximo a las 10:30: llamar a Iker',
        '2 agentes esperando desde ayer: kaito, web'], 'dailySummaryLines');
    eq(dailySummaryLines({now}), [], 'daily vacío');
    eq(dailySummaryLines({now, issues: [{key: 'A-1', category: 'indeterminate'}]}), ['1 ticket en curso: A-1'], 'daily singular');
}

// Orden de tickets
{
    const I = (key, category, status, prio, updated) => ({key, category, status, priority: prio ? {id: prio, name: ''} : null, updated});
    const list = [
        I('DONE', 'done', 'Hecho', '1', '2026-11-19T10:00:00.000+0100'),
        I('NEW-LOW', 'new', 'Por hacer', '4', '2026-11-19T10:00:00.000+0100'),
        I('BLOCK', 'indeterminate', 'Bloqueado', '1', '2026-11-19T10:00:00.000+0100'),
        I('PROG-MED-OLD', 'indeterminate', 'En curso', '3', '2026-11-01T10:00:00.000+0100'),
        I('NEW-HIGH', 'new', 'Por hacer', '2', null),
        I('PROG-MED-NEW', 'indeterminate', 'En curso', '3', '2026-11-18T10:00:00.000+0100'),
        I('WAIT', 'new', 'Esperando cliente', '5', null),
        I('PROG-NOPRIO', 'indeterminate', 'Haciendo', null, '2026-11-19T10:00:00.000+0100'),
        I('PROG-HIGHEST', 'indeterminate', 'Probando', '1', null),
        I('OTHER', 'undefined', 'Raro', '3', null),
        I('PROG-MED-NEW-2', 'indeterminate', 'En curso', '3', '2026-11-18T10:00:00.000+0100'),
    ];
    eq(sortIssues(list).map(i => i.key), ['PROG-HIGHEST', 'PROG-MED-NEW', 'PROG-MED-NEW-2', 'PROG-MED-OLD', 'PROG-NOPRIO',
        'NEW-HIGH', 'NEW-LOW', 'BLOCK', 'OTHER', 'WAIT', 'DONE'], 'sortIssues');
    eq(list[0].key, 'DONE', 'sortIssues no modifica la entrada');
    eq([statusGroup({category: 'indeterminate', status: 'Waiting for QA'}), statusGroup({category: 'done', status: 'Blocked'})], [2, 3], 'statusGroup');
    eq(sortIssues([I('A', 'new', 'x', null, null), I('B', 'new', 'x', null, null)]).map(i => i.key), ['A', 'B'], 'sortIssues: orden API');
}

// Al terminar un ticket: PR, log, deduplicado, tarjeta
{
    eq(parseRemote('git@github.com:runnea/web.git'), {host: 'github.com', path: 'runnea/web'}, 'remote scp');
    eq(parseRemote('https://user:tok@github.com/runnea/web.git'), {host: 'github.com', path: 'runnea/web'}, 'remote https con credenciales');
    eq(parseRemote('ssh://git@gitlab.com:2222/grupo/sub/app.git/'), {host: 'gitlab.com', path: 'grupo/sub/app'}, 'remote ssh://');
    eq(parseRemote('/srv/git/repo.git'), null, 'remote local');
    eq(parseRemote('file:///srv/repo.git'), null, 'remote file://');
    eq(prUrl('git@github.com:runnea/web.git', 'RUN-1-fix/x y'), 'https://github.com/runnea/web/pull/new/RUN-1-fix/x%20y', 'pr github ssh');
    eq(prUrl('https://github.com/runnea/web', 'RUN-1'), 'https://github.com/runnea/web/pull/new/RUN-1', 'pr github https');
    eq(prUrl('git@github.com-work:runnea/web.git', 'RUN-1'), 'https://github.com/runnea/web/pull/new/RUN-1', 'pr github alias ssh');
    eq(prUrl('git@gitlab.com:g/sub/app.git', 'RUN-2'), 'https://gitlab.com/g/sub/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=RUN-2', 'pr gitlab ssh');
    eq(prUrl('https://gitlab.empresa.es/g/app.git', 'RUN-2'), 'https://gitlab.empresa.es/g/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=RUN-2', 'pr gitlab autoalojado');
    eq(prUrl('git@bitbucket.org:ws/app.git', 'RUN-3'), 'https://bitbucket.org/ws/app/pull-requests/new?source=RUN-3&t=1', 'pr bitbucket ssh');
    eq(prUrl('https://julen@bitbucket.org/ws/app.git', 'a&b'), 'https://bitbucket.org/ws/app/pull-requests/new?source=a%26b&t=1', 'pr bitbucket https');
    eq([prUrl('git@github.com:o/r.git', 'main'), prUrl('git@github.com:o/r.git', null), prUrl('git@example.com:o/r.git', 'x'),
        prUrl('git@notgithub.io:o/r.git', 'x')], [null, null, null, null], 'pr: sin URL');
    eq(parseLog('abc1234 RUN-1: hola mundo\n\nzzz basura\ndef5678 RUN-1: x  \n'), [{sha: 'abc1234', subject: 'RUN-1: hola mundo'}, {sha: 'def5678', subject: 'RUN-1: x'}], 'parseLog');
    eq(parseLog(null), [], 'parseLog null');
    const k = finishKey('s1', 'abc');
    const m1 = markOnce({}, k, 1000);
    const m2 = markOnce(m1.map, k, 2000);
    const m3 = markOnce({...m2.map, viejo: 1}, finishKey('s1', 'def'), 8 * 86400 * 1000);
    eq([m1.fresh, m2.fresh, m3.fresh, Object.keys(m3.map)], [true, false, true, ['s1:def']], 'markOnce');
    const work = {branch: 'RUN-12326-carreras-virtuales', pushed: true, commits: [{sha: 'a', subject: 'RUN-12326: carreras'}, {sha: 'b', subject: 'x'}]};
    eq(finishLines({work, moved: 'Probando Desarrollo', lastText: '## Hecho\nresto', remindAt: new Date(2026, 10, 19, 9, 5)}), [
        {text: 'Rama RUN-12326-carreras-virtuales · subida', warn: false},
        {text: '2 commits nuevos · RUN-12326: carreras', warn: false},
        {text: 'Movido a Probando Desarrollo', warn: false},
        {text: 'Te recuerdo revisarlo a las 09:05', warn: false},
        {text: 'Hecho', warn: false, quote: true},
    ], 'finishLines');
    eq(finishLines({work: {...work, pushed: false, commits: [work.commits[0]]}, reason: 'HTTP 403'}).map(l => [l.text, l.warn]), [
        ['Rama RUN-12326-carreras-virtuales · sin subir', true], ['1 commit nuevo · RUN-12326: carreras', false],
        ['No se ha movido: HTTP 403', true]], 'finishLines sin subir ni mover');
    eq([reviewReminderText('RUN-1', 'Arreglar x'), reviewReminderText('RUN-1', '')], ['Revisar RUN-1 · Arreglar x', 'Revisar RUN-1'], 'texto recordatorio');
}

// Transcript: rutas con las que trabajó el agente (recientes primero) y ramas del ticket
{
    const tu = input => JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text: 'cd /no/esto'}, {type: 'tool_use', name: 'x', input}]}});
    const jsonl = [tu({command: 'cd /srv/a && git status'}), 'linea {cortada', JSON.stringify({type: 'user', message: {content: 'cd /no'}}),
        tu({file_path: '/srv/b/src/x.js'}), tu({command: "git -C '/srv/c d' log; cd ~/w/e | cat"}), tu({command: 'cd rel && ls'}),
        tu({file_path: '/srv/a/y.js'})].join('\n');
    eq(pathsFromTranscript(jsonl, '/home/u'), ['/srv/a/y.js', '/home/u/w/e', '/srv/c d', '/srv/b/src/x.js', '/srv/a'], 'pathsFromTranscript');
    eq(pathsFromTranscript('', '/h'), [], 'pathsFromTranscript vacío');
    const dirs = new Set(['/srv', '/srv/a', '/srv/b', '/srv/b/src']);
    eq(dirsFromPaths(['/srv/a/y.js', '/srv/b/src/x.js', '/srv/a', '/srv/zz/q/f.js', '/nada/f'], p => dirs.has(p)), ['/srv/a', '/srv/b/src', '/srv'], 'dirsFromPaths');
    const refs = 'main 100\nrun-5-Algo 300\nfeature/RUN-5-b 200\nRUN-5-viejo 10\nRUN-50-otro 400\nbasura\n';
    eq(ticketBranches(refs, 'RUN-5', 100), [{branch: 'run-5-Algo', ts: 300}, {branch: 'feature/RUN-5-b', ts: 200}], 'ticketBranches');
}

// detectWork en un repo temporal con un "origin" bare temporal
if (GLib.find_program_in_path('git')) {
    const tmp = GLib.dir_make_tmp('kaito-git-XXXXXX');
    let extraEnv = [];
    const sh = (cwd, ...argv) => {
        const [, out, err, status] = GLib.spawn_sync(cwd, ['git', ...argv], [...extraEnv,
            'GIT_AUTHOR_NAME=t', 'GIT_AUTHOR_EMAIL=t@t', 'GIT_COMMITTER_NAME=t', 'GIT_COMMITTER_EMAIL=t@t',
            `HOME=${tmp}`, 'GIT_CONFIG_NOSYSTEM=1', `PATH=${GLib.getenv('PATH')}`,
        ], GLib.SpawnFlags.SEARCH_PATH, null);
        if (status !== 0)
            throw new Error(`git ${argv.join(' ')}: ${new TextDecoder().decode(err)}`);
        return new TextDecoder().decode(out).trim();
    };
    const origin = `${tmp}/origin.git`, repo = `${tmp}/repo`;
    sh(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    sh(tmp, 'init', '-q', '-b', 'main', repo);
    sh(repo, 'remote', 'add', 'origin', origin);
    GLib.file_set_contents(`${repo}/a.txt`, '1');
    sh(repo, 'add', '.');
    const old = Math.floor(Date.now() / 1000) - 7200;
    extraEnv = [`GIT_COMMITTER_DATE=@${old} +0000`];
    sh(repo, 'commit', '-q', '-m', 'inicial', `--date=@${old} +0000`);
    extraEnv = [];
    sh(repo, 'push', '-q', '-u', 'origin', 'main');
    sh(repo, 'switch', '-q', '-c', 'RUN-9-algo');
    const since = Math.floor(Date.now() / 1000) - 60;
    let wk = await detectWork(repo, since);
    eq([wk.branch, wk.commits.length, wk.upstream, wk.pushed], ['RUN-9-algo', 0, null, false], 'detectWork: rama sin commits');
    GLib.file_set_contents(`${repo}/a.txt`, '2');
    sh(repo, 'commit', '-q', '-am', 'RUN-9: cambio');
    wk = await detectWork(repo, since);
    eq([wk.commits.map(c => c.subject), wk.upstream, wk.pushed, wk.remote, wk.head === sh(repo, 'rev-parse', 'HEAD')],
        [['RUN-9: cambio'], null, false, origin, true], 'detectWork: commit sin subir');
    sh(repo, 'push', '-q', '-u', 'origin', 'RUN-9-algo');
    wk = await detectWork(repo, since);
    eq([wk.upstream, wk.pushed], ['origin/RUN-9-algo', true], 'detectWork: subida');
    GLib.file_set_contents(`${repo}/a.txt`, '3');
    sh(repo, 'commit', '-q', '-am', 'RUN-9: otro');
    wk = await detectWork(repo, since);
    eq([wk.commits.length, wk.pushed], [2, false], 'detectWork: commit posterior sin subir');
    eq(await detectWork(tmp, since), null, 'detectWork: no es repo');
    eq(await detectWork('relativo', since), null, 'detectWork: ruta relativa');

    // El agente trabajó en OTRO repo que su cwd: rama con la clave del ticket en el segundo repo
    {
        const repo2 = `${tmp}/otro`, home2 = GLib.build_filenamev([tmp, 'h']);
        sh(tmp, 'init', '-q', '-b', 'main', repo2);
        GLib.file_set_contents(`${repo2}/b.txt`, '1');
        sh(repo2, 'add', '.');
        extraEnv = [`GIT_COMMITTER_DATE=@${old} +0000`];
        sh(repo2, 'commit', '-q', '-m', 'inicial', `--date=@${old} +0000`);
        extraEnv = [];
        const solo = `${tmp}/solo`; // repo sin rama del ticket ni commits nuevos
        sh(tmp, 'init', '-q', '-b', 'main', solo);
        GLib.file_set_contents(`${solo}/c.txt`, '1');
        sh(solo, 'add', '.');
        extraEnv = [`GIT_COMMITTER_DATE=@${old} +0000`];
        sh(solo, 'commit', '-q', '-m', 'inicial', `--date=@${old} +0000`);
        extraEnv = [];
        sh(repo2, 'switch', '-q', '-c', 'run-77-cards');
        GLib.file_set_contents(`${repo2}/b.txt`, '2');
        sh(repo2, 'commit', '-q', '-am', 'RUN-77: cards');
        sh(repo2, 'switch', '-q', 'main');
        const since2 = Math.floor(Date.now() / 1000) - 60;
        eq(await findTicketWork(solo, 'RUN-77', since2), null, 'findTicketWork: nada en ningún sitio');
        // por el transcript
        const sid = 'sess-1';
        const pdir = GLib.build_filenamev([CLAUDE_PROJECTS, solo.replace(/[^a-zA-Z0-9]/g, '-')]);
        if (CLAUDE_PROJECTS.startsWith('/tmp') || CLAUDE_PROJECTS.startsWith(tmp) || GLib.get_home_dir().startsWith('/tmp')) {
            GLib.mkdir_with_parents(pdir, 0o755);
            GLib.file_set_contents(`${pdir}/${sid}.jsonl`, JSON.stringify({type: 'assistant', message: {content: [
                {type: 'tool_use', name: 'Bash', input: {command: `cd ${repo2} && git switch -c run-77-cards`}}]}}) + '\n');
            const tw = await findTicketWork(solo, 'RUN-77', since2, null, {sessionId: sid});
            eq([tw?.repo, tw?.branch, tw?.commits.map(c => c.subject), tw?.pushed], [repo2, 'run-77-cards', ['RUN-77: cards'], false], 'findTicketWork: por transcript');
        } else {
            print('(sin HOME temporal: se omite la prueba de transcript)');
        }
        // por escaneo de repos conocidos (raíz con ambos repos)
        const sw = await findTicketWork(solo, 'RUN-77', since2, null, {roots: [tmp]});
        eq([sw?.repo, sw?.branch], [repo2, 'run-77-cards'], 'findTicketWork: por escaneo');
        // la rama actual del cwd con commits nuevos (comportamiento previo)
        const cw = await findTicketWork(repo, 'RUN-99', since);
        eq([cw.repo, cw.branch], [repo, 'RUN-9-algo'], 'findTicketWork: rama actual del cwd');
        eq((await findTicketWork(repo, 'RUN-9', since)).repo, repo, 'findTicketWork: rama del ticket en el cwd');
    }
    print(`repo git temporal: ${repo}`);
}

// Actualizaciones: salida de bin/kaito check --json / update con KAITO_UPDATE_FROM_SHELL=1
eq(parseCheck('{"current":"0.1.0","latest":"0.2.0","behind":3}\n'), {behind: 3, latest: '0.2.0', current: '0.1.0', changes: []}, 'check con versión nueva');
eq(parseCheck('{"current":"0.3.0","latest":"0.4.0","behind":7,"changes":["Uno \\"a\\"","",3,"Dos","Tres","Cuatro","Cinco","Seis"]}').changes,
    ['Uno "a"', 'Dos', 'Tres', 'Cuatro', 'Cinco'], 'check: changes filtrados (solo texto, máx. 5)');
eq(changelogBody(['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco']), '• Uno\n• Dos\n• Tres\n… y 2 más', 'changelog: 3 líneas + resto');
eq(changelogBody(['  Solo   uno ']), '• Solo uno', 'changelog: espacios');
eq(changelogBody([]), 'Pulsa Actualizar para instalarla', 'changelog vacío');
eq(changelogBody(['x'.repeat(200)]).length, 92, 'changelog: línea recortada');
eq(parseCheck('{"current":"0.1.0","latest":null,"behind":0,"error":"fetch"}'), null, 'check sin red');
eq(parseCheck('basura'), null, 'check ilegible');
eq(parseUpdateMarker('==> Buscando\n  ✓ Actualizado a 0.2.0.\nkaito-update: version=0.2.0 relogin=1 updated=1\n'),
    {version: '0.2.0', relogin: true, updated: true}, 'marcador de update');
eq(parseUpdateMarker('kaito-update: version=0.1.0 relogin=0 updated=0'), {version: '0.1.0', relogin: false, updated: false}, 'marcador al día');
eq(parseUpdateMarker('sin marcador'), null, 'sin marcador');
eq(firstErrorLine('\x1b[1;34m==>\x1b[0m Buscando\n  \x1b[31m✗\x1b[0m El checkout tiene cambios locales; no se actualiza:\n  M x'),
    'El checkout tiene cambios locales; no se actualiza:', 'primera línea de error');
eq(firstErrorLine('fatal: no remote\n'), 'fatal: no remote', 'error de git');

// Config nueva (0.4) y ficheros de estado: solo con XDG temporales (nunca la config real).
if (GLib.get_user_config_dir().startsWith('/tmp') || CONFIG_PATH.includes('/scratchpad/')) {
    let c = readConfig();
    eq([c.jiraEnabled, c.workHours, c.dndManual, c.dndUntil, c.dndSilenceReminders, c.agentProviders.codex],
        [true, {enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00'}, false, null, false, true], 'config 0.4 por defecto');
    updateConfig({jiraEnabled: false, workHours: {enabled: true, days: [6, 7], start: '22:00', end: '6:00'}, dndUntil: 'x',
        agentProviders: {codex: false}});
    c = readConfig();
    eq([c.jiraEnabled, c.workHours, c.dndUntil, c.agentProviders.codex, c.agentProviders.claude],
        [false, {enabled: true, days: [6, 7], start: '22:00', end: '06:00'}, null, false, true], 'config 0.4 guardada');
    let q = queuePush([], {key: 'update', text: 'Kaito 0.4.0 disponible', action: {type: 'update'}});
    q = queuePush(q, {key: 'update', text: 'Kaito 0.4.1 disponible', action: {type: 'update'}});
    writeQuietQueue(q);
    eq(readQuietQueue().map(x => x.text), ['Kaito 0.4.1 disponible'], 'cola persistida y deduplicada');
    writeUpdateState({notified: '0.4.0'});
    writeUpdateState({at: 1});
    eq(readUpdateState(), {notified: '0.4.0', at: 1}, 'update.json conserva la versión avisada');

    // 0.5.0: opcionales apagados por defecto; tablero sobre todos.json; panel de avisos.
    c = readConfig();
    eq([c.kanbanEnabled, c.inboxEnabled], [false, false], 'tablero y avisos apagados por defecto');
    updateConfig({kanbanEnabled: true, inboxEnabled: true});
    c = readConfig();
    eq([c.kanbanEnabled, c.inboxEnabled], [true, true], 'tablero y avisos activados');
    writeJson(TODOS_PATH, [{text: 'viejo', done: false}, {text: 'hecho', done: true}]);
    let b = readBoard();
    eq(b.map(t => [t.id, t.state, t.done]), [['K-1', 'todo', false], ['K-2', 'done', true]], 'readBoard migra todos.json');
    eq(readTodos().map(t => t.id), ['K-1', 'K-2'], 'migración escrita');
    eq(readJson(KANBAN_PATH, {}).seq, 2, 'contador persistido');
    const nt = addBoardTask({text: 'Nueva', priority: 'high'});
    eq([nt.id, nt.state, readTodos().length], ['K-3', 'todo', 3], 'addBoardTask');
    patchBoardTask('K-3', t => ({...t, state: 'doing', done: false}));
    eq(readBoard().find(t => t.id === 'K-3').state, 'doing', 'patchBoardTask');
    patchBoardTask('K-3', () => null);
    eq(readTodos().map(t => t.id), ['K-1', 'K-2'], 'borrar tarea');
    eq(addBoardTask({text: 'otra'}).id, 'K-4', 'no reutiliza K-3');
    // la lista antigua (tablero desactivado) marca como hecho: al volver, pasa a Hecho
    writeJson(TODOS_PATH, readTodos().map(t => (t.id === 'K-1' ? {...t, done: true} : t)));
    eq(readBoard().find(t => t.id === 'K-1').state, 'done', 'done de la lista antigua');
    writeInbox(inboxPush(inboxPush([], {id: 'a', kind: 'done', title: 'x'}), {id: 'a', kind: 'done', title: 'y'}));
    eq(readInbox().map(x => x.title), ['y'], 'inbox.json deduplicado');
    // tarea local mandada a Claude: prompt propio en lugar del de Jira
    const repo2 = GLib.dir_make_tmp('kaito-repo-XXXXXX');
    const task = {id: 'K-4', text: 'Arreglar login', description: 'El botón no responde'};
    let got2 = null;
    const r2 = sendIssueToClaude({issue: {key: task.id, summary: task.text}, base: '', description: null, repo: repo2,
        terminal: 'kgx', prompt: localTaskPrompt(task, repo2)}, o => (got2 = o), {has: x => x === 'kgx', ptyxisFlatpak: () => false, ptyxisVersion: () => null});
    eq(new TextDecoder().decode(GLib.file_get_contents(r2.promptPath)[1]), localTaskPrompt(task, repo2), 'prompt de tarea local');
    eq([r2.promptPath.endsWith('/K-4.txt'), got2.argv[0]], [true, 'kgx'], 'lanzado como un ticket');
} else {
    print('(sin XDG temporales: se omiten las pruebas de config 0.4)');
}

// URL de Jira escrita a medias en Ajustes
{
    const {normalizeJiraUrl: nj} = await import('./common.js');
    for (const [a, b] of [['gembiratech', 'https://gembiratech.atlassian.net'], [' gembiratech.atlassian.net/ ', 'https://gembiratech.atlassian.net'], ['https://x.atlassian.net/', 'https://x.atlassian.net'], ['', '']])
        if (nj(a) !== b) throw new Error(`normalizeJiraUrl(${a}) = ${nj(a)}`);
}

print(`kaito.test.js: ${n} comprobaciones OK`);
