// Ejecutar: XDG_CONFIG_HOME=$(mktemp -d) XDG_DATA_HOME=$(mktemp -d) gjs -m tasks.test.js
// (no llama a Claude, a Jira ni a BigQuery; sin XDG_* en /tmp se saltan las pruebas de disco)
import GLib from 'gi://GLib';

import {
    taskArgv, bqMcpConfig, parseStream, parseSummary, stripSummaryLine, findingsComment, extractKey, suggestTools, taskName, resolveCwd, newTask,
    dueTasks, afterRun, setEnabled, toPrune, runFileName, ticketBlock, buildTaskPrompt, TaskScheduler,
    BQ_READ_TOOLS, SELECT_GUARD, TASK_SYSTEM, REVIEW_INSTRUCTION, TICKET_MAX,
    readTasks, addTask, patchTask, deleteTask, writeRun, listRuns, readLastRun,
} from './tasks.js';
import {TASKS_PATH, TASK_RUNS_DIR, formatIssueDetail, defaultRepoRoots} from './common.js';

let n = 0;
function eq(a, b, msg) {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
    if (x !== y)
        throw new Error(`${msg}\n  esperado: ${y}\n  obtenido: ${x}`);
    n++;
}
const ok = (c, msg) => eq(!!c, true, msg);
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

// --- argv por política ---
const ro = taskArgv('/x/claude', 'readonly');
eq(ro.slice(0, 2), ['/x/claude', '-p'], 'argv: -p');
eq(after(ro, '--output-format'), 'stream-json', 'argv: stream-json');
ok(ro.includes('--verbose'), 'argv: --verbose (obligatorio con stream-json)');
eq(after(ro, '--model'), 'sonnet', 'argv: sonnet');
eq(after(ro, '--tools'), 'Read,Glob,Grep', 'argv ro: solo herramientas de lectura');
eq(after(ro, '--permission-mode'), 'dontAsk', 'argv ro: dontAsk');
eq(after(ro, '--permission-prompts'), 'none', 'argv ro: sin preguntas');
ok(ro.includes('--safe-mode') && ro.includes('--strict-mcp-config') && ro.includes('--no-session-persistence'), 'argv ro: aislado');
ok(!ro.includes('--mcp-config') && !ro.includes('--allowedTools'), 'argv ro: sin MCP ni allowedTools');
eq(ro.slice(ro.indexOf('--disallowedTools') + 1, ro.indexOf('--disallowedTools') + 7),
    ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'], 'argv ro: denegadas');
eq(after(ro, '--append-system-prompt'), TASK_SYSTEM, 'argv ro: system');

const bq = taskArgv('/x/claude', 'readonly+bq', '/run/user/1000/kaito/mcp-x.json');
ok(!bq.includes('--safe-mode'), 'argv bq: sin --safe-mode (ignoraría --mcp-config)');
eq(after(bq, '--setting-sources'), '', 'argv bq: sin settings de usuario (hooks, plugins, permisos)');
eq(after(bq, '--mcp-config'), '/run/user/1000/kaito/mcp-x.json', 'argv bq: mcp-config');
ok(bq.includes('--strict-mcp-config'), 'argv bq: strict');
eq(bq.slice(bq.indexOf('--allowedTools') + 1, bq.indexOf('--allowedTools') + 1 + BQ_READ_TOOLS.length), BQ_READ_TOOLS, 'argv bq: solo lectura BQ');
eq(BQ_READ_TOOLS, ['mcp__bigquery__list_dataset_ids', 'mcp__bigquery__list_table_ids', 'mcp__bigquery__get_dataset_info',
    'mcp__bigquery__get_table_info', 'mcp__bigquery__search_catalog', 'mcp__bigquery__execute_sql'], 'BQ tools');
ok(after(bq, '--append-system-prompt').endsWith(SELECT_GUARD), 'argv bq: guarda SELECT');
eq(after(bq, '--tools'), 'Read,Glob,Grep', 'argv bq: built-in de lectura');
let threw = false;
try {
    taskArgv('/x/claude', 'readonly+bq');
} catch (_e) {
    threw = true;
}
ok(threw, 'argv bq sin config lanza');

// --- config MCP de BigQuery ---
const cj = {mcpServers: {bigquery: {type: 'stdio', command: 'npx', args: ['-y', 'x'], env: {BIGQUERY_PROJECT: 'p'}}, neon: {type: 'http'}},
    projects: {'/r': {mcpServers: {bigquery: {command: 'local'}}}}};
eq(bqMcpConfig(cj, '/home'), {mcpServers: {bigquery: {type: 'stdio', command: 'npx', args: ['-y', 'x'],
    env: {BIGQUERY_PROJECT: 'p', BIGQUERY_WRITE_MODE: 'blocked'}}}}, 'mcp: solo bigquery, write mode blocked');
eq(bqMcpConfig(cj, '/r').mcpServers.bigquery.command, 'local', 'mcp: ámbito local primero');
eq(bqMcpConfig({mcpServers: {}}, '/'), null, 'mcp: sin servidor');
eq(bqMcpConfig(null, '/'), null, 'mcp: sin ~/.claude.json');

// --- salida stream-json ---
const stream = [
    JSON.stringify({type: 'system', subtype: 'init', tools: ['Glob', 'Grep', 'Read']}),
    JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text: 'voy'},
        {type: 'tool_use', name: 'mcp__bigquery__execute_sql', input: {sql: ' SELECT 1 '}}]}}),
    JSON.stringify({type: 'assistant', message: {content: [{type: 'tool_use', name: 'mcp__bigquery__list_table_ids', input: {}}]}}),
    'basura no json',
    JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'RESUMEN: todo bien\n\nDetalle', total_cost_usd: 0.01,
        permission_denials: [{tool_name: 'Write'}]}),
].join('\n');
const ps = parseStream(stream);
eq([ps.ok, ps.result, ps.queries, ps.denials, ps.tools, ps.cost], [true, 'RESUMEN: todo bien\n\nDetalle', ['SELECT 1'], ['Write'],
    ['Glob', 'Grep', 'Read'], 0.01], 'parseStream');
