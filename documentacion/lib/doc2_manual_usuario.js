"use strict";
const {
  docx: { Document, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType, ShadingType, VerticalAlign, Packer },
  FONT, COLOR, A4_PORTRAIT, MARGIN_APA,
  pageHeader, pageFooterAPA, titlePage, toc,
  h1, h2, h3, p, ps, bullet, numbered, reference, allBorders, cell, simpleTable,
} = require("./common");

function screenshot(desc) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allBorders(COLOR.primary, 6),
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill: COLOR.lightGray },
            margins: { top: 160, bottom: 160, left: 200, right: 200 },
            children: [
              new Paragraph({
                children: [new TextRun({ text: "🖼  CAPTURA DE PANTALLA (descripción)", bold: true, font: FONT, size: 18, color: COLOR.primary })],
                spacing: { after: 80 },
              }),
              new Paragraph({
                children: [new TextRun({ text: desc, font: FONT, size: 20, italics: true })],
                spacing: { after: 0 },
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function flowStep(text, opts = {}) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allBorders(opts.color || COLOR.olive, 6),
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill: opts.fill || COLOR.oliveTint },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 120, bottom: 120, left: 200, right: 200 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text, bold: true, font: FONT, size: 21, color: opts.textColor || COLOR.primaryDark })],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function flowArrow() {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 40, after: 40 },
    children: [new TextRun({ text: "↓", bold: true, size: 28, color: COLOR.primary })],
  });
}

function flowDiagram(title, steps, opts = {}) {
  const out = [h3(`Diagrama de flujo: ${title}`)];
  steps.forEach((s, i) => {
    out.push(flowStep(s, opts));
    if (i < steps.length - 1) out.push(flowArrow());
  });
  return out;
}

