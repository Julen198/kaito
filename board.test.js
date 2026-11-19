// Ejecutar: node board.test.js (o gjs -m board.test.js). Tablero de tareas (board.js) y panel de avisos (inbox.js).
import {
    migrateTodos, newTask, withState, stepState, cyclePriority, todoState, boardColumns, boardCounts, matchesQuery,
    taskSlug, gitInstructions, localTaskPrompt, isLocalKey, maxKey,
} from './board.js';
import {
    inboxRoute, inboxPush, normalizeInbox, pruneInbox, unreadCount, markAllRead, resolveItem, groupInbox,
    pendingNeeds, initials, agoLabel, clampDndMinutes, INBOX_MAX, INBOX_MAX_AGE_MS,
} from './inbox.js';
import {ticketFromHead} from './agents.js';

let n = 0;
function eq(a, b, msg) {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
    if (x !== y)
        throw new Error(`${msg}\n  esperado: ${y}\n  obtenido: ${x}`);
    n++;
}
const NOW = 1_800_000_000_000;

// --- Migración de todos.json (compatible con la lista antigua {text, done}) ---
const old = [{text: 'uno', done: false}, {text: 'dos', done: true}, null, {text: 3}];
const m = migrateTodos(old, 0, NOW);
eq(m.changed, true, 'migración: cambia');
eq(m.todos.map(t => [t.id, t.state, t.done, t.priority]), [['K-1', 'todo', false, 'medium'], ['K-2', 'done', true, 'medium']], 'ids, estado y done');
eq(m.seq, 2, 'contador');
eq([m.todos[0].created, m.todos[0].updated], [NOW, NOW], 'fechas');
eq(old[0].id, undefined, 'no modifica la entrada');
const again = migrateTodos(m.todos, m.seq, NOW + 1);
eq(again.changed, false, 'idempotente');
// contador persistido: no reutiliza números borrados
eq(migrateTodos([{text: 'x', done: false}], 7, NOW).todos[0].id, 'K-8', 'usa el contador guardado');
eq(migrateTodos([{text: 'a', id: 'K-5', done: false}, {text: 'b'}], 0, NOW).todos.map(t => t.id), ['K-5', 'K-6'], 'continúa tras el mayor');
eq(migrateTodos([{text: 'a', id: 'K-5'}, {text: 'b', id: 'K-5'}], 0, NOW).todos.map(t => t.id), ['K-5', 'K-6'], 'id repetido');
// la lista antigua marcó como hecho un pendiente del tablero: manda `done`
const synced = migrateTodos([{...m.todos[0], state: 'doing', done: true}], 2, NOW);
eq([synced.todos[0].state, synced.todos[0].done, synced.changed], ['done', true, true], 'done de la lista antigua gana');
eq(migrateTodos([{...m.todos[0], state: 'done', done: false}], 2, NOW).todos[0].state, 'todo', 'done=false con estado hecho');
eq(migrateTodos([{text: 'z', state: 'review', id: 'K-1'}], 0, NOW).todos[0].done, false, 'sin done: lo pone según estado');
eq(todoState({done: true}), 'done', 'estado deducido');
eq(todoState({state: 'rara', done: false}), 'todo', 'estado inválido');
eq(maxKey([{id: 'K-3'}, {id: 'RUN-9'}, {id: 'K-12'}]), 12, 'maxKey');
eq([isLocalKey('K-1'), isLocalKey('K-'), isLocalKey('RUN-1'), isLocalKey('k-1')], [true, false, false, false], 'isLocalKey');

// --- Tareas nuevas y estado ---
const nt = newTask(m.todos, m.seq, {text: '  Exportar informe  ', priority: 'high', repo: '/r/stats'}, NOW);
eq([nt.task.id, nt.task.text, nt.task.state, nt.task.done, nt.task.priority, nt.seq], ['K-3', 'Exportar informe', 'todo', false, 'high', 3], 'newTask');
eq(newTask([], 0, {text: 'x', priority: 'rara'}, NOW).task.priority, 'medium', 'prioridad inválida');
const moved = withState(nt.task, 'done', NOW + 5);
eq([moved.state, moved.done, moved.updated, nt.task.state], ['done', true, NOW + 5, 'todo'], 'withState sincroniza done');
eq([stepState('todo', 1), stepState('doing', -1), stepState('done', 1), stepState('todo', -1)], ['doing', 'todo', null, null], 'stepState');
eq([cyclePriority('highest'), cyclePriority('low'), cyclePriority(undefined)], ['high', 'highest', 'medium'], 'cyclePriority (inválida: media)');

