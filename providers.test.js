// Ejecutar: node providers.test.js (o gjs -m providers.test.js). Rollouts de Codex sintéticos.
import {
    detectProviders, searchDirs, normalizeProviderToggles, matchAgentProcess, dedupeProcesses, parseRolloutMeta,
    parseCodexTail, codexStatus, rolloutId, LEVEL_TEXT, PROVIDERS,
} from './providers.js';

let n = 0;
function eq(a, b, msg) {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
    if (x !== y)
        throw new Error(`${msg}\n  esperado: ${y}\n  obtenido: ${x}`);
    n++;
}

// Detección con sondas falsas
const fake = {claude: '/h/.local/bin/claude', codex: '/h/.nvm/versions/node/v24/bin/codex'};
const det = detectProviders(b => fake[b] ?? null);
eq(det.filter(p => p.installed).map(p => [p.id, p.level, p.path]),
    [['claude', 'full', fake.claude], ['codex', 'sessions', fake.codex]], 'instalados');
eq(det.filter(p => !p.installed).map(p => p.id), ['gemini', 'opencode', 'aider', 'cursor'], 'no instalados');
eq(detectProviders(() => { throw new Error('x'); }).some(p => p.installed), false, 'sonda que falla');
eq(PROVIDERS.every(p => LEVEL_TEXT[p.level]), true, 'todos con texto de nivel');
eq(searchDirs('/h', '/usr/bin:/h/.local/bin::rel', ['/h/.nvm/versions/node/v24/bin']).slice(0, 6),
    ['/usr/bin', '/h/.local/bin', '/h/.npm-global/bin', '/h/.bun/bin', '/h/.opencode/bin', '/h/.cargo/bin'], 'carpetas sin repetir ni relativas');
eq(searchDirs('/h', '', ['/h/.nvm/x/bin']).includes('/h/.nvm/x/bin'), true, 'nvm incluido');
eq(normalizeProviderToggles({codex: false, raro: false}), {claude: true, codex: false, gemini: true, opencode: true, aider: true, cursor: true}, 'interruptores');
eq(normalizeProviderToggles(null).claude, true, 'por defecto todo activado');

// Procesos
eq(matchAgentProcess(['/h/.nvm/versions/node/v24/lib/node_modules/@openai/codex/vendor/x86_64/codex/codex'], 'codex'), 'codex', 'codex nativo');
eq(matchAgentProcess(['node', '/h/.nvm/versions/node/v24/bin/codex'], 'node'), 'codex', 'codex vía node');
eq(matchAgentProcess(['node', '--no-warnings', '/x/bin/codex.js', 'resume'], 'node'), 'codex', 'node con flags + resume');
eq(matchAgentProcess(['codex', 'app-server'], 'codex'), null, 'app-server no es sesión');
eq(matchAgentProcess(['codex', 'exec', 'haz algo'], 'codex'), null, 'exec no es sesión interactiva');
eq(matchAgentProcess(['codex', '--version'], 'codex'), null, '--version');
eq(matchAgentProcess(['codex', 'arregla el test'], 'codex'), 'codex', 'codex con prompt');
eq(matchAgentProcess(['/usr/bin/python3', '/h/.local/bin/aider', '--model', 'x'], 'python3'), 'aider', 'aider (python)');
eq(matchAgentProcess(['gemini'], 'node'), 'gemini', 'gemini');
eq(matchAgentProcess(['/h/.opencode/bin/opencode'], 'opencode'), 'opencode', 'opencode');
eq(matchAgentProcess(['opencode', 'serve'], 'opencode'), null, 'opencode serve');
eq(matchAgentProcess(['cursor-agent'], 'cursor-agent'), 'cursor', 'cursor-agent');
eq(matchAgentProcess(['claude'], 'claude'), null, 'claude se lee de su registro');
eq(matchAgentProcess(['vim', 'codex.md'], 'vim'), null, 'otro programa');
eq(matchAgentProcess(['node', '/x/server.js'], 'node'), null, 'node cualquiera');
eq(matchAgentProcess([], ''), null, 'vacío');
eq(dedupeProcesses([
    {pid: 10, ppid: 1, provider: 'codex'}, {pid: 11, ppid: 10, provider: 'codex'}, {pid: 20, ppid: 1, provider: 'codex'},
    {pid: 30, ppid: 11, provider: 'gemini'},
]).map(p => p.pid), [11, 20, 30], 'lanzador de node fuera; el hijo nativo queda');

// Rollouts sintéticos (formato de codex-cli 0.16x)
const iso = ms => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
const L = (t, type, payload) => JSON.stringify({timestamp: iso(t), type, payload});
const meta = L(T0, 'session_meta', {id: '01a1d46e-45e0-7080-ace5-3160f4268d49', cwd: '/h/repo', timestamp: iso(T0), base_instructions: 'x'.repeat(50)});
eq(parseRolloutMeta(`${meta}\n`), {id: '01a1d46e-45e0-7080-ace5-3160f4268d49', cwd: '/h/repo', startedMs: T0}, 'session_meta');
eq(parseRolloutMeta(meta.slice(0, meta.indexOf('base_instructions') + 30)).cwd, '/h/repo', 'session_meta cortada: cwd por regex');
eq(parseRolloutMeta('{"type":"event_msg"}\n'), null, 'sin session_meta');
eq(rolloutId('/h/.codex/sessions/2026/11/13/rollout-2026-11-13T11-22-39-01a1d46e-45e0-7080-ace5-3160f4268d49.jsonl'),
    '01a1d46e-45e0-7080-ace5-3160f4268d49', 'id del nombre del rollout');
