// Cuadros modales tipo Spotlight sobre un agente: responderle sin cambiar de ventana
// (ReplyModal) y comentar en Jira lo que ha hecho al terminar (CommentModal).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {canDecide, writeDecision} from './common.js';
import {DRAFT_TIMEOUT_S, draftCommentWithClaude, fetchIssueBasics, gitContext, postComment} from './jiradraft.js';
import {stripSummaryLine} from './tasks.js';

const WIDTH = 640;
const TOP = 110;
const NEEDS = '#FFA348';
const COMMENT_TIMEOUT_S = 90;

const lbl = (text, cls = '', extra = {}) => new St.Label({text, style_class: cls, y_align: Clutter.ActorAlign.CENTER, ...extra});

/** Etiqueta multilínea (sin elipsis). */
function wrapped(text, cls) {
    const l = new St.Label({text, style_class: cls, x_expand: true});
    l.clutter_text.line_wrap = true;
    l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return l;
}

function scrolled(child, maxH) {
    const inner = new St.BoxLayout({vertical: true, x_expand: true});
    inner.add_child(child);
    return new St.ScrollView({
        style: `max-height: ${maxH}px;`, child: inner, x_expand: true,
        hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
    });
}

const agoS = s => (s < 60 ? `hace ${s} s` : s < 3600 ? `hace ${Math.floor(s / 60)} min` : `hace ${Math.floor(s / 3600)} h`);

/** Base común: overlay a pantalla completa con una tarjeta centrada, modal, Esc y clic fuera cierran. */
class Modal {
    constructor() {
        this._overlay = null;
        this._gen = 0;
    }

    get isOpen() {
        return this._overlay !== null;
    }

    /** Crea overlay + tarjeta. Devuelve la tarjeta o null si no hay monitor. */
    _openShell() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return null;
        const overlay = new St.Widget({
            style_class: 'kaito-capture-overlay', reactive: true,
            x: mon.x, y: mon.y, width: mon.width, height: mon.height,
        });
        overlay.connect('button-press-event', (_a, ev) => {
            if (ev.get_source() === overlay)
                this._onEscape();
            return Clutter.EVENT_STOP;
        });
        overlay.connect('key-press-event', (_a, ev) => {
            if (ev.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._onEscape();
            return Clutter.EVENT_STOP;
        });
        const card = new St.BoxLayout({
            style_class: 'kaito-capture', vertical: true, reactive: true,
            x: Math.round((mon.width - WIDTH) / 2), y: TOP, width: WIDTH,
        });
        overlay.add_child(card);
        this._overlay = overlay;
        Main.layoutManager.addTopChrome(overlay);
        // Por debajo de la herramienta de capturas de GNOME, para poder fotografiarlo.
        Main.layoutManager.uiGroup.set_child_below_sibling(overlay, Main.layoutManager.screenshotUIGroup);
        this._grab = Main.pushModal(overlay);
        return card;
    }

    _onEscape() {
        this.close();
    }

    _footer() {
        const footer = new St.BoxLayout({style_class: 'kaito-capture-footer', x_expand: true});
        this._footerLeft = new St.BoxLayout({style_class: 'kaito-capture-footer-left', x_expand: true});
        footer.add_child(this._footerLeft);
        this._footerRight = new St.BoxLayout({style_class: 'kaito-capture-footer-left'});
        footer.add_child(this._footerRight);
        this._footerEl = footer;
        return footer;
    }

    /** Pares [tecla, texto] a la izquierda del pie, o un error en naranja. */
    _setFooter(pairs, error = null) {
        const left = this._footerLeft;
        if (!left)
            return;
        left.destroy_all_children();
        if (error) {
            left.add_child(wrapped(error, 'kaito-error'));
            return;
        }
        for (const [key, text] of pairs) {
            const k = new St.BoxLayout({style_class: 'kaito-capture-key'});
            if (key)
                k.add_child(lbl(key, 'kaito-capture-cap'));
            k.add_child(lbl(text, 'kaito-capture-muted'));
            left.add_child(k);
        }
    }

    _flash() {
        if (this._warnId)
            GLib.source_remove(this._warnId);
        this._footerEl?.add_style_class_name('warn');
        this._warnId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._warnId = 0;
            this._footerEl?.remove_style_class_name('warn');
            return GLib.SOURCE_REMOVE;
        });
    }

    close() {
        const overlay = this._overlay;
        if (!overlay)
            return;
        this._overlay = null;
        this._gen++;
        this._cleanup?.();
        if (this._warnId) {
            GLib.source_remove(this._warnId);
            this._warnId = 0;
        }
        try {
            Main.popModal(this._grab);
        } catch (e) {
            console.error(`kaito: popModal: ${e.message}`);
        }
        this._grab = null;
        Main.layoutManager.removeChrome(overlay);
        overlay.destroy();
        this._footerLeft = this._footerRight = this._footerEl = null;
    }

    destroy() {
        this.close();
    }
}

