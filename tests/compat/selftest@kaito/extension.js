// Autoprueba de Kaito para tests/compat/run.sh: con kaito@runnea activo, abre el menú con datos falsos,
// el cuadro de captura (4 pestañas + revisión de Jira), tarjetas, una notificación con acciones, los
// modales de respuesta/comentario/resultado, la tarjeta fija, una recarga en caliente y un
// desactivar/activar. Cada paso escribe "SELFTEST ok <paso>" o "SELFTEST FAIL <paso>: <error>".
import GLib from 'gi://GLib';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

const UUID = 'kaito@runnea';
const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    r();
    return GLib.SOURCE_REMOVE;
}));
const loader = () => Main.extensionManager.lookup(UUID)?.stateObj;
const impl = () => loader()?._impl;

function walk(actor, fn) {
    fn(actor);
    for (const c of actor.get_children?.() ?? [])
        walk(c, fn);
}
function labels(actor) {
    const out = [];
    walk(actor, a => {
        if (a instanceof St.Label && a.text)
            out.push(a.text);
    });
    return out;
}

const NEEDS = {
    id: 'sess-needs', cwd: 'kaito', cwdPath: '/tmp', state: 'needs', live: true, age: 42, pid: null,
    message: '¿Permitir Bash: ls?', ticket: 'RUN-1', lastText: 'Voy a listar',
    hook: {kind: 'permission', tool: 'Bash', detail: 'ls -la /tmp', ts: Math.floor(Date.now() / 1000) - 42},
};
const AGENTS = [NEEDS, {
    id: 'sess-work', cwd: 'web', cwdPath: '/tmp', state: 'working', live: true, age: 5, pid: null,
    lastAction: 'Edit src/app.js',
}, {
    id: 'codex-0000', provider: 'codex', cwd: 'api', cwdPath: '/tmp', state: 'working', live: true, age: 3, pid: null,
    lastAction: '$ npm test', activityMs: Date.now(),
}, {
    id: 'gemini-pid1', provider: 'gemini', cwd: 'docs', cwdPath: '/tmp/docs', state: 'open', live: false, age: 60, pid: null,
}];
const CONFIG = () => GLib.build_filenamev([GLib.get_user_config_dir(), 'kaito', 'config.json']);
function patchConfig(patch) {
    let raw = {};
    try {
        raw = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(CONFIG())[1]));
    } catch (_e) { /* sin config */ }
    GLib.file_set_contents(CONFIG(), JSON.stringify({...raw, ...patch}));
}
const ISSUES = [
    {key: 'RUN-1', summary: 'Arreglar el login', status: 'Por hacer', category: 'new', priority: 'high'},
    {key: 'RUN-2', summary: 'Cupones FR', status: 'En curso', category: 'indeterminate', priority: 'low'},
];
const TASK = {id: 't1', name: 'Revisar ventas', key: 'RUN-1', cwd: '/tmp', enabled: true, lastOk: true, prompt: 'x'};
const RUN = {ok: true, summary: 'Todo bien', text: 'Ventas **estables**.\n\n```sql\nSELECT 1\n```', ts: new Date().toISOString()};

async function step(name, fn) {
    try {
        const r = await fn();
        console.log(`SELFTEST ok ${name}${r ? `: ${r}` : ''}`);
    } catch (e) {
        console.log(`SELFTEST FAIL ${name}: ${e}\n${e?.stack ?? ''}`);
    }
}

