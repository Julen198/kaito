// Ejecutar: node when.test.js
import assert from 'node:assert/strict';
import {parseWhen, shortLabel, parseRecurrence, parseSchedule, nextRun, ruleLabel, nextLabel} from './when.js';

const now = new Date(2026, 10, 18, 13, 40, 0); // miércoles 18 nov 2026, 13:40
const iso = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
const t = (txt, when, clean, label) => {
    const r = parseWhen(txt, now);
    assert.ok(r, `sin resultado: ${txt}`);
    assert.equal(iso(r.date), when, `fecha: ${txt}`);
    assert.equal(r.clean, clean, `clean: ${txt}`);
    if (label)
        assert.equal(r.label, label, `label: ${txt}`);
};

t('llamar a Iker en 20 min', '2026-11-18 14:00', 'llamar a Iker', 'Hoy a las 14:00 (en 20 min)');
t('en 2 horas comer', '2026-11-18 15:40', 'comer');
t('en media hora café', '2026-11-18 14:10', 'café');
t('en 1 h estirar', '2026-11-18 14:40', 'estirar');
t('Revisar PR mañana a las 9', '2026-11-19 9:00', 'Revisar PR', 'Mañana a las 09:00');
t('mañana', '2026-11-19 9:00', '');
t('pasado mañana a las 18:30 cena', '2026-11-20 18:30', 'cena', 'Pasado mañana a las 18:30');
t('standup a las 17:30', '2026-11-18 17:30', 'standup', 'Hoy a las 17:30 (en 3 h 50 min)');
t('gimnasio a las 9', '2026-11-19 9:00', 'gimnasio'); // ya pasó: mañana
t('hoy a las 20 sacar basura', '2026-11-18 20:00', 'sacar basura');
t('a las 5 y media pan', '2026-11-19 5:30', 'pan');
t('reunión el lunes a las 10', '2026-11-23 10:00', 'reunión', 'Lunes 23 a las 10:00');
t('lunes', '2026-11-23 9:00', '');
t('el miércoles a las 15 dentista', '2026-11-18 15:00', 'dentista'); // hoy es miércoles y aún no son las 15
t('el miércoles a las 9 dentista', '2026-11-25 9:00', 'dentista'); // ya pasó: la semana próxima
t('a las 9 de la noche peli', '2026-11-18 21:00', 'peli');
t('a las 3 de la tarde', '2026-11-18 15:00', '');
t('a las 10 menos cuarto', '2026-11-19 9:45', '');

assert.equal(parseWhen('comprar leche', now), null);
assert.equal(parseWhen('hoy sin hora', now), null);
assert.equal(parseWhen('a las 25', now), null);
assert.equal(parseWhen('', now), null);

assert.equal(shortLabel(new Date(2026, 10, 18, 17, 30), now), 'hoy 17:30');
assert.equal(shortLabel(new Date(2026, 10, 19, 9, 0), now), 'mañana 09:00');
assert.equal(shortLabel(new Date(2026, 10, 23, 10, 0), now), 'lun 23 10:00');

// --- Recurrencias (tareas programadas) ---
const rec = (txt, rule, clean) => {
    const r = parseRecurrence(txt, now);
    assert.ok(r, `sin recurrencia: ${txt}`);
    assert.deepEqual(r.rule, rule, `regla: ${txt}`);
    assert.equal(r.clean, clean, `clean: ${txt}`);
    return r;
};
rec('todos los días a las 9 mira el correo', {kind: 'daily', hour: 9, minute: 0}, 'mira el correo');
rec('cada día a las 9:30 revisa', {kind: 'daily', hour: 9, minute: 30}, 'revisa');
rec('cada dia a las 7 y media x', {kind: 'daily', hour: 7, minute: 30}, 'x');
assert.equal(rec('cada lunes a las 9 revisa en BigQuery las ventas de la semana pasada', {kind: 'weekly', days: [1], hour: 9, minute: 0},
    'revisa en BigQuery las ventas de la semana pasada').label, 'Cada lunes a las 09:00');
rec('todos los martes a las 10 x', {kind: 'weekly', days: [2], hour: 10, minute: 0}, 'x');
rec('todos los lunes y jueves a las 18 x', {kind: 'weekly', days: [1, 4], hour: 18, minute: 0}, 'x');
rec('todos los sábados a las 11 x', {kind: 'weekly', days: [6], hour: 11, minute: 0}, 'x');
rec('cada miércoles x', {kind: 'weekly', days: [3], hour: 9, minute: 0}, 'x');
rec('de lunes a viernes a las 8 standup', {kind: 'weekdays', hour: 8, minute: 0}, 'standup');
assert.equal(rec('cada hora mira logs', {kind: 'hourly'}, 'mira logs').label, 'Cada hora');
assert.equal(rec('cada 2 horas x', {kind: 'interval', minutes: 120}, 'x').label, 'Cada 2 horas');
rec('cada 30 minutos x', {kind: 'interval', minutes: 30}, 'x');
rec('cada 5 min x', {kind: 'interval', minutes: 15}, 'x'); // mínimo 15
assert.equal(rec('el día 1 de cada mes a las 10 factura', {kind: 'monthly', day: 1, hour: 10, minute: 0}, 'factura').label,
    'El día 1 de cada mes a las 10:00');