eq(parseStream(JSON.stringify({type: 'result', subtype: 'error_max_turns', is_error: true, result: ''})).ok, false, 'parseStream: error');
eq(parseStream('').error, 'Claude no devolvió nada', 'parseStream: vacío');
eq(parseStream(JSON.stringify({result: 'RESUMEN: x', is_error: false})).ok, true, 'parseStream: sobre json');

// --- resumen ---
eq(parseSummary('RESUMEN: Las ventas bajan en 2 tiendas\n\nDetalle'), 'Las ventas bajan en 2 tiendas', 'resumen');
eq(parseSummary('**RESUMEN:** Todo correcto.\nmás'), 'Todo correcto.', 'resumen en negrita');
eq(parseSummary('Intro\nresumen: abajo'), 'abajo', 'resumen en otra línea');
eq(parseSummary('## Informe\nsin marca'), 'Informe', 'resumen: primera línea');
eq(parseSummary(''), '', 'resumen vacío');
eq(stripSummaryLine('RESUMEN: x\n\nDetalle\n- a'), 'Detalle\n- a', 'sin línea de resumen');
eq(stripSummaryLine('Intro\n**RESUMEN:** x\nfin'), 'Intro\nfin', 'sin resumen en medio');
eq(findingsComment({name: 'Rev'}, {summary: 'Todo bien', result: 'RESUMEN: Todo bien\n\nDetalle'}),
    '## Revisión programada (Kaito): Rev\n\nTodo bien\n\n## Detalle\nDetalle', 'comentario con hallazgos');

