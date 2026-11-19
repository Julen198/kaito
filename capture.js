import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {addNote, addReminder, collectRepos, readConfig, readJson, updateConfig, CONFIG_PATH} from './common.js';
import {parseWhen, parseSchedule, nextRun, nextLabel} from './when.js';
import {
    TOOLS, TOOLS_LABEL, addTask, newTask, extractKey, suggestTools, taskName, resolveCwd,
} from './tasks.js';
import {
    KINDS, PRIORITIES, PRIORITY_ES, DEFAULT_PROJECT, DRAFT_TIMEOUT_S,
    draftWithClaude, loadCreateContext, fetchProjectStats, createIssue,
    moveToReady, readyRegex,
    matchIssueType, projectCandidates, mostUsedOption, fieldValue,
} from './jiradraft.js';

const WIDTH = 640;
const TOP = 110;
const MODES = [
    {id: 'note', title: 'Nota', icon: 'document-edit-symbolic', hint: 'Escribe una nota'},
    {id: 'reminder', title: 'Recordatorio', icon: 'alarm-symbolic',
        hint: 'Qué y cuándo: «llamar a Iker en 20 min»'},
    {id: 'jira', title: 'Jira', file: 'jira.svg',
        hint: 'Qué pasa: «el chat de Nike en FR no carga los cupones, urgente»'},
    {id: 'task', title: 'Tarea', icon: 'media-playlist-repeat-symbolic',
        hint: 'Cuándo y qué: «cada lunes a las 9 revisa en BigQuery las ventas…»'},
];
const TASK_NO_WHEN = 'Añade cuándo: «todos los lunes a las 9», «cada hora», «mañana a las 10»…';
const REPO_CHOICES = 8;
const tilde = p => (p.startsWith(GLib.get_home_dir()) ? `~${p.slice(GLib.get_home_dir().length)}` : p);
// Estilos inline del modo Jira (stylesheet.css lo edita otro flujo).
const ST_ERROR = 'color: #FFA348;';
const ST_SUMMARY = 'font-size: 19px; font-weight: bold; padding: 14px 24px 6px 24px;';
const ST_DESC_SCROLL = 'max-height: 230px; margin: 0 24px;';
const ST_DESC = 'font-size: 0.95em; color: rgba(255,255,255,0.85);';
const ST_CHIPS = 'spacing: 8px; padding: 12px 24px 14px 24px;';
const ST_CHIP = 'background-color: rgba(255,255,255,0.10); border-radius: 8px; padding: 4px 10px; color: #ffffff;';
const ST_CHIP_HOVER = 'background-color: rgba(255,255,255,0.18); border-radius: 8px; padding: 4px 10px; color: #ffffff;';

const lbl = (text, cls = '') => new St.Label({text, style_class: cls, y_align: Clutter.ActorAlign.CENTER});

/** Pestañas disponibles: sin Jira si está desactivado en Ajustes. */
const activeModes = () => (readConfig().jiraEnabled ? MODES : MODES.filter(m => m.id !== 'jira'));

/** captureMode crudo: readConfig() solo conoce note/reminder. */
function savedMode(modes = MODES) {
    const raw = readJson(CONFIG_PATH, {})?.captureMode;
    const mode = modes.some(m => m.id === raw) ? raw : readConfig().captureMode;
    return modes.some(m => m.id === mode) ? mode : 'note';
}

/** "## Título" → negrita; el resto, escapado. */
function descMarkup(text) {
    return String(text).split('\n').map(line => {
        const m = /^\s*#{1,6}\s+(.+)$/.exec(line);
        return m ? `<b>${GLib.markup_escape_text(m[1], -1)}</b>` : GLib.markup_escape_text(line, -1);
    }).join('\n');
}

