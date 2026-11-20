import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {ago, firstLine} from './agents.js';
import {CaptureModal} from './capture.js';
import {
    TODOS_PATH, CONFIG_PATH, CONF_DIR, STATE_DIR, NOTES_PATH, REMINDERS_PATH, TASKS_PATH,
    readConfig, readJson, writeJson, updateConfig, collectAgents, readAgentStates, fetchJira,
    readNotes, readReminders, readDismissed, writeDismissed, applyDismissed, ancestorPids,
    collectRepos, scanRepos, filterRepos, rankRepos, fetchIssueDescription, sendIssueToClaude, priorityKind, projectOf,
    agentsByTicket, dailySummaryLines, shouldShowDaily, readDailyDay, writeDailyDay, localDay, addReminder,
    CLAUDE_USAGE_PATH, readClaudeUsage, readCodexUsage, usageView, readOpencodeProvider,
    fetchJiraJql, visibleViews, viewJql, projectsFromIssues, resolveProjects, shortName, descriptionSnippet, ticketDetailLine, migrateTerminalOnce,
    processChain, terminalFocusTarget, cancelPendingUris,
    installedProviders, collectOtherAgents, changelogBody, readUpdateState, writeUpdateState,
    readBoard, readTodos, patchBoardTask, addBoardTask, OPEN_KANBAN_PATH, INBOX_PATH, readInbox, writeInbox,
    canDecide, writeDecision, patchReminder, repoBranch,
} from './common.js';
import {KanbanBoard} from './kanban.js';
import {InboxPanel} from './inboxui.js';
import {STATE_NAMES, isLocalKey, todoState, withState, localTaskPrompt, taskSlug} from './board.js';
import {inboxPush, inboxRoute, unreadCount, pendingNeeds, resolveItem} from './inbox.js';
import {QuietController} from './dnd.js';
import {RING, MINI_RING, RING_TRACK, DIM_OPACITY, USAGE_COLUMNS, BADGE_ICONS, hexRgb, usageRows, panelRing} from './usage.js';
import {PROVIDER_BY_ID} from './providers.js';
import {quietLabel, snoozeLabel, snoozeUntil} from './quiet.js';
import {findTicketWork, finishKey, finishLines, markFinished, prUrl, reviewReminderText} from './finish.js';
import {fetchTransitions, applyTransition, pickTransition, REVIEW_RE, assignToMe, fetchMyself} from './jiradraft.js';
import {ReminderManager} from './reminders.js';
import {ReplyModal, CommentModal, TaskResultModal} from './reply.js';
import {TaskScheduler, readTasks, patchTask, deleteTask, readLastRun, setEnabled, findingsComment} from './tasks.js';
import {shortLabel, nextLabel} from './when.js';
import {UpdateNotice} from './updates.js';
import {attachTooltip} from './tooltip.js';

const C = {live: '#5BC8AF', idle: '#9A9996', jira: '#78AEED', todo: '#F5C211', needs: '#FFA348'};
const DONE_MSG = 'Terminó, esperando tu respuesta';
const CARD_W = 380;
const CARD_MARGIN = 12;
const NOTES_SHOWN = 5;
const JIRA_MAX_H = 320; // alto máximo (px lógicos) de la lista de tickets
const SHORTCUT_KEY = 'capture-shortcut';
const KANBAN_KEY = 'kanban-shortcut'; // clave nueva del esquema (0.5.0): sin volver a entrar puede no existir aún
const STATE_PILL = {todo: 'kaito-pill-new', doing: 'kaito-pill-doing', review: 'kaito-pill-review', done: 'kaito-pill-done'};
const PILL = {new: 'kaito-pill-new', indeterminate: 'kaito-pill-progress', done: 'kaito-pill-done'};
const PICK_MAX = 12;
const PICK_PILL = {issue: 'este ticket', match: 'coincide', project: 'último'};
const DONE_MIN_MS = 3 * 60 * 1000; // aviso de "terminó" solo tras trabajar al menos esto
const MOVED_MSG = 'Movido en Jira';
const MOVE_PER_ROW = 2; // botones de "Mover a" por fila
const SINCE_SLACK_MS = 60 * 1000; // el inicio de "trabajando" se detecta con retraso (refresco)
const TASK_TICK_S = 60; // las tareas programadas se miran cada minuto
const TASK_FIRST_TICK_S = 15; // y poco después de activar (recupera las perdidas con la sesión cerrada)
const TASK_CONFIRM_MS = 4000; // "¿Borrar?" vuelve a "×" pasado esto
const REVIEW_PREFILL = key => `${key}: revisa que `;
const TABS_PER_ROW = 5; // pestañas de vistas de Jira por fila (filas fijas: nada de FlowLayout en el ScrollView)
const ASSIGNED_MSG = 'Asignado';
const ASSIGN_CLEAR_MS = 4000; // "Asignado" se quita tras refrescar y este margen
const VIEW_EMPTY = {
    unassigned: 'Nada sin asignar en tus proyectos',
    sprint: 'No hay sprint activo o no tiene tickets abiertos',
    recent: 'Nada actualizado en las últimas 24 h',
};
// Ptyxis nativo y flatpak (GApplication exporta sus acciones en org.gtk.Actions).
const PTYXIS_BUSES = [
    ['org.gnome.Ptyxis', '/org/gnome/Ptyxis'],
    ['app.devsuite.Ptyxis', '/app/devsuite/Ptyxis'],
    ['org.gnome.Ptyxis.Devel', '/org/gnome/Ptyxis/Devel'],
];
const WINDOW_KIND_RE = {ptyxis: /ptyxis/i, 'gnome-terminal': /gnome-terminal|org\.gnome\.Terminal/i};

