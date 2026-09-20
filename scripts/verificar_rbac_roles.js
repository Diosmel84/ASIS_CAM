"use strict";
/**
 * Verificación puntual (no es parte de npm test) de los permisos por
 * rol agregados/reforzados en las últimas sesiones (RBAC etapa 1):
 * justificar_alerta, ver_reportes/exportar_reportes, ver_auditoria/
 * gestionar_auditoria/backup_restore, editar_criterios_puntualidad.
 *
 * No hay extensión de Chrome disponible en esta sesión para probar
 * SECRETARIA/RECTOR en el sitio real, así que esto simula ambos roles
 * cargando roles.js + auditoria.js + script.js en el mismo sandbox
 * (mismo patrón que los demás scripts/verificar_*.js) y llamando
 * directo a las funciones reales - no es "ver la pantalla", pero
 * confirma que la lógica de cada gate hace lo que debería para cada
 * rol, incluida la que YA estaba en el código antes de tocar nada
 * (create/update sin delete para Secretaría).
 *
 * Uso: node scripts/verificar_rbac_roles.js
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const rolesSrc = fs.readFileSync(path.join(__dirname, "..", "roles.js"), "utf8");
const auditoriaSrc = fs.readFileSync(path.join(__dirname, "..", "auditoria.js"), "utf8");
const scriptSrc = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");

const results = [];
function check(desc, ok) { results.push({ desc, ok }); console.log(`  [${ok ? "OK" : "FALLÓ"}] ${desc}`); }

class FakeStorage {
  constructor() { this.store = {}; }
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; }
  setItem(k, v) { this.store[k] = String(v); }
  removeItem(k) { delete this.store[k]; }
}

// Elemento DOM genérico: soporta value/disabled/innerHTML/textContent/
// classList.toggle-add-remove-contains para cualquier id, sin tener
// que declarar cada uno de antemano - los formularios que tocamos acá
// (alertas, criterios de puntualidad) usan ids simples de <input>/<div>.
class FakeElement {
  constructor(id) {
    this.id = id;
    this._value = "";
    this.disabled = false;
    this.innerHTML = "";
    this.textContent = "";
    this.style = {};
    const self = this;
    this.classList = {
      _set: new Set(),
      toggle(cls, force) {
        const has = this._set.has(cls);
        const want = force === undefined ? !has : !!force;
        if (want) this._set.add(cls); else this._set.delete(cls);
        return want;
      },
      add(cls) { this._set.add(cls); },
      remove(cls) { this._set.delete(cls); },
      contains(cls) { return this._set.has(cls); },
    };
  }
  get value() { return this._value; }
  set value(v) { this._value = v; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild() {}
  click() {}
}

function makeSandbox() {
  const elements = new Map();
  const getByIdCalls = [];
  function getElementById(id) {
    getByIdCalls.push(id);
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  }

  const toasts = [];
  const logs = [];
  const confirmAnswers = []; // .pop() cada vez que corre confirm()

  const sandbox = {
    window: { addEventListener() {}, removeEventListener() {}, ASISCAM_CRED_HASHES: {} },
    document: {
      addEventListener() {},
      getElementById,
      querySelectorAll() { return []; },
      createElement() { return new FakeElement("__created__"); },
      body: { appendChild() {}, removeChild() {} },
    },
    localStorage: new FakeStorage(),
    navigator: { onLine: true, userAgent: "test", platform: "test" },
    console,
    crypto: require("crypto").webcrypto,
    confirm: () => (confirmAnswers.length ? confirmAnswers.pop() : true),
    alert() {},
    bootstrap: { Modal: class { show() {} hide() {} static getInstance() { return null; } }, Tab: { getOrCreateInstance() { return { show() {} }; } } },
    supabase: {
      createClient() {
        return {
          from(tabla) {
            return {
              select() { return this; },
              eq() { return this; },
              order() { return this; },
              limit() { return this; },
              in: async () => ({ data: [], error: null }),
              maybeSingle: async () => ({ data: null, error: null }),
              single: async () => ({ data: { id: 1 }, error: null }),
              // upsert()/insert() de app_data y auditoria_logs se usan de
              // 2 formas distintas en el código real: con await (RPC-like)
              // y con .then() fire-and-forget (persistToSupabase) - el
              // stub tiene que servir para las dos, por eso el objeto que
              // devuelve upsert() es a la vez thenable Y tiene .select().
              upsert() {
                const p = Promise.resolve({ error: null });
                p.select = () => ({ single: async () => ({ data: { id: 1 }, error: null }) });
                return p;
              },
              insert() {
                const p = Promise.resolve({ error: null });
                p.select = () => ({ single: async () => ({ data: { id: 1 }, error: null }) });
                return p;
              },
              update() { return { eq: async () => ({ error: null }) }; },
              delete() { return { gt: async () => ({ error: null }), eq: async () => ({ error: null }) }; },
            };
          },
        };
      },
    },
    setInterval: () => 0, clearInterval() {}, setTimeout, clearTimeout,
    URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} },
    Blob: class {}, FileReader: class {}, Date, Math, JSON, Promise, Array, Object, Number, String, Boolean,
  };
  sandbox.window.navigator = sandbox.navigator;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(rolesSrc, sandbox, { filename: "roles.js" });
  vm.runInContext(auditoriaSrc, sandbox, { filename: "auditoria.js" });
  vm.runInContext(scriptSrc, sandbox, { filename: "script.js" });
  // showToast (script.js) y logAccion (auditoria.js) son `function`
  // declarations reales, así que pisan cualquier stub puesto ANTES de
  // cargar esos archivos (quedan como propiedades del objeto global de
  // la vm) - por eso el espía se engancha DESPUÉS de cargar los 3.
  sandbox.showToast = (msg, type) => toasts.push({ msg, type });
  sandbox.logAccion = (accion, detalle) => logs.push({ accion, detalle });
  return { sandbox, elements, toasts, logs, confirmAnswers, getByIdCalls };
}

function setCurrentUser(sandbox, user) {
  sandbox.__userTest = user;
  vm.runInContext("currentUser = __userTest;", sandbox);
}

// ROLES es `const` a nivel de módulo (roles.js): igual que
// materiasSeleccionadasDocenteIds en verificar_asignacion_materias.js,
// no queda como propiedad del sandbox - hay que leerlo ejecutando
// código DENTRO del contexto.
function getROLES(sandbox) { return vm.runInContext("ROLES", sandbox); }

async function main() {
  console.log("\n== 1) Matriz de permisos (roles.js): Secretaría vs Rector vs Programador ==");
  {
    const { sandbox } = makeSandbox();
    const R = getROLES(sandbox);
    const tp = (rol, accion) => sandbox.tienePermiso(rol, accion);

    // Ya existía antes de esta sesión - confirma que no se rompió.
    check("Secretaría SÍ puede agregar/editar docentes (create/update)", tp(R.SECRETARIA, "agregar_docente") && tp(R.SECRETARIA, "editar_docente"));
    check("Secretaría NO puede borrar", !tp(R.SECRETARIA, "borrar"));
    check("Rector SÍ puede borrar", tp(R.RECTOR, "borrar"));

    // Reforzado en esta sesión (RBAC etapa 1).
    check("Solo Rector justifica alertas (Secretaría y Programador NO)", tp(R.RECTOR, "justificar_alerta") && !tp(R.SECRETARIA, "justificar_alerta") && !tp(R.PROGRAMADOR, "justificar_alerta"));
    check("Reportes/PDF exclusivo Rector (ni Secretaría ni Programador)", tp(R.RECTOR, "ver_reportes") && tp(R.RECTOR, "exportar_reportes") && !tp(R.SECRETARIA, "ver_reportes") && !tp(R.PROGRAMADOR, "ver_reportes"));
    check("Auditoría: Rector y Programador leen, Secretaría no", tp(R.RECTOR, "ver_auditoria") && tp(R.PROGRAMADOR, "ver_auditoria") && !tp(R.SECRETARIA, "ver_auditoria"));
    check("Gestionar auditoría (borrar log) exclusivo Programador (ni Rector ni Secretaría)", tp(R.PROGRAMADOR, "gestionar_auditoria") && !tp(R.RECTOR, "gestionar_auditoria") && !tp(R.SECRETARIA, "gestionar_auditoria"));
    check("Backup/restore exclusivo Programador", tp(R.PROGRAMADOR, "backup_restore") && !tp(R.RECTOR, "backup_restore") && !tp(R.SECRETARIA, "backup_restore"));
    check("Criterios de puntualidad: exclusivo Rector", tp(R.RECTOR, "editar_criterios_puntualidad") && !tp(R.SECRETARIA, "editar_criterios_puntualidad") && !tp(R.PROGRAMADOR, "editar_criterios_puntualidad"));

    check('mensajeSinPermiso("justificar_alerta") dice "solo Rector"', sandbox.mensajeSinPermiso("justificar_alerta").includes("Rector"));
    check('mensajeSinPermiso("gestionar_auditoria") dice "solo el Programador"', sandbox.mensajeSinPermiso("gestionar_auditoria").includes("Programador"));
  }

  console.log("\n== 2) Alertas: Secretaría solo puede \"Enviar a Rectoría\", Rector resuelve de verdad ==");
  {
    const { sandbox, toasts, logs } = makeSandbox();
    await sandbox.loadAllData();
    const R = getROLES(sandbox);
    const teacherSecre = { id: "sec1", rol: R.SECRETARIA, username: "ADMIN1", apellido: "Sec", nombre: "Retaria" };
    const teacherRector = { id: "rec1", rol: R.RECTOR, username: "ADMIN2", apellido: "Rec", nombre: "Tor" };

    sandbox.saveAlerts([{ id: "al1", teacherId: "t1", teacherName: "Pérez", type: "Falta", message: "No fichó", date: new Date().toISOString(), justified: false, justification: null }]);

    // Secretaría intenta resolver de verdad (reason real) -> debe ser rechazada.
    setCurrentUser(sandbox, teacherSecre);
    sandbox.justifyAlert("al1", "enfermedad");
    let alerts = sandbox.getAlerts();
    check("Secretaría NO puede resolver una alerta con una razón real (queda sin tocar)", alerts[0].justified === false && alerts[0].justification === null);
    check("...y queda logueado PERMISO_DENEGADO", logs.some(l => l.accion === "PERMISO_DENEGADO" && /justificar/i.test(l.detalle)));

    // Secretaría manda a Rectoría (el único caso permitido para su rol).
    sandbox.justifyAlert("al1", "pendiente_aprobacion_rectoria");
    alerts = sandbox.getAlerts();
    check('Secretaría SÍ puede mandarla a "pendiente_aprobacion_rectoria" (sigue sin resolver)', alerts[0].justified === false && alerts[0].justification === "pendiente_aprobacion_rectoria");

    // Rector ahora la resuelve de verdad, incluso habiendo sido escalada por Secretaría.
    setCurrentUser(sandbox, teacherRector);
    sandbox.justifyAlert("al1", "justificada");
    alerts = sandbox.getAlerts();
    check("Rector SÍ resuelve una alerta ya escalada por Secretaría", alerts[0].justified === true && alerts[0].justification === "justificada");

    // dismissAlert: Secretaría no puede borrar, Rector sí.
    sandbox.saveAlerts([{ id: "al2", teacherId: "t1", teacherName: "Pérez", type: "Falta", message: "x", date: new Date().toISOString(), justified: false, justification: null }]);
    setCurrentUser(sandbox, teacherSecre);
    sandbox.dismissAlert("al2");
    check("Secretaría NO puede borrar una alerta", sandbox.getAlerts().some(a => a.id === "al2"));
    setCurrentUser(sandbox, teacherRector);
    sandbox.confirm = () => true;
    sandbox.dismissAlert("al2");
    check("Rector SÍ puede borrar una alerta", !sandbox.getAlerts().some(a => a.id === "al2"));
  }

  console.log("\n== 3) Reportes: generateReport()/generateReportExcel() rechazan a quien no sea Rector ANTES de leer el formulario ==");
  {
    const { sandbox, getByIdCalls } = makeSandbox();
    await sandbox.loadAllData();
    const R = getROLES(sandbox);
    setCurrentUser(sandbox, { id: "sec1", rol: R.SECRETARIA, apellido: "Sec", nombre: "Retaria" });

    getByIdCalls.length = 0;
    sandbox.generateReport();
    check("Secretaría: generateReport() no llega a leer #reportFrom (corta antes)", !getByIdCalls.includes("reportFrom"));

    getByIdCalls.length = 0;
    sandbox.generateReportExcel();
    check("Secretaría: generateReportExcel() no llega a leer #reportFrom (corta antes)", !getByIdCalls.includes("reportFrom"));

    setCurrentUser(sandbox, { id: "rec1", rol: R.RECTOR, apellido: "Rec", nombre: "Tor" });
    getByIdCalls.length = 0;
    try { sandbox.generateReport(); } catch (e) { /* puede fallar más adelante por no tener jsPDF real - lo que importa es que pasó el gate */ }
    check("Rector: generateReport() SÍ llega a leer #reportFrom (pasó el gate)", getByIdCalls.includes("reportFrom"));
  }

  console.log("\n== 4) Criterios de Puntualidad: solo Rector puede guardar, quedan inputs deshabilitados para los demás ==");
  {
    const { sandbox } = makeSandbox();
    await sandbox.loadAllData();
    const R = getROLES(sandbox);

    setCurrentUser(sandbox, { id: "sec1", rol: R.SECRETARIA });
    sandbox.loadCriteriosPuntualidad();
    check("Secretaría: inputs de puntualidad quedan disabled", sandbox.document.getElementById("limitePresenteMin").disabled === true);
    check("Secretaría: botón Guardar de puntualidad queda disabled", sandbox.document.getElementById("guardarCriteriosPuntualidadBtn").disabled === true);

    const antes = sandbox.getCriteria();
    sandbox.document.getElementById("limitePresenteMin").value = "1";
    sandbox.document.getElementById("limiteTardanzaMin").value = "2";
    sandbox.document.getElementById("limiteMediaFaltaMin").value = "3";
    await sandbox.guardarCriteriosPuntualidad();
    check("Secretaría: guardarCriteriosPuntualidad() NO cambia nada aunque se llame directo", sandbox.getCriteria().limitePresenteMin === antes.limitePresenteMin);

    setCurrentUser(sandbox, { id: "rec1", rol: R.RECTOR });
    sandbox.loadCriteriosPuntualidad();
    check("Rector: inputs de puntualidad quedan habilitados", sandbox.document.getElementById("limitePresenteMin").disabled === false);
    sandbox.document.getElementById("limitePresenteMin").value = "12";
    sandbox.document.getElementById("limiteTardanzaMin").value = "18";
    sandbox.document.getElementById("limiteMediaFaltaMin").value = "25";
    await sandbox.guardarCriteriosPuntualidad();
    const despues = sandbox.getCriteria();
    check("Rector: SÍ guarda los nuevos límites (12/18/25)", despues.limitePresenteMin === 12 && despues.limiteTardanzaMin === 18 && despues.limiteMediaFaltaMin === 25);
    check("Rector: guardar puntualidad NO pisa lateLimit/minAttendance/minHours existentes", despues.lateLimit === antes.lateLimit && despues.minAttendance === antes.minAttendance);
  }

  console.log("\n== 5) Auditoría técnica (auditoria.js): borrar log / backup-restore exclusivos de Programador ==");
  {
    const { sandbox, logs } = makeSandbox();
    await sandbox.loadAllData();
    const R = getROLES(sandbox);

    setCurrentUser(sandbox, { id: "rec1", rol: R.RECTOR });
    await sandbox.borrarLogsConfirm();
    check("Rector NO puede borrar el log de auditoría (solo lectura)", logs.some(l => l.accion === "PERMISO_DENEGADO" && /borrar el log/i.test(l.detalle)));
    logs.length = 0;
    sandbox.backupLocalStorage();
    check("Rector NO puede descargar backup", logs.some(l => l.accion === "PERMISO_DENEGADO" && /backup/i.test(l.detalle)));

    setCurrentUser(sandbox, { id: "prog1", rol: R.PROGRAMADOR });
    logs.length = 0;
    sandbox.backupLocalStorage();
    check("Programador SÍ puede descargar backup (no quedó PERMISO_DENEGADO)", !logs.some(l => l.accion === "PERMISO_DENEGADO"));
  }

  console.log("\n==================================================");
  const total = results.length, ok = results.filter(r => r.ok).length;
  console.log(`RESULTADO: ${ok}/${total} verificaciones OK`);
  if (ok !== total) { console.log("Fallaron:", results.filter(r => !r.ok).map(r => r.desc)); process.exitCode = 1; }
}

main().catch(e => { console.error("ERROR EJECUTANDO EL TEST:", e); process.exitCode = 1; });