/** Cuadro modal tipo Spotlight para crear una nota, un recordatorio o un ticket de Jira. */
export class CaptureModal {
    /**
     * @param {() => void} onSaved se llama tras guardar algo
     * @param {object} opts {issueSummary(key) → string}: resumen de un ticket ya cargado (para elegir herramientas);
     *   {extensionDir}: carpeta real de la extensión (de ahí salen los iconos; el código corre desde una copia)
     */
    constructor(onSaved, opts = {}) {
        this._onSaved = onSaved;
        this._extensionDir = opts.extensionDir;
        this._issueSummary = opts.issueSummary ?? (() => '');
        this._overlay = null;
        this._gen = 0;
    }

    get isOpen() {
        return this._overlay !== null;
    }

    /** @param {string} initialText texto inicial (cursor al final) @param {string|null} mode pestaña a abrir */
    open(initialText = '', mode = null) {
        if (this._overlay)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;

        this._modes = activeModes();
        this._mode = this._modes.some(m => m.id === mode) ? mode : savedMode(this._modes);
        this._jira = {stage: 'input'};
        this._task = {stage: 'input'};
        const overlay = new St.Widget({
            style_class: 'kaito-capture-overlay', reactive: true,
            x: mon.x, y: mon.y, width: mon.width, height: mon.height,
        });
        overlay.connect('button-press-event', (_a, ev) => {
            if (ev.get_source() === overlay)
                this.close();
            return Clutter.EVENT_STOP;
        });
        overlay.connect('key-press-event', (_a, ev) => this._onKey(ev));

        const card = new St.BoxLayout({
            style_class: 'kaito-capture', vertical: true, reactive: true,
            x: Math.round((mon.width - WIDTH) / 2), y: TOP, width: WIDTH,
        });
        this._card = card;
        overlay.add_child(card);
        card.add_child(this._buildTabs());

        this._entry = new St.Entry({style_class: 'kaito-capture-entry', can_focus: true, x_expand: true});
        this._entry.clutter_text.connect('activate', () => this._save());
        this._entry.clutter_text.connect('text-changed', () => this._updateFooter());
        card.add_child(this._entry);
        card.add_child(this._buildFooter());

        this._overlay = overlay;
        Main.layoutManager.addTopChrome(overlay);
        // Por debajo de la herramienta de capturas de GNOME, para poder fotografiarlo.
        Main.layoutManager.uiGroup.set_child_below_sibling(overlay, Main.layoutManager.screenshotUIGroup);
        this._grab = Main.pushModal(overlay);
        this._entry.grab_key_focus();
        if (initialText) {
            this._entry.set_text(initialText);
            this._entry.clutter_text.set_cursor_position(-1);
        }
        this._applyMode();
    }

    close() {
        const overlay = this._overlay;
        if (!overlay)
            return;
        this._overlay = null;
        this._gen++;
        this._stopJiraWork();
        this._session?.abort();
        this._session = null;
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
        this._entry = this._footerLeft = this._footerEl = this._footerKeys = this._tabs = null;
        this._card = this._review = this._sumEntry = this._chipsBox = null;
        this._jira = null;
        this._task = null;
    }

    destroy() {
        this.close();
    }