/** Llamada D-Bus sin autoarranque (si la terminal no corre, falla en vez de abrir otra). */
function dbusCall(name, path, iface, method, params, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(name, path, iface, method, params, null, Gio.DBusCallFlags.NO_AUTO_START, 3000,
            cancellable, (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function mkLabel(text, styleClass, extra = {}) {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...extra});
}

function ellipsized(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    label.x_expand = true;
    return label;
}

/** Pastilla de estado: ancho máximo por CSS y «…» al recortar, para que el resumen conserve el sitio. */
function pillLabel(text, cls) {
    const l = mkLabel(text, `kaito-pill ${cls}`);
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function dot(color) {
    return new St.Widget({
        style_class: 'kaito-dot', style: `background-color: ${color};`,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

/** Opacidad en bucle mientras el actor está visible; se para al desmapearse o destruirse. */
function pulsing(actor) {
    const sync = () => {
        actor.remove_all_transitions();
        actor.opacity = 255;
        if (actor.mapped) {
            actor.ease({
                opacity: 60, duration: 1000, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                autoReverse: true, repeatCount: -1,
            });
        }
    };
    actor.connect('notify::mapped', sync);
    sync();
    return actor;
}

/** Botón pequeño con icono o texto para el final de una fila. */
function sideButton(accessibleName, child, onClick) {
    const btn = new St.Button({
        style_class: 'kaito-side-btn', can_focus: true, track_hover: true,
        accessible_name: accessibleName, y_align: Clutter.ActorAlign.CENTER, child,
    });
    btn.connect('clicked', onClick);
    return btn;
}

const PRIORITY_NAMES = {highest: 'Más alta', high: 'Alta', medium: 'Media', low: 'Baja', lowest: 'Más baja'};

/**
 * Anillo de uso (St.DrawingArea + Cairo): pista tenue y arco desde las 12 en el sentido del reloj, con
 * extremos redondeados. El tamaño viene del CSS (escala del tema incluida) y el trazo escala con él.
 * set({frac, color}) guarda el valor y pide repintar.
 */
function usageRing(spec = RING, styleClass = 'kaito-ring') {
    const area = new St.DrawingArea({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
    const ring = {actor: area, frac: 0, color: '#5BC8AF'};
    area.connect('repaint', a => {
        const cr = a.get_context();
        try {
            const [w, h] = a.get_surface_size();
            const size = Math.min(w, h);
            if (size <= 0)
                return;
            const lw = spec.stroke * size / spec.size;
            const r = (size - lw) / 2;
            cr.setLineWidth(lw);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setSourceRGBA(...RING_TRACK);
            cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI);
            cr.stroke();
            if (ring.frac > 0) {
                const start = -Math.PI / 2;
                cr.setSourceRGBA(...hexRgb(ring.color), 1);
                cr.arc(w / 2, h / 2, r, start, start + 2 * Math.PI * ring.frac);
                cr.stroke();
            }
        } finally {
            cr.$dispose();
        }
    });
    ring.set = ({frac, color}) => {
        ring.frac = frac;
        ring.color = color;
        area.queue_repaint();
    };
    return ring;
}

const badgeIconCache = new Map();
/** Icono que instala la app del proveedor en el tema (hicolor: /usr/share/icons, ~/.local/share/icons), o null. */
function providerIconName(id) {
    if (!badgeIconCache.has(id)) {
        let found = null;
        try {
            const theme = new St.IconTheme();
            found = (BADGE_ICONS[id] ?? []).find(n => theme.lookup_icon(n, 32, 0)) ?? null;
        } catch (e) {
            console.warn(`kaito: icono de ${id}: ${e.message}`);
        }
        badgeIconCache.set(id, found);
    }
    return badgeIconCache.get(id);
}

/** Insignia de 30 px: el icono del proveedor si está instalado; si no, su inicial sobre su color. */
function providerBadge(row) {
    const icon = providerIconName(row.id);
    const box = new St.Bin({
        style_class: icon ? 'kaito-usage-badge kaito-usage-badge-icon' : 'kaito-usage-badge',
        style: icon ? null : `background-color: ${row.badge.bg};`,
        y_align: Clutter.ActorAlign.CENTER, reactive: true, track_hover: true, accessible_name: row.tooltip,
    });
    box.set_child(icon
        ? new St.Icon({icon_name: icon, icon_size: 28})
        : new St.Label({text: row.badge.letter, style_class: 'kaito-usage-letter', style: `color: ${row.badge.fg};`,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
    return box;
}

function spacer() {
    return new St.Widget({x_expand: true});
}

const agentRank = a => a.state === 'needs' ? 0 : a.state === 'done' ? 1 : a.live ? 2 : 3;

/** Contenedor horizontal de una fila: lo comparten el menú y la tarjeta fija. */
function content() {
    return new St.BoxLayout({style_class: 'kaito-content', x_expand: true});
}

/** Fila no clicable pero sin atenuar (reactive:false, no setSensitive). */
function staticItem() {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'kaito-row'});
    return item;
}

const SECTIONS = [
    ['usage', 'Uso'], ['agents', 'Agentes'], ['jira', 'Jira'], ['todos', 'Pendientes'],
    ['reminders', 'Recordatorios'], ['tasks', 'Tareas programadas'], ['notes', 'Notas'],
];
const PANEL_ICONS = {
    agentsLive: 'agents-live', agentsIdle: 'agents-idle', agentsNeeds: 'agents-needs',
    jira: 'jira', todos: 'todos',
};

/** "<Control><Alt>space" -> "Ctrl+Alt+Espacio" */
function prettyAccel(accel) {
    if (!accel)
        return '';
    return accel.replace(/<Primary>|<Control>/gi, 'Ctrl+').replace(/<Alt>/gi, 'Alt+')
        .replace(/<Shift>/gi, 'Mayús+').replace(/<Super>/gi, 'Super+')
        .replace(/space$/i, 'Espacio').replace(/\+([a-z])$/, (_m, c) => `+${c.toUpperCase()}`);
}

// PanelMenu.Button de GNOME 46–49 abre el menú en vfunc_event; el de 50 usa un Clutter.ClickGesture.
const PANEL_BUTTON_HAS_EVENT = Object.prototype.hasOwnProperty.call(PanelMenu.Button.prototype, 'vfunc_event');

// Clase GObject registrada una vez por evaluación del módulo. Cada build recargada en caliente es un
// módulo nuevo y GType no admite dos tipos con el mismo nombre: el nombre lleva el id de la build.
let Indicator = null;
const indicatorClass = loadId => (Indicator ??= GObject.registerClass({
    GTypeName: `KaitoIndicator_${String(loadId).replace(/[^A-Za-z0-9_]/g, '_')}`,
}, class KaitoIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Kaito');
        this._ext = extension;
        this._cfg = readConfig();
        this._icons = {};
        for (const [k, name] of Object.entries(PANEL_ICONS))
            this._icons[k] = new Gio.FileIcon({file: Gio.File.new_for_path(`${extension.path}/icons/${name}.svg`)});
        for (const k of Object.keys(PRIORITY_NAMES))
            this._icons[`prio-${k}`] = new Gio.FileIcon({file: Gio.File.new_for_path(`${extension.path}/icons/priority-${k}.svg`)});
        this._buildPanel();
        // GNOME 50: PanelMenu.Button abre el menú con un Clutter.ClickGesture que reconoce al pulsar y se
        // adelantaría al clic de la campana; ahí no se deja reconocer si la pulsación cae en la campana.
        this._clickGesture?.connect?.('may-recognize', g => !this._pressOnBell(g));
        this.menu.box.add_style_class_name('kaito-menu');
        this._session = new Soup.Session({timeout: 15});
        this._cancellable = new Gio.Cancellable();
        this._counts = {usage: 0, agents: 0, jira: 0, todos: 0, reminders: 0, tasks: 0, notes: 0};
        this._tasksTotal = 0; // incluidas las hechas: la sección se oculta si no hay ninguna
        this._taskConfirm = null; // id de la tarea con "¿Borrar?" pendiente
        this._live = false;
        this._agents = [];
        this._agentsError = null;
        this._needsIds = null; // null hasta la primera carga: no avisar de lo que ya estaba
        this._jira = {error: null, setup: null, issues: []};
        this._jiraPick = null; // {issue, repos, query, focus, entries} mientras se elige repo para mandar a Claude
        this._deb = {};
        this._monitors = [];
        this._card = null;
        this._busySince = null; // Map sessionId -> ms desde que trabaja; null hasta la primera carga
        this._needNotes = new Map(); // sessionId -> notificación "te necesita"
        this._byTicket = {}; // clave Jira -> agente vivo lanzado con ese ticket
        this._ticketSig = '';
        this._jiraExpand = null; // {key, loading, transitions, error, done, busy} fila con "Cambiar estado" abierta
        this._jiraView = this._cfg.jiraView; // pestaña activa ('mine' = "Mías", la del contador del panel)
        this._jiraLoaded = false; // "Mías" cargada al menos una vez (de ella salen los proyectos)
        this._views = {}; // id -> {issues, base, error, msg, loading, fetching, t}; "Mías" vive en this._jira
        this._assign = {}; // clave -> {busy, done, error} de "Asignarme"
        this._myId = null; // tu accountId (para "Asignarme" en el sprint)
        this._tabButtons = [];
        this._assignTimers = new Set();
        this._viewsSig = JSON.stringify(visibleViews(this._cfg));
        this._cfgSig = this._configSig();
        this._source = null;

        this._sections = {};
        this._counters = {};
        this._headers = {};
        this._usage = {claude: null, codex: null};
        this._usageRows = [];
        for (const [id, title] of SECTIONS) {
            this._addHeader(id, title);
            this._sections[id] = new PopupMenu.PopupMenuSection();
            if (id === 'jira') {
                // Pestañas de vistas bajo la cabecera, fuera del scroll.
                this._jiraTabsItem = staticItem();
                this._jiraTabsBox = new St.BoxLayout({style_class: 'kaito-tabs', vertical: true, x_expand: true});
                this._jiraTabsItem.add_child(this._jiraTabsBox);
                this.menu.addMenuItem(this._jiraTabsItem);
                // Lista de tickets desplazable; la cabecera con el contador queda fuera.
                this._jiraScroll = new St.ScrollView({
                    hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
                    overlay_scrollbars: true, x_expand: true,
                });
                this._jiraScroll.set_child(this._sections[id].actor);
                const wrap = new PopupMenu.PopupMenuSection();
                wrap.actor.add_child(this._jiraScroll);
                this.menu.addMenuItem(wrap);
                this._jiraWrap = wrap;
                this._applyMenuCap();
            } else {
                this.menu.addMenuItem(this._sections[id]);
            }
        }
        this._buildEntry();
        this._renderJiraTabs();
        // Aviso de versión nueva, arriba del todo (oculto si no hay o si no es un checkout de git).
        this._update = new UpdateNotice(extension, {
            onState: n => this._syncUpdateBadge(n),
            onAvailable: c => this._onUpdateAvailable(c),
        });
        this.menu.addMenuItem(this._update.item, 0);
        this._syncUpdateBadge(this._update);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._syncMenuTone();
                this._applyMenuCap();
                this._refresh();
            } else if (this._jiraPick) {
                this._jiraPick = null;
                this._renderSection('jira');
                this._renderJiraTabs();
            }
        });
        this._overviewIds = [
            Main.overview.connect('showing', () => this._updateCardVisibility()),
            Main.overview.connect('hidden', () => this._updateCardVisibility()),
        ];
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._placeCard());

        GLib.mkdir_with_parents(STATE_DIR, 0o755);
        GLib.mkdir_with_parents(CONF_DIR, 0o755);
        this._inboxStats = {unread: 0, needs: false};
        // Estados de los hooks: solo agentes. Config (p. ej. "pinned" desde Ajustes): todo.
        this._watch(Gio.File.new_for_path(STATE_DIR), 'dir', 'state', () => this.refreshLocal());
        this._watch(Gio.File.new_for_path(CONFIG_PATH), 'file', 'config', () => this._onConfigChanged());
        this._watch(Gio.File.new_for_path(CLAUDE_USAGE_PATH), 'file', 'usage', () => this._refreshUsage());
        this._watch(Gio.File.new_for_path(TASKS_PATH), 'file', 'tasks', () => {
            this._renderSection('tasks');
            this._updateLabel();
        });
        // Tablero: todos.json cambiado desde otro sitio (tablero, prefs) y `kaito kanban`.
        this._watch(Gio.File.new_for_path(TODOS_PATH), 'file', 'todos', () => {
            this._renderSection('todos');
            this._updateLabel();
            this._ext.kanban?.refresh();
        });
        this._watch(Gio.File.new_for_path(OPEN_KANBAN_PATH), 'file', 'open-kanban', () => {
            if (!GLib.file_test(OPEN_KANBAN_PATH, GLib.FileTest.EXISTS))
                return;
            if (readConfig().kanbanEnabled)
                this._ext.openKanban();
            else
                Main.notify('Kaito', 'El tablero de tareas está desactivado: actívalo en Ajustes');
        });
        this._watch(Gio.File.new_for_path(INBOX_PATH), 'file', 'inbox', () => {
            this._loadInboxStats();
            this._updateLabel();
            this._ext.inbox?.refresh();
        });
        for (const [path, key] of [[NOTES_PATH, 'notes'], [REMINDERS_PATH, 'reminders']]) {
            this._watch(Gio.File.new_for_path(path), 'file', key, () => {
                this._renderSection(key);
                this._updateLabel();
                this._ext.checkReminders();
            });
        }

        this._refresh();
        this._schedule();
    }

    /** Limita la lista de Jira y todo el menú al área útil del monitor. */
    // Los colores de Kaito son claros (menú oscuro de GNOME). Con un tema de menús claro (Yaru en Ubuntu 26.04)
    // se vería blanco sobre blanco: ahí se fuerza el fondo oscuro de nuestro menú.
    _syncMenuTone() {
        try {
            const box = this.menu.box;
            box.remove_style_class_name('kaito-force-dark');
            box.ensure_style();
            const c = box.get_theme_node().get_background_color();
            if (c.alpha > 128 && (0.299 * c.red + 0.587 * c.green + 0.114 * c.blue) / 255 > 0.6)
                box.add_style_class_name('kaito-force-dark');
        } catch (e) {
            console.warn(`kaito: tono del menú: ${e.message}`);
        }
    }

    _applyMenuCap() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const boxMax = Math.max(200, Math.floor(area.height / scale) - 16);
        this.menu.box.set_style(`max-height: ${boxMax}px;`);
        this._jiraScroll.set_style(`max-height: ${Math.min(JIRA_MAX_H, Math.floor(boxMax * 0.5))}px;`);
    }

    _watch(file, kind, key, fn) {
        try {
            const m = kind === 'dir'
                ? file.monitor_directory(Gio.FileMonitorFlags.NONE, null)
                : file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            m.connect('changed', () => this._debounce(key, fn));
            this._monitors.push(m);
        } catch (e) {
            console.error(`kaito: no se pudo vigilar ${file.get_path()}: ${e.message}`);
        }
    }

    _debounce(key, fn) {
        if (this._deb[key])
            GLib.source_remove(this._deb[key]);
        this._deb[key] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._deb[key] = 0;
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** (Re)crea el temporizador si refreshSeconds ha cambiado. */
    _schedule() {
        const secs = this._cfg.refreshSeconds;
        if (this._timeoutId && secs === this._scheduledSecs)
            return;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._scheduledSecs = secs;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildPanel() {
        const box = new St.BoxLayout({style_class: 'kaito-panel', y_align: Clutter.ActorAlign.CENTER});
        this._panelBox = box;
        // No molestar: luna delante de los contadores (y el indicador algo atenuado).
        this._moon = new St.Icon({
            icon_name: 'weather-clear-night-symbolic', icon_size: 14, visible: false,
            style_class: 'kaito-icon kaito-moon', y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._moon);
        this._seg = {};
        for (const id of ['agents', 'jira', 'todos']) {
            const seg = new St.BoxLayout({style_class: 'kaito-seg', y_align: Clutter.ActorAlign.CENTER});
            const d = new St.Icon({
                gicon: this._icons[id === 'agents' ? 'agentsIdle' : id], icon_size: 15,
                style_class: 'kaito-icon', y_align: Clutter.ActorAlign.CENTER,
            });
            const n = mkLabel('0', 'kaito-count');
            seg.add_child(d);
            seg.add_child(n);
            box.add_child(seg);
            this._seg[id] = {seg, dot: d, num: n};
        }
        // Panel de avisos (opcional): campana con los no leídos y punto naranja si alguien te necesita.
        // Botón propio: su clic no abre el menú (el St.Button se queda el evento).
        const bellBox = new St.BoxLayout({style_class: 'kaito-seg', y_align: Clutter.ActorAlign.CENTER});
        bellBox.add_child(new St.Icon({
            icon_name: 'preferences-system-notifications-symbolic', icon_size: 15,
            style_class: 'kaito-icon', y_align: Clutter.ActorAlign.CENTER,
        }));
        const bellNum = mkLabel('0', 'kaito-count');
        bellBox.add_child(bellNum);
        const bellDot = new St.Widget({style_class: 'kaito-bell-dot', visible: false, y_align: Clutter.ActorAlign.START});
        bellBox.add_child(bellDot);
        const bell = new St.Button({
            style_class: 'kaito-bell', child: bellBox, can_focus: true, track_hover: true, visible: false,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: 'Avisos',
        });
        bell.connect('clicked', () => {
            this.menu.close();
            this._ext.openInbox();
        });
        box.add_child(bell);
        this._bell = {btn: bell, num: bellNum, dot: bellDot};
        // Mini anillo del uso de 5 h (proveedor de Ajustes, Claude por defecto), tras los segmentos; oculto sin datos.
        this._mini = usageRing(MINI_RING, 'kaito-ring-mini');
        this._mini.actor.visible = false;
        box.add_child(this._mini.actor);
        // Punto de "hay versión nueva", arriba a la derecha del indicador, hasta actualizar.
        this._badge = new St.Widget({style_class: 'kaito-update-badge', visible: false, y_align: Clutter.ActorAlign.START});
        box.add_child(this._badge);
        this.add_child(box);
    }

    _pressOnBell(gesture) {
        let p = null;
        try {
            p = gesture.get_coords_abs?.();
        } catch (_e) { /* sin coordenadas: se usa el hover */ }
        return this._onBell(p ? [p.x, p.y] : null);
    }

    /** ¿Cae el punto (coordenadas de escenario) en la campana visible? Sin punto: su hover. */
    _onBell(xy) {
        const bell = this._bell?.btn;
        if (!bell?.visible || !bell.mapped)
            return false;
        if (!xy)
            return bell.hover;
        const [x, y] = bell.get_transformed_position();
        const [w, h] = bell.get_transformed_size();
        return xy[0] >= x && xy[0] < x + w && xy[1] >= y && xy[1] < y + h;
    }

    // GNOME 46–49: PanelMenu.Button abre el menú en vfunc_event al pulsar. En 49 el St.Button de la campana
    // ya no se queda la pulsación (usa gestos), así que una pulsación sobre la campana no abre el menú.
    vfunc_event(event) {
        const t = event.type();
        if (!PANEL_BUTTON_HAS_EVENT) // GNOME 50: gestos; St/Clutter no implementan vfunc_event (llamarlo lanza)
            return Clutter.EVENT_PROPAGATE;
        if ((t === Clutter.EventType.BUTTON_PRESS || t === Clutter.EventType.TOUCH_BEGIN) && this._onBell(event.get_coords()))
            return Clutter.EVENT_PROPAGATE;
        return super.vfunc_event(event);
    }

    /** Punto del panel según el aviso de actualización. */
    _syncUpdateBadge(notice) {
        this._updatePending = !!notice?.pending;
        this._badge.visible = this._updatePending;
        if (this._update)
            this._updateLabel();
    }

    /** Versión nueva: una notificación por versión (update.json), retenida si hay No molestar. */
    _onUpdateAvailable(c) {
        const version = c.latest ?? '?';
        try {
            if (readUpdateState().notified === version)
                return;
            writeUpdateState({notified: version, at: Date.now()});
        } catch (e) {
            console.warn(`kaito: update.json: ${e.message}`);
        }
        const title = `Kaito ${version} disponible`;
        if (this._cfg.inboxEnabled) { // solo panel (y el punto azul de siempre)
            this._ext.inboxAdd({
                id: `update:${version}`, kind: 'update', title, body: changelogBody(c.changes),
                actions: [{label: 'Actualizar', action: {type: 'update'}}],
            });
            return;
        }
        if (this._ext.quiet?.defer({key: 'update', text: title, action: {type: 'update'}}))
            return;
        const update = () => this._update?.update().catch(e => console.warn(`kaito: actualizar: ${e.message}`));
        this._notify(title, changelogBody(c.changes), {
            activate: update,
            actions: [['Actualizar', update], ['Más tarde', () => {}]],
        });
    }

    /** Estado de No molestar en el panel y en el menú. */
    syncQuiet(q = this._ext.quiet?.state) {
        const quiet = !!q?.quiet;
        this._moon.visible = quiet;
        this._panelBox.opacity = quiet ? 170 : 255;
        if (this._dnd) {
            this._dnd.sw.setToggleState(q?.reason === 'manual');
            const text = quiet ? quietLabel(q, new Date()) : 'Avisos activados';
            this._dnd.status.set_text(text);
            this._dnd.off.visible = quiet;
        }
        if (this._update)
            this._updateLabel();
    }

    _headerRow(title) {
        const count = mkLabel('0', 'kaito-header-text');
        return {count, title: mkLabel(title, 'kaito-header-text'), spacer: spacer()};
    }

    _addHeader(id, title) {
        const item = staticItem();
        item.add_style_class_name('kaito-header');
        const h = this._headerRow(title);
        (this._headerTitles ??= {})[id] = h.title;
        item.add_child(h.title);
        item.add_child(h.spacer);
        item.add_child(h.count);
        this._counters[id] = h.count;
        this._headers[id] = item;
        this.menu.addMenuItem(item);
    }

    _emptySpec(text) {
        return {actor: ellipsized(mkLabel(text, 'kaito-muted'))};
    }

    /** Añade un pendiente; lo usan la entrada del menú y la de la tarjeta fija. */
    _makeEntry() {
        const entry = new St.Entry({
            style_class: 'kaito-entry', hint_text: 'Añadir pendiente y pulsar Enter',
            can_focus: true, x_expand: true,
        });
        entry.clutter_text.connect('activate', () => {
            const text = entry.get_text().trim();
            if (!text)
                return;
            if (this._cfg.kanbanEnabled) {
                try {
                    addBoardTask({text});
                } catch (e) {
                    console.error(`kaito: no se pudo guardar la tarea: ${e.message}`);
                }
                this._renderSection('todos');
                this._updateLabel();
                this._ext.kanban?.refresh();
            } else {
                const todos = readJson(TODOS_PATH, []);
                todos.push({text, done: false});
                this._saveTodos(todos);
            }
            entry.set_text('');
        });
        (this._todoEntries ??= new Set()).add(entry);
        entry.connect('destroy', () => this._todoEntries?.delete(entry));
        if (this._cfg.kanbanEnabled)
            entry.hint_text = 'Añadir tarea y pulsar Enter';
        return entry;
    }

    _buildEntry() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'kaito-row'});
        item.add_child(this._makeEntry());
        this.menu.addMenuItem(item);

        // Opcionales (Ajustes): tablero de tareas y panel de avisos; ocultos si están desactivados.
        const board = new PopupMenu.PopupMenuItem('Abrir tablero');
        this._kanbanLabel = mkLabel('', 'kaito-muted');
        this._kanbanLabel.x_expand = true;
        this._kanbanLabel.x_align = Clutter.ActorAlign.END;
        board.add_child(this._kanbanLabel);
        board.connect('activate', () => this._ext.openKanban());
        board.visible = false;
        this.menu.addMenuItem(board);
        this._kanbanItem = board;
        const inbox = new PopupMenu.PopupMenuItem('Avisos');
        inbox.connect('activate', () => this._ext.openInbox());
        inbox.visible = false;
        this.menu.addMenuItem(inbox);
        this._inboxItem = inbox;

        const capture = new PopupMenu.PopupMenuItem('Nueva nota, recordatorio o tarea');
        this._shortcutLabel = mkLabel('', 'kaito-muted');
        this._shortcutLabel.x_expand = true;
        this._shortcutLabel.x_align = Clutter.ActorAlign.END;
        capture.add_child(this._shortcutLabel);
        capture.connect('activate', () => this._ext.openCapture());
        this.menu.addMenuItem(capture);
        this.syncShortcutLabel();

        this._buildDnd();

        const prefs = new PopupMenu.PopupMenuItem('Ajustes');
        prefs.add_style_class_name('kaito-settings');
        prefs.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefs);
    }

    /** "No molestar": interruptor (manual, sin límite) + 1 h, Hasta mañana y Desactivar. */
    _buildDnd() {
        const sw = new PopupMenu.PopupSwitchMenuItem('No molestar', false);
        sw.add_style_class_name('kaito-dnd');
        // En GNOME 50 setToggleState() (syncQuiet) también emite 'toggled': si ya está en ese estado no se toca,
        // o "1 h", "Hasta mañana" y los minutos del panel de avisos se convertirían en "sin límite".
        sw.connect('toggled', (_i, on) => {
            if (on !== (this._ext.quiet?.state?.reason === 'manual'))
                this._ext.quiet?.set(on ? 'on' : 'off');
        });
        this.menu.addMenuItem(sw);
        const row = staticItem();
        row.add_style_class_name('kaito-dnd-row');
        const status = ellipsized(mkLabel('', 'kaito-muted kaito-dnd-status'));
        row.add_child(status);
        const btn = (label, mode) => {
            const b = new St.Button({
                label, style_class: 'kaito-dnd-btn', can_focus: true, track_hover: true,
                y_align: Clutter.ActorAlign.CENTER, accessible_name: `No molestar: ${label}`,
            });
            b.connect('clicked', () => this._ext.quiet?.set(mode));
            row.add_child(b);
            return b;
        };
        btn('1 h', 'hour');
        btn('Hasta mañana', 'tomorrow');
        const off = btn('Desactivar', 'off');
        this.menu.addMenuItem(row);
        this._dnd = {sw, status, off};
        this.syncQuiet();
    }

    syncShortcutLabel() {
        const settings = this._ext.getSettings();
        const [accel] = settings.get_strv(SHORTCUT_KEY);
        this._shortcutLabel.set_text(prettyAccel(accel));
        const kb = settings.settings_schema.has_key(KANBAN_KEY) ? settings.get_strv(KANBAN_KEY)[0] : '';
        this._kanbanLabel?.set_text(prettyAccel(kb));
    }

    /** Tablero y avisos opcionales: menú, cabecera "Tareas", campana y atajo según Ajustes. */
    _syncFeatures() {
        const kanban = this._cfg.kanbanEnabled, inbox = this._cfg.inboxEnabled;
        this._kanbanItem.visible = kanban;
        this._inboxItem.visible = inbox;
        this._bell.btn.visible = inbox;
        const title = kanban ? 'Tareas' : 'Pendientes';
        this._headerTitles?.todos?.set_text(title);
        this._cardTitles?.todos?.set_text(title);
        for (const e of this._todoEntries ?? [])
            e.hint_text = kanban ? 'Añadir tarea y pulsar Enter' : 'Añadir pendiente y pulsar Enter';
        this._ext.syncKanbanKey?.(kanban);
        if (!kanban)
            this._ext.kanban?.close();
        if (!inbox)
            this._ext.inbox?.close();
        if (this._features !== `${kanban}|${inbox}`) {
            this._features = `${kanban}|${inbox}`;
            this._loadInboxStats();
        }
    }

    /** Contadores de la campana (no leídos, "te necesita" sin resolver) desde inbox.json. */
    _loadInboxStats() {
        let list = [];
        if (this._cfg.inboxEnabled) {
            try {
                list = readInbox();
            } catch (e) {
                console.warn(`kaito: inbox.json: ${e.message}`);
            }
        }
        this._inboxStats = {unread: unreadCount(list), needs: pendingNeeds(list)};
        if (this._inboxItem)
            this._inboxItem.label.text = this._inboxStats.unread ? `Avisos (${this._inboxStats.unread})` : 'Avisos';
    }

    _saveTodos(todos) {
        try {
            writeJson(TODOS_PATH, todos);
        } catch (e) {
            console.error(`kaito: no se pudo guardar todos: ${e.message}`);
        }
        this._renderSection('todos');
        this._updateLabel();
    }

    // --- Datos -> specs {actor, activate?, cls?}. Los consumen el menú y la tarjeta fija. ---

    _specs(id) {
        return this[`_${id}Specs`]();
    }

    _loadAgents() {
        try {
            const states = readAgentStates();
            const on = this._cfg.agentProviders;
            const agents = on.claude ? collectAgents(this._cfg.agentWindowMinutes * 60, states, this._cfg.liveSeconds) : [];
            // Codex, Gemini…: solo los instalados y activados en Ajustes (sin ninguno no se mira /proc).
            const others = installedProviders().filter(p => p.id !== 'claude' && p.installed && on[p.id]).map(p => p.id);
            if (others.length) {
                try {
                    agents.push(...collectOtherAgents(others, states, this._cfg.liveSeconds));
                } catch (e) {
                    console.warn(`kaito: agentes de ${others.join(', ')}: ${e.message}`);
                }
            }
            agents.sort((a, b) => agentRank(a) - agentRank(b) || a.age - b.age);
            const d = applyDismissed(agents, readDismissed());
            if (d.changed)
                writeDismissed(d.dismissed);
            this._agents = d.visible;
            this._agentsError = null;
            this._live = this._agents.some(a => a.live);
            this._byTicket = agentsByTicket(agents.filter(a => Number.isInteger(a.pid)));
            this._checkNeeds(agents);
            this._checkDone(agents);
        } catch (e) {
            this._agents = [];
            this._agentsError = e.message;
            this._live = false;
        }
        this._counts.agents = this._agents.length;
    }

    /** Aviso y pulso solo cuando una sesión ENTRA en "needs", no en cada refresco. */
    _checkNeeds(agents) {
        const now = new Set(agents.filter(a => a.state === 'needs').map(a => a.id));
        const prev = this._needsIds;
        this._needsIds = now;
        // Panel de avisos: lo que ya no espera (contestado aquí o en la terminal) queda resuelto.
        if (this._cfg.inboxEnabled && prev) {
            for (const id of prev) {
                if (!now.has(id))
                    this._ext.inboxResolveNeeds(id, 'Ya no espera respuesta');
            }
        }
        // Ya no te necesita (respondido aquí o en la terminal): fuera su notificación.
        for (const [id, n] of this._needNotes) {
            if (!now.has(id)) {
                this._needNotes.delete(id);
                n.destroy();
            }
        }
        if (prev === null)
            return;
        const fresh = agents.filter(a => now.has(a.id) && !prev.has(a.id));
        if (!fresh.length)
            return;
        if (this._cfg.inboxEnabled) {
            // Siempre al panel; interrumpe también con No molestar manual, no fuera de horario.
            for (const a of fresh)
                this._ext.inboxAdd(this._needsItem(a));
            if (inboxRoute('needs', this._ext.quiet?.state) !== 'interrupt')
                return;
            this._pulse();
            if (this._cfg.notifyNeeds)
                this._notifyNeeds(fresh);
            return;
        }
        if (this._ext.quiet?.quiet) {
            if (this._cfg.notifyNeeds) {
                for (const a of fresh)
                    this._ext.quiet.defer({key: `needs:${a.id}`, text: `${a.cwd ?? '?'} te necesitaba`, action: {type: 'agent', id: a.id}});
            }
            return;
        }
        this._pulse();
        if (!this._cfg.notifyNeeds)
            return;
        this._notifyNeeds(fresh);
    }

    /** Aviso del panel para un agente que te necesita. */
    _needsItem(a) {
        const h = a.hook ?? {};
        return {
            id: `needs:${a.id}:${h.ts ?? Math.floor(Date.now() / 1000)}`, kind: 'needs', agentId: a.id,
            provider: a.provider ?? 'claude', repo: a.cwd ?? null,
            title: h.kind === 'permission' ? 'Te pide permiso' : 'Te necesita',
            body: a.message ?? 'Te necesita', cmd: h.detail ? `${h.tool ? `${h.tool}: ` : ''}${h.detail}` : h.tool ?? null,
            actions: Number.isInteger(a.pid) ? [{label: 'Ir al agente', action: {type: 'agent', id: a.id}}] : [],
        };
    }

    _notifyNeeds(fresh) {
        for (const a of fresh) {
            // Si ya estás mirando su terminal, el diálogo lo tienes delante.
            if (this._agentFocused(a))
                continue;
            const n = this._notify(`${a.cwd ?? '?'} te necesita`, a.message ?? 'Te necesita', {
                activate: () => this.replyTo(a.id),
                actions: [['Responder', () => this.replyTo(a.id)], ['Ir a la terminal', () => this.focusAgent(a)]],
            });
            this._needNotes.set(a.id, n);
            n.connect('destroy', () => {
                if (this._needNotes.get(a.id) === n)
                    this._needNotes.delete(a.id);
            });
        }
    }

    /** Abre el cuadro de respuesta con el estado actual del agente (o su terminal si ya no te necesita). */
    replyTo(id) {
        const a = this._agents.find(x => x.id === id);
        if (a?.state === 'needs')
            this._ext.openReply(a);
        else if (a)
            this.focusAgent(a);
    }

    /** Notificación propia (con acciones). */
    _notify(title, body, {activate = null, actions = []} = {}) {
        if (!this._source) {
            this._source = new MessageTray.Source({title: 'Kaito', iconName: 'utilities-terminal-symbolic'});
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        const n = new MessageTray.Notification({source: this._source, title, body});
        if (activate)
            n.connect('activated', activate);
        for (const [label, cb] of actions)
            n.addAction(label, cb);
        this._source.addNotification(n);
        return n;
    }

    /** Aviso cuando un agente pasa de trabajar a parado tras >= DONE_MIN_MS trabajando. */
    _checkDone(agents) {
        const now = Date.now();
        const prev = this._busySince;
        const next = new Map();
        for (const a of agents) {
            const since = prev?.get(a.id);
            if (a.live && a.state !== 'done' && a.state !== 'needs') {
                next.set(a.id, since ?? now);
            } else if (since !== undefined && a.state === 'needs') {
                next.set(a.id, since); // esperando un permiso no corta la tarea
            } else if (since !== undefined) {
                const ms = now - since;
                if (this._cfg.autoReview && a.ticket && a.cwdPath)
                    this._onTicketFinish(a, since, ms); // decide entre tarjeta "listo" y aviso normal
                else if (ms >= DONE_MIN_MS && this._cfg.notifyDone)
                    this._notifyDone(a, Math.round(ms / 60000));
            }
        }
        this._busySince = next;
    }

    /**
     * Agente de un ticket que deja de trabajar. Con commits nuevos desde que empezó: mueve el ticket a
     * revisión, crea el recordatorio de revisar y muestra la tarjeta "listo" (sin el aviso normal).
     * Sin commits: el aviso normal de "terminó" si trabajó >= DONE_MIN_MS. Una vez por sesión y HEAD.
     */
    async _onTicketFinish(a, since, ms) {
        const mins = Math.round(ms / 60000);
        let work = null;
        try {
            work = await findTicketWork(a.cwdPath, a.ticket, Math.floor((since - SINCE_SLACK_MS) / 1000), this._cancellable,
                {sessionId: a.id, roots: this._cfg.repoRoots});
        } catch (e) {
            console.warn(`kaito: git en ${a.cwdPath}: ${e.message}`);
        }
        if (this._cancellable.is_cancelled())
            return;
        if (!work?.commits.length) {
            if (ms >= DONE_MIN_MS && this._cfg.notifyDone)
                this._notifyDone(a, mins);
            return;
        }
        const key = finishKey(a.id, work.head);
        try {
            if (!markFinished(key))
                return;
        } catch (e) {
            console.warn(`kaito: finished.json: ${e.message}`);
        }
        const local = this._localTask(a.ticket); // tarea K-<n> del tablero: nada de Jira
        const issue = local ? null : this._jira.issues.find(i => i.key === a.ticket);
        const jira = this._cfg.jiraEnabled && !local; // sin Jira: tarjeta con lo de git, sin mover el ticket
        let moved = null, reason = null;
        if (local) {
            try {
                const t = patchBoardTask(a.ticket, x => (todoState(x) === 'done' || todoState(x) === 'review' ? x : withState(x, 'review')));
                moved = t ? STATE_NAMES[todoState(t)] : null;
                reason = t ? null : 'la tarea ya no existe en el tablero';
            } catch (e) {
                reason = e.message;
                console.warn(`kaito: tablero ${a.ticket}: ${e.message}`);
            }
            this._ext.kanban?.refresh();
        } else if (!jira) {
            // nada que mover
        } else if (issue && REVIEW_RE.test(issue.status)) {
            reason = `ya estaba en ${issue.status}`;
        } else {
            try {
                const t = pickTransition(await fetchTransitions(this._session, a.ticket), 'review');
                if (!t) {
                    reason = 'no hay transición a revisión o pruebas';
                } else {
                    await applyTransition(this._session, a.ticket, t.id);
                    moved = t.to || t.name;
                }
            } catch (e) {
                reason = e.message;
                console.warn(`kaito: no se pudo mover ${a.ticket}: ${e.message}`);
            }
        }
        if (this._cancellable.is_cancelled())
            return;
        let remindAt = null;
        const rm = this._cfg.reviewReminderMinutes;
        if (rm > 0) {
            try {
                remindAt = new Date(Date.now() + rm * 60000);
                addReminder(reviewReminderText(a.ticket, local?.text ?? issue?.summary ?? ''), remindAt);
            } catch (e) {
                remindAt = null;
                console.warn(`kaito: recordatorio de revisión: ${e.message}`);
            }
        }
        this._ext.showFinished({
            id: key,
            agentId: a.id,
            provider: a.provider ?? 'claude',
            repo: a.cwd ?? null,
            ticket: a.ticket,
            title: `${a.ticket} listo`,
            meta: `${a.cwd ?? '?'}${work.repo !== a.cwdPath ? ` · en ${GLib.path_get_basename(work.repo)}` : ''} · ${mins} min`,
            lines: finishLines({work, moved, reason, lastText: a.lastText, remindAt}),
            prUrl: work.pushed ? prUrl(work.remote, work.branch) : null,
            onFocus: Number.isInteger(a.pid) ? () => this.focusAgent(a) : null,
            onSchedule: jira || local ? () => this._ext.openTaskCapture(REVIEW_PREFILL(a.ticket)) : null,
        });
        if (moved)
            this._refresh();
    }

    /** Tarea K-<n> del tablero con esa clave (o null: entonces es un ticket de Jira). */
    _localTask(key) {
        if (!isLocalKey(key))
            return null;
        try {
            return readTodos().find(t => t?.id === key) ?? null;
        } catch (_e) {
            return null;
        }
    }

    async _notifyDone(a, mins) {
        const title = `${a.cwd ?? '?'} terminó · ${mins} min`;
        const jiraTicket = a.ticket && this._cfg.jiraEnabled && !this._localTask(a.ticket);
        if (this._cfg.inboxEnabled) {
            const items = [{label: 'Ir al agente', action: {type: 'agent', id: a.id}}];
            if (jiraTicket)
                items.push({label: 'Comentar en Jira', action: {type: 'comment', ticket: a.ticket, cwdPath: a.cwdPath ?? null, cwd: a.cwd ?? null}});
            this._ext.inboxAdd({
                id: `done:${a.id}:${Math.floor(Date.now() / 60000)}`, kind: 'done', agentId: a.id,
                provider: a.provider ?? 'claude', repo: a.cwd ?? null, title: `Terminó · ${mins} min`,
                body: firstLine(a.lastText) || DONE_MSG, actions: items,
            });
            if (inboxRoute('done', this._ext.quiet?.state) !== 'brief')
                return;
        } else if (this._ext.quiet?.defer({key: `done:${a.id}`, text: title, action: {type: 'agent', id: a.id}})) {
            return;
        }
        const actions = [['Ir al agente', () => this.focusAgent(a)]];
        if (jiraTicket) {
            actions.push(['Comentar en Jira', () => this._ext.openComment(a, this._issueSummary(a.ticket))]);
            try {
                const t = pickTransition(await fetchTransitions(this._session, a.ticket), 'review');
                if (t)
                    actions.push([`Mover a ${t.to}`, () => this._moveFromNotification(a.ticket, t)]);
            } catch (e) {
                console.warn(`kaito: transiciones de ${a.ticket}: ${e.message}`);
            }
            if (this._cancellable.is_cancelled())
                return;
        }
        this._notify(title, firstLine(a.lastText) || DONE_MSG,
            {activate: actions[0][1], actions});
    }

    _issueSummary(key) {
        return this._jira.issues.find(i => i.key === key)?.summary ?? '';
    }

    async _moveFromNotification(key, t) {
        try {
            await applyTransition(this._session, key, t.id);
            Main.notify('Kaito', `${key} movido a ${t.to}`);
        } catch (e) {
            Main.notify('Kaito', `No se pudo mover ${key}: ${e.message}`);
        }
        if (!this._cancellable.is_cancelled())
            this._refresh();
    }

    /** Parpadeo suave dos veces (nunca infinito). */
    _pulse(times = 2) {
        this.remove_all_transitions();
        const step = i => {
            if (i >= times) {
                this.opacity = 255;
                return;
            }
            this.ease({
                opacity: 110, duration: 350, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                onComplete: () => this.ease({
                    opacity: 255, duration: 350, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                    onComplete: () => step(i + 1),
                }),
            });
        };
        step(0);
    }

    /**
     * Lee el uso de Claude (statusLine) y Codex (rollouts) y monta las filas de anillos: solo proveedores
     * activados en Ajustes; Gemini y OpenCode (sin límites legibles) solo si están instalados.
     */
    _loadUsage() {
        this._usage = {claude: null, codex: null};
        this._usageRows = [];
        if (!this._cfg.showUsage)
            return;
        const now = Date.now() / 1000;
        const enabled = this._cfg.agentProviders ?? {};
        for (const [k, read] of [['claude', readClaudeUsage], ['codex', readCodexUsage]]) {
            if (enabled[k] === false)
                continue;
            try {
                this._usage[k] = usageView(read(), now);
            } catch (e) {
                console.warn(`kaito: uso de ${k}: ${e.message}`);
            }
        }
        let installed = {}, opencode = null;
        try {
            installed = this._usageInstalled();
            if (installed.opencode && enabled.opencode !== false)
                opencode = readOpencodeProvider();
        } catch (e) {
            console.warn(`kaito: proveedores para el uso: ${e.message}`);
        }
        this._usageRows = usageRows({views: this._usage, enabled, installed, opencode}, now);
    }

    /** {gemini, opencode}: instalados (la detección de proveedores tiene su propia caché). */
    _usageInstalled() {
        const out = {};
        for (const p of installedProviders())
            out[p.id] = p.installed;
        return out;
    }

    _refreshUsage() {
        this._loadUsage();
        this._renderSection('usage');
        this._updateLabel();
    }

    /** Una fila por proveedor: insignia, anillos de 5 h y semana con su porcentaje y una nota a la derecha. */
    _usageSpecs() {
        const specs = (this._usageRows ?? []).map(row => {
            const box = new St.BoxLayout({style_class: 'kaito-usage-row', x_expand: true, accessible_name: row.tooltip});
            const badge = providerBadge(row);
            box.add_child(badge);
            for (const r of row.rings) {
                if (!r)
                    continue;
                const cell = new St.BoxLayout({style_class: 'kaito-usage-cell', y_align: Clutter.ActorAlign.CENTER,
                    accessible_name: `${r.kind === 'five' ? '5 h' : 'semana'} ${r.text}`});
                const ring = usageRing();
                ring.set(r);
                cell.add_child(ring.actor);
                cell.add_child(mkLabel(r.text, 'kaito-usage-pct'));
                cell.opacity = r.dim || row.dim ? DIM_OPACITY : 255;
                box.add_child(cell);
            }
            box.add_child(spacer());
            const note = mkLabel(row.note, row.rings.length ? 'kaito-muted kaito-usage-note' : 'kaito-muted kaito-usage-note kaito-usage-nolimit');
            if (row.dim)
                note.opacity = DIM_OPACITY;
            box.add_child(note);
            // "Tooltip": al pasar por la insignia, la nota dice proveedor y reinicios.
            badge.connect('notify::hover', () => note.set_text(badge.hover ? row.tooltip : row.note));
            return {actor: box};
        });
        this._counts.usage = specs.length;
        return specs;
    }

    /** La sección "Uso" (cabecera incluida) solo existe si algún proveedor tiene datos. */
    _syncUsageVisible() {
        const show = this._counts.usage > 0;
        this._headers.usage.visible = show;
        this._sections.usage.actor.visible = show;
        if (this._card) {
            this._cardHeaders.usage.visible = show;
            this._cardSec.usage.visible = show;
        }
    }

    _agentsSpecs() {
        if (this._agentsError)
            return [this._emptySpec(`Error: ${this._agentsError}`)];
        if (!this._agents.length)
            return [this._emptySpec('Ningún agente trabajando ahora')];
        // Chip del proveedor: siempre en los que no son Claude; en Claude solo si hay mezcla.
        const mixed = new Set(this._agents.map(a => a.provider ?? 'claude')).size > 1;
        return this._agents.map(a => {
            const needs = a.state === 'needs';
            const provider = a.provider ?? 'claude';
            const color = needs ? C.needs : a.state !== 'done' && a.live ? C.live : C.idle;
            const col = new St.BoxLayout({vertical: true, x_expand: true});
            const top = new St.BoxLayout({x_expand: true});
            const d = dot(color);
            top.add_child(!needs && a.state !== 'done' && a.live ? pulsing(d) : d);
            if (needs)
                top.add_child(mkLabel('Te necesita', 'kaito-pill kaito-pill-needs'));
            top.add_child(mkLabel(a.cwd ?? '?', 'kaito-repo'));
            if (provider !== 'claude' || mixed)
                top.add_child(mkLabel(PROVIDER_BY_ID[provider]?.name ?? provider, `kaito-provider kaito-provider-${provider}`));
            if (a.ticket)
                top.add_child(mkLabel(a.ticket, 'kaito-key kaito-key-chip'));
            top.add_child(spacer());
            top.add_child(mkLabel(a.state === 'open' ? 'abierto' : ago(a.age), 'kaito-muted'));
            col.add_child(top);
            const line = needs ? (a.message ?? 'Te necesita')
                : a.state === 'open' ? `abierto en ${a.cwdPath ? a.cwdPath.replace(GLib.get_home_dir(), '~') : '?'}`
                    : a.state === 'done' ? (provider !== 'claude' && a.lastText ? `Terminó: ${a.lastText}` : DONE_MSG)
                        : (a.lastAction ?? '(sin acción)');
            col.add_child(ellipsized(mkLabel(line, needs
                ? 'kaito-action kaito-needs-msg' : 'kaito-muted kaito-action')));
            const side = needs ? null : sideButton('Ocultar', new St.Label({text: '×', style_class: 'kaito-side-x'}),
                () => this._dismissAgent(a.id));
            const activate = needs ? () => this._ext.openReply(a)
                : Number.isInteger(a.pid) ? () => this.focusAgent(a) : null;
            return {actor: col, activate, side};
        });
    }

    _dismissAgent(id) {
        try {
            writeDismissed({...readDismissed(), [id]: Date.now()});
        } catch (e) {
            console.error(`kaito: no se pudo ocultar ${id}: ${e.message}`);
        }
        this.refreshLocal();
    }

    /** Ventana cuyo pid es el del agente o el de un antecesor (claude -> bash -> terminal). */
    _agentWindow(pid) {
        if (!Number.isInteger(pid))
            return null;
        const wins = global.get_window_actors().map(wa => wa.meta_window).filter(w => w && !w.skip_taskbar);
        for (const p of ancestorPids(pid)) {
            const win = wins.find(w => w.get_pid() === p);
            if (win)
                return win;
        }
        return null;
    }

    _agentFocused(a) {
        const w = this._agentWindow(a.pid);
        return w !== null && w === global.display.focus_window;
    }

    focusAgent(a) {
        this.menu.close();
        this._focusAgentTerminal(a);
    }

    /**
     * Ventana de la terminal del agente y, si se puede, su pestaña exacta: Ptyxis (PTYXIS_TAB, Ptyxis >= 52)
     * con la acción focus-tab-by-uuid; GNOME Terminal (GNOME_TERMINAL_SCREEN) con su proveedor de búsqueda.
     * Si falla, se queda en la ventana (ya activada antes).
     */
    _focusAgentTerminal(a) {
        const win = this._agentWindow(a.pid);
        if (win)
            Main.activateWindow(win);
        let target = null;
        if (Number.isInteger(a.pid)) {
            try {
                target = terminalFocusTarget(processChain(a.pid));
            } catch (e) {
                console.warn(`kaito: entorno del agente ${a.pid}: ${e.message}`);
            }
        }
        // Variable heredada de otra terminal (p. ej. Warp abierto desde Ptyxis): la ventana manda.
        if (target && win) {
            const id = `${win.get_gtk_application_id() ?? ''} ${win.get_wm_class() ?? ''}`;
            if (!WINDOW_KIND_RE[target.kind].test(id))
                target = null;
        }
        if (!target) {
            if (!win)
                console.log(`kaito: sin ventana para el agente ${a.pid}`);
            return;
        }
        const appId = win?.get_gtk_application_id() ?? '';
        this._focusTab(target, appId).catch(e => {
            if (!this._cancellable.is_cancelled())
                console.warn(`kaito: no se pudo enfocar la pestaña (${target.kind}): ${e.message}`);
        });
    }

    async _focusTab({kind, uuid}, appId = '') {
        if (kind === 'gnome-terminal') {
            await dbusCall('org.gnome.Terminal', '/org/gnome/Terminal/SearchProvider', 'org.gnome.Shell.SearchProvider2',
                'ActivateResult', new GLib.Variant('(sasu)', [uuid, [], global.get_current_time()]), this._cancellable);
            return;
        }
        // Token de activación (xdg-activation) para que Ptyxis pueda traer su ventana al frente.
        const pd = {};
        try {
            const token = global.create_app_launch_context(0, -1).get_startup_notify_id(null, []);
            if (token) {
                pd['activation-token'] = GLib.Variant.new_string(token);
                pd['desktop-startup-id'] = GLib.Variant.new_string(token);
            }
        } catch (e) {
            console.warn(`kaito: token de activación: ${e.message}`);
        }
        const buses = [...PTYXIS_BUSES].sort(([a], [b]) => (b === appId) - (a === appId));
        let real = null; // primer error de un Ptyxis que sí está en el bus
        for (const [name, path] of buses) {
            try {
                await dbusCall(name, path, 'org.gtk.Actions', 'Activate',
                    new GLib.Variant('(sava{sv})', ['focus-tab-by-uuid', [GLib.Variant.new_string(uuid)], pd]), this._cancellable);
                return;
            } catch (e) {
                if (!e.matches?.(Gio.DBusError, Gio.DBusError.NAME_HAS_NO_OWNER) && !e.matches?.(Gio.DBusError, Gio.DBusError.SERVICE_UNKNOWN))
                    real ??= e;
            }
        }
        throw real ?? new Error('Ptyxis no está en el bus de sesión');
    }

    _todosSpecs() {
        if (this._cfg.kanbanEnabled)
            return this._boardSpecs();
        const todos = readJson(TODOS_PATH, []);
        const pending = todos.filter(t => !t.done);
        this._counts.todos = pending.length;
        if (!pending.length)
            return [this._emptySpec('Nada pendiente')];
        return pending.map(t => {
            const row = content();
            row.add_child(new St.Widget({style_class: 'kaito-circle', y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(ellipsized(mkLabel(t.text, 'kaito-todo-text')));
            return {
                actor: row, cls: 'kaito-todo',
                activate: () => {
                    t.done = true;
                    this._saveTodos(todos);
                },
            };
        });
    }

    /** Con el tablero: "Tareas" abiertas (Haciendo, En revisión, Por hacer) con prioridad y estado. */
    _boardSpecs() {
        let todos = [];
        try {
            todos = readBoard();
        } catch (e) {
            console.warn(`kaito: tablero: ${e.message}`);
        }
        const order = {doing: 0, review: 1, todo: 2};
        const prio = {highest: 0, high: 1, medium: 2, low: 3};
        const open = todos.filter(t => todoState(t) !== 'done')
            .sort((a, b) => order[todoState(a)] - order[todoState(b)] || (prio[a.priority] ?? 2) - (prio[b.priority] ?? 2));
        this._counts.todos = open.length;
        if (!open.length)
            return [this._emptySpec('Nada pendiente')];
        return open.map(t => {
            const row = content();
            row.add_child(new St.Icon({
                gicon: this._icons[`prio-${t.priority}`] ?? this._icons['prio-medium'], icon_size: 14, style_class: 'kaito-prio',
                y_align: Clutter.ActorAlign.CENTER, accessible_name: PRIORITY_NAMES[t.priority] ?? '',
            }));
            row.add_child(ellipsized(mkLabel(t.text, 'kaito-todo-text')));
            if (this._byTicket[t.id])
                row.add_child(pulsing(dot(C.live)));
            const st = todoState(t);
            row.add_child(mkLabel(STATE_NAMES[st], `kaito-pill ${STATE_PILL[st]}`));
            return {actor: row, activate: () => this._ext.openKanban(t.id)};
        });
    }

    _notesSpecs() {
        const all = readNotes();
        this._counts.notes = all.length;
        if (!all.length)
            return [this._emptySpec('Sin notas')];
        return all.slice(-NOTES_SHOWN).reverse().map(n => {
            const row = content();
            row.add_child(ellipsized(mkLabel(n.text, 'kaito-summary')));
            return {
                actor: row,
                activate: () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, n.text),
            };
        });
    }

    _remindersSpecs() {
        const now = new Date();
        const list = readReminders().filter(r => !r.done)
            .sort((a, b) => new Date(a.due) - new Date(b.due));
        this._counts.reminders = list.length;
        if (!list.length)
            return [this._emptySpec('Sin recordatorios')];
        return list.map(r => {
            const row = content();
            row.add_child(ellipsized(mkLabel(r.text, 'kaito-summary')));
            row.add_child(mkLabel(shortLabel(new Date(r.due), now), 'kaito-muted'));
            return {actor: row};
        });
    }

    _tasksSpecs() {
        let tasks = [];
        try {
            tasks = readTasks();
        } catch (e) {
            console.warn(`kaito: tareas: ${e.message}`);
        }
        this._tasksTotal = tasks.length;
        this._counts.tasks = tasks.filter(t => !t.done).length;
        if (!tasks.length)
            return [];
        const now = new Date();
        const sched = this._ext.tasks;
        const rank = t => (t.done ? 2 : t.enabled ? 0 : 1);
        const order = [...tasks].sort((a, b) => rank(a) - rank(b) ||
            (a.nextRun && b.nextRun ? new Date(a.nextRun) - new Date(b.nextRun) : 0));
        return order.map(t => {
            const running = sched?.runningId === t.id;
            const pending = !running && sched?.isPending(t.id);
            const color = running ? C.live : t.lastOk === true ? C.live : t.lastOk === false ? C.needs : C.idle;
            const col = new St.BoxLayout({vertical: true, x_expand: true});
            const top = new St.BoxLayout({x_expand: true});
            const d = dot(color);
            top.add_child(running ? pulsing(d) : d);
            top.add_child(ellipsized(mkLabel(t.name, 'kaito-repo kaito-task-name')));
            if (t.key)
                top.add_child(mkLabel(t.key, 'kaito-key kaito-key-chip'));
            col.add_child(top);
            const status = running ? 'ejecutando…' : pending ? 'en cola' : t.done ? 'hecha'
                : !t.enabled ? 'pausada' : t.nextRun ? `próxima: ${nextLabel(new Date(t.nextRun), now)}` : 'sin próxima';
            col.add_child(ellipsized(mkLabel(t.lastSummary ? `${status} · ${t.lastSummary}` : status,
                t.lastOk === false && !running ? 'kaito-muted kaito-action kaito-task-failed' : 'kaito-muted kaito-action')));
            const side = [];
            if (!running && !pending) {
                side.push(sideButton('Ejecutar ahora', new St.Icon({icon_name: 'system-run-symbolic', icon_size: 14}),
                    () => this._runTaskNow(t.id)));
            }
            if (!t.done) {
                side.push(sideButton(t.enabled ? 'Pausar' : 'Reanudar',
                    new St.Icon({icon_name: t.enabled ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic', icon_size: 14}),
                    () => this._toggleTask(t.id)));
            }
            const confirm = this._taskConfirm === t.id;
            side.push(sideButton(confirm ? 'Confirmar borrado' : 'Borrar',
                confirm ? new St.Label({text: '¿Borrar?', style_class: 'kaito-error'})
                    : new St.Label({text: '×', style_class: 'kaito-side-x'}),
                () => this._deleteTask(t.id)));
            return {actor: col, activate: () => this._ext.openTaskResult(t), side};
        });
    }

    _runTaskNow(id) {
        this._ext.tasks?.runNow(id);
        this._renderSection('tasks');
    }

    _toggleTask(id) {
        try {
            patchTask(id, t => setEnabled(t, !t.enabled, new Date()));
        } catch (e) {
            console.error(`kaito: no se pudo pausar/reanudar ${id}: ${e.message}`);
        }
        this._renderSection('tasks');
        this._updateLabel();
    }

    /** Primer clic: "¿Borrar?" en la fila; segundo clic (antes de TASK_CONFIRM_MS): borra. */
    _deleteTask(id) {
        if (this._confirmId) {
            GLib.source_remove(this._confirmId);
            this._confirmId = 0;
        }
        if (this._taskConfirm !== id) {
            this._taskConfirm = id;
            this._confirmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TASK_CONFIRM_MS, () => {
                this._confirmId = 0;
                this._taskConfirm = null;
                this._renderSection('tasks');
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._taskConfirm = null;
            try {
                deleteTask(id);
            } catch (e) {
                console.error(`kaito: no se pudo borrar la tarea ${id}: ${e.message}`);
            }
        }
        this._renderSection('tasks');
        this._updateLabel();
    }

    /** La sección "Tareas programadas" (cabecera incluida) solo existe si hay alguna tarea. */
    _syncTasksVisible() {
        const show = this._tasksTotal > 0;
        this._headers.tasks.visible = show;
        this._sections.tasks.actor.visible = show;
        if (this._card) {
            this._cardHeaders.tasks.visible = show;
            this._cardSec.tasks.visible = show;
        }
    }

    _jiraSpecs() {
        const j = this._jira;
        this._counts.jira = j.issues.length;
        if (this._jiraPick)
            return this._repoPickSpecs();
        if (j.setup)
            return [this._emptySpec(j.setup)];
        const view = this._jiraView;
        if (view === 'mine') {
            if (j.error)
                return [this._emptySpec(`Jira no responde: ${j.error}`)];
            if (!j.issues.length)
                return [this._emptySpec(this._jiraLoaded ? 'No tienes tickets abiertos' : 'Cargando…')];
            return j.issues.flatMap(i => this._issueSpecs(i, j.base, view));
        }
        const st = this._views[view];
        if (!st || st.loading)
            return [this._emptySpec('Cargando…')];
        if (st.msg)
            return [this._emptySpec(st.msg)];
        if (st.error)
            return [this._emptySpec(`Jira no responde: ${st.error}`)];
        if (!st.issues.length)
            return [this._emptySpec(VIEW_EMPTY[view] ?? 'Sin tickets')];
        return st.issues.flatMap(i => this._issueSpecs(i, st.base, view));
    }

    /** ¿Ofrecer "Asignarme" en esta fila? En "Sin asignar" y en el sprint si no es tuyo. */
    _canAssign(issue, view) {
        if (view === 'unassigned')
            return true;
        if (view === 'sprint')
            return !issue.assignee || (this._myId !== null && issue.assignee.accountId !== this._myId);
        return false;
    }

    /** Fila de un ticket (y debajo, si toca, "Mover a" o el error de "Asignarme"). */
    _issueSpecs(i, base, view) {
        const row = content();
        const agent = this._byTicket[i.key] ?? null;
        row.add_child(this._priorityIcon(i.priority));
        row.add_child(mkLabel(i.key, 'kaito-key'));
        row.add_child(ellipsized(mkLabel(i.summary, 'kaito-summary')));
        if (view === 'sprint')
            row.add_child(mkLabel(shortName(i.assignee?.displayName) || 'Sin asignar', 'kaito-muted kaito-assignee'));
        if (!agent)
            row.add_child(pillLabel(i.status, PILL[i.category] ?? PILL.new));
        const side = [];
        if (agent) {
            // En vez del estado: el agente que trabaja en el ticket; clic = su terminal.
            const box = new St.BoxLayout({style_class: 'kaito-agent-chip'});
            box.add_child(new St.Icon({icon_name: 'utilities-terminal-symbolic', icon_size: 14, style_class: 'kaito-teal'}));
            box.add_child(mkLabel(agent.cwd ?? '?', 'kaito-teal'));
            side.push(sideButton(`Ir a la terminal de ${agent.cwd ?? 'agente'}`, box, () => this.focusAgent(agent)));
        }
        const as = this._assign[i.key];
        if (as?.done) {
            side.push(mkLabel(ASSIGNED_MSG, 'kaito-teal kaito-assign-note'));
        } else if (as?.busy) {
            side.push(mkLabel('Asignando…', 'kaito-muted kaito-assign-note'));
        } else if (this._canAssign(i, view)) {
            side.push(sideButton('Asignarme', new St.Label({text: 'Asignarme', style_class: 'kaito-assign-btn'}),
                () => this._assignMe(i)));
        }
        const open = this._jiraExpand?.key === i.key;
        side.push(sideButton('Ver ticket',
            new St.Icon({icon_name: open ? 'pan-up-symbolic' : 'pan-down-symbolic', icon_size: 14}),
            () => this._toggleExpand(i)));
        if (view === 'mine') {
            side.push(sideButton('Programar revisión',
                new St.Icon({icon_name: 'appointment-soon-symbolic', icon_size: 14}),
                () => this._ext.openTaskCapture(REVIEW_PREFILL(i.key))));
        }
        side.push(sideButton('Mandar a Claude',
            new St.Icon({icon_name: 'mail-send-symbolic', icon_size: 14}), () => this._pickRepo(i)));
        const spec = {
            actor: row,
            activate: () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(`${base}/browse/${i.key}`, null);
                } catch (e) {
                    console.error(`kaito: ${e.message}`);
                }
            },
            side,
            tip: () => ({title: i.summary, detail: ticketDetailLine(i, this._myId)}),
        };
        const out = [spec];
        if (as?.error && !as.busy) {
            const err = mkLabel(as.error, 'kaito-error kaito-assign-error');
            err.clutter_text.line_wrap = true;
            out.push({actor: err});
        }
        if (open) {
            out.push(this._detailSpec(i, base));
            out.push(this._moveSpec(i, this._jiraExpand));
        }
        return out;
    }

    /** "Asignarme": PUT del responsable; nota en la fila y refresco de "Mías" y de la vista. */
    async _assignMe(issue) {
        if (this._assign[issue.key]?.busy)
            return;
        const st = {busy: true, done: false, error: null};
        this._assign[issue.key] = st;
        this._renderSection('jira');
        try {
            await assignToMe(this._session, issue.key, this._cancellable);
            st.done = true;
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            st.error = `No se pudo asignar ${issue.key}: ${e.message}`;
            console.warn(`kaito: asignar ${issue.key}: ${e.message}`);
        }
        st.busy = false;
        if (this._cancellable.is_cancelled())
            return;
        this._renderSection('jira');
        if (!st.done)
            return;
        await this._refresh();
        if (this._cancellable.is_cancelled())
            return;
        const t = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ASSIGN_CLEAR_MS, () => {
            this._assignTimers.delete(t);
            if (this._assign[issue.key] === st) {
                delete this._assign[issue.key];
                this._renderSection('jira');
            }
            return GLib.SOURCE_REMOVE;
        });
        this._assignTimers.add(t);
    }

    // --- Vistas de Jira (pestañas) ---

    /** (Re)construye las pestañas (menú y tarjeta) según las vistas visibles. */
    _renderJiraTabs() {
        const views = visibleViews(this._cfg);
        if (!views.some(v => v.id === this._jiraView))
            this._jiraView = 'mine';
        this._tabButtons = [];
        const fill = box => {
            box.destroy_all_children();
            views.forEach((v, n) => {
                const btn = new St.Button({
                    style_class: 'kaito-tab', label: v.name, can_focus: true, track_hover: true,
                    accessible_name: `Vista ${v.name}`,
                });
                btn._kaitoView = v.id;
                btn.connect('clicked', () => this._selectView(v.id));
                if (n % TABS_PER_ROW === 0)
                    box.add_child(new St.BoxLayout({style_class: 'kaito-tabs-row'}));
                box.last_child.add_child(btn);
                this._tabButtons.push(btn);
            });
        };
        fill(this._jiraTabsBox);
        if (this._cardJiraTabs)
            fill(this._cardJiraTabs);
        this._syncTabClasses();
        this._syncTabsVisible();
    }

    /** Pestañas visibles si hay más de una vista y no se está eligiendo repo. */
    _syncTabsVisible() {
        const show = this._cfg.jiraEnabled && this._tabButtons.length > (this._cardJiraTabs ? 2 : 1) && !this._jiraPick && !this._jira.setup;
        this._jiraTabsItem.visible = show;
        if (this._cardJiraTabs)
            this._cardJiraTabs.visible = show;
    }

    _syncTabClasses() {
        for (const b of this._tabButtons) {
            if (b._kaitoView === this._jiraView)
                b.add_style_class_name('kaito-tab-active');
            else
                b.remove_style_class_name('kaito-tab-active');
        }
    }

    _selectView(id) {
        if (id === this._jiraView)
            return;
        this._jiraView = id;
        this._jiraExpand = null;
        this._syncTabClasses();
        try {
            updateConfig({jiraView: id});
            this._cfg.jiraView = id;
        } catch (e) {
            console.warn(`kaito: no se pudo guardar jiraView: ${e.message}`);
        }
        this._renderSection('jira');
        this._updateLabel();
        const st = this._views[id];
        // Carga perezosa: la primera vez que se elige, o si lo guardado es más viejo que un refresco.
        if (id !== 'mine' && (!st || Date.now() - st.t > this._cfg.refreshSeconds * 1000))
            this._fetchView(id).catch(e => console.warn(`kaito: vista ${id}: ${e.message}`));
    }

    /** Proyectos para "Sin asignar" y "Sprint": los de tus tickets (con caché) o jiraProjects. */
    _projects() {
        return resolveProjects(projectsFromIssues(this._jira.issues), this._cfg);
    }

    /** Descarga la vista `id` (no "Mías") y la pinta si sigue activa. */
    async _fetchView(id) {
        const v = visibleViews(this._cfg).find(x => x.id === id);
        if (!v || id === 'mine' || !this._cfg.jiraEnabled)
            return;
        const st = this._views[id] ??= {issues: [], base: this._jira.base, error: null, msg: null, loading: true, fetching: false, t: 0};
        if (st.fetching)
            return;
        const jql = v.custom ? v.jql : viewJql(id, {projects: this._projects()});
        if (!jql) {
            if (!this._jiraLoaded)
                return; // sin proyectos aún: _refresh la pide al terminar de cargar "Mías"
            Object.assign(st, {loading: false, msg: 'No hay proyectos conocidos: añade jiraProjects en config.json', issues: [], t: Date.now()});
            if (this._jiraView === id)
                this._renderSection('jira');
            return;
        }
        st.fetching = true;
        const wantMe = id === 'sprint' && this._myId === null;
        try {
            const [r, me] = await Promise.all([
                fetchJiraJql(this._session, jql),
                wantMe ? fetchMyself(this._session).catch(e => {
                    console.warn(`kaito: /myself: ${e.message}`);
                    return null;
                }) : null,
            ]);
            if (me?.accountId)
                this._myId = me.accountId;
            if (r.setup)
                Object.assign(st, {issues: [], msg: r.setup, error: null});
            else
                Object.assign(st, {issues: r.issues, base: r.base, msg: null, error: null});
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            console.warn(`kaito: vista ${id}: ${e.message}`);
            // Sin Jira Software (o sin sprints) la JQL de sprint da error: no es un fallo de conexión.
            if (id === 'sprint')
                Object.assign(st, {issues: [], msg: 'No hay sprint activo', error: null});
            else
                Object.assign(st, {issues: [], msg: null, error: e.message});
        } finally {
            st.fetching = false;
        }
        if (this._cancellable.is_cancelled())
            return;
        st.loading = false;
        st.t = Date.now();
        if (this._jiraView === id) {
            this._renderSection('jira');
            this._updateLabel();
        }
    }

    /** Firma de la config sin jiraView: cambiar de pestaña no debe disparar un refresco de red. */
    _configSig() {
        // Tampoco No molestar: activarlo no tiene nada que ver con Jira.
        const {jiraView: _v, dndManual: _m, dndUntil: _u, dndSkipUntil: _s, ...rest} = readJson(CONFIG_PATH, {}) ?? {};
        return JSON.stringify(rest);
    }

    _onConfigChanged() {
        this._update?.onConfig();
        this._ext.quiet?.tick();
        const sig = this._configSig();
        if (sig === this._cfgSig) {
            this.refreshLocal();
            return;
        }
        this._cfgSig = sig;
        this._refresh();
    }

    /** Abre/cierra "Mover a" bajo la fila y carga sus transiciones. */
    _toggleExpand(issue) {
        if (this._jiraExpand?.key === issue.key) {
            this._jiraExpand = null;
            this._renderSection('jira');
            return;
        }
        const ex = {key: issue.key, loading: true, transitions: [], error: null, done: null, busy: false};
        this._jiraExpand = ex;
        this._renderSection('jira');
        fetchTransitions(this._session, issue.key)
            .then(list => {
                ex.transitions = list;
            })
            .catch(e => {
                ex.error = `No se pudieron cargar los estados: ${e.message}`;
                console.warn(`kaito: transiciones de ${issue.key}: ${e.message}`);
            })
            .finally(() => {
                ex.loading = false;
                if (this._jiraExpand === ex && !this._cancellable.is_cancelled())
                    this._renderSection('jira');
            });
    }

    /** Detalle del ticket bajo la fila: resumen completo, línea de datos, inicio de la descripción y «Abrir en Jira». */
    _detailSpec(issue, base) {
        const wrap = l => {
            l.clutter_text.line_wrap = true;
            l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            l.x_expand = true;
            return l;
        };
        const box = new St.BoxLayout({style_class: 'kaito-move kaito-detail', vertical: true, x_expand: true});
        box.add_child(wrap(mkLabel(issue.summary, 'kaito-summary kaito-detail-title')));
        const meta = ticketDetailLine(issue, this._myId);
        if (meta)
            box.add_child(wrap(mkLabel(meta, 'kaito-muted')));
        const snip = descriptionSnippet(issue.text);
        box.add_child(wrap(mkLabel(snip || 'Sin descripción', snip ? 'kaito-detail-desc' : 'kaito-muted')));
        const open = new St.Button({style_class: 'kaito-move-btn', label: 'Abrir en Jira', can_focus: true,
            reactive: true, track_hover: true, x_align: Clutter.ActorAlign.START});
        open.connect('clicked', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(`${base}/browse/${issue.key}`, null);
            } catch (e) {
                console.error(`kaito: ${e.message}`);
            }
            this.menu.close();
        });
        box.add_child(open);
        return {actor: box};
    }

    _moveSpec(issue, ex) {
        const box = new St.BoxLayout({style_class: 'kaito-move', vertical: true, x_expand: true});
        box.add_child(mkLabel('Mover a', 'kaito-muted'));
        // Filas fijas de MOVE_PER_ROW botones: Clutter.FlowLayout dentro del St.ScrollView del menú
        // asignaba alto 0 a los botones (invisibles y sin clic).
        if (ex.loading) {
            box.add_child(mkLabel('Cargando…', 'kaito-muted'));
        } else {
            ex.transitions.forEach((t, n) => {
                const btn = new St.Button({
                    style_class: 'kaito-move-btn', label: t.to || t.name, can_focus: true,
                    reactive: !ex.busy, track_hover: true,
                });
                btn.connect('clicked', () => {
                    this._doMove(issue.key, t, ex).catch(e => console.warn(`kaito: mover ${issue.key}: ${e.message}`));
                });
                if (n % MOVE_PER_ROW === 0)
                    box.add_child(new St.BoxLayout({style_class: 'kaito-move-row'}));
                box.last_child.add_child(btn);
            });
            if (!ex.transitions.length && !ex.error)
                box.add_child(mkLabel('Sin transiciones disponibles', 'kaito-muted'));
        }
        const note = ex.error ? mkLabel(ex.error, 'kaito-error') : ex.done ? mkLabel(ex.done, 'kaito-teal')
            : ex.busy ? mkLabel('Moviendo…', 'kaito-muted') : null;
        if (note) {
            note.clutter_text.line_wrap = true;
            box.add_child(note);
        }
        return {actor: box, reveal: true};
    }

    async _doMove(key, t, ex) {
        if (ex.busy)
            return;
        ex.busy = true;
        ex.error = null;
        this._renderSection('jira');
        try {
            await applyTransition(this._session, key, t.id);
            ex.done = MOVED_MSG;
        } catch (e) {
            ex.error = `No se pudo mover a ${t.to || t.name}: ${e.message}`;
            console.warn(`kaito: no se pudo mover ${key} (transición ${t.id}): ${e.message}`);
        }
        ex.busy = false;
        if (this._cancellable.is_cancelled())
            return;
        if (this._jiraExpand === ex)
            this._renderSection('jira');
        if (!ex.done)
            return;
        await this._refresh();
        if (this._collapseId)
            GLib.source_remove(this._collapseId);
        this._collapseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2500, () => {
            this._collapseId = 0;
            if (this._jiraExpand === ex) {
                this._jiraExpand = null;
                this._renderSection('jira');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _priorityIcon(priority) {
        const kind = priorityKind(priority);
        if (!kind)
            return new St.Widget({style_class: 'kaito-prio', y_align: Clutter.ActorAlign.CENTER});
        return new St.Icon({
            gicon: this._icons[`prio-${kind}`], icon_size: 14, style_class: 'kaito-prio',
            y_align: Clutter.ActorAlign.CENTER, accessible_name: priority.name || PRIORITY_NAMES[kind],
        });
    }

    /** Cambia la sección de Jira (menú y tarjeta) al selector de repo. */
    _pickRepo(issue) {
        let repos = [];
        try {
            repos = collectRepos();
            const now = GLib.get_monotonic_time() / 1e6;
            if (!this._scan || now - this._scan.t > 300)
                this._scan = {t: now, list: scanRepos(this._cfg.repoRoots)};
            const seen = new Set(repos.map(r => r.path));
            repos = [...repos, ...this._scan.list.filter(r => !seen.has(r.path))];
        } catch (e) {
            console.error(`kaito: repos: ${e.message}`);
        }
        repos = rankRepos(issue, repos, this._cfg, p => GLib.file_test(p, GLib.FileTest.IS_DIR));
        this._jiraPick = {issue, repos, query: '', focus: this.menu.isOpen ? 0 : 1, entries: []};
        this._renderSection('jira');
    }

    /** Entrada de búsqueda del selector (una por destino: menú y tarjeta). */
    _pickEntry(idx) {
        const pick = this._jiraPick;
        const entry = new St.Entry({
            style_class: 'kaito-entry', hint_text: 'Buscar carpeta…', can_focus: true, x_expand: true,
        });
        entry.set_text(pick.query);
        const ct = entry.clutter_text;
        ct.connect('text-changed', () => {
            const q = entry.get_text();
            if (this._jiraPick !== pick || q === pick.query)
                return;
            pick.query = q;
            pick.focus = idx;
            // Se reconstruye la lista fuera del manejador: destruir la entrada que emite la señal es inseguro.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._jiraPick === pick)
                    this._renderSection('jira');
                return GLib.SOURCE_REMOVE;
            });
        });
        ct.connect('activate', () => {
            const first = filterRepos(pick.repos, pick.query)[0];
            if (first)
                this._sendToClaude(pick.issue, first.path);
        });
        ct.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._jiraPick = null;
            this._renderSection('jira');
            return Clutter.EVENT_STOP;
        });
        pick.entries[idx] = entry;
        return entry;
    }

    _repoPickSpecs() {
        const {issue, query} = this._jiraPick;
        const all = this._jiraPick.repos;
        const repos = filterRepos(all, query).slice(0, PICK_MAX);
        const idx = this._jiraPick.entries.length;
        const home = GLib.get_home_dir();
        const specs = [];
        const head = content();
        head.add_child(mkLabel('¿En qué repo?', 'kaito-summary'));
        head.add_child(mkLabel(issue.key, 'kaito-key'));
        specs.push({actor: head});
        specs.push({actor: this._pickEntry(idx)});
        if (!repos.length)
            specs.push(this._emptySpec(all.length ? 'Ninguna carpeta coincide' : 'No hay repos'));
        for (const r of repos) {
            const row = content();
            const parts = r.path.split('/');
            const name = parts.pop() || r.path;
            let parent = parts.join('/');
            if (parent === home || parent.startsWith(`${home}/`))
                parent = `~${parent.slice(home.length)}`;
            row.add_child(mkLabel(name, 'kaito-repo kaito-repo-pick'));
            row.add_child(ellipsized(mkLabel(parent, 'kaito-muted')));
            if (r === repos[0] && (!query.trim() || r.why))
                row.add_child(mkLabel(PICK_PILL[r.why] ?? 'último', 'kaito-pill kaito-pill-progress'));
            specs.push({actor: row, activate: () => this._sendToClaude(issue, r.path), keepOpen: true});
        }
        if (GLib.find_program_in_path('zenity')) {
            const other = content();
            other.add_child(mkLabel('Otra carpeta…', 'kaito-muted'));
            specs.push({actor: other, activate: () => this._chooseFolder(issue)});
        }
        const cancel = content();
        cancel.add_child(mkLabel('Cancelar', 'kaito-muted'));
        specs.push({
            actor: cancel, keepOpen: true, activate: () => {
                this._jiraPick = null;
                this._renderSection('jira');
            },
        });
        return specs;
    }

    /** Selector de carpeta con zenity (un actor de la shell no puede mostrar un diálogo GTK). */
    async _chooseFolder(issue) {
        this._jiraPick = null;
        this.menu.close();
        this._renderSection('jira');
        try {
            const proc = Gio.Subprocess.new(['zenity', '--file-selection', '--directory',
                `--title=Carpeta para ${issue.key}`], Gio.SubprocessFlags.STDOUT_PIPE);
            // Al desactivar (o recargar) se cierra el diálogo: cancelar solo dejaría de esperarlo.
            const cid = this._cancellable.connect(() => proc.force_exit());
            let out;
            try {
                [out] = await proc.communicate_utf8_async(null, this._cancellable);
            } finally {
                this._cancellable.disconnect(cid);
            }
            const dir = (out ?? '').trim();
            if (proc.get_successful() && dir.startsWith('/') && GLib.file_test(dir, GLib.FileTest.IS_DIR))
                await this._sendToClaude(issue, dir);
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                console.warn(`kaito: selector de carpeta: ${e.message}`);
        }
    }

    async _sendToClaude(issue, repo) {
        this._jiraPick = null;
        this.menu.close();
        this._renderSection('jira');
        const base = this._jira.base;
        try {
            updateConfig({
                jiraRepoByProject: {...this._cfg.jiraRepoByProject, [projectOf(issue.key)]: repo},
                jiraRepoByIssue: {...this._cfg.jiraRepoByIssue, [issue.key]: repo},
            });
        } catch (e) {
            console.error(`kaito: no se pudo guardar el repo: ${e.message}`);
        }
        let description = null;
        try {
            description = await fetchIssueDescription(this._session, issue.key);
        } catch (e) {
            console.error(`kaito: descripción de ${issue.key}: ${e.message}`);
        }
        if (this._cancellable.is_cancelled())
            return;
        try {
            sendIssueToClaude({issue, base, description, repo, terminal: this._cfg.terminal});
            Main.notify('Kaito', `${issue.key} enviado a Claude en ${GLib.path_get_basename(repo)}`);
        } catch (e) {
            Main.notify('Kaito', `No se pudo mandar ${issue.key} a Claude: ${e.message}`);
            return;
        }
        if (issue.category === 'new')
            await this._autoStart(issue);
    }

    /** Ticket "Por hacer" mandado a Claude: pasa a la primera transición "en curso". */
    async _autoStart(issue) {
        try {
            const t = pickTransition(await fetchTransitions(this._session, issue.key), 'start');
            if (!t || this._cancellable.is_cancelled())
                return;
            await applyTransition(this._session, issue.key, t.id);
            Main.notify('Kaito', `${issue.key} movido a ${t.to}`);
        } catch (e) {
            console.warn(`kaito: no se pudo mover ${issue.key}: ${e.message}`);
            return;
        }
        if (!this._cancellable.is_cancelled())
            this._refresh();
    }

    // --- Render ---

    _renderSection(id) {
        // Un actor solo puede tener un padre: cada destino construye sus propios widgets.
        if (id === 'jira' && this._jiraPick)
            this._jiraPick.entries = [];
        this._renderMenu(id, this._specs(id));
        if (this._card)
            this._renderCard(id, this._specs(id));
        if (id === 'usage')
            this._syncUsageVisible();
        if (id === 'tasks')
            this._syncTasksVisible();
        if (id === 'jira')
            this._syncTabsVisible();
        const pick = id === 'jira' ? this._jiraPick : null;
        const e = pick?.entries[pick.focus] ?? pick?.entries.find(Boolean);
        if (e) {
            e.grab_key_focus();
            e.clutter_text.set_cursor_position(-1);
        }
    }

    _renderMenu(id, specs) {
        const s = this._sections[id];
        s.removeAll();
        for (const {actor, activate, cls, side, keepOpen, reveal, tip} of specs) {
            let item;
            if (side || keepOpen) {
                // Botones hermanos (no anidados): el × o el envío no disparan la acción de la fila.
                item = staticItem();
                const main = this._rowButton(actor, activate, cls, !keepOpen, tip);
                if (id === 'jira')
                    main.connect('key-focus-in', () => ensureActorVisibleInScrollView(this._jiraScroll, main));
                item.add_child(main);
                for (const sb of [side ?? []].flat())
                    item.add_child(sb);
            } else if (activate) {
                item = new PopupMenu.PopupBaseMenuItem({style_class: `kaito-row ${cls ?? ''}`});
                item.connect('activate', activate);
                if (id === 'jira')
                    item.connect('key-focus-in', () => ensureActorVisibleInScrollView(this._jiraScroll, item));
            } else {
                item = staticItem();
            }
            if (!actor.get_parent())
                item.add_child(actor);
            s.addMenuItem(item);
            if (reveal && id === 'jira')
                this._revealInJira(item);
        }
    }

    /** Desplaza la lista de Jira para que se vea `item` en cuanto tenga tamaño. */
    _revealInJira(item) {
        let alive = true;
        item.connect('destroy', () => (alive = false));
        const sig = item.connect('notify::allocation', () => {
            item.disconnect(sig);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (alive && item.mapped)
                    ensureActorVisibleInScrollView(this._jiraScroll, item);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    /** Fila principal como St.Button; sin acción, contenedor plano. */
    _rowButton(actor, activate, cls, closeMenu, tip = null) {
        if (!activate) {
            const box = new St.BoxLayout({style_class: 'kaito-row-main', x_expand: true});
            box.add_child(actor);
            return box;
        }
        const btn = new St.Button({
            style_class: `kaito-row-main kaito-card-btn ${cls ?? ''}`, reactive: true,
            can_focus: true, track_hover: true, x_expand: true, x_align: Clutter.ActorAlign.FILL,
        });
        btn.set_child(actor);
        if (tip)
            attachTooltip(btn, tip);
        btn.connect('clicked', () => {
            if (closeMenu)
                this.menu.close();
            activate();
        });
        return btn;
    }

    _renderCard(id, specs) {
        const box = this._cardSec[id];
        box.destroy_all_children();
        for (const {actor, activate, cls, side, tip} of specs) {
            if (side) {
                const row = new St.BoxLayout({style_class: 'kaito-row kaito-split', x_expand: true});
                row.add_child(this._rowButton(actor, activate, cls, false, tip));
                for (const sb of [side].flat())
                    row.add_child(sb);
                box.add_child(row);
            } else if (activate) {
                const btn = new St.Button({
                    style_class: `kaito-row kaito-card-btn ${cls ?? ''}`, reactive: true,
                    can_focus: true, track_hover: true, x_expand: true, x_align: Clutter.ActorAlign.FILL,
                });
                btn.set_child(actor);
                btn.connect('clicked', activate);
                box.add_child(btn);
            } else {
                const row = new St.BoxLayout({style_class: 'kaito-row', x_expand: true});
                row.add_child(actor);
                box.add_child(row);
            }
        }
    }

    // --- Tarjeta fija ("Mostrar siempre desplegado") ---

    _syncPinned() {
        if (this._cfg.pinned && !this._card)
            this._buildCard();
        else if (!this._cfg.pinned && this._card)
            this._destroyCard();
    }

    _buildCard() {
        const card = new St.BoxLayout({style_class: 'kaito-pinned', vertical: true, reactive: true});
        const head = new St.BoxLayout({style_class: 'kaito-card-head', x_expand: true});
        head.add_child(mkLabel('Kaito', 'kaito-header-text'));
        head.add_child(spacer());
        const close = new St.Button({
            style_class: 'kaito-card-close', can_focus: true, track_hover: true,
            accessible_name: 'Dejar de mostrar siempre desplegado',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
        });
        close.connect('clicked', () => {
            try {
                updateConfig({pinned: false});
            } catch (e) {
                console.error(`kaito: no se pudo guardar pinned: ${e.message}`);
            }
            this._cfg.pinned = false;
            this._syncPinned();
        });
        head.add_child(close);
        card.add_child(head);

        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true, x_expand: true,
        });
        const body = new St.BoxLayout({vertical: true, x_expand: true});
        scroll.set_child(body);
        card.add_child(scroll);

        this._cardSec = {};
        this._cardCounters = {};
        this._cardHeaders = {};
        for (const [id, title] of SECTIONS) {
            const h = this._headerRow(title);
            (this._cardTitles ??= {})[id] = h.title;
            const row = new St.BoxLayout({style_class: 'kaito-row kaito-header', x_expand: true});
            row.add_child(h.title);
            row.add_child(h.spacer);
            row.add_child(h.count);
            this._cardCounters[id] = h.count;
            this._cardHeaders[id] = row;
            body.add_child(row);
            this._cardSec[id] = new St.BoxLayout({vertical: true, x_expand: true});
            if (id === 'jira') {
                this._cardJiraTabs = new St.BoxLayout({style_class: 'kaito-tabs kaito-row', vertical: true, x_expand: true});
                body.add_child(this._cardJiraTabs);
                const js = new St.ScrollView({
                    hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
                    overlay_scrollbars: true, x_expand: true,
                });
                js.set_style(`max-height: ${JIRA_MAX_H}px;`);
                js.set_child(this._cardSec[id]);
                body.add_child(js);
                this._cardJiraScroll = js;
            } else {
                body.add_child(this._cardSec[id]);
            }
        }
        const entryRow = new St.BoxLayout({style_class: 'kaito-row', x_expand: true});
        entryRow.add_child(this._makeEntry());
        body.add_child(entryRow);

        this._card = card;
        this._cardScroll = scroll;
        this._cardWidthId = card.connect('notify::width', () => this._placeCard());
        Main.layoutManager.addChrome(card, {trackFullscreen: true});
        this._renderJiraTabs();
        for (const [id] of SECTIONS)
            this._renderCard(id, this._specs(id));
        this._syncUsageVisible();
        this._syncTasksVisible();
        this._syncJiraVisible();
        this._placeCard();
        this._updateCardVisibility();
        this._updateLabel();
    }

    _destroyCard() {
        const card = this._card;
        this._card = null;
        this._cardSec = null;
        this._cardCounters = null;
        this._cardHeaders = null;
        this._cardTitles = null;
        this._cardScroll = null;
        this._cardJiraTabs = null;
        this._cardJiraScroll = null;
        card.disconnect(this._cardWidthId);
        Main.layoutManager.removeChrome(card);
        card.destroy();
    }

    _placeCard() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!this._card || !mon)
            return;
        const w = this._card.width || CARD_W;
        this._card.set_position(mon.x + mon.width - w - CARD_MARGIN, mon.y + Main.panel.height + 8);
        // ~70 % del alto del monitor, descontando la cabecera de la tarjeta.
        this._cardScroll.set_style(`max-height: ${Math.floor(mon.height * 0.7) - 56}px;`);
    }

    /** Jira desactivado en Ajustes: fuera la sección (menú y tarjeta), sus pestañas y el contador del panel. */
    _syncJiraVisible() {
        const on = this._cfg.jiraEnabled;
        this._headers.jira.visible = on;
        this._jiraWrap.actor.visible = on;
        this._seg.jira.seg.visible = on;
        if (this._card) {
            this._cardHeaders.jira.visible = on;
            this._cardJiraScroll.visible = on;
        }
        this._syncTabsVisible();
    }

    _updateCardVisibility() {
        if (this._card)
            this._card.visible = !Main.overview.visible;
    }

    _updateLabel() {
        const c = this._counts;
        const needs = this._agents.filter(a => a.state === 'needs').length;
        const icons = {
            agents: this._icons[needs ? 'agentsNeeds' : this._live ? 'agentsLive' : 'agentsIdle'],
            jira: this._icons.jira, todos: this._icons.todos,
        };
        for (const id of Object.keys(this._seg)) {
            const {seg, dot: d, num} = this._seg[id];
            const n = id === 'agents' && needs ? needs : c[id];
            d.set_gicon(icons[id]);
            num.set_text(String(n));
            seg.opacity = n ? 255 : 115;
        }
        // Cabecera de Jira: la vista activa. El panel sigue contando "Mías".
        const shown = {...c, usage: this._usageRows?.some(r => r.rings.some(Boolean)) ? USAGE_COLUMNS : '', jira: this._jiraView === 'mine' ? c.jira : this._views[this._jiraView]?.issues.length ?? 0};
        for (const [id] of SECTIONS) {
            this._counters[id]?.set_text(String(shown[id]));
            this._cardCounters?.[id]?.set_text(String(shown[id]));
        }
        const ib = this._cfg.inboxEnabled ? this._inboxStats ?? {unread: 0, needs: false} : null;
        if (ib) {
            this._bell.num.set_text(String(ib.unread));
            this._bell.dot.visible = ib.needs;
            this._bell.btn.opacity = ib.unread || ib.needs ? 255 : 115;
            this._bell.btn.accessible_name = `Avisos: ${ib.unread} sin leer`;
        }
        const five = panelRing(this._usage, this._cfg.usagePanelProvider);
        this._mini.actor.visible = !!five;
        if (five) {
            this._mini.set(five);
            this._mini.actor.opacity = five.dim ? DIM_OPACITY : 255;
        }
        this._mini.actor.accessible_name = five?.label ?? '';
        if (needs)
            this.add_style_class_name('kaito-attention');
        else
            this.remove_style_class_name('kaito-attention');
        this.accessible_name = `Kaito: ${c.agents} agentes`
            + (needs ? `, ${needs} ${needs === 1 ? 'te necesita' : 'te necesitan'}` : '')
            + (this._cfg.jiraEnabled ? `, ${c.jira} tickets` : '') + `, ${c.todos} ${this._cfg.kanbanEnabled ? 'tareas' : 'pendientes'}`
            + (ib?.unread ? `, ${ib.unread} avisos` : '')
            + (five ? `, ${five.label}` : '')
            + (this._ext.quiet?.quiet ? ', no molestar' : '')
            + (this._updatePending ? ', actualización disponible' : '');
    }

    /** Todo lo local (agentes, pendientes, config); sin red. */
    refreshLocal() {
        this._cfg = readConfig();
        this._schedule();
        this._loadAgents();
        this._loadUsage();
        this._syncPinned();
        this._syncFeatures();
        const vsig = JSON.stringify(visibleViews(this._cfg));
        if (vsig !== this._viewsSig) {
            this._viewsSig = vsig;
            const prev = this._jiraView;
            this._renderJiraTabs();
            if (this._jiraView !== prev)
                this._renderSection('jira');
        }
        if (this._jiraOn !== this._cfg.jiraEnabled) {
            this._jiraOn = this._cfg.jiraEnabled;
            if (!this._jiraOn) {
                this._jira = {issues: []};
                this._views = {};
                this._jiraExpand = null;
                this._jiraPick = null;
            }
            this._syncJiraVisible();
            this._renderSection('jira');
        }
        this._renderSection('usage');
        this._renderSection('agents');
        const sig = Object.entries(this._byTicket).map(([k, a]) => `${k}:${a.id}:${a.cwd}`).sort().join();
        if (sig !== this._ticketSig) {
            this._ticketSig = sig;
            if (this._jira.issues.length)
                this._renderSection('jira');
        }
        for (const id of ['todos', 'reminders', 'tasks', 'notes'])
            this._renderSection(id);
        this._updateLabel();
    }

    async _refresh() {
        this.refreshLocal();
        if (this._fetching)
            return;
        if (!this._cfg.jiraEnabled) { // Jira desactivado: nada de red
            this._jiraLoaded = true;
            this._maybeDaily();
            return;
        }
        this._fetching = true;
        try {
            const r = await fetchJira(this._session);
            this._jira = r.setup ? {setup: r.setup, issues: []} : {issues: r.issues, base: r.base};
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return;
            this._jira = {error: e.message, issues: []};
        } finally {
            this._fetching = false;
        }
        if (this._cancellable.is_cancelled())
            return;
        this._jiraLoaded = true;
        this._renderSection('jira');
        this._updateLabel();
        this._maybeDaily();
        // Solo la vista activa se refresca con el temporizador ("Mías" siempre, arriba).
        if (this._jiraView !== 'mine')
            await this._fetchView(this._jiraView);
    }

    /** Resumen de la mañana: una vez al día, en el primer refresco a partir de las 06:00. */
    _maybeDaily() {
        if (!this._cfg.dailySummary || this._jira.error)
            return; // con Jira caído se reintenta en el siguiente refresco
        if (this._ext.quiet?.quiet)
            return; // con No molestar no se marca como visto: sale en el primer refresco al terminar
        const now = new Date();
        if (!shouldShowDaily(readDailyDay(), now))
            return;
        try {
            writeDailyDay(localDay(now));
        } catch (e) {
            console.error(`kaito: no se pudo guardar daily.json: ${e.message}`);
            return;
        }
        const lines = dailySummaryLines({issues: this._jira.issues, reminders: readReminders(),
            agents: this._agents.filter(a => a.state !== 'open'), now}); // sin estado (Gemini…): no "esperan"
        if (lines.length)
            this._ext.showDaily(lines);
    }

    destroy() {
        this._cancellable.cancel();
        this._jiraPick = null; // un idle_add pendiente del buscador ya no repinta nada
        this._update?.destroy();
        this._session.abort();
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        for (const id of Object.values(this._deb)) {
            if (id)
                GLib.source_remove(id);
        }
        this._deb = {};
        for (const m of this._monitors)
            m.cancel();
        this._monitors = [];
        for (const id of this._overviewIds)
            Main.overview.disconnect(id);
        Main.layoutManager.disconnect(this._monitorsId);
        if (this._collapseId) {
            GLib.source_remove(this._collapseId);
            this._collapseId = 0;
        }
        if (this._confirmId) {
            GLib.source_remove(this._confirmId);
            this._confirmId = 0;
        }
        for (const t of this._assignTimers)
            GLib.source_remove(t);
        this._assignTimers.clear();
        this._needNotes.clear();
        this._source?.destroy();
        this._source = null;
        this.remove_all_transitions();
        if (this._card)
            this._destroyCard();
        super.destroy();
    }
}));

