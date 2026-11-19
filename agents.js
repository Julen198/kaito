// Lógica pura (sin imports de Shell) para poder probarla con gjs/node.

const trunc = (s, n = 60) => {
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function actionFromMessage(entry) {
    const content = entry?.message?.content;
    if (typeof content === 'string')
        return trunc(content);
    if (!Array.isArray(content))
        return null;
    // Preferimos tool_use; si no hay, el último bloque de texto.
    const tool = content.findLast(b => b?.type === 'tool_use');
    if (tool)
        return trunc(`${tool.name}: ${tool.input?.description ?? tool.input?.command ?? ''}`);
    const text = content.findLast(b => b?.type === 'text' && b.text?.trim());
    return text ? trunc(text.text) : null;
}

const LAST_TEXT_MAX = 2000;

/** Último bloque de texto (no herramienta) de un mensaje del asistente, o null. */
function textFromMessage(entry) {
    const content = entry?.message?.content;
    if (typeof content === 'string')
        return content.trim() || null;
    if (!Array.isArray(content))
        return null;
    const text = content.findLast(b => b?.type === 'text' && b.text?.trim());
    return text ? text.text.trim() : null;
}

/**
 * Texto de la cola de un .jsonl → {cwd, lastAction, lastText}.
 * lastText: último texto del asistente (hasta LAST_TEXT_MAX caracteres), para resúmenes.
 */
export function parseTail(text) {
    const lines = text.split('\n');
    lines.shift(); // la primera línea puede estar cortada por el seek
    let cwd = null, lastAction = null, lastText = null;
    for (const line of lines.reverse()) {
        if (!line.trim())
            continue;
        let e;
        try { e = JSON.parse(line); } catch (_e) { continue; }
        if (!cwd && typeof e.cwd === 'string')
            cwd = e.cwd.split('/').filter(Boolean).pop() ?? e.cwd;
        if (!lastAction && e.type === 'assistant')
            lastAction = actionFromMessage(e);
        if (!lastText && e.type === 'assistant') {
            const t = textFromMessage(e);
            lastText = t ? t.slice(0, LAST_TEXT_MAX) : null;
        }
        if (cwd && lastAction && lastText)
            break;
    }
    return {cwd, lastAction, lastText};
}

// Ticket de Jira o tarea local del tablero (K-<n>, board.js localTaskPrompt).
const TICKET_RE = /^\s*Trabaja en (?:el ticket de Jira|la tarea) ([A-Z][A-Z0-9_]*-\d+)/;

/** Texto escrito por el usuario en una entrada `user` (sin tool_result), o null. */
function userText(e) {
    if (e?.type !== 'user' || e.isMeta)
        return null;
    const c = e.message?.content;
    if (typeof c === 'string')
        return c;
    if (!Array.isArray(c) || c.some(b => b?.type === 'tool_result'))
        return null;
    return c.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n') || null;
}

/**
 * Cabeza de un .jsonl → clave del ticket de Jira (o tarea K-<n>) si el primer mensaje del usuario es un
 * prompt de Kaito ("Trabaja en el ticket de Jira KEY: …" / "Trabaja en la tarea K-3: …"); null si es otro mensaje;
 * undefined si aún no hay mensaje del usuario (no cachear).
 */
export function ticketFromHead(text) {
    for (const line of String(text).split('\n')) {
        if (!line.includes('"user"'))
            continue;
        let e;
        try { e = JSON.parse(line); } catch (_e) { continue; }
        const t = userText(e);
        if (t === null)
            continue;
        return TICKET_RE.exec(t)?.[1] ?? null;
    }
    return undefined;
}

/** Puro. Primera línea no vacía de un texto, recortada a n caracteres. */
export function firstLine(text, n = 160) {
    const line = String(text ?? '').split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '';
    return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

export function ago(seconds) {
    if (seconds < 60) return `hace ${seconds}s`;
    return `hace ${Math.floor(seconds / 60)} min`;
}
