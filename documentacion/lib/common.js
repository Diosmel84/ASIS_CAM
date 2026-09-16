"use strict";
/**
 * Utilidades compartidas por los 3 generadores de documentos ASIS_CAM.
 * Norma APA 7ma edición: Times New Roman 12, márgenes 2.54 cm, encabezado
 * con el nombre de la plataforma y pie de página con número de página.
 */
const {
  Document, Paragraph, TextRun, HeadingLevel, AlignmentType, Header, Footer,
  PageNumber, TableOfContents, Table, TableRow, TableCell, WidthType,
  BorderStyle, ShadingType, VerticalAlign, convertMillimetersToTwip,
  PageOrientation, TabStopType, TabStopPosition, ExternalHyperlink,
  Packer,
} = require("docx");

const FONT = "Times New Roman";

// Paleta institucional (usada sobre todo en el folleto comercial)
const COLOR = {
  primary: "1B3A5C", // azul institucional oscuro
  primaryDark: "0F2438",
  accent: "C9A227", // dorado
  olive: "5B6B3D", // guiño al tema visual real de la app (--olive-800)
  oliveTint: "EAF0DE",
  gray: "555555",
  lightGray: "F2F2F2",
  white: "FFFFFF",
  danger: "8B2E2E",
  success: "2E7D4F",
};

const A4_PORTRAIT = {
  width: convertMillimetersToTwip(210),
  height: convertMillimetersToTwip(297),
};
const A4_LANDSCAPE = {
  width: convertMillimetersToTwip(297),
  height: convertMillimetersToTwip(210),
};

const MARGIN_APA = {
  top: convertMillimetersToTwip(25.4),
  bottom: convertMillimetersToTwip(25.4),
  left: convertMillimetersToTwip(25.4),
  right: convertMillimetersToTwip(25.4),
};

function pageHeader(subtitle) {
  return new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR.primary, space: 4 } },
        children: [
          new TextRun({ text: "ASIS_CAM", bold: true, font: FONT, size: 20, color: COLOR.primary }),
          new TextRun({ text: subtitle ? `\t${subtitle}` : "", italics: true, font: FONT, size: 18, color: COLOR.gray }),
        ],
      }),
    ],
  });
}

// Pie de página formato APA: número de página centrado.
function pageFooterAPA() {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20 }),
        ],
      }),
    ],
  });
}

function titlePage({ titulo, subtitulo, autor, institucion, curso, docente, fecha, lugar }) {
  const blank = (n = 1) => Array.from({ length: n }, () => new Paragraph({ text: "" }));
  const centered = (text, opts = {}) =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text, font: FONT, size: opts.size || 24, bold: !!opts.bold })],
    });

  return [
    ...blank(3),
    centered(institucion, { size: 26, bold: true }),
    centered("Documentación Técnica de Plataforma", { size: 24 }),
    ...blank(4),
    centered(titulo, { size: 32, bold: true }),
    centered(subtitulo, { size: 26 }),
    ...blank(4),
    centered(autor, { size: 24 }),
    centered(curso || "", { size: 22 }),
    centered(docente ? `Presentado a: ${docente}` : "", { size: 22 }),
    ...blank(6),
    centered(lugar, { size: 22 }),
    centered(fecha, { size: 22 }),
    new Paragraph({ text: "", pageBreakBefore: true }),
  ];
}

function toc() {
  return [
    new Paragraph({ text: "Índice", heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }),
    new Paragraph({
      children: [
        new TextRun({
          italics: true,
          size: 18,
          font: FONT,
          text: "Nota: este índice se genera automáticamente. En Word, haga clic derecho sobre él y seleccione \"Actualizar campo\" para reflejar la paginación final.",
        }),
      ],
      spacing: { after: 200 },
    }),
    new TableOfContents("Índice", {
      hyperlink: true,
      headingStyleRange: "1-3",
    }),
    new Paragraph({ text: "", pageBreakBefore: true }),
  ];
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 240, after: 160 },
    children: [new TextRun({ text, font: FONT, bold: true, size: 28, color: COLOR.primaryDark })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 120 },
    children: [new TextRun({ text, font: FONT, bold: true, size: 26, color: COLOR.primary })],
  });
}
function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 160, after: 100 },
    children: [new TextRun({ text, font: FONT, bold: true, italics: true, size: 24 })],
  });
}

// Párrafo de cuerpo. APA 7 = interlineado doble + sangría de primera línea en el cuerpo del texto.
function p(text, opts = {}) {
  const runs = Array.isArray(text)
    ? text
    : [new TextRun({ text, font: FONT, size: opts.size || 24, bold: !!opts.bold, italics: !!opts.italics })];
  return new Paragraph({
    children: runs,
    alignment: opts.align || AlignmentType.JUSTIFIED,
    spacing: { line: opts.line || 480, lineRule: "auto", after: opts.after ?? 0 },
    indent: opts.firstLine === false ? undefined : { firstLine: convertMillimetersToTwip(12.7) },
  });
}