/** Cabecera: punto + repo + chip del ticket + texto a la derecha. */
function agentHead(agent, color, rightText) {
    const head = new St.BoxLayout({style_class: 'kaito-modal-head', x_expand: true});
    head.add_child(new St.Widget({
        style_class: 'kaito-dot', style: `background-color: ${color};`, y_align: Clutter.ActorAlign.CENTER,
    }));
    head.add_child(lbl(agent.cwd ?? '?', 'kaito-repo'));
    if (agent.ticket)
        head.add_child(lbl(agent.ticket, 'kaito-key kaito-key-chip'));
    head.add_child(new St.Widget({x_expand: true}));
    head.add_child(lbl(rightText, 'kaito-capture-muted'));
    return head;
}

/** "Responder sin cambiar de ventana" para un agente que te necesita. */
export class ReplyModal extends Modal {
    /**
     * @param {object} hooks {focus(agent), refresh()}
     */
    constructor(hooks) {
        super();
        this._hooks = hooks;
    }

    open(agent) {
        if (this._overlay)
            this.close();
        const card = this._openShell();
        if (!card)
            return;
        this._agent = agent;
        const h = agent.hook ?? {};
        const since = Number(h.ts) ? Math.max(0, Math.floor(Date.now() / 1000 - Number(h.ts))) : agent.age ?? 0;
        card.add_child(agentHead(agent, NEEDS, `Te necesita · ${agoS(since)}`));

        const msg = agent.message || agent.lastText || 'Te necesita';
        card.add_child(scrolled(wrapped(msg, 'kaito-modal-msg'), 180));
        const permission = h.kind === 'permission';
        if (permission && (h.tool || h.detail)) {
            const box = new St.BoxLayout({style_class: 'kaito-mono-box', vertical: true, x_expand: true});
            if (h.tool)
                box.add_child(lbl(h.tool, 'kaito-mono-tool'));
            if (h.detail)
                box.add_child(scrolled(wrapped(h.detail, 'kaito-mono'), 140));
            card.add_child(box);
        }

        this._entry = new St.Entry({
            style_class: 'kaito-capture-entry', can_focus: true, x_expand: true,
            hint_text: permission ? 'Escribe tu respuesta, o usa los botones' : 'Escribe tu respuesta',
        });
        this._entry.clutter_text.connect('activate', () => this._send());
        card.add_child(this._entry);
        card.add_child(this._footer());

        if (canDecide(agent)) {
            const deny = new St.Button({style_class: 'kaito-reminder-btn snooze', label: 'Denegar', can_focus: true});
            const allow = new St.Button({style_class: 'kaito-reminder-btn kaito-allow', label: 'Permitir', can_focus: true});
            deny.connect('clicked', () => this._decide('deny'));
            allow.connect('clicked', () => this._decide('allow'));
            this._footerRight.add_child(deny);
            this._footerRight.add_child(allow);
            this._setFooter([['Enter', 'enviar'], ['Esc', 'cerrar']]);
        } else if (permission) {
            this._setFooter([['Enter', 'enviar'], ['Esc', 'cerrar'], ['', '· permiso: respóndelo en la terminal']]);
        } else {
            this._setFooter([['Enter', 'enviar'], ['Esc', 'cerrar']]);
        }
        this._entry.grab_key_focus();
    }

    /**
     * Texto libre: Claude Code no ofrece una vía documentada para escribir como el usuario en una
     * sesión interactiva ajena (los mensajes entre sesiones llegan como "de otra sesión" y no
     * responden diálogos), así que se copia al portapapeles y se enfoca su terminal.
     */
    _send() {
        const text = this._entry?.get_text().trim();
        if (!text) {
            this._flash();
            return;
        }
        const agent = this._agent;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this.close();
        this._hooks.focus(agent);
        Main.notify('Kaito', 'Copiado. Pégalo con Ctrl+Shift+V en la terminal');
    }

    _decide(behavior) {
        const agent = this._agent;
        if (!canDecide(agent)) {
            this._setFooter([], 'La petición ya no espera respuesta: contesta en la terminal');
            return;
        }
        try {
            writeDecision(agent.id, agent.hook.request, behavior);
        } catch (e) {
            this._setFooter([], `No se pudo enviar: ${e.message}`);
            return;
        }
        this.close();
        this._hooks.refresh();
    }

