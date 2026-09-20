"use strict";
/**
 * Verificación puntual (no es parte de npm test) del fichaje en modo
 * avión real: WiFi/datos apagados (navigator.onLine = false) pero el
 * chip GPS sí consigue posición satelital (lo más común en modo avión
 * con "Ubicación" activada) - a diferencia de tests/test_offline_sync.js,
 * que solo prueba el caso "GPS también falla".
 *
 * Reusa la misma técnica que test_offline_sync.js (vm + script.js real).
 *
 * Uso: node scripts/verificar_modo_avion.js
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");

class FakeStorage {
  constructor() { this.store = {}; }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; }
  setItem(k, v) { this.store[k] = String(v); }
  removeItem(k) { delete this.store[k]; }
}

const results = [];
function check(desc, ok) { results.push({ desc, ok }); console.log(`  [${ok ? "OK" : "FALLÓ"}] ${desc}`); }

async function main() {
  const localStorage = new FakeStorage();
  // Escuela en (0,0) para simplificar: el docente ficha a 80mts (Haversine
  // de un desplazamiento chico en grados), dentro del radio 220 default.
  const ESCUELA_LAT = -27.7471404, ESCUELA_LNG = -55.9001535;
  const DOCENTE_LAT = ESCUELA_LAT + 0.0005, DOCENTE_LNG = ESCUELA_LNG; // ~55mts al norte

  let fetchLlamado = 0;
  const fakeFetch = async (url) => {
    fetchLlamado++;
    if (String(url).includes("nominatim")) {
      return { json: async () => ({ address: { town: "San Carlos", state: "Corrientes" }, display_name: "San Carlos, Corrientes, Argentina" }) };
    }
    if (String(url).includes("ipwho.is")) {
      return { json: async () => ({ success: true, ip: "190.190.190.190" }) };
    }
    throw new Error("fetch no esperado: " + url);
  };

  const sandbox = {
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
    localStorage,
    navigator: {
      onLine: false, // modo avión: sin datos/wifi
      geolocation: {
        // A diferencia del test oficial (sin navigator.geolocation en
        // absoluto = simula GPS que ni siquiera está disponible), acá
        // SÍ hay chip GPS y consigue fix satelital (independiente de
        // la red, que es justo el punto de este test).
        getCurrentPosition(success) {
          success({ coords: { latitude: DOCENTE_LAT, longitude: DOCENTE_LNG, accuracy: 12 } });
        },
      },
    },
    fetch: fakeFetch,
    console,
    supabase: { createClient() { return { from() { return { select() { return this; }, eq() { return this; }, in: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: null, error: null }), upsert: async () => ({ error: null }) }; } }; } },
    setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout,
    URL, Blob: class {}, FileReader: class {}, Date, Math, JSON, Promise, Array, Object, Number, String, Boolean,
  };
  sandbox.window.navigator = sandbox.navigator;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "script.js" });
  await sandbox.loadAllData();
  // dataStore es `let` a nivel de módulo en script.js: vm no lo expone
  // como propiedad de sandbox (a diferencia de las function
  // declarations), así que se setea por la función real de la app.
  sandbox.saveGeofenceConfig({ lat: ESCUELA_LAT, lng: ESCUELA_LNG, radio: 220, nombreLugar: "Colegio Secundario De San Carlos" });

  console.log("\n== 1) Modo avión: WiFi/datos apagados, GPS SÍ consigue fix ==");
  const geo = await sandbox.verifyGeofence();
  check("verifyGeofence() no bloquea (ok:true) - el GPS funcionó sin red", geo.ok === true);
  check("NO usa el bypass 'offline_sin_gps' (no hizo falta: el GPS respondió)", geo.bypass !== "offline_sin_gps");
  check("la distancia a la escuela se calculó offline con Haversine (sin red)", Number.isFinite(geo.distance) && geo.distance > 0 && geo.distance < 220);
  check("coords reales del fichaje quedaron guardadas", geo.coords && geo.coords.lat === DOCENTE_LAT);
  check("precisión (accuracy) del GPS capturada", geo.precision === 12);

  console.log("\n== 2) Los campos que se guardan en el fichaje salen bien, sin red ==");
  const campos = sandbox.geoFichajeFields(geo);
  check("fichajeLat/Lng correctos", campos.fichajeLat === DOCENTE_LAT && campos.fichajeLng === DOCENTE_LNG);
  check("fichajeDistanciaMts calculada (offline)", Number.isFinite(campos.fichajeDistanciaMts));
  check("dentroGeocerca = true (está a ~55mts, dentro del radio 220)", campos.dentroGeocerca === true);
  check("syncUbicacion arranca 'pendiente' (dirección/IP todavía no se pidieron, no hay red)", campos.syncUbicacion === "pendiente");
  check("fetch NO se llamó todavía (nada de red hasta que se pida explícito)", fetchLlamado === 0);

  console.log("\n== 3) Vuelve el WiFi: se completa dirección (Nominatim) + IP (ipwho.is) ==");
  sandbox.navigator.onLine = true;
  const attendance = [{ id: "avion-1", teacherId: 1, ...campos, horaFichajeReal: new Date(Date.now() - 20 * 60000).toISOString(), timestamp: new Date(Date.now() - 20 * 60000).toISOString() }];
  sandbox.saveAttendance(attendance);
  await sandbox.completarDireccionEIp("avion-1", campos.fichajeLat, campos.fichajeLng, "attendance");
  const registro = sandbox.getAttendance().find(a => a.id === "avion-1");
  check("se llamó a Nominatim e ipwho.is (2 fetch)", fetchLlamado === 2);
  check("direccionFichaje se completó", registro.direccionFichaje === "San Carlos, Corrientes");
  check("IP se completó", registro.ip === "190.190.190.190");
  check("syncUbicacion pasa a 'completo'", registro.syncUbicacion === "completo");

  console.log("\n== 4) Fichó hace 20min (offline) y recién ahora sincronizó -> debe marcar DIFERIDO ==");
  const diffMin = sandbox.minutosDiferidoFichaje(registro);
  check("la diferencia da ~20 minutos", diffMin >= 19 && diffMin <= 21);
  check("esFichajeDiferido() = true (>15min)", sandbox.esFichajeDiferido(registro) === true);
  check("textoDistanciaFichaje() dice 'EN ESCUELA'", sandbox.textoDistanciaFichaje(registro).startsWith("EN ESCUELA"));

  console.log("\n== 5) Fichó en su casa, lejos de la escuela, en modo avión ==");
  const geoLejos = { ok: false, reason: "geofence", distance: 850, geofence: { radio: 220 }, coords: { lat: DOCENTE_LAT + 0.01, lng: DOCENTE_LNG }, precision: 15, fakeGpsSospechoso: false };
  const camposLejos = sandbox.geoFichajeFields(geoLejos);
  check("dentroGeocerca = false (850mts > radio 220)", camposLejos.dentroGeocerca === false);
  check("textoDistanciaFichaje() dice 'FUERA DE RANGO'", sandbox.textoDistanciaFichaje({ ...camposLejos }).startsWith("FUERA DE RANGO"));

  console.log("\n==================================================");
  const total = results.length, ok = results.filter(r => r.ok).length;
  console.log(`RESULTADO: ${ok}/${total} verificaciones OK`);
  if (ok !== total) { console.log("Fallaron:", results.filter(r => !r.ok).map(r => r.desc)); process.exitCode = 1; }
}

main().catch(e => { console.error("ERROR EJECUTANDO EL TEST:", e); process.exitCode = 1; });
