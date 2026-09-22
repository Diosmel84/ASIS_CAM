// ============================================================
// PRESENCIA-LOGIC.JS - Semáforo de puntualidad ("Docentes que
// deberían presentarse hoy", Inicio > admin).
//
// Módulo SIN dependencias de DOM/Supabase a propósito: script.js lo
// carga como <script> normal (index.html lo incluye ANTES de
// script.js, así que SEMAFORO_PUNTUALIDAD/calcularSemaforoPuntualidad
// quedan disponibles ahí como globales, sin duplicar la definición),
// y test-presencia.js lo importa con require() en Node para poder
// testear la lógica real sin tener que levantar un DOM/browser falso.
// Un solo archivo, una sola fuente de verdad para ambos.
// ============================================================
const SEMAFORO_PUNTUALIDAD = {
    esperado:    { color: '#9ca3af', label: 'Esperado' },
    presente:    { color: '#22c55e', label: 'Presente' },
    tardanza:    { color: '#eab308', label: 'Tardanza' },
    media_falta: { color: '#f97316', label: 'Media Falta' },
    ausente:     { color: '#ef4444', label: 'Ausente' },
};
// Orden de la lista pedido: rojo, naranja, amarillo, gris, verde.
const SEMAFORO_ORDEN = { ausente: 0, media_falta: 1, tardanza: 2, esperado: 3, presente: 4 };

// Límites por defecto (minutos desde la hora asignada) cuando el
// admin no configuró nada propio en Criterios de Puntualidad. Pedidos
// explícitamente por el instituto: 0-15 Presente, 16-30 Tardanza,
// 31-60 Media Falta, más de 60 Ausente (ver getCriteria() en
// script.js, que es la única que los lee/expone).
const CRITERIA_PUNTUALIDAD_DEFAULT = {
    limitePresenteMin: 15,
    limiteTardanzaMin: 30,
    limiteMediaFaltaMin: 60,
};

// elapsedMin: minutos desde la hora asignada (null si todavía no llegó
// esa hora). yaFicho: si ya hay un fichaje de entrada para este bloque.
// Regla pedida: mientras no fichó, se queda "Esperado" (gris) hasta que
// se cumple limiteMediaFaltaMin sin fichar -> ahí pasa directo a
// "Ausente" (rojo). Si fichó, el color depende de en qué franja cayó
// esa hora real, sin importar si ya se hubiera "vencido" el margen.
// IMPORTANTE: elapsedMin se mide siempre contra la HORA DE INICIO del
// bloque (nunca contra la duración de la clase) - fichar "tarde"
// respecto del inicio es lo único que importa acá, sin importar si la
// clase dura 40, 60 u 80 minutos: una clase de 40 minutos y una de 80
// usan exactamente el mismo semáforo.
function calcularSemaforoPuntualidad(elapsedMin, criteria, yaFicho) {
    if (yaFicho) {
        if (elapsedMin <= criteria.limitePresenteMin) return { code: 'presente', ...SEMAFORO_PUNTUALIDAD.presente };
        if (elapsedMin <= criteria.limiteTardanzaMin) return { code: 'tardanza', ...SEMAFORO_PUNTUALIDAD.tardanza };
        if (elapsedMin <= criteria.limiteMediaFaltaMin) return { code: 'media_falta', ...SEMAFORO_PUNTUALIDAD.media_falta };
        return { code: 'ausente', ...SEMAFORO_PUNTUALIDAD.ausente };
    }
    if (elapsedMin == null || elapsedMin <= criteria.limiteMediaFaltaMin) return { code: 'esperado', ...SEMAFORO_PUNTUALIDAD.esperado };
    return { code: 'ausente', ...SEMAFORO_PUNTUALIDAD.ausente };
}

// ============================================================
// TURNOS (Mañana/Tarde/Noche) - agrupan los bloques de horario de
// cátedra para 1) validar que un fichaje realmente corresponda a una
// clase puntual (ver fichajeValidoParaClase() más abajo) y 2) agrupar
// "Docentes que deberían presentarse hoy" en 3 secciones (script.js,
// renderDocentesEsperadosHoy()).
//
// `ventanaDesde`: 10 minutos antes del inicio del turno - margen para
// que un docente pueda fichar un poco antes sin quedar "fuera de
// ventana". `fin`: límite de la VENTANA DE VALIDEZ de un fichaje para
// una clase de ese turno (no el fin de la última clase posible en la
// práctica) - pedido explícito: Noche cierra la ventana a las 23:00
// en punto, sin importar si en la realidad puede haber clases que
// terminen más tarde.
// ============================================================
const TURNOS = {
    MANANA: { nombre: 'Mañana', inicio: '06:00', fin: '11:59', ventanaDesde: '05:50' },
    TARDE: { nombre: 'Tarde', inicio: '12:00', fin: '17:59', ventanaDesde: '11:50' },
    NOCHE: { nombre: 'Noche', inicio: '18:00', fin: '23:00', ventanaDesde: '17:50' },
};
const TURNO_ORDEN = ['MANANA', 'TARDE', 'NOCHE'];

function horaAMinutos(hhmm) {
    if (!hhmm || typeof hhmm !== 'string') return null;
    const [h, m] = hhmm.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
}

// A qué turno pertenece una clase según su hora de INICIO (nunca la de
// fin - una clase que arranca 17:40 y termina 18:20 es Tarde, no
// Noche). Antes de las 06:00 (nadie tiene clase de madrugada en este
// instituto) se cae a Noche por default, mismo criterio que "sigue
// siendo de noche hasta el amanecer".
function getTurnoPorHora(hora) {
    const min = horaAMinutos(hora);
    if (min == null) return null;
    if (min >= horaAMinutos(TURNOS.MANANA.inicio) && min < horaAMinutos(TURNOS.TARDE.inicio)) return 'MANANA';
    if (min >= horaAMinutos(TURNOS.TARDE.inicio) && min < horaAMinutos(TURNOS.NOCHE.inicio)) return 'TARDE';
    return 'NOCHE';
}

// El corazón del fix de fichajes "fantasma" (bug real reportado con un
// docente de apellido Nuñez): un fichaje solo puede corresponder a una
// clase puntual si cayó DENTRO de la ventana del TURNO de esa clase
// (10 min antes del inicio del turno, hasta el fin del turno) - nunca
// solo por coincidir el día calendario. Antes de este chequeo, un
// fichaje real de 00:29 (ya cruzada la medianoche) podía validar por
// error una clase de las 21:00 de Noche del día anterior, porque el
// único cruce que se hacía era teacherId + materiaId + fecha, sin
// mirar la hora real del fichaje contra la de la clase.
// Ej: clase 21:00 (turno Noche, ventana 17:50-23:00) - fichaje 00:29
// NO vale (29 min están fuera de [17:50,23:00]) -> la clase queda
// "Esperado", no se marca presente por error.
function fichajeValidoParaClase(horaFichaje, horaInicioClase) {
    const turno = getTurnoPorHora(horaInicioClase);
    if (!turno) return false;
    const cfg = TURNOS[turno];
    const minFichaje = horaAMinutos(horaFichaje);
    if (minFichaje == null) return false;
    return minFichaje >= horaAMinutos(cfg.ventanaDesde) && minFichaje <= horaAMinutos(cfg.fin);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SEMAFORO_PUNTUALIDAD, SEMAFORO_ORDEN, CRITERIA_PUNTUALIDAD_DEFAULT, calcularSemaforoPuntualidad,
        TURNOS, TURNO_ORDEN, horaAMinutos, getTurnoPorHora, fichajeValidoParaClase,
    };
}
