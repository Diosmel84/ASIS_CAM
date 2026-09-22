// ============================================================
// ASISCAM PRO - Selector de idioma (ES/EN/PT)
//
// No hay React en este proyecto (es HTML+JS clásico con Bootstrap,
// servido estático), así que next-intl/react-i18next/framer-motion no
// aplican - esto es el equivalente vanilla: diccionarios en
// locales/es.js, en.js, pt.js (cargados ANTES que este archivo en
// index.html, cada uno se registra en window.ASISCAM_I18N.<locale>,
// mismo patrón que config.secrets.js/presencia-logic.js) + este
// módulo, que expone t()/setLocale() y aplica el idioma activo al DOM.
//
// Cambio de idioma instantáneo, sin reload: setLocale() reescribe el
// texto de todo lo marcado con data-i18n en el HTML estático, y avisa
// a las pantallas armadas con innerHTML en script.js (Esperados Hoy,
// modal de fichaje) para que se vuelvan a renderizar con el nuevo
// idioma - ver onLocaleChangeRerender() más abajo. No toca la lógica
// de fecha/hora de Argentina (getFechaHoyArgentina() y compañía en
// script.js): esto es solo texto de interfaz, nunca fechas/horas ni
// cálculos.
// ============================================================
const I18N_DEFAULT_LOCALE = 'es';
const I18N_STORAGE_KEY = 'app_lang';
let currentLocale = I18N_DEFAULT_LOCALE;

function getLocale() { return currentLocale; }

// key admite notación con punto ("login.title") para bajar por el
// diccionario anidado. Si la clave no existe en el idioma activo, cae
// al diccionario base (es) - más útil que mostrar la clave cruda o
// nada mientras la segunda pasada de traducción no llegó a esa parte
// de la app todavía.
function t(key, vars) {
    const buscar = (dict) => key.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), dict);
    let valor = buscar((window.ASISCAM_I18N && window.ASISCAM_I18N[currentLocale]) || {});
    if (valor == null) valor = buscar((window.ASISCAM_I18N && window.ASISCAM_I18N[I18N_DEFAULT_LOCALE]) || {});
    if (valor == null) return key;
    if (vars) {
        Object.keys(vars).forEach(k => { valor = valor.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]); });
    }
    return valor;
}

// Aplica el diccionario activo a todo el HTML estático marcado con
// data-i18n (textContent), data-i18n-placeholder (placeholder de
// inputs) y data-i18n-title (atributo title). El texto generado
// dinámicamente en script.js (listas armadas con innerHTML, que
// mezclan traducción + datos reales como nombres de docentes) no pasa
// por acá - ver onLocaleChangeRerender().
function aplicarLocaleAlDOM() {
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')); });
}

// Pantallas que arman su propio HTML con innerHTML (mezclando
// traducción + datos reales, ej. renderDocentesEsperadosHoy()) se
// registran acá para que setLocale() las vuelva a pintar. Un array
// simple en vez de que este archivo conozca de antemano esas
// funciones de script.js (que se carga DESPUÉS): evita una
// dependencia circular entre los dos archivos.
const _i18nDynamicRenderers = [];
function onLocaleChangeRerender(fn) { _i18nDynamicRenderers.push(fn); }

// SVG inline en vez de emoji de bandera (🇦🇷/🇺🇸/🇧🇷): Windows no tiene
// fuente de emoji de banderas instalada por default y las muestra como
// texto plano ("AR"/"US"/"BR"), rompiendo el look de "banderita
// redonda" pedido - un SVG propio se ve igual en cualquier sistema, y
// al ser inline (no una imagen externa) sigue funcionando 100% offline
// sin agregar nada al precache del service worker.
const LOCALES_INFO = {
    es: {
        label: 'ES',
        flagSvg: '<svg viewBox="0 0 30 20" xmlns="http://www.w3.org/2000/svg"><rect width="30" height="20" fill="#fff"/><rect width="30" height="7" fill="#75AADB"/><rect y="13" width="30" height="7" fill="#75AADB"/><circle cx="15" cy="10" r="2.6" fill="#FCBF49"/></svg>',
    },
    en: {
        label: 'EN',
        flagSvg: '<svg viewBox="0 0 30 20" xmlns="http://www.w3.org/2000/svg"><rect width="30" height="20" fill="#B22234"/><rect y="1.5" width="30" height="1.5" fill="#fff"/><rect y="4.5" width="30" height="1.5" fill="#fff"/><rect y="7.5" width="30" height="1.5" fill="#fff"/><rect y="10.5" width="30" height="1.5" fill="#fff"/><rect y="13.5" width="30" height="1.5" fill="#fff"/><rect y="16.5" width="30" height="1.5" fill="#fff"/><rect width="13" height="10.5" fill="#3C3B6E"/></svg>',
    },
    pt: {
        label: 'PT',
        flagSvg: '<svg viewBox="0 0 30 20" xmlns="http://www.w3.org/2000/svg"><rect width="30" height="20" fill="#009739"/><polygon points="15,2 28,10 15,18 2,10" fill="#FEDD00"/><circle cx="15" cy="10" r="4.2" fill="#012169"/></svg>',
    },
};

