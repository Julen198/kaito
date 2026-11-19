// Cargador de Kaito. MANTENLO MÍNIMO: gnome-shell cachea los módulos ES por URL durante toda la sesión,
// así que este archivo (y metadata.json) solo se actualizan cerrando sesión. Todo lo demás vive en
// main.js y se recarga en caliente: se copia el código (*.js) a $XDG_CACHE_HOME/kaito/build/<hash>/ y
// se importa desde ahí, de modo que cada versión (y todos sus imports relativos) tiene una URL nueva.
// Recargar: `kaito reload` (toca $XDG_CACHE_HOME/kaito/reload) o el botón "Actualizar" del menú.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CACHE = GLib.build_filenamev([GLib.get_user_cache_dir(), 'kaito']);
const BUILD_ROOT = GLib.build_filenamev([CACHE, 'build']);
const TRIGGER = GLib.build_filenamev([CACHE, 'reload']);
const SKIP = /^(extension|prefs)\.js$|\.test\.js$/; // el cargador, las preferencias (otro proceso) y los tests

// "SyntaxError: ... (common.js:12)": el stack de un error de sintaxis al importar no dice dónde está.
const where = e => e?.fileName ? ` (${GLib.path_get_basename(String(e.fileName))}:${e.lineNumber ?? '?'})` : '';
const msg = e => `${String(e?.message ?? e).split('\n')[0]}${where(e)}`;

/** Copia los *.js a BUILD_ROOT/<hash>/ (si no existe ya) y devuelve {stamp, uri}. */
function prepareBuild(srcDir) {
    const names = [];
    const en = srcDir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    for (let info; (info = en.next_file(null));) {
        const n = info.get_name();
        if (n.endsWith('.js') && !SKIP.test(n) && info.get_file_type() === Gio.FileType.REGULAR)
            names.push(n);
    }
    en.close(null);
    names.sort();
    if (!names.includes('main.js'))
        throw new Error('falta main.js');
    const sum = new GLib.Checksum(GLib.ChecksumType.SHA256);
    const files = names.map(n => {
        const [, bytes] = GLib.file_get_contents(srcDir.get_child(n).get_path());
        sum.update(new TextEncoder().encode(`${n}\0${bytes.length}\0`));
        sum.update(bytes);
        return [n, bytes];
    });
    const stamp = sum.get_string().slice(0, 12);
    const dir = GLib.build_filenamev([BUILD_ROOT, stamp]);
    if (!GLib.file_test(GLib.build_filenamev([dir, 'main.js']), GLib.FileTest.EXISTS)) {
        GLib.mkdir_with_parents(BUILD_ROOT, 0o700);
        const tmp = GLib.build_filenamev([BUILD_ROOT, `.tmp-${stamp}-${GLib.get_real_time()}`]);
        GLib.mkdir_with_parents(tmp, 0o700);
        for (const [n, bytes] of files)
            GLib.file_set_contents(GLib.build_filenamev([tmp, n]), bytes);
        // Atómico: o está entera o no está.
        if (GLib.rename(tmp, dir) !== 0) {
            removeDir(tmp);
            if (!GLib.file_test(GLib.build_filenamev([dir, 'main.js']), GLib.FileTest.EXISTS))
                throw new Error(`no se pudo crear ${dir}`);
        }
    }
    return {stamp, uri: Gio.File.new_for_path(GLib.build_filenamev([dir, 'main.js'])).get_uri()};
}

function removeDir(path) {
    const d = Gio.File.new_for_path(path);
    try {
        const en = d.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        for (let info; (info = en.next_file(null));)
            d.get_child(info.get_name()).delete(null);
        en.close(null);
        d.delete(null);
    } catch (e) {
        console.warn(`kaito: no se pudo borrar ${path}: ${msg(e)}`);
    }
}

/** Borra las builds viejas: solo quedan las de `keep` (la activa y la anterior, de reserva). */
function pruneBuilds(keep) {
    const root = Gio.File.new_for_path(BUILD_ROOT);
    try {
        const en = root.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        const old = [];
        for (let info; (info = en.next_file(null));) {
            if (!keep.includes(info.get_name()))
                old.push(info.get_name());
        }
        en.close(null);
        for (const n of old)
            removeDir(GLib.build_filenamev([BUILD_ROOT, n]));
    } catch (e) {
        console.warn(`kaito: limpieza de builds: ${msg(e)}`);
    }
}

