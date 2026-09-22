// ============================================================
// TEST-PRESENCIA.JS - Casos borde del semáforo de puntualidad
// ("Docentes que deberían presentarse hoy").
//
// Testea la función REAL que usa la app (calcularSemaforoPuntualidad,
// en presencia-logic.js - script.js la usa tal cual, sin copia
// paralela) para que no haya riesgo de que el test verifique una
// lógica distinta de la que corre en producción.
//
// Correr con: node test-presencia.js
// ============================================================
const { calcularSemaforoPuntualidad, CRITERIA_PUNTUALIDAD_DEFAULT, SEMAFORO_ORDEN, getTurnoPorHora, fichajeValidoParaClase } = require('./presencia-logic.js');

const criteria = CRITERIA_PUNTUALIDAD_DEFAULT; // { limitePresenteMin:15, limiteTardanzaMin:30, limiteMediaFaltaMin:60 }

console.log('Ventanas vigentes (CRITERIA_PUNTUALIDAD_DEFAULT):');
console.log(`  Presente:    0 a ${criteria.limitePresenteMin} min`);
console.log(`  Tardanza:    ${criteria.limitePresenteMin + 1} a ${criteria.limiteTardanzaMin} min`);
console.log(`  Media Falta: ${criteria.limiteTardanzaMin + 1} a ${criteria.limiteMediaFaltaMin} min`);
console.log(`  Ausente:     más de ${criteria.limiteMediaFaltaMin} min (o sin fichar, pasada esa ventana)`);
console.log('');

const casos = [
    { n: 1, caso: 'Ficha 5 min antes', elapsedMin: -5, yaFicho: true, esperado: 'presente' },
    { n: 2, caso: 'Ficha justo a tiempo', elapsedMin: 0, yaFicho: true, esperado: 'presente' },
    { n: 3, caso: 'Ficha 10 min tarde', elapsedMin: 10, yaFicho: true, esperado: 'presente' },
    { n: 4, caso: 'Ficha 20 min tarde', elapsedMin: 20, yaFicho: true, esperado: 'tardanza' },
    { n: 5, caso: 'Ficha 35 min tarde', elapsedMin: 35, yaFicho: true, esperado: 'media_falta' },
    // El pedido dice "90 min tarde (caso de la foto 20:00 -> 21:50)",
    // pero 20:00 a 21:50 son en realidad 110 min, no 90 - se testean
    // los dos valores por separado para no perder ninguno de los dos.
    { n: '6a', caso: 'Ficha 90 min tarde', elapsedMin: 90, yaFicho: true, esperado: 'ausente' },
    { n: '6b', caso: 'Caso foto: clase 20:00, ficha 21:50 (110 min tarde)', elapsedMin: 110, yaFicho: true, esperado: 'ausente' },
    { n: 7, caso: 'Ficha 120 min tarde', elapsedMin: 120, yaFicho: true, esperado: 'ausente' },
    { n: '8a', caso: 'No ficha, todavía dentro de la ventana (30 min, no llegó a 60)', elapsedMin: 30, yaFicho: false, esperado: 'esperado' },
    { n: '8b', caso: 'No ficha, se cumplió la ventana (61 min sin fichar)', elapsedMin: 61, yaFicho: false, esperado: 'ausente' },
    { n: '8c', caso: 'No ficha, todavía no llegó la hora de la clase', elapsedMin: null, yaFicho: false, esperado: 'esperado' },
];

function correr(casos) {
    return casos.map(c => {
        const r = calcularSemaforoPuntualidad(c.elapsedMin, criteria, c.yaFicho);
        return { ...c, obtenido: r.code, ok: r.code === c.esperado };
    });
}

const resultados = correr(casos);

