"use strict";
/**
 * Verificación puntual (no es parte de npm test) del filtro en
 * cascada Carrera -> Año -> checklist para asignar materias a un
 * docente, y de que guardarMateriasAsignadasDocente() aplica bien los
 * cambios (asigna lo tildado, libera lo destildado) sin pisar la
 * selección de un docente con la de otro.
 *
 * Uso: node scripts/verificar_asignacion_materias.js
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

function makeSandbox() {
  const updates = [];
  const sandbox = {
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
    localStorage: new FakeStorage(),
    navigator: { onLine: true },
    console,
    supabase: {
      createClient() {
        return {
          from(tabla) {
            return {
              select() { return this; },
              eq() { return this; },
              in: async () => ({ data: [], error: null }),
              maybeSingle: async () => ({ data: null, error: null }),
              upsert(payload) {
                // syncTeacherToDocenteTable(): resuelve el docente real
                // por dni y devuelve su id.
                return { select() { return this; }, single: async () => ({ data: { id: Number(payload.dni) }, error: null }) };
              },
              update(cambios) {
                if (tabla === "materias") updates.push({ id: undefined, cambios });
                return { eq: async (_col, id) => { updates[updates.length - 1].id = id; return { error: null }; } };
              },
            };
          },
        };
      },
    },
    setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout,
    URL, Blob: class {}, FileReader: class {}, Date, Math, JSON, Promise, Array, Object, Number, String, Boolean,
    // logAccion vive en auditoria.js, no en script.js - acá solo se
    // carga script.js, así que se stubea (igual que showToast).
    logAccion() {},
    showToast() {},
  };
  sandbox.window.navigator = sandbox.navigator;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "script.js" });
  return { sandbox, updates };
}

function setMateriasDeTest(sandbox, materias, materiaProfesorPorDocenteId) {
  sandbox.__materiasTest = materias;
  sandbox.__mapaTest = materiaProfesorPorDocenteId;
  vm.runInContext("currentMaterias = __materiasTest; materiaProfesorPorDocenteId = __mapaTest;", sandbox);
}

// materiasSeleccionadasDocenteIds es `let` a nivel de módulo: no es
// una propiedad de sandbox (mismo motivo que dataStore/currentMaterias
// en los otros scripts de verificación) - se lee ejecutando código
// DENTRO del contexto, no accediendo desde afuera.
function leerSeleccion(sandbox) {
  return vm.runInContext("materiasSeleccionadasDocenteIds", sandbox);
}

async function main() {
  const { sandbox, updates } = makeSandbox();
  await sandbox.loadAllData();

  const docenteA = { id: "a1", dni: "111" };
  const docenteB = { id: "b1", dni: "222" };
  const materias = [
    { id: 1, nombre: "MATEMATICA", carrera_id: 9, anio: 1, profesor_id: 111 }, // ya de A
    { id: 2, nombre: "FISICA", carrera_id: 9, anio: 1, profesor_id: null },
    { id: 3, nombre: "QUIMICA", carrera_id: 9, anio: 2, profesor_id: null },
  ];
  setMateriasDeTest(sandbox, materias, { 111: docenteA });

  console.log("\n== 1) Abrir para editar al docente A: la selección arranca con lo que YA tiene ==");
  sandbox.renderMateriasDocenteChecklist("a1");
  check("materiasSeleccionadasDocenteIds arranca con MATEMATICA (id 1)", leerSeleccion(sandbox).has(1) && leerSeleccion(sandbox).size === 1);

  console.log("\n== 2) Elegir carrera/año y tildar FISICA además ==");
  sandbox.onCambioCarreraAsignar("9");
  sandbox.onCambioAnioAsignar("1");
  sandbox.toggleMateriaSeleccionadaDocente(2, true);
  check("ahora tiene MATEMATICA + FISICA seleccionadas", leerSeleccion(sandbox).has(1) && leerSeleccion(sandbox).has(2));

  console.log("\n== 3) Sacar MATEMATICA con la X del chip ==");
  sandbox.quitarMateriaSeleccionadaDocente(1);
  check("MATEMATICA ya no está, FISICA sigue", !leerSeleccion(sandbox).has(1) && leerSeleccion(sandbox).has(2));

  console.log("\n== 4) Guardar: debe liberar MATEMATICA y asignar FISICA a docente A ==");
  await sandbox.guardarMateriasAsignadasDocente(docenteA);
  const upd1 = updates.find(u => u.cambios.profesor_id === null);
  const upd2 = updates.find(u => u.cambios.profesor_id === 111);
  check("se liberó MATEMATICA (profesor_id: null)", !!upd1 && upd1.id === 1);
  check("se asignó FISICA a docente A (profesor_id: 111, id de docentes por dni)", !!upd2 && upd2.id === 2);

  console.log("\n== 5) Abrir para OTRO docente (B) nuevo: la selección de A no debe quedar pegada ==");
  sandbox.renderMateriasDocenteChecklist(null); // "nuevo docente"
  check("selección vacía para un docente nuevo (no arrastra lo de A)", leerSeleccion(sandbox).size === 0);

  console.log("\n== 6) Volver a llamar con el MISMO id (ej: se creó una materia nueva) no debe resetear lo ya tildado ==");
  sandbox.toggleMateriaSeleccionadaDocente(3, true);
  sandbox.renderMateriasDocenteChecklist(null); // mismo "null" de antes
  check("sigue tildada QUIMICA (no se resetea por refrescar con el mismo id)", leerSeleccion(sandbox).has(3));

  console.log("\n==================================================");
  const total = results.length, ok = results.filter(r => r.ok).length;
  console.log(`RESULTADO: ${ok}/${total} verificaciones OK`);
  if (ok !== total) { console.log("Fallaron:", results.filter(r => !r.ok).map(r => r.desc)); process.exitCode = 1; }
}

main().catch(e => { console.error("ERROR EJECUTANDO EL TEST:", e); process.exitCode = 1; });
