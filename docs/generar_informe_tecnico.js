"use strict";
/**
 * Genera Informe_Tecnico_ASIS-CAM.docx (APA 7) con capturas reales del
 * sistema corriendo en http://localhost:3000.
 * Uso: node docs/generar_informe_tecnico.js
 */
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, FONT, COLOR, A4_PORTRAIT, MARGIN_APA,
  pageFooterAPA, toc, p, bullet, numbered, reference, codeBlock, simpleTable,
  loadLogo, brandedHeader, coverPage, h1, h2, h3, sectionBreak,
  figure, resetFigureCounter,
} = require("./lib/helpers");

const OUT_PATH = path.join(__dirname, "Informe_Tecnico_ASIS-CAM.docx");

function build(logoBuf) {
  resetFigureCounter();
  const sectionBase = {
    properties: { page: { size: A4_PORTRAIT, margin: MARGIN_APA } },
    headers: { default: brandedHeader(logoBuf, "Informe Técnico") },
    footers: { default: pageFooterAPA() },
  };

  const portada = coverPage(logoBuf, {
    titulo: "ASIS-CAM PRO — Sistema de Control de Asistencia Docente por Reconocimiento Facial y Geolocalización",
    subtitulo: "Informe Técnico",
    autor: "Diosmel",
    fecha: "16/09/2026",
  });

  const resumen = [
    h1("Resumen Ejecutivo"),
    p(
      "ASIS-CAM PRO es una aplicación web de control de asistencia del personal docente que combina reconocimiento facial biométrico, geolocalización obligatoria por geocerca y persistencia de datos en la nube. El presente informe documenta, con criterio técnico y académico, la arquitectura del sistema efectivamente desplegado, la organización de su código fuente, el flujo interno de reconocimiento facial, las consideraciones de seguridad relevadas y el procedimiento de instalación y ejecución local, verificado sobre la instancia real del sistema corriendo en http://localhost:3000."
    ),
    p(
      "El sistema se implementa como un sitio estático (HTML, CSS y JavaScript sin paso de compilación) que persiste sus datos en Supabase (PostgreSQL con API REST autogenerada), utiliza face-api.js para el cómputo biométrico en el propio navegador, Bootstrap para la interfaz y jsPDF/SheetJS para la exportación de reportes, y contempla tanto Netlify como Firebase Hosting como plataformas de publicación. Las capturas incluidas en este informe (Figuras 1 a 8) corresponden a pantallas reales del sistema en ejecución, obtenidas durante una sesión de auditoría técnica realizada el 16 de septiembre de 2026."
    ),
    sectionBreak(),
  ];

  const arquitectura = [
    h1("Arquitectura del Sistema"),
    p(
      "La arquitectura de ASIS-CAM PRO combina un frontend estático con dos servicios de infraestructura como plataforma (Supabase para datos y Firebase Hosting como una de las vías de publicación), una librería de biometría embebida en el cliente y bibliotecas de terceros autohospedadas para no depender de un CDN externo en tiempo de ejecución."
    ),
    h2("Frontend"),
    bullet("HTML5 + CSS3 + JavaScript clásico (script.js, sin type=\"module\"): el marcado dispara acciones mediante atributos onclick/onchange inline que requieren que las funciones estén expuestas en window, algo que un script clásico garantiza automáticamente."),
    bullet("Bootstrap 5.3 y Bootstrap Icons: maquetación responsiva, modales (alta de docente, eventos especiales, recuperación de contraseña) y el sistema de pestañas del Panel de Administración (Inicio, Alertas, Docentes, Licencias, Eventos, Configuración, Reportes)."),
    bullet("Leaflet + OpenStreetMap: mapa interactivo de la geocerca de fichaje, con buscador de direcciones (Nominatim) y marcador arrastrable."),
    bullet("Chart.js: gráficos de la sección Estadísticas (torta de distribución de registros, barras por docente, evolución temporal)."),
    bullet("jsPDF y SheetJS (xlsx): exportación de reportes de asistencia a PDF y a Excel desde la pestaña Reportes."),
    h2("Backend como servicio: Supabase"),
    p(
      "Supabase provee la base de datos PostgreSQL y expone automáticamente una API REST (PostgREST) sobre sus tablas. El modelo de datos combina un almacén documental (la tabla app_data, con columnas key/value en formato jsonb, que guarda colecciones como teachers, attendance, alerts, licencias, criteria, geofence y modoPrueba) con tablas relacionales propias para el módulo de Eventos Especiales (evento_especial, evento_docente, docente), que sí requieren integridad referencial y restricciones de unicidad."
    ),
    h2("Reconocimiento facial: face-api.js"),
    p(
      "face-api.js ejecuta la detección de rostro, la extracción de landmarks faciales y el cálculo del descriptor biométrico enteramente en el navegador del usuario, sin enviar imágenes a un servidor externo. Los tres modelos utilizados (tiny_face_detector, face_landmark_68 y face_recognition) están autohospedados en la carpeta /models del propio repositorio."
    ),
    h2("Hosting: Netlify y Firebase Hosting"),
    p(
      "El repositorio incluye configuración para dos plataformas de publicación de sitios estáticos: Netlify (netlify.toml, con integración continua desde GitHub) como vía principal, y Firebase Hosting (firebase.json y .firebaserc) como plataforma alternativa. Ambas cumplen el mismo rol —servir los archivos estáticos y redirigir cualquier ruta hacia index.html para que la navegación interna de la aplicación de una sola página no produzca errores 404— y ninguna de las dos actúa como base de datos: esa función la cumple exclusivamente Supabase."
    ),
    h2("Diagrama de capas"),
    codeBlock([
      "┌─────────────────────────── NAVEGADOR ───────────────────────────┐",
      "│  index.html + style.css + script.js (sitio estático, sin build) │",
      "│  ├─ Bootstrap 5.3 (UI, modales, pestañas)                       │",
      "│  ├─ Leaflet + OpenStreetMap (mapa de geocerca)                  │",
      "│  ├─ Chart.js (estadísticas)                                     │",
      "│  ├─ face-api.js + /models (reconocimiento facial en cliente)    │",
      "│  └─ jsPDF / SheetJS (exportación PDF / Excel)                   │",
      "└──────────────────────────────┬───────────────────────────────--┘",
      "                               │  API REST (PostgREST)",
      "                               ▼",
      "                    ┌─────────────────────┐",
      "                    │  Supabase / Postgres │  ← app_data, evento_especial,",
      "                    │  (base de datos)     │    evento_docente, docente,",
      "                    └─────────────────────┘    usuarios",
      "",
      "  Publicación del sitio estático (elige una vía):",
      "    Netlify  (CI/CD desde GitHub)   |   Firebase Hosting (despliegue manual)",
    ]),
    ...figure("02_dashboard_admin.jpg", "Panel de Administración de ASIS-CAM PRO, vista Inicio, con el resumen de docentes totales, presentes, ausentes y tardanzas del día.", { width: 460 }),
    sectionBreak(),
  ];

  const estructura = [
    h1("Estructura de Carpetas — ASIS_CAM_PRO_LIMPIA"),
    p("El proyecto se organiza como un sitio estático sin herramienta de build, con la siguiente estructura principal:", { firstLine: false }),
    codeBlock([
      "ASIS_CAM_PRO_LIMPIA/",
      "├── index.html               # Marcado semántico + modales de Bootstrap",
      "├── style.css                # Hoja de estilos del tema institucional",
      "├── script.js                # Lógica de la aplicación (script clásico)",
      "├── contacto.html            # Página de contacto institucional",
      "├── libs/                    # Bootstrap, Chart.js, jsPDF, SheetJS,",
      "│                            #   face-api.js, supabase-js (autohospedados)",
      "├── models/                  # 7 archivos de pesos de face-api.js",
      "├── sw.js                    # Service worker (caché offline-first)",
      "├── supabase_schema.sql      # Esquema base de app_data + RLS",
      "├── fix_rls_eventos.sql      # Políticas RLS de evento_docente / docente",
      "├── fix_unique_evento.sql    # Restricción UNIQUE de eventos especiales",
      "├── add_geocerca_evento.sql  # Columnas de geocerca por evento",
      "├── migrate_kclnaabvcxdovvgblyoc_schema.sql  # Migración al proyecto real",
      "├── usuarios_schema.sql      # Tabla usuarios (credenciales de acceso)",
      "├── netlify.toml / _redirects            # Configuración de Netlify",
      "├── firebase.json / .firebaserc           # Configuración de Firebase Hosting",
      "├── tests/",
      "│   ├── test_offline_sync.js     # Arnés de sincronización diferida",
      "│   └── test_service_worker.js   # Arnés del service worker",
      "├── documentacion/           # Informe técnico, manual y folleto previos",
      "├── docs/                    # Documentación consolidada y esta serie",
      "│   └── screenshots/         # Capturas reales usadas en estos documentos",
      "└── package.json             # Metadatos y scripts (\"npm test\", deploy:*)",
    ]),
    p(
      "No existe un paso de build (no hay Webpack ni Vite): al ser una única página con navegación por paneles (mostrar/ocultar secciones del DOM), mantener HTML, CSS y JavaScript planos simplifica el desarrollo y el despliegue, ya que no quedan artefactos de build que puedan desincronizarse del código fuente.",
      { firstLine: false }
    ),
    sectionBreak(),
  ];

  const flujoReconocimiento = [
    h1("Flujo de Reconocimiento Facial"),
    p(
      "El flujo de identificación biométrica se ejecuta íntegramente en el navegador del docente y se repite en cada intento de marcación (entrada, salida o retiro anticipado), sin reutilizar una identificación previa de la misma sesión, precisamente para impedir que un docente marque la asistencia de otro."
    ),
    numbered(1, "Carga de modelos: al iniciar la aplicación, face-api.js carga en segundo plano los tres modelos autohospedados (tiny_face_detector, face_landmark_68, face_recognition) desde /models. El aviso \"Módulo de reconocimiento facial listo\" confirma que la carga finalizó."),
    numbered(2, "Verificación de geocerca: antes de activar la cámara, verifyGeofence() comprueba si el dispositivo está exento (administrador, kiosco autorizado, Modo Prueba activo) o, en caso contrario, obtiene la posición actual mediante la Geolocation API y calcula la distancia al punto configurado."),
    numbered(3, "Captura y detección: al presionar \"Identificarme\", la cámara se activa y el sistema toma IDENTIFY_SAMPLES muestras sucesivas (3, una cada 250 ms). Si ningún cuadro contiene un rostro detectable, se muestra el aviso \"No se detectó un rostro. Ubicate frente a la cámara con buena iluminación.\""),
    numbered(4, "Extracción del descriptor: por cada muestra en la que sí se detecta un rostro, se extraen los landmarks faciales y se calcula un descriptor numérico de 128 valores."),
    numbered(5, "Comparación: se calcula la distancia euclidiana promedio entre el descriptor obtenido y el descriptor de referencia registrado para ese DNI al momento del alta. Si esa distancia es menor o igual al umbral FACE_MATCH_THRESHOLD (0.55), la identificación se considera exitosa."),
    numbered(6, "Habilitación de la marcación: una vez identificado, el sistema habilita únicamente el botón que corresponde al momento del día y al horario laboral del docente (Entrada, Salida o Retiro anticipado), evaluando además la ventana de tolerancia (EXIT_TOLERANCE_MINUTES = 15) y el límite de tardanza (LATE_LIMIT = 15 minutos)."),
    numbered(7, "Registro: al presionar el botón habilitado, se guarda la marcación (hora, tipo, estado de geocerca) primero en localStorage y luego, en segundo plano, en Supabase; si la sincronización falla por falta de conexión, la marcación queda encolada para subirse automáticamente al reconectar."),
    ...figure("04_reconocimiento_facial.jpg", "Panel del docente con el visor de cámara activo durante el flujo de identificación. El sistema reporta en tiempo real que no detectó un rostro frente a la cámara, el mensaje real que ve un docente cuando la iluminación o el encuadre no son adecuados.", { width: 460 }),
    ...figure("04b_gps_requerido.jpg", "Aviso de bloqueo mostrado cuando el navegador no puede obtener la ubicación del dispositivo (permiso de geolocalización denegado o no disponible): el fichaje queda impedido hasta habilitar el GPS, salvo que el dispositivo esté exento (administrador, kiosco o Modo Prueba).", { width: 460 }),
    sectionBreak(),
  ];

  const geocercaSection = [
    h1("Geocerca de Fichaje"),
    p(
      "Además de la biometría facial, ASIS-CAM PRO exige que el dispositivo se encuentre dentro de un radio configurable (en metros) alrededor de un punto geográfico, normalmente las coordenadas del establecimiento educativo. La configuración se administra desde la pestaña Configuración del panel de administrador mediante un mapa interactivo construido con Leaflet sobre teselas de OpenStreetMap, con buscador de direcciones (Nominatim), marcador arrastrable y un botón para usar la ubicación actual del dispositivo."
    ),
    ...figure("03_geocerca_mapa.jpg", "Configuración de la geocerca de fichaje en el panel de administración: mapa interactivo (Leaflet/OpenStreetMap) con el marcador y el radio configurado alrededor del establecimiento, y el detalle de la dirección resuelta por geocodificación inversa.", { width: 460 }),
    p(
      "Quedan exentos de la geocerca: el fichaje manual cargado por el administrador, una PC designada como kiosco autorizado, el propio usuario administrador, y el Modo Prueba, un interruptor pensado para demostraciones y pruebas que desactiva la geocerca para todos los usuarios de forma temporal.",
      { firstLine: false }
    ),
    sectionBreak(),
  ];

  const reportesSection = [
    h1("Reportes y Estadísticas"),
    p(
      "El panel de administración ofrece dos vías de análisis de la asistencia registrada: la pestaña Reportes, que genera un documento PDF o Excel filtrado por rango de fechas y por docente, y la vista Estadísticas, que calcula en el momento indicadores agregados (total de movimientos, porcentaje de puntualidad, docente con más registros, alertas sin justificar) y los presenta mediante gráficos de Chart.js."
    ),
    ...figure("06_reportes_generar.jpg", "Pestaña Reportes del panel de administración, con los filtros de fecha y docente, y los botones de exportación a PDF y a Excel.", { width: 460 }),
    ...figure("05_estadisticas.jpg", "Vista de Estadísticas con los indicadores agregados de asistencia calculados en tiempo real a partir de los registros existentes.", { width: 460 }),
    ...figure("05b_estadisticas_grafico.jpg", "Gráfico de distribución de registros (presentes frente a tardanzas), construido con Chart.js dentro de la vista de Estadísticas.", { width: 400 }),
    sectionBreak(),
  ];

  const seguridad = [
    h1("Seguridad"),
    h2("Autenticación"),
    p(
      "El sistema no utiliza Supabase Auth. El inicio de sesión del administrador compara el usuario y la contraseña ingresados contra credenciales fijas definidas en el objeto CONFIG de script.js, y el inicio de sesión de cada docente compara su DNI y contraseña contra el registro correspondiente en la colección teachers, con una contraseña por defecto asignada al crear el docente que este puede cambiar desde su panel (\"Cambiar Contraseña\"). El rol resultante (admin o docente) se guarda únicamente en una variable de JavaScript de la sesión del navegador."
    ),
    h2("Row Level Security (RLS)"),
    p(
      "Al no emplearse Supabase Auth, las políticas de RLS de las tablas app_data, evento_especial, evento_docente y docente están definidas de forma abierta para el rol anon: cualquier cliente que posea la clave anónima del proyecto —visible en el código fuente servido al navegador— puede leer, insertar y actualizar filas de esas tablas sin distinción de rol. En la práctica, la separación entre administrador y docente que percibe la persona usuaria es una capa de presentación en el cliente, no una restricción equivalente en la base de datos."
    ),
    h2("Datos sensibles en el panel de administración"),
    p(
      "El listado de docentes del panel de administración muestra, entre otros datos, la contraseña vigente de cada docente en texto plano y su fotografía de referencia biométrica. Durante esta auditoría se comprobó directamente en pantalla que las contraseñas se almacenan y se listan sin ningún tipo de hash o cifrado. Por ese motivo, la captura correspondiente a esa pantalla (Figura 10, en la sección de Gestión de Usuarios de este mismo informe) se incluye con las columnas de DNI, teléfono, domicilio, contraseña y foto deliberadamente difuminadas, para no exponer en un documento de circulación datos personales y credenciales reales de docentes."
    ),
    h2("Geolocalización y HTTPS"),
    p(
      "La Geolocation API del navegador solo entrega la posición del dispositivo si el sitio se sirve sobre HTTPS o desde localhost; sobre un despliegue en producción sin certificado válido, la geocerca dejaría de poder verificarse y el sistema lo señala explícitamente mediante el aviso \"GPS requerido\" (Figura 3).",
      { firstLine: false }
    ),
    h2("Recomendaciones"),
    bullet("Migrar la autenticación a Supabase Auth y restringir las políticas de RLS al rol authenticated."),
    bullet("Sustituir el almacenamiento de contraseñas en texto plano por un hash con sal, tanto para el usuario administrador como para cada docente."),
    bullet("Evaluar el traslado de las escrituras sensibles detrás de una Supabase Edge Function que valide un secreto del lado del servidor."),
    sectionBreak(),
  ];

  const instalacion = [
    h1("Instalación y Ejecución Local"),
    p(
      "ASIS-CAM PRO es un sitio estático sin paso de compilación: no existe un script \"dev\" en package.json (sus únicos scripts son deploy:firebase, deploy:netlify y test), por lo que no se ejecuta con npm run dev sino sirviendo directamente los archivos del repositorio con cualquier servidor HTTP estático. El procedimiento verificado en esta auditoría fue el siguiente:"
    ),
    numbered(1, "Instalar Node.js (18 o superior) si no está instalado."),
    numbered(2, "Posicionarse en la carpeta raíz del proyecto (ASIS_CAM_PRO_LIMPIA)."),
    numbered(3, "Ejecutar: npx serve . -p 3000"),
    numbered(4, "Abrir el navegador en http://localhost:3000."),
    codeBlock([
      "cd ASIS_CAM_PRO_LIMPIA",
      "npx serve . -p 3000",
      "# Servidor disponible en http://localhost:3000",
    ]),
    p(
      "El comando npx serve . -p 3000 descarga (si hace falta) y ejecuta el paquete serve para publicar el directorio actual (.) como sitio estático en el puerto 3000, replicando en el entorno local el mismo modelo de publicación que usan Netlify y Firebase Hosting en producción: servir los archivos tal cual, sin build intermedio.",
      { firstLine: false }
    ),
    ...figure("01_login.jpg", "Pantalla de inicio (\"Bienvenidos\") de ASIS-CAM PRO, servida localmente en http://localhost:3000 mediante npx serve, con el aviso de que el módulo de reconocimiento facial ya terminó de cargar.", { width: 380 }),
    sectionBreak(),
  ];

  const gestionUsuarios = [
    h1("Gestión de Usuarios (Docentes)"),
    p(
      "El módulo de Docentes del panel de administración permite dar de alta nuevos docentes y consultar el listado existente. El alta requiere apellido, nombre y DNI (que será el usuario de acceso del docente); opcionalmente se cargan materia, contacto y horario laboral, y se capturan al menos tres fotografías del rostro para calcular el descriptor biométrico de referencia."
    ),
    ...figure("07_alta_docente.jpg", "Formulario de alta de un nuevo docente en el panel de administración, con los campos de datos personales y la indicación de que el DNI será el usuario de inicio de sesión.", { width: 460 }),
    p(
      "El listado de docentes muestra el estado de cada uno (presente/ausente del día) y permite editar, eliminar o volver a capturar la biometría. Tal como se señala en la sección de Seguridad, la columna Contraseña de este listado expone la contraseña vigente en texto plano; por ese motivo, en la Figura 10 las columnas Foto, DNI, Teléfono, Domicilio y Contraseña se muestran difuminadas.",
      { firstLine: false }
    ),
    ...figure("08_listado_docentes_blurred.jpg", "Listado de docentes registrados en el sistema. Las columnas Foto, DNI, Teléfono, Domicilio y Contraseña fueron difuminadas deliberadamente para esta documentación, dado que exponían datos personales y credenciales reales de docentes en texto plano.", { width: 460 }),
    sectionBreak(),
  ];

  const conclusion = [
    h1("Conclusión"),
    p(
      "ASIS-CAM PRO integra reconocimiento facial, geolocalización y persistencia en la nube en una arquitectura de sitio estático sin necesidad de un servidor de aplicación propio. El sistema cumple su función central de manera verificable —tal como muestran las capturas reales incluidas en este informe—, aunque presenta oportunidades de mejora concretas en materia de autenticación y protección de contraseñas, detalladas en la sección de Seguridad, que se recomienda abordar antes de una puesta en producción con datos reales de docentes."
    ),
  ];

  const children = [
    ...portada,
    ...toc(),
    ...resumen,
    ...arquitectura,
    ...estructura,
    ...flujoReconocimiento,
    ...geocercaSection,
    ...reportesSection,
    ...seguridad,
    ...instalacion,
    ...gestionUsuarios,
    ...conclusion,
  ];

  return new Document({
    creator: "Diosmel",
    title: "Informe Técnico - ASIS-CAM PRO",
    description: "Informe técnico APA 7 de ASIS-CAM PRO con capturas reales del sistema",
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
      console.error("Error generando el informe técnico:", err);
      process.exit(1);
    });
}

module.exports = { generate };
