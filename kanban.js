// Tablero de tareas (opcional, kanbanEnabled): panel grande centrado con 4 columnas y la vista de detalle.
// Datos en todos.json (common.js readBoard/patchBoardTask/addBoardTask); lógica pura en board.js.
// Como capture.js: overlay a pantalla completa (Esc y clic fuera cierran), por debajo de la herramienta de
// capturas. El modal usa ActionMode.POPUP: el atajo del tablero sigue funcionando para cerrarlo.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {readBoard, patchBoardTask, addBoardTask, filterRepos} from './common.js';
import {
    STATES, STATE_NAMES, STATE_COLORS, PRIORITY_GLYPHS, DEFAULT_PRIORITY, boardColumns, boardCounts, withState,
    stepState, cyclePriority, todoState, relAgo,
} from './board.js';
import {agoLabel} from './inbox.js';

const MARGIN = 48; // px lógicos alrededor del panel
const GAP = 12;
const PICK_MAX = 8;
const CONFIRM_MS = 4000;
const HINT = 'Funciona igual que con un ticket de Jira: elige repo, Claude crea una rama con el número de la tarea, ' +
    'hace commits y al terminar la tarjeta pasa sola a «En revisión» con el aviso «listo».';

const lbl = (text, cls = '', extra = {}) => new St.Label({text, style_class: cls, y_align: Clutter.ActorAlign.CENTER, ...extra});
/** "#5BC8AF", 0.35 → "rgba(91,200,175,0.35)" (St no entiende #RRGGBBAA). */
const rgba = (hex, a) => `rgba(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',')},${a})`;
const base = p => String(p ?? '').split('/').filter(Boolean).pop() ?? p;
const tilde = p => (p && p.startsWith(GLib.get_home_dir()) ? `~${p.slice(GLib.get_home_dir().length)}` : p);

function wrapped(text, cls, extra = {}) {
    const l = new St.Label({text, style_class: cls, x_expand: true, ...extra});
    l.clutter_text.line_wrap = true;
    l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return l;
}

function button(label, cls, onClick, extra = {}) {
    const b = new St.Button({label, style_class: cls, can_focus: true, track_hover: true, y_align: Clutter.ActorAlign.CENTER, ...extra});
    b.connect('clicked', () => onClick(b));
    return b;
}

function prioGlyph(p) {
    const [g, color, name] = PRIORITY_GLYPHS[p] ?? PRIORITY_GLYPHS[DEFAULT_PRIORITY];
    return lbl(g, 'kaito-board-prio', {style: `color: ${color};`, accessible_name: `Prioridad ${name.toLowerCase()}`});
}

export class KanbanBoard {
    /**
     * @param {object} hooks {agentFor(id), repoCandidates(task) → [path], allRepos() → [{path}], chooseFolder(title) →
     *   Promise<path|null>, send(task, repo), scheduleReview(task), focusAgent(agent), dueFor(task) → texto|null,
     *   changed()}
     */
    constructor(hooks) {
        this._hooks = hooks;
        this._overlay = null;
        this._query = '';
    }

    get isOpen() {
        return this._overlay !== null;
    }

    /** Abre el tablero (o el detalle de `taskId`). */
    open(taskId = null) {
        if (this._overlay) {
            if (taskId)
                this._openDetail(taskId);
            return;
        }
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const overlay = new St.Widget({
            style_class: 'kaito-capture-overlay', reactive: true,
            x: mon.x, y: mon.y, width: mon.width, height: mon.height,
        });
        overlay.connect('button-press-event', (_a, ev) => {
            if (ev.get_source() === overlay)
                this.close();
            return Clutter.EVENT_STOP;
        });
        overlay.connect('key-press-event', (_a, ev) => this._onKey(ev));
        const m = MARGIN * scale;
        const top = Main.panel.height + 16 * scale;
        this._w = Math.max(600 * scale, mon.width - 2 * m);
        this._h = Math.max(400 * scale, mon.height - top - m);
        this._scale = scale;
        const panel = new St.BoxLayout({
            style_class: 'kaito-board', vertical: true, reactive: true,
            x: Math.round((mon.width - this._w) / 2), y: top, width: this._w, height: this._h,
        });
        overlay.add_child(panel);
        this._panel = panel;
        this._overlay = overlay;
        Main.layoutManager.addTopChrome(overlay);
        // Por debajo de la herramienta de capturas de GNOME, para poder fotografiarlo.
        Main.layoutManager.uiGroup.set_child_below_sibling(overlay, Main.layoutManager.screenshotUIGroup);
        this._grab = Main.pushModal(overlay, {actionMode: Shell.ActionMode.POPUP});
        this._detail = null;
        this._showBoard();
        if (taskId)
            this._openDetail(taskId);
    }

