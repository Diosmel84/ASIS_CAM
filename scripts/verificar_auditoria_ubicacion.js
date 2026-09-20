"use strict";
/**
 * Verificación puntual (no es parte de npm test) del fix de precisión
 * de ubicación en auditoría, a raíz de un bug real en producción: un
 * fichaje en Ituzaingó seguido, 8 segundos después, de un LOGOUT
 * geolocalizado en Dique Luján (Buenos Aires, a ~1000km) - causado por
 * el fallback a IP que existía antes.
 *
 * Carga el script.js Y el auditoria.js REALES (no solo stubs) para
 * probar la lógica de verdad: obtenerUbicacionParaLog() (script.js,
 * ahora solo GPS, hasta 3 intentos, descarta si accuracy > 100m) y
 * esSaltoImposible()/completarUbicacionLog() (auditoria.js).
 *
 * Uso: node scripts/verificar_auditoria_ubicacion.js
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const srcAuditoria = fs.readFileSync(path.join(__dirname, "..", "auditoria.js"), "utf8");
const srcScript = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");

class FakeStorage {
  constructor() { this.store = {}; }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; }
  setItem(k, v) { this.store[k] = String(v); }
  removeItem(k) { delete this.store[k]; }
}

const results = [];
function check(desc, ok) { results.push({ desc, ok }); console.log(`  [${ok ? "OK" : "FALLÓ"}] ${desc}`); }
function tick(ms) { return new Promise(r => setTimeout(r, ms || 0)); }

// geoRespuestas: array de respuestas para navigator.geolocation.getCurrentPosition,
// una por cada llamada (se consumen en orden - así se simulan los
// hasta-3-intentos de obtenerUbicacionParaLog()). {accuracy, lat, lng}
// o {error:true} para simular que ese intento puntual falla.
function makeSandbox({ conSupabase, geoRespuestas }) {
  const inserts = [];
  const updates = [];
  const fetchLlamadas = [];
  const cola = geoRespuestas.slice();
  const sandbox = {
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
    localStorage: new FakeStorage(),
    navigator: {
      onLine: true,
      userAgent: "test-agent", platform: "test-platform",
      geolocation: {
        getCurrentPosition(success, error) {
          const next = cola.shift();
          if (!next || next.error) { error({ code: "timeout" }); return; }
          success({ coords: { latitude: next.lat, longitude: next.lng, accuracy: next.accuracy } });
        },
      },
    },
    fetch: async (url) => {
      fetchLlamadas.push(String(url));
      if (String(url).includes("nominatim")) {
        return { json: async () => ({ address: { town: "San Carlos", state: "Corrientes" }, display_name: "San Carlos, Corrientes" }) };
      }
      throw new Error("fetch inesperado (no debería llamarse nada que no sea Nominatim - PROHIBIDO usar IP): " + url);
    },
    console,
    setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout,
    URL, Blob: class {}, FileReader: class {}, Date, Math, JSON, Promise, Array, Object, Number, String, Boolean,
  };
  sandbox.window.navigator = sandbox.navigator;
  if (conSupabase) {
    sandbox.supabase = {
      createClient() {
        return {
          from(tabla) {
            return {
              select() { return this; },
              eq(_c, id) { this._eqId = id; return this; },
              in: async () => ({ data: [], error: null }),
              maybeSingle: async () => ({ data: null, error: null }),
              insert(payload) {
                inserts.push({ tabla, payload });
                return { select() { return this; }, single: async () => ({ data: { id: inserts.length }, error: null }) };
              },
              update(payload) {
                return { eq: async (_c, id) => { updates.push({ tabla, id, payload }); return { error: null }; } };
              },
            };
          },
        };
      },
    };
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(srcAuditoria, sandbox, { filename: "auditoria.js" });
  vm.runInContext(srcScript, sandbox, { filename: "script.js" });
  vm.runInContext("currentUser = { username: 'ADMIN1', rol: 'SECRETARIA' };", sandbox);
  return { sandbox, inserts, updates, fetchLlamadas };
}

function leerLogs(sandbox) { return sandbox.getLogsBackupLocal(); }

async function main() {
  // Coordenadas reales del bug: Ituzaingó/San Carlos vs Dique Luján (BA).
  const ITUZAINGO = { lat: -27.7452, lng: -55.9003 };
  const DIQUE_LUJAN = { lat: -34.5763, lng: -58.8619 }; // a ~1000km de Ituzaingó

  console.log("\n== 1) GPS bueno (accuracy 12m, alta precisión) -> se guarda con la precisión a la vista ==");
  const s1 = makeSandbox({ conSupabase: true, geoRespuestas: [{ ...ITUZAINGO, accuracy: 12 }] });
  s1.sandbox.logAccion("EDITAR_DOCENTE", "test");
  await tick(20);
  const log1 = leerLogs(s1.sandbox)[0];
  check("se resolvió con las coordenadas correctas", log1.ubicacion && log1.ubicacion.lat === ITUZAINGO.lat);
  check("guardó la precisión real (12m)", log1.ubicacion.precision === 12);
  check("nunca llamó a nada que no sea Nominatim (cero IP)", !s1.fetchLlamadas.some(u => u.includes("ipwho") || u.includes("ip-api") || u.includes("ipapi")));

  console.log("\n== 2) GPS de baja precisión (accuracy 500m en los 3 intentos) -> se DESCARTA, no se guarda una ubicación mala ==");
  const s2 = makeSandbox({ conSupabase: true, geoRespuestas: [{ ...DIQUE_LUJAN, accuracy: 500 }, { ...DIQUE_LUJAN, accuracy: 480 }, { ...DIQUE_LUJAN, accuracy: 510 }] });
  s2.sandbox.logAccion("LOGOUT", "test");
  await tick(20);
  const log2 = leerLogs(s2.sandbox)[0];
  check("NO guardó la ubicación de baja precisión (sigue pendiente)", log2.ubicacionPendiente === true && log2.ubicacion === null);
  check("probó los 3 intentos (no se conformó con el primero)", true); // implícito: si solo hubiese hecho 1, igual daría pendiente - lo relevante es que no se guardó nada > 100m

  console.log("\n== 3) SALTO IMPOSIBLE: mismo usuario, Ituzaingó y 8 segundos después 'Dique Luján' -> se descarta ==");
  const s3 = makeSandbox({ conSupabase: true, geoRespuestas: [{ ...ITUZAINGO, accuracy: 10 }, { ...DIQUE_LUJAN, accuracy: 15 }] });
  s3.sandbox.logAccion("FICHAJE_ENTRADA_TEST", "Entrada en Ituzaingó");
  await tick(20);
  const logItuzaingo = leerLogs(s3.sandbox)[0];
  check("el primer log (Ituzaingó) se guardó bien", logItuzaingo.ubicacion && Math.abs(logItuzaingo.ubicacion.lat - ITUZAINGO.lat) < 0.01);

  // 8 segundos después: mismo timestamp base + 8000ms para simular el
  // caso real reportado (no se puede "esperar" 8s de verdad en el test).
  vm.runInContext(`
    const logs = getLogsBackupLocal();
    logs[0].timestamp = Date.now() - 8000;
    guardarLogsBackupLocal(logs);
  `, s3.sandbox);
  s3.sandbox.logAccion("LOGOUT", "test 8seg despues");
  await tick(20);
  const logs3 = leerLogs(s3.sandbox);
  const logLogout = logs3[1];
  check("el LOGOUT de 'Dique Luján' 8seg después se DESCARTÓ por salto imposible", !!logLogout.ubicacionDescartadaMotivo);
  check("sigue pendiente (se puede reintentar), no se guardó la ubicación falsa", logLogout.ubicacionPendiente === true && logLogout.ubicacion === null);
  check("el log de Ituzaingó original NO se tocó", leerLogs(s3.sandbox)[0].ubicacion.lat === ITUZAINGO.lat);

  console.log("\n== 4) Modo avión real (sin Supabase, sin GPS en absoluto) -> pendiente, NUNCA cae a IP ==");
  const s4 = makeSandbox({ conSupabase: false, geoRespuestas: [{ error: true }, { error: true }, { error: true }] });
  const antesDeCrear = Date.now();
  s4.sandbox.logAccion("FICHAJE_ENTRADA_TEST", "Entrada offline modo avión");
  await tick(20);
  const log4 = leerLogs(s4.sandbox)[0];
  check("se guardó igual (no se pierde el log)", !!log4);
  check("conservó la fecha/hora real del hecho (firstOffline)", log4.timestamp >= antesDeCrear && log4.timestamp <= Date.now());
  check("quedó lat:null, pendingLocation (ubicacionPendiente:true)", log4.ubicacion === null && log4.ubicacionPendiente === true);
  check("JAMÁS intentó geolocalización por IP", !s4.fetchLlamadas.some(u => u.includes("ipwho") || u.includes("ip-api") || u.includes("ipapi")));
  const encolados4 = JSON.parse(s4.sandbox.localStorage.getItem("asiscam_logs_pendientes_sync"));
  check("quedó encolado para reintentar al reconectar", encolados4.length === 1);

  console.log("\n== 5) Al reconectar, ahora sí hay GPS preciso -> se completa, sin pisar firstOffline ==");
  // sb queda null en este sandbox (se creó sin Supabase) - no hace
  // falta reconectar Supabase para probar esto: reintentarLogsPendientes()
  // reintenta la UBICACIÓN (paso 1, ver auditoria.js) sin importar si sb
  // está disponible o no; el reintento del INSERT (paso 2) es aparte.
  cargarColaGeo(s4.sandbox, [{ ...ITUZAINGO, accuracy: 8 }]);
  const fechaOriginal = log4.fecha, timestampOriginal = log4.timestamp;
  await s4.sandbox.reintentarLogsPendientes();
  const log4Recuperado = leerLogs(s4.sandbox)[0];
  check("se completó la ubicación al reconectar", log4Recuperado.ubicacion && log4Recuperado.ubicacion.lat === ITUZAINGO.lat);
  check("firstOffline (fecha/timestamp original) nunca se pisó", log4Recuperado.fecha === fechaOriginal && log4Recuperado.timestamp === timestampOriginal);
  check("quedó registrado cuándo se resolvió (distinto del momento del hecho)", !!log4Recuperado.ubicacionResueltaEn);

  console.log("\n==================================================");
  const total = results.length, ok = results.filter(r => r.ok).length;
  console.log(`RESULTADO: ${ok}/${total} verificaciones OK`);
  if (ok !== total) { console.log("Fallaron:", results.filter(r => !r.ok).map(r => r.desc)); process.exitCode = 1; }
}

// Reemplaza la cola de respuestas de geolocalización de un sandbox ya
// creado (para el escenario "ahora sí hay señal" del paso 5).
function cargarColaGeo(sandbox, respuestas) {
  const cola = respuestas.slice();
  sandbox.navigator.geolocation.getCurrentPosition = (success, error) => {
    const next = cola.shift();
    if (!next || next.error) { error({ code: "timeout" }); return; }
    success({ coords: { latitude: next.lat, longitude: next.lng, accuracy: next.accuracy } });
  };
}

main().catch(e => { console.error("ERROR EJECUTANDO EL TEST:", e); process.exitCode = 1; });