// --- Filtro y columnas ---
const T = [
    {id: 'K-1', text: 'Revisar PR de checkout', repo: '/h/mp_www', priority: 'high', state: 'todo', updated: 1},
    {id: 'K-2', text: 'Llamar a proveedor', repo: null, priority: 'medium', state: 'todo', updated: 5},
    {id: 'K-3', text: 'Script caché', repo: '/h/runnea-api', priority: 'highest', state: 'todo', updated: 2},
    {id: 'K-4', text: 'Informe de ventas', description: 'BigQuery semanal', repo: '/h/stats', priority: 'low', state: 'doing', updated: 3},
    {id: 'K-5', text: 'Viejo', priority: 'low', state: 'done', done: true, updated: NOW - 8 * 86400000},
    {id: 'K-6', text: 'Reciente', priority: 'low', state: 'done', done: true, updated: NOW - 3600000},
];
let cols = boardColumns(T);
eq(cols.todo.map(t => t.id), ['K-3', 'K-1', 'K-2'], 'orden por prioridad');
eq(cols.done.map(t => t.id), ['K-6', 'K-5'], 'hechas: la más reciente primero');
eq([cols.doing.length, cols.review.length], [1, 0], 'columnas');
cols = boardColumns(T, 'mp_www');
eq(cols.todo.map(t => t.id), ['K-1'], 'filtro por repo');
eq(boardColumns(T, 'bigquery').doing.map(t => t.id), ['K-4'], 'filtro por descripción');
eq(boardColumns(T, 'cache').todo.map(t => t.id), ['K-3'], 'sin acentos');
eq(boardColumns(T, 'k-2').todo.map(t => t.id), ['K-2'], 'por id');
eq(matchesQuery(T[0], 'revisar checkout'), true, 'varias palabras');
eq(matchesQuery(T[0], 'revisar ventas'), false, 'todas las palabras');
eq(boardCounts(T, NOW), {open: 4, doneWeek: 1}, 'contadores');

// --- Prompt de una tarea local ---
eq(taskSlug('Exportar informe de ventas semanal (v2)!'), 'exportar-informe-de-ventas-semanal-v2', 'slug');
eq(taskSlug('Ñandú  áé'), 'nandu-ae', 'slug sin acentos');
eq(taskSlug('???'), 'tarea', 'slug vacío');
eq(taskSlug('a'.repeat(60)).length, 40, 'slug máx.');
const task = {id: 'K-12', text: 'Exportar informe de ventas', description: 'Sacar de BigQuery.\nDejar CSV.'};
const pr = localTaskPrompt(task, '/home/u/stats-dashboard', 'main');
eq(pr.split('\n').slice(0, 4), ['Trabaja en la tarea K-12: Exportar informe de ventas', 'Sacar de BigQuery.', 'Dejar CSV.',
    'Repo de trabajo: stats-dashboard (/home/u/stats-dashboard), rama main'], 'prompt: cabecera');
eq(pr.endsWith(gitInstructions('K-12', 'K-12-exportar-informe-de-ventas')), true, 'prompt: párrafo de Git');
eq(pr.includes('crea una llamada K-12-exportar-informe-de-ventas') && pr.includes('empiecen por "K-12: "'), true, 'rama y commits');
eq(localTaskPrompt({id: 'K-1', text: 'x'}).includes('poco detalle'), true, 'sin descripción: avisa');
eq(gitInstructions('RUN-123', 'RUN-123-<resumen-corto>').startsWith('Git: trabaja en una rama propia (si estás en main, master o develop, crea una llamada RUN-123-<resumen-corto>). '), true, 'mismo párrafo que Jira');
// El agente lanzado con la tarea queda vinculado a K-<n> (agents.js)
const head = c => JSON.stringify({type: 'user', message: {content: c}});
eq(ticketFromHead(head(pr)), 'K-12', 'ticketFromHead acepta K-<n>');
eq(ticketFromHead(head('Trabaja en el ticket de Jira RUN-7: y')), 'RUN-7', 'y sigue aceptando Jira');
eq(ticketFromHead(head('Trabaja en la tareaK-1')), null, 'otra cosa');

