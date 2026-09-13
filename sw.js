"use strict";
/**
 * Service worker de ASIS_CAM.
 *
 * Objetivo: que el fichaje por reconocimiento facial (y la app en general)
 * sigan funcionando sin conexión a internet (modo avión) después de la
 * primera visita con señal. Para eso, en la instalación se precachea:
 *   - el "app shell" (index.html, style.css),
 *   - las librerías de terceros que la app necesita en tiempo de ejecución
 *     (face-api.js, Bootstrap, Chart.js, jsPDF, supabase-js), y
 *   - los 7 archivos de pesos del modelo de reconocimiento facial en /models
 *     (tiny_face_detector, face_landmark_68 y face_recognition), que están
 *     copiados dentro del propio repo en vez de servirse desde el CDN de
 *     face-api.js, justamente para que este precacheo no dependa de un CDN
 *     externo.
 *
 * Lo que NO cachea nunca: las llamadas a la API de Supabase (app_data,
 * evento_especial, etc.). Esas siguen yendo directo a la red; sin conexión,
 * es la propia app (dataStore + localStorage + sb_pending_sync, ver el
 * <script> inline de index.html) la que sigue funcionando con la última
 * copia local y sincroniza sola al reconectar.
 */

const CACHE_VERSION = "v1";
const CACHE_NAME = "asiscam-cache-" + CACHE_VERSION;

// App shell: mismo origen que este service worker.
// Nota: toda la lógica de la app vive INLINE dentro de index.html (no hay
// un <script src="script.js">, así que no hace falta -ni tiene sentido-
// precachear ese archivo por separado).
const APP_SHELL_URLS = [
  "./",
  "./index.html",
  "./style.css",
];

// Pesos del reconocimiento facial (copiados en /models, ver CONFIG.FACE_MODELS_URL en index.html).
const MODEL_URLS = [
  "./models/tiny_face_detector_model-weights_manifest.json",
  "./models/tiny_face_detector_model-shard1",
  "./models/face_landmark_68_model-weights_manifest.json",
  "./models/face_landmark_68_model-shard1",
  "./models/face_recognition_model-weights_manifest.json",
  "./models/face_recognition_model-shard1",
  "./models/face_recognition_model-shard2",
];

// Librerías de terceros: sin ellas la app ni siquiera arranca offline,
// aunque los modelos estén cacheados (face-api.js necesita su propia
// librería cargada, no solo los pesos).
const VENDOR_URLS = [
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css",
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js",
  "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js",
];

const PRECACHE_URLS = [...APP_SHELL_URLS, ...MODEL_URLS, ...VENDOR_URLS];

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

function isVendorRequest(url) {
  return VENDOR_URLS.some((v) => v === url.href || v.endsWith(url.pathname));
}

function isAppShellRequest(url) {
  if (url.origin !== self.location.origin) return false;
  return (
    url.pathname === "/" ||
    url.pathname.endsWith("/index.html") ||
    url.pathname.endsWith("/style.css")
  );
}

// Cache-first: para recursos inmutables (pesos del modelo, librerías de
// terceros con versión fija en la URL). Si ya están en caché, ni siquiera
// se sale a la red a confirmarlos; si no están, se buscan y se guardan
// para la próxima vez que falte la conexión ("precache on first online load").
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
async function networkFirst(request) {
  try {
    const response = await fetch(request);
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

  if (isModelRequest(url) || isVendorRequest(url)) {
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
