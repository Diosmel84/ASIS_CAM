// ============================================================
// ASISCAM PRO - Modo oscuro (toggle claro/oscuro)
//
// Mismo patrón que i18n.js (script clásico, sin build, registrado
// en window para que ande offline con el service worker): CSS ya
// trae toda la paleta invertida via variables (ver style.css,
// bloque "MODO OSCURO"), este archivo solo decide QUÉ atributo va
// en <html> y lo persiste.
//
// Tres fuentes posibles del tema, en orden de prioridad:
//   1) Elección manual guardada en localStorage (el usuario ya tocó
//      el toggle alguna vez en este dispositivo).
//   2) Si nunca tocó el toggle: prefers-color-scheme del sistema
//      operativo - sin agregar data-theme, el CSS lo sigue solo via
//      @media (ver style.css). No se guarda nada en localStorage
//      hasta que el usuario elige a mano.
//
// Nota anti-flash: además de este archivo (que pinta el botón y
// maneja el click, cargado al final junto al resto de los scripts),
// hay un <script> inline chiquito en el <head> de index.html que
// aplica el data-theme guardado ANTES de que se pinte la página -
// si esa parte se hiciera acá nomás, se vería un flash del tema
// equivocado durante una fracción de segundo en cada carga.
// ============================================================
const THEME_STORAGE_KEY = 'app_theme';

// Preferencia explícita del usuario (o null si nunca tocó el toggle
// y sigue al sistema operativo).
function getStoredTheme() {
    try {
        const t = localStorage.getItem(THEME_STORAGE_KEY);
        return (t === 'dark' || t === 'light') ? t : null;
    } catch (e) { return null; /* localStorage deshabilitado: se ignora, sigue al SO */ }
}

// Tema realmente aplicado ahora mismo (explícito, o el del SO si no hay explícito).
function getEffectiveTheme() {
    const guardado = getStoredTheme();
    if (guardado) return guardado;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}

function aplicarAtributoTheme(theme) {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
}

// Pinta (o repinta) el botón en cada contenedor .theme-switcher que
// haya en la página (login + header del dashboard) - mismo criterio
// que renderLanguageSwitcher() en i18n.js: se reconstruye entero en
// cada cambio, por eso el onclick es inline en vez de addEventListener.
function renderThemeToggle() {
    const efectivo = getEffectiveTheme();
    const irA = efectivo === 'dark' ? 'light' : 'dark';
    const icono = efectivo === 'dark' ? 'bi-sun' : 'bi-moon-stars-fill';
    const titulo = (window.t ? t(irA === 'dark' ? 'header.themeToDark' : 'header.themeToLight') : (irA === 'dark' ? 'Modo oscuro' : 'Modo claro'));
    document.querySelectorAll('.theme-switcher').forEach(cont => {
        cont.innerHTML = `<button type="button" class="theme-toggle-btn" onclick="toggleTheme()" aria-label="${titulo}" title="${titulo}"><i class="bi ${icono}"></i></button>`;
    });
}

function toggleTheme() {
    const nuevo = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_STORAGE_KEY, nuevo); } catch (e) { /* localStorage lleno o deshabilitado: no persiste, pero no rompe nada */ }
    aplicarAtributoTheme(nuevo);
    renderThemeToggle();
}

function initTheme() {
    // El <script> inline en el <head> ya aplicó el data-theme guardado
    // (si había uno) antes del primer render - acá solo se asegura de
    // que quede sincronizado y se pinta el botón.
    aplicarAtributoTheme(getStoredTheme());
    renderThemeToggle();
    // Si el usuario nunca eligió a mano y cambia el tema del SO en vivo
    // (por ej. se hace de noche y el celular pasa a oscuro solo), el
    // CSS ya seguía ese cambio automáticamente (@media) - acá solo se
    // repinta el ICONO del botón para que coincida.
    if (window.matchMedia) {
        const mql = window.matchMedia('(prefers-color-scheme: dark)');
        const onSystemChange = () => { if (!getStoredTheme()) renderThemeToggle(); };
        if (mql.addEventListener) mql.addEventListener('change', onSystemChange);
        else if (mql.addListener) mql.addListener(onSystemChange); // Safari viejo
    }
}

document.addEventListener('DOMContentLoaded', initTheme);
// Si cambia el idioma después de iniciar, el title/aria-label del botón
// (que usa t()) se re-pinta para que quede traducido.
if (typeof onLocaleChangeRerender === 'function') onLocaleChangeRerender(renderThemeToggle);
