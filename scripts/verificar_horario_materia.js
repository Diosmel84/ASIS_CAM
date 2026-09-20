"use strict";
/**
 * Verificación puntual (no es parte de npm test) del cambio "horario
 * por materia": un docente sin materias sigue usando su horario_laboral
 * propio intacto; con 1+ materias, el horario efectivo es la unión de
 * todas, y el fichaje puede filtrar a UNA materia puntual (selector
 * "¿para qué materia fichás hoy?").
 *
 * Uso: node scripts/verificar_horario_materia.js
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
  const sandbox = {
    window: { addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
    localStorage: new FakeStorage(),
    navigator: { onLine: true },
    fetch: async () => { throw new Error("no debería llamarse fetch acá"); },
    console,
    supabase: { createClient() { return { from() { return { select() { return this; }, eq() { return this; }, in: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: null, error: null }), upsert: async () => ({ error: null }) }; } }; } },
    setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout,
    URL, Blob: class {}, FileReader: class {}, Date, Math, JSON, Promise, Array, Object, Number, String, Boolean,
  };
  sandbox.window.navigator = sandbox.navigator;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "script.js" });
  return sandbox;
}

// currentMaterias/materiaProfesorPorDocenteId son `let` a nivel de
// módulo en script.js: vm no los expone como propiedades de sandbox
// (igual que dataStore), así que para pisarlos desde este test hay
// que ejecutar la asignación DENTRO del contexto, no hacer
// sandbox.currentMaterias = ... desde afuera (eso solo crea una
// propiedad nueva que la función real nunca lee).
function setMateriasDeTest(sandbox, materias, materiaProfesorPorDocenteId) {
  sandbox.__materiasTest = materias;
  sandbox.__mapaTest = materiaProfesorPorDocenteId;
  vm.runInContext("currentMaterias = __materiasTest; materiaProfesorPorDocenteId = __mapaTest;", sandbox);
}

async function main() {
  const sandbox = makeSandbox();
  await sandbox.loadAllData();

  console.log("\n== 1) Docente SIN materias -> sigue usando su horario_laboral propio, intacto ==");
  const sinMaterias = { id: "t1", horario_laboral: [{ dia: "Lunes", inicio: "08:00", fin: "12:00" }] };
  setMateriasDeTest(sandbox, [], {});
  const efectivoSinMaterias = sandbox.getHorarioEfectivo(sinMaterias);
  check("getMateriasDeDocente() da vacío", sandbox.getMateriasDeDocente("t1").length === 0);
  check("getHorarioEfectivo() = su horario_laboral tal cual (no se le borró nada)", JSON.stringify(efectivoSinMaterias) === JSON.stringify(sinMaterias.horario_laboral));

  console.log("\n== 2) Docente con 1 materia -> el horario sale de la materia, no del docente ==");
  const conUnaMateria = { id: "t2", horario_laboral: [{ dia: "Martes", inicio: "07:00", fin: "07:40" }] }; // horario viejo, ya no debería usarse
  setMateriasDeTest(sandbox, [{ id: 100, nombre: "MATEMATICA", profesor_id: 555, horarios: [{ dia: "Lunes", inicio: "18:00", fin: "20:00" }] }], { 555: conUnaMateria });
  const materiasT2 = sandbox.getMateriasDeDocente("t2");
  check("tiene exactamente 1 materia", materiasT2.length === 1 && materiasT2[0].nombre === "MATEMATICA");
  const efectivoT2 = sandbox.getHorarioEfectivo(conUnaMateria);
  check("el horario efectivo es el de la MATERIA (Lunes 18-20), no el horario_laboral viejo (Martes)", efectivoT2.length === 1 && efectivoT2[0].dia === "Lunes" && efectivoT2[0].inicio === "18:00");
  check("getEarliestScheduleTime() para el Lunes da 18:00", sandbox.getEarliestScheduleTime(conUnaMateria, "Lunes") === "18:00");
  check("getEarliestScheduleTime() para el Martes da null (esa materia no tiene Martes)", sandbox.getEarliestScheduleTime(conUnaMateria, "Martes") === null);

  console.log("\n== 3) Docente con 2 materias -> horario efectivo es la UNIÓN, y se puede filtrar a una sola ==");
  const conDosMaterias = { id: "t3" };
  setMateriasDeTest(sandbox, [
    { id: 200, nombre: "ARQUITECTURA", profesor_id: 777, horarios: [{ dia: "Miércoles", inicio: "18:00", fin: "20:00" }] },
    { id: 201, nombre: "LABORATORIO", profesor_id: 777, horarios: [{ dia: "Viernes", inicio: "21:20", fin: "22:40" }] },
  ], { 777: conDosMaterias });
  const materiasT3 = sandbox.getMateriasDeDocente("t3");
  check("tiene 2 materias (Díaz Darío, caso real)", materiasT3.length === 2);
  const efectivoT3 = sandbox.getHorarioEfectivo(conDosMaterias);
  check("el horario efectivo tiene los 2 bloques (unión)", efectivoT3.length === 2);
  check("getEarliestScheduleTime() sin materiaId (unión) encuentra el Miércoles", sandbox.getEarliestScheduleTime(conDosMaterias, "Miércoles") === "18:00");
  check("getEarliestScheduleTime() sin materiaId (unión) encuentra el Viernes también", sandbox.getEarliestScheduleTime(conDosMaterias, "Viernes") === "21:20");
  check("...pero filtrando a la materia 200 (ARQUITECTURA), el Viernes ya no aparece", sandbox.getEarliestScheduleTime(conDosMaterias, "Viernes", 200) === null);
  check("...y filtrando a la materia 201 (LABORATORIO), el Viernes sí aparece", sandbox.getEarliestScheduleTime(conDosMaterias, "Viernes", 201) === "21:20");

  console.log("\n==================================================");
  const total = results.length, ok = results.filter(r => r.ok).length;
  console.log(`RESULTADO: ${ok}/${total} verificaciones OK`);
  if (ok !== total) { console.log("Fallaron:", results.filter(r => !r.ok).map(r => r.desc)); process.exitCode = 1; }
}

main().catch(e => { console.error("ERROR EJECUTANDO EL TEST:", e); process.exitCode = 1; });
