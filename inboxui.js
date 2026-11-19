// Panel de avisos (opcional, inboxEnabled): historial de lo que Kaito te cuenta, agrupado por agente o
// fuente, con Permitir/Denegar, respuesta y acciones. Anclado arriba a la derecha; clic fuera o Esc cierran.
// Almacén en ~/.cache/kaito/inbox.json (common.js readInbox/writeInbox); lógica pura en inbox.js.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {readInbox, writeInbox, canDecide} from './common.js';
import {groupInbox, markAllRead, resolveItem, initials, agoLabel, clampDndMinutes} from './inbox.js';
import {PROVIDER_BY_ID} from './providers.js';
import {whenLabel} from './quiet.js';

const WIDTH = 440;
const MARGIN = 10;
const BADGE = {claude: ['C', '#E8A87C'], codex: ['X', '#9FD8C8'], gemini: ['G', '#A9C1F5'], opencode: ['O', '#D0C3A0'],
    aider: ['A', '#C9B3E6'], cursor: ['U', '#CFCFCF']};
const AVATAR_BG = ['#7a4a2a', '#2a5a50', '#4a3a6a', '#2a4a6a', '#5a3a3a', '#3a5a2a'];
export const REPLY_HINT = 'Responder · se copia y te llevo a su terminal';

const lbl = (text, cls = '', extra = {}) => new St.Label({text, style_class: cls, y_align: Clutter.ActorAlign.CENTER, ...extra});

function wrapped(text, cls) {
    const l = new St.Label({text, style_class: cls, x_expand: true});
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

const hash = s => [...String(s)].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 7);

/** Nombre de la fuente de un grupo: "Claude · kaito", "Tarea programada", "Recordatorio", "Kaito". */
function sourceName(it) {
    if (it.agentId) {
        const prov = PROVIDER_BY_ID[it.provider ?? 'claude']?.name ?? it.provider ?? 'Agente';
        return it.repo ? `${prov} · ${it.repo}` : prov;
    }
    if (it.kind === 'task')
        return 'Tarea programada';
    if (it.kind === 'reminder')
        return 'Recordatorio';
    return 'Kaito';
}

export class InboxPanel {
    /**
     * @param {object} hooks {agent(id) → agente vivo o null, decide(agent, behavior) → true|mensaje de error,
     *   reply(agent, text), action(action), quiet() → {quiet, reason, until}, setDnd(minutes), dndOff(), changed()}
     */
    constructor(hooks) {
        this._hooks = hooks;
        this._overlay = null;
        this._expanded = new Set();
        this._drafts = new Map();
        this._mins = 30;
    }

    get isOpen() {
        return this._overlay !== null;
    }

