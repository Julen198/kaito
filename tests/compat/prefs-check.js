// Carga prefs.js de Kaito como lo haría gnome-extensions-app y recorre la ventana resultante.
// Uso: WAYLAND_DISPLAY=… gjs -m prefs-check.js <carpeta-de-la-extensión>
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import System from 'system';

const dir = Gio.File.new_for_path(System.programArgs[0]);
for (const res of ['/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource',
    '/usr/share/gnome-shell/org.gnome.Extensions.src.gresource']) {
    if (GLib.file_test(res, GLib.FileTest.EXISTS))
        Gio.Resource.load(res)._register();
}
Adw.init();
const {default: Prefs} = await import(dir.get_child('prefs.js').get_uri());
const metadata = JSON.parse(new TextDecoder().decode(dir.get_child('metadata.json').load_contents(null)[1]));
const win = new Adw.PreferencesWindow();
const p = new Prefs({...metadata, path: dir.get_path(), dir});
await p.fillPreferencesWindow(win);
win.present();
const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
    let n = 0, groups = 0;
    const walk = w => {
        for (let c = w.get_first_child(); c; c = c.get_next_sibling()) {
            n++;
            if (c instanceof Adw.PreferencesGroup)
                groups++;
            walk(c);
        }
    };
    walk(win);
    print(`PREFS ok adw=${Adw.MAJOR_VERSION}.${Adw.MINOR_VERSION} gtk=${Gtk.MAJOR_VERSION}.${Gtk.MINOR_VERSION} groups=${groups} widgets=${n}`);
    win.close();
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
