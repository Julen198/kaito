import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    TODOS_PATH, CLAUDE_PROJECTS, TASKS_PATH, TASK_RUNS_DIR,
    PRESETS, TERMINALS, readConfig, updateConfig, readJson, writeJson, getToken, storeToken, checkJira, scanAgents,
    BUILTIN_VIEWS, normalizeCustomViews, resolveTerminal, terminalFocusLevel, ptyxisVersion, migrateTerminalOnce,
} from './common.js';

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

        // --- General ---
        const general = new Adw.PreferencesGroup({title: 'General'});
        page.add(general);
        general.add(switchRow('Mostrar siempre desplegado',
            'Panel fijo arriba a la derecha, por encima de las ventanas', 'pinned', cfg));
        general.add(switchRow('Mostrar uso de Claude y Codex',
            'Barras de los límites de 5 h y semanales. Claude necesita hooks/kaito-statusline.py (ver README); Codex se lee de ~/.codex', 'showUsage', cfg));
        general.add(switchRow('Resumen al empezar el día',
            'Primera vez a partir de las 06:00: tickets en curso, recordatorios de hoy y agentes parados', 'dailySummary', cfg));
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
        runCheck();
    }
}