    toggle() {
        if (this._overlay)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._overlay)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const overlay = new St.Widget({
            style_class: 'kaito-inbox-overlay', reactive: true,
            x: mon.x, y: mon.y, width: mon.width, height: mon.height,
        });
        overlay.connect('button-press-event', (_a, ev) => {
            if (ev.get_source() === overlay)
                this.close();
            return Clutter.EVENT_STOP;
        });
        overlay.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        const w = WIDTH * scale;
        const top = Main.panel.height + 6 * scale;
        const panel = new St.BoxLayout({
            style_class: 'kaito-inbox', vertical: true, reactive: true, width: w,
            x: mon.width - w - MARGIN * scale, y: top,
        });
        panel.set_style(`max-height: ${Math.floor((mon.height - top) / scale) - 2 * MARGIN}px;`);
        overlay.add_child(panel);
        this._panel = panel;
        this._overlay = overlay;
        Main.layoutManager.addTopChrome(overlay);
        // Por debajo de la herramienta de capturas de GNOME, para poder fotografiarlo.
        Main.layoutManager.uiGroup.set_child_below_sibling(overlay, Main.layoutManager.screenshotUIGroup);
        this._grab = Main.pushModal(overlay, {actionMode: Shell.ActionMode.POPUP});
        // Abrir el panel marca todo como leído.
        this._update(markAllRead);
        this._render();
        overlay.grab_key_focus();
    }

    close() {
        const overlay = this._overlay;
        if (!overlay)
            return;
        this._overlay = null;
        try {
            Main.popModal(this._grab);
        } catch (e) {
            console.warn(`kaito: popModal: ${e.message}`);
        }
        this._grab = null;
        Main.layoutManager.removeChrome(overlay);
        overlay.destroy();
        this._panel = null;
        this._expanded.clear();
    }

    destroy() {
        this.close();
        this._drafts.clear();
    }

    /** inbox.json cambió: repinta (lo nuevo llega ya leído porque lo estás viendo). */
    refresh() {
        if (!this._overlay)
            return;
        if (readInbox().some(x => !x.read))
            this._update(markAllRead);
        this._render();
    }

    _update(fn) {
        try {
            const before = readInbox();
            const after = fn(before);
            if (JSON.stringify(after) !== JSON.stringify(before))
                writeInbox(after);
        } catch (e) {
            console.warn(`kaito: inbox.json: ${e.message}`);
        }
        this._hooks.changed?.();
    }

    _render() {
        const panel = this._panel;
        if (!panel)
            return;
        panel.destroy_all_children();
        const list = readInbox();
        const head = new St.BoxLayout({style_class: 'kaito-inbox-head', x_expand: true});
        head.add_child(lbl('Avisos', 'kaito-inbox-title'));
        head.add_child(new St.Widget({x_expand: true}));
        if (list.length) {
            head.add_child(button('Borrar todo', 'kaito-inbox-link', () => {
                this._update(() => []);
                this._drafts.clear();
                this._render();
            }));
        }
        panel.add_child(head);

        const q = this._hooks.quiet?.() ?? {quiet: false};
        if (q.quiet) {
            const banner = new St.BoxLayout({style_class: 'kaito-inbox-dnd', vertical: true, x_expand: true});
            const row = new St.BoxLayout({style: 'spacing: 6px;'});
            row.add_child(new St.Icon({icon_name: 'weather-clear-night-symbolic', icon_size: 14, style_class: 'kaito-moon'}));
            row.add_child(lbl(q.reason === 'schedule' ? 'Fuera de horario' : 'No molestar activo', 'kaito-inbox-dnd-title'));
            banner.add_child(row);
            const until = q.until ? ` hasta ${whenLabel(q.until, new Date())}` : '';
            banner.add_child(wrapped(q.reason === 'schedule'
                ? `Todo te espera aquí${until}. Los agentes que te necesitan se marcan con un punto naranja.`
                : `Solo ves avisos de agentes que te necesitan. El resto te espera aquí${until}.`, 'kaito-capture-muted'));
            panel.add_child(banner);
        }

        const body = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'kaito-inbox-list'});
        const groups = groupInbox(list);
        for (const g of groups)
            body.add_child(this._group(g));
        if (!groups.length)
            body.add_child(lbl('Sin avisos pendientes', 'kaito-capture-muted kaito-inbox-empty', {x_align: Clutter.ActorAlign.CENTER}));
        panel.add_child(new St.ScrollView({
            child: body, x_expand: true, y_expand: true, overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
        }));
        panel.add_child(this._footer(q));
    }

    _group(g) {
        const it = g.latest;
        const box = new St.BoxLayout({style_class: 'kaito-inbox-group', vertical: true, x_expand: true});
        const head = new St.BoxLayout({style_class: 'kaito-inbox-group-head', x_expand: true});
        const [letter, color] = it.agentId ? BADGE[it.provider ?? 'claude'] ?? [String(it.provider ?? '?')[0].toUpperCase(), '#CFCFCF']
            : it.kind === 'task' ? ['T', '#5BC8AF'] : it.kind === 'reminder' ? ['R', '#F5C211'] : ['K', '#78AEED'];
        head.add_child(lbl(letter, 'kaito-inbox-badge', {style: `background-color: ${color}; color: #1d1d20;`}));
        head.add_child(lbl(sourceName(it), 'kaito-inbox-app'));
        head.add_child(new St.Widget({x_expand: true}));
        head.add_child(lbl(agoLabel(it.ts), 'kaito-capture-muted'));
        box.add_child(head);
        const open = this._expanded.has(g.key);
        const items = open ? g.items : [g.items[0]];
        for (const x of items)
            box.add_child(this._item(x));
        if (g.items.length > 1) {
            const more = g.items.length - 1;
            box.add_child(button(open ? 'Mostrar menos' : `+${more} ${more === 1 ? 'aviso' : 'avisos'}`, 'kaito-inbox-link kaito-inbox-more', () => {
                if (open)
                    this._expanded.delete(g.key);
                else
                    this._expanded.add(g.key);
                this._render();
            }));
        }
        return box;
    }

    _item(it) {
        const row = new St.BoxLayout({style_class: 'kaito-inbox-item', x_expand: true});
        const who = it.repo ?? (it.kind === 'task' ? 'tarea' : it.kind === 'update' ? 'Kaito' : it.title);
        row.add_child(lbl(initials(who), 'kaito-inbox-avatar', {
            style: `background-color: ${AVATAR_BG[hash(it.agentId ?? it.kind) % AVATAR_BG.length]};`, y_align: Clutter.ActorAlign.START,
        }));
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'kaito-inbox-col'});
        col.add_child(wrapped(it.title, it.kind === 'needs' && !it.resolved ? 'kaito-inbox-item-title kaito-error' : 'kaito-inbox-item-title'));
        if (it.body)
            col.add_child(wrapped(it.body.length > 600 ? `${it.body.slice(0, 599)}…` : it.body, 'kaito-inbox-body'));
        if (it.cmd) {
            const mono = new St.BoxLayout({style_class: 'kaito-mono-box kaito-inbox-cmd', vertical: true, x_expand: true});
            mono.add_child(wrapped(it.cmd.length > 400 ? `${it.cmd.slice(0, 399)}…` : it.cmd, 'kaito-mono'));
            col.add_child(mono);
        }
        if (it.resolved) {
            col.add_child(wrapped(it.resolved, 'kaito-teal kaito-inbox-resolved'));
            row.add_child(col);
            return row;
        }
        const agent = it.agentId ? this._hooks.agent?.(it.agentId) ?? null : null;
        const btns = new St.BoxLayout({style_class: 'kaito-inbox-actions'});
        if (it.kind === 'needs' && agent && canDecide(agent)) {
            btns.add_child(button('Denegar', 'kaito-reminder-btn snooze kaito-inbox-btn', () => this._decide(it, agent, 'deny')));
            btns.add_child(button('Permitir', 'kaito-reminder-btn kaito-allow kaito-inbox-btn', () => this._decide(it, agent, 'allow')));
        }
        for (const a of it.actions ?? []) {
            btns.add_child(button(a.label, 'kaito-reminder-btn snooze kaito-inbox-btn', () => {
                this.close();
                this._hooks.action?.(a.action, it);
            }));
        }
        if (btns.get_n_children())
            col.add_child(btns);
        if (agent && ['needs', 'done', 'finished'].includes(it.kind)) {
            const entry = new St.Entry({
                style_class: 'kaito-entry kaito-inbox-reply', can_focus: true, x_expand: true,
                hint_text: REPLY_HINT, text: this._drafts.get(it.id) ?? '',
            });
            entry._kaitoItem = it.id;
            entry.clutter_text.connect('text-changed', () => this._drafts.set(it.id, entry.get_text()));
            entry.clutter_text.connect('activate', () => this._reply(it, agent, entry.get_text()));
            col.add_child(entry);
        }
        if (this._errors?.get(it.id))
            col.add_child(wrapped(this._errors.get(it.id), 'kaito-error'));
        row.add_child(col);
        return row;
    }

    _decide(it, agent, behavior) {
        const r = this._hooks.decide?.(agent, behavior);
        if (r !== true) {
            (this._errors ??= new Map()).set(it.id, typeof r === 'string' ? r : 'La petición ya no espera respuesta: contesta en la terminal');
            this._render();
            return;
        }
        this._errors?.delete(it.id);
        this._update(list => resolveItem(list, it.id, behavior === 'allow' ? 'Permitido · sigue trabajando' : 'Denegado'));
        this._render();
    }

    /**
     * Texto libre: Claude Code no deja escribir en una sesión interactiva desde fuera, así que (como en
     * el cuadro de respuesta) se copia al portapapeles y se enfoca su terminal.
     */
    _reply(it, agent, text) {
        const t = String(text ?? '').trim();
        if (!t)
            return;
        this._drafts.delete(it.id);
        this._update(list => resolveItem(list, it.id, 'Respuesta copiada'));
        this.close();
        this._hooks.reply?.(agent, t);
    }

    _footer(q) {
        const foot = new St.BoxLayout({style_class: 'kaito-inbox-foot', x_expand: true});
        foot.add_child(lbl('No molestar', 'kaito-inbox-dnd-label'));
        foot.add_child(new St.Widget({x_expand: true}));
        const manual = q.quiet && q.reason === 'manual';
        const minus = button('−', 'kaito-inbox-step', () => {
            this._mins = clampDndMinutes(this._mins - 15);
            this._render();
        }, {accessible_name: 'Menos minutos'});
        const plus = button('+', 'kaito-inbox-step', () => {
            this._mins = clampDndMinutes(this._mins + 15);
            this._render();
        }, {accessible_name: 'Más minutos'});
        foot.add_child(minus);
        foot.add_child(lbl(`${this._mins} min`, 'kaito-inbox-mins'));
        foot.add_child(plus);
        foot.add_child(button(manual ? 'Activo' : 'Activar', manual ? 'kaito-inbox-dnd-btn kaito-inbox-dnd-on' : 'kaito-inbox-dnd-btn', () => {
            if (manual)
                this._hooks.dndOff?.();
            else
                this._hooks.setDnd?.(this._mins);
            this._render();
        }, {accessible_name: manual ? 'Desactivar No molestar' : `Activar No molestar ${this._mins} min`}));
        return foot;
    }
}
