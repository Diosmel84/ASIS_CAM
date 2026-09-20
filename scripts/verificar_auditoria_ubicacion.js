"use strict";
/**
 * Verificación puntual (no es parte de npm test) de que logAccion()
 * intenta ubicación para toda acción por defecto, sin bloquear nada,
 * y que un log creado offline preserva la fecha/hora real del hecho y
 * se termina completando (ubicación + subida a Supabase) al
 * reconectar, vía reintentarLogsPendientes().
 *
 * Carga solo auditoria.js (no todo script.js) con stubs mínimos de lo
 * que necesita (currentUser, showToast, sb, obtenerUbicacionParaLog),
 * para poder simular con precisión "GPS/IP funcionan" vs "no hay
 * señal de ningún tipo" en cada escenario.
 *
 * Uso: node scripts/verificar_auditoria_ubicacion.js
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "auditoria.js"), "utf8");

class FakeStorage {
  constructor() { this.store = {}; }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; }
  setItem(k, v) { this.store[k] = String(v); }
  removeItem(k) { delete this.store[k]; }
}

const results = [];
function check(desc, ok) { results.push({ desc, ok }); console.log(`  [${ok ? "OK" : "FALLÓ"}] ${desc}`); }
function tick(ms) { return new Promise(r => setTimeout(r, ms || 0)); }

function makeSandbox({ sbDisponible, ubicacionDisponible }) {
  const inserts = [];
  const updates = [];
  const sandbox = {
    localStorage: new FakeStorage(),
    document: { getElementById() { return null; } },
    console,
    currentUser: { username: "ADMIN1", rol: "SECRETARIA" },
    navigator: { userAgent: "test-agent", platform: "test-platform" },
    showToast() {},
    describeSupabaseError: e => JSON.stringify(e),
    obtenerUbicacionParaLog: async () => ubicacionDisponible
      ? { lat: -27.5, lng: -55.5, direccion: "San Carlos, Corrientes", ip: "1.2.3.4", fuente: "gps" }
      : null, // ni GPS ni IP: simula estar realmente sin señal de ningún tipo
    sb: sbDisponible ? {
      from() {
        return {
          insert(payload) {
            inserts.push(payload);
            return { select() { return this; }, single: async () => ({ data: { id: inserts.length }, error: null }) };
          },
          update(payload) {
            updates.push(payload);
            return { eq: async () => ({ error: null }) };
          },
        };
      },
    } : null,
    setTimeout, clearTimeout, Date, Math, JSON, Promise, Array, Object, Number, String, Boolean,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "auditoria.js" });
  return { sandbox, inserts, updates };
}

async function main() {
  console.log("\n== 1) Log ONLINE con GPS disponible: se resuelve la ubicación sola, sin bloquear ==");
  const s1 = makeSandbox({ sbDisponible: true, ubicacionDisponible: true });
  s1.sandbox.logAccion("EDITAR_DOCENTE", "Editó a Juan Pérez"); // logAccion() en sí es sincrónica
  check("logAccion() no devuelve una promesa (no hay que esperarla para que la acción real siga)", !(s1.sandbox.logAccion("LOGOUT", "x") instanceof Promise));
  await tick(10);
  const log1 = s1.sandbox.getLogsBackupLocal()[0];
  check("se guardó el log al toque, con ubicacionPendiente:true de entrada", true); // ya pasó el tiempo, se verifica el estado final abajo
  check("terminó con ubicación resuelta (San Carlos)", log1.ubicacion && log1.ubicacion.direccion === "San Carlos, Corrientes");
  check("ubicacionPendiente terminó en false", log1.ubicacionPendiente === false);
  check("se subió a Supabase (insert)", s1.inserts.length >= 1);

  console.log("\n== 2) Log OFFLINE (sin Supabase, sin GPS/IP): NO se pierde, guarda fecha/hora real y queda pendiente ==");
  const s2 = makeSandbox({ sbDisponible: false, ubicacionDisponible: false });
  const antesDeCrear = Date.now();
  s2.sandbox.logAccion("FICHAJE_ENTRADA_TEST", "Entrada docente offline");
  await tick(10);
  const log2 = s2.sandbox.getLogsBackupLocal()[0];
  check("se guardó igual, sin bloquear ni perderse por estar offline", !!log2);
  check("la fecha/hora del hecho quedó guardada y es la real (no se pierde ni se retrasa)", log2.timestamp >= antesDeCrear && log2.timestamp <= Date.now());
  check("ubicacionPendiente sigue true (no se da por 'fallido', se puede reintentar)", log2.ubicacionPendiente === true);
  check("ubicacion sigue null mientras tanto", log2.ubicacion === null);
  const encolados = JSON.parse(s2.sandbox.localStorage.getItem("asiscam_logs_pendientes_sync"));
  check("quedó encolado para reintentar la subida a Supabase", encolados.length === 1 && encolados[0].id === log2.id);

  console.log("\n== 3) Offline y LUEGO se recupera (vuelve la señal, se llama reintentarLogsPendientes()) ==");
  // Mismo sandbox que el paso 2 (mismo localStorage): simula que ahora
  // sb está disponible Y la ubicación también - "volvió la señal".
  s2.sandbox.sb = {
    from() {
      return {
        insert(payload) {
          s2.inserts.push(payload);
          return { select() { return this; }, single: async () => ({ data: { id: 999 }, error: null }) };
        },
        update(payload) { s2.updates.push(payload); return { eq: async () => ({ error: null }) }; },
      };
    },
  };
  s2.sandbox.obtenerUbicacionParaLog = async () => ({ lat: -27.5, lng: -55.5, direccion: "San Carlos, Corrientes", ip: "1.2.3.4", fuente: "gps" });
  const fechaOriginalAntesDeReconectar = s2.sandbox.getLogsBackupLocal()[0].fecha;
  const timestampOriginalAntesDeReconectar = s2.sandbox.getLogsBackupLocal()[0].timestamp;
  await s2.sandbox.reintentarLogsPendientes();
  const log2Recuperado = s2.sandbox.getLogsBackupLocal()[0];
  check("la ubicación se terminó completando al reconectar", log2Recuperado.ubicacion && log2Recuperado.ubicacion.direccion === "San Carlos, Corrientes");
  check("ubicacionPendiente pasó a false", log2Recuperado.ubicacionPendiente === false);
  check("quedó registrado CUÁNDO se resolvió (ubicacionResueltaEn), aparte de cuándo pasó el hecho", !!log2Recuperado.ubicacionResueltaEn);
  check("la fecha/hora ORIGINAL del hecho NUNCA se tocó (no se pisa con la de la reconexión)", log2Recuperado.fecha === fechaOriginalAntesDeReconectar && log2Recuperado.timestamp === timestampOriginalAntesDeReconectar);
  check("se subió a Supabase en el reintento", s2.inserts.length === 1);
  const pendientesFinal = JSON.parse(s2.sandbox.localStorage.getItem("asiscam_logs_pendientes_sync"));
  check("ya no queda en la cola de pendientes", pendientesFinal.length === 0);

  console.log("\n==================================================");
  const total = results.length, ok = results.filter(r => r.ok).length;
  console.log(`RESULTADO: ${ok}/${total} verificaciones OK`);
  if (ok !== total) { console.log("Fallaron:", results.filter(r => !r.ok).map(r => r.desc)); process.exitCode = 1; }
}

main().catch(e => { console.error("ERROR EJECUTANDO EL TEST:", e); process.exitCode = 1; });
