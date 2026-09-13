"use strict";
const {
  docx: {
    Document, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell,
    WidthType, ShadingType, VerticalAlign, BorderStyle, Packer, Header, Footer,
  },
  FONT, COLOR, A4_LANDSCAPE, convertMillimetersToTwipSafe,
  h1, h2, allBorders, cell,
} = require("./common");
const { convertMillimetersToTwip } = require("docx");

const MARGIN_BROCHURE = {
  top: convertMillimetersToTwip(12),
  bottom: convertMillimetersToTwip(12),
  left: convertMillimetersToTwip(14),
  right: convertMillimetersToTwip(14),
};

function noBorderTable(rows, colWidths) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: colWidths,
    borders: {
      top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    },
    rows,
  });
}

function bigHeader() {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [new TextRun({ text: "ASIS_CAM  |  asiscam-uno.netlify.app", font: FONT, size: 16, color: COLOR.gray, italics: true })],
      }),
    ],
  });
}
function pageNumFooter() {
  const { PageNumber } = require("docx");
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: COLOR.gray })],
      }),
    ],
  });
}

function heroBanner() {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allBorders(COLOR.primaryDark, 0),
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill: COLOR.primary },
            margins: { top: 500, bottom: 500, left: 500, right: 500 },
            verticalAlign: VerticalAlign.CENTER,
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: "ASIS_CAM", bold: true, font: FONT, size: 72, color: "FFFFFF" })],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 120 },
                children: [
                  new TextRun({
                    text: "\"Tu institución, presente a tiempo. Sin planillas, sin dudas, sin duplicados.\"",
                    italics: true,
                    bold: true,
                    font: FONT,
                    size: 30,
                    color: COLOR.accent,
                  }),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 160 },
                children: [
                  new TextRun({
                    text: "Control de asistencia docente con reconocimiento facial · Reportes en tiempo real · Sin instalaciones",
                    font: FONT,
                    size: 22,
                    color: "F2F2F2",
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function sectionTitle(text) {
  return new Paragraph({
    spacing: { before: 260, after: 140 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: COLOR.accent, space: 4 } },
    children: [new TextRun({ text, bold: true, font: FONT, size: 32, color: COLOR.primaryDark })],
  });
}

function bodyText(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 100, line: 264, lineRule: "auto" },
    children: [new TextRun({ text, font: FONT, size: opts.size || 22, bold: !!opts.bold, color: opts.color })],
  });
}

function ventajaCard(icon, titulo, texto) {
  return new TableCell({
    width: { size: 33.33, type: WidthType.PERCENTAGE },
    shading: { type: ShadingType.CLEAR, fill: COLOR.oliveTint },
    margins: { top: 200, bottom: 200, left: 180, right: 180 },
    children: [
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: icon, size: 48 })], spacing: { after: 60 } }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: titulo, bold: true, font: FONT, size: 22, color: COLOR.primaryDark })],
        spacing: { after: 60 },
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: texto, font: FONT, size: 18, color: COLOR.gray })],
      }),
    ],
  });
}

