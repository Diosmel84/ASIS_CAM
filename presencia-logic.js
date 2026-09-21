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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SEMAFORO_PUNTUALIDAD, SEMAFORO_ORDEN, CRITERIA_PUNTUALIDAD_DEFAULT, calcularSemaforoPuntualidad };
}
