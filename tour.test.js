// Ejecutar: node tour.test.js  (o gjs -m tour.test.js). Pasos del tour de bienvenida.
import {tourSteps, withAccel, pointMarkup, escapeMarkup, STEPS, ORDER, WELCOME, DONE_NOTE} from './tour.js';

let n = 0;
function eq(a, b, msg) {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
    if (x !== y)
        throw new Error(`${msg}\n  esperado: ${y}\n  obtenido: ${x}`);
    n++;
}

// Todo visible con Jira: 9 pasos en el orden del menú.
let s = tourSteps({jira: true, kanban: false});
eq(s.map(x => x.id), ['usage', 'agents', 'board', 'todos', 'reminders', 'tasks', 'notes', 'create', 'settings'], 'orden con Jira');
eq(s.map(x => x.zone), ['usage', 'agents', 'jira', 'todos', 'reminders', 'tasks', 'notes', 'create', 'settings'], 'zonas con Jira');
eq([s[0].n, s[0].total, s[8].n, s[8].total], [1, 9, 9, 9], 'numeración');
eq(s[2].title, 'Tus tickets de Jira', 'Jira');
eq(s[1].points.length, 4, 'agentes: 4 puntos');
eq(s[1].points[1], {c: '#e66100', b: 'Naranja:', t: 'te pide permiso o te pregunta algo. Respóndele desde aquí sin cambiar de ventana.'}, 'punto con color');

// Sin Jira y con tablero: "Tu tablero" ocupa la zona de pendientes y no hay paso "Pendientes".
s = tourSteps({jira: false, kanban: true});
eq(s.map(x => x.id), ['usage', 'agents', 'kanban', 'reminders', 'tasks', 'notes', 'create', 'settings'], 'sin Jira, con tablero');
eq([s[2].title, s[2].zone], ['Tu tablero', 'todos'], 'tablero en la zona de pendientes');
// Sin Jira ni tablero; con Jira y tablero.
eq(tourSteps({jira: false, kanban: false}).map(x => x.id).includes('board'), false, 'sin Jira ni tablero');
eq(tourSteps({jira: true, kanban: true}).map(x => x.id).slice(2, 4), ['board', 'todos'], 'Jira y tablero');

// Zonas ocultas se saltan (uso sin datos, sin tareas programadas).
s = tourSteps({jira: true, shown: {usage: false, tasks: false, jira: true}});
eq(s.map(x => x.id), ['agents', 'board', 'todos', 'reminders', 'notes', 'create', 'settings'], 'zonas ocultas');
eq(s[s.length - 1].total, 7, 'total sin las ocultas');
eq(tourSteps({jira: true, shown: {jira: false}}).some(x => x.id === 'board'), false, 'Jira oculto');

// Atajo configurado
s = tourSteps({accel: 'Super+N'});
const create = s.find(x => x.id === 'create'), notes = s.find(x => x.id === 'notes');
eq(create.text, 'Super+N abre una caja encima de lo que estés haciendo.', 'atajo en el texto');
eq(notes.points[1].t, 'Super+N y escribes.', 'atajo en el punto');
s = tourSteps({accel: ''});
eq(s.find(x => x.id === 'create').text, 'El atajo de Kaito abre una caja encima de lo que estés haciendo.', 'sin atajo: texto');
eq(s.find(x => x.id === 'notes').points[1].t, 'el atajo de Kaito y escribes.', 'sin atajo: punto');
eq(tourSteps().find(x => x.id === 'create').text.startsWith('Ctrl+Alt+Espacio'), true, 'atajo por defecto');
eq([withAccel('a Ctrl+Alt+Espacio b', 'X'), withAccel('nada', '')], ['a X b', 'nada'], 'withAccel');

// Markup
eq(escapeMarkup('a < b & c > d'), 'a &lt; b &amp; c &gt; d', 'escape');
eq(pointMarkup({b: 'Pestañas:', t: 'Mías & «Asignarme»'}), '<b>Pestañas:</b> Mías &amp; «Asignarme»', 'markup del punto');

// Textos completos
eq(ORDER.every(id => id === 'board' || STEPS[id]), true, 'todos los pasos tienen texto');
eq(Object.values(STEPS).every(x => x.title && x.text && x.points.length >= 2 && x.points.every(p => /^#[0-9a-f]{6}$/.test(p.c) && p.b && p.t)), true, 'pasos completos');
eq([WELCOME.title, WELCOME.skip, WELCOME.go, DONE_NOTE], ['Kaito ya está en tu barra', 'Ahora no', 'Ver el tour', 'Listo. Puedes repetir el tour desde Ajustes.'], 'bienvenida');

const msg = `tour.test.js: ${n} comprobaciones OK`;
if (typeof print === 'function')
    print(msg);
else
    console.log(msg);