    close() {
        const overlay = this._overlay;
        if (!overlay)
            return;
        this._saveDetail();
        this._clearConfirm();
        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }
        this._overlay = null;
        try {
            Main.popModal(this._grab);
        } catch (e) {
            console.warn(`kaito: popModal: ${e.message}`);
        }
        this._grab = null;
        Main.layoutManager.removeChrome(overlay);
        overlay.destroy();
        this._panel = this._body = this._cols = this._search = this._counts = null;
        this._detail = null;
    }

    destroy() {
        this.close();
    }

    /** todos.json cambió fuera (menú, otra ventana): repinta el tablero si no se está editando. */
    refresh() {
        if (this._overlay && !this._detail)
            this._renderColumns();
    }

    _onKey(ev) {
        if (ev.get_key_symbol() !== Clutter.KEY_Escape)
            return Clutter.EVENT_PROPAGATE;
        if (this._detail?.picker) {
            this._detail.picker = null;
            this._renderDetail();
        } else if (this._detail) {
            this._backToBoard();
        } else {
            this.close();
        }
        return Clutter.EVENT_STOP;
    }

    _tasks() {
        try {
            return readBoard();
        } catch (e) {
            console.warn(`kaito: tablero: ${e.message}`);
            return [];
        }
    }

    // --- Vista de columnas ---

    _showBoard() {
        this._panel.destroy_all_children();
        const head = new St.BoxLayout({style_class: 'kaito-board-head', x_expand: true});
        const titles = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER});
        titles.add_child(lbl('Tablero', 'kaito-board-title'));
        this._counts = lbl('', 'kaito-capture-muted kaito-board-counts');
        titles.add_child(this._counts);
        head.add_child(titles);
        head.add_child(new St.Widget({x_expand: true}));
        this._search = new St.Entry({
            style_class: 'kaito-entry kaito-board-search', hint_text: 'Buscar tareas o repo', can_focus: true,
            text: this._query, y_align: Clutter.ActorAlign.CENTER,
        });
        this._search.clutter_text.connect('text-changed', () => {
            this._query = this._search.get_text();
            if (this._idleId)
                return;
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._idleId = 0;
                if (this._overlay && !this._detail)
                    this._renderColumns();
                return GLib.SOURCE_REMOVE;
            });
        });
        head.add_child(this._search);
        head.add_child(button('Nueva tarea', 'kaito-board-btn kaito-board-primary', () => this._openDetail(null)));
        head.add_child(new St.Button({
            style_class: 'kaito-card-close', can_focus: true, track_hover: true, accessible_name: 'Cerrar tablero',
            y_align: Clutter.ActorAlign.CENTER, child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 16}),
        }));
        head.last_child.connect('clicked', () => this.close());
        this._panel.add_child(head);
        this._cols = new St.BoxLayout({style_class: 'kaito-board-cols', x_expand: true, y_expand: true});
        this._panel.add_child(this._cols);
        this._renderColumns();
        this._search.grab_key_focus();
        this._search.clutter_text.set_cursor_position(-1);
    }

    _renderColumns() {
        if (!this._cols)
            return;
        const todos = this._tasks();
        const c = boardCounts(todos);
        this._counts.set_text(`${c.open} ${c.open === 1 ? 'abierta' : 'abiertas'} · ${c.doneWeek} ${c.doneWeek === 1 ? 'hecha' : 'hechas'} esta semana`);
        this._cols.destroy_all_children();
        const cols = boardColumns(todos, this._query);
        const pad = 2 * 18 * this._scale; // padding horizontal del panel (stylesheet .kaito-board)
        const colW = Math.floor((this._w - pad - 3 * GAP * this._scale) / 4);
        STATES.forEach((st, i) => {
            const col = new St.BoxLayout({style_class: 'kaito-board-col', vertical: true, width: colW, y_expand: true});
            const h = new St.BoxLayout({style_class: 'kaito-board-col-head'});
            h.add_child(new St.Widget({style_class: 'kaito-dot', style: `background-color: ${STATE_COLORS[st]};`, y_align: Clutter.ActorAlign.CENTER}));
            h.add_child(lbl(STATE_NAMES[st], 'kaito-board-col-name'));
            h.add_child(lbl(String(cols[st].length), 'kaito-capture-muted'));
            col.add_child(h);
            const list = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'kaito-board-list'});
            for (const t of cols[st])
                list.add_child(this._card(t, i));
            if (!cols[st].length)
                list.add_child(lbl(this._query ? 'Nada coincide' : 'Vacío', 'kaito-capture-muted kaito-board-empty'));
            col.add_child(new St.ScrollView({
                child: list, x_expand: true, y_expand: true, overlay_scrollbars: true,
                hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            }));
            this._cols.add_child(col);
        });
    }

    _card(t, i) {
        const st = STATES[i];
        const card = new St.BoxLayout({style_class: 'kaito-board-card', vertical: true, x_expand: true});
        card._kaitoTask = t.id;
        const main = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'kaito-board-card-main'});
        const top = new St.BoxLayout({style_class: 'kaito-board-card-top', x_expand: true});
        top.add_child(prioGlyph(t.priority));
        top.add_child(wrapped(t.text || '(sin título)', st === 'done' ? 'kaito-board-card-title kaito-board-strike' : 'kaito-board-card-title'));
        main.add_child(top);
        const chips = new St.BoxLayout({style_class: 'kaito-board-chips'});
        chips.add_child(lbl(t.id, 'kaito-key kaito-board-key'));
        if (t.repo)
            chips.add_child(lbl(base(t.repo), 'kaito-board-chip'));
        const agent = st !== 'done' ? this._hooks.agentFor?.(t.id) : null;
        if (agent) {
            const w = new St.BoxLayout({style_class: 'kaito-board-agent'});
            w.add_child(new St.Widget({style_class: 'kaito-dot', style: 'background-color: #5BC8AF;', y_align: Clutter.ActorAlign.CENTER}));
            w.add_child(lbl('Claude trabajando', 'kaito-teal'));
            chips.add_child(w);
        }
        const due = st !== 'done' ? this._hooks.dueFor?.(t) : null;
        if (due)
            chips.add_child(lbl(due, 'kaito-board-due'));
        main.add_child(chips);
        const open = new St.Button({
            style_class: 'kaito-board-card-btn', child: main, can_focus: true, track_hover: true,
            x_expand: true, x_align: Clutter.ActorAlign.FILL, accessible_name: `Abrir ${t.id}`,
        });
        open.connect('clicked', () => this._openDetail(t.id));
        card.add_child(open);
        const moves = new St.BoxLayout({style_class: 'kaito-board-moves', x_expand: true});
        if (i > 0)
            moves.add_child(button('←', 'kaito-board-move', () => this._move(t.id, -1), {accessible_name: `Mover a ${STATE_NAMES[STATES[i - 1]]}`}));
        moves.add_child(new St.Widget({x_expand: true}));
        if (i < STATES.length - 1)
            moves.add_child(button(`→ ${STATE_NAMES[STATES[i + 1]]}`, 'kaito-board-move', () => this._move(t.id, 1)));
        card.add_child(moves);
        return card;
    }

    /** ← / →: cambia de columna. */
    _move(id, dir) {
        try {
            patchBoardTask(id, t => {
                const next = stepState(todoState(t), dir);
                return next ? withState(t, next) : t;
            });
        } catch (e) {
            console.warn(`kaito: mover ${id}: ${e.message}`);
        }
        this._renderColumns();
        this._hooks.changed?.();
    }

    // --- Detalle ---

    _openDetail(id) {
        this._saveDetail();
        let task;
        if (id) {
            task = this._tasks().find(t => t.id === id);
            if (!task)
                return;
        } else {
            task = {id: null, text: '', description: '', priority: DEFAULT_PRIORITY, state: 'todo', repo: null};
        }
        this._detail = {task: {...task}, picker: null, repos: null, confirm: false};
        this._renderDetail();
    }

    /** Guarda título y descripción (y crea la tarea nueva si tiene título). */
    _saveDetail() {
        const d = this._detail;
        if (!d)
            return null;
        if (d.title)
            d.task.text = d.title.get_text().replace(/\s+/g, ' ').trim();
        if (d.desc)
            d.task.description = d.desc.get_text().replace(/\s+$/, '');
        const t = d.task;
        try {
            if (!t.id) {
                if (!t.text)
                    return null;
                const created = addBoardTask({text: t.text, priority: t.priority, repo: t.repo, description: t.description, state: t.state});
                d.task = {...created};
                this._hooks.changed?.();
                return d.task;
            }
            let changed = false;
            const saved = patchBoardTask(t.id, cur => {
                const fields = ['text', 'description', 'priority', 'repo', 'state'];
                changed = fields.some(f => (cur[f] ?? null) !== (t[f] ?? null)) && !!t.text;
                if (!changed)
                    return cur;
                const next = {...cur, text: t.text, description: t.description, priority: t.priority, repo: t.repo};
                return t.state !== todoState(cur) ? withState(next, t.state) : {...next, updated: Date.now()};
            });
            if (changed)
                this._hooks.changed?.();
            return saved;
        } catch (e) {
            console.warn(`kaito: guardar tarea: ${e.message}`);
            return null;
        }
    }

    _backToBoard() {
        this._saveDetail();
        this._clearConfirm();
        this._detail = null;
        this._showBoard();
    }

    _clearConfirm() {
        if (this._confirmId) {
            GLib.source_remove(this._confirmId);
            this._confirmId = 0;
        }
    }

    _renderDetail() {
        const d = this._detail;
        if (!d || !this._panel)
            return;
        // Conserva lo escrito antes de reconstruir.
        if (d.title)
            d.task.text = d.title.get_text();
        if (d.desc)
            d.task.description = d.desc.get_text();
        const t = d.task;
        this._panel.destroy_all_children();
        this._cols = null;
        const head = new St.BoxLayout({style_class: 'kaito-board-head', x_expand: true});
        head.add_child(button('← Tablero', 'kaito-board-btn', () => this._backToBoard()));
        head.add_child(new St.Widget({x_expand: true}));
        head.add_child(new St.Button({
            style_class: 'kaito-card-close', can_focus: true, track_hover: true, accessible_name: 'Cerrar tablero',
            y_align: Clutter.ActorAlign.CENTER, child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 16}),
        }));
        head.last_child.connect('clicked', () => this.close());
        this._panel.add_child(head);

        const body = new St.BoxLayout({style_class: 'kaito-board-detail', vertical: true, x_expand: true});
        const scroll = new St.ScrollView({
            child: body, x_expand: true, y_expand: true, overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._panel.add_child(scroll);

        const meta = new St.BoxLayout({style_class: 'kaito-board-meta'});
        if (t.id)
            meta.add_child(lbl(t.id, 'kaito-key kaito-board-key'));
        const state = todoState(t);
        const pill = button(STATE_NAMES[state], 'kaito-board-pill', () => {
            t.state = STATES[(STATES.indexOf(todoState(t)) + 1) % STATES.length];
            this._renderDetail();
        }, {style: `background-color: ${rgba(STATE_COLORS[state], 0.35)};`, accessible_name: `Estado: ${STATE_NAMES[state]} (cambiar)`});
        meta.add_child(pill);
        const [g, color, pname] = PRIORITY_GLYPHS[t.priority] ?? PRIORITY_GLYPHS[DEFAULT_PRIORITY];
        meta.add_child(button(`${g} ${pname}`, 'kaito-board-chip-btn', () => {
            t.priority = cyclePriority(t.priority);
            this._renderDetail();
        }, {style: `color: ${color};`, accessible_name: `Prioridad ${pname} (cambiar)`}));
        if (t.created)
            meta.add_child(lbl(`creada ${agoLabel(Number(t.created))}`, 'kaito-capture-muted'));
        body.add_child(meta);

        d.title = new St.Entry({
            style_class: 'kaito-capture-entry kaito-board-title-entry', can_focus: true, x_expand: true,
            hint_text: 'Título de la tarea', text: t.text ?? '',
        });
        d.title.clutter_text.connect('activate', () => {
            const saved = this._saveDetail();
            if (saved && !t.id)
                this._renderDetail();
            d.desc?.grab_key_focus();
        });
        body.add_child(d.title);

        d.desc = new St.Entry({
            style_class: 'kaito-entry kaito-board-desc', can_focus: true, x_expand: true,
            hint_text: 'Descripción (opcional). Enter: nueva línea', text: t.description ?? '',
        });
        const ct = d.desc.clutter_text;
        ct.single_line_mode = false;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.connect('key-press-event', (_a, ev) => {
            if (![Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter].includes(ev.get_key_symbol()))
                return Clutter.EVENT_PROPAGATE;
            ct.insert_unichar('\n'.codePointAt(0));
            return Clutter.EVENT_STOP;
        });
        body.add_child(d.desc);

        const chips = new St.BoxLayout({style_class: 'kaito-board-chips kaito-board-detail-chips'});
        chips.add_child(lbl('Repo', 'kaito-capture-muted'));
        chips.add_child(button(t.repo ? base(t.repo) : 'Sin repo', 'kaito-board-chip-btn', () => this._cycleRepo(),
            {accessible_name: 'Cambiar repo'}));
        chips.add_child(button('Otra…', 'kaito-board-chip-btn', () => this._togglePicker()));
        const due = t.id ? this._hooks.dueFor?.(t) : null;
        if (due) {
            chips.add_child(lbl('Recordatorio', 'kaito-capture-muted'));
            chips.add_child(lbl(due, 'kaito-board-due'));
        }
        body.add_child(chips);
        if (d.picker)
            body.add_child(this._pickerBox());

        const agent = t.id ? this._hooks.agentFor?.(t.id) : null;
        if (agent) {
            const row = new St.BoxLayout({style_class: 'kaito-board-agent-row'});
            row.add_child(new St.Widget({style_class: 'kaito-dot', style: 'background-color: #5BC8AF;', y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(lbl(`Claude trabajando en ${agent.cwd ?? '?'}`, 'kaito-teal'));
            body.add_child(row);
        }
        if (d.error)
            body.add_child(wrapped(d.error, 'kaito-error'));

        const actions = new St.BoxLayout({style_class: 'kaito-board-actions'});
        actions.add_child(button('Mandar a Claude', 'kaito-board-btn kaito-board-primary', () => this._send()));
        if (agent)
            actions.add_child(button('Ir al agente', 'kaito-board-btn', () => {
                this.close();
                this._hooks.focusAgent?.(agent);
            }));
        if (t.id)
            actions.add_child(button('Programar revisión', 'kaito-board-btn', () => {
                this._saveDetail();
                const task = {...d.task};
                this.close();
                this._hooks.scheduleReview?.(task);
            }));
        actions.add_child(new St.Widget({x_expand: true}));
        if (t.id)
            actions.add_child(button(d.confirm ? '¿Borrar?' : 'Borrar', d.confirm ? 'kaito-board-btn kaito-board-danger' : 'kaito-board-btn', () => this._delete()));
        body.add_child(actions);
        body.add_child(wrapped(HINT, 'kaito-capture-muted kaito-board-hint'));
        if (!d.picker) {
            const focus = t.text ? null : d.title;
            focus?.grab_key_focus();
        }
    }

    _candidates() {
        const d = this._detail;
        d.repos ??= (() => {
            try {
                return this._hooks.repoCandidates?.(d.task) ?? [];
            } catch (e) {
                console.warn(`kaito: repos: ${e.message}`);
                return [];
            }
        })();
        return d.repos;
    }

    _cycleRepo() {
        const d = this._detail;
        const list = this._candidates().slice(0, PICK_MAX);
        if (!list.length) {
            this._togglePicker();
            return;
        }
        const i = list.indexOf(d.task.repo);
        d.task.repo = list[(i + 1) % list.length];
        this._renderDetail();
    }

    _togglePicker(sendAfter = false) {
        const d = this._detail;
        d.picker = d.picker && !sendAfter ? null : {query: '', sendAfter};
        this._renderDetail();
        d.picker && d.pickEntry?.grab_key_focus();
    }

    /** Selector de carpeta (mismas fuentes que el de Jira: repos recientes + escaneo + zenity). */
    _pickerBox() {
        const d = this._detail;
        const p = d.picker;
        const box = new St.BoxLayout({style_class: 'kaito-board-picker', vertical: true, x_expand: true});
        box.add_child(lbl(p.sendAfter ? '¿En qué repo trabaja Claude?' : '¿Qué repo?', 'kaito-summary'));
        const entry = new St.Entry({style_class: 'kaito-entry', hint_text: 'Buscar carpeta…', can_focus: true, x_expand: true, text: p.query});
        d.pickEntry = entry;
        const list = new St.BoxLayout({vertical: true, x_expand: true});
        let all = null;
        const fill = () => {
            list.destroy_all_children();
            if (p.searching)
                list.add_child(lbl(`Buscando rama de ${d.task.id ?? 'la tarea'}…`, 'kaito-capture-muted'));
            all ??= (() => {
                try {
                    return this._hooks.allRepos?.(d.task) ?? [];
                } catch (e) {
                    console.warn(`kaito: repos: ${e.message}`);
                    return [];
                }
            })();
            const found = filterRepos(all, p.query).slice(0, PICK_MAX);
            if (!found.length)
                list.add_child(lbl(all.length ? 'Ninguna carpeta coincide' : 'No hay repos', 'kaito-capture-muted'));
            for (const r of found) {
                const row = new St.BoxLayout({style: 'spacing: 8px;'});
                row.add_child(lbl(base(r.path), 'kaito-repo kaito-repo-pick'));
                row.add_child(lbl(tilde(r.path.slice(0, r.path.lastIndexOf('/'))), 'kaito-capture-muted'));
                if (r.branch) {
                    row.add_child(lbl(`${r.branch.branch} · ${relAgo(r.branch.ts)}`, 'kaito-capture-muted'));
                    row.add_child(lbl('tiene rama', 'kaito-pill kaito-pill-progress'));
                }
                const b = new St.Button({style_class: 'kaito-board-pick-row', child: row, can_focus: true, track_hover: true, x_expand: true, x_align: Clutter.ActorAlign.FILL});
                b.connect('clicked', () => this._pickRepo(r.path));
                list.add_child(b);
            }
        };
        entry.clutter_text.connect('text-changed', () => {
            p.query = entry.get_text();
            fill();
        });
        entry.clutter_text.connect('activate', () => {
            const first = filterRepos(all ?? [], p.query)[0];
            if (first)
                this._pickRepo(first.path);
        });
        box.add_child(entry);
        fill();
        box.add_child(list);
        if (d.task.id && this._hooks.findBranches && p.searched !== d.task.id) {
            p.searched = d.task.id;
            p.searching = true;
            fill();
            Promise.resolve(this._hooks.findBranches(d.task)).catch(e => console.warn(`kaito: ramas: ${e.message}`)).then(() => {
                p.searching = false;
                if (this._detail === d && d.picker === p) {
                    this._renderDetail(); // se reordena con las ramas encontradas
                    d.pickEntry?.grab_key_focus();
                }
            });
        }
        const foot = new St.BoxLayout({style: 'spacing: 8px;'});
        if (GLib.find_program_in_path('zenity')) {
            foot.add_child(button('Otra carpeta…', 'kaito-board-chip-btn', async () => {
                const task = {...d.task};
                const sendAfter = p.sendAfter;
                this._saveDetail();
                this.close(); // el diálogo GTK no se ve detrás del modal
                const dir = await this._hooks.chooseFolder?.(`Carpeta para ${task.id ?? 'la tarea'}`);
                if (!dir || !task.id)
                    return;
                try {
                    patchBoardTask(task.id, x => ({...x, repo: dir, updated: Date.now()}));
                } catch (e) {
                    console.warn(`kaito: guardar repo: ${e.message}`);
                }
                if (sendAfter)
                    this._hooks.send?.({...task, repo: dir}, dir);
                else
                    this.open(task.id);
            }));
        }
        foot.add_child(button('Cancelar', 'kaito-board-chip-btn', () => this._togglePicker()));
        box.add_child(foot);
        return box;
    }

    _pickRepo(path) {
        const d = this._detail;
        const sendAfter = d.picker?.sendAfter;
        d.task.repo = path;
        d.picker = null;
        if (sendAfter) {
            this._send();
            return;
        }
        this._renderDetail();
    }

    /** "Mandar a Claude": guarda, pide repo si falta y lanza (la tarea pasa a Haciendo). */
    _send() {
        const d = this._detail;
        const saved = this._saveDetail();
        if (!saved && !d.task.id) {
            d.error = 'Escribe un título antes de mandarla a Claude';
            this._renderDetail();
            return;
        }
        if (!d.task.repo) {
            this._togglePicker(true);
            return;
        }
        const task = {...d.task};
        this.close();
        this._hooks.send?.(task, task.repo);
    }

    _delete() {
        const d = this._detail;
        if (!d.confirm) {
            d.confirm = true;
            this._clearConfirm();
            this._confirmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONFIRM_MS, () => {
                this._confirmId = 0;
                if (this._detail === d) {
                    d.confirm = false;
                    this._renderDetail();
                }
                return GLib.SOURCE_REMOVE;
            });
            this._renderDetail();
            return;
        }
        this._clearConfirm();
        try {
            patchBoardTask(d.task.id, () => null);
        } catch (e) {
            console.warn(`kaito: borrar ${d.task.id}: ${e.message}`);
        }
        this._detail = null; // sin guardar: está borrada
        this._hooks.changed?.();
        this._showBoard();
    }
}