// --- texto → tarea ---
eq(extractKey('mañana a las 10 revisa RUN-12326 que las carreras'), 'RUN-12326', 'clave');
eq(extractKey('revisa run-1'), null, 'clave en minúsculas no');
eq(suggestTools('revisa en BigQuery las ventas'), 'readonly+bq', 'herramientas: bigquery');
eq(suggestTools('mira la tabla de pedidos'), 'readonly+bq', 'herramientas: tabla');
eq(suggestTools('cuenta las filas del CSV'), 'readonly', 'herramientas: lectura');
eq(suggestTools('revisa RUN-1 que los datos cuadran', true), 'readonly+bq', 'herramientas: ticket + datos');
eq(suggestTools('revisa RUN-1 que los datos cuadran'), 'readonly', 'herramientas: datos sin ticket');
eq(taskName('revisa en BigQuery las ventas de la semana pasada'), 'Revisa en BigQuery las ventas de…', 'nombre');
eq(taskName('mira logs'), 'Mira logs', 'nombre corto');
eq(taskName(''), 'Tarea', 'nombre vacío');
const cfg = {jiraRepoByIssue: {'RUN-5': '/h/issue'}, jiraRepoByProject: {RUN: '/h/proj', WEB: '/h/gone'}};
eq(resolveCwd('RUN-5', cfg, '/h'), '/h/issue', 'cwd: repo del ticket');
eq(resolveCwd('RUN-6', cfg, '/h'), '/h/proj', 'cwd: repo del proyecto');
eq(resolveCwd('WEB-1', cfg, '/h', p => p !== '/h/gone'), '/h', 'cwd: inexistente → home');
eq(resolveCwd(null, cfg, '/h'), '/h', 'cwd: sin ticket');
eq(defaultRepoRoots('/h', p => ['/h/dev', '/h/Documents'].includes(p)), ['/h/Documents', '/h/dev'], 'repoRoots: los que existen');
eq(defaultRepoRoots('/h', () => false), ['/h/Documentos'], 'repoRoots: ninguno');

// --- calendario: alta, vencidas, recuperación ---
const t0 = new Date(2026, 10, 16, 8, 0); // lunes 08:00
const weekly = newTask({name: 'Ventas', prompt: 'p', cwd: '~', rule: {kind: 'weekly', days: [1], hour: 9, minute: 0}, tools: 'x'}, t0);
eq([weekly.tools, weekly.enabled, weekly.done, weekly.nextRun], ['readonly', true, false, new Date(2026, 10, 16, 9, 0).toISOString()], 'newTask');
ok(/^[a-z0-9]+$/.test(weekly.id), 'newTask: id');
eq(dueTasks([weekly], new Date(2026, 10, 16, 8, 59)).length, 0, 'due: aún no');
eq(dueTasks([weekly], new Date(2026, 10, 16, 9, 0)).length, 1, 'due: a la hora');
eq(dueTasks([{...weekly, enabled: false}], new Date(2026, 11, 1)).length, 0, 'due: pausada');
// Sesión cerrada tres semanas: al volver se ejecuta UNA vez y la próxima es el lunes siguiente.
const back = new Date(2026, 11, 9, 10, 0); // miércoles 9 dic
eq(dueTasks([weekly], back).length, 1, 'catch-up: una sola vez');
const done = afterRun(weekly, {finished: new Date(back.getTime() + 60000), ok: true, summary: 's'});
eq([done.nextRun, done.lastOk, done.lastSummary], [new Date(2026, 11, 14, 9, 0).toISOString(), true, 's'], 'catch-up: siguiente lunes');
eq(dueTasks([done], new Date(2026, 11, 9, 10, 5)).length, 0, 'catch-up: no se repite');
// Manual antes de la hora: no mueve la próxima.
eq(afterRun(weekly, {finished: t0, ok: false, manual: true}).nextRun, weekly.nextRun, 'manual: conserva la próxima');
// Una vez: queda hecha.
const once = newTask({name: 'Rev', prompt: 'p', cwd: '~', rule: {kind: 'once', at: new Date(2026, 10, 17, 10).toISOString()}, key: 'RUN-1'}, t0);
const onceDone = afterRun(once, {finished: new Date(2026, 10, 17, 10, 3), ok: true});
eq([onceDone.done, onceDone.nextRun, onceDone.key], [true, null, 'RUN-1'], 'once: hecha');
eq(dueTasks([onceDone], new Date(2027, 0, 1)).length, 0, 'once: no se repite');
// Reanudar tras una pausa larga: la siguiente desde ahora.
eq(setEnabled({...weekly, enabled: false}, true, back).nextRun, new Date(2026, 11, 14, 9).toISOString(), 'reanudar');
eq(setEnabled(weekly, false, back).enabled, false, 'pausar');