    _cleanup() {
        this._entry = null;
        this._agent = null;
    }
}

/** "Comentar en Jira": borrador con Claude a partir del trabajo del agente, editable, Enter publica. */
export class CommentModal extends Modal {
    /** @param {() => Soup.Session} session */
    constructor(session) {
        super();
        this._session = session;
    }

    /**
     * @param {object} agent agente (cwdPath, lastText, ticket) @param {string} summary resumen si se conoce
     * @param {string|null} text texto ya escrito (p. ej. hallazgos de una tarea): sin IA, directo a revisión
     */
    open(agent, summary = '', text = null) {
        if (this._overlay)
            this.close();
        if (!agent?.ticket)
            return;
        const card = this._openShell();
        if (!card)
            return;
        this._agent = agent;
        this._key = agent.ticket;
        this._stage = 'drafting';
        card.add_child(agentHead(agent, '#78AEED', 'Comentario para Jira'));
        this._summaryLabel = wrapped(summary ? `${agent.ticket} · ${summary}` : agent.ticket, 'kaito-modal-msg');
        card.add_child(this._summaryLabel);

        this._text = new St.Entry({
            style_class: 'kaito-capture-entry kaito-comment-entry', can_focus: true, x_expand: true,
            hint_text: 'Redactando con IA…',
        });
        const ct = this._text.clutter_text;
        ct.single_line_mode = false;
        ct.line_wrap = true;
        ct.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        ct.editable = false;
        ct.connect('key-press-event', (_a, ev) => this._onTextKey(ev));
        card.add_child(scrolled(this._text, 320));
        card.add_child(this._footer());
        this._overlay.grab_key_focus();
        if (text) {
            this._stage = 'review';
            this._text.set_text(text);
            ct.editable = true;
            this._text.grab_key_focus();
            ct.set_cursor_position(-1);
            this._reviewFooter(); // Enter explícito para publicar: nunca se publica solo
            return;
        }
        this._draft(summary);
    }

    _onEscape() {
        if (this._stage === 'posting')
            return; // el POST ya va en camino
        this.close(); // descartar (cancela la IA si sigue)
    }

    _onTextKey(ev) {
        const sym = ev.get_key_symbol();
        if (![Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter].includes(sym))
            return Clutter.EVENT_PROPAGATE;
        if (ev.get_state() & Clutter.ModifierType.SHIFT_MASK) {
            this._text.clutter_text.insert_unichar('\n'.codePointAt(0));
            return Clutter.EVENT_STOP;
        }
        this._publish();
        return Clutter.EVENT_STOP;
    }

    async _draft(summary) {
        const gen = this._gen;
        this._cancel = new Gio.Cancellable();
        let elapsed = 0;
        const tick = () => this._setFooter([['Esc', 'cancelar'], ['', `Redactando… ${elapsed} s`]]);
        tick();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            elapsed++;
            tick();
            return GLib.SOURCE_CONTINUE;
        });
        try {
            if (!summary) {
                try {
                    summary = (await fetchIssueBasics(this._session(), this._key)).summary;
                    if (gen === this._gen)
                        this._summaryLabel.text = `${this._key} · ${summary}`;
                } catch (e) {
                    console.warn(`kaito: resumen de ${this._key}: ${e.message}`);
                }
            }
            const ctx = await gitContext(this._agent.cwdPath, this._cancel);
            if (gen !== this._gen)
                return;
            const text = await draftCommentWithClaude({
                key: this._key, summary, lastText: this._agent.lastText, ...ctx,
            }, {cancellable: this._cancel, timeoutS: Math.max(DRAFT_TIMEOUT_S, COMMENT_TIMEOUT_S)});
            if (gen !== this._gen)
                return;
            this._stopTick();
            this._stage = 'review';
            this._text.set_text(text);
            this._text.clutter_text.editable = true;
            this._text.grab_key_focus();
            this._text.clutter_text.set_cursor_position(-1);
            this._reviewFooter();
        } catch (e) {
            if (gen !== this._gen)
                return;
            this._stopTick();
            console.warn(`kaito: borrador de comentario: ${e.message}`);
            // Sin borrador se puede escribir a mano.
            this._stage = 'review';
            this._text.hint_text = 'Escribe el comentario';
            this._text.clutter_text.editable = true;
            this._text.grab_key_focus();
            this._setFooter([], `No se pudo redactar: ${e.message}`);
        }
    }

    _reviewFooter(error = null) {
        this._setFooter([['Enter', 'publicar en Jira'], ['Mayús+Enter', 'nueva línea'], ['Esc', 'descartar']], error);
    }

    async _publish() {
        if (this._stage !== 'review')
            return;
        const text = this._text.get_text().trim();
        if (!text) {
            this._flash();
            return;
        }
        const gen = this._gen;
        const key = this._key;
        this._stage = 'posting';
        this._text.clutter_text.editable = false;
        this._setFooter([['', 'Publicando en Jira…']]);
        try {
            await postComment(this._session(), key, text);
            Main.notify('Kaito', `Comentario publicado en ${key}`);
            if (gen === this._gen)
                this.close();
        } catch (e) {
            if (gen !== this._gen)
                return;
            this._stage = 'review';
            this._text.clutter_text.editable = true;
            this._reviewFooter(`No se pudo publicar: ${e.message}`);
        }
    }

    _stopTick() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _cleanup() {
        this._cancel?.cancel();
        this._cancel = null;
        this._stopTick();
        this._text = this._summaryLabel = this._agent = null;
        this._stage = null;
    }
}

