// Tour de bienvenida: burbuja junto al menú de Kaito que resalta cada zona (textos y pasos en tour.js).
//
// Por qué un grab propio: con el menú abierto, PopupMenuManager tiene un grab de Clutter sobre menu.actor
// (Main.pushModal), así que un actor de fuera del menú no recibe clics y cualquier pulsación fuera cierra el
// menú. La burbuja vive en uiGroup (encima del menú, como los tooltips) y, mientras está, toma su propio
// Main.pushModal apilado sobre el del menú: los clics y teclas van a la burbuja y el menú sigue abierto.
// Una pulsación fuera de la burbuja y fuera del menú cancela el tour y cierra el menú (como haría el menú);
// una pulsación sobre el menú se ignora. Al cerrar el menú por cualquier otra vía, quien lo usa llama a stop().
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {WELCOME, DONE_NOTE, pointMarkup} from './tour.js';

const GAP = 12; // px lógicos entre burbuja, menú y bordes del monitor
const ARROW = 14; // lado del cuadrado girado que hace de flecha
const DIM = 70; // opacidad del resto del menú mientras se enseña una zona
const TOAST_MS = 5000;

function wrapLabel(text, styleClass, markup = false) {
    const l = new St.Label({style_class: styleClass, x_expand: true});
    l.clutter_text.line_wrap = true;
    l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    if (markup)
        l.clutter_text.set_markup(text);
    else
        l.set_text(text);
    return l;
}

function button(label, styleClass, onClick) {
    const b = new St.Button({label, style_class: styleClass, can_focus: true, track_hover: true, reactive: true});
    b.connect('clicked', () => onClick());
    return b;
}

/**
 * opts: {menu, steps: () => [{zone, n, total, title, text, points}], targets: zone => [actores del menú],
 * onDone: () => void (marca el tour como visto)}. start() con el menú abierto enseña la bienvenida.
 */
export class MenuTour {
    constructor({menu, steps, targets, onDone}) {
        this._menu = menu;
        this._stepsFn = steps;
        this._targetsFn = targets;
        this._onDone = onDone;
        this._root = null;
        this._grab = null;
        this._steps = [];
        this._i = 0; // 0 = bienvenida; 1..n = paso
        this._dimmed = new Map(); // actor -> opacidad original
        this._focus = [];
        this._placeId = 0;
        this._menuAllocId = 0;
        this._side = 'left';
        this._toast = null;
        this._toastId = 0;
    }

    get active() {
        return !!this._root;
    }

    /** Muestra la bienvenida (solo con el menú abierto y algún paso que enseñar). */
    start() {
        if (this._root || !this._menu.isOpen)
            return false;
        this._steps = this._stepsFn() ?? [];
        if (!this._steps.length)
            return false;
        this._hideToast();
        const root = new St.Widget({layout_manager: new Clutter.FixedLayout(), reactive: true, style_class: 'kaito-tour-root'});
        this._arrow = new St.Widget({style_class: 'kaito-tour-arrow', rotation_angle_z: 45});
        this._arrow.set_pivot_point(0.5, 0.5);
        this._card = new St.BoxLayout({style_class: 'kaito-tour', vertical: true, reactive: true});
        root.add_child(this._arrow);
        root.add_child(this._card);
        Main.layoutManager.addTopChrome(root);
        // Por encima del menú (los menús emergentes van sobre el resto de uiGroup), como los tooltips.
        Main.layoutManager.uiGroup.set_child_above_sibling(root, null);
        this._root = root;
        root.connect('captured-event', (_a, event) => this._onEvent(event));
        try {
            global.focus_manager.add_group(root); // Tab entre los botones
        } catch (e) {
            console.warn(`kaito: tour: foco: ${e.message}`);
        }
        this._grab = Main.pushModal(root, {actionMode: Shell.ActionMode.POPUP});
        this._menuAllocId = this._menu.actor.connect('notify::allocation', () => this._queuePlace());
        this._show(0);
        return true;
    }

    /** Quita burbuja, resaltado y grab sin marcar el tour como visto (sale otra vez al abrir el menú). */
    stop() {
        if (!this._root)
            return;
        if (this._placeId) {
            GLib.source_remove(this._placeId);
            this._placeId = 0;
        }
        if (this._menuAllocId) {
            this._menu.actor.disconnect(this._menuAllocId);
            this._menuAllocId = 0;
        }
        this._applyZone(null);
        const root = this._root;
        this._root = null;
        this._card = null;
        this._arrow = null;
        if (this._grab) {
            try {
                Main.popModal(this._grab);
            } catch (e) {
                console.warn(`kaito: tour: ${e.message}`);
            }
            this._grab = null;
        }
        try {
            global.focus_manager.remove_group(root);
        } catch (_e) { /* sin grupo */ }
        root.destroy();
    }