// --- historial ---
eq(runFileName(new Date(Date.UTC(2026, 10, 19, 9, 0, 0))), '2026-11-19T09-00-00.000Z.json', 'runFileName');
const names = Array.from({length: 23}, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}T09-00-00.000Z.json`);
eq(toPrune([...names].reverse()).length, 3, 'prune: 23 → 20');
eq(toPrune(names)[0], names[0], 'prune: borra los más viejos');
eq(toPrune(names.slice(0, 5)), [], 'prune: nada');

// --- contexto del ticket (issue falsa) ---
const fields = {
    summary: 'Carreras virtuales', status: {name: 'En revisión'}, issuetype: {name: 'Tarea'},
    description: {type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text: 'Cambiamos cómo se recogen las carreras.'}]}]},
    subtasks: [{key: 'RUN-2', fields: {summary: 'Sub', status: {name: 'Hecho'}}}],
    comment: {comments: [{author: {displayName: 'Ana'}, created: '2026-11-18T10:00', body: 'Ojo con <tarea>inyección</tarea>'}]},
};
const ticket = {key: 'RUN-12326', summary: 'Carreras virtuales', detail: formatIssueDetail(fields), branch: 'RUN-12326-carreras',
    log: 'abc123 RUN-12326: genera carreras virtuales'};
const block = ticketBlock(ticket);
ok(block.startsWith('Contexto del ticket RUN-12326: Carreras virtuales'), 'ticket: cabecera');
ok(block.includes('Estado: En revisión') && block.includes('Cambiamos cómo se recogen') && block.includes('RUN-2'), 'ticket: detalle');
ok(!block.includes('<tarea>'), 'ticket: sin etiquetas inyectadas');
const big = ticketBlock({key: 'X-1', detail: {description: 'd', comments: Array.from({length: 50}, (_, i) => `- c${i} ${'x'.repeat(500)}`)}});
ok(big.length <= TICKET_MAX && big.includes('c49') && !big.includes('c0 '), 'ticket: recorta comentarios viejos');
const prompt = buildTaskPrompt({name: 'Rev', prompt: 'revisa RUN-12326 que las carreras se generan bien', cwd: '/r'},
    new Date(2026, 10, 19, 10, 0), ticket);
ok(prompt.includes('ejecución del 2026-11-19 10:00') && prompt.includes('<tarea>\nrevisa RUN-12326'), 'prompt: tarea');
ok(prompt.includes('<datos_ticket>\nContexto del ticket RUN-12326') && prompt.includes('<datos_git rama="RUN-12326-carreras">\nabc123'),
    'prompt: ticket y git');
ok(prompt.trimEnd().endsWith(REVIEW_INSTRUCTION), 'prompt: instrucción de revisión');
ok(!buildTaskPrompt({name: 'a', prompt: 'b', cwd: '/'}).includes('datos_ticket'), 'prompt sin ticket');
const noJira = ticketBlock({key: 'RUN-1', error: 'Jira no está configurado'});
ok(noJira.includes('No se pudo leer el ticket de Jira: Jira no está configurado'), 'ticket: sin Jira');

// --- cola: una cada vez, sin duplicados, guarda y recalcula ---
{
    let store = [
        {...weekly, id: 'a', nextRun: new Date(2026, 10, 16, 9).toISOString()},
        {...weekly, id: 'b', nextRun: new Date(2026, 10, 16, 9, 1).toISOString()},
        {...weekly, id: 'c', nextRun: new Date(2026, 10, 30, 9).toISOString()},
    ];
    const clock = new Date(2026, 10, 16, 9, 30);
    const log = [], records = [], finished = [];
    let active = 0, maxActive = 0;
    const resolvers = [];
    const sched = new TaskScheduler({
        now: () => clock,
        load: () => store,
        save: (id, fn) => {
            store = store.map(t => (t.id === id ? fn(t) : t));
            return store.find(t => t.id === id);
        },
        record: (id, run) => records.push([id, run.ok]),
        run: task => new Promise(resolve => {
            active++;
            maxActive = Math.max(maxActive, active);
            log.push(task.id);
            resolvers.push(() => {
                active--;
                resolve({started: clock.toISOString(), finished: clock.toISOString(), ok: task.id === 'a', summary: task.id,
                    result: '', queries: []});
            });
        }),
        onFinish: (t, r) => finished.push([t.id, r.ok, t.nextRun]),
    });
    eq(sched.tick(), ['a', 'b'], 'cola: encola las vencidas');
    eq(sched.tick(), [], 'cola: sin duplicados');
    eq(sched.runNow('a'), false, 'cola: ya pendiente');
    eq(sched.runningId, 'a', 'cola: ejecutando a');
    const flush = async () => {
        for (let i = 0; i < 5; i++)
            await Promise.resolve();
    };
    await flush();
    eq(log, ['a'], 'cola: una cada vez');
    resolvers.shift()();
    await flush();
    eq(log, ['a', 'b'], 'cola: luego b');
    resolvers.shift()();
    await sched.whenIdle();
    eq(maxActive, 1, 'cola: nunca dos a la vez');
    eq(records, [['a', true], ['b', false]], 'cola: historial');
    eq(finished.map(f => [f[0], f[1], f[2]]), [['a', true, new Date(2026, 10, 23, 9).toISOString()],
        ['b', false, new Date(2026, 10, 23, 9).toISOString()]], 'cola: próxima recalculada (también si falla)');
    eq(sched.tick(), [], 'cola: nada más pendiente');
    // Manual: se ejecuta aunque no toque y no mueve la próxima.
    eq(sched.runNow('c'), true, 'manual: encola');
    await flush();
    resolvers.shift()();
    await sched.whenIdle();
    eq(store.find(t => t.id === 'c').nextRun, new Date(2026, 10, 30, 9).toISOString(), 'manual: próxima intacta');
    // destroy durante una ejecución: no se guarda nada (se repetirá al volver).
    store = store.map(t => (t.id === 'a' ? {...t, nextRun: clock.toISOString()} : t));
    sched.tick();
    sched.destroy();
    resolvers.shift()();
    await sched.whenIdle();
    eq(records.length, 3, 'destroy: sin historial');
    eq(store.find(t => t.id === 'a').nextRun, clock.toISOString(), 'destroy: nextRun intacto');
}

// --- disco (solo con XDG_* temporales) ---
if (TASKS_PATH.startsWith('/tmp/') && TASK_RUNS_DIR.startsWith('/tmp/')) {
    const t = newTask({name: 'n', prompt: 'p', cwd: '~', rule: {kind: 'hourly'}}, new Date());
    addTask(t);
    eq(readTasks().map(x => x.id), [t.id], 'disco: alta');
    patchTask(t.id, x => ({...x, enabled: false}));
    eq(readTasks()[0].enabled, false, 'disco: patch');
    for (let i = 0; i < 23; i++)
        writeRun(t.id, {started: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), ok: i % 2 === 0, summary: `r${i}`});
    eq(listRuns(t.id).length, 20, 'disco: se quedan 20');
    eq(readLastRun(t.id).summary, 'r22', 'disco: última');
    deleteTask(t.id);
    eq([readTasks().length, listRuns(t.id).length, GLib.file_test(`${TASK_RUNS_DIR}/${t.id}`, GLib.FileTest.EXISTS)],
        [0, 0, false], 'disco: borrar con historial');
    let bad = false;
    try {
        writeRun('../x', {started: new Date().toISOString()});
    } catch (_e) {
        bad = true;
    }
    ok(bad, 'disco: id con ruta rechazado');
} else {
    print('tasks.test.js: pruebas de disco saltadas (usa XDG_CONFIG_HOME/XDG_DATA_HOME en /tmp)');
}

print(`tasks.test.js: ${n} OK`);
