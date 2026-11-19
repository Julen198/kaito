import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {readReminders, patchReminder} from './common.js';

const CHECK_SECONDS = 20;
const SNOOZE_MS = 10 * 60 * 1000;
const MAX_VISIBLE = 3;
const WIDTH = 480;
const TOP = 70;
const DAILY_ID = '__daily'; // tarjeta del resumen del día (no es un recordatorio)
const FIN_PREFIX = '__fin:'; // tarjetas "<KEY> listo" (agente que terminó un ticket)
const TASK_PREFIX = '__task:'; // tarjetas "Tarea «…» · terminada/falló" (tareas programadas)
const QUEUED_ID = '__quiet'; // tarjeta "Mientras no estabas" (avisos retenidos por No molestar)
const QUEUED_SHOWN = 12;

/** Tarjetas de recordatorios vencidos. No son modales: no roban el teclado. */
export class ReminderManager {
    /**
     * @param {() => void} onChange se llama tras posponer o completar
     * @param {{quiet?: () => ({quiet: boolean, holdReminders: boolean}|null)}} opts quiet: estado de No molestar
     *   (sin sonido; con holdReminders los recordatorios esperan a que termine)
     */
    constructor(onChange, opts = {}) {
        this._onChange = onChange;
        this._quiet = opts.quiet ?? (() => null);
        this._cards = new Map(); // id -> actor
        this._box = null;
        this.check();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_SECONDS, () => {
            this.check();
            return GLib.SOURCE_CONTINUE;
        });
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());
    }

    /** Muestra los vencidos (no hechos) que aún no tienen tarjeta. */
    check() {
        if (this._quiet()?.holdReminders)
            return; // No molestar con "Silenciar también recordatorios": salen al terminar
        const now = Date.now();
        const due = readReminders()
            .filter(r => r.id && !r.done && new Date(r.due).getTime() <= now)
            .sort((a, b) => new Date(a.due) - new Date(b.due))
            .slice(0, MAX_VISIBLE);
        const ids = new Set(due.map(r => r.id));
        // Quita las que ya no corresponden (hechas o pospuestas desde otro sitio).
        for (const [id] of this._cards) {
            if (!id.startsWith('__') && !ids.has(id)) // las de '__' no son recordatorios
                this._removeCard(id);
        }
        let fresh = false;
        for (const r of due) {
            if (this._cards.has(r.id))
                continue;
            this._addCard(r);
            fresh = true;
        }
        if (fresh)
            this._beep();
    }

    _beep() {
        if (this._quiet()?.quiet)
            return;
        try {
            global.display.get_sound_player().play_from_theme('complete', 'Recordatorio', null);
        } catch (e) {
            console.error(`kaito: sonido: ${e.message}`);
        }
    }

    _ensureBox() {
        if (this._box)
            return;
        this._box = new St.BoxLayout({style_class: 'kaito-reminders', vertical: true, width: WIDTH});
        Main.layoutManager.addTopChrome(this._box);
        // Por debajo de la herramienta de capturas de GNOME, para poder fotografiarlo.
        Main.layoutManager.uiGroup.set_child_below_sibling(this._box, Main.layoutManager.screenshotUIGroup);
        this._place();
    }

    _place() {
        const mon = Main.layoutManager.primaryMonitor;
        if (this._box && mon)
            this._box.set_position(mon.x + Math.round((mon.width - WIDTH) / 2), mon.y + TOP);
    }

    _addCard(r) {
        this._ensureBox();
        const card = new St.BoxLayout({style_class: 'kaito-reminder', reactive: true});

        const circle = new St.Bin({
            style_class: 'kaito-reminder-icon', y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'alarm-symbolic', icon_size: 20}),
        });
        card.add_child(circle);

        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'kaito-reminder-col'});
        const n = r.snoozes ?? 0;
        col.add_child(new St.Label({
            style_class: 'kaito-reminder-meta',
            text: n > 0 ? `Recordatorio · pospuesto ${n} ${n === 1 ? 'vez' : 'veces'}` : 'Recordatorio · ahora',
        }));
        const title = new St.Label({style_class: 'kaito-reminder-title', text: r.text});
        title.clutter_text.line_wrap = true;
        title.clutter_text.line_wrap_mode = 2; // Pango.WrapMode.WORD_CHAR
        col.add_child(title);

        const buttons = new St.BoxLayout({style_class: 'kaito-reminder-buttons', x_align: Clutter.ActorAlign.END});
        const snooze = new St.Button({style_class: 'kaito-reminder-btn snooze', label: 'Posponer 10 min', can_focus: true});
        const done = new St.Button({style_class: 'kaito-reminder-btn done', label: 'Hecho', can_focus: true});
        snooze.connect('clicked', () => this._act(r.id, x => {
            x.due = new Date(Date.now() + SNOOZE_MS).toISOString();
            x.snoozes = (x.snoozes ?? 0) + 1;
        }));
        done.connect('clicked', () => this._act(r.id, x => { x.done = true; }));
        buttons.add_child(snooze);
        buttons.add_child(done);
        col.add_child(buttons);
        card.add_child(col);

        this._cards.set(r.id, card);
        this._box.add_child(card);
    }

    /** Resumen de la mañana: misma tarjeta, sin sonido ni modal; "Entendido" la cierra. */
    showDaily(lines) {
        this._removeCard(DAILY_ID);
        this._ensureBox();
        const card = new St.BoxLayout({style_class: 'kaito-reminder kaito-daily', reactive: true});
        card.add_child(new St.Bin({
            style_class: 'kaito-reminder-icon kaito-daily-icon', y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'weather-clear-symbolic', icon_size: 20}),
        }));
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'kaito-reminder-col'});
        col.add_child(new St.Label({style_class: 'kaito-reminder-title', text: 'Buenos días. Hoy tienes:'}));
        for (const line of lines) {
            const l = new St.Label({style_class: 'kaito-daily-line', text: `• ${line}`});
            l.clutter_text.line_wrap = true;
            l.clutter_text.line_wrap_mode = 2; // Pango.WrapMode.WORD_CHAR
            col.add_child(l);
        }
        const buttons = new St.BoxLayout({style_class: 'kaito-reminder-buttons', x_align: Clutter.ActorAlign.END});
        const ok = new St.Button({style_class: 'kaito-reminder-btn kaito-daily-ok', label: 'Entendido', can_focus: true});
        ok.connect('clicked', () => this._removeCard(DAILY_ID));
        buttons.add_child(ok);
        col.add_child(buttons);
        card.add_child(col);
        this._cards.set(DAILY_ID, card);
        this._box.insert_child_at_index(card, 0);
    }

    /**
     * Agente que terminó un ticket: tarjeta persistente (hasta "Entendido"), con sonido.
     * lines: [{text, warn, quote}] · prUrl: abre la PR/MR · onFocus: ir a la terminal del agente.
     */
    showFinished({id, title, meta, lines, prUrl = null, onFocus = null, onSchedule = null}) {
        const cid = `${FIN_PREFIX}${id}`;
        if (this._cards.has(cid))
            return;
        this._ensureBox();
        const card = new St.BoxLayout({style_class: 'kaito-reminder kaito-fin', reactive: true});
        card.add_child(new St.Bin({
            style_class: 'kaito-reminder-icon kaito-fin-icon', y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'object-select-symbolic', icon_size: 20}),
        }));
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'kaito-reminder-col'});
        if (meta)
            col.add_child(new St.Label({style_class: 'kaito-reminder-meta kaito-fin-meta', text: meta}));
        col.add_child(new St.Label({style_class: 'kaito-reminder-title', text: title}));
        for (const l of lines) {
            const label = new St.Label({
                style_class: `kaito-daily-line${l.warn ? ' kaito-fin-warn' : ''}${l.quote ? ' kaito-fin-quote' : ''}`,
                text: l.text,
            });
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = 2; // Pango.WrapMode.WORD_CHAR
            col.add_child(label);
        }
        const buttons = new St.BoxLayout({style_class: 'kaito-reminder-buttons', x_align: Clutter.ActorAlign.END});
        const close = () => this._removeCard(cid);
        if (prUrl) {
            const pr = new St.Button({style_class: 'kaito-reminder-btn snooze', label: 'Abrir PR', can_focus: true});
            pr.connect('clicked', () => {
                try {
                    Gio.AppInfo.launch_default_for_uri(prUrl, null);
                } catch (e) {
                    console.warn(`kaito: no se pudo abrir ${prUrl}: ${e.message}`);
                }
                close();
            });
            buttons.add_child(pr);
        }
        if (onFocus) {
            const go = new St.Button({style_class: 'kaito-reminder-btn snooze', label: 'Ir al agente', can_focus: true});
            go.connect('clicked', () => {
                onFocus();
                close();
            });
            buttons.add_child(go);
        }
        if (onSchedule) {
            const sch = new St.Button({style_class: 'kaito-reminder-btn snooze', label: 'Programar revisión', can_focus: true});
            sch.connect('clicked', () => {
                close();
                onSchedule();
            });
            buttons.add_child(sch);
        }
        const ok = new St.Button({style_class: 'kaito-reminder-btn kaito-fin-ok', label: 'Entendido', can_focus: true});
        ok.connect('clicked', close);
        buttons.add_child(ok);
        col.add_child(buttons);
        card.add_child(col);
        this._cards.set(cid, card);
        this._box.add_child(card);
        this._beep();
    }

    /**
     * Resultado de una tarea programada: persistente hasta "Entendido", con sonido.
     * onView: abre el resultado completo · onComment: "Comentar en Jira" (solo con ticket).
     */
    showTaskResult({id, name, ok, summary, key = null, onView = null, onComment = null}) {
        const cid = `${TASK_PREFIX}${id}`;
        this._removeCard(cid); // una tarjeta por tarea: la nueva sustituye a la anterior
        this._ensureBox();
        const card = new St.BoxLayout({style_class: `kaito-reminder kaito-fin${ok ? '' : ' kaito-task-fail'}`, reactive: true});
        card.add_child(new St.Bin({
            style_class: `kaito-reminder-icon kaito-fin-icon${ok ? '' : ' kaito-task-fail-icon'}`, y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: ok ? 'object-select-symbolic' : 'dialog-warning-symbolic', icon_size: 20}),
        }));
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'kaito-reminder-col'});
        const meta = new St.BoxLayout({style: 'spacing: 6px;'});
        meta.add_child(new St.Label({style_class: `kaito-reminder-meta kaito-fin-meta${ok ? '' : ' kaito-task-fail-meta'}`,
            text: 'Tarea programada', y_align: Clutter.ActorAlign.CENTER}));
        if (key)
            meta.add_child(new St.Label({style_class: 'kaito-key kaito-key-chip', text: key, y_align: Clutter.ActorAlign.CENTER}));
        col.add_child(meta);
        const title = new St.Label({style_class: 'kaito-reminder-title', text: `Tarea «${name}» · ${ok ? 'terminada' : 'falló'}`});
        title.clutter_text.line_wrap = true;
        title.clutter_text.line_wrap_mode = 2; // Pango.WrapMode.WORD_CHAR
        col.add_child(title);
        if (summary) {
            const l = new St.Label({style_class: `kaito-daily-line${ok ? '' : ' kaito-fin-warn'}`, text: summary});
            l.clutter_text.line_wrap = true;
            l.clutter_text.line_wrap_mode = 2;
            col.add_child(l);
        }
        const buttons = new St.BoxLayout({style_class: 'kaito-reminder-buttons', x_align: Clutter.ActorAlign.END});
        const close = () => this._removeCard(cid);
        const add = (label, fn, cls = 'snooze') => {
            const b = new St.Button({style_class: `kaito-reminder-btn kaito-task-btn ${cls}`, label, can_focus: true});
            b.connect('clicked', () => {
                close();
                fn?.();
            });
            buttons.add_child(b);
        };
        if (onView)
            add('Ver completo', onView);
        if (key && onComment)
            add('Comentar en Jira', onComment);
        add('Entendido', null, `kaito-fin-ok${ok ? '' : ' kaito-task-fail-ok'}`);
        col.add_child(buttons);
        card.add_child(col);
        this._cards.set(cid, card);
        this._box.add_child(card);
        this._beep();
    }

    /**
     * "Mientras no estabas": una tarjeta con los avisos retenidos por No molestar. items: [{text, action?}];
     * onItem(item) abre su acción (si la tiene, la línea es un botón). Sin sonido.
     */
    showQueued(items, onItem = null) {
        this._removeCard(QUEUED_ID);
        if (!items?.length)
            return;
        this._ensureBox();
        const card = new St.BoxLayout({style_class: 'kaito-reminder kaito-daily kaito-queued', reactive: true});
        card.add_child(new St.Bin({
            style_class: 'kaito-reminder-icon kaito-daily-icon', y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'mail-unread-symbolic', icon_size: 20}),
        }));
        const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'kaito-reminder-col'});
        col.add_child(new St.Label({style_class: 'kaito-reminder-meta', text: `${items.length} ${items.length === 1 ? 'aviso' : 'avisos'}`}));
        col.add_child(new St.Label({style_class: 'kaito-reminder-title', text: 'Mientras no estabas'}));
        const close = () => this._removeCard(QUEUED_ID);
        for (const it of items.slice(-QUEUED_SHOWN)) {
            const l = new St.Label({style_class: 'kaito-daily-line', text: `• ${it.text}`});
            l.clutter_text.line_wrap = true;
            l.clutter_text.line_wrap_mode = 2; // Pango.WrapMode.WORD_CHAR
            if (it.action && onItem) {
                const b = new St.Button({style_class: 'kaito-queued-item', child: l, can_focus: true, track_hover: true,
                    x_expand: true, x_align: Clutter.ActorAlign.FILL});
                b.connect('clicked', () => {
                    close();
                    onItem(it);
                });
                col.add_child(b);
            } else {
                col.add_child(l);
            }
        }
        if (items.length > QUEUED_SHOWN)
            col.add_child(new St.Label({style_class: 'kaito-daily-line kaito-muted', text: `… y ${items.length - QUEUED_SHOWN} más`}));
        const buttons = new St.BoxLayout({style_class: 'kaito-reminder-buttons', x_align: Clutter.ActorAlign.END});
        const ok = new St.Button({style_class: 'kaito-reminder-btn kaito-daily-ok', label: 'Entendido', can_focus: true});
        ok.connect('clicked', close);
        buttons.add_child(ok);
        col.add_child(buttons);
        card.add_child(col);
        this._cards.set(QUEUED_ID, card);
        this._box.insert_child_at_index(card, 0);
    }

    _act(id, fn) {
        try {
            patchReminder(id, fn);
        } catch (e) {
            console.error(`kaito: no se pudo actualizar el recordatorio: ${e.message}`);
        }
        this._removeCard(id);
        this._onChange?.();
        this.check(); // por si había más vencidos esperando hueco
    }

    _removeCard(id) {
        this._cards.get(id)?.destroy();
        this._cards.delete(id);
        if (!this._cards.size && this._box) {
            Main.layoutManager.removeChrome(this._box);
            this._box.destroy();
            this._box = null;
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        Main.layoutManager.disconnect(this._monitorsId);
        if (this._box) {
            Main.layoutManager.removeChrome(this._box);
            this._box.destroy();
            this._box = null;
        }
        this._cards.clear();
    }
}
