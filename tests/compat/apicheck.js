// Comprueba en los typelibs de esta versión las APIs nativas que usa Kaito y que la autoprueba no
// recorre (eventos de teclado/ratón, ventanas, lanzamiento). Script clásico (no módulo):
//   GI_TYPELIB_PATH=<mutter>:<gnome-shell> gjs apicheck.js <versión de mutter>
const v = ARGV[0];
for (const ns of ['Clutter', 'Meta', 'St', 'Shell', 'Mtk'])
    imports.gi.versions[ns] = v;
const {Clutter, Meta, St, Shell, GObject} = imports.gi;
let miss = 0;
const chk = (name, ok) => {
    print(`${ok ? 'OK  ' : 'MISS'} ${name}`);
    if (!ok)
        miss++;
};
const prop = (k, n) => !!GObject.Object.find_property.call(k, n);
const fn = (k, n) => typeof k.prototype[n] === 'function';
chk('Clutter.Event.get_source', fn(Clutter.Event, 'get_source'));
chk('Clutter.Event.get_key_symbol', fn(Clutter.Event, 'get_key_symbol'));
chk('Clutter.Event.get_state', fn(Clutter.Event, 'get_state'));
chk('Meta.Window.get_pid', fn(Meta.Window, 'get_pid'));
chk('Meta.Window.get_gtk_application_id', fn(Meta.Window, 'get_gtk_application_id'));
chk('Meta.Window.get_wm_class', fn(Meta.Window, 'get_wm_class'));
chk('Meta.Display.get_sound_player', fn(Meta.Display, 'get_sound_player'));
chk('Shell.Global.create_app_launch_context', fn(Shell.Global, 'create_app_launch_context'));
chk('Shell.Global.get_window_actors', fn(Shell.Global, 'get_window_actors'));
chk('Shell.Global.get_current_time', fn(Shell.Global, 'get_current_time'));
chk('St.ScrollView.set_child', fn(St.ScrollView, 'set_child'));
chk('St.ScrollView:child', prop(St.ScrollView, 'child'));
chk('St.BoxLayout:vertical', prop(St.BoxLayout, 'vertical'));
chk('St.Bin:child', prop(St.Bin, 'child'));
chk('St.Button:child', prop(St.Button, 'child'));
chk('Clutter.Actor.set_child_below_sibling', fn(Clutter.Actor, 'set_child_below_sibling'));
chk('St.Theme.load_stylesheet', fn(St.Theme, 'load_stylesheet'));
chk('St.Theme.unload_stylesheet', fn(St.Theme, 'unload_stylesheet'));
print(`info: St.BoxLayout:orientation=${prop(St.BoxLayout, 'orientation')} Clutter.Actor.add_actor=${fn(Clutter.Actor, 'add_actor')}`);
print(miss ? `APICHECK ${miss} ausentes` : 'APICHECK ok');