// --- Panel de avisos: niveles por modo ---
const WORK = {quiet: false, reason: null};
const DND = {quiet: true, reason: 'manual'};
const OFF = {quiet: true, reason: 'schedule'};
const route = q => ['needs', 'reminder', 'done', 'finished', 'task', 'update', 'raro'].map(k => inboxRoute(k, q));
eq(route(WORK), ['interrupt', 'interrupt', 'brief', 'brief', 'brief', 'panel', 'none'], 'trabajando');
eq(route(DND), ['interrupt', 'interrupt', 'panel', 'panel', 'panel', 'panel', 'none'], 'No molestar manual: solo te necesita interrumpe');
eq(route(OFF), ['panel', 'interrupt', 'panel', 'panel', 'panel', 'panel', 'none'], 'fuera de horario: todo al panel');
eq(inboxRoute('needs', null), 'interrupt', 'sin estado');

// --- Almacén: dedupe, poda, tope ---
let box = [];
box = inboxPush(box, {id: 'a', kind: 'needs', agentId: 's1', title: 'Te necesita', body: '¿Permitir?'}, NOW);
box = inboxPush(box, {id: 'b', kind: 'done', agentId: 's2', title: 'Terminó', actions: [{label: 'Ir al agente', action: {type: 'agent', id: 's2'}}, {label: 'x'}]}, NOW + 1000);
eq(box.map(x => x.id), ['b', 'a'], 'nuevo primero');
eq(box[0].actions, [{label: 'Ir al agente', action: {type: 'agent', id: 's2'}}], 'acciones saneadas');
eq(unreadCount(box), 2, 'no leídos');
box = markAllRead(box);
eq(unreadCount(box), 0, 'leídos al abrir');
box = resolveItem(box, 'a', 'Permitido · sigue trabajando');
eq([box[1].resolved, pendingNeeds(box)], ['Permitido · sigue trabajando', false], 'resuelto');
box = inboxPush(box, {id: 'a', kind: 'needs', agentId: 's1', title: 'Te necesita otra vez'}, NOW + 2000);
eq([box.length, box[0].id, box[0].read, box[0].resolved, pendingNeeds(box)], [2, 'a', false, null, true], 'mismo id: sustituye y vuelve arriba');
eq(inboxPush(box, {kind: 'done', title: 'sin id'}, NOW).length, 2, 'sin id: se ignora');
// poda > 7 días y tope de 100
const many = Array.from({length: 130}, (_, i) => ({id: `x${i}`, kind: 'done', title: `t${i}`, ts: NOW - i * 1000}));
eq(normalizeInbox(many, NOW).length, INBOX_MAX, 'tope');
eq(normalizeInbox(many, NOW)[0].id, 'x0', 'se quedan los nuevos');
eq(pruneInbox([{id: 'v', ts: NOW - INBOX_MAX_AGE_MS - 1}, {id: 'w', ts: NOW - 1000}], NOW).map(x => x.id), ['w'], 'poda > 7 días');
eq(normalizeInbox([{id: 'd', title: 'viejo', ts: NOW - 5000}, {id: 'd', title: 'nuevo', ts: NOW - 10}, {id: 'e'}, 'basura'], NOW).map(x => x.title), ['nuevo'], 'dedupe al leer');
eq(normalizeInbox(null, NOW), [], 'nada');

// --- Grupos ---
const g = groupInbox([
    {id: '1', kind: 'done', agentId: 's1', title: 'a', ts: 10},
    {id: '2', kind: 'needs', agentId: 's1', title: 'b', ts: 30},
    {id: '3', kind: 'update', title: 'c', ts: 20},
    {id: '4', kind: 'reminder', title: 'd', ts: 5},
]);
eq(g.map(x => [x.key, x.items.map(i => i.id)]), [['agent:s1', ['2', '1']], ['kaito', ['3']], ['reminders', ['4']]], 'agrupado por agente o fuente');
eq([initials('kaito'), initials('mp_kontan'), initials('stats-dashboard'), initials('')], ['KA', 'MK', 'SD', '?'], 'iniciales');
eq([agoLabel(NOW - 5000, NOW), agoLabel(NOW - 6 * 60000, NOW), agoLabel(NOW - 2 * 3600000, NOW), agoLabel(NOW - 3 * 86400000, NOW)],
    ['ahora', 'hace 6 min', 'hace 2 h', 'hace 3 d'], 'hace…');
eq([clampDndMinutes(0), clampDndMinutes(5), clampDndMinutes(400), clampDndMinutes(44)], [30, 15, 240, 45], 'minutos de No molestar');

console.log(`board.test.js: ${n} comprobaciones OK`);