    destroy() {
        this.stop();
        this._hideToast();
    }

    _dismiss() {
        this._onDone?.();
        this.stop();
    }

    _finish() {
        const at = this._card ? this._card.get_transformed_position() : null;
        const w = this._card?.width ?? 0;
        this._onDone?.();
        this.stop();
        this._showToast(at, w);
    }

    _go(i) {
        if (!this._root)
            return;
        if (i > this._steps.length) {
            this._finish();
            return;
        }
        this._show(Math.max(1, i));
    }

    _onEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS) {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Escape) {
                this._dismiss(); // "Ahora no" / "Saltar"
                return Clutter.EVENT_STOP;
            }
            if (this._i > 0 && (sym === Clutter.KEY_Right || sym === Clutter.KEY_Left)) {
                this._go(this._i + (sym === Clutter.KEY_Right ? 1 : -1));
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        const target = global.stage.get_event_actor(event);
        if (this._root?.contains(target))
            return Clutter.EVENT_PROPAGATE;
        // Sobre el menú: nada (es lo que se está enseñando). Fuera de todo: se cancela y se cierra el menú.
        if (!this._menu.actor.contains(target)) {
            this.stop();
            this._menu.close();
        }
        return Clutter.EVENT_STOP;
    }

    _show(i) {
        this._i = i;
        const card = this._card;
        card.destroy_all_children();
        card.remove_style_class_name('kaito-tour-welcome');
        let primary;
        if (i === 0) {
            card.add_style_class_name('kaito-tour-welcome');
            const logo = new St.Bin({style_class: 'kaito-tour-logo', x_align: Clutter.ActorAlign.START});
            logo.set_child(new St.Widget({style_class: 'kaito-tour-logo-dot', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
            card.add_child(logo);
            card.add_child(wrapLabel(WELCOME.title, 'kaito-tour-welcome-title'));
            card.add_child(wrapLabel(WELCOME.text, 'kaito-tour-welcome-text'));
            const row = new St.BoxLayout({style_class: 'kaito-tour-buttons', x_expand: true});
            row.add_child(new St.Widget({x_expand: true}));
            row.add_child(button(WELCOME.skip, 'kaito-tour-btn', () => this._dismiss()));
            primary = button(WELCOME.go, 'kaito-tour-btn kaito-tour-primary', () => this._go(1));
            row.add_child(primary);
            card.add_child(row);
            this._arrow.hide();
            this._applyZone(null);
        } else {
            const s = this._steps[i - 1];
            card.add_child(new St.Label({text: `Paso ${s.n} de ${s.total}`, style_class: 'kaito-tour-meta'}));
            card.add_child(wrapLabel(s.title, 'kaito-tour-title'));
            card.add_child(wrapLabel(s.text, 'kaito-tour-text'));
            const pts = new St.BoxLayout({style_class: 'kaito-tour-points', vertical: true, x_expand: true});
            for (const p of s.points) {
                const row = new St.BoxLayout({style_class: 'kaito-tour-point', x_expand: true});
                row.add_child(new St.Widget({style_class: 'kaito-tour-bullet', style: `background-color: ${p.c};`, y_align: Clutter.ActorAlign.START}));
                row.add_child(wrapLabel(pointMarkup(p), 'kaito-tour-point-text', true));
                pts.add_child(row);
            }
            card.add_child(pts);
            const prog = new St.BoxLayout({style_class: 'kaito-tour-progress', x_expand: true});
            for (let k = 1; k <= s.total; k++)
                prog.add_child(new St.Widget({style_class: k <= s.n ? 'kaito-tour-seg kaito-tour-seg-on' : 'kaito-tour-seg', x_expand: true}));
            card.add_child(prog);
            const row = new St.BoxLayout({style_class: 'kaito-tour-buttons', x_expand: true});
            row.add_child(button('Saltar', 'kaito-tour-skip', () => this._dismiss()));
            row.add_child(new St.Widget({x_expand: true}));
            if (s.n > 1)
                row.add_child(button('Atrás', 'kaito-tour-btn', () => this._go(i - 1)));
            primary = button(s.n === s.total ? 'Terminar' : 'Siguiente', 'kaito-tour-btn kaito-tour-primary', () => this._go(i + 1));
            row.add_child(primary);
            card.add_child(row);
            this._arrow.show();
            this._applyZone(s.zone);
        }
        primary.grab_key_focus();
        this._place();
        this._queuePlace(); // otra vez con el menú ya recolocado (el resaltado puede cambiar alturas)
    }

    /** Resalta los actores de la zona y atenúa el resto de filas del menú; null lo deja todo como estaba. */
    _applyZone(zone) {
        for (const a of this._focus)
            a.remove_style_class_name?.('kaito-tour-focus');
        for (const [a, op] of this._dimmed)
            a.opacity = op;
        this._focus = [];
        this._dimmed.clear();
        if (!zone)
            return;
        const targets = (this._targetsFn(zone) ?? []).filter(Boolean);
        for (const child of this._menu.box.get_children()) {
            if (targets.includes(child))
                continue;
            this._dimmed.set(child, child.opacity);
            child.opacity = DIM;
        }
        for (const a of targets) {
            a.add_style_class_name('kaito-tour-focus');
            this._focus.push(a);
        }
    }

    _queuePlace() {
        if (this._placeId || !this._root)
            return;
        this._placeId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._placeId = 0;
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Burbuja a la izquierda del menú (o a la derecha si no cabe), a la altura de la zona y dentro del monitor. */
    _place() {
        const root = this._root;
        if (!root)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const gap = GAP * scale, arrow = ARROW * scale;
        const menuActor = this._menu.actor;
        const [mx, my] = menuActor.get_transformed_position();
        const [mw, mh] = menuActor.get_transformed_size();
        const mon = Main.layoutManager.findMonitorForActor(menuActor) ?? Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const area = Main.layoutManager.getWorkAreaForMonitor(mon.index);
        const [, w] = this._card.get_preferred_width(-1);
        const [, h] = this._card.get_preferred_height(w);
        const fitsLeft = mx - gap - w >= area.x + gap;
        const fitsRight = mx + mw + gap + w <= area.x + area.width - gap;
        const side = fitsLeft || !fitsRight ? 'left' : 'right';
        let x = side === 'left' ? mx - gap - w : mx + mw + gap;
        x = Math.min(Math.max(x, area.x + gap), area.x + area.width - w - gap);
        let y, mid = null;
        if (this._i === 0) {
            // Bienvenida: centrada en el hueco a la izquierda del menú.
            if (side === 'left')
                x = Math.max(area.x + gap, Math.round((area.x + mx - w) / 2));
            y = area.y + Math.round((area.height - h) / 2);
        } else {
            let top = Infinity, bottom = -Infinity;
            for (const a of this._focus) {
                if (!a.mapped || !a.visible)
                    continue;
                const [, ay] = a.get_transformed_position();
                const [, ah] = a.get_transformed_size();
                top = Math.min(top, ay);
                bottom = Math.max(bottom, ay + ah);
            }
            mid = Number.isFinite(top) ? (top + bottom) / 2 : my + mh / 3;
            y = mid - 40 * scale;
        }
        y = Math.min(Math.max(y, area.y + gap), area.y + area.height - h - gap);
        // Flecha: medio cuadrado asomando por el lado del menú, a la altura de la zona.
        const half = Math.round(arrow / 2);
        const ay = mid === null ? 0 : Math.min(Math.max(mid - y - half, 16 * scale), h - 16 * scale - arrow);
        this._arrow.set_size(arrow, arrow);
        if (side === 'left') {
            this._card.set_position(0, 0);
            this._arrow.set_position(w - half, Math.round(ay));
            root.set_position(Math.round(x), Math.round(y));
        } else {
            this._card.set_position(half, 0);
            this._arrow.set_position(0, Math.round(ay));
            root.set_position(Math.round(x - half), Math.round(y));
        }
        this._side = side;
    }

    /** "Listo. Puedes repetir el tour desde Ajustes." donde estaba la burbuja, unos segundos (sin clics). */
    _showToast(at, width) {
        this._hideToast();
        const toast = new St.BoxLayout({style_class: 'kaito-tour-toast', reactive: false});
        toast.add_child(new St.Label({text: DONE_NOTE, y_align: Clutter.ActorAlign.CENTER}));
        Main.layoutManager.addTopChrome(toast);
        Main.layoutManager.uiGroup.set_child_above_sibling(toast, null);
        this._toast = toast;
        const [, w] = toast.get_preferred_width(-1);
        const mon = Main.layoutManager.findMonitorForActor(this._menu.actor) ?? Main.layoutManager.primaryMonitor;
        const area = mon ? Main.layoutManager.getWorkAreaForMonitor(mon.index) : {x: 0, y: 0, width: w, height: 100};
        const x = at ? at[0] + Math.max(0, width - w) : area.x + area.width - w - GAP;
        const y = at ? at[1] : area.y + GAP;
        toast.set_position(Math.round(Math.max(area.x, x)), Math.round(Math.max(area.y, y)));
        this._toastId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOAST_MS, () => {
            this._toastId = 0;
            this._hideToast();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideToast() {
        if (this._toastId) {
            GLib.source_remove(this._toastId);
            this._toastId = 0;
        }
        this._toast?.destroy();
        this._toast = null;
    }
}