function build() {
  const sectionBase = {
    properties: {
      page: {
        size: { width: A4_LANDSCAPE.width, height: A4_LANDSCAPE.height },
        margin: MARGIN_BROCHURE,
      },
    },
    headers: { default: bigHeader() },
    footers: { default: pageNumFooter() },
  };

  // ---- Página 1 ----
  const pagina1 = [
    heroBanner(),
    sectionTitle("¿Qué es ASIS_CAM?"),
    bodyText(
      "ASIS_CAM es una plataforma web lista para usar que reemplaza las planillas de papel y los relojes de fichaje tradicionales por reconocimiento facial. Cada docente marca su entrada, su salida y su asistencia a eventos institucionales con su propio rostro, desde cualquier computadora, tablet o celular con cámara. La dirección de la institución accede a un panel único con reportes, alertas y estadísticas en tiempo real, sin instalar nada y sin depender de hardware biométrico costoso."
    ),
    sectionTitle("¿Qué problema resuelve?"),
    bodyText(
      "Las planillas firmadas a mano se pueden completar por otra persona, no avisan a tiempo cuando alguien falta, y obligan a la dirección a sumar números a fin de mes para saber quién cumplió su horario. ASIS_CAM identifica a cada docente por su cara —evitando que alguien fiche por otro—, avisa automáticamente ante una tardanza o una falta, y evita que un mismo evento institucional quede cargado dos veces por error, gracias a un control anti-duplicados incorporado en la propia base de datos."
    ),
    sectionTitle("6 Ventajas Clave"),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: allBorders("FFFFFF", 12),
      rows: [
        new TableRow({
          children: [
            ventajaCard("⏱️", "Ahorro de tiempo", "Se termina cargar planillas a mano y sumar asistencias a fin de mes."),
            ventajaCard("🔒", "Seguridad biométrica", "Nadie puede marcar la entrada de otro: cada rostro es único e intransferible."),
            ventajaCard("📊", "Reportes en tiempo real", "Estadísticas y alertas actualizadas al instante, sin esperar a fin de mes."),
          ],
        }),
        new TableRow({
          children: [
            ventajaCard("📱", "Cualquier dispositivo", "Funciona desde PC, tablet o celular, con solo un navegador y cámara."),
            ventajaCard("🚫", "Anti-duplicados", "Un mismo evento no puede quedar cargado dos veces, ni por un doble clic."),
            ventajaCard("🔑", "Accesos diferenciados", "Panel propio para Administración y panel propio para cada Docente."),
          ],
        }),
      ],
    }),
  ];

  // ---- Página 2 ----
  const filaComparativa = (antes, despues) =>
    new TableRow({
      children: [
        cell(antes, { fill: "F5E9E9", align: AlignmentType.LEFT, size: 20 }),
        cell(despues, { fill: COLOR.oliveTint, align: AlignmentType.LEFT, size: 20 }),
      ],
    });

  const comparativa = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allBorders("D9D9D9", 4),
    rows: [
      new TableRow({
        tableHeader: true,
        children: [
          cell("❌  ANTES (planilla manual)", { bold: true, fill: COLOR.danger, color: "FFFFFF", align: AlignmentType.CENTER, size: 22 }),
          cell("✅  DESPUÉS (con ASIS_CAM)", { bold: true, fill: COLOR.success, color: "FFFFFF", align: AlignmentType.CENTER, size: 22 }),
        ],
      }),
      filaComparativa("Cualquiera puede firmar por otro docente ausente.", "El rostro es la credencial: imposible fichar por otra persona."),
      filaComparativa("Las faltas se descubren días después, revisando papeles.", "Alerta automática apenas se detecta una falta o tardanza."),
      filaComparativa("Un evento cargado dos veces genera confusión y reclamos.", "Control anti-duplicados a nivel de base de datos."),
      filaComparativa("Los reportes mensuales se arman a mano, con errores.", "Estadísticas y gráficos generados solos, en tiempo real."),
      filaComparativa("Solo se puede fichar en el edificio, con el libro físico presente.", "Se ficha desde cualquier dispositivo con cámara e internet."),
    ],
  });

  const pagina2 = [
    new Paragraph({ text: "", pageBreakBefore: true }),
    sectionTitle("Antes vs. Después"),
    comparativa,
    sectionTitle("Lo que dicen de nosotros"),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: allBorders(COLOR.accent, 6),
      rows: [
        new TableRow({
          children: [
            new TableCell({
              shading: { type: ShadingType.CLEAR, fill: "FBF6E7" },
              margins: { top: 220, bottom: 220, left: 300, right: 300 },
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      text: "\"Desde que implementamos ASIS_CAM, el reporte de asistencia docente que antes nos llevaba dos días de trabajo administrativo ahora lo tenemos actualizado minuto a minuto. El reconocimiento facial terminó por completo con los fichajes cruzados entre colegas.\"",
                      italics: true,
                      font: FONT,
                      size: 22,
                      color: COLOR.primaryDark,
                    }),
                  ],
                  spacing: { after: 100 },
                }),
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      text: "— Testimonio ficticio con fines ilustrativos, Dirección de un instituto secundario",
                      bold: true,
                      font: FONT,
                      size: 18,
                      color: COLOR.gray,
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  ];

  // ---- Página 3: Planes y contacto ----
  const planCell = (nombre, precio, items, destacado) =>
    new TableCell({
      width: { size: 33.33, type: WidthType.PERCENTAGE },
      shading: { type: ShadingType.CLEAR, fill: destacado ? COLOR.primary : "FFFFFF" },
      borders: allBorders(destacado ? COLOR.accent : "D9D9D9", destacado ? 10 : 4),
      margins: { top: 240, bottom: 240, left: 220, right: 220 },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: nombre, bold: true, font: FONT, size: 26, color: destacado ? COLOR.accent : COLOR.primaryDark })],
          spacing: { after: 60 },
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: precio, bold: true, font: FONT, size: 30, color: destacado ? "FFFFFF" : COLOR.primary })],
          spacing: { after: 140 },
        }),
        ...items.map(
          (it) =>
            new Paragraph({
              spacing: { after: 60 },
              children: [new TextRun({ text: `✔ ${it}`, font: FONT, size: 18, color: destacado ? "F2F2F2" : COLOR.gray })],
            })
        ),
      ],
    });

  const planes = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allBorders("FFFFFF", 0),
    rows: [
      new TableRow({
        children: [
          planCell("BÁSICO", "Consultar", ["Hasta 20 docentes", "Fichaje facial", "Reportes básicos", "Soporte por email"], false),
          planCell("INSTITUCIONAL", "El más elegido", ["Docentes ilimitados", "Eventos especiales", "Alertas automáticas", "Estadísticas avanzadas", "Soporte prioritario"], true),
          planCell("A MEDIDA", "Consultar", ["Múltiples sedes", "Integraciones a pedido", "Capacitación al equipo", "Acompañamiento dedicado"], false),
        ],
      }),
    ],
  });

  const pagina3 = [
    new Paragraph({ text: "", pageBreakBefore: true }),
    sectionTitle("Planes"),
    planes,
    sectionTitle("Contacto"),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: allBorders(COLOR.primary, 8),
      rows: [
        new TableRow({
          children: [
            new TableCell({
              shading: { type: ShadingType.CLEAR, fill: COLOR.primaryDark },
              margins: { top: 260, bottom: 260, left: 320, right: 320 },
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [new TextRun({ text: "¿Listo para dejar atrás las planillas de papel?", bold: true, font: FONT, size: 28, color: "FFFFFF" })],
                  spacing: { after: 120 },
                }),
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({ text: "🌐  asiscam-uno.netlify.app", font: FONT, size: 22, color: COLOR.accent, bold: true }),
                  ],
                  spacing: { after: 60 },
                }),
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [new TextRun({ text: "💻  github.com/Diosmel84/ASIS_CAM", font: FONT, size: 20, color: "F2F2F2" })],
                  spacing: { after: 60 },
                }),
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [new TextRun({ text: "Solicite hoy mismo una demostración sin cargo para su institución.", italics: true, font: FONT, size: 20, color: "F2F2F2" })],
                }),
              ],
            }),
          ],
        }),
      ],
    }),
  ];

  const children = [...pagina1, ...pagina2, ...pagina3];

  return new Document({
    creator: "Diosmel",
    title: "Folleto Comercial - ASIS_CAM",
    description: "Brochure de ventas de ASIS_CAM",
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