// Pinta (o repinta) el selector de idioma en cada contenedor
// .lang-switcher que haya en la página (login + header del
// dashboard): 3 botones tipo pill en desktop, un <select> nativo en
// mobile (mismo breakpoint que el resto de la app, ver <576px en
// style.css) - los dos escriben al mismo setLocale(), así que
// cualquiera de los dos sirve sin importar cuál esté visible.
// onclick/onchange inline a propósito: el contenedor se reconstruye
// entero en cada cambio de idioma, así que un addEventListener
// quedaría colgado del nodo viejo.
function renderLanguageSwitcher() {
    document.querySelectorAll('.lang-switcher').forEach(cont => {
        const pills = Object.keys(LOCALES_INFO).map(loc => {
            const info = LOCALES_INFO[loc];
            const activo = loc === currentLocale;
            return `<button type="button" class="lang-pill${activo ? ' lang-pill-active' : ''}" onclick="setLocale('${loc}')" aria-pressed="${activo}" aria-label="${loc.toUpperCase()}">` +
                `<span class="lang-pill-flag">${info.flagSvg}</span><span class="lang-pill-label">${info.label}</span></button>`;
        }).join('');
        // Mismas 3 pills en cualquier ancho de pantalla - antes había un
        // <select> nativo aparte para mobile (<576px), pero terminaba
        // mostrando un selector distinto (sin banderas, a veces con el
        // <select> de un service worker viejo todavía cacheado) al de
        // desktop. Una sola marcación para los dos evita esa divergencia;
        // que entre en mobile lo resuelve el CSS (.lang-switcher-pills
        // con flex-wrap y pills más chicas en <576px, ver style.css).
        cont.innerHTML = `<div class="lang-switcher-pills">${pills}</div>`;
    });
}

// Cambia el idioma activo, lo persiste en localStorage (mismo patrón
// que last_known_coords/my_device_id en script.js: try/catch porque
// localStorage puede estar lleno o deshabilitado, y eso no debe
// romper el cambio de idioma en pantalla) y repinta todo sin reload.
//
// Supabase: el pedido original menciona guardar en "user_preferences"
// si existe esa tabla - no existe en este proyecto (ver
// docs/base_de_datos/schema.sql), así que por ahora el idioma es
// por-dispositivo (localStorage), no por-usuario entre dispositivos.
// Agregar esa tabla es una migración de base de datos aparte, fuera
// de esta primera pasada.
function setLocale(locale) {
    if (!window.ASISCAM_I18N || !window.ASISCAM_I18N[locale]) return;
    currentLocale = locale;
    try { localStorage.setItem(I18N_STORAGE_KEY, locale); } catch (e) { /* localStorage lleno o deshabilitado: se ignora, el idioma no persiste pero no rompe nada */ }
    document.documentElement.lang = locale;
    aplicarLocaleAlDOM();
    renderLanguageSwitcher();
    _i18nDynamicRenderers.forEach(fn => {
        try { fn(); } catch (e) { console.error('[i18n] error re-renderizando una pantalla tras cambiar de idioma:', e); }
    });
}

function initI18n() {
    let guardado = null;
    try { guardado = localStorage.getItem(I18N_STORAGE_KEY); } catch (e) { /* ignorado */ }
    currentLocale = (guardado && window.ASISCAM_I18N && window.ASISCAM_I18N[guardado]) ? guardado : I18N_DEFAULT_LOCALE;
    document.documentElement.lang = currentLocale;
    aplicarLocaleAlDOM();
    renderLanguageSwitcher();
}

document.addEventListener('DOMContentLoaded', initI18n);