export default class KaitoLoader extends Extension {
    async enable() {
        this._enabled = true;
        this._shared ??= {}; // sobrevive a las recargas (p. ej. el resultado de "Actualizar")
        this._watchTrigger();
        await this.reload();
    }

    disable() {
        this._enabled = false;
        this._again = false;
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = 0;
        this._monitor?.cancel();
        this._monitor = null;
        this._stopImpl();
    }

    /** Importa el código actual y sustituye la versión en marcha. Serializado; nunca lanza. */
    async reload() {
        if (this._busy) {
            this._again = true;
            return;
        }
        this._busy = true;
        try {
            do {
                this._again = false;
                // eslint-disable-next-line no-await-in-loop
                await this._reloadOnce();
            } while (this._again && this._enabled);
        } finally {
            this._busy = false;
        }
    }

    async _reloadOnce() {
        let build, mod;
        try {
            build = prepareBuild(this.dir);
            mod = await import(build.uri);
            if (typeof mod.default !== 'function')
                throw new Error('main.js no exporta una clase por defecto');
        } catch (e) {
            this._failed(e);
            return;
        }
        if (!this._enabled)
            return;
        const prev = this._impl ? {Impl: this._Impl, stamp: this._stamp} : null;
        this._stopImpl();
        this._reloadStylesheet();
        try {
            this._startImpl(mod.default, build.stamp);
        } catch (e) {
            this._stopImpl();
            this._failed(e);
            if (prev) {
                try {
                    this._startImpl(prev.Impl, prev.stamp);
                } catch (e2) {
                    this._stopImpl();
                    console.warn(`kaito: tampoco arranca la versión anterior: ${msg(e2)}`);
                }
            }
            return;
        }
        pruneBuilds([build.stamp, prev?.stamp]);
    }

    _startImpl(Impl, stamp) {
        const impl = new Impl({
            extension: this, dir: this.dir, path: this.path, uuid: this.uuid, metadata: this.metadata,
            loadId: stamp, shared: this._shared, reload: () => this.reload(),
        });
        this._impl = impl;
        this._Impl = Impl;
        this._stamp = stamp;
        impl.enable();
    }

    _stopImpl() {
        const impl = this._impl;
        this._impl = null;
        try {
            impl?.disable();
        } catch (e) {
            console.warn(`kaito: error al desactivar la build ${this._stamp}: ${msg(e)}`);
        }
    }

    _failed(e) {
        console.warn(`kaito: no se pudo recargar: ${e?.name ?? 'Error'}: ${msg(e)}\n${e?.stack ?? ''}`);
        try {
            Main.notify('Kaito: no se pudo recargar', `${msg(e)}. Cierra sesión para aplicar la actualización.`);
        } catch {}
    }

    /** Lo mismo que hace gnome-shell al activar: descarga y vuelve a cargar stylesheet.css. */
    _reloadStylesheet() {
        try {
            const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            const meta = Main.extensionManager.lookup(this.uuid);
            const file = meta?.stylesheet ?? this.dir.get_child('stylesheet.css');
            if (!file.query_exists(null))
                return;
            theme.unload_stylesheet(file);
            theme.load_stylesheet(file);
            if (meta)
                meta.stylesheet = file; // así gnome-shell la descarga al desactivar
        } catch (e) {
            console.warn(`kaito: no se pudo recargar stylesheet.css: ${msg(e)}`);
        }
    }

    _watchTrigger() {
        if (this._monitor)
            return;
        try {
            GLib.mkdir_with_parents(CACHE, 0o755);
            this._monitor = Gio.File.new_for_path(TRIGGER).monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitor.connect('changed', (_m, _f, _o, ev) => {
                if (ev === Gio.FileMonitorEvent.DELETED)
                    return;
                if (this._debounceId)
                    GLib.source_remove(this._debounceId);
                this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                    this._debounceId = 0;
                    if (this._enabled)
                        this.reload().catch(e => console.warn(`kaito: recarga: ${msg(e)}`));
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (e) {
            console.warn(`kaito: no se puede vigilar ${TRIGGER}: ${msg(e)}`);
        }
    }
}