/**
 * Implementación de la extensión; la crea y destruye el cargador (extension.js) en cada (re)carga.
 * ctx: {extension, dir, path, uuid, metadata, loadId, shared, reload}. Los recursos (icons/, bin/,
 * stylesheet.css) se buscan siempre en ctx.path (la carpeta real), nunca junto a import.meta.url.
 */
export default class KaitoMain {
    constructor(ctx) {
        this._ctx = ctx;
        this.uuid = ctx.uuid;
        this.path = ctx.path;
        this.dir = ctx.dir;
        this.metadata = ctx.metadata;
        this.loadId = ctx.loadId;
        this.shared = ctx.shared;
    }

    getSettings() {
        return this._ctx.extension.getSettings();
    }

    openPreferences() {
        this._ctx.extension.openPreferences();
    }

    /** Recarga el código (lo usa "Actualizar"). */
    reload() {
        return this._ctx.reload();
    }

    enable() {
        console.log(`kaito: cargado build ${this.loadId}`);
        try {
            const m = migrateTerminalOnce(); // 'warp' guardado -> 'auto' (una sola vez)
            if (m?.terminal)
                console.log('kaito: terminal migrado de warp a auto');
        } catch (e) {
            console.warn(`kaito: migración de terminal: ${e.message}`);
        }
        this._settings = this.getSettings();
        // No molestar antes que el indicador (el menú y el panel lo consultan al construirse).
        this.quiet = new QuietController({
            onChange: q => {
                this._indicator?.syncQuiet(q);
                this._reminders?.check(); // recordatorios retenidos: salen al terminar el silencio
            },
            onFlush: items => this._showQueued(items),
        });
        this._capture = new CaptureModal(() => {
            this._indicator?.refreshLocal();
            this._tickTasks();
        }, {issueSummary: key => this._indicator?._issueSummary(key) ?? '', extensionDir: this.path});
        this._taskResult = new TaskResultModal({
            comment: (task, run) => this.commentTask(task, run),
            canComment: () => readConfig().jiraEnabled,
        });
        this.tasks = new TaskScheduler({
            onStart: () => this._indicator?._renderSection('tasks'),
            onFinish: (task, run) => this._onTaskFinish(task, run),
        });
        this._reply = new ReplyModal({
            focus: a => this._indicator?.focusAgent(a),
            refresh: () => this._indicator?.refreshLocal(),
        });
        this._comment = new CommentModal(() => {
            this._commentSession ??= new Soup.Session({timeout: 20});
            return this._commentSession;
        });
        // Opcionales (kanbanEnabled / inboxEnabled): se crean siempre, solo se abren si están activados.
        this.kanban = new KanbanBoard(this._kanbanHooks());
        this.inbox = new InboxPanel(this._inboxHooks());
        this._indicator = new (indicatorClass(this.loadId))(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        // Tras crear el indicador: así, al vencerse algo, la lista del menú ya está montada.
        this._reminders = new ReminderManager(() => this._indicator?.refreshLocal(), {
            quiet: () => this.quiet && {quiet: this.quiet.quiet, holdReminders: this.quiet.holdReminders},
            onDue: list => this._remindersDue(list),
            snoozeMinutes: () => readConfig().snoozeMinutes,
        });

        this._taskTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TASK_TICK_S, () => {
            this._tickTasks();
            return GLib.SOURCE_CONTINUE;
        });
        this._taskFirst = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TASK_FIRST_TICK_S, () => {
            this._taskFirst = 0;
            this._tickTasks();
            return GLib.SOURCE_REMOVE;
        });

