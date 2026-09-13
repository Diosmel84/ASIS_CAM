"use strict";
/**
 * Harness de prueba: ejecuta el script.js REAL del proyecto dentro de un
 * sandbox de Node (vm) con localStorage y un cliente Supabase falsos, para
 * verificar el flujo de sincronización diferida (offline-first) sin
 * necesidad de un navegador real ni de reconocimiento facial.
 *
 * script.js es un archivo aparte cargado por index.html con
 * <script src="script.js"></script> (no inline, no ES module: las
 * funciones quedan expuestas en window porque buena parte del HTML las
 * dispara con atributos onclick=/onchange=).
 *
 * Uso: node tests/test_offline_sync.js
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const SCRIPT_PATH = path.join(__dirname, "..", "script.js");
const src = fs.readFileSync(SCRIPT_PATH, "utf8");

class FakeStorage {
  constructor() { this.store = {}; }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; }
  setItem(k, v) { this.store[k] = String(v); }
  removeItem(k) { delete this.store[k]; }
}

function makeSandbox(sharedLocalStorage) {
  const localStorage = sharedLocalStorage || new FakeStorage();
  const toasts = [];
  const upsertCalls = [];
  const state = { networkOnline: true };

  const windowListeners = {};
  const fakeWindow = {
    addEventListener(evt, cb) { (windowListeners[evt] = windowListeners[evt] || []).push(cb); },
    removeEventListener() {},
  };

  const fakeDocument = {
    addEventListener() {}, // no disparamos DOMContentLoaded: evitamos correr todo el init de la UI
    getElementById() { return null; },
    querySelectorAll() { return []; },
  };

  const fakeSupabaseModule = {
    createClient() {
      return {
        from(table) {
          return {
            select() { return this; },
            in() { return Promise.resolve({ data: [], error: null }); },
            upsert(payload) {
              upsertCalls.push({ ...payload, __online: state.networkOnline });
              if (!state.networkOnline) {
                return Promise.resolve({ error: { message: "Failed to fetch (offline simulado)" } });
              }
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };

  const sandbox = {
    window: fakeWindow,
    document: fakeDocument,
    localStorage,
    navigator: { onLine: true },
    console,
    supabase: fakeSupabaseModule,
    setInterval: (fn) => { const id = setInterval(() => {}, 1 << 30); id.unref(); return id; }, // no ejecutamos el poll real de 20s en el test
    clearInterval,
    setTimeout,
    clearTimeout,
    showToast: (msg, type) => toasts.push({ msg, type }),
    Promise, JSON, Date, Object, Array, Math, String, Number, Boolean, Error,
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "script.js" });

  // El script.js real define su PROPIA función showToast (manipula el DOM
  // para mostrar un toast visual). La pisamos recién ahora, después de
  // cargar el script, para capturar los mensajes sin necesitar un DOM real;
  // como showToast quedó declarada en el scope global del contexto, esta
  // reasignación sí es la que terminan invocando los demás listeners.
  sandbox.showToast = (msg, type) => toasts.push({ msg, type });

  return {
    sandbox,
    localStorage,
    toasts,
    upsertCalls,
    state,
    fireWindowEvent(evt) {
      return Promise.all((windowListeners[evt] || []).map((cb) => cb()));
    },
  };
}

async function tick(ms = 15) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const results = [];
  const check = (desc, cond) => {
    results.push({ desc, ok: !!cond });
    console.log((cond ? "  [OK] " : "  [FALLÓ] ") + desc);
  };

  console.log("== Paso 1: carga inicial de la app (online) ==");
  const shared = new FakeStorage();
  let env = makeSandbox(shared);
  await env.sandbox.loadAllData();
  check("dataLoaded tras loadAllData", env.sandbox.getAttendance().length === 0);
  check("no hay claves pendientes al arrancar", env.sandbox.getPendingSyncKeys().length === 0);

  console.log("\n== Paso 2: se pierde la conexión y el docente/admin guarda un fichaje ==");
  env.state.networkOnline = false;
  env.fireWindowEvent("offline");
  const nuevaAsistencia = [{ teacherId: 1, tipo: "Entrada", fecha: "2026-09-12", hora: "07:58" }];
  env.sandbox.saveAttendance(nuevaAsistencia);
  await tick();

  check("aviso de 'sin conexión' mostrado", env.toasts.some((t) => /sin conexión/i.test(t.msg)));
  check("el dato quedó guardado en localStorage (sb_cache_attendance)", JSON.parse(env.localStorage.getItem("sb_cache_attendance") || "[]").length === 1);
  check("'attendance' quedó marcada como pendiente de sincronizar", env.sandbox.getPendingSyncKeys().includes("attendance"));
  check("se avisó que el guardado a Supabase falló y se guardó localmente", env.toasts.some((t) => /se guardó localmente/i.test(t.msg)));
  check("NO se subió nada a Supabase todavía (getAttendance sigue en memoria, pero upsert fue rechazado)", env.upsertCalls.filter(c => c.key === "attendance" && !c.__online).length === 1);

  console.log("\n== Paso 3: se guarda una alerta también sin conexión (segunda colección pendiente) ==");
  env.sandbox.saveAlerts([{ teacherId: 1, tipo: "Tardanza", fecha: "2026-09-12" }]);
  await tick();
  check("'alerts' también quedó pendiente", env.sandbox.getPendingSyncKeys().sort().join(",") === "alerts,attendance");

  console.log("\n== Paso 4: vuelve la conexión -> evento 'online' dispara la sincronización sola ==");
  env.state.networkOnline = true;
  await env.fireWindowEvent("online");
  await tick(30);

  check("la cola de pendientes quedó vacía", env.sandbox.getPendingSyncKeys().length === 0);
  check("se subieron ambas colecciones a Supabase (upsert online) tras reconectar",
    env.upsertCalls.some(c => c.key === "attendance" && c.__online) &&
    env.upsertCalls.some(c => c.key === "alerts" && c.__online));
  check("el valor subido a Supabase es el dato correcto (no uno viejo)",
    JSON.stringify(env.upsertCalls.find(c => c.key === "attendance" && c.__online).value) === JSON.stringify(nuevaAsistencia));
  check("se mostró el toast de confirmación de sincronización", env.toasts.some((t) => t.type === "success" && /sincronizaron/i.test(t.msg)));

  console.log("\n== Paso 5: guardado offline + recarga de página (sin reconectar) -> el pendiente sobrevive ==");
  env.state.networkOnline = false;
  env.sandbox.saveLicenciasToStorage([{ teacherId: 2, desde: "2026-09-15", hasta: "2026-09-20" }]);
  await tick();
  check("'licencias' quedó pendiente antes de 'recargar'", env.sandbox.getPendingSyncKeys().includes("licencias"));

  // Simula un F5: nueva carga del script.js reutilizando el MISMO localStorage.
  const env2 = makeSandbox(shared);
  env2.state.networkOnline = false;
  check("tras 'recargar' la página (nuevo contexto, mismo localStorage), el pendiente sigue ahí", env2.sandbox.getPendingSyncKeys().includes("licencias"));

  console.log("\n== Paso 6: en la 'recarga', ahora SÍ hay señal -> el init llama flushPendingSync() y sincroniza solo ==");
  env2.state.networkOnline = true;
  await env2.sandbox.flushPendingSync(); // esto es exactamente lo que el listener DOMContentLoaded dispara al iniciar
  await tick(30);
  check("la licencia pendiente de la sesión anterior se sincronizó al reabrir con señal", env2.sandbox.getPendingSyncKeys().length === 0);
  check("se subió la licencia correcta a Supabase", env2.upsertCalls.some(c => c.key === "licencias" && c.__online));

  console.log("\n==================================================");
  const total = results.length, ok = results.filter(r => r.ok).length;
  console.log(`RESULTADO: ${ok}/${total} verificaciones OK`);
  if (ok !== total) {
    console.log("Fallaron:", results.filter(r => !r.ok).map(r => r.desc));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("ERROR EJECUTANDO EL TEST:", e);
  process.exitCode = 1;
});