eq(rolloutId('/x/otro.jsonl'), null, 'nombre ajeno');

const cmd = (t, c) => L(t, 'event_msg', {type: 'item_completed', item: {type: 'CommandExecution', command: ['/bin/bash', '-lc', c], aggregated_output: 'SECRETO'}});
const msg = (t, text) => L(t, 'event_msg', {type: 'item_completed', item: {type: 'AgentMessage', phase: 'commentary', content: [{type: 'Text', text}]}});
const started = t => L(t, 'event_msg', {type: 'task_started', turn_id: 't1', started_at: t / 1000});
const complete = (t, last) => L(t, 'event_msg', {type: 'task_complete', turn_id: 't1', last_agent_message: last});
const tokens = t => L(t, 'event_msg', {type: 'token_count', info: null, rate_limits: null});

const working = ['{"cortada', meta, started(T0 + 1000), msg(T0 + 2000, 'Voy a mirar los tests'), cmd(T0 + 3000, 'npm test -- --watch=false\necho segunda línea')].join('\n');
let tail = parseCodexTail(working);
eq([tail.turnOpen, tail.lastAction, tail.lastText, tail.lastStartMs, tail.lastEventMs],
    [true, '$ npm test -- --watch=false', null, T0 + 1000, T0 + 3000], 'turno abierto: última orden (1.ª línea)');
eq(JSON.stringify(tail).includes('SECRETO'), false, 'nunca la salida de los comandos');
eq(codexStatus({tail, mtimeMs: T0 + 3000, nowMs: T0 + 200 * 1000}), {live: true, state: 'working'}, 'trabajando aunque lleve 200 s sin escribir');
eq(codexStatus({tail, mtimeMs: T0 + 3000, nowMs: T0 + 3600 * 1000}), {live: false, state: 'idle'}, 'turno abierto pero parado 1 h: murió');

const longAnswer = `## Hecho\n${'Arreglé el fallo del login y añadí pruebas. '.repeat(10)}\nSegunda línea con detalles`;
const done = [meta, started(T0 + 1000), cmd(T0 + 2000, 'git diff'), msg(T0 + 3000, 'Listo'), complete(T0 + 4000, longAnswer), tokens(T0 + 4100)].join('\n');
tail = parseCodexTail(done);
eq([tail.turnOpen, tail.lastAction, tail.lastCompleteMs], [false, 'Listo', T0 + 4000], 'turno terminado');
eq([tail.lastText.length <= 160, tail.lastText.startsWith('Hecho'), tail.lastText.includes('Segunda')], [true, true, false],
    'lastText: primera línea, ≤ 160');
eq(codexStatus({tail, mtimeMs: T0 + 4100, nowMs: T0 + 5000}), {live: false, state: 'done'}, 'terminado aunque el rollout sea reciente');

const edits = [meta, started(T0), L(T0 + 1, 'event_msg', {type: 'item_completed', item: {type: 'FileChange', changes: {'/h/repo/a.js': {}, '/h/repo/b.js': {}}}})].join('\n');
eq(parseCodexTail(edits).lastAction, 'Edit 2 ficheros', 'FileChange');
// Formato antiguo: function_call / agent_message, sin task_started
const old = [L(T0, 'response_item', {type: 'function_call', name: 'shell', arguments: '{}'}), L(T0 + 1, 'event_msg', {type: 'agent_message', message: 'Revisando\nmás'})].join('\n');
tail = parseCodexTail(old);
eq([tail.lastAction, tail.turnOpen], ['Revisando', false], 'formato antiguo');
eq(codexStatus({tail, mtimeMs: T0, nowMs: T0 + 30 * 1000, liveS: 60}).state, 'working', 'sin turnos: por mtime (< liveS)');
eq(codexStatus({tail, mtimeMs: T0, nowMs: T0 + 90 * 1000, liveS: 60}).state, 'idle', 'sin turnos: por mtime (> liveS)');
eq(parseCodexTail(''), {lastAction: null, lastText: null, turnOpen: false, lastStartMs: null, lastCompleteMs: null, lastEventMs: null}, 'vacío');

// Hook de notify (estado "done" escrito por hooks/kaito-codex-notify.py)
tail = parseCodexTail(working);
eq(codexStatus({tail, mtimeMs: T0 + 3000, nowMs: T0 + 10000, hook: {state: 'done', ts: (T0 + 5000) / 1000}}).state, 'done',
    'hook posterior al inicio del turno: terminado');
eq(codexStatus({tail, mtimeMs: T0 + 3000, nowMs: T0 + 10000, hook: {state: 'done', ts: (T0 - 60000) / 1000}}).state, 'working',
    'hook de un turno anterior: no cuenta');

console.log(`providers.test.js: ${n} comprobaciones OK`);
