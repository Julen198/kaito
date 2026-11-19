// Ejecutar: node quiet.test.js (o gjs -m quiet.test.js). Horas locales: prueba con TZ=Europe/Madrid para el DST.
import {
    parseHHMM, normalizeWorkHours, inWorkHours, nextWorkStart, isQuiet, quietLabel, untilTomorrow, queuePush,
    normalizeQueue, whenLabel, QUEUE_MAX,
} from './quiet.js';

let n = 0;
function eq(a, b, msg) {
    const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
    if (x !== y)
        throw new Error(`${msg}\n  esperado: ${y}\n  obtenido: ${x}`);
    n++;
}
const D = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi); // local
const ms = d => d.getTime();

// Horas
eq([parseHHMM('09:00'), parseHHMM('9:05'), parseHHMM('23:59'), parseHHMM('24:00'), parseHHMM('9h'), parseHHMM('')],
    [540, 545, 1439, null, null, null], 'parseHHMM');
eq(normalizeWorkHours(undefined), {enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00'}, 'por defecto');
eq(normalizeWorkHours({enabled: true, days: [7, 1, 1, 9, 'x', 3], start: '8:30', end: 'mal'}),
    {enabled: true, days: [1, 3, 7], start: '08:30', end: '18:00'}, 'saneado');

// 2026-11-16 es lunes; 2026-11-21 sábado.
const WH = {enabled: true, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00'};
eq(inWorkHours(D(2026, 11, 16, 9, 0), WH), true, 'lunes 09:00 dentro');
eq(inWorkHours(D(2026, 11, 16, 17, 59), WH), true, 'lunes 17:59 dentro');
eq(inWorkHours(D(2026, 11, 16, 18, 0), WH), false, 'lunes 18:00 fuera');
eq(inWorkHours(D(2026, 11, 16, 8, 59), WH), false, 'lunes 08:59 fuera');
eq(inWorkHours(D(2026, 11, 21, 12, 0), WH), false, 'sábado fuera');

// isQuiet por horario
let q = isQuiet(D(2026, 11, 16, 12, 0), {workHours: WH});
eq([q.quiet, q.reason], [false, null], 'en horario: sin silencio');
q = isQuiet(D(2026, 11, 20, 19, 0), {workHours: WH}); // viernes tarde
eq([q.quiet, q.reason, ms(q.until)], [true, 'schedule', ms(D(2026, 11, 23, 9, 0))], 'viernes 19:00 → lunes 09:00');
eq(quietLabel(q, D(2026, 11, 20, 19, 0)), 'Fuera de horario hasta lun 09:00', 'etiqueta fin de semana');
q = isQuiet(D(2026, 11, 17, 7, 0), {workHours: WH});
eq([q.reason, ms(q.until)], ['schedule', ms(D(2026, 11, 17, 9, 0))], 'martes 07:00 → hoy 09:00');
eq(quietLabel(q, D(2026, 11, 17, 7, 0)), 'Fuera de horario hasta las 09:00', 'etiqueta hoy');
eq(quietLabel(isQuiet(D(2026, 11, 17, 20, 0), {workHours: WH}), D(2026, 11, 17, 20, 0)),
    'Fuera de horario hasta mañana 09:00', 'etiqueta mañana');
eq(isQuiet(D(2026, 11, 21, 12, 0), {workHours: {...WH, enabled: false}}).quiet, false, 'horario desactivado');
eq(isQuiet(D(2026, 11, 21, 12, 0), {workHours: {...WH, days: []}}),
    {quiet: true, reason: 'schedule', until: null}, 'sin días: siempre fuera, sin fin');

// Tramo nocturno 22:00–06:00 (lunes a viernes por la noche)
const NIGHT = {enabled: true, days: [1, 2, 3, 4, 5], start: '22:00', end: '06:00'};
eq(inWorkHours(D(2026, 11, 16, 23, 0), NIGHT), true, 'noche: lunes 23:00 dentro');
eq(inWorkHours(D(2026, 11, 17, 5, 59), NIGHT), true, 'noche: martes 05:59 dentro (turno del lunes)');
eq(inWorkHours(D(2026, 11, 17, 6, 0), NIGHT), false, 'noche: martes 06:00 fuera');
eq(inWorkHours(D(2026, 11, 16, 3, 0), NIGHT), false, 'noche: lunes 03:00 fuera (domingo no trabaja)');
eq(inWorkHours(D(2026, 11, 21, 3, 0), NIGHT), true, 'noche: sábado 03:00 dentro (turno del viernes)');
eq(inWorkHours(D(2026, 11, 21, 23, 0), NIGHT), false, 'noche: sábado 23:00 fuera');
q = isQuiet(D(2026, 11, 17, 12, 0), {workHours: NIGHT});
eq([q.reason, ms(q.until)], ['schedule', ms(D(2026, 11, 17, 22, 0))], 'noche: mediodía → 22:00');
eq(inWorkHours(D(2026, 11, 16, 3, 0), {...WH, start: '00:00', end: '00:00'}), true, 'start=end: día entero');

// DST (Europa: 29-03-2026 02:00 → 03:00; 25-10-2026 03:00 → 02:00): las horas son locales.
const sat = D(2026, 3, 28, 20, 0);
eq(ms(nextWorkStart(sat, WH)), ms(D(2026, 3, 30, 9, 0)), 'DST primavera: lunes 09:00 local');
eq(nextWorkStart(sat, WH).getHours(), 9, 'DST primavera: sigue siendo a las 9');
eq(nextWorkStart(D(2026, 10, 24, 20, 0), WH).getHours(), 9, 'DST otoño: a las 9');
eq(isQuiet(D(2026, 3, 30, 9, 30), {workHours: WH}).quiet, false, 'lunes tras DST en horario');

// Manual
const now = D(2026, 11, 16, 12, 0);
q = isQuiet(now, {workHours: WH, dndManual: true});
eq([q.quiet, q.reason, q.until], [true, 'manual', null], 'manual sin límite');
eq(quietLabel(q, now), 'No molestar', 'etiqueta manual');
q = isQuiet(now, {dndManual: true, dndUntil: ms(now) + 3600e3});
eq([q.reason, ms(q.until)], ['manual', ms(now) + 3600e3], 'manual 1 h');
eq(quietLabel(q, now), 'No molestar hasta las 13:00', 'etiqueta 1 h');
eq(isQuiet(now, {dndManual: true, dndUntil: ms(now) - 1}).quiet, false, 'manual caducado');
eq(isQuiet(D(2026, 11, 16, 20, 0), {workHours: WH, dndManual: true, dndUntil: ms(now) - 1}).reason, 'schedule',
    'manual caducado: manda el horario');
// "Desactivar" fuera de horario: dndSkipUntil anula el horario hasta la próxima jornada
const eve = D(2026, 11, 16, 20, 0);
eq(isQuiet(eve, {workHours: WH, dndSkipUntil: ms(D(2026, 11, 17, 9, 0))}).quiet, false, 'skip anula el horario');
eq(isQuiet(eve, {workHours: WH, dndSkipUntil: ms(eve) - 1}).quiet, true, 'skip caducado');

// "Hasta mañana"
eq(ms(untilTomorrow(D(2026, 11, 16, 15, 0), WH)), ms(D(2026, 11, 17, 9, 0)), 'hasta mañana: martes 09:00');
eq(ms(untilTomorrow(D(2026, 11, 20, 15, 0), WH)), ms(D(2026, 11, 23, 9, 0)), 'hasta mañana desde viernes: lunes');
eq(ms(untilTomorrow(D(2026, 11, 17, 7, 0), WH)), ms(D(2026, 11, 18, 9, 0)), 'hasta mañana a las 7: mañana, no hoy');
eq(ms(untilTomorrow(D(2026, 11, 21, 15, 0), {days: []})), ms(D(2026, 11, 22, 9, 0)), 'sin días: mañana 09:00');
eq(whenLabel(D(2026, 11, 25, 9, 0), now), 'mié 09:00', 'whenLabel otro día');

// Cola: deduplicado, tope y saneado
let queue = [];
queue = queuePush(queue, {key: 'a', text: 'A', at: 1});
queue = queuePush(queue, {key: 'b', text: 'B', at: 2});
queue = queuePush(queue, {key: 'a', text: 'A2', at: 3});
eq(queue.map(x => `${x.key}:${x.text}`), ['b:B', 'a:A2'], 'mismo key: sustituye y pasa al final');
eq(queuePush(queue, {text: 'sin key'}), queue, 'sin key: se ignora');
for (let i = 0; i < 40; i++)
    queue = queuePush(queue, {key: `k${i}`, text: `t${i}`, at: 10 + i});
eq([queue.length, queue[0].key, queue.at(-1).key], [QUEUE_MAX, 'k10', 'k39'], 'tope: caen los más viejos');
eq(normalizeQueue([{key: 'x', text: 'X', at: 5}, null, 'basura', {key: 'x', text: 'X2', at: 6}, {key: 'y'}]),
    [{key: 'x', text: 'X2', at: 6}], 'normalizeQueue');
eq(normalizeQueue({no: 'lista'}), [], 'normalizeQueue: no es lista');

console.log(`quiet.test.js: ${n} comprobaciones OK`);
