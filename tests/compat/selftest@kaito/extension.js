// Autoprueba de Kaito para tests/compat/run.sh: con kaito@runnea activo, abre el menú con datos falsos,
// (0.5.0) los anillos de uso con datos falsos, el tablero de tareas y el panel de avisos opcionales (activados y vueltos a desactivar),
// el cuadro de captura (4 pestañas + revisión de Jira), tarjetas, una notificación con acciones, los
// modales de respuesta/comentario/resultado, la tarjeta fija, una recarga en caliente y un
// desactivar/activar. Cada paso escribe "SELFTEST ok <paso>" o "SELFTEST FAIL <paso>: <error>".
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
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
        else if (a instanceof St.Button && a.label) // la etiqueta del botón no siempre es un hijo visible al recorrer
            out.push(a.label);
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
const CACHE = () => GLib.build_filenamev([GLib.get_user_cache_dir(), 'kaito']);
const readJsonFile = (path, fb) => {
    try {
        return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(path)[1]));
    } catch (_e) {
        return fb;
    }
};
const todos = () => readJsonFile(GLib.build_filenamev([GLib.get_user_config_dir(), 'kaito', 'todos.json']), []);
const inbox = () => readJsonFile(GLib.build_filenamev([CACHE(), 'inbox.json']), []);
async function until(fn, ms = 6000) {
    for (let i = 0; i < ms / 100 && !fn(); i++)
        await wait(100);
    return fn();
}
function findButton(actor, pred) {
    let found = null;
    walk(actor, a => {
        if (!found && a instanceof St.Button && pred(a))
            found = a;
    });
    return found;
}
function sh(argv, cwd) {
    const [ok, , err, status] = GLib.spawn_sync(cwd, argv, null, GLib.SpawnFlags.SEARCH_PATH, null);
    if (!ok || status !== 0)
        throw new Error(`${argv.join(' ')}: ${new TextDecoder().decode(err)}`);
}
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

