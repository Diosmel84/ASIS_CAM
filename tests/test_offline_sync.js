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
  // serverData simula lo que hay REALMENTE guardado en Supabase en cada
  // momento -independiente de dataStore/localStorage-, para poder probar
  // el caso en que un guardado local todavía no llegó a subirse: la
  // lectura "fresca" (.eq().maybeSingle(), usada por
  // fetchFreshAppDataValue) y la carga en bloque (.in(), usada por
  // loadAllData) tienen que devolver lo que hay en serverData, que puede
  // seguir siendo el valor viejo aunque dataStore ya tenga el nuevo.
  const state = { networkOnline: true, failUpsertFor: new Set(), serverData: {} };

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

  function networkFailure() {
    return { message: "Failed to fetch (offline simulado)" };
  }

  const fakeSupabaseModule = {
    createClient() {
      return {
        from() {
          let eqValue;
          const builder = {
            select() { return builder; },
            eq(_col, value) { eqValue = value; return builder; },
            in(_col, keys) {
              if (!state.networkOnline) return Promise.resolve({ data: null, error: networkFailure() });
              const rows = keys
                .filter((k) => Object.prototype.hasOwnProperty.call(state.serverData, k))
                .map((k) => ({ key: k, value: state.serverData[k] }));
              return Promise.resolve({ data: rows, error: null });
            },
            maybeSingle() {
              if (!state.networkOnline) return Promise.resolve({ data: null, error: networkFailure() });
              const has = Object.prototype.hasOwnProperty.call(state.serverData, eqValue);
              return Promise.resolve({ data: has ? { value: state.serverData[eqValue] } : null, error: null });
            },
            upsert(payload) {
              upsertCalls.push({ ...payload, __online: state.networkOnline });
              if (!state.networkOnline || state.failUpsertFor.has(payload.key)) {
                return Promise.resolve({ error: networkFailure() });
              }
              state.serverData[payload.key] = payload.value;
              return Promise.resolve({ error: null });
            },
          };
          return builder;
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

  console.log("\n== Paso 7: bug real reportado -> una lectura 'fresca' de Supabase no debe pisar un cambio de geocerca aún pendiente ==");
  const env3 = makeSandbox(new FakeStorage());
  await env3.sandbox.loadAllData(); // arranca sin nada guardado todavía
  const ubicacionVieja = { lat: -27.747601, lng: -55.888582, radio: 150, nombreLugar: "Colegio Secundario De San Carlos", actualizadoPor: "sistema", actualizadoEn: null };
  const ubicacionNueva = { lat: -27.5, lng: -55.9, radio: 200, nombreLugar: "Nueva sede", actualizadoPor: "admin", actualizadoEn: new Date().toISOString() };
  // El admin ya había guardado la ubicación vieja en una sesión anterior
  // (esto sí llega a Supabase: todavía no simulamos ninguna falla).
  env3.sandbox.saveGeofenceConfig(ubicacionVieja);
  await tick();
  check("la ubicación vieja quedó sincronizada en el 'servidor'", env3.state.serverData.geofence.nombreLugar === ubicacionVieja.nombreLugar);

  // El admin cambia la ubicación, pero justo en ese momento el guardado
  // a Supabase falla (wifi de la escuela, típicamente) - la app SÍ queda
  // con el valor nuevo en memoria y en localStorage, pero Supabase se
  // queda con el viejo.
  env3.state.failUpsertFor.add("geofence");
  env3.sandbox.saveGeofenceConfig(ubicacionNueva);
  await tick();
  env3.state.failUpsertFor.delete("geofence"); // la red en sí sigue andando para todo lo demás (ver Paso 7b)
  check("'geofence' quedó pendiente tras el guardado fallido", env3.sandbox.getPendingSyncKeys().includes("geofence"));
  check("dataStore ya tiene la ubicación NUEVA en memoria", env3.sandbox.getGeofenceConfig().nombreLugar === ubicacionNueva.nombreLugar);
  check("Supabase ('servidor') se quedó con la ubicación VIEJA", env3.state.serverData.geofence.nombreLugar === ubicacionVieja.nombreLugar);

  // Ahora el docente intenta fichar: verifyGeofence() llama a
  // fetchFreshAppDataValue('geofence', ...), que SÍ logra conectarse a
  // Supabase (la red anda) y Supabase todavía tiene la ubicación vieja.
  // Antes del fix, esto pisaba dataStore.geofence y el localStorage con
  // el valor viejo; con el fix, como "geofence" sigue pendiente, no se
  // toca nada.
  const geofenceUsadaParaFichar = await env3.sandbox.fetchFreshAppDataValue("geofence", env3.sandbox.getGeofenceConfig);
  check("el fichaje del docente usa la ubicación NUEVA, no la vieja del servidor", geofenceUsadaParaFichar.nombreLugar === ubicacionNueva.nombreLugar);
  check("dataStore.geofence sigue siendo la ubicación NUEVA después de la lectura 'fresca'", env3.sandbox.getGeofenceConfig().nombreLugar === ubicacionNueva.nombreLugar);
  check("el localStorage (sb_cache_geofence) NO quedó pisado con la ubicación vieja", JSON.parse(env3.localStorage.getItem("sb_cache_geofence")).nombreLugar === ubicacionNueva.nombreLugar);

  console.log("\n== Paso 7b: lo mismo, pero simulando una recarga completa (loadAllData) en vez de fetchFreshAppDataValue ==");
  const env4 = makeSandbox(env3.localStorage); // mismo dispositivo: comparte localStorage con env3
  env4.state.serverData = env3.state.serverData; // y el mismo "Supabase" (todavía con la ubicación vieja)
  await env4.sandbox.loadAllData();
  check("tras 'recargar' la app, dataStore.geofence sigue siendo la ubicación NUEVA (no la vieja que trajo loadAllData)", env4.sandbox.getGeofenceConfig().nombreLugar === ubicacionNueva.nombreLugar);

  console.log("\n== Paso 7c: al reconectar del todo, se termina subiendo la ubicación correcta (la nueva, no la vieja) ==");
  await env4.sandbox.flushPendingSync();
  await tick(30);
  check("'geofence' ya no queda pendiente", env4.sandbox.getPendingSyncKeys().length === 0);
  check("lo que terminó subiéndose a Supabase es la ubicación NUEVA", env4.state.serverData.geofence.nombreLugar === ubicacionNueva.nombreLugar);

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
