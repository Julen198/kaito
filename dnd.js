// "No molestar" en marcha: estado (quiet.js + config.json), cola persistente de avisos y su vaciado al terminar.
// Sin imports de la shell: quien lo usa (main.js) pinta el panel, el menú y la tarjeta "Mientras no estabas".
import GLib from 'gi://GLib';

import {readConfig, updateConfig, readQuietQueue, writeQuietQueue} from './common.js';
import {isQuiet, queuePush, normalizeQueue, untilTomorrow} from './quiet.js';

const TICK_S = 30;
const HOUR_MS = 3600 * 1000;

export class QuietController {
    /**
     * @param {{onChange?: (q) => void, onFlush?: (items) => void}} hooks onChange: cambió el estado (o su "hasta");
     *   onFlush: terminó el silencio con avisos en cola (una sola tarjeta con todos).
     */
    constructor({onChange = null, onFlush = null} = {}) {
        this._onChange = onChange;
        this._onFlush = onFlush;
        this._queue = normalizeQueue(readQuietQueue());
        this._state = null;
        this._sig = null;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_S, () => {
            this.tick();
            return GLib.SOURCE_CONTINUE;
        });
        // Tras arrancar (p. ej. al volver a entrar con avisos guardados): un momento, para que la UI exista.
        this._first = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            this._first = 0;
            this.tick();
            return GLib.SOURCE_REMOVE;
        });
        this._state = this._compute();
    }

    _compute(cfg = readConfig()) {
        return isQuiet(new Date(), cfg);
    }

    /** Estado actual {quiet, reason, until}. */
    get state() {
        return this._state ?? this._compute();
    }

    get quiet() {
        return this.state.quiet;
    }

    /** ¿Retener los recordatorios mientras dure el silencio? */
    get holdReminders() {
        return this.quiet && readConfig().dndSilenceReminders;
    }

    get queue() {
        return [...this._queue];
    }

    /** Recalcula; si el silencio acaba con avisos en cola, los entrega. Lo llaman el temporizador y la config. */
    tick() {
        const q = this._compute();
        this._state = q;
        const sig = `${q.quiet}|${q.reason}|${q.until?.getTime() ?? ''}`;
        if (sig !== this._sig) {
            this._sig = sig;
            try {
                this._onChange?.(q);
            } catch (e) {
                console.warn(`kaito: no molestar: ${e.message}`);
            }
        }
        if (!q.quiet && this._queue.length && !this._first) // no durante los 5 s del arranque
            this.flush();
        return q;
    }

    /**
     * Si hay silencio, guarda el aviso en la cola y devuelve true (no se muestra ahora); si no, false.
     * item: {key, text, action?} (action: objeto serializable que resuelve main.js).
     */
    defer(item) {
        if (!this.quiet)
            return false;
        this._queue = queuePush(this._queue, {...item, at: Date.now()});
        this._save();
        return true;
    }

    flush() {
        const items = this._queue;
        if (!items.length)
            return;
        this._queue = [];
        this._save();
        try {
            this._onFlush?.(items);
        } catch (e) {
            console.warn(`kaito: avisos en cola: ${e.message}`);
        }
    }

    _save() {
        try {
            writeQuietQueue(this._queue);
        } catch (e) {
            console.warn(`kaito: no se pudo guardar quiet-queue.json: ${e.message}`);
        }
    }

    /** Opciones del menú: 'on' | 'hour' | 'tomorrow' | 'off'. */
    set(mode) {
        const cfg = readConfig();
        const now = new Date();
        let patch;
        if (mode === 'hour')
            patch = {dndManual: true, dndUntil: now.getTime() + HOUR_MS, dndSkipUntil: null};
        else if (mode === 'tomorrow')
            patch = {dndManual: true, dndUntil: untilTomorrow(now, cfg.workHours).getTime(), dndSkipUntil: null};
        else if (mode === 'on')
            patch = {dndManual: true, dndUntil: null, dndSkipUntil: null};
        else {
            // Desactivar también vale fuera de horario: se ignora el horario hasta la próxima jornada.
            const sched = isQuiet(now, {...cfg, dndManual: false, dndSkipUntil: null});
            patch = {dndManual: false, dndUntil: null,
                dndSkipUntil: sched.quiet && sched.until ? sched.until.getTime() : null};
        }
        try {
            updateConfig(patch);
        } catch (e) {
            console.warn(`kaito: no se pudo guardar No molestar: ${e.message}`);
        }
        return this.tick();
    }

    destroy() {
        for (const id of [this._timer, this._first]) {
            if (id)
                GLib.source_remove(id);
        }
        this._timer = this._first = 0;
        this._onChange = this._onFlush = null;
    }
}
