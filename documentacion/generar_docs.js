"use strict";
/**
 * Genera los 3 documentos oficiales de ASIS_CAM en formato .docx (norma APA 7).
 * Uso: node documentacion/generar_docs.js
 */
const path = require("path");
const fs = require("fs");

const OUT_DIR = __dirname;

const targets = [
  { name: "01_Informe_Tecnico_ASIS_CAM_APA7.docx", mod: "./lib/doc1_informe_tecnico" },
  { name: "02_Manual_Usuario_ASIS_CAM.docx", mod: "./lib/doc2_manual_usuario" },
  { name: "03_Folleto_Comercial_ASIS_CAM.docx", mod: "./lib/doc3_folleto_comercial" },
];

async function main() {
  console.log("Generando documentación oficial de ASIS_CAM...\n");
  const generated = [];

  for (const t of targets) {
    const outPath = path.join(OUT_DIR, t.name);
    process.stdout.write(`  -> ${t.name} ... `);
    const { generate } = require(t.mod);
    await generate(outPath);
    const { size } = fs.statSync(outPath);
    console.log(`OK (${(size / 1024).toFixed(1)} KB)`);
    generated.push(outPath);
  }

  console.log("\nArchivos generados en /documentacion/:");
  generated.forEach((f) => console.log("  - " + path.relative(process.cwd(), f)));
}

main().catch((err) => {
  console.error("\nError generando la documentación:", err);
  process.exit(1);
});
