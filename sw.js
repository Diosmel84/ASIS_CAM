"use strict";
/**
 * Service worker de ASIS_CAM.
 *
 * Objetivo: que el fichaje por reconocimiento facial (y la app en general)
 * sigan funcionando sin conexión a internet (modo avión) después de la
 * primera visita con señal. Para eso, en la instalación se precachea:
 *   - el "app shell" (index.html, style.css, script.js),
 *   - las librerías de terceros que la app necesita en tiempo de ejecución,
 *     autohospedadas en /libs (Bootstrap, Bootstrap Icons + sus fuentes,
 *     face-api.js, Chart.js, jsPDF, supabase-js), y
 *   - los 7 archivos de pesos del modelo de reconocimiento facial en /models
 *     (tiny_face_detector, face_landmark_68 y face_recognition).
 * Tanto /libs como /models están copiados dentro del propio repo en vez de
 * servirse desde un CDN externo, para que ni el arranque de la app ni el
 * reconocimiento facial dependan de que un tercero esté disponible.
 *
 * Lo que NO cachea nunca: las llamadas a la API de Supabase (app_data,
 * evento_especial, etc.). Esas siguen yendo directo a la red; sin conexión,
 * es la propia app (dataStore + localStorage + sb_pending_sync, ver
 * script.js) la que sigue funcionando con la última copia local y
 * sincroniza sola al reconectar.
 */

const CACHE_VERSION = "v7";
const CACHE_NAME = "asiscam-cache-" + CACHE_VERSION;

// App shell: mismo origen que este service worker.
const APP_SHELL_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./presencia-logic.js",
  "./locales/es.js",
  "./locales/en.js",
  "./locales/pt.js",
  "./i18n.js",
  "./theme.js",
  "./script.js",
  "./liveness.js",
];

// Pesos del reconocimiento facial (copiados en /models, ver CONFIG.FACE_MODELS_URL en script.js).
const MODEL_URLS = [
  "./models/tiny_face_detector_model-weights_manifest.json",
  "./models/tiny_face_detector_model-shard1",
  "./models/face_landmark_68_model-weights_manifest.json",
  "./models/face_landmark_68_model-shard1",
  "./models/face_recognition_model-weights_manifest.json",
  "./models/face_recognition_model-shard1",
  "./models/face_recognition_model-shard2",
];

// Librerías de terceros autohospedadas en /libs (ya no se cargan desde un
// CDN): sin ellas la app ni siquiera arranca offline, aunque los modelos
// estén cacheados (face-api.js necesita su propia librería cargada, no
// solo los pesos; Bootstrap Icons necesita además sus archivos de fuente).
const LIB_URLS = [
  "./libs/bootstrap.min.css",
  "./libs/bootstrap.bundle.min.js",
  "./libs/bootstrap-icons.css",
  "./libs/fonts/bootstrap-icons.woff2",
  "./libs/fonts/bootstrap-icons.woff",
  "./libs/face-api.min.js",
  "./libs/chart.umd.min.js",
  "./libs/jspdf.umd.min.js",
  "./libs/supabase.min.js",
];

const PRECACHE_URLS = [...APP_SHELL_URLS, ...MODEL_URLS, ...LIB_URLS];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        // addAll() falla entero si UN solo recurso no se puede descargar
        // (por ejemplo, el usuario instala el SW ya sin conexión). Se
        // agregan uno por uno para que un fallo puntual no impida cachear
        // el resto; los que fallen quedarán pendientes de cachearse en el
        // primer fetch exitoso (ver el handler de "fetch" más abajo).
        Promise.all(
          PRECACHE_URLS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn("[sw] No se pudo precachear en la instalación:", url, err);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isModelRequest(url) {
  return url.pathname.includes("/models/");
}

function isLibRequest(url) {
  return url.pathname.includes("/libs/");
}

function isAppShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  return (
    url.pathname === "/" ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/style.css") ||
    url.pathname.endsWith("/presencia-logic.js") ||
    url.pathname.endsWith("/locales/es.js") ||
    url.pathname.endsWith("/locales/en.js") ||
    url.pathname.endsWith("/locales/pt.js") ||
    url.pathname.endsWith("/i18n.js") ||
    url.pathname.endsWith("/theme.js") ||
    url.pathname.endsWith("/script.js") ||
    url.pathname.endsWith("/liveness.js")
  );
}

// Cache-first: para recursos inmutables (pesos del modelo, librerías de
// terceros autohospedadas en /libs). Solo cambian cuando se actualiza el
// propio repositorio, así que si ya están en caché ni siquiera se sale a
// la red a confirmarlos; si no están, se buscan y se guardan para la
// próxima vez que falte la conexión ("precache on first online load").
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && (response.ok || response.type === "opaque")) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Sin red y sin copia en caché: no hay nada que devolver.
    throw err;
  }
}

// Network-first con reserva en caché: para el app shell, así quien tiene
// conexión siempre ve la última versión publicada, y quien no la tiene
// sigue viendo la última versión que llegó a cachearse con éxito.
// cache: "no-store" es a propósito: sin esto, fetch() puede resolverse
// contra la caché HTTP del navegador (Firebase Hosting manda
// Cache-Control en index.html/sw.js) y esta función "network-first"
// terminaría devolviendo una respuesta vieja creyendo que fue a la red.
async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Última reserva para una navegación: servir el index cacheado.
    const fallback = await caches.match("./index.html");
    if (fallback) return fallback;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // los POST/PATCH/etc. (Supabase) siguen de largo, nunca se cachean

  const url = new URL(request.url);

  if (isModelRequest(url) || isLibRequest(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (isAppShellRequest(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Todo lo demás (Supabase REST, fuentes de Bootstrap Icons, wa.me, etc.)
  // no lo toca este service worker: sigue el comportamiento normal del
  // navegador.
});