// Párrafo simple sin sangría de primera línea (para manuales / folleto, interlineado sencillo)
function ps(text, opts = {}) {
  const runs = Array.isArray(text)
    ? text
    : [new TextRun({ text, font: FONT, size: opts.size || 22, bold: !!opts.bold, italics: !!opts.italics, color: opts.color })];
  return new Paragraph({
    children: runs,
    alignment: opts.align || AlignmentType.LEFT,
    spacing: { line: opts.line || 276, lineRule: "auto", after: opts.after ?? 120, before: opts.before ?? 0 },
  });
}

function bullet(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 80, line: opts.line || 276, lineRule: "auto" },
    indent: { left: convertMillimetersToTwip(8) },
    children: [
      new TextRun({ text: "•  ", font: FONT, size: opts.size || 22, bold: true }),
      new TextRun({ text, font: FONT, size: opts.size || 22 }),
    ],
  });
}

function numbered(n, text, opts = {}) {
  return new Paragraph({
    spacing: { after: 100, line: opts.line || 276, lineRule: "auto" },
    indent: { left: convertMillimetersToTwip(6), hanging: convertMillimetersToTwip(6) },
    children: [
      new TextRun({ text: `${n}. `, font: FONT, size: opts.size || 22, bold: true, color: opts.numColor || COLOR.primary }),
      new TextRun({ text, font: FONT, size: opts.size || 22 }),
    ],
  });
}

// Cita textual en bloque APA (40+ palabras): sangría 1.27cm, sin comillas.
function blockQuote(text, cite) {
  return new Paragraph({
    indent: { left: convertMillimetersToTwip(12.7) },
    spacing: { line: 480, lineRule: "auto", after: 120 },
    children: [new TextRun({ text: `${text} ${cite ? `(${cite})` : ""}`, font: FONT, size: 24 })],
  });
}

// Entrada de referencia APA 7 con sangría francesa.
function reference(text) {
  return new Paragraph({
    spacing: { line: 480, lineRule: "auto", after: 0 },
    indent: { left: convertMillimetersToTwip(12.7), hanging: convertMillimetersToTwip(12.7) },
    children: [new TextRun({ text, font: FONT, size: 24 })],
  });
}

function referenceLink(before, url, after) {
  return new Paragraph({
    spacing: { line: 480, lineRule: "auto", after: 0 },
    indent: { left: convertMillimetersToTwip(12.7), hanging: convertMillimetersToTwip(12.7) },
    children: [
      new TextRun({ text: before, font: FONT, size: 24 }),
      new ExternalHyperlink({
        link: url,
        children: [new TextRun({ text: url, font: FONT, size: 24, style: "Hyperlink", color: "1155CC", underline: {} })],
      }),
      new TextRun({ text: after || "", font: FONT, size: 24 }),
    ],
  });
}

function codeBlock(lines) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allBorders("999999", 4),
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, fill: "1E1E1E" },
            margins: { top: 120, bottom: 120, left: 160, right: 160 },
            children: lines.map(
              (line) =>
                new Paragraph({
                  spacing: { after: 0, line: 260, lineRule: "auto" },
                  children: [new TextRun({ text: line || " ", font: "Consolas", size: 19, color: "D4D4D4" })],
                })
            ),
          }),
        ],
      }),
    ],
  });
}

function allBorders(color = "AAAAAA", size = 4) {
  const b = { style: BorderStyle.SINGLE, size, color };
  return { top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b };
}

function cell(text, opts = {}) {
  const children = Array.isArray(text)
    ? text
    : [
        new Paragraph({
          alignment: opts.align || AlignmentType.LEFT,
          children: [
            new TextRun({
              text,
              font: FONT,
              size: opts.size || 20,
              bold: !!opts.bold,
              color: opts.color || (opts.dark ? "FFFFFF" : "000000"),
            }),
          ],
        }),
      ];
  return new TableCell({
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    shading: opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    columnSpan: opts.colSpan,
    children,
  });
}

function simpleTable(headerRow, bodyRows, opts = {}) {
  const rows = [];
  rows.push(
    new TableRow({
      tableHeader: true,
      children: headerRow.map((t) => cell(t, { bold: true, fill: opts.headerFill || COLOR.primary, color: "FFFFFF", align: AlignmentType.CENTER })),
    })
  );
  bodyRows.forEach((r, i) => {
    rows.push(
      new TableRow({
        children: r.map((t, ci) =>
          typeof t === "object" && t && t.__cellOpts
            ? cell(t.text, t.__cellOpts)
            : cell(String(t), { fill: opts.zebra && i % 2 === 1 ? opts.zebraFill || COLOR.lightGray : undefined })
        ),
      })
    );
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allBorders("BFBFBF", 4),
    rows,
  });
}

module.exports = {
  docx: {
    Document, Paragraph, TextRun, HeadingLevel, AlignmentType, Header, Footer,
    PageNumber, TableOfContents, Table, TableRow, TableCell, WidthType,
    BorderStyle, ShadingType, VerticalAlign, convertMillimetersToTwip,
    PageOrientation, TabStopType, TabStopPosition, ExternalHyperlink, Packer,
  },
  FONT, COLOR, A4_PORTRAIT, A4_LANDSCAPE, MARGIN_APA,
  pageHeader, pageFooterAPA, titlePage, toc,
  h1, h2, h3, p, ps, bullet, numbered, blockQuote, reference, referenceLink,
  codeBlock, allBorders, cell, simpleTable,
};