    _buildTabs() {
        const row = new St.BoxLayout({style_class: 'kaito-capture-top'});
        this._tabs = {};
        for (const m of this._modes) {
            const content = new St.BoxLayout({style_class: 'kaito-capture-tab-content'});
            const icon = m.file
                ? {gicon: new Gio.FileIcon({file: Gio.File.new_for_path(GLib.build_filenamev([this._extensionDir, 'icons', m.file]))})}
                : {icon_name: m.icon};
            content.add_child(new St.Icon({...icon, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
            content.add_child(lbl(m.title));
            const btn = new St.Button({
                style_class: 'kaito-tab', can_focus: false, child: content, toggle_mode: false,
            });
            btn.connect('clicked', () => {
                if (this._stage() !== 'input')
                    return;
                this._setMode(m.id);
                this._entry.grab_key_focus();
            });
            this._tabs[m.id] = btn;
            row.add_child(btn);
        }
        row.add_child(new St.Widget({x_expand: true}));
        row.add_child(lbl('Tab para cambiar', 'kaito-capture-muted'));
        return row;
    }

    _buildFooter() {
        const footer = new St.BoxLayout({style_class: 'kaito-capture-footer', x_expand: true});
        this._footerEl = footer;
        this._footerLeft = new St.BoxLayout({style_class: 'kaito-capture-footer-left', x_expand: true});
        footer.add_child(this._footerLeft);
        this._footerKeys = new St.BoxLayout({style_class: 'kaito-capture-footer-left'});
        footer.add_child(this._footerKeys);
        return footer;
    }

    _setKeys(pairs) {
        const box = this._footerKeys;
        box.destroy_all_children();
        for (const [key, text] of pairs) {
            const k = new St.BoxLayout({style_class: 'kaito-capture-key'});
            k.add_child(lbl(key, 'kaito-capture-cap'));
            k.add_child(lbl(text, 'kaito-capture-muted'));
            box.add_child(k);
        }
    }

    /** Etapa del modo actual (Jira y Tarea tienen revisión; nota y recordatorio, no). */
    _stage() {
        if (this._mode === 'task')
            return this._task?.stage ?? 'input';
        return this._mode === 'jira' ? this._jira?.stage ?? 'input' : 'input';
    }

    _onKey(ev) {
        const stage = this._stage();
        const sym = ev.get_key_symbol();
        switch (sym) {
        case Clutter.KEY_Escape:
            if (this._mode === 'jira' && stage === 'creating')
                return Clutter.EVENT_STOP; // el POST ya va en camino
            if (this._mode === 'jira' && stage !== 'input')
                this._jiraBackToInput();
            else if (this._mode === 'task' && stage !== 'input')
                this._taskBackToInput();
            else
                this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab: {
            if (stage !== 'input')
                return Clutter.EVENT_STOP;
            const modes = this._modes;
            const i = modes.findIndex(m => m.id === this._mode);
            const step = sym === Clutter.KEY_ISO_Left_Tab ? modes.length - 1 : 1;
            this._setMode(modes[(i + step) % modes.length].id);
            return Clutter.EVENT_STOP;
        }
        default:
            // Ctrl+1..9 cicla los chips del borrador.
            if (stage === 'review' && (ev.get_state() & Clutter.ModifierType.CONTROL_MASK) &&
                sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
                this._chipActions?.[sym - Clutter.KEY_1]?.();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _setMode(mode) {
        this._mode = mode;
        try {
            updateConfig({captureMode: mode});
        } catch (e) {
            console.error(`kaito: no se pudo guardar captureMode: ${e.message}`);
        }
        this._applyMode();
    }

    _applyMode() {
        for (const m of this._modes) {
            if (m.id === this._mode)
                this._tabs[m.id].add_style_class_name('selected');
            else
                this._tabs[m.id].remove_style_class_name('selected');
        }
        this._entry.hint_text = MODES.find(m => m.id === this._mode).hint;
        this._updateFooter();
    }

    _parsed() {
        const text = this._entry.get_text().trim();
        return text ? parseWhen(text, new Date()) : null;
    }

    _updateFooter() {
        if (!this._overlay)
            return;
        const left = this._footerLeft;
        left.destroy_all_children();
        if (this._mode === 'jira') {
            this._updateJiraFooter(left);
            return;
        }
        if (this._mode === 'task') {
            this._updateTaskFooter(left);
            return;
        }
        this._setKeys([['Enter', 'guardar'], ['Esc', 'cerrar']]);
        if (this._mode === 'note') {
            left.add_child(lbl('Se guarda en Notas, en el menú de Kaito', 'kaito-capture-muted'));
            return;
        }
        const p = this._parsed();
        left.add_child(new St.Icon({
            icon_name: 'alarm-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER,
            style_class: p ? 'kaito-capture-clock' : 'kaito-capture-clock-off',
        }));
        if (!p) {
            left.add_child(lbl('Añade cuándo: «en 20 min», «a las 17:30», «mañana»',
                'kaito-capture-muted'));
            return;
        }
        left.add_child(lbl(p.label, 'kaito-capture-when'));
        if (p.clean)
            left.add_child(lbl(`· ${p.clean}`, 'kaito-capture-muted kaito-capture-clean'));
    }

    _flashWarning() {
        if (this._warnId)
            GLib.source_remove(this._warnId);
        this._footerEl.add_style_class_name('warn');
        this._warnId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._warnId = 0;
            this._footerEl?.remove_style_class_name('warn');
            return GLib.SOURCE_REMOVE;
        });
    }

    _save() {
        const text = this._entry.get_text().trim();
        if (!text)
            return;
        if (this._mode === 'jira') {
            this._jiraDraft(text);
            return;
        }
        if (this._mode === 'task') {
            this._taskReview(text);
            return;
        }
        try {
            if (this._mode === 'note') {
                addNote(text);
            } else {
                const p = parseWhen(text, new Date());
                if (!p) {
                    this._flashWarning();
                    return;
                }
                addReminder(p.clean || text, p.date);
            }
        } catch (e) {
            console.error(`kaito: no se pudo guardar: ${e.message}`);
            this._flashWarning();
            return;
        }
        this.close();
        this._onSaved?.();
    }

    // --- Modo Jira: texto libre → borrador con IA → revisión → crear ---

    _soup() {
        this._session ??= new Soup.Session({timeout: 20});
        return this._session;
    }

    _stopJiraWork() {
        this._cancel?.cancel();
        this._cancel = null;
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _updateJiraFooter(left) {
        const j = this._jira;
        const muted = t => left.add_child(lbl(t, 'kaito-capture-muted'));
        switch (j.stage) {
        case 'drafting':
            this._setKeys([['Esc', 'cancelar']]);
            left.add_child(new St.Icon({icon_name: 'content-loading-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
            muted(`Redactando… ${j.elapsed ?? 0} s`);
            break;
        case 'creating':
            this._setKeys([]);
            muted('Creando en Jira…');
            break;
        case 'review': {
            this._setKeys([['Enter', 'crear en Jira'], ['Esc', 'descartar']]);
            if (j.error) {
                left.add_child(this._errorLabel(j.error));
            } else {
                muted(j.ctx ? 'Se te asignará · Ctrl+1… cambia los campos' : 'Cargando datos de Jira…');
            }
            break;
        }
        default:
            this._setKeys([['Enter', 'redactar'], ['Esc', 'cerrar']]);
            if (j.error) {
                left.add_child(this._errorLabel(j.error));
            } else {
                muted('Describe el ticket. Enter para redactar con IA');
            }
        }
    }

    _errorLabel(text) {
        const l = new St.Label({text, style: ST_ERROR, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        l.clutter_text.line_wrap = true;
        l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return l;
    }

    _setEntryEnabled(on) {
        this._entry.clutter_text.editable = on;
        this._entry.opacity = on ? 255 : 130;
    }

    async _jiraDraft(text) {
        const j = this._jira;
        if (j.stage !== 'input')
            return;
        const gen = this._gen;
        j.stage = 'drafting';
        j.text = text;
        j.error = null;
        j.elapsed = 0;
        this._setEntryEnabled(false);
        this._cancel = new Gio.Cancellable();
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            j.elapsed++;
            this._updateFooter();
            return GLib.SOURCE_CONTINUE;
        });
        this._updateFooter();
        // Datos de Jira en paralelo a la IA (proyectos, tipos, campos).
        if (!j.prepared)
            j.prepared = this._jiraPrepare(null, gen);
        try {
            const draft = await draftWithClaude(text, {cancellable: this._cancel, timeoutS: DRAFT_TIMEOUT_S});
            if (gen !== this._gen || j !== this._jira || j.stage !== 'drafting')
                return;
            this._stopJiraWork();
            j.draft = draft;
            j.kind = draft.issuetype;
            j.priority = draft.priority;
            j.stage = 'review';
            j.error = j.ctx ? null : j.ctxError ?? null;
            this._showReview();
        } catch (e) {
            if (gen !== this._gen || j !== this._jira || j.stage !== 'drafting')
                return;
            this._stopJiraWork();
            console.error(`kaito: borrador Jira: ${e.message}`);
            j.stage = 'input';
            j.error = e.message;
            this._setEntryEnabled(true);
            this._entry.grab_key_focus();
            this._updateFooter();
        }
    }

    /** Proyecto por defecto, contexto del proyecto y valores de campos extra. */
    async _jiraPrepare(project, gen) {
        const j = this._jira;
        const cfg = readConfig();
        try {
            if (!j.projects) {
                let keys = [];
                try {
                    keys = (await fetchProjectStats(this._soup())).keys;
                } catch (e) {
                    console.error(`kaito: proyectos Jira: ${e.message}`);
                }
                const counted = projectCandidates(keys, null);
                const def = typeof cfg.jiraCreateProject === 'string' && cfg.jiraCreateProject
                    ? cfg.jiraCreateProject : counted[0] ?? DEFAULT_PROJECT;
                if (gen !== this._gen || j !== this._jira)
                    return;
                j.projects = projectCandidates(keys, def);
                j.project ??= def;
            }
            project ??= j.project;
            const ctx = await loadCreateContext(this._soup(), project);
            const fieldIds = [...new Set(Object.values(ctx.extras).flat().map(f => f.fieldId))];
            let stats = null;
            if (fieldIds.length) {
                try {
                    stats = await fetchProjectStats(this._soup(), fieldIds);
                } catch (_e) { /* sin estadísticas: primera opción */ }
            }
            if (gen !== this._gen || j !== this._jira || j.project !== project)
                return;
            const saved = cfg.jiraCreateFields?.[project] ?? {};
            j.extraSel = {};
            for (const f of Object.values(ctx.extras).flat()) {
                if (f.fieldId in j.extraSel)
                    continue;
                const ok = id => id && f.options.some(o => o.id === String(id));
                const used = stats ? mostUsedOption(stats.issues, project, f.fieldId) : null;
                j.extraSel[f.fieldId] = ok(saved[f.fieldId]) ? String(saved[f.fieldId])
                    : ok(used) ? used : f.options[0].id;
            }
            j.ctx = ctx;
            j.type = null;
            j.ctxError = null;
            if (j.stage === 'review')
                j.error = null;
        } catch (e) {
            if (gen !== this._gen || j !== this._jira)
                return;
            console.error(`kaito: contexto Jira: ${e.message}`);
            j.ctx = null;
            j.ctxError = e.message;
            if (j.stage === 'review')
                j.error = e.message;
        }
        if (j.stage === 'review') {
            this._refreshChips();
            this._updateFooter();
        }
    }

    _currentType() {
        const j = this._jira;
        if (!j.ctx)
            return null;
        j.type ??= matchIssueType(j.kind, j.ctx.types);
        return j.type;
    }

    _showReview() {
        const j = this._jira;
        this._entry.hide();
        const review = new St.BoxLayout({vertical: true, x_expand: true});
        this._review = review;

        this._sumEntry = new St.Entry({
            style_class: 'kaito-capture-entry', style: ST_SUMMARY, can_focus: true, x_expand: true,
            text: j.draft.summary, hint_text: 'Resumen del ticket',
        });
        this._sumEntry.clutter_text.connect('activate', () => this._jiraCreate());
        review.add_child(this._sumEntry);

        if (j.draft.description) {
            const desc = new St.Label({style: ST_DESC, x_expand: true});
            desc.clutter_text.line_wrap = true;
            desc.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            desc.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            desc.clutter_text.set_markup(descMarkup(j.draft.description));
            const inner = new St.BoxLayout({vertical: true, x_expand: true});
            inner.add_child(desc);
            review.add_child(new St.ScrollView({
                style: ST_DESC_SCROLL, child: inner, x_expand: true,
                hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
            }));
        }

        this._chipsBox = new St.BoxLayout({style: ST_CHIPS, x_expand: true});
        review.add_child(this._chipsBox);
        this._card.insert_child_above(review, this._entry);
        this._refreshChips();
        this._updateFooter();
        this._sumEntry.grab_key_focus();
        this._sumEntry.clutter_text.set_cursor_position(-1);
    }

    _chip(title, value, onClick) {
        const box = new St.BoxLayout({style: 'spacing: 6px;'});
        box.add_child(lbl(title, 'kaito-capture-muted'));
        box.add_child(lbl(value));
        const btn = new St.Button({style: ST_CHIP, child: box, can_focus: false, reactive: !!onClick, track_hover: true});
        btn.connect('notify::hover', () => {
            btn.style = btn.hover ? ST_CHIP_HOVER : ST_CHIP;
        });
        if (onClick)
            btn.connect('clicked', onClick);
        this._chipsBox.add_child(btn);
    }

    _refreshChips() {
        const j = this._jira;
        if (!this._chipsBox || j.stage !== 'review')
            return;
        this._chipsBox.destroy_all_children();
        const cycle = (list, cur) => list[(Math.max(0, list.indexOf(cur)) + 1) % list.length];
        const actions = [];
        const add = (title, value, fn) => {
            this._chip(title, value, fn);
            actions.push(fn);
        };

        add('Proyecto', j.project ?? '…', () => {
            if (!j.projects || j.projects.length < 2)
                return;
            j.project = cycle(j.projects, j.project);
            j.ctx = null;
            j.type = null;
            j.error = null;
            this._jiraPrepare(j.project, this._gen);
            this._refreshChips();
            this._updateFooter();
        });

        const type = this._currentType();
        if (type) {
            const types = j.ctx.types.filter(t => !t.subtask);
            add('Tipo', type.name, () => {
                j.type = cycle(types, types.find(t => t.id === j.type.id));
                this._refreshChips();
            });
        } else {
            add('Tipo', j.kind, () => {
                j.kind = cycle(KINDS, j.kind);
                this._refreshChips();
            });
        }

        add('Prioridad', PRIORITY_ES[j.priority] ?? j.priority, () => {
            j.priority = cycle(PRIORITIES, j.priority);
            this._refreshChips();
        });

        for (const f of type ? j.ctx.extras[type.id] ?? [] : []) {
            const ids = f.options.map(o => o.id);
            const cur = j.extraSel?.[f.fieldId] ?? ids[0];
            add(f.name, f.options.find(o => o.id === cur)?.value ?? '?', () => {
                j.extraSel[f.fieldId] = cycle(ids, cur);
                this._refreshChips();
            });
        }
        this._chipActions = actions;
    }

    _jiraBackToInput() {
        const j = this._jira;
        this._gen++;
        this._stopJiraWork();
        this._review?.destroy();
        this._review = this._sumEntry = this._chipsBox = null;
        this._chipActions = null;
        // Se conserva lo ya cargado (proyectos y contexto), pero no el borrador.
        this._jira = {stage: 'input', projects: j.projects, project: j.project};
        this._entry.show();
        this._setEntryEnabled(true);
        this._entry.grab_key_focus();
        this._updateFooter();
    }

    async _jiraCreate() {
        const j = this._jira;
        if (j?.stage !== 'review')
            return;
        const summary = this._sumEntry.get_text().replace(/\s+/g, ' ').trim();
        if (!summary) {
            this._flashWarning();
            return;
        }
        const gen = this._gen;
        j.stage = 'creating';
        j.error = null;
        this._sumEntry.clutter_text.editable = false;
        this._updateFooter();
        const project = j.project ?? DEFAULT_PROJECT;
        try {
            j.ctx ??= await loadCreateContext(this._soup(), project);
            if (gen !== this._gen)
                return;
            const issueType = this._currentType();
            if (!issueType)
                throw new Error(`El proyecto ${project} no tiene tipos de ticket disponibles`);
            const extras = {};
            const sel = {};
            for (const f of j.ctx.extras[issueType.id] ?? []) {
                const id = j.extraSel?.[f.fieldId] ?? f.options[0].id;
                extras[f.fieldId] = fieldValue(f, id);
                sel[f.fieldId] = id;
            }
            const {key, url} = await createIssue(this._soup(), {
                project, summary, description: j.draft.description, issueType,
                priorityName: j.priority, extras,
            });
            try {
                const cfgFields = readJson(CONFIG_PATH, {})?.jiraCreateFields;
                updateConfig({
                    jiraCreateProject: project,
                    jiraCreateFields: {...cfgFields && typeof cfgFields === 'object' ? cfgFields : {}, [project]: sel},
                });
            } catch (e) {
                console.error(`kaito: no se pudo guardar jiraCreateProject: ${e.message}`);
            }
            try {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, url);
            } catch (_e) { /* sin portapapeles */ }
            // Los tickets nacen en "Por Asignar": pasarlos a "Por Hacer <Departamento>". Si falla, el ticket ya existe.
            const dept = (j.ctx.extras[issueType.id] ?? []).map(f =>
                /departament/i.test(f.name) ? f.options.find(o => o.id === sel[f.fieldId])?.value : null).find(Boolean) ?? '';
            let msg = `${key} creado: ${summary}`;
            try {
                const r = await moveToReady(this._soup(), key, dept, readyRegex(readJson(CONFIG_PATH, {})?.jiraCreateStatus));
                msg = r.ready ? `${key} creado en ${r.status}: ${summary}` : `${key} creado (sigue en ${r.status})`;
            } catch (e) {
                console.warn(`kaito: mover ${key} a Por Hacer: ${e.message}`);
                msg = `${key} creado · no se pudo mover a Por Hacer: ${e.message}`;
            }
            Main.notify('Kaito', msg);
            if (gen === this._gen)
                this.close();
        } catch (e) {
            if (gen !== this._gen || j !== this._jira)
                return;
            console.error(`kaito: crear ticket: ${e.message}`);
            j.stage = 'review';
            j.error = e.message;
            this._sumEntry.clutter_text.editable = true;
            this._refreshChips();
            this._updateFooter();
            this._sumEntry.grab_key_focus();
        }
    }

    // --- Modo Tarea: texto libre → cuándo + qué → revisión (nombre, carpeta, herramientas) → guardar ---

    _updateTaskFooter(left) {
        const t = this._task;
        if (t.stage === 'review') {
            this._setKeys([['Enter', 'guardar'], ['Esc', 'volver']]);
            left.add_child(lbl('Ctrl+1… cambia los campos · Claude sonnet, máx. 10 min', 'kaito-capture-muted'));
            return;
        }
        this._setKeys([['Enter', 'revisar'], ['Esc', 'cerrar']]);
        const text = this._entry.get_text().trim();
        if (!text) {
            left.add_child(lbl('Claude la ejecutará solo, con permisos de lectura', 'kaito-capture-muted'));
            return;
        }
        const p = parseSchedule(text, new Date());
        left.add_child(new St.Icon({
            icon_name: p ? 'media-playlist-repeat-symbolic' : 'alarm-symbolic', icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER, style_class: p ? 'kaito-capture-clock' : 'kaito-capture-clock-off',
        }));
        if (!p) {
            left.add_child(this._errorLabel(TASK_NO_WHEN));
            return;
        }
        left.add_child(lbl(p.label, 'kaito-capture-when'));
        if (p.clean)
            left.add_child(lbl(`· ${p.clean}`, 'kaito-capture-muted kaito-capture-clean'));
    }

    _taskReview(text) {
        const t = this._task;
        if (t.stage !== 'input')
            return;
        const now = new Date();
        const p = parseSchedule(text, now);
        const next = p ? nextRun(p.rule, now) : null;
        if (!p || !next) {
            this._flashWarning();
            return;
        }
        const prompt = p.clean || text;
        const key = extractKey(prompt);
        const cfg = readConfig();
        const home = GLib.get_home_dir();
        const def = resolveCwd(key, cfg, home, d => GLib.file_test(d, GLib.FileTest.IS_DIR));
        let repos = [];
        try {
            repos = collectRepos(30, REPO_CHOICES).map(r => r.path);
        } catch (e) {
            console.warn(`kaito: repos: ${e.message}`);
        }
        const summary = key ? this._issueSummary(key) ?? '' : '';
        Object.assign(t, {
            stage: 'review', text, prompt, key, rule: p.rule, label: p.label, next,
            cwds: [...new Set([def, ...repos, home])], cwd: def,
            tools: suggestTools(`${prompt} ${summary}`, !!key),
        });
        this._entry.hide();
        const review = new St.BoxLayout({vertical: true, x_expand: true});
        this._review = review;
        this._sumEntry = new St.Entry({
            style_class: 'kaito-capture-entry', style: ST_SUMMARY, can_focus: true, x_expand: true,
            text: taskName(key ? prompt.replace(/^\s*[A-Z][A-Z0-9_]*-\d+\s*[:,-]?\s*/, `${key} `) : prompt),
            hint_text: 'Nombre de la tarea',
        });
        this._sumEntry.clutter_text.connect('activate', () => this._taskSave());
        review.add_child(this._sumEntry);
        const when = new St.BoxLayout({style: 'spacing: 8px; padding: 0 24px 4px 24px;'});
        when.add_child(new St.Icon({icon_name: 'media-playlist-repeat-symbolic', icon_size: 16,
            style_class: 'kaito-capture-clock', y_align: Clutter.ActorAlign.CENTER}));
        when.add_child(lbl(p.label, 'kaito-capture-when'));
        when.add_child(lbl(`· próxima: ${nextLabel(next, now)}`, 'kaito-capture-muted'));
        review.add_child(when);
        const desc = new St.Label({style: `${ST_DESC} padding: 2px 24px 0 24px;`, x_expand: true, text: prompt});
        desc.clutter_text.line_wrap = true;
        desc.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        desc.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        review.add_child(desc);
        this._chipsBox = new St.BoxLayout({style: ST_CHIPS, x_expand: true});
        review.add_child(this._chipsBox);
        this._card.insert_child_above(review, this._entry);
        this._refreshTaskChips();
        this._updateFooter();
        this._sumEntry.grab_key_focus();
        this._sumEntry.clutter_text.set_cursor_position(-1);
    }

    _refreshTaskChips() {
        const t = this._task;
        if (!this._chipsBox || t?.stage !== 'review')
            return;
        this._chipsBox.destroy_all_children();
        const cycle = (list, cur) => list[(Math.max(0, list.indexOf(cur)) + 1) % list.length];
        const actions = [];
        const add = (title, value, fn) => {
            this._chip(title, value, fn);
            actions.push(fn ?? (() => {}));
        };
        add('Carpeta', tilde(t.cwd), () => {
            t.cwd = cycle(t.cwds, t.cwd);
            this._refreshTaskChips();
        });
        add('Herramientas', TOOLS_LABEL[t.tools], () => {
            t.tools = cycle(TOOLS, t.tools);
            this._refreshTaskChips();
        });
        if (t.key)
            add('Ticket', t.key, null);
        this._chipActions = actions;
    }

    _taskBackToInput() {
        this._review?.destroy();
        this._review = this._sumEntry = this._chipsBox = null;
        this._chipActions = null;
        this._task = {stage: 'input'};
        this._entry.show();
        this._entry.grab_key_focus();
        this._entry.clutter_text.set_cursor_position(-1);
        this._updateFooter();
    }

    _taskSave() {
        const t = this._task;
        if (t?.stage !== 'review')
            return;
        const name = this._sumEntry.get_text().replace(/\s+/g, ' ').trim();
        if (!name) {
            this._flashWarning();
            return;
        }
        let task;
        try {
            task = newTask({name, prompt: t.prompt, cwd: t.cwd, rule: t.rule, tools: t.tools, key: t.key}, new Date());
            if (!task.nextRun)
                throw new Error('la fecha ya ha pasado');
            addTask(task);
        } catch (e) {
            console.error(`kaito: no se pudo guardar la tarea: ${e.message}`);
            this._flashWarning();
            return;
        }
        Main.notify('Kaito', `Tarea «${name}» programada · próxima: ${nextLabel(new Date(task.nextRun))}`);
        this.close();
        this._onSaved?.();
    }
}
