// Tour de bienvenida del menú: pasos (textos aprobados en la maqueta) y qué pasos tocan según lo que se ve.
// Lógica pura (sin imports de gi ni de la shell): se prueba con node y gjs (tour.test.js). La parte visual
// (burbuja, resaltado, grab) está en tourui.js.

const G = '#2ec27e', O = '#e66100', B = '#1c71d8', P = '#9141ac';
/** Atajo de la captura con el que están escritos los textos; se cambia por el configurado. */
export const DEFAULT_ACCEL = 'Ctrl+Alt+Espacio';

export const WELCOME = {
    title: 'Kaito ya está en tu barra',
    text: 'Tus agentes, tickets, pendientes, recordatorios y notas en un solo menú. Te enseñamos para qué sirve cada zona y qué puedes hacer en ella; son un par de minutos.',
    skip: 'Ahora no', go: 'Ver el tour',
};
export const DONE_NOTE = 'Listo. Puedes repetir el tour desde Ajustes.';

/** Pasos en el orden del menú. `board` y `kanban` son variantes de la misma zona (Jira o tablero propio). */
export const STEPS = {
    usage: {title: 'Uso de tus IAs', text: 'Un anillo por cada herramienta que tienes instalada: Claude, Codex, OpenCode o Gemini.',
        points: [
            {c: B, b: 'Anillo lleno:', t: 'cuánto llevas gastado del límite de 5 horas y de la semana.'},
            {c: O, b: 'Naranja o rojo:', t: 'te queda poco; mejor deja lo pesado para luego.'},
            {c: P, b: 'A la derecha', t: 'ves a qué hora se reinicia el límite («reinicia 14:50»).'},
        ]},
    agents: {title: 'Agentes', text: 'Cada sesión de Claude Code, Codex u otro agente que tengas abierta, en el repo donde trabaja.',
        points: [
            {c: G, b: 'Verde que parpadea:', t: 'está trabajando. No tienes que mirar la terminal.'},
            {c: O, b: 'Naranja:', t: 'te pide permiso o te pregunta algo. Respóndele desde aquí sin cambiar de ventana.'},
            {c: B, b: 'Púlsalo', t: 'para saltar a su pestaña de la terminal.'},
            {c: P, b: 'Al terminar', t: 'deja commit y push en la rama del ticket, te avisa en pantalla y crea un recordatorio para revisarlo.'},
        ]},
    board: {title: 'Tus tickets de Jira', text: 'Ordenados por estado y prioridad, con las mismas flechas que en Jira.',
        points: [
            {c: B, b: 'Pestañas:', t: 'Mías, Sin asignar (con «Asignarme»), Sprint y Recientes.'},
            {c: G, b: '▶ Mandar a Claude:', t: 'eliges el repo y Claude empieza con todo el contexto del ticket. Si ya hay una rama del ticket, sigue en ella.'},
            {c: O, b: 'La flecha', t: 'despliega el ticket completo; desde ahí cambias su estado o lo abres en Jira.'},
        ]},
    kanban: {title: 'Tu tablero', text: 'Sin Jira, Kaito te da un tablero propio con tareas K-1, K-2… y sus estados.',
        points: [
            {c: B, b: 'Crea tareas', t: 'desde aquí o con «kaito kanban» en la terminal.'},
            {c: G, b: '▶ Mandar a Claude:', t: 'igual que con Jira: repo, rama propia, commit y push al terminar.'},
            {c: O, b: 'Muévelas', t: 'de Por hacer a En curso y Hecho; Kaito las mueve solo cuando el agente acaba.'},
        ]},
    todos: {title: 'Pendientes', text: 'Una lista de cosas por hacer, sin fecha.',
        points: [
            {c: G, b: 'Márcalas', t: 'cuando las acabes y desaparecen.'},
            {c: B, b: 'Para cosas con hora,', t: 'mejor un recordatorio.'},
        ]},
    reminders: {title: 'Recordatorios', text: 'Te avisan con una tarjeta en pantalla a la hora que digas.',
        points: [
            {c: B, b: 'Escríbelos normal:', t: '«llamar a Iker en 20 min», «revisar deploy el lunes a las 10».'},
            {c: O, b: 'Posponer:', t: '15 min, 30 min, 1 h, 3 h o mañana a las 9.'},
            {c: P, b: 'Con No molestar', t: 'activo o fuera de tu horario, se guardan y te llegan después.'},
        ]},
    tasks: {title: 'Tareas programadas', text: 'Claude hace una revisión por su cuenta cada cierto tiempo y te avisa del resultado.',
        points: [
            {c: B, b: 'Ejemplo:', t: '«cada lunes a las 9 revisa en BigQuery las ventas de la semana».'},
            {c: G, b: 'Solo lectura:', t: 'puede consultar, nunca cambiar nada.'},
            {c: O, b: 'Ligadas a un ticket:', t: 'útil para comprobar unos días después que un cambio funciona.'},
        ]},
    notes: {title: 'Notas', text: 'Para apuntar algo rápido sin abrir otra aplicación.',
        points: [
            {c: B, b: 'Se quedan aquí', t: 'hasta que las borres.'},
            {c: G, b: 'Desde cualquier sitio:', t: 'Ctrl+Alt+Espacio y escribes.'},
        ]},
    create: {title: 'Crear desde cualquier sitio', text: 'Ctrl+Alt+Espacio abre una caja encima de lo que estés haciendo.',
        points: [
            {c: B, b: 'Cuatro pestañas:', t: 'Nota, Recordatorio, Jira y Tarea.'},
            {c: G, b: 'En Jira', t: 'describes el problema con tus palabras y la IA redacta el ticket por ti.'},
            {c: O, b: 'Los ejemplos de fondo', t: 'te enseñan cómo escribir cada cosa.'},
        ]},
    settings: {title: 'Ajustes', text: 'Para dejar Kaito a tu manera.',
        points: [
            {c: B, b: 'Encender o apagar:', t: 'Jira, el tablero, el panel de notificaciones y cada agente detectado.'},
            {c: O, b: 'No molestar:', t: 'pon tu horario de trabajo y fuera de él Kaito se calla.'},
            {c: P, b: 'Repetir este tour', t: 'cuando quieras.'},
        ]},
};
export const ORDER = ['usage', 'agents', 'board', 'todos', 'reminders', 'tasks', 'notes', 'create', 'settings'];