const TEAL = '#5BC8AF';
const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const p2 = x => String(x).padStart(2, '0');
const runDate = d => `${DOW[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
const DIM = '#9A9996';

/** Resultado completo de una tarea programada: texto, consultas SQL y "Copiar". */
export class TaskResultModal extends Modal {
    /** @param {object} hooks {comment(task, run)}: "Comentar en Jira" (solo si la tarea tiene ticket) */
    constructor(hooks = {}) {
        super();
        this._hooks = hooks;
    }

    /** @param {object} task tarea @param {object|null} run ejecución (null: nunca se ha ejecutado) */
    open(task, run) {
        if (this._overlay)
            this.close();
        const card = this._openShell();
        if (!card)
            return;
        const color = !run ? DIM : run.ok ? TEAL : NEEDS;
        const head = new St.BoxLayout({style_class: 'kaito-modal-head', x_expand: true});
        head.add_child(new St.Widget({
            style_class: 'kaito-dot', style: `background-color: ${color};`, y_align: Clutter.ActorAlign.CENTER,
        }));
        head.add_child(lbl(task.name, 'kaito-repo'));
        if (task.key)
            head.add_child(lbl(task.key, 'kaito-key kaito-key-chip'));
        head.add_child(new St.Widget({x_expand: true}));
        const when = run?.finished ? new Date(run.finished) : null;
        head.add_child(lbl(when ? `${run.ok ? 'terminada' : 'falló'} · ${runDate(when)}` : 'sin ejecutar', 'kaito-capture-muted'));
        card.add_child(head);

        const body = new St.BoxLayout({vertical: true, x_expand: true, style: 'spacing: 8px;'});
        if (!run) {
            body.add_child(wrapped('Esta tarea aún no se ha ejecutado.', 'kaito-capture-muted'));
        } else {
            if (run.summary)
                body.add_child(wrapped(run.summary, run.ok ? 'kaito-task-summary' : 'kaito-task-summary kaito-error'));
            const rest = stripSummaryLine(run.result);
            if (rest)
                body.add_child(wrapped(rest, 'kaito-task-result'));
            if (run.error && run.error !== run.summary)
                body.add_child(wrapped(run.error, 'kaito-error'));
            if (run.queries?.length) {
                body.add_child(lbl(`Consultas SQL (${run.queries.length})`, 'kaito-mono-tool'));
                for (const q of run.queries) {
                    const box = new St.BoxLayout({style_class: 'kaito-mono-box', vertical: true, x_expand: true});
                    box.add_child(wrapped(q, 'kaito-mono'));
                    body.add_child(box);
                }
            }
        }
        const scroll = scrolled(body, 420);
        scroll.add_style_class_name('kaito-task-scroll');
        card.add_child(scroll);
        card.add_child(this._footer());
        this._setFooter([['Esc', 'cerrar']]);
        const btns = this._footerRight;
        const btn = (label, fn, cls = 'snooze') => {
            const b = new St.Button({style_class: `kaito-reminder-btn ${cls}`, label, can_focus: true});
            b.connect('clicked', fn);
            btns.add_child(b);
            return b;
        };
        if (run) {
            const copy = btn('Copiar', () => {
                const text = [run.result || run.summary, ...run.queries?.length
                    ? ['', 'Consultas SQL:', ...run.queries.map(q => `${q};`)] : []].join('\n');
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
                copy.label = 'Copiado';
            });
            if (task.key && this._hooks.comment) {
                btn('Comentar en Jira', () => {
                    this.close();
                    this._hooks.comment(task, run);
                });
            }
        }
        btn('Cerrar', () => this.close(), 'kaito-fin-ok');
        this._overlay.grab_key_focus();
    }
}
