"use strict";
/**
 * Harness de prueba: ejecuta sw.js REAL dentro de un sandbox de Node (vm)
 * simulando el entorno de un Service Worker (self, caches, fetch), para
 * verificar el precacheo en la instalación, la limpieza en la activación,
 * y las estrategias cache-first / network-first, sin necesitar un
 * navegador real.
 *
 * Uso: node tests/test_service_worker.js
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const SW_PATH = path.join(__dirname, "..", "sw.js");
const src = fs.readFileSync(SW_PATH, "utf8");

// El navegador real siempre normaliza las claves del Cache Storage a URL
// absoluta (cache.add('./models/x') termina guardado bajo la URL absoluta
// resuelta contra la ubicación del service worker), así que este mock hace
// lo mismo para que "./models/x" y "https://.../models/x" sean la MISMA
// entrada de caché, tal como pasaría en un navegador.
const ORIGIN = "https://asiscam-uno.netlify.app/";
function toAbsolute(key) { return new URL(key, ORIGIN).href; }

// ---- Cache Storage falso (Map de Map) ----
class FakeCache {
  constructor(fetchFn) { this.store = new Map(); this._fetch = fetchFn; }
  async match(request) {
    const key = typeof request === "string" ? request : request.url;
    return this.store.get(toAbsolute(key));
  }
  async put(request, response) {
    const key = typeof request === "string" ? request : request.url;
    this.store.set(toAbsolute(key), response);
  }
  async add(request) {
    const key = typeof request === "string" ? request : request.url;
    const response = await this._fetch(key);
    if (!response || !(response.ok || response.type === "opaque")) throw new Error("add() falló para " + key);
    this.store.set(toAbsolute(key), response);
  }
}

function makeSandbox({ networkOnline = true, unreachableUrls = [] } = {}) {
  const caches_ = new Map(); // nombre de cache -> FakeCache
  const fetchCalls = [];
  const putCalls = [];

  const fakeCaches = {
    async open(name) {
      if (!caches_.has(name)) caches_.set(name, new FakeCache(fakeFetch));
      return caches_.get(name);
    },
    async keys() { return [...caches_.keys()]; },
    async delete(name) { return caches_.delete(name); },
    async match(request) {
      const key = toAbsolute(typeof request === "string" ? request : request.url);
      for (const cache of caches_.values()) {
        const hit = cache.store.get(key);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  function fakeResponse(url) {
    return { ok: true, status: 200, type: "cors", url, _body: "contenido de " + url, clone() { return this; } };
  }

  async function fakeFetch(requestOrUrl) {
    const url = typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.url;
    fetchCalls.push(url);
    if (!networkOnline || unreachableUrls.includes(url)) {
      throw new Error("network error (offline simulado): " + url);
    }
    return fakeResponse(url);
  }

  const listeners = {};
  const self_ = {
    location: { origin: "https://asiscam-uno.netlify.app", href: "https://asiscam-uno.netlify.app/" },
    addEventListener(evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); },
    skipWaiting: () => { self_._skippedWaiting = true; },
    clients: { claim: () => { self_._claimed = true; } },
    fetch: fakeFetch,
    console,
  };

  const sandbox = {
    self: self_,
    caches: fakeCaches,
    fetch: fakeFetch,
    URL,
    console,
    Promise,
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "sw.js" });

  return {
    sandbox,
    caches: caches_,
    fetchCalls,
    self: self_,
    async dispatch(evtName, eventProps = {}) {
      const waitUntilPromises = [];
      const event = {
        ...eventProps,
        waitUntil(p) { waitUntilPromises.push(p); },
        respondWith(p) { event._respondWith = p; },
      };
      for (const cb of listeners[evtName] || []) cb(event);
      await Promise.all(waitUntilPromises);
      return event;
    },
  };
}

function makeRequest(url, method = "GET") {
  return { url, method };
}

async function main() {
  const results = [];
  const check = (desc, cond) => {
    results.push({ desc, ok: !!cond });
    console.log((cond ? "  [OK] " : "  [FALLÓ] ") + desc);
  };

  console.log("== Paso 1: instalación (install) con red disponible ==");
  let env = makeSandbox({ networkOnline: true });
  await env.dispatch("install");
  const cache = env.caches.get("asiscam-cache-v3");
  check("se creó la cache asiscam-cache-v3", !!cache);
  check("precacheó el app shell (index.html, style.css, script.js)", !!(await cache.match("./index.html")) && !!(await cache.match("./style.css")) && !!(await cache.match("./script.js")));
  check("precacheó los 7 archivos de /models", [
    "./models/tiny_face_detector_model-weights_manifest.json",
    "./models/tiny_face_detector_model-shard1",
    "./models/face_landmark_68_model-weights_manifest.json",
    "./models/face_landmark_68_model-shard1",
    "./models/face_recognition_model-weights_manifest.json",
    "./models/face_recognition_model-shard1",
    "./models/face_recognition_model-shard2",
  ].every((u) => cache.store.has(toAbsolute(u))));
  check("precacheó las 9 librerías autohospedadas en /libs (incluidas las 2 fuentes de íconos)", [
    "./libs/bootstrap.min.css",
    "./libs/bootstrap.bundle.min.js",
    "./libs/bootstrap-icons.css",
    "./libs/fonts/bootstrap-icons.woff2",
    "./libs/fonts/bootstrap-icons.woff",
    "./libs/face-api.min.js",
    "./libs/chart.umd.min.js",
    "./libs/jspdf.umd.min.js",
    "./libs/supabase.min.js",
  ].every((u) => cache.store.has(toAbsolute(u))));
  check("total precacheado = 20 recursos (4 app shell + 7 modelos + 9 libs)", cache.store.size === 20);
  check("llamó a self.skipWaiting()", env.self._skippedWaiting === true);

  console.log("\n== Paso 2: activación (activate) limpia caches viejas ==");
  env.caches.set("asiscam-cache-v2", new FakeCache(async () => ({ ok: true })));
  await env.dispatch("activate");
  check("borró la cache vieja asiscam-cache-v2", !env.caches.has("asiscam-cache-v2"));
  check("conservó la cache actual asiscam-cache-v3", env.caches.has("asiscam-cache-v3"));
  check("llamó a self.clients.claim()", env.self._claimed === true);

  console.log("\n== Paso 3: fetch de un modelo -> cache-first (ya cacheado, no debe volver a pedirlo a la red) ==");
  const fetchCountAntes = env.fetchCalls.length;
  const reqModelo = makeRequest("https://asiscam-uno.netlify.app/models/tiny_face_detector_model-shard1");
  let event = await env.dispatch("fetch", { request: reqModelo });
  const respuestaModelo = await event._respondWith;
  check("respondWith() fue invocado para el pedido de un modelo", !!event._respondWith);
  check("devolvió una respuesta OK", respuestaModelo && respuestaModelo.ok);
  check("NO volvió a pedirlo a la red (ya estaba cacheado por la instalación)", env.fetchCalls.length === fetchCountAntes);

  console.log("\n== Paso 4: fetch de un modelo NO cacheado -> lo trae de la red y lo cachea (\"precache on first online load\") ==");
  env = makeSandbox({ networkOnline: true }); // instancia nueva, sin instalar
  const reqModeloNuevo = makeRequest("https://asiscam-uno.netlify.app/models/face_recognition_model-shard2");
  event = await env.dispatch("fetch", { request: reqModeloNuevo });
  const respuesta2 = await event._respondWith;
  check("se fue a buscarlo a la red porque no estaba cacheado", env.fetchCalls.includes(reqModeloNuevo.url));
  check("quedó cacheado después de traerlo", !!(await env.sandbox.caches.match(reqModeloNuevo.url)));
  check("una segunda pedida ya no vuelve a la red", await (async () => {
    const antes = env.fetchCalls.length;
    const event2 = await env.dispatch("fetch", { request: reqModeloNuevo });
    await event2._respondWith;
    return env.fetchCalls.length === antes;
  })());

  console.log("\n== Paso 5: fetch del app shell -> network-first (usa la red si hay, actualiza la caché) ==");
  env = makeSandbox({ networkOnline: true });
  await env.dispatch("install");
  const reqShell = makeRequest("https://asiscam-uno.netlify.app/index.html");
  const fetchCountAntesShell = env.fetchCalls.length;
  event = await env.dispatch("fetch", { request: reqShell });
  const respuestaShell = await event._respondWith;
  check("el app shell SÍ va a la red aunque ya esté cacheado (network-first)", env.fetchCalls.length === fetchCountAntesShell + 1);
  check("la respuesta es OK", respuestaShell && respuestaShell.ok);

  console.log("\n== Paso 6: fetch del app shell SIN conexión -> cae a la copia cacheada ==");
  env = makeSandbox({ networkOnline: true });
  await env.dispatch("install"); // cachea index.html mientras hay señal
  env.self.fetch = async (r) => { env.fetchCalls.push(typeof r === "string" ? r : r.url); throw new Error("offline"); };
  event = await env.dispatch("fetch", { request: makeRequest("https://asiscam-uno.netlify.app/index.html") });
  const respuestaOffline = await event._respondWith;
  check("sin red, sirvió la copia cacheada de index.html en vez de fallar", respuestaOffline && respuestaOffline.ok);

  console.log("\n== Paso 7: peticiones que el service worker debe IGNORAR (Supabase, POST) ==");
  env = makeSandbox({ networkOnline: true });
  event = await env.dispatch("fetch", { request: makeRequest("https://kclnaabvcxdovvgblyoc.supabase.co/rest/v1/app_data?key=eq.teachers", "GET") });
  check("una llamada GET a la API de Supabase NO es interceptada (respondWith no se llama)", event._respondWith === undefined);
  event = await env.dispatch("fetch", { request: makeRequest("https://asiscam-uno.netlify.app/models/tiny_face_detector_model-shard1", "POST") });
  check("un POST (aunque sea a una URL de /models) tampoco se intercepta", event._respondWith === undefined);

  console.log("\n==================================================");
  const total = results.length, ok = results.filter((r) => r.ok).length;
  console.log(`RESULTADO: ${ok}/${total} verificaciones OK`);
  if (ok !== total) {
    console.log("Fallaron:", results.filter((r) => !r.ok).map((r) => r.desc));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("ERROR EJECUTANDO EL TEST:", e);
  process.exitCode = 1;
});