        Main.wm.addKeybinding(SHORTCUT_KEY, this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.openCapture());
        this._shortcutId = this._settings.connect(`changed::${SHORTCUT_KEY}`,
            () => this._indicator?.syncShortcutLabel());
        this._kanbanKeyId = this._settings.settings_schema.has_key(KANBAN_KEY)
            ? this._settings.connect(`changed::${KANBAN_KEY}`, () => this._indicator?.syncShortcutLabel()) : 0;
        this._indicator.syncShortcutLabel();
    }

    // --- Tablero de tareas (opcional) ---

    /** Atajo global del tablero: solo con el tablero activado (y si el esquema ya tiene la clave). */
    syncKanbanKey(on) {
        if (on === !!this._kanbanBound || !this._settings)
            return;
        if (on) {
            if (!this._settings.settings_schema.has_key(KANBAN_KEY)) {
                if (!this._kanbanKeyWarned)
                    console.warn(`kaito: el esquema instalado no tiene ${KANBAN_KEY}: cierra sesión y vuelve a entrar para el atajo del tablero`);
                this._kanbanKeyWarned = true;
                return;
            }
            Main.wm.addKeybinding(KANBAN_KEY, this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP, () => this.toggleKanban());
            this._kanbanBound = true;
        } else {
            Main.wm.removeKeybinding(KANBAN_KEY);
            this._kanbanBound = false;
        }
    }

    openKanban(taskId = null) {
        if (!readConfig().kanbanEnabled)
            return;
        if (!this.kanban.isOpen)
            this._closeModals();
        this.kanban.open(taskId);
    }

    toggleKanban() {
        if (this.kanban?.isOpen)
            this.kanban.close();
        else
            this.openKanban();
    }

    _repoList(task) {
        const ind = this._indicator;
        let repos = [];
        try {
            repos = collectRepos();
            const now = GLib.get_monotonic_time() / 1e6;
            if (ind && (!ind._scan || now - ind._scan.t > 300))
                ind._scan = {t: now, list: scanRepos(ind._cfg.repoRoots)};
            const seen = new Set(repos.map(r => r.path));
            repos = [...repos, ...(ind?._scan?.list ?? []).filter(r => !seen.has(r.path))];
        } catch (e) {
            console.warn(`kaito: repos: ${e.message}`);
        }
        const issue = {key: task?.id ?? '', summary: task?.text ?? '', description: task?.description ?? ''};
        return rankRepos(issue, repos, ind?._cfg ?? readConfig(), p => GLib.file_test(p, GLib.FileTest.IS_DIR));
    }

    _kanbanHooks() {
        return {
            agentFor: id => this._indicator?._byTicket[id] ?? null,
            repoCandidates: task => {
                const list = this._repoList(task).map(r => r.path);
                return task.repo && !list.includes(task.repo) ? [task.repo, ...list] : list;
            },
            allRepos: task => this._repoList(task),
            chooseFolder: title => this._chooseFolder(title),
            send: (task, repo) => this._sendTaskToClaude(task, repo),
            scheduleReview: task => this.openTaskCapture(REVIEW_PREFILL(task.id)),
            focusAgent: a => this._indicator?.focusAgent(a),
            dueFor: task => {
                const r = readReminders().filter(x => !x.done && String(x.text).includes(task.id))
                    .sort((a, b) => new Date(a.due) - new Date(b.due))[0];
                return r ? shortLabel(new Date(r.due), new Date()) : null;
            },
            changed: () => {
                this._indicator?._renderSection('todos');
                this._indicator?._updateLabel();
            },
        };
    }

    async _chooseFolder(title) {
        try {
            const proc = Gio.Subprocess.new(['zenity', '--file-selection', '--directory', `--title=${title}`],
                Gio.SubprocessFlags.STDOUT_PIPE);
            const [out] = await proc.communicate_utf8_async(null, null);
            const dir = (out ?? '').trim();
            return proc.get_successful() && dir.startsWith('/') && GLib.file_test(dir, GLib.FileTest.IS_DIR) ? dir : null;
        } catch (e) {
            console.warn(`kaito: selector de carpeta: ${e.message}`);
            return null;
        }
    }

    /** "Mandar a Claude" desde el tablero: mismo lanzamiento que un ticket, con el prompt de la tarea. */
    _sendTaskToClaude(task, repo) {
        const cfg = readConfig();
        try {
            const branch = `${task.id}-${taskSlug(task.text)}`;
            sendIssueToClaude({
                issue: {key: task.id, summary: task.text}, base: '', description: null, repo, terminal: cfg.terminal,
                prompt: localTaskPrompt(task, repo, repoBranch(repo)),
            });
            patchBoardTask(task.id, x => ({...withState(x, todoState(x) === 'todo' ? 'doing' : todoState(x)), repo}));
            Main.notify('Kaito', `${task.id} enviada a Claude en ${GLib.path_get_basename(repo)} · rama ${branch}`);
        } catch (e) {
            Main.notify('Kaito', `No se pudo mandar ${task.id} a Claude: ${e.message}`);
        }
        this.kanban?.refresh();
        this._indicator?.refreshLocal();
    }

    // --- Panel de avisos (opcional) ---

    openInbox() {
        if (!readConfig().inboxEnabled)
            return;
        if (this.inbox.isOpen) {
            this.inbox.close();
            return;
        }
        this._closeModals();
        this.inbox.open();
    }

    get _inboxOn() {
        return this._indicator?._cfg.inboxEnabled ?? readConfig().inboxEnabled;
    }

    /** Guarda un aviso en el panel. once: no lo repite si ya está (recordatorios que se revisan cada 20 s). */
    inboxAdd(item, once = false) {
        try {
            const list = readInbox();
            if (once && list.some(x => x.id === item.id))
                return;
            writeInbox(inboxPush(list, item));
        } catch (e) {
            console.warn(`kaito: inbox.json: ${e.message}`);
        }
        this._indicator?._loadInboxStats();
        this._indicator?._updateLabel();
        this.inbox?.refresh();
    }

    /** El agente ya no te necesita: sus "te necesita" pendientes quedan resueltos con `text`. */
    inboxResolveNeeds(agentId, text) {
        try {
            const list = readInbox();
            let next = list;
            for (const x of list) {
                if (x.kind === 'needs' && x.agentId === agentId && !x.resolved)
                    next = resolveItem(next, x.id, text);
            }
            if (next !== list)
                writeInbox(next);
        } catch (e) {
            console.warn(`kaito: inbox.json: ${e.message}`);
        }
    }

    _inboxHooks() {
        return {
            agent: id => this._indicator?._agents.find(a => a.id === id) ?? null,
            decide: (agent, behavior) => {
                if (!canDecide(agent))
                    return 'La petición ya no espera respuesta: contesta en la terminal';
                try {
                    writeDecision(agent.id, agent.hook.request, behavior);
                } catch (e) {
                    return `No se pudo enviar: ${e.message}`;
                }
                this._indicator?.refreshLocal();
                return true;
            },
            reply: (agent, text) => this.copyReplyTo(agent, text),
            action: action => this._inboxAction(action),
            quiet: () => this.quiet?.state ?? {quiet: false},
            setDnd: mins => this.quiet?.setMinutes(mins),
            dndOff: () => this.quiet?.set('off'),
            changed: () => {
                this._indicator?._loadInboxStats();
                this._indicator?._updateLabel();
            },
        };
    }

    /**
     * Texto libre para un agente: Claude Code no deja escribir en su sesión desde fuera, así que (como en
     * el cuadro de respuesta) se copia al portapapeles y se enfoca su terminal.
     */
    copyReplyTo(agent, text) {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._indicator?.focusAgent(agent);
        Main.notify('Kaito', 'Copiado. Pégalo con Ctrl+Shift+V en la terminal');
    }

    /** Acciones guardadas en un aviso del panel: {type: agent|url|review|task|taskComment|comment|update|reminder*}. */
    _inboxAction(action) {
        const ind = this._indicator;
        switch (action?.type) {
        case 'url':
            try {
                Gio.AppInfo.launch_default_for_uri(action.url, null);
            } catch (e) {
                console.warn(`kaito: no se pudo abrir ${action.url}: ${e.message}`);
            }
            break;
        case 'review':
            this.openTaskCapture(REVIEW_PREFILL(action.key));
            break;
        case 'board':
            this.openKanban(action.id ?? null);
            break;
        case 'taskComment': {
            const task = this._findTask(action.id);
            if (task)
                this.commentTask(task, readLastRun(task.id));
            break;
        }
        case 'comment': {
            const live = ind?._agents.find(a => a.ticket === action.ticket);
            const cwdPath = action.cwdPath ?? null;
            this.openComment(live ?? {ticket: action.ticket, cwdPath, cwd: action.cwd ?? '?', lastText: ''},
                ind?._issueSummary(action.ticket) ?? '');
            break;
        }
        case 'reminderDone':
        case 'reminderSnooze':
            try {
                patchReminder(action.id, r => {
                    if (action.type === 'reminderDone') {
                        r.done = true;
                    } else {
                        r.due = snoozeUntil(readConfig().snoozeMinutes, new Date()).toISOString();
                        r.snoozes = (r.snoozes ?? 0) + 1;
                    }
                });
            } catch (e) {
                console.warn(`kaito: recordatorio: ${e.message}`);
            }
            this._reminders?.check();
            ind?.refreshLocal();
            break;
        default:
            this._queuedAction(action);
        }
    }

    _findTask(id) {
        try {
            return readTasks().find(t => t.id === id) ?? null;
        } catch (e) {
            console.warn(`kaito: tareas: ${e.message}`);
            return null;
        }
    }

    /** Recordatorios vencidos (se muestren o los retenga No molestar): también al panel, una vez cada uno. */
    _remindersDue(list) {
        if (!this._inboxOn)
            return;
        for (const r of list) {
            this.inboxAdd({
                id: `rem:${r.id}:${r.due}`, kind: 'reminder', title: r.text, body: '',
                actions: [{label: `Posponer ${snoozeLabel(readConfig().snoozeMinutes)}`, action: {type: 'reminderSnooze', id: r.id}},
                    {label: 'Hecho', action: {type: 'reminderDone', id: r.id}}],
            }, true);
        }
    }

    openCapture() {
        if (this._capture.isOpen)
            return;
        this._closeModals();
        this._capture.open();
    }

    checkReminders() {
        this._reminders?.check();
    }

    /** Ejecuta las tareas que tocan (si están activadas en Ajustes). */
    _tickTasks() {
        if (!this.tasks || !readConfig().tasksEnabled)
            return;
        if (this.tasks.tick().length)
            this._indicator?._renderSection('tasks');
    }

    _onTaskFinish(task, run) {
        this._indicator?._renderSection('tasks');
        this._indicator?._updateLabel();
        if (this._inboxOn) {
            const title = `Tarea «${task.name}» · ${run.ok ? 'terminada' : 'falló'}`;
            const comment = task.key && readConfig().jiraEnabled;
            this.inboxAdd({
                id: `task:${task.id}:${run.finished ?? Date.now()}`, kind: 'task', repo: task.name, title,
                body: run.summary ?? '', actions: [{label: 'Ver completo', action: {type: 'task', id: task.id}},
                    ...comment ? [{label: 'Comentar en Jira', action: {type: 'taskComment', id: task.id}}] : []],
            });
            if (inboxRoute('task', this.quiet?.state) === 'brief') {
                this._indicator?._notify(title, run.summary ?? '', {
                    activate: () => this.openTaskResult(task, run),
                    actions: [['Ver completo', () => this.openTaskResult(task, run)],
                        ...comment ? [['Comentar en Jira', () => this.commentTask(task, run)]] : []],
                });
            }
            return;
        }
        if (this.quiet?.defer({key: `task:${task.id}`, text: `Tarea «${task.name}» · ${run.ok ? 'terminada' : 'falló'}`,
            action: {type: 'task', id: task.id}}))
            return;
        this._reminders?.showTaskResult({
            id: task.id, name: task.name, ok: run.ok, summary: run.summary, key: task.key,
            onView: () => this.openTaskResult(task, run),
            onComment: task.key && readConfig().jiraEnabled ? () => this.commentTask(task, run) : null,
        });
    }

    /** Fin del silencio: una tarjeta "Mientras no estabas" con todo lo retenido. */
    _showQueued(items) {
        if (this._inboxOn) { // con el panel no hay tarjeta "Mientras no estabas": todo queda en el panel
            const LABEL = {agent: 'Ir al agente', task: 'Ver completo', update: 'Actualizar'};
            const KIND = {needs: 'needs', done: 'done', fin: 'finished', task: 'task', update: 'update'};
            for (const it of items) {
                this.inboxAdd({
                    id: `quiet:${it.key}`, kind: KIND[String(it.key).split(':')[0]] ?? 'done', title: it.text, ts: it.at,
                    actions: it.action && LABEL[it.action.type] ? [{label: LABEL[it.action.type], action: it.action}] : [],
                }, true);
            }
            return;
        }
        this._reminders?.showQueued(items, it => this._queuedAction(it.action));
    }

    /** Acción de una línea de "Mientras no estabas": {type: 'agent'|'task'|'update', id?}. */
    _queuedAction(action) {
        const ind = this._indicator;
        if (action?.type === 'agent') {
            const a = ind?._agents.find(x => x.id === action.id);
            if (a?.state === 'needs')
                this.openReply(a);
            else if (a && Number.isInteger(a.pid))
                ind.focusAgent(a);
        } else if (action?.type === 'task') {
            let task = null;
            try {
                task = readTasks().find(t => t.id === action.id) ?? null;
            } catch (e) {
                console.warn(`kaito: tareas: ${e.message}`);
            }
            if (task)
                this.openTaskResult(task);
        } else if (action?.type === 'update') {
            ind?._update?.update().catch(e => console.warn(`kaito: actualizar: ${e.message}`));
        }
    }

    /** Captura en la pestaña Tarea, con texto inicial (p. ej. "RUN-1: revisa que "). */
    openTaskCapture(text = '') {
        this._closeModals();
        this._capture.open(text, 'task');
    }

    /** Resultado completo de la última ejecución (o de `run`). */
    openTaskResult(task, run = null) {
        this._closeModals();
        let last = run;
        if (!last) {
            try {
                last = readLastRun(task.id);
            } catch (e) {
                console.warn(`kaito: historial de ${task.id}: ${e.message}`);
            }
        }
        this._taskResult.open(task, last);
    }

    /** "Comentar en Jira" con los hallazgos ya escritos (editable; Enter publica, nunca solo). */
    commentTask(task, run) {
        if (!task.key)
            return;
        const cwdPath = String(task.cwd ?? '').replace(/^~(?=\/|$)/, GLib.get_home_dir());
        const agent = {ticket: task.key, cwdPath, cwd: cwdPath.split('/').filter(Boolean).pop() ?? '~', lastText: ''};
        const text = findingsComment(task, run);
        this._closeModals();
        this._comment.open(agent, this._indicator?._issueSummary(task.key) ?? '', text);
    }

    _closeModals() {
        this._indicator?.menu.close();
        this.kanban?.close();
        this.inbox?.close();
        this._capture?.close();
        this._reply?.close();
        this._comment?.close();
        this._taskResult?.close();
    }

    openReply(agent) {
        this._closeModals();
        this._reply.open(agent);
    }

    openComment(agent, summary = '') {
        this._closeModals();
        this._comment.open(agent, summary);
    }

    showDaily(lines) {
        this._reminders?.showDaily(lines);
    }

    showFinished(info) {
        if (this._inboxOn) {
            const actions = [];
            if (info.prUrl)
                actions.push({label: 'Abrir PR', action: {type: 'url', url: info.prUrl}});
            if (info.onFocus && info.agentId)
                actions.push({label: 'Ir al agente', action: {type: 'agent', id: info.agentId}});
            if (info.onSchedule && info.ticket)
                actions.push({label: 'Revisar', action: {type: 'review', key: info.ticket}});
            this.inboxAdd({
                id: `fin:${info.id}`, kind: 'finished', agentId: info.agentId ?? null, provider: info.provider ?? null,
                repo: info.repo ?? null, title: info.title, body: [info.meta, ...info.lines.map(l => l.text)].filter(Boolean).join('\n'),
                actions,
            });
            if (inboxRoute('finished', this.quiet?.state) === 'brief') {
                const cb = [];
                if (info.prUrl)
                    cb.push(['Abrir PR', () => this._inboxAction({type: 'url', url: info.prUrl})]);
                if (info.onFocus)
                    cb.push(['Ir al agente', info.onFocus]);
                if (info.onSchedule)
                    cb.push(['Programar revisión', info.onSchedule]);
                this._indicator?._notify(info.title, info.lines.map(l => l.text).join('\n'), {activate: cb[0]?.[1] ?? null, actions: cb});
            }
            return;
        }
        if (this.quiet?.defer({key: `fin:${info.id}`, text: `${info.title} · ${info.meta}`,
            action: info.agentId ? {type: 'agent', id: info.agentId} : null}))
            return;
        this._reminders?.showFinished(info);
    }

    disable() {
        for (const id of [this._taskTimer, this._taskFirst]) {
            if (id)
                GLib.source_remove(id);
        }
        this._taskTimer = this._taskFirst = 0;
        this.tasks?.destroy(); // cancela la que corra: se repetirá al volver (nextRun sigue vencido)
        this.tasks = null;
        this._taskResult?.destroy();
        this._taskResult = null;
        Main.wm.removeKeybinding(SHORTCUT_KEY);
        this._settings?.disconnect(this._shortcutId);
        if (this._kanbanKeyId)
            this._settings?.disconnect(this._kanbanKeyId);
        if (this._kanbanBound)
            Main.wm.removeKeybinding(KANBAN_KEY);
        this._kanbanBound = false;
        this.kanban?.destroy();
        this.kanban = null;
        this.inbox?.destroy();
        this.inbox = null;
        this._capture?.destroy();
        this._capture = null;
        this._reply?.destroy();
        this._reply = null;
        this._comment?.destroy();
        this._comment = null;
        this._commentSession?.abort();
        this._commentSession = null;
        this._reminders?.destroy();
        this._reminders = null;
        this._indicator?.destroy();
        this._indicator = null;
        this.quiet?.destroy();
        this.quiet = null;
        cancelPendingUris();
        this._settings = null;
    }
}