rec('el 31 de cada mes a las 9 x', {kind: 'monthly', day: 31, hour: 9, minute: 0}, 'x');
assert.equal(parseRecurrence('revisa las ventas', now), null);
assert.equal(parseRecurrence('mañana a las 10 x', now), null);
assert.equal(parseRecurrence('', now), null);

// nextRun: siempre estrictamente después de `after`
const nr = (rule, after) => iso(nextRun(rule, after));
assert.equal(nr({kind: 'daily', hour: 9, minute: 30}, now), '2026-11-19 9:30');
assert.equal(nr({kind: 'daily', hour: 14, minute: 0}, now), '2026-11-18 14:00');
assert.equal(nr({kind: 'daily', hour: 13, minute: 40}, now), '2026-11-19 13:40'); // igual que ahora: siguiente
assert.equal(nr({kind: 'weekly', days: [1], hour: 9, minute: 0}, now), '2026-11-23 9:00');
assert.equal(nr({kind: 'weekly', days: [3], hour: 9, minute: 0}, now), '2026-11-25 9:00'); // miércoles ya pasado
assert.equal(nr({kind: 'weekly', days: [3], hour: 15, minute: 0}, now), '2026-11-18 15:00');
assert.equal(nr({kind: 'weekdays', hour: 8, minute: 0}, new Date(2026, 10, 20, 9, 0)), '2026-11-23 8:00'); // viernes → lunes
assert.equal(nr({kind: 'hourly'}, now), '2026-11-18 14:00');
assert.equal(nr({kind: 'interval', minutes: 120}, now), '2026-11-18 15:40');
assert.equal(nr({kind: 'interval', minutes: 1}, now), '2026-11-18 13:55');
assert.equal(nr({kind: 'monthly', day: 1, hour: 10, minute: 0}, now), '2026-12-1 10:00');
assert.equal(nr({kind: 'monthly', day: 31, hour: 9, minute: 0}, new Date(2027, 1, 2)), '2027-2-28 9:00'); // febrero: último día
assert.equal(nr({kind: 'monthly', day: 18, hour: 15, minute: 0}, now), '2026-11-18 15:00');
assert.equal(nextRun({kind: 'once', at: new Date(2026, 10, 18, 10).toISOString()}, now), null);
assert.equal(nr({kind: 'once', at: new Date(2026, 10, 19, 10).toISOString()}, now), '2026-11-19 10:00');
assert.equal(nextRun({kind: 'nope'}, now), null);

// Una sola vez: parseSchedule cae a parseWhen
const once = parseSchedule('mañana a las 10 revisa RUN-12326 que las carreras virtuales se generan bien', now);
assert.equal(once.once, true);
assert.equal(once.rule.kind, 'once');
assert.equal(iso(new Date(once.rule.at)), '2026-11-19 10:00');
assert.equal(once.clean, 'revisa RUN-12326 que las carreras virtuales se generan bien');
assert.equal(parseSchedule('en 2 horas mira x', now).rule.kind, 'once');
assert.equal(parseSchedule('cada lunes a las 9 x', now).once, false);
assert.equal(parseSchedule('revisa x', now), null);
assert.match(ruleLabel({kind: 'once', at: new Date(2026, 10, 20, 9).toISOString()}), /^Una vez: viernes 20 a las 09:00$/);
assert.equal(nextLabel(new Date(2026, 10, 23, 9, 0), now), 'lun 09:00');
assert.equal(nextLabel(new Date(2026, 10, 19, 9, 0), now), 'mañana 09:00');
assert.equal(nextLabel(new Date(2026, 11, 1, 10, 0), now), 'mar 1 10:00');

// Cambio de hora (Europa/Madrid): 29 mar 2026 02:00 → 03:00; 25 oct 2026 03:00 → 02:00.
if (new Date(2026, 2, 29, 12).getTimezoneOffset() !== new Date(2026, 2, 28, 12).getTimezoneOffset()) {
    assert.equal(nr({kind: 'daily', hour: 9, minute: 0}, new Date(2026, 2, 28, 10)), '2026-3-29 9:00');
    assert.equal(nr({kind: 'daily', hour: 9, minute: 0}, new Date(2026, 9, 24, 10)), '2026-10-25 9:00');
    assert.equal(nr({kind: 'daily', hour: 2, minute: 30}, new Date(2026, 2, 28, 10)), '2026-3-29 3:30'); // hora inexistente
    assert.equal(nr({kind: 'hourly'}, new Date(2026, 2, 29, 1, 10)), '2026-3-29 3:00');
    assert.equal(nr({kind: 'weekly', days: [1], hour: 9, minute: 0}, new Date(2026, 2, 27, 10)), '2026-3-30 9:00');
    console.log('when.test.js: cambio de hora comprobado');
} else {
    console.log('when.test.js: zona sin cambio de hora (usa TZ=Europe/Madrid para probarlo)');
}
console.log('when.test.js: OK');