/**
 * Cambia el atajo de los textos por el configurado. Sin atajo: "el atajo de Kaito" (con mayúscula si `cap`
 * y el texto empieza por él: el párrafo, no los puntos, que siguen a la negrita).
 */
export function withAccel(s, accel, cap = false) {
    if (accel)
        return s.split(DEFAULT_ACCEL).join(accel);
    const out = s.split(DEFAULT_ACCEL).join('el atajo de Kaito');
    return cap && s.startsWith(DEFAULT_ACCEL) ? `E${out.slice(1)}` : out;
}

/**
 * Pasos del tour según lo que se ve en el menú. shown: {id: bool} por zona (usage, agents, todos, reminders,
 * tasks, notes, create, settings; lo que falte cuenta como visible); jira/kanban: Ajustes. La zona `board` es
 * Jira si está activado; si no, el tablero propio (que ocupa la zona de pendientes: entonces no hay paso
 * "Pendientes"). -> [{id, zone, n, total, title, text, points}]
 */
export function tourSteps({jira = true, kanban = false, shown = {}, accel = DEFAULT_ACCEL} = {}) {
    const out = [];
    for (const id of ORDER) {
        let key = id, zone = id;
        if (id === 'board') {
            if (jira) {
                zone = 'jira';
            } else if (kanban) {
                key = 'kanban';
                zone = 'todos';
            } else {
                continue;
            }
        } else if (id === 'todos' && !jira && kanban) {
            continue;
        }
        if (shown[zone] === false)
            continue;
        const s = STEPS[key];
        out.push({
            id: key, zone, title: s.title, text: withAccel(s.text, accel, true),
            points: s.points.map(p => ({c: p.c, b: withAccel(p.b, accel), t: withAccel(p.t, accel)})),
        });
    }
    return out.map((s, i) => ({...s, n: i + 1, total: out.length}));
}

/** Escapa texto para Pango markup. */
export const escapeMarkup = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "<b>Naranja:</b> te pide permiso…" (Pango) de un punto {b, t}. */
export const pointMarkup = p => `<b>${escapeMarkup(p.b)}</b> ${escapeMarkup(p.t)}`;
