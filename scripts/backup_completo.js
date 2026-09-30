"use strict";
/**
 * Backup COMPLETO de los datos de Supabase: todas las tablas, todas las
 * filas (pagina de a 1000 para no cortar en el límite de la API), a
 * /backups/backup_completo_<fecha>/ - un JSON por tabla + resumen.json.
 *
 * Es solo lectura (no modifica nada en la base). /backups/ está en
 * .gitignore: los archivos incluyen contraseñas, fotos y datos
 * faciales, así que NO se suben a git ni se comparten.
 *
 * Complementa a scripts/backup.js (que solo respalda carreras/materias).
 * No incluye la ESTRUCTURA de las tablas (eso es el esquema SQL del
 * panel de Supabase), solo los datos.
 *
 * Lee SUPABASE_URL/SUPABASE_ANON_KEY del propio script.js, igual que
 * backup.js.
 *
 * Uso: node scripts/backup_completo.js
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");
function extraerConst(nombre) {
    const m = src.match(new RegExp(`const ${nombre}\\s*=\\s*'([^']+)'`));
    if (!m) throw new Error(`No se encontró ${nombre} en script.js`);
    return m[1];
}
const SUPABASE_URL = extraerConst("SUPABASE_URL");
const SUPABASE_ANON_KEY = extraerConst("SUPABASE_ANON_KEY");

// Todas las tablas del esquema público (las que usa la app y las que no).
const TABLAS = [
    "app_data", "usuarios", "docentes", "carreras", "materias",
    "evento_especial", "evento_docente", "auditoria_logs",
    "asistencia", "alerta", "horario", "docente_horario", "app_config",
];
const PAGINA = 1000;

async function traerTablaCompleta(tabla) {
    const filas = [];
    for (let desde = 0; ; desde += PAGINA) {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${tabla}?select=*`, {
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                Range: `${desde}-${desde + PAGINA - 1}`,
                "Range-Unit": "items",
            },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        const lote = await res.json();
        filas.push(...lote);
        if (lote.length < PAGINA) return filas;
    }
}

async function main() {
    const ahora = new Date();
    const stamp = ahora.toISOString().replace(/:/g, "-").replace(/\..+/, "");
    const dir = path.join(__dirname, "..", "backups", `backup_completo_${stamp}`);
    fs.mkdirSync(dir, { recursive: true });

    const resumen = { fecha: ahora.toISOString(), origen: SUPABASE_URL, tablas: {} };
    for (const tabla of TABLAS) {
        try {
            const filas = await traerTablaCompleta(tabla);
            fs.writeFileSync(path.join(dir, `${tabla}.json`), JSON.stringify(filas, null, 2), "utf8");
            resumen.tablas[tabla] = { filas: filas.length };
            console.log(`OK    ${tabla.padEnd(18)} ${filas.length} fila(s)`);
        } catch (e) {
            resumen.tablas[tabla] = { error: e.message };
            console.log(`ERROR ${tabla.padEnd(18)} ${e.message}`);
        }
    }
    fs.writeFileSync(path.join(dir, "resumen.json"), JSON.stringify(resumen, null, 2), "utf8");
    console.log(`\nBackup guardado en: ${dir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
