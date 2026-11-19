// Aviso de versión nueva en el menú: `kaito check --json` cada 6 h (y 2 min tras activar) y botón
// "Actualizar" que ejecuta `kaito update --yes` y recarga el código en caliente.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {readConfig, parseUpdateMarker, firstErrorLine, parseCheck} from './common.js';

const FIRST_CHECK_S = 120;
const CHECK_EVERY_S = 6 * 3600;
const RESULT_KEEP_MS = 10 * 60 * 1000; // "Actualizado a X" se ve un rato tras recargar

export class UpdateNotice {
    /**
     * @param {{path: string, shared: object, reload: () => Promise}} ext la implementación (main.js)
     * @param {{onState?: (notice) => void, onAvailable?: (check) => void}} hooks onState: cambió el aviso (punto
     *   del panel); onAvailable: `kaito check` encontró versión nueva ({latest, behind, changes}).
     */
    constructor(ext, hooks = {}) {
        this._ext = ext;
        this._hooks = hooks;
        this._bin = GLib.build_filenamev([ext.path, 'bin', 'kaito']);
        this._enabled = GLib.file_test(GLib.build_filenamev([ext.path, '.git']), GLib.FileTest.EXISTS) &&
            GLib.file_test(this._bin, GLib.FileTest.IS_EXECUTABLE);
        this._cancellable = new Gio.Cancellable();
        this._state = null; // {kind: 'available'|'updating'|'done'|'error', ...}
        this._timers = new Set();

        this.item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'kaito-row kaito-update'});
        this._label = new St.Label({text: '', style_class: 'kaito-update-text', y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._button = new St.Button({
            label: 'Actualizar', style_class: 'kaito-update-btn', can_focus: true, track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._button.connect('clicked', () => this.update().catch(e => console.warn(`kaito: actualizar: ${e.message}`)));
        this.item.add_child(this._label);
        this.item.add_child(this._button);
        this.item.visible = false;

        if (!this._enabled)
            return;
        // Resultado de un "Actualizar" de la versión anterior (el código acaba de recargarse).
        const r = ext.shared?.updateResult;
        if (r && Date.now() - r.at < RESULT_KEEP_MS) {
            delete ext.shared.updateResult;
            this._set(r.ok ? {kind: 'done', ...r} : {kind: 'error', text: r.error});
        }
        // Tras una recarga se conserva el último resultado: el aviso no desaparece 2 min.
        const last = ext.shared?.lastCheck;
        if (!this._state && last?.behind > 0 && Date.now() - last.at < CHECK_EVERY_S * 1000 && readConfig().checkUpdates)
            this._set({kind: 'available', latest: last.latest});
        const env = Number(GLib.getenv('KAITO_UPDATE_FIRST_CHECK_S'));
        this._after(Number.isFinite(env) && env > 0 ? env : FIRST_CHECK_S, () => this.check());
        this._every = this._after(CHECK_EVERY_S, () => this.check(), true);
    }

    _after(secs, fn, repeat = false) {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            fn();
            if (repeat)
                return GLib.SOURCE_CONTINUE;
            this._timers.delete(id);
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    /** Al cambiar config.json: oculta el aviso si se desactivó la búsqueda. */
    onConfig() {
        if (this._enabled && !readConfig().checkUpdates && this._state?.kind === 'available')
            this._set(null);
    }

    /** ¿Hay una versión nueva sin instalar? (para el punto del panel) */
    get pending() {
        return this._state?.kind === 'available' || this._state?.kind === 'error';
    }

    _set(state) {
        this._state = state;
        try {
            this._hooks.onState?.(this);
        } catch (e) {
            console.warn(`kaito: aviso de actualización: ${e.message}`);
        }
        const k = state?.kind;
        this.item.visible = !!state;
        this._label.remove_style_class_name('kaito-error');
        this._button.visible = k === 'available' || k === 'error';
        this._button.reactive = this._button.visible;
        this._button.label = k === 'error' ? 'Reintentar' : 'Actualizar';
        if (k === 'available')
            this._label.text = `Hay una versión nueva (${state.latest ?? '?'})`;
        else if (k === 'updating')
            this._label.text = 'Actualizando…';
        else if (k === 'done')
            this._label.text = state.relogin
                ? `Actualizado a ${state.version} · cierra sesión para aplicarlo del todo`
                : state.updated === false ? `Ya tienes la última versión (${state.version})` : `Actualizado a ${state.version}`;
        else if (k === 'error') {
            this._label.text = `No se pudo actualizar: ${state.text}`;
            this._label.add_style_class_name('kaito-error');
        }
    }

    async _run(argv, env = {}, cancellable = this._cancellable) {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
        });
        launcher.set_cwd(this._ext.path);
        for (const [k, v] of Object.entries(env))
            launcher.setenv(k, v, true);
        const proc = launcher.spawnv(argv);
        const [out] = await proc.communicate_utf8_async(null, cancellable);
        return {ok: proc.get_successful(), out: out ?? ''};
    }

    async check() {
        if (!this._enabled || !readConfig().checkUpdates || ['updating', 'error'].includes(this._state?.kind))
            return;
        if (this._state?.kind === 'done' && Date.now() - (this._state.at ?? 0) < RESULT_KEEP_MS)
            return;
        try {
            const {out} = await this._run([this._bin, 'check', '--json']);
            if (this._cancellable.is_cancelled())
                return;
            const c = parseCheck(out);
            if (!c)
                return; // sin red o sin acceso: se reintenta en el próximo ciclo
            this._ext.shared.lastCheck = {...c, at: Date.now()};
            this._set(c.behind > 0 ? {kind: 'available', latest: c.latest} : null);
            if (c.behind > 0)
                this._hooks.onAvailable?.(c);
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                console.warn(`kaito: comprobar actualizaciones: ${e.message}`);
        }
    }

    async update() {
        if (!this._enabled || this._state?.kind === 'updating')
            return;
        this._set({kind: 'updating'});
        let res;
        try {
            // Sin cancellable: si Kaito se recarga a mitad, el update termina igualmente (nunca se mata un git pull).
            res = await this._run([this._bin, 'update', '--yes'], {KAITO_UPDATE_FROM_SHELL: '1'}, null);
        } catch (e) {
            res = {ok: false, out: e.message};
        }
        if (this._cancellable.is_cancelled())
            return;
        const mark = parseUpdateMarker(res.out);
        if (!res.ok || !mark) {
            const text = firstErrorLine(res.out);
            console.warn(`kaito: kaito update falló: ${text}`);
            this._set({kind: 'error', text});
            return;
        }
        const result = {ok: true, ...mark, at: Date.now()};
        delete this._ext.shared.lastCheck;
        if (!mark.updated) {
            this._set({kind: 'done', ...result});
            return;
        }
        // La versión nueva lo mostrará al arrancar; si la recarga falla, el cargador vuelve a esta.
        this._ext.shared.updateResult = result;
        this._ext.reload();
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
    }
}