// Caso 9: dos materias del mismo docente el mismo día (ej. "Docente
// DePrueba" con dos bloques a las 20:00 en años distintos) - no es un
// caso de calcularSemaforoPuntualidad en sí, es la reducción que hace
// getDocentesEsperadosHoyPorDocente() en script.js: un docente con
// varios bloques hoy cuenta UNA vez, con el PEOR semáforo del día.
// Se replica acá la misma reducción (mismo SEMAFORO_ORDEN) sobre dos
// bloques ficticios para confirmar que se queda con el peor.
const bloqueA = { teacherId: 1, semaforo: calcularSemaforoPuntualidad(10, criteria, true) };  // presente
const bloqueB = { teacherId: 1, semaforo: calcularSemaforoPuntualidad(70, criteria, true) };  // ausente
const peor = [bloqueA, bloqueB].sort((a, b) => SEMAFORO_ORDEN[a.semaforo.code] - SEMAFORO_ORDEN[b.semaforo.code])[0];
const caso9 = {
    n: 9, caso: 'Dos materias mismo docente mismo día (20:00 presente + 20:00 ausente) -> se queda con la peor',
    elapsedMin: 'A:10 / B:70', yaFicho: true, esperado: 'ausente', obtenido: peor.semaforo.code, ok: peor.semaforo.code === 'ausente',
};
resultados.push(caso9);

// Caso 10: ficha después de medianoche. calcularSemaforoPuntualidad
// en sí solo recibe minutos ya calculados y no tiene bug (120 min
// tarde da "ausente" sin importar si cruzó medianoche o no, ver caso
// 7). El problema real está UN PASO ANTES, en script.js
// (getScheduleEntriesForDate): tardanzaMin sale de restar HH:MM sin
// mirar la fecha ("(eh*60+em) - (sh*60+sm)"), así que una clase que
// empieza 23:50 y se ficha 00:10 del día siguiente da
// (0*60+10)-(23*60+50) = -1420 minutos -> "Presente" (¡1420 minutos
// "antes"!) en vez de 20 minutos tarde. Se deja documentado acá en
// vez de goldeado como PASS/FAIL de calcularSemaforoPuntualidad,
// porque el bug no vive en esta función.
const claseInicio = 23 * 60 + 50; // 23:50
const fichajeCrudo = 0 * 60 + 10; // 00:10 (día siguiente)
const elapsedCrudo = fichajeCrudo - claseInicio; // -1420, tal como lo calcula hoy script.js
const resultadoCrudo = calcularSemaforoPuntualidad(elapsedCrudo, criteria, true);
const caso10 = {
    n: 10, caso: 'Ficha después de medianoche (clase 23:50, ficha 00:10 = 20 min tarde real)',
    elapsedMin: `${elapsedCrudo} (crudo, sin corregir fecha)`, yaFicho: true, esperado: 'tardanza (real)', obtenido: resultadoCrudo.code,
    ok: null, // no es pass/fail de calcularSemaforoPuntualidad: es una alerta de bug upstream
};
resultados.push(caso10);

console.table(resultados.map(r => ({
    '#': r.n, Caso: r.caso, elapsedMin: r.elapsedMin, yaFicho: r.yaFicho,
    Esperado: r.esperado, Obtenido: r.obtenido,
    Resultado: r.ok === null ? '⚠ VER NOTA (bug upstream, no de esta función)' : (r.ok ? '✓ OK' : '✗ FALLÓ'),
})));

const relevantes = resultados.filter(r => r.ok !== null);
const fallidos = relevantes.filter(r => !r.ok);
console.log('');
if (fallidos.length === 0) {
    console.log(`✓ ${relevantes.length}/${relevantes.length} casos de calcularSemaforoPuntualidad() pasaron.`);
} else {
    console.log(`✗ ${fallidos.length}/${relevantes.length} casos FALLARON:`, fallidos.map(f => f.n));
    process.exitCode = 1;
}
console.log('');
console.log('Caso 10 (medianoche): NO se cuenta como pass/fail de calcularSemaforoPuntualidad -');
console.log('el bug real está en getScheduleEntriesForDate() de script.js (tardanzaMin no considera');
console.log('el cruce de fecha). Reportado aparte, no se tocó sin confirmar con el usuario si el');
console.log('instituto tiene bloques que cruzan medianoche.');