async function run() {
    // Al desactivar kaito, gnome-shell también desactiva y reactiva esta extensión: una sola pasada.
    if (globalThis.__kaitoSelftest)
        return;
    globalThis.__kaitoSelftest = true;
    for (let i = 0; i < 40 && !impl()?._indicator; i++)
        await wait(250);
    console.log(`SELFTEST start shell=${Config.PACKAGE_VERSION}`);
    const m = impl();
    const ind = m?._indicator;
    if (!ind) {
        const info = Main.extensionManager.lookup(UUID);
        console.log(`SELFTEST FAIL arranque: kaito sin indicador (state ${info?.state}, error ${info?.error})`);
        console.log('SELFTEST done');
        return;
    }
    await step('menu', async () => {
        ind._loadAgents = function () {
            this._agents = AGENTS;
            this._agentsError = null;
            this._counts.agents = AGENTS.length;
            this._byTicket = {};
        };
        ind._refresh = async function () {
            this.refreshLocal();
            this._jira = {issues: ISSUES, base: 'https://example.atlassian.net'};
            this._jiraLoaded = true;
            this._renderSection('jira');
            this._updateLabel();
        };
        ind.menu.open(false);
        await wait(800);
        const t = labels(ind.menu.box);
        for (const want of ['RUN-1', 'Arreglar el login', 'Te necesita', 'web', 'Revisar ventas', 'Codex', 'Gemini', 'api', 'abierto'])
            if (!t.includes(want))
                throw new Error(`falta «${want}» en el menú`);
        ind._toggleExpand?.(ISSUES[0]);
        await wait(300);
        ind.menu.close(false);
        return `${t.length} etiquetas`;
    });
    await step('pinned-card', async () => {
        ind._buildCard();
        await wait(300);
        const n = labels(ind._card).length;
        ind._destroyCard();
        return `${n} etiquetas`;
    });
    await step('capture', async () => {
        m.openCapture();
        const c = m._capture;
        if (!c.isOpen)
            throw new Error('no se abrió');
        for (const id of ['note', 'reminder', 'jira', 'task']) {
            c._setMode(id);
            await wait(150);
        }
        c._setMode('jira');
        Object.assign(c._jira, {stage: 'review', project: 'RUN', kind: 'Bug', priority: 'High', draft: {summary: 'Cupones FR', description: 'El chat *no* carga.\n- uno\n- dos'}});
        c._showReview();
        await wait(300);
        c._jiraBackToInput?.();
        c._setMode('note');
        c.close();
        return 'note/reminder/jira/task + revisión';
    });
    await step('reminder-cards', async () => {
        const r = m._reminders;
        r._addCard({id: 'r1', text: 'Llamar a Iker', due: new Date().toISOString()});
        r.showDaily(['3 tickets abiertos', '1 recordatorio hoy']);
        r.showTaskResult({id: 't1', name: TASK.name, ok: true, summary: RUN.summary, key: 'RUN-1', onView: () => {}, onComment: () => {}});
        r.showTaskResult({id: 't2', name: 'Otra', ok: false, summary: 'Falló', onView: () => {}});
        await wait(500);
        const n = r._box ? r._box.get_n_children() : 0;
        if (n < 3)
            throw new Error(`solo ${n} tarjetas`);
        return `${n} tarjetas`;
    });
    await step('notification', async () => {
        const n = ind._notify('kaito te necesita', '¿Permitir?', {activate: () => {}, actions: [['Responder', () => {}], ['Ir a la terminal', () => {}]]});
        await wait(500);
        n.destroy();
        return 'con 2 acciones';
    });
    await step('reply-modal', async () => {
        m.openReply(NEEDS);
        await wait(300);
        if (!m._reply._overlay)
            throw new Error('no se abrió');
        m._reply.close();
        m._closeModals();
        m._comment.open(NEEDS, 'Arreglar el login', 'Hallazgos de prueba'); // con texto: sin llamar a claude
        await wait(300);
        m._comment.close();
        m.openTaskResult(TASK, RUN);
        await wait(300);
        m._taskResult.close();
        return 'respuesta, comentario, resultado';
    });
    await step('jira-off', async () => {
        patchConfig({jiraEnabled: false});
        for (let i = 0; i < 20 && ind._cfg.jiraEnabled; i++)
            await wait(250);
        if (ind._cfg.jiraEnabled)
            throw new Error('el watcher de config no aplicó jiraEnabled=false');
        if (ind._headers.jira.visible || ind._jiraWrap.actor.visible || ind._seg.jira.seg.visible || ind._jiraTabsItem.visible)
            throw new Error('la sección o el segmento de Jira siguen visibles');
        m.openCapture();
        const tabs = Object.keys(m._capture._tabs);
        m._capture.close();
        if (tabs.includes('jira'))
            throw new Error(`la captura sigue con pestaña Jira: ${tabs}`);
        patchConfig({jiraEnabled: true});
        for (let i = 0; i < 20 && !ind._cfg.jiraEnabled; i++)
            await wait(250);
        if (!ind._headers.jira.visible || !ind._seg.jira.seg.visible)
            throw new Error('Jira no volvió al activarlo');
        return `captura: ${tabs.join('/')}`;
    });
    await step('quiet', async () => {
        for (let i = 0; i < 40 && m.quiet._first; i++)
            await wait(250); // la entrega de la cola espera 5 s tras arrancar
        m.quiet.set('on');
        await wait(300);
        if (!m.quiet.quiet || !ind._moon.visible || ind._panelBox.opacity === 255)
            throw new Error('sin luna o sin atenuar con No molestar');
        if (!ind._dnd.status.text.startsWith('No molestar'))
            throw new Error(`estado del menú: ${ind._dnd.status.text}`);
        const before = m._reminders._box ? m._reminders._box.get_n_children() : 0;
        m.showFinished({id: 'k1', agentId: 'sess-work', title: 'RUN-1 listo', meta: 'web · 5 min', lines: []});
        m._onTaskFinish(TASK, {ok: true, summary: 'ok'});
        ind._notifyDone(AGENTS[2], 4);
        ind._notifyDone(AGENTS[2], 5); // mismo agente: deduplicado
        const after = m._reminders._box ? m._reminders._box.get_n_children() : 0;
        if (after !== before)
            throw new Error('con No molestar se mostró una tarjeta');
        if (m.quiet.queue.length !== 3)
            throw new Error(`cola: ${m.quiet.queue.length} (esperaba 3)`);
        m.quiet.set('off');
        await wait(500);
        if (m.quiet.quiet || ind._moon.visible)
            throw new Error('No molestar no se desactivó');
        const card = m._reminders._cards.get('__quiet');
        if (!card)
            throw new Error('sin tarjeta «Mientras no estabas»');
        const t = labels(card);
        if (!t.includes('Mientras no estabas') || !t.some(x => x.includes('RUN-1 listo')))
            throw new Error(`tarjeta: ${t.join(' | ')}`);
        m._reminders._removeCard('__quiet');
        return `${t.length} etiquetas, cola vacía: ${m.quiet.queue.length === 0}`;
    });
    await step('update-notice', async () => {
        ind._syncUpdateBadge({pending: true});
        if (!ind._badge.visible || !ind.accessible_name.includes('actualización disponible'))
            throw new Error('sin punto de actualización');
        ind._onUpdateAvailable({latest: '9.9.9', behind: 2, changes: ['Uno', 'Dos']});
        await wait(300);
        const n = ind._source?.notifications?.length ?? 0;
        if (!ind._source)
            throw new Error('sin notificación');
        ind._onUpdateAvailable({latest: '9.9.9', behind: 2, changes: ['Uno', 'Dos']}); // misma versión: no repite
        await wait(200);
        const n2 = ind._source?.notifications?.length ?? 0;
        ind._syncUpdateBadge({pending: false});
        ind._source?.destroy();
        if (n2 > n)
            throw new Error('notificó dos veces la misma versión');
        if (ind._badge.visible)
            throw new Error('el punto no se quitó');
        return `${n} notificación`;
    });
    await step('moon-icon', async () => {
        const theme = new St.IconTheme();
        const names = ['weather-clear-night-symbolic', 'mail-unread-symbolic'];
        const missing = names.filter(name => !theme.lookup_icon(name, 16, 0));
        if (missing.length)
            throw new Error(`iconos ausentes: ${missing}`);
        return 'iconos del tema presentes';
    });
    await step('hot-reload', async () => {
        const before = impl();
        const path = GLib.build_filenamev([GLib.get_user_cache_dir(), 'kaito', 'reload']);
        GLib.file_set_contents(path, String(Date.now()));
        for (let i = 0; i < 40 && impl() === before; i++)
            await wait(250);
        await wait(1000);
        if (impl() === before || !impl()?._indicator)
            throw new Error('no se recargó');
        if (!Main.panel.statusArea[UUID])
            throw new Error('sin indicador tras recargar');
        return `build ${impl().loadId}`;
    });
    await step('disable-enable', async () => {
        Main.extensionManager.disableExtension(UUID);
        await wait(1000);
        Main.extensionManager.enableExtension(UUID);
        for (let i = 0; i < 40 && !impl()?._indicator; i++)
            await wait(250);
        if (!impl()?._indicator)
            throw new Error('no volvió');
        return `state ${Main.extensionManager.lookup(UUID).state}`;
    });
    console.log('SELFTEST done');
}

export default class Selftest extends Extension {
    enable() {
        this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._id = 0;
            run().catch(e => console.log(`SELFTEST FAIL run: ${e}\n${e?.stack}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._id)
            GLib.source_remove(this._id);
    }
}
