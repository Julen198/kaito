import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    TODOS_PATH, CLAUDE_PROJECTS, TASKS_PATH, TASK_RUNS_DIR,
    PRESETS, TERMINALS, readConfig, updateConfig, readJson, writeJson, getToken, storeToken, checkJira, scanAgents,
    BUILTIN_VIEWS, normalizeCustomViews, resolveTerminal, terminalFocusLevel, ptyxisVersion, migrateTerminalOnce,
    installedProviders,
} from './common.js';
import {LEVEL_TEXT} from './providers.js';
import {parseHHMM, fmtHHMM, SNOOZE_CHOICES, snoozeLabel} from './quiet.js';
import {PANEL_RING_PROVIDERS, PANEL_RING_LABELS} from './usage.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const DAY_NAMES = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const STATUS_INFO = 'Claude Code pasa tu uso (5 h y semanal) a su barra de estado; Kaito la usa para los anillos de uso.';
const DAY_FULL = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

const TERMINAL_LABELS = ['Automático (recomendado)', 'Ptyxis', 'GNOME Terminal', 'Consola (kgx)', 'Warp (pestaña)', 'Warp (ventana)'];
const TERMINAL_NAMES = {ptyxis: 'Ptyxis', 'gnome-terminal': 'GNOME Terminal', kgx: 'Consola (kgx)', warp: 'Warp (pestaña)', 'warp-window': 'Warp (ventana)'};

/** "Ptyxis · pestaña exacta" para el subtítulo del combo de terminal. */
function terminalInfo(terminal) {
    const t = resolveTerminal(terminal);
    if (!t)
        return 'No se encuentra ninguna terminal compatible';
    const level = terminalFocusLevel(t.id, t.id === 'ptyxis' ? ptyxisVersion(t.flatpak) : null);
    const name = `${TERMINAL_NAMES[t.id]}${t.flatpak ? ' (flatpak)' : ''}`;
    const focus = level === 'tab' ? 'pestaña exacta' : 'solo ventana';
    return terminal === 'auto' ? `Se usará ${name} · volver al agente: ${focus}` : `Volver al agente: ${focus}`;
}

const TOKEN_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const tilde = p => p.replace(GLib.get_home_dir(), '~');

function spinRow(title, key, lower, upper, cfg) {
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 10, value: cfg[key]}),
    });
    row.connect('notify::value', () => {
        try {
            updateConfig({[key]: Math.round(row.value)});
        } catch (e) {
            console.error(`kaito: no se pudo guardar ${key}: ${e.message}`);
        }
    });
    return row;
}

function switchRow(title, subtitle, key, cfg) {
    const row = new Adw.SwitchRow({title, subtitle, active: !!cfg[key]});
    row.connect('notify::active', () => {
        try {
            updateConfig({[key]: row.active});
        } catch (e) {
            console.error(`kaito: no se pudo guardar ${key}: ${e.message}`);
        }
    });
    return row;
}

function entryRow(title, key, cfg) {
    const row = new Adw.EntryRow({title, text: cfg[key] ?? '', show_apply_button: true});
    row.connect('apply', () => {
        try {
            updateConfig({[key]: row.text.trim()});
        } catch (e) {
            console.error(`kaito: no se pudo guardar ${key}: ${e.message}`);
        }
    });
    return row;
}

export default class KaitoPreferences extends ExtensionPreferences {
    /** Atajo del tablero (clave nueva del esquema: sin volver a entrar puede no existir). */
    _kanbanShortcutRow() {
        const settings = this.getSettings();
        if (!settings.settings_schema.has_key('kanban-shortcut'))
            return new Adw.ActionRow({title: 'Atajo del tablero', subtitle: 'Cierra sesión y vuelve a entrar una vez para poder cambiarlo (Super+K por defecto)'});
        const row = new Adw.EntryRow({
            title: 'Atajo del tablero (p. ej. <Super>k)', use_markup: false,
            text: settings.get_strv('kanban-shortcut')[0] ?? '', show_apply_button: true,
        });
        row.connect('apply', () => {
            const accel = row.text.trim();
            const [ok, key] = Gtk.accelerator_parse(accel);
            if (!accel || !ok || !key) {
                row.add_css_class('error');
                return;
            }
            row.remove_css_class('error');
            settings.set_strv('kanban-shortcut', [accel]);
        });
        return row;
    }