// ============================================================
// TURNOS (getTurnoPorHora / fichajeValidoParaClase) - sistema de
// turnos Mañana/Tarde/Noche agregado para el fix del bug real
// reportado con el docente Nuñez: un fichaje de 00:29 validaba por
// error una clase de las 21:00 (turno Noche) del día anterior, porque
// getScheduleEntriesForDate() (script.js) solo cruzaba
// teacherId+materiaId+fecha, sin mirar si la HORA del fichaje caía
// dentro de la ventana real de esa clase.
// ============================================================
console.log('');
console.log('== Turnos (getTurnoPorHora / fichajeValidoParaClase) ==');

const casosTurno = [
    { caso: 'getTurnoPorHora(07:00) -> Mañana', fn: () => getTurnoPorHora('07:00'), esperado: 'MANANA' },
    { caso: 'getTurnoPorHora(11:59) -> Mañana (límite superior)', fn: () => getTurnoPorHora('11:59'), esperado: 'MANANA' },
    { caso: 'getTurnoPorHora(12:00) -> Tarde (límite inferior)', fn: () => getTurnoPorHora('12:00'), esperado: 'TARDE' },
    { caso: 'getTurnoPorHora(17:59) -> Tarde (límite superior)', fn: () => getTurnoPorHora('17:59'), esperado: 'TARDE' },
    { caso: 'getTurnoPorHora(18:00) -> Noche (límite inferior)', fn: () => getTurnoPorHora('18:00'), esperado: 'NOCHE' },
    { caso: 'getTurnoPorHora(21:00) -> Noche', fn: () => getTurnoPorHora('21:00'), esperado: 'NOCHE' },
    { caso: 'getTurnoPorHora(00:29) -> Noche (madrugada, cae en Noche por default)', fn: () => getTurnoPorHora('00:29'), esperado: 'NOCHE' },

    // Caso real reportado: clase 21:00 (Noche, ventana 17:50-23:00) -
    // un fichaje de 00:29 (ya del día siguiente en términos de reloj,
    // pero la fecha calendario ya la filtra getFechaRealFichaje() en
    // script.js antes de llegar acá) NO puede validar esa clase.
    { caso: 'Fix Nuñez: clase 21:00, fichaje 00:29 -> NO vale', fn: () => fichajeValidoParaClase('00:29', '21:00'), esperado: false },
    { caso: 'Clase 21:00, fichaje 20:55 (5 min antes) -> vale', fn: () => fichajeValidoParaClase('20:55', '21:00'), esperado: true },
    { caso: 'Clase 21:00, fichaje 21:10 (10 min tarde) -> vale', fn: () => fichajeValidoParaClase('21:10', '21:00'), esperado: true },
    { caso: 'Clase 21:00, fichaje 23:00 (fin de ventana Noche) -> vale', fn: () => fichajeValidoParaClase('23:00', '21:00'), esperado: true },
    { caso: 'Clase 21:00, fichaje 23:01 (1 min después del fin) -> NO vale', fn: () => fichajeValidoParaClase('23:01', '21:00'), esperado: false },
    { caso: 'Clase 07:00, fichaje 05:50 (inicio ventana Mañana) -> vale', fn: () => fichajeValidoParaClase('05:50', '07:00'), esperado: true },
    { caso: 'Clase 07:00, fichaje 05:49 (1 min antes de la ventana) -> NO vale', fn: () => fichajeValidoParaClase('05:49', '07:00'), esperado: false },
];

const resultadosTurno = casosTurno.map(c => {
    const obtenido = c.fn();
    return { Caso: c.caso, Esperado: c.esperado, Obtenido: obtenido, Resultado: obtenido === c.esperado ? '✓ OK' : '✗ FALLÓ' };
});
console.table(resultadosTurno);

const fallidosTurno = resultadosTurno.filter(r => r.Resultado === '✗ FALLÓ');
if (fallidosTurno.length === 0) {
    console.log(`✓ ${resultadosTurno.length}/${resultadosTurno.length} casos de turnos pasaron.`);
} else {
    console.log(`✗ ${fallidosTurno.length}/${resultadosTurno.length} casos de turnos FALLARON.`);
    process.exitCode = 1;
}