function build() {
  const sectionBase = {
    properties: { page: { size: A4_PORTRAIT, margin: MARGIN_APA } },
    headers: { default: pageHeader("Manual de Usuario") },
    footers: { default: pageFooterAPA() },
  };

  const portada = titlePage({
    institucion: "ASIS_CAM",
    titulo: "Manual de Usuario",
    subtitulo: "Guía práctica para Administradores y Docentes",
    autor: "Elaborado por: Diosmel",
    curso: "Versión 1.0",
    lugar: "Argentina",
    fecha: "Septiembre de 2026",
  });

  const intro = [
    h1("Introducción a este manual"),
    p(
      "Este manual explica, paso a paso y con lenguaje simple, cómo usar ASIS_CAM. Está dividido en dos grandes secciones: una para quien administra el sistema (director/a, secretaría o coordinación) y otra para cada docente. Cada paso incluye una descripción de lo que la persona usuaria debe hacer y una descripción detallada de lo que va a ver en la pantalla, señalada como \"Captura de pantalla\".",
      { firstLine: false }
    ),
    ps("Antes de empezar, tenga a mano:"),
    bullet("La dirección web de la plataforma: asiscam-uno.netlify.app"),
    bullet("Un dispositivo con cámara (computadora, tablet o celular) y navegador actualizado (Chrome, Edge o Safari)."),
    bullet("El usuario y la contraseña que le fueron entregados."),
    new Paragraph({ text: "", pageBreakBefore: true }),
  ];

  // ---------------- SECCIÓN A: ADMINISTRADOR ----------------
  const seccionA = [
    h1("SECCIÓN A — Manual para el Administrador"),

    h2("A.1 Iniciar sesión"),
    numbered(1, "Abra el navegador y visite la dirección de la plataforma."),
    numbered(2, "En la pantalla de inicio, ingrese el usuario administrador y la contraseña."),
    numbered(3, "Presione el botón \"Ingresar\"."),
    screenshot(
      "Pantalla de bienvenida con fondo institucional. En el centro, una tarjeta blanca con el logo ASIS_CAM, un campo de texto \"Usuario\", un campo \"Contraseña\" (oculto con puntos) y un botón azul \"Ingresar\". Debajo, un pequeño aviso indica si los modelos de reconocimiento facial ya terminaron de cargar (\"Listo\" en verde) o si todavía están cargando (spinner)."
    ),
    ps("Al ingresar correctamente, el sistema lo llevará automáticamente al Panel de Administración."),

    h2("A.2 Dar de alta a un nuevo docente"),
    numbered(1, "En el menú lateral, seleccione \"Docentes\" y luego el botón \"Nuevo docente\"."),
    numbered(2, "Complete el formulario: nombre, apellido, DNI, teléfono, dirección y materia."),
    numbered(3, "Defina su horario laboral: elija el día, la hora de inicio y la hora de fin de sus clases, y agregue tantos bloques como necesite."),
    numbered(4, "Active la cámara y capture al menos 3 fotos del rostro del docente, con buena luz y mirando de frente, para que el sistema pueda reconocerlo luego."),
    numbered(5, "Presione \"Guardar docente\". El sistema le asigna automáticamente una contraseña provisoria."),
    screenshot(
      "Formulario de alta de docente dividido en dos columnas: a la izquierda los datos personales y el horario semanal (una tabla con casillas por día); a la derecha, el visor de la cámara con un recuadro verde que sigue al rostro detectado en vivo, un contador \"Fotos capturadas: 2 de 3\" y un botón \"Capturar foto\". Un cartel verde \"Modelos de reconocimiento cargados\" aparece arriba del visor."
    ),

    h2("A.3 Gestionar Eventos Especiales (convocar docentes)"),
    numbered(1, "Vaya a \"Eventos Especiales\" y presione \"Nuevo evento\"."),
    numbered(2, "Escriba el título del evento (por ejemplo, \"Acto por el Día del Estudiante\"), la fecha y el horario."),
    numbered(3, "En el buscador de docentes, escriba un apellido para encontrarlo y haga clic para agregarlo a la lista de convocados. Repita para cada docente."),
    numbered(4, "Revise la lista de convocados y presione \"Guardar evento\" una sola vez."),
    screenshot(
      "Ventana modal (recuadro emergente) titulada \"Nuevo Evento Especial\", con campos Título, Fecha y Hora arriba, y debajo un buscador con la leyenda \"Buscar docente por apellido...\". Al escribir aparece una lista desplegable con coincidencias. Los docentes ya agregados se muestran como etiquetas (chips) con una \"x\" para quitarlos. El botón \"Guardar evento\" está en la esquina inferior derecha."
    ),
    p(
      "Importante: presione \"Guardar evento\" una sola vez y espere. El botón se desactiva solo mientras el sistema procesa el guardado, precisamente para evitar que quede registrado el mismo evento dos veces si se hace doble clic por error.",
      { firstLine: false }
    ),
    ...flowDiagram("Cargar un Evento Especial", [
      "1. Admin abre \"Nuevo evento\"",
      "2. Completa título, fecha y hora",
      "3. Busca y agrega docentes convocados",
      "4. Presiona \"Guardar\" (el botón se bloquea)",
      "5. El sistema verifica que no exista ya un evento igual",
      "6. Evento guardado y docentes notificados en su panel",
    ]),

    h2("A.4 Registrar una licencia o permiso"),
    numbered(1, "Ingrese a \"Licencias\" y elija el docente."),
    numbered(2, "Indique la fecha de inicio y la fecha de fin de la licencia."),
    numbered(3, "Guarde. Los días cubiertos por esa licencia no se contarán como falta."),

    h2("A.5 Revisar el buzón de alertas"),
    ps("El buzón agrupa automáticamente:"),
    bullet("Faltas: el docente tenía clase asignada y no marcó entrada."),
    bullet("Tardanzas: marcó entrada pasado el margen permitido."),
    bullet("Salidas anticipadas: se retiró antes de horario, pendiente de autorización."),
    bullet("Inasistencias a Eventos Especiales convocados."),
    screenshot(
      "Panel \"Alertas\" con una lista de tarjetas, cada una con el nombre del docente, un ícono de color (rojo para falta, amarillo para tardanza, naranja para salida anticipada), la fecha, y dos botones: un ícono de WhatsApp para contactar al docente y un ícono de archivo para moverla al histórico."
    ),

    h2("A.6 Ver la grilla horaria y el calendario anual"),
    numbered(1, "Ingrese a \"Horarios\" para ver la grilla semanal completa de todos los docentes en una sola tabla."),
    numbered(2, "Ingrese a \"Calendario\" y elija un docente para ver, mes a mes, qué días tuvo clase, cuáles marcó presente y cuáles quedaron como falta."),

    h2("A.7 Ver reportes y estadísticas globales"),
    numbered(1, "Ingrese a \"Estadísticas\"."),
    numbered(2, "Observe los gráficos de asistencia general (torta), de tardanzas por docente (barras) y de evolución mensual (líneas)."),
    numbered(3, "Use el buscador de \"Ficha del docente\" para ver el historial completo de una persona en particular."),
    screenshot(
      "Panel de estadísticas con tres tarjetas de indicadores arriba (Asistencia General 92%, Tardanzas del mes: 4, Faltas del mes: 1) y, debajo, tres gráficos: un gráfico de torta verde/rojo, un gráfico de barras por docente y un gráfico de líneas con la evolución de los últimos meses."
    ),
  ];

  // ---------------- SECCIÓN B: DOCENTE ----------------
  const seccionB = [
    new Paragraph({ text: "", pageBreakBefore: true }),
    h1("SECCIÓN B — Manual para el Docente"),

    h2("B.1 Iniciar sesión"),
    numbered(1, "Abra el navegador y visite la dirección de la plataforma."),
    numbered(2, "Ingrese su número de DNI como usuario y su contraseña (la que le entregó la administración, o la que usted ya cambió)."),
    numbered(3, "Presione \"Ingresar\"."),
    ps("La primera vez que ingresa, se recomienda cambiar la contraseña provisoria desde \"Mi perfil\" → \"Cambiar contraseña\"."),

    h2("B.2 Marcar entrada, salida o retiro"),
    numbered(1, "En su panel, presione el botón \"Identificarme\"."),
    numbered(2, "Mire de frente a la cámara unos segundos, sin gorra ni lentes oscuros, hasta que el recuadro se ponga verde y el sistema confirme su identidad."),
    numbered(3, "Una vez identificado, presione el botón que corresponda: \"Entrada\", \"Salida\" o \"Retiro anticipado\". Solo aparece habilitado el botón que corresponde al momento del día."),
    screenshot(
      "Panel del docente con foto de perfil, nombre y materia arriba. Debajo, el visor de la cámara centrado con el mensaje \"Presione Identificarme para marcar su asistencia\". Tres botones grandes debajo: \"Entrada\" (verde), \"Salida\" (azul) y \"Retiro anticipado\" (naranja); los que no corresponden en ese momento aparecen apagados (gris)."
    ),
    ...flowDiagram("Tomar Asistencia (docente)", [
      "1. Docente inicia sesión con DNI y contraseña",
      "2. Presiona \"Identificarme\" y mira a la cámara",
      "3. El sistema calcula su rostro y lo compara con el registrado",
      "4. ¿Coincide? Sí → continúa / No → vuelve a intentar",
      "5. Se habilita el botón correcto (Entrada / Salida / Retiro)",
      "6. Docente presiona el botón y la asistencia queda registrada",
    ]),

    h2("B.3 Ver sus convocatorias a Eventos Especiales"),
    numbered(1, "En \"Mis eventos\", revise los eventos institucionales a los que fue convocado."),
    numbered(2, "El día del evento, márquese presente identificándose por rostro igual que en el fichaje diario."),

    h2("B.4 Ver su historial de asistencia"),
    numbered(1, "Ingrese a \"Mi historial\"."),
    numbered(2, "Consulte, por mes, sus entradas, salidas, tardanzas y faltas registradas."),
    screenshot(
      "Tabla con columnas Fecha, Entrada, Salida, Estado (con etiquetas de color: verde \"A horario\", amarillo \"Tardanza\", rojo \"Falta\") y un resumen arriba con el porcentaje de asistencia del mes."
    ),

    h2("B.5 Solicitar o consultar una licencia"),
    p(
      "Las licencias las carga la administración. Si necesita una licencia o permiso, comuníquese con la dirección; una vez cargada, la verá reflejada en su calendario personal y esos días no contarán como falta.",
      { firstLine: false }
    ),
  ];

  const nota = [
    new Paragraph({ text: "", pageBreakBefore: true }),
    h1("Preguntas frecuentes"),
    h3("El sistema no me reconoce el rostro, ¿qué hago?"),
    p("Verifique que haya buena luz sobre su cara, quítese lentes oscuros o gorra, y vuelva a presionar \"Identificarme\". Si el problema persiste, pida a la administración que vuelva a capturar sus fotos de referencia.", { firstLine: false }),
    h3("Marqué \"Retiro anticipado\" por error, ¿se puede corregir?"),
    p("Comuníquese con la administración: puede revisar el registro en el buzón de alertas y, si corresponde, autorizarlo o dejar la aclaración correspondiente.", { firstLine: false }),
    h3("¿Qué pasa si no tengo cámara disponible ese día?"),
    p("Informe a la administración: puede registrar la asistencia manualmente desde el panel de administrador como excepción, dejando constancia del motivo.", { firstLine: false }),
  ];

  const children = [...portada, ...toc(), ...intro, ...seccionA, ...seccionB, ...nota];

  return new Document({
    creator: "Diosmel",
    title: "Manual de Usuario - ASIS_CAM",
    description: "Manual de usuario para administrador y docente",
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ ...sectionBase, children }],
  });
}

async function generate(outPath) {
  const doc = build();
  const buffer = await Packer.toBuffer(doc);
  require("fs").writeFileSync(outPath, buffer);
  return outPath;
}

module.exports = { generate };