    /**
     * "Datos de uso de Claude": ¿la statusLine de ~/.claude/settings.json es hooks/kaito-statusline.py?
     * Instalar/Quitar con hooks/merge-settings.py --statusline-only (argv, sin shell; hace copia de seguridad
     * y nunca sustituye otra statusLine distinta).
     */
    _statusLineRow() {
        const row = new Adw.ActionRow({title: 'Datos de uso de Claude', subtitle: STATUS_INFO});
        row.subtitle_lines = 4;
        const btn = new Gtk.Button({label: 'Instalar', valign: Gtk.Align.CENTER, sensitive: false});
        row.add_suffix(btn);
        const script = GLib.build_filenamev([this.path, 'hooks', 'merge-settings.py']);
        const python = GLib.find_program_in_path('python3');
        let state = null;
        const run = async args => {
            const proc = Gio.Subprocess.new([python, script, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
            const [out] = await proc.communicate_utf8_async(null, null);
            return {code: proc.get_exit_status(), out: out ?? ''};
        };
        const refresh = async (note = null) => {
            if (!python || !GLib.file_test(script, GLib.FileTest.EXISTS)) {
                row.subtitle = `${STATUS_INFO}\nNo se encuentra python3 o ${script}`;
                btn.sensitive = false;
                return;
            }
            try {
                const r = await run(['status']);
                const st = JSON.parse(r.out.trim().split('\n').pop());
                state = st.state;
                if (st.state === 'other') {
                    btn.label = 'Instalar';
                    btn.sensitive = false;
                    row.subtitle = `${STATUS_INFO}\nYa tienes otra barra de estado: ${GLib.markup_escape_text(st.command ?? '?', -1)}`;
                    return;
                }
                const installed = st.state === 'kaito';
                btn.label = installed ? 'Quitar' : 'Instalar';
                btn.sensitive = true;
                row.subtitle = `${STATUS_INFO}\n${note ?? (installed ? 'Instalada' : st.state === 'kaito-other-path' ? 'Instalada desde otra carpeta de Kaito: pulsa Instalar para actualizar la ruta' : 'No instalada')}`;
            } catch (e) {
                btn.sensitive = false;
                row.subtitle = `${STATUS_INFO}\nNo se pudo leer ~/.claude/settings.json: ${GLib.markup_escape_text(e.message, -1)}`;
            }
        };
        btn.connect('clicked', async () => {
            const remove = state === 'kaito';
            btn.sensitive = false;
            try {
                const r = await run([remove ? 'uninstall' : 'install', '--statusline-only', '--apply']);
                if (r.code !== 0 && r.code !== 10)
                    throw new Error(r.out.trim().split('\n').pop() || `código ${r.code}`);
                await refresh(remove ? 'Quitada.' : 'Instalada. Se verá al abrir o usar Claude Code.');
            } catch (e) {
                await refresh(`No se pudo: ${GLib.markup_escape_text(e.message, -1)}`);
            }
        });
        refresh().catch(e => console.error(`kaito: statusLine: ${e.message}`));
        return row;
    }

    /** Opcionales: tablero de tareas y panel de avisos (apagados por defecto). */
    _optionalGroup(page, cfg) {
        const group = new Adw.PreferencesGroup({
            title: 'Tablero y avisos',
            description: 'Opcionales. Desactivados, Kaito funciona exactamente como antes',
        });
        page.add(group);
        group.add(switchRow('Tablero de tareas',
            'Convierte Pendientes en tareas con estado y prioridad', 'kanbanEnabled', cfg));
        group.add(this._kanbanShortcutRow());
        group.add(switchRow('Panel de avisos',
            'Un solo sitio para todos los avisos, con respuesta', 'inboxEnabled', cfg));
    }

    /** Atajo de captura rápida: acepta un acelerador GTK, p. ej. <Control><Alt>space. */
    _shortcutRow() {
        const settings = this.getSettings();
        const row = new Adw.EntryRow({
            title: 'Atajo de captura (p. ej. <Control><Alt>space)', use_markup: false,
            text: settings.get_strv('capture-shortcut')[0] ?? '', show_apply_button: true,
        });
        row.connect('apply', () => {
            const accel = row.text.trim();
            const [ok, key] = Gtk.accelerator_parse(accel);
            if (!accel || !ok || !key) {
                row.add_css_class('error');
                return;
            }
            row.remove_css_class('error');
            settings.set_strv('capture-shortcut', [accel]);
        });
        return row;
    }

    /** Vistas de Jira: integradas (interruptores) y propias (nombre + JQL). */
    _viewsGroup(page, cfg) {
        const group = new Adw.PreferencesGroup({
            title: 'Vistas de Jira',
            description: 'Pestañas bajo la sección Jira. "Mías" es la consulta de arriba y siempre está',
        });
        page.add(group);
        this._jiraGroups.push(group);
        const builtin = {...cfg.jiraBuiltinViews};
        const subtitles = {
            unassigned: 'Tickets abiertos sin responsable en tus proyectos',
            sprint: 'Sprint activo de tus proyectos, con el responsable de cada ticket',
            recent: 'Tuyos, creados por ti o que sigues, actualizados en 24 h',
        };
        for (const v of BUILTIN_VIEWS.filter(b => b.id !== 'mine')) {
            const row = new Adw.SwitchRow({title: v.name, subtitle: subtitles[v.id], active: builtin[v.id] !== false});
            row.connect('notify::active', () => {
                builtin[v.id] = row.active;
                try {
                    updateConfig({jiraBuiltinViews: builtin});
                } catch (e) {
                    console.error(`kaito: no se pudo guardar jiraBuiltinViews: ${e.message}`);
                }
            });
            group.add(row);
        }

        const custom = new Adw.PreferencesGroup({
            title: 'Vistas propias',
            description: 'Cada una sale como una pestaña más. Pulsa ✓ en el campo para guardar',
        });
        page.add(custom);
        this._jiraGroups.push(custom);
        const add = new Gtk.Button({icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Añadir vista'});
        add.add_css_class('flat');
        custom.set_header_suffix(add);
        let views = normalizeCustomViews(readConfig().jiraViews);
        let rows = [];
        const save = () => {
            try {
                updateConfig({jiraViews: views});
            } catch (e) {
                console.error(`kaito: no se pudo guardar jiraViews: ${e.message}`);
            }
        };
        const build = () => {
            for (const r of rows)
                custom.remove(r);
            rows = [];
            if (!views.length) {
                const empty = new Adw.ActionRow({title: 'Sin vistas propias', subtitle: 'Añade una con +'});
                custom.add(empty);
                rows.push(empty);
            }
            for (const v of views) {
                const name = new Adw.EntryRow({title: 'Nombre', text: v.name, show_apply_button: true});
                name.connect('apply', () => {
                    v.name = name.text.trim();
                    save();
                });
                const jql = new Adw.EntryRow({title: 'JQL', text: v.jql, show_apply_button: true});
                jql.connect('apply', () => {
                    v.jql = jql.text.trim();
                    save();
                });
                const ctl = new Adw.ActionRow({title: v.name || 'Vista sin nombre', subtitle: 'Mostrar como pestaña'});
                const sw = new Gtk.Switch({active: v.enabled, valign: Gtk.Align.CENTER});
                sw.connect('notify::active', () => {
                    v.enabled = sw.active;
                    save();
                });
                name.connect('apply', () => (ctl.title = v.name || 'Vista sin nombre'));
                const del = new Gtk.Button({icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER, tooltip_text: 'Quitar vista'});
                del.add_css_class('flat');
                del.connect('clicked', () => {
                    views = views.filter(x => x !== v);
                    save();
                    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                        build();
                        return GLib.SOURCE_REMOVE;
                    });
                });
                ctl.add_suffix(sw);
                ctl.add_suffix(del);
                for (const r of [ctl, name, jql]) {
                    custom.add(r);
                    rows.push(r);
                }
            }
        };
        add.connect('clicked', () => {
            views.push({id: `c${Date.now().toString(36)}`, name: '', jql: '', enabled: true});
            save();
            build();
        });
        build();
    }

    /** "Ver otra vez": tourDone=false; el tour sale la próxima vez que se abra el menú. */
    _tourRow() {
        const row = new Adw.ActionRow({
            title: 'Tour de bienvenida',
            subtitle: 'Te enseña dónde está cada cosa en el menú. Sale solo la primera vez.',
        });
        const btn = new Gtk.Button({label: 'Ver otra vez', valign: Gtk.Align.CENTER});
        btn.connect('clicked', () => {
            try {
                updateConfig({tourDone: false});
                btn.label = 'Sale al abrir el menú';
                btn.sensitive = false;
            } catch (e) {
                console.error(`kaito: no se pudo guardar tourDone: ${e.message}`);
            }
        });
        row.add_suffix(btn);
        return row;
    }

    fillPreferencesWindow(window) {
        try {
            migrateTerminalOnce();
        } catch (e) {
            console.error(`kaito: migración de terminal: ${e.message}`);
        }
        const cfg = readConfig();
        const page = new Adw.PreferencesPage({title: 'Kaito', icon_name: 'preferences-system-symbolic'});
        window.add(page);
        window.set_default_size(560, 720);

        const session = new Soup.Session({timeout: 15});
        let closed = false;
        window.connect('close-request', () => {
            closed = true;
            session.abort();
            return false;
        });

        // --- Jira ---
        const jira = new Adw.PreferencesGroup({title: 'Jira'});
        page.add(jira);
        // Interruptor general: apagado, Kaito no habla con Jira (el resto de filas quedan inactivas).
        const useJira = new Adw.SwitchRow({
            title: 'Usar Jira', subtitle: 'Tickets en el menú y el panel, crear tickets, mover y comentar', active: cfg.jiraEnabled,
        });
        jira.add(useJira);
        const jiraRows = [];
        this._jiraGroups = [];
        const syncJira = () => {
            for (const w of [...jiraRows, ...this._jiraGroups])
                w.sensitive = useJira.active;
        };
        const origAdd = jira.add.bind(jira);
        jira.add = row => {
            origAdd(row);
            jiraRows.push(row);
        };
        useJira.connect('notify::active', () => {
            try {
                updateConfig({jiraEnabled: useJira.active});
            } catch (e) {
                console.error(`kaito: no se pudo guardar jiraEnabled: ${e.message}`);
            }
            syncJira();
            if (useJira.active)
                runCheck();
        });

        const status = new Adw.ActionRow({title: 'Estado', subtitle: 'Comprobando…'});
        const test = new Gtk.Button({label: 'Probar conexión', valign: Gtk.Align.CENTER});
        status.add_suffix(test);
        jira.add(status);

        let checkId = 0;
        const runCheck = async () => {
            const id = ++checkId;
            test.sensitive = false;
            status.subtitle = 'Comprobando…';
            let text;
            try {
                const r = await checkJira(session);
                text = `Conectado como ${r.displayName} · ${r.count} tickets abiertos`;
            } catch (e) {
                text = e.message;
            }
            if (closed || id !== checkId)
                return;
            status.subtitle = text;
            test.sensitive = true;
        };
        test.connect('clicked', runCheck);

        jira.add(entryRow('URL de Jira', 'jiraBaseUrl', cfg));
        jira.add(entryRow('Email', 'jiraEmail', cfg));

        // Qué tickets mostrar: preset + JQL propia + máximo.
        const presetIdx = Math.max(0, PRESETS.findIndex(p => p.id === cfg.jiraPreset));
        const combo = new Adw.ComboRow({
            title: 'Qué tickets mostrar',
            model: Gtk.StringList.new(PRESETS.map(p => p.title)),
            selected: presetIdx,
        });
        const jqlRow = new Adw.EntryRow({
            title: 'JQL', text: cfg.jiraPreset === 'custom' ? cfg.jiraJql : '',
            show_apply_button: true, visible: PRESETS[presetIdx].id === 'custom',
        });
        const saveJql = (preset, jql) => {
            try {
                updateConfig({jiraPreset: preset.id, jiraJql: jql});
            } catch (e) {
                console.error(`kaito: no se pudo guardar jql: ${e.message}`);
            }
            runCheck();
        };
        combo.connect('notify::selected', () => {
            const preset = PRESETS[combo.selected];
            jqlRow.visible = preset.id === 'custom';
            if (preset.jql)
                saveJql(preset, preset.jql);
            else if (jqlRow.text.trim())
                saveJql(preset, jqlRow.text.trim());
        });
        jqlRow.connect('apply', () => {
            if (jqlRow.text.trim())
                saveJql(PRESETS[3], jqlRow.text.trim());
        });
        jira.add(combo);
        jira.add(jqlRow);
        jira.add(spinRow('Máximo de tickets', 'jiraMax', 1, 50, cfg));

        const token = new Adw.PasswordEntryRow({title: 'API token', show_apply_button: true});
        jira.add(token);
        const tokenInfo = new Adw.ActionRow({title: 'Token', subtitle: 'Comprobando…'});
        const create = new Gtk.Button({label: 'Crear token', valign: Gtk.Align.CENTER});
        create.connect('clicked', () => Gtk.show_uri(window, TOKEN_URL, 0));
        tokenInfo.add_suffix(create);
        jira.add(tokenInfo);

        const refreshTokenInfo = async () => {
            let stored = false;
            try {
                stored = !!await getToken();
            } catch (e) {
                console.error(`kaito: llavero: ${e.message}`);
            }
            if (!closed)
                tokenInfo.subtitle = stored ? 'Token guardado en el llavero' : 'No hay token';
        };
        token.connect('apply', async () => {
            const value = token.text.trim();
            if (!value)
                return;
            try {
                await storeToken(value);
                token.text = '';
            } catch (e) {
                tokenInfo.subtitle = `No se pudo guardar: ${e.message}`;
                return;
            }
            await refreshTokenInfo();
            runCheck();
        });

        this._viewsGroup(page, cfg);
        syncJira();

        // --- Agentes ---
        const agents = new Adw.PreferencesGroup({title: 'Agentes'});
        page.add(agents);
        const sessions = new Adw.ActionRow({title: 'Sesiones de Claude Code'});
        agents.add(sessions);
        const win = spinRow('Ventana de actividad (minutos)', 'agentWindowMinutes', 1, 120, cfg);
        const live = spinRow('Trabajando si hubo actividad hace menos de (segundos)', 'liveSeconds', 10, 600, cfg);
        const updateSessions = () => {
            const n = scanAgents(Math.round(win.value) * 60, false).length;
            sessions.subtitle = `${tilde(CLAUDE_PROJECTS)} · ${n} activas ahora`;
        };
        win.connect('notify::value', updateSessions);
        agents.add(win);
        agents.add(live);
        agents.add(switchRow('Avisar con notificación cuando un agente te necesite',
            'Requiere registrar los hooks (ver README)', 'notifyNeeds', cfg));
        agents.add(switchRow('Avisar cuando un agente termina',
            'Tras 3 min o más trabajando, con resumen y acciones', 'notifyDone', cfg));
        agents.add(switchRow('Al terminar un ticket con commits: moverlo a revisión y avisar',
            'Tarjeta en pantalla con la rama, si está subida y el estado en Jira', 'autoReview', cfg));
        const reviewRow = spinRow('Recordatorio para revisar (minutos)', 'reviewReminderMinutes', 0, 480, cfg);
        reviewRow.subtitle = '0 = sin recordatorio';
        agents.add(reviewRow);
        updateSessions();

        this._providersGroup(page, cfg);
        this._quietGroup(page, cfg);

        // --- General ---
        const general = new Adw.PreferencesGroup({title: 'General'});
        page.add(general);
        general.add(this._tourRow());
        general.add(switchRow('Mostrar siempre desplegado',
            'Panel fijo arriba a la derecha, por encima de las ventanas', 'pinned', cfg));
        general.add(switchRow('Mostrar uso de Claude y Codex',
            'Anillos de los límites de 5 h y semanales. Claude necesita hooks/kaito-statusline.py (ver README); Codex se lee de ~/.codex', 'showUsage', cfg));
        general.add(this._statusLineRow());
        const ringIdx = Math.max(0, PANEL_RING_PROVIDERS.indexOf(cfg.usagePanelProvider));
        const ringRow = new Adw.ComboRow({
            title: 'Anillo en la barra superior',
            subtitle: 'Uso de 5 h junto a los contadores',
            model: Gtk.StringList.new(PANEL_RING_LABELS),
            selected: ringIdx,
        });
        ringRow.connect('notify::selected', () => {
            try {
                updateConfig({usagePanelProvider: PANEL_RING_PROVIDERS[ringRow.selected]});
            } catch (e) {
                console.error(`kaito: no se pudo guardar usagePanelProvider: ${e.message}`);
            }
        });
        general.add(ringRow);
        general.add(switchRow('Resumen al empezar el día',
            'Primera vez a partir de las 06:00: tickets en curso, recordatorios de hoy y agentes parados', 'dailySummary', cfg));
        const snIdx = Math.max(0, SNOOZE_CHOICES.indexOf(cfg.snoozeMinutes));
        const snoozeRow = new Adw.ComboRow({
            title: 'Posponer recordatorios',
            subtitle: 'Duración del botón «Posponer» de la tarjeta (el chevron ofrece más opciones)',
            model: Gtk.StringList.new(SNOOZE_CHOICES.map(snoozeLabel)),
            selected: snIdx,
        });
        snoozeRow.connect('notify::selected', () => {
            try {
                updateConfig({snoozeMinutes: SNOOZE_CHOICES[snoozeRow.selected]});
            } catch (e) {
                console.error(`kaito: no se pudo guardar snoozeMinutes: ${e.message}`);
            }
        });
        general.add(snoozeRow);
        general.add(this._shortcutRow());
        general.add(spinRow('Refrescar cada (segundos)', 'refreshSeconds', 10, 600, cfg));
        const term = new Adw.ComboRow({
            title: 'Terminal para Claude',
            subtitle: terminalInfo(cfg.terminal),
            model: Gtk.StringList.new(TERMINAL_LABELS),
            selected: Math.max(0, TERMINALS.indexOf(cfg.terminal)),
        });
        term.connect('notify::selected', () => {
            const t = TERMINALS[term.selected];
            try {
                updateConfig({terminal: t, terminalMigrated: true});
            } catch (e) {
                console.error(`kaito: no se pudo guardar terminal: ${e.message}`);
            }
            term.subtitle = terminalInfo(t);
        });
        general.add(term);
        general.add(switchRow('Buscar actualizaciones',
            'Cada 6 h mira si hay una versión nueva y la ofrece arriba del menú (solo si Kaito se instaló con git)', 'checkUpdates', cfg));

        this._optionalGroup(page, cfg);

        // --- Tareas programadas ---
        const tasksGroup = new Adw.PreferencesGroup({
            title: 'Tareas programadas',
            description: 'Claude Code las ejecuta solo, con permisos de lectura (y BigQuery si lo eliges). Se crean desde la pestaña Tarea de la captura rápida',
        });
        page.add(tasksGroup);
        tasksGroup.add(switchRow('Activar tareas programadas',
            'Si lo desactivas no se ejecuta ninguna (se recuperan al volver a activarlo)', 'tasksEnabled', cfg));
        const tasksRow = new Adw.ActionRow({title: 'Tareas'});
        tasksGroup.add(tasksRow);
        const tasks = readJson(TASKS_PATH, []);
        const list = Array.isArray(tasks) ? tasks : [];
        const active = list.filter(t => t && t.enabled && !t.done).length;
        tasksRow.title = `${list.length} ${list.length === 1 ? 'tarea' : 'tareas'} · ${active} ${active === 1 ? 'activa' : 'activas'}`;
        tasksRow.subtitle = `${tilde(TASKS_PATH)} · historial en ${tilde(TASK_RUNS_DIR)}`;

        // --- Pendientes ---
        const todosGroup = new Adw.PreferencesGroup({title: 'Pendientes'});
        page.add(todosGroup);
        const todosRow = new Adw.ActionRow({title: 'Pendientes'});
        const clear = new Gtk.Button({label: 'Borrar hechos', valign: Gtk.Align.CENTER});
        clear.add_css_class('destructive-action');
        todosRow.add_suffix(clear);
        todosGroup.add(todosRow);
        const updateTodos = () => {
            const todos = readJson(TODOS_PATH, []);
            const done = todos.filter(t => t.done).length;
            todosRow.title = `${todos.length - done} pendientes, ${done} hechos`;
            todosRow.subtitle = tilde(TODOS_PATH);
            clear.sensitive = done > 0;
        };
        clear.connect('clicked', () => {
            try {
                writeJson(TODOS_PATH, readJson(TODOS_PATH, []).filter(t => !t.done));
            } catch (e) {
                console.error(`kaito: no se pudo borrar hechos: ${e.message}`);
            }
            updateTodos();
        });
        updateTodos();

        refreshTokenInfo();
        if (cfg.jiraEnabled)
            runCheck();
        else
            status.subtitle = 'Jira desactivado';
    }

    /** Agentes detectados: un interruptor por proveedor instalado; los que faltan, atenuados. */
    _providersGroup(page, cfg) {
        const group = new Adw.PreferencesGroup({
            title: 'Agentes detectados',
            description: 'CLIs de agentes que Kaito encuentra en tu equipo. Desactiva los que no quieras ver en el menú',
        });
        page.add(group);
        const toggles = {...cfg.agentProviders};
        let list = [];
        try {
            list = installedProviders(true);
        } catch (e) {
            console.error(`kaito: proveedores: ${e.message}`);
        }
        for (const p of list) {
            if (p.installed) {
                const row = new Adw.SwitchRow({
                    title: p.title, subtitle: `${LEVEL_TEXT[p.level]} · ${tilde(p.path)}`, active: toggles[p.id] !== false,
                });
                row.connect('notify::active', () => {
                    toggles[p.id] = row.active;
                    try {
                        updateConfig({agentProviders: toggles});
                    } catch (e) {
                        console.error(`kaito: no se pudo guardar agentProviders: ${e.message}`);
                    }
                });
                group.add(row);
            } else {
                const row = new Adw.ActionRow({title: p.title, subtitle: 'No instalado', sensitive: false});
                group.add(row);
            }
        }
    }

    /** Horario de trabajo y No molestar. */
    _quietGroup(page, cfg) {
        const group = new Adw.PreferencesGroup({
            title: 'Horario y No molestar',
            description: 'Fuera de horario (o con No molestar del menú) Kaito no avisa ni suena: lo guarda y te lo enseña al volver. Las tareas programadas siguen ejecutándose. No cambia el No molestar de GNOME',
        });
        page.add(group);
        const wh = {...cfg.workHours, days: [...cfg.workHours.days]};
        const save = () => {
            try {
                updateConfig({workHours: wh});
            } catch (e) {
                console.error(`kaito: no se pudo guardar workHours: ${e.message}`);
            }
        };
        const use = new Adw.SwitchRow({
            title: 'Usar horario de trabajo', subtitle: 'Fuera de él, No molestar automático', active: wh.enabled,
        });
        group.add(use);

        const daysRow = new Adw.ActionRow({title: 'Días', subtitle: 'Días laborables'});
        const box = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER});
        box.add_css_class('linked');
        DAY_NAMES.forEach((name, i) => {
            const b = new Gtk.ToggleButton({label: name, active: wh.days.includes(i + 1), tooltip_text: DAY_FULL[i]});
            b.connect('toggled', () => {
                const set = new Set(wh.days);
                if (b.active)
                    set.add(i + 1);
                else
                    set.delete(i + 1);
                wh.days = [...set].sort();
                save();
            });
            box.append(b);
        });
        daysRow.add_suffix(box);
        group.add(daysRow);

        const timeRow = (title, key) => {
            const row = new Adw.EntryRow({title, text: wh[key], show_apply_button: true});
            row.connect('apply', () => {
                const m = parseHHMM(row.text);
                if (m === null) {
                    row.add_css_class('error');
                    return;
                }
                row.remove_css_class('error');
                wh[key] = fmtHHMM(m);
                row.text = wh[key];
                save();
            });
            row.connect('changed', () => {
                if (parseHHMM(row.text) !== null)
                    row.remove_css_class('error');
            });
            return row;
        };
        const start = timeRow('Empieza (HH:MM)', 'start');
        const end = timeRow('Termina (HH:MM; si es menor que el inicio, al día siguiente)', 'end');
        group.add(start);
        group.add(end);
        const sync = () => {
            for (const r of [daysRow, start, end])
                r.sensitive = use.active;
        };
        use.connect('notify::active', () => {
            wh.enabled = use.active;
            save();
            sync();
        });
        sync();
        group.add(switchRow('Silenciar también recordatorios',
            'Con No molestar, los recordatorios esperan a que termine (si no, salen sin sonido)', 'dndSilenceReminders', cfg));
    }
}
