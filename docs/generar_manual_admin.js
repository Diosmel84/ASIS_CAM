"use strict";
/**
 * Genera Manual_Admin_ASIS-CAM.docx (APA 7) con capturas reales del panel
 * de administración de ASIS-CAM PRO corriendo en http://localhost:3000.
 * Uso: node docs/generar_manual_admin.js
 */
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, FONT, A4_PORTRAIT, MARGIN_APA,
  pageFooterAPA, toc, p, bullet, numbered,
  loadLogo, brandedHeader, coverPage, h1, h2, sectionBreak,
  figure, resetFigureCounter,
} = require("./lib/helpers");

const OUT_PATH = path.join(__dirname, "Manual_Admin_ASIS-CAM.docx");

function build(logoBuf) {
  resetFigureCounter();
  const sectionBase = {
    properties: { page: { size: A4_PORTRAIT, margin: MARGIN_APA } },
    headers: { default: brandedHeader(logoBuf, "Manual del Administrador") },
    footers: { default: pageFooterAPA() },
  };

  const portada = coverPage(logoBuf, {
    titulo: "ASIS-CAM PRO",
    subtitulo: "Manual del Administrador — Guía para Directivos",
    autor: "Diosmel",
    fecha: "16/09/2026",
  });

  const intro = [
    h1("Introducción"),
    p(
      "Este manual explica, paso a paso y con capturas reales del sistema, cómo un directivo o encargado de administración opera ASIS-CAM PRO: cómo dar de alta a los docentes, consultar reportes de asistencia, configurar la geocerca del establecimiento, exportar reportes a PDF y administrar las credenciales de acceso. Todas las capturas fueron tomadas directamente sobre la instancia del sistema corriendo en http://localhost:3000."
    ),
    sectionBreak(),
  ];

  const ingreso = [
    h1("1. Iniciar Sesión como Administrador"),
    numbered(1, "Abrir el navegador en la dirección de la plataforma (en este entorno de prueba, http://localhost:3000)."),
    numbered(2, "En el campo \"Usuario (DNI)\", ingresar el usuario administrador."),
    numbered(3, "En el campo \"Contraseña\", ingresar la contraseña de administrador."),
    numbered(4, "Presionar \"Ingresar\"."),
    p(
      "Por seguridad, este manual no reproduce las credenciales reales del administrador: ambas están definidas en el objeto CONFIG del código fuente del sistema y deben ser entregadas de forma privada a la persona responsable, nunca compartidas en un documento de circulación general.",
      { firstLine: false }
    ),
    ...figure("01_login.jpg", "Pantalla de inicio de sesión de ASIS-CAM PRO (\"Bienvenidos\"), con los campos Usuario (DNI) y Contraseña.", { width: 340 }),
    p(
      "Al ingresar correctamente, el sistema muestra el Panel de Administración con el resumen del día: total de docentes, presentes, ausentes y tardanzas.",
      { firstLine: false }
    ),
    ...figure("02_dashboard_admin.jpg", "Panel de Administración, pestaña Inicio, con el resumen de asistencia del día y el menú de pestañas (Alertas, Docentes, Licencias, Eventos, Configuración, Reportes).", { width: 460 }),
    sectionBreak(),
  ];

  const crearDocentes = [
    h1("2. Crear un Nuevo Docente"),
    numbered(1, "En el menú de pestañas, seleccionar \"Docentes\"."),
    numbered(2, "Completar los Datos Personales: Apellido, Nombre, DNI (será el usuario de inicio de sesión del docente) y, opcionalmente, la Materia que dicta."),
    numbered(3, "Desplegar la sección \"Contacto\" y completar teléfono, dirección y localidad si se dispone de esos datos."),
    numbered(4, "Desplegar la sección \"Laboral\" y cargar el horario semanal del docente (día, hora de inicio y hora de fin). Puede usarse el atajo para aplicar el mismo horario a varios días marcados con casillas de verificación."),
    numbered(5, "Capturar al menos tres fotografías del rostro del docente con buena iluminación, mirando de frente a la cámara, para que el sistema pueda reconocerlo luego."),
    numbered(6, "Presionar \"Guardar Docente\"."),
    p(
      "El aviso que aparece debajo del formulario indica el criterio de acceso que va a tener el nuevo docente: \"Acceso: Usuario = DNI, Contraseña = asignada (por defecto: 123456)\". Se recomienda indicarle al docente que cambie esa contraseña provisoria la primera vez que ingresa, desde \"Cambiar Contraseña\" en su propio panel.",
      { firstLine: false }
    ),
    ...figure("07_alta_docente.jpg", "Formulario \"Registrar Nuevo Docente\", sección Datos Personales, con los campos Apellido, Nombre, DNI (Usuario) y Materia.", { width: 460 }),
    sectionBreak(),
  ];

  const listadoDocentes = [
    h1("3. Consultar y Administrar el Listado de Docentes"),
    p(
      "Debajo del formulario de alta, la sección \"Listado de Docentes\" muestra a todos los docentes registrados, con su foto, DNI, nombre, teléfono, domicilio, materia, horario, contraseña vigente, estado de la biometría (Registrada) y estado de asistencia del día (Presente/Ausente). Desde esta tabla se puede buscar un docente por nombre, DNI o materia, editar sus datos, volver a capturar su rostro, restablecer su contraseña o eliminarlo."
    ),
    p(
      "Importante — manejo de datos sensibles: esta tabla muestra la contraseña de cada docente en texto plano, junto con su DNI, teléfono, domicilio y foto de referencia biométrica. En la captura siguiente esas columnas fueron intencionalmente difuminadas, porque corresponden a datos personales y credenciales reales de docentes que no deben circular en un manual. Al usar el sistema en la pantalla real, esos datos sí son visibles para quien tenga la sesión de administrador abierta: se recomienda no dejar la sesión de administrador abierta en un equipo compartido y no compartir capturas de esta pantalla sin editar.",
      { firstLine: false }
    ),
    ...figure("08_listado_docentes_blurred.jpg", "Listado de Docentes del panel de administración. Las columnas Foto, DNI, Teléfono, Domicilio y Contraseña se muestran difuminadas en este manual porque en la pantalla real exhiben datos personales y contraseñas reales de docentes.", { width: 460 }),
    sectionBreak(),
  ];

  const geocerca = [
    h1("4. Configurar la Geocerca del Establecimiento"),
    numbered(1, "Ingresar a la pestaña \"Configuracion\"."),
    numbered(2, "En \"Configuración: Geocerca de Fichaje\", completar el \"Nombre del lugar\" (por ejemplo, el nombre de la institución)."),
    numbered(3, "Ajustar el control deslizante \"Radio\" (entre 50 y 500 metros) según la superficie del establecimiento."),
    numbered(4, "Ubicar el punto exacto de una de estas tres formas: escribiendo la dirección en el buscador (\"Buscar: Provincia, Localidad, Calle\"), arrastrando el marcador azul directamente sobre el mapa, o presionando \"Usar mi ubicación actual\" desde un dispositivo ubicado en el establecimiento."),
    numbered(5, "Presionar \"Guardar\"."),
    p(
      "A partir de ese momento, un docente solo podrá fichar por reconocimiento facial si su dispositivo está dentro del radio configurado alrededor de ese punto. Quedan exentos de esta exigencia el fichaje manual del administrador, una PC autorizada como \"kiosco\" y el propio usuario administrador.",
      { firstLine: false }
    ),
    ...figure("03_geocerca_mapa.jpg", "Configuración de la Geocerca de Fichaje: mapa interactivo con el marcador, el radio configurado y la dirección resuelta automáticamente (\"Colegio Secundario de San Carlos, Avenida Mitre...\").", { width: 460 }),
    p(
      "El interruptor \"Modo Prueba\", ubicado debajo del mapa, desactiva la geocerca para todos los usuarios de forma temporal. Es útil para hacer demostraciones o pruebas del sistema, pero debe mantenerse apagado durante el uso normal en la institución, ya que mientras esté activo cualquier docente puede fichar desde cualquier ubicación.",
      { firstLine: false }
    ),
    sectionBreak(),
  ];

  const reportes = [
    h1("5. Ver Reportes y Exportar a PDF"),
    numbered(1, "Ingresar a la pestaña \"Reportes\"."),
    numbered(2, "Completar, si se desea acotar la búsqueda, las fechas \"Desde\" y \"Hasta\" y/o seleccionar un docente puntual en el campo \"Docente\" (por defecto, \"Todos\")."),
    numbered(3, "Presionar \"Generar PDF\" para obtener un reporte imprimible, o \"Generar Excel\" para obtener una planilla editable con los mismos datos."),
    ...figure("06_reportes_generar.jpg", "Pestaña Reportes del panel de administración, con los filtros de fecha y docente, y los botones \"Generar PDF\" y \"Generar Excel\".", { width: 460 }),
    p(
      "Adicionalmente, desde el botón \"Ver Estadísticas\" (disponible en la parte superior del panel) se accede a una vista con indicadores agregados de asistencia —total de movimientos, porcentaje de puntualidad, docente con más registros, alertas sin justificar— y gráficos que se recalculan automáticamente con los datos existentes.",
      { firstLine: false }
    ),
    ...figure("05_estadisticas.jpg", "Vista de Estadísticas con los indicadores agregados de asistencia del establecimiento.", { width: 460 }),
    sectionBreak(),
  ];

  const credenciales = [
    h1("6. Administrar Credenciales de Acceso"),
    h2("Cambiar la contraseña del administrador"),
    numbered(1, "Con la sesión de administrador iniciada, presionar el botón \"Cambiar Contraseña\" ubicado en la parte superior del panel."),
    numbered(2, "Completar la nueva contraseña siguiendo las indicaciones en pantalla."),
    h2("Restablecer la contraseña de un docente"),
    numbered(1, "En el Listado de Docentes, ubicar al docente correspondiente."),
    numbered(2, "Usar la acción de restablecer contraseña de esa fila: se puede definir una nueva contraseña o dejar el campo vacío para restaurar la contraseña por defecto del sistema."),
    numbered(3, "Comunicarle al docente su nueva contraseña por un canal privado (nunca por un medio público) y recomendarle cambiarla apenas ingrese."),
    p(
      "Recordatorio de buenas prácticas: dado que el listado de docentes exhibe las contraseñas en texto plano (ver sección 3), se recomienda restringir quién tiene acceso a la sesión de administrador y evitar dejarla abierta sin supervisión.",
      { firstLine: false }
    ),
  ];

  const children = [
    ...portada,
    ...toc(),
    ...intro,
    ...ingreso,
    ...crearDocentes,
    ...listadoDocentes,
    ...geocerca,
    ...reportes,
    ...credenciales,
  ];

  return new Document({
    creator: "Diosmel",
    title: "Manual del Administrador - ASIS-CAM PRO",
    description: "Manual de uso para directivos, con capturas reales del sistema",
    styles: { default: { document: { run: { font: FONT, size: 24 } } } },
    sections: [{ ...sectionBase, children }],
  });
}

async function generate() {
  const logoBuf = loadLogo();
  const doc = build(logoBuf);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(OUT_PATH, buffer);
  return OUT_PATH;
}

if (require.main === module) {
  generate()
    .then((outPath) => {
      const { size } = fs.statSync(outPath);
      console.log(`Documento generado: ${outPath} (${(size / 1024).toFixed(1)} KB)`);
    })
    .catch((err) => {
      console.error("Error generando el manual del administrador:", err);
      process.exit(1);
    });
}

module.exports = { generate };
