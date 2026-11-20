import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DELAY_MS = 500;
const MAX_WIDTH = 360;
const GAP = 6;

/**
 * Tooltip flotante al quedarse el puntero sobre `actor` (~500 ms). `textFn()` devuelve
 * `{title, detail}` (o una cadena); si no hay título no se muestra. Se oculta al salir, al pulsar,
 * al desmapearse el actor (menú cerrado), al hacer scroll y al destruirlo. Devuelve {hide}.
 */
export function attachTooltip(actor, textFn) {
    let timeoutId = 0;
    let tip = null;

    const hide = () => {
        if (timeoutId) {
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        }
        if (tip) {
            tip.destroy();
            tip = null;
        }
    };

    const show = () => {
        timeoutId = 0;
        if (tip || !actor.mapped || !actor.get_stage())
            return GLib.SOURCE_REMOVE;
        let t;
        try {
            t = textFn();
        } catch (e) {
            console.error(`kaito: tooltip: ${e.message}`);
            return GLib.SOURCE_REMOVE;
        }
        const title = typeof t === 'string' ? t : t?.title;
        if (!title)
            return GLib.SOURCE_REMOVE;
        const box = new St.BoxLayout({style_class: 'kaito-tooltip', vertical: true, reactive: false});
        const wrap = l => {
            l.clutter_text.line_wrap = true;
            l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            return l;
        };
        box.add_child(wrap(new St.Label({text: title, style_class: 'kaito-tooltip-title'})));
        if (t?.detail)
            box.add_child(wrap(new St.Label({text: t.detail, style_class: 'kaito-tooltip-detail'})));
        box.set_style(`max-width: ${MAX_WIDTH}px;`);
        Main.layoutManager.addTopChrome(box);
        // Los menús emergentes viven por encima de screenshotUIGroup: el tooltip va arriba del todo
        // (con un sibling por debajo quedaría oculto tras el menú de Kaito).
        Main.layoutManager.uiGroup.set_child_above_sibling(box, null);
        tip = box;

        const [ax, ay] = actor.get_transformed_position();
        const [aw, ah] = actor.get_transformed_size();
        const [, w] = box.get_preferred_width(-1);
        const [, h] = box.get_preferred_height(Math.min(w, MAX_WIDTH));
        const mon = Main.layoutManager.findMonitorForActor(actor) ?? Main.layoutManager.primaryMonitor;
        const area = Main.layoutManager.getWorkAreaForMonitor(mon.index);
        let x = Math.min(Math.max(ax, area.x + GAP), area.x + area.width - w - GAP);
        let y = ay + ah + GAP;
        if (y + h > area.y + area.height - GAP)
            y = Math.max(area.y + GAP, ay - h - GAP);
        box.set_position(Math.round(x), Math.round(y));
        return GLib.SOURCE_REMOVE;
    };

    const ids = [
        actor.connect('notify::hover', () => {
            hide();
            if (actor.hover)
                timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DELAY_MS, show);
        }),
        actor.connect('notify::mapped', () => {
            if (!actor.mapped)
                hide();
        }),
        actor.connect('scroll-event', () => {
            hide();
            return Clutter.EVENT_PROPAGATE;
        }),
        actor.connect('button-press-event', () => {
            hide();
            return Clutter.EVENT_PROPAGATE;
        }),
        actor.connect('clicked', hide),
    ];
    actor.connect('destroy', () => {
        hide();
        ids.length = 0;
    });
    return {hide};
}
