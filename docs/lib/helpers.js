"use strict";
/**
 * Utilidades compartidas por los 3 generadores de documentación de
 * ASIS-CAM PRO (Informe Técnico, Manual del Administrador, Manual del
 * Docente): membrete con logo, portada, jerarquía de títulos APA 7
 * estricta (mismo tamaño de fuente en todos los niveles, diferenciados
 * solo por alineación/negrita/cursiva) y figuras con epígrafe APA
 * (Figura N + título en cursiva + nota de fuente).
 *
 * Reutiliza fuente, márgenes, interlineado, tabla de contenido,
 * referencias y tablas de documentacion/lib/common.js.
 */
const fs = require("fs");
const path = require("path");

const {
  Document, Paragraph, TextRun, Header, Footer, ImageRun,
  AlignmentType, TabStopType, TabStopPosition, HeadingLevel,
  BorderStyle, Packer,
} = require("docx");

const {
  FONT, COLOR, A4_PORTRAIT, MARGIN_APA,
  pageFooterAPA, toc, p, bullet, numbered, reference, codeBlock, simpleTable,
} = require("../../documentacion/lib/common");

const ROOT = path.join(__dirname, "..", "..");
const LOGO_PATH = path.join(ROOT, "logo.png");
const SCREENSHOTS_DIR = path.join(__dirname, "..", "screenshots");

// Todas las capturas de pantalla de este lote se tomaron a 1568x745 px.
const SHOT_W = 1568;
const SHOT_H = 745;

function loadLogo() {
  return fs.readFileSync(LOGO_PATH);
}

function logoImage(logoBuf, width) {
  return new ImageRun({
    type: "png",
    data: logoBuf,
    transformation: { width, height: Math.round((width * 1280) / 1920) },
  });
}

function brandedHeader(logoBuf, subtitle) {
  return new Header({
    children: [
      new Paragraph({
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR.primary, space: 4 } },
        children: [
          logoImage(logoBuf, 36),
          new TextRun({ text: `\tASIS-CAM PRO${subtitle ? " — " + subtitle : ""}`, bold: true, font: FONT, size: 18, color: COLOR.primary }),
        ],
      }),
    ],
  });
}

function coverPage(logoBuf, { titulo, autor, fecha, subtitulo }) {
  const blank = (n = 1) => Array.from({ length: n }, () => new Paragraph({ text: "" }));
  const centered = (text, opts = {}) =>
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: opts.after ?? 120 },
      children: [new TextRun({ text, font: FONT, size: opts.size || 24, bold: !!opts.bold, italics: !!opts.italics })],
    });

  return [
    ...blank(2),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 400 }, children: [logoImage(logoBuf, 220)] }),
    centered(titulo, { size: 30, bold: true, after: 200 }),
    subtitulo ? centered(subtitulo, { size: 24, italics: true, after: 200 }) : new Paragraph({ text: "" }),
    ...blank(4),
    centered(`Autor: ${autor}`, { size: 26, bold: true }),
    centered(`Fecha: ${fecha}`, { size: 24 }),
    ...blank(6),
    centered("Argentina", { size: 22 }),
    new Paragraph({ text: "", pageBreakBefore: true }),
  ];
}

// Jerarquía de títulos APA 7 estricta: el tamaño de fuente no cambia entre
// niveles (siempre 12 pt); se diferencian por alineación y negrita/cursiva.
function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
    spacing: { before: 480, after: 240, line: 480, lineRule: "auto" },
    children: [new TextRun({ text, font: FONT, size: 24, bold: true })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    alignment: AlignmentType.LEFT,
    spacing: { before: 360, after: 200, line: 480, lineRule: "auto" },
    children: [new TextRun({ text, font: FONT, size: 24, bold: true })],
  });
}
function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    alignment: AlignmentType.LEFT,
    spacing: { before: 280, after: 160, line: 480, lineRule: "auto" },
    children: [new TextRun({ text, font: FONT, size: 24, bold: true, italics: true })],
  });
}

function sectionBreak() {
  return new Paragraph({ text: "", pageBreakBefore: true });
}

let figureCounter = 0;
function resetFigureCounter() {
  figureCounter = 0;
}

// Figura con epígrafe APA 7: "Figura N" (negrita) + título (cursiva) arriba,
// imagen centrada, y una nota de fuente debajo indicando que es una captura
// real del sistema en ejecución.
function figure(fileName, caption, opts = {}) {
  figureCounter += 1;
  const n = figureCounter;
  const filePath = path.join(SCREENSHOTS_DIR, fileName);
  const data = fs.readFileSync(filePath);
  const width = opts.width || 480;
  const height = Math.round((width * SHOT_H) / SHOT_W);
  return [
    new Paragraph({
      spacing: { before: 240, after: 40 },
      children: [new TextRun({ text: `Figura ${n}`, font: FONT, size: 24, bold: true })],
    }),
    new Paragraph({
      spacing: { after: 120 },
      children: [new TextRun({ text: caption, font: FONT, size: 24, italics: true })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new ImageRun({ type: "jpg", data, transformation: { width, height } })],
    }),
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({ text: "Nota. ", font: FONT, size: 20, italics: true }),
        new TextRun({ text: opts.nota || "Captura de pantalla real del sistema ASIS-CAM PRO en ejecución (http://localhost:3000), tomada el 16 de septiembre de 2026.", font: FONT, size: 20 }),
      ],
    }),
  ];
}

module.exports = {
  Document, Paragraph, TextRun, Packer,
  FONT, COLOR, A4_PORTRAIT, MARGIN_APA,
  pageFooterAPA, toc, p, bullet, numbered, reference, codeBlock, simpleTable,
  loadLogo, logoImage, brandedHeader, coverPage,
  h1, h2, h3, sectionBreak,
  figure, resetFigureCounter,
};
