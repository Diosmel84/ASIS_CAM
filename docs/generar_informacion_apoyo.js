"use strict";
/**
 * Genera docs/informacion_de_apoyo.pdf: hoja A4 única, lista para
 * imprimir, con 6 preguntas/respuestas de apoyo para la defensa oral
 * de la materia Base de Datos (docs/base_de_datos/).
 * Uso: node docs/generar_informacion_apoyo.js
 */
const fs = require("fs");
const path = require("path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const OUT_PATH = path.join(__dirname, "informacion_de_apoyo.pdf");

// Paleta institucional (misma que documentacion/lib/common.js: COLOR.primary / COLOR.gray)
const PRIMARY = rgb(0x1b / 255, 0x3a / 255, 0x5c / 255);
const GRAY = rgb(0x55 / 255, 0x55 / 255, 0x55 / 255);
const LIGHT_GRAY = rgb(0xf2 / 255, 0xf2 / 255, 0xf2 / 255);
const INK = rgb(0x1a / 255, 0x1a / 255, 0x1a / 255);
const WHITE = rgb(1, 1, 1);

const QA = [
  {
    p: "P1: ¿Por qué no hay tabla app_config y usan app_data?",
    r: "Patrón clave-valor genérico. app_data (key, value jsonb) guarda lateLimit y otros umbrales como JSON. Más flexible que columnas fijas, no requiere migraciones para nuevos configs.",
  },
  {
    p: "P2: ¿Qué significa DOCENTES ||--o{ MATERIAS?",
    r: "Relación Uno a Muchos opcional. Un docente PUEDE dictar materias, pero no es obligatorio (ej: preceptor). Por eso es opcional.",
  },
  {
    p: "P3: ¿Por qué eliminaron el campo tardanza?",
    r: "Dato redundante. Viola 3FN. Se calcula en consulta: fichaje > horario + lateLimit. Si cambia el límite en app_data no hay que recalcular tabla.",
  },
  {
    p: "P4: ¿Qué es APP_DATA_TEACHERS }o..o{ DOCENTES?",
    r: "Espejo por DNI sin FK real. app_data guarda copia JSON para velocidad offline. No hay integridad referencial, está documentado como tal.",
  },
  {
    p: "P5: ¿Por qué Supabase + Firebase Hosting?",
    r: "Supabase = BD relacional + RLS. Firebase = hosting estático gratis y rápido. Advertencia documentada: no usamos Supabase Auth, RLS abierto y validación de roles en cliente (inseguro para prod).",
  },
  {
    p: "P6: ¿Qué es supabase-schema.sql con escuelas?",
    r: "Diseño V2.0 multi-escuela (escuelas + suscripciones). Nunca conectado. Es antecedente para modelo SaaS.",
  },
];

function wrapText(text, font, size, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function build() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle("Información de Apoyo - Defensa Base de Datos");
  pdfDoc.setAuthor("Diosmel");
  pdfDoc.setSubject("Sistema de Asistencia Docente - Información de Apoyo para Defensa");

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const PAGE_W = 595.28; // A4
  const PAGE_H = 841.89;
  const MARGIN = 44;
  const CONTENT_W = PAGE_W - MARGIN * 2;

  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  // ===== Encabezado =====
  let y = PAGE_H - MARGIN;
  const titleSize = 18;
  page.drawText("Sistema de Asistencia Docente", {
    x: MARGIN, y: y - titleSize, size: titleSize, font: fontBold, color: PRIMARY,
  });
  y -= titleSize + 6;
  const subtitleSize = 12;
  page.drawText("Información de Apoyo para Defensa", {
    x: MARGIN, y: y - subtitleSize, size: subtitleSize, font: fontItalic, color: GRAY,
  });
  y -= subtitleSize + 10;
  // Filete institucional bajo el encabezado
  page.drawRectangle({ x: MARGIN, y: y - 2, width: CONTENT_W, height: 2.5, color: PRIMARY });
  y -= 22;

  // ===== Tarjetas P/R =====
  const qSize = 12.5;
  const rSize = 11;
  const lineGapQ = 16;
  const lineGapR = 14.5;
  const padX = 16;
  const padY = 14;
  const accentW = 4;
  const gapBetween = 15;
  const textMaxW = CONTENT_W - padX * 2 - accentW - 4;

  // Pre-cálculo de alturas para centrar el bloque completo entre el
  // encabezado y el pie, en vez de dejar espacio muerto al final.
  const blocks = QA.map(({ p, r }) => {
    const qLines = wrapText(p, fontBold, qSize, textMaxW);
    const rLines = wrapText(`R: ${r}`, font, rSize, textMaxW);
    const blockH = padY * 2 + qLines.length * lineGapQ + 4 + rLines.length * lineGapR;
    return { qLines, rLines, blockH };
  });
  const totalBlocksH = blocks.reduce((sum, b) => sum + b.blockH, 0) + gapBetween * (blocks.length - 1);
  const FOOTER_TOP = 54;
  const availableH = y - FOOTER_TOP;
  if (totalBlocksH < availableH) y -= (availableH - totalBlocksH) / 2;

  blocks.forEach(({ qLines, rLines, blockH }) => {
    const top = y;
    const bottom = top - blockH;

    // Fondo de la tarjeta + barra de acento a la izquierda
    page.drawRectangle({ x: MARGIN, y: bottom, width: CONTENT_W, height: blockH, color: LIGHT_GRAY });
    page.drawRectangle({ x: MARGIN, y: bottom, width: accentW, height: blockH, color: PRIMARY });

    let ty = top - padY - qSize;
    const tx = MARGIN + accentW + padX;
    qLines.forEach((line) => {
      page.drawText(line, { x: tx, y: ty, size: qSize, font: fontBold, color: PRIMARY });
      ty -= lineGapQ;
    });
    ty = top - padY - qLines.length * lineGapQ - 4 - rSize;
    rLines.forEach((line) => {
      page.drawText(line, { x: tx, y: ty, size: rSize, font, color: INK });
      ty -= lineGapR;
    });

    y = bottom - gapBetween;
  });

  // ===== Footer =====
  const footerSize = 9;
  const footerText = "Proyecto SaaS - Modelo por suscripción $25k/mes por escuela";
  const footerW = font.widthOfTextAtSize(footerText, footerSize);
  page.drawRectangle({ x: MARGIN, y: 30, width: CONTENT_W, height: 0.75, color: LIGHT_GRAY });
  page.drawText(footerText, {
    x: (PAGE_W - footerW) / 2, y: 14, size: footerSize, font: fontItalic, color: GRAY,
  });

  const bytes = await pdfDoc.save();
  fs.writeFileSync(OUT_PATH, bytes);
  console.log(`Generado: ${OUT_PATH} (${(bytes.length / 1024).toFixed(1)} KB, y final = ${y.toFixed(0)}pt, margen inferior disponible hasta footer = ${(y - 46).toFixed(0)}pt)`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