// KAITO_SHOT=/ruta.png: captura el escritorio (con el menú abierto) para revisarlo a ojo.
async function screenshot(suffix = '') {
    let path = GLib.getenv('KAITO_SHOT');
    if (!path)
        return;
    if (suffix)
        path = path.replace(/(\.png)?$/, `-${suffix}.png`);
    try {
        Gio._promisify(Shell.Screenshot.prototype, 'screenshot');
        const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
        await new Shell.Screenshot().screenshot(false, stream);
        stream.close(null);
        console.log(`SELFTEST ok screenshot: ${path}`);
    } catch (e) {
        console.log(`SELFTEST info screenshot falló: ${e}`);
    }
}

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
    // KAITO_COMPAT_FEATURES=on (in-container.sh): arranca con tablero y avisos activados.
    if (ind._cfg.kanbanEnabled || ind._cfg.inboxEnabled) {
        await step('features-preset', async () => {
            if (!ind._kanbanItem.visible || !ind._bell.btn.visible || ind._headerTitles.todos.text !== 'Tareas')
                throw new Error('activados desde el arranque, pero sin menú/campana/«Tareas»');
            m.openKanban();
            await wait(300);
            const ok = m.kanban.isOpen;
            m.kanban.close();
            m.openInbox();
            await wait(300);
            const ok2 = m.inbox.isOpen;
            m.inbox.close();
            if (!ok || !ok2)
                throw new Error(`tablero ${ok}, avisos ${ok2}`);
            if (!m._kanbanBound)
                throw new Error('atajo del tablero sin registrar al arrancar activado');
            patchConfig({kanbanEnabled: false, inboxEnabled: false});
            if (!await until(() => !ind._cfg.kanbanEnabled && !ind._cfg.inboxEnabled))
                throw new Error('no se desactivaron');
            return 'menú, campana, «Tareas», atajo registrado; desactivados para el resto';
        });
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
        await screenshot();
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
        const names = ['weather-clear-night-symbolic', 'mail-unread-symbolic', 'preferences-system-notifications-symbolic'];
        const missing = names.filter(name => !theme.lookup_icon(name, 16, 0));
        if (missing.length)
            throw new Error(`iconos ausentes: ${missing}`);
        return 'iconos del tema presentes';
    });
    await step('usage-rings', async () => {
        // in-container.sh deja datos falsos: Claude 42 % / 18 % (statusLine) y Codex 78 % / 95 % (rollout).
        ind._usageInstalled = () => ({gemini: true, opencode: true});
        ind._refreshUsage();
        const ids = ind._usageRows.map(r => r.id).join(',');
        if (ids !== 'claude,codex,gemini,opencode')
            throw new Error(`filas: ${ids}`);
        const sec = ind._sections.usage.actor;
        const t = labels(sec);
        for (const want of ['42 %', '18 %', '78 %', '95 %', 'sin datos de límite'])
            if (!t.includes(want))
                throw new Error(`falta «${want}» en Uso: ${t.join(' | ')}`);
        // Insignia: icono de la app si el tema lo tiene (p. ej. claude-desktop en el host), si no la inicial.
        let icons = 0;
        walk(sec, a => {
            if (a.has_style_class_name?.('kaito-usage-badge') && a.get_first_child() instanceof St.Icon)
                icons++;
        });
        const letters = t.filter(x => ['C', 'X', 'G', 'O'].includes(x)).length;
        if (icons + letters !== 4)
            throw new Error(`insignias: ${icons} iconos + ${letters} iniciales`);
        if (!t.some(x => x.startsWith('reinicia ')))
            throw new Error('sin «reinicia …»');
        if (ind._counters.usage.text !== '5 h · semana' || !ind._headers.usage.visible)
            throw new Error(`cabecera: «${ind._counters.usage.text}»`);
        const areas = [];
        walk(sec, a => {
            if (a instanceof St.DrawingArea)
                areas.push(a);
        });
        if (areas.length !== 4)
            throw new Error(`${areas.length} anillos (esperaba 4)`);
        let painted = 0;
        for (const a of [...areas, ind._mini.actor])
            a.connect('repaint', () => painted++);
        for (const a of [...areas, ind._mini.actor])
            a.queue_repaint();
        if (!ind._mini.actor.visible || ind._mini.actor.accessible_name !== 'Claude 5 h 42 %')
            throw new Error(`mini anillo: ${ind._mini.actor.visible} «${ind._mini.actor.accessible_name}»`);
        ind.menu.open(false);
        await wait(800);
        await screenshot('uso');
        ind.menu.close(false);
        if (painted < 5)
            throw new Error(`solo ${painted} repintados de Cairo`);
        patchConfig({usagePanelProvider: 'codex'});
        if (!await until(() => ind._mini.actor.accessible_name === 'Codex 5 h 78 %'))
            throw new Error(`panel con Codex: «${ind._mini.actor.accessible_name}»`);
        patchConfig({usagePanelProvider: 'none', agentProviders: {codex: false, gemini: false}});
        if (!await until(() => !ind._mini.actor.visible && ind._usageRows.map(r => r.id).join(',') === 'claude,opencode'))
            throw new Error(`sin anillo / proveedores desactivados: ${ind._usageRows.map(r => r.id)}`);
        patchConfig({showUsage: false, usagePanelProvider: 'claude', agentProviders: {}});
        if (!await until(() => !ind._cfg.showUsage && !ind._headers.usage.visible && !ind._mini.actor.visible))
            throw new Error('showUsage=false no oculta el uso');
        patchConfig({showUsage: true});
        if (!await until(() => ind._headers.usage.visible && ind._mini.actor.visible))
            throw new Error('el uso no volvió');
        return `4 filas (${icons} iconos, ${letters} iniciales), 4 anillos + mini, ${painted} repintados`;
    });
    await step('kanban', async () => {
        if (m.kanban.isOpen || ind._kanbanItem.visible || ind._headerTitles.todos.text !== 'Pendientes')
            throw new Error('el tablero no está apagado por defecto');
        patchConfig({kanbanEnabled: true});
        if (!await until(() => ind._cfg.kanbanEnabled))
            throw new Error('no se activó');
        if (!ind._kanbanItem.visible || ind._headerTitles.todos.text !== 'Tareas')
            throw new Error('sin «Abrir tablero» o sin «Tareas»');
        // `kaito kanban`: toca ~/.cache/kaito/open-kanban
        GLib.mkdir_with_parents(CACHE(), 0o755);
        GLib.file_set_contents(GLib.build_filenamev([CACHE(), 'open-kanban']), '');
        if (!await until(() => m.kanban.isOpen))
            throw new Error('open-kanban no abrió el tablero');
        const k = m.kanban;
        let t = labels(k._panel);
        for (const want of ['Tablero', 'Por hacer', 'Haciendo', 'En revisión', 'Hecho', 'Nueva tarea'])
            if (!t.includes(want))
                throw new Error(`falta «${want}»`);
        // Nueva tarea desde el detalle
        findButton(k._panel, b => b.label === 'Nueva tarea').emit('clicked', 1);
        await wait(100);
        k._detail.title.set_text('Probar el tablero');
        k._detail.desc.set_text('Línea 1\nLínea 2');
        findButton(k._panel, b => b.label === '← Tablero').emit('clicked', 1);
        await wait(200);
        const task = todos().find(x => x.text === 'Probar el tablero');
        if (!task || !/^K-\d+$/.test(task.id) || task.state !== 'todo' || task.description !== 'Línea 1\nLínea 2')
            throw new Error(`tarea: ${JSON.stringify(task)}`);
        // → Haciendo
        const card = (() => {
            let c = null;
            walk(k._panel, a => {
                if (a._kaitoTask === task.id)
                    c = a;
            });
            return c;
        })();
        if (!card)
            throw new Error('sin tarjeta');
        findButton(card, b => b.label === '→ Haciendo').emit('clicked', 1);
        await wait(200);
        if (todos().find(x => x.id === task.id).state !== 'doing')
            throw new Error('→ no movió la tarea');
        await wait(300);
        await screenshot('tablero');
        // detalle
        findButton(k._panel, b => b.accessible_name === `Abrir ${task.id}`).emit('clicked', 1);
        await wait(200);
        await wait(300);
        await screenshot('detalle');
        t = labels(k._panel);
        for (const want of ['Mandar a Claude', 'Programar revisión', 'Borrar', 'Haciendo', task.id])
            if (!t.includes(want))
                throw new Error(`detalle sin «${want}»: ${t.join(' | ')}`);
        findButton(k._panel, b => b.label === 'Otra…').emit('clicked', 1); // buscador de repos
        await wait(200);
        if (!labels(k._panel).includes('¿Qué repo?'))
            throw new Error('sin buscador de repos');
        k._onKey({get_key_symbol: () => Clutter.KEY_Escape}); // cierra el buscador
        k._onKey({get_key_symbol: () => Clutter.KEY_Escape}); // vuelve al tablero
        if (!k.isOpen || k._detail)
            throw new Error('Esc no volvió al tablero');
        // borrar (dos clics) una segunda tarea
        findButton(k._panel, b => b.label === 'Nueva tarea').emit('clicked', 1);
        k._detail.title.set_text('Borrame');
        k._saveDetail();
        k._renderDetail();
        findButton(k._panel, b => b.label === 'Borrar').emit('clicked', 1);
        findButton(k._panel, b => b.label === '¿Borrar?').emit('clicked', 1);
        await wait(100);
        if (todos().some(x => x.text === 'Borrame'))
            throw new Error('no se borró');
        k._onKey({get_key_symbol: () => Clutter.KEY_Escape});
        if (k.isOpen)
            throw new Error('Esc no cerró');
        ind._renderSection('todos');
        const menu = labels(ind.menu.box);
        if (!menu.includes('Probar el tablero') || !menu.includes('Haciendo'))
            throw new Error('la fila del menú no muestra la tarea con su estado');
        m.toggleKanban();
        const viaKey = k.isOpen;
        m.toggleKanban();
        return `${task.id} creada, movida y abierta; atajo ${m._kanbanBound ? 'registrado' : 'NO registrado'}; toggle ${viaKey}`;
    });
    await step('inbox', async () => {
        if (ind._bell.btn.visible)
            throw new Error('campana visible con el panel apagado');
        patchConfig({inboxEnabled: true});
        if (!await until(() => ind._cfg.inboxEnabled))
            throw new Error('no se activó');
        if (!ind._bell.btn.visible || !ind._inboxItem.visible)
            throw new Error('sin campana o sin «Avisos»');
        // te necesita (permiso que espera respuesta)
        const perm = {...NEEDS, id: 'sess-perm', cwd: 'mp_kontan',
            hook: {...NEEDS.hook, request: 'req-1', waitUntil: Math.floor(Date.now() / 1000) + 120}};
        AGENTS.push(perm);
        ind._needsIds = new Set();
        ind._checkNeeds([perm]);
        if (!inbox().some(x => x.kind === 'needs' && x.agentId === 'sess-perm'))
            throw new Error('el «te necesita» no llegó al panel');
        if (ind._inboxStats.unread < 1 || !ind._bell.dot.visible)
            throw new Error(`campana: ${JSON.stringify(ind._inboxStats)}`);
        // clic real en la campana (puntero virtual): abre el panel, no el menú
        let via = 'puntero';
        const click = async actor => {
            const dev = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            dev.notify_absolute_motion(GLib.get_monotonic_time(), x + w / 2, y + h / 2);
            await wait(300);
            dev.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
            await wait(100);
            dev.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
            await wait(400);
            const hit = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x + w / 2, y + h / 2);
            const box = actor.get_allocation_box();
            return `${Math.round(x + w / 2)},${Math.round(y + h / 2)} alloc ${box.x1},${box.y1} ${box.get_width()}x${box.get_height()} → ${hit} padre ${hit?.get_parent?.()} ${hit?.get_parent?.()?.get_parent?.()} modal ${Main.modalCount} mapped ${actor.mapped}`;
        };
        // El diálogo de bienvenida de la distro (Fedora/Ubuntu) tapa el panel en una sesión nueva.
        for (const d of Main.layoutManager.modalDialogGroup.get_children())
            d.close?.();
        await wait(600);
        ind.queue_relayout();
        await wait(1000);
        try {
            // Calentamiento: el primer clic del puntero virtual tras cerrar el diálogo a veces se pierde.
            await click({get_transformed_position: () => [400, 400], get_transformed_size: () => [2, 2],
                get_allocation_box: () => ({x1: 0, y1: 0, get_width: () => 0, get_height: () => 0})});
            const b = await click(ind._bell.btn);
            via = m.inbox.isOpen ? 'clic real abre el panel' : `clic real no abrió (${b})`;
        } catch (e) {
            via = `sin puntero virtual (${e.message})`;
        }
        if (ind.menu.isOpen)
            throw new Error(`el clic en la campana abrió el menú (${via})`);
        if (!m.inbox.isOpen) {
            if (!via.includes('control abrió el menú'))
                throw new Error(`el clic de control no llegó: ${via}`);
            throw new Error(`el clic en la campana no abrió el panel: ${via}`);
        }
        if (ind.menu.isOpen)
            throw new Error('menú abierto junto al panel');
        await wait(200);
        if (m.inbox.isOpen && via === 'clic real abre el panel') {
            // Control: con el panel cerrado, un clic en otro segmento del indicador sigue abriendo el menú.
            m.inbox.close();
            await wait(300);
            const c = await click(ind._seg.agents.seg);
            const menuOk = ind.menu.isOpen;
            ind.menu.close(false);
            await wait(300);
            if (!menuOk)
                throw new Error(`un clic fuera de la campana ya no abre el menú (${c})`);
            via += '; el resto del indicador abre el menú';
            m.openInbox();
            await wait(200);
        }
        await wait(300);
        await screenshot('avisos');
        let t = labels(m.inbox._panel);
        for (const want of ['Avisos', 'Permitir', 'Denegar', 'No molestar', 'Te pide permiso'])
            if (!t.includes(want))
                throw new Error(`panel sin «${want}»: ${t.join(' | ')}`);
        if (ind._inboxStats.unread !== 0)
            throw new Error('abrir no marcó como leído');
        findButton(m.inbox._panel, b => b.label === 'Permitir').emit('clicked', 1);
        await wait(200);
        const dec = readJsonFile(GLib.build_filenamev([CACHE(), 'decisions', 'sess-perm.json']), null);
        if (dec?.behavior !== 'allow' || dec.request !== 'req-1')
            throw new Error(`decisión: ${JSON.stringify(dec)}`);
        if (!labels(m.inbox._panel).includes('Permitido · sigue trabajando'))
            throw new Error('sin «Permitido · sigue trabajando»');
        m.inbox.close();
        // agente terminó: aviso breve + panel, con respuesta
        ind._notifyDone(AGENTS[1], 5);
        await wait(100);
        const done = inbox().find(x => x.kind === 'done' && x.agentId === 'sess-work');
        if (!done)
            throw new Error('«terminó» no llegó al panel');
        m.openInbox();
        await wait(200);
        let entry = null;
        walk(m.inbox._panel, a => {
            if (a instanceof St.Entry && a._kaitoItem === done.id)
                entry = a;
        });
        if (!entry || entry.hint_text !== 'Responder · se copia y te llevo a su terminal')
            throw new Error('sin campo de respuesta');
        entry.set_text('sí, actualiza la documentación');
        entry.clutter_text.emit('activate');
        await wait(200);
        if (m.inbox.isOpen || inbox().find(x => x.id === done.id)?.resolved !== 'Respuesta copiada')
            throw new Error('la respuesta no se copió/resolvió');
        // No molestar manual: nada de tarjetas ni cola; todo al panel
        m.quiet.set('on');
        await wait(200);
        const cards = m._reminders._box ? m._reminders._box.get_n_children() : 0;
        m.showFinished({id: 'k2', agentId: 'sess-work', title: 'RUN-2 listo', meta: 'web · 5 min', lines: [{text: 'Rama x'}],
            prUrl: 'https://github.com/o/r/pull/new/x', onFocus: () => {}, ticket: 'RUN-2'});
        m._onTaskFinish(TASK, {ok: true, summary: 'ok', finished: new Date().toISOString()});
        ind._onUpdateAvailable({latest: '9.9.8', behind: 1, changes: ['Uno']});
        if ((m._reminders._box ? m._reminders._box.get_n_children() : 0) !== cards)
            throw new Error('salió una tarjeta con el panel activado');
        if (m.quiet.queue.length)
            throw new Error('con el panel no debe usarse la cola de «Mientras no estabas»');
        const ids = inbox().map(x => x.id);
        for (const want of ['fin:k2', 'update:9.9.8'])
            if (!ids.includes(want))
                throw new Error(`falta ${want} en el panel: ${ids}`);
        if (!ids.some(x => x.startsWith('task:t1:')))
            throw new Error('falta el resultado de la tarea');
        m.openInbox();
        await wait(200);
        t = labels(m.inbox._panel);
        if (!t.includes('No molestar activo') || !t.includes('Abrir PR'))
            throw new Error(`panel en No molestar: ${t.join(' | ')}`);
        findButton(m.inbox._panel, b => b.label === 'Activo').emit('clicked', 1); // pie: desactivar
        await wait(500);
        if (m.quiet.quiet || m._reminders._cards.has('__quiet'))
            throw new Error('No molestar sigue o salió «Mientras no estabas»');
        findButton(m.inbox._panel, b => b.label === '+').emit('clicked', 1);
        findButton(m.inbox._panel, b => b.label === 'Activar').emit('clicked', 1);
        await wait(200);
        const q = m.quiet.state;
        const mins = q.until ? Math.round((q.until.getTime() - Date.now()) / 60000) : null;
        m.quiet.set('off');
        if (q.reason !== 'manual' || mins !== 45)
            throw new Error(`pie de No molestar: ${q.reason} ${mins} min`);
        m.inbox.close();
        m.quiet.set('hour'); // el interruptor del menú no debe convertirlo en "sin límite" (GNOME 50)
        await wait(200);
        const hour = m.quiet.state.until;
        m.quiet.set('off');
        if (!hour)
            throw new Error('«1 h» quedó sin límite');
        return `${inbox().length} avisos; campana: ${via}`;
    });
    await step('kanban-finish', async () => {
        // Agente de una tarea K-<n> que termina con commits: pasa a «En revisión», sin Jira, al panel.
        const task = todos().find(x => x.text === 'Probar el tablero');
        const repo = GLib.dir_make_tmp('kaito-k-XXXXXX');
        const env = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
        sh(['git', 'init', '-q', '-b', 'main'], repo);
        sh(['git', ...env, 'commit', '-q', '--allow-empty', '-m', 'base'], repo);
        sh(['git', 'checkout', '-q', '-b', `${task.id}-probar`], repo);
        sh(['git', ...env, 'commit', '-q', '--allow-empty', '-m', `${task.id}: hecho`], repo);
        const a = {id: 'sess-k', ticket: task.id, cwdPath: repo, cwd: 'repo', pid: null, lastText: 'Listo'};
        await ind._onTicketFinish(a, Date.now() - 10 * 60000, 10 * 60000);
        const now = todos().find(x => x.id === task.id);
        if (now.state !== 'review')
            throw new Error(`estado ${now.state}`);
        const fin = inbox().find(x => x.kind === 'finished' && x.title === `${task.id} listo`);
        if (!fin || !fin.actions.some(x => x.label === 'Revisar'))
            throw new Error(`aviso «listo»: ${JSON.stringify(fin)}`);
        const rem = readJsonFile(GLib.build_filenamev([GLib.get_user_config_dir(), 'kaito', 'reminders.json']), [])
            .find(r => r.text.startsWith(`Revisar ${task.id}`));
        if (!rem)
            throw new Error('sin recordatorio «Revisar K-n»');
        return `${task.id} → En revisión, «${fin.title}», recordatorio «${rem.text}»`;
    });
    await step('features-off', async () => {
        patchConfig({kanbanEnabled: false, inboxEnabled: false});
        if (!await until(() => !ind._cfg.kanbanEnabled && !ind._cfg.inboxEnabled))
            throw new Error('no se desactivaron');
        if (ind._bell.btn.visible || ind._kanbanItem.visible || ind._inboxItem.visible || ind._headerTitles.todos.text !== 'Pendientes' || m._kanbanBound)
            throw new Error('quedan restos del tablero o del panel');
        ind._renderSection('todos');
        if (!labels(ind.menu.box).includes('Probar el tablero'))
            throw new Error('la tarea abierta no sale en Pendientes');
        // con el panel apagado vuelve la tarjeta fija de «listo»
        m.showFinished({id: 'k3', agentId: 'sess-work', title: 'RUN-3 listo', meta: 'web', lines: []});
        if (!m._reminders._cards.has('__fin:k3'))
            throw new Error('sin tarjeta «listo» con el panel apagado');
        m._reminders._removeCard('__fin:k3');
        return 'como antes';
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
