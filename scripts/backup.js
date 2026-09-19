"use strict";
/**
 * Backup de `carreras` y `materias` (Supabase) a un JSON con fecha en
 * /backups/. Pensado para correr a mano antes de tocar esas tablas a
 * mano (SQL editor, pruebas, etc.) - ver fix_cascade_delete.sql, que
 * quedó a raíz de una materia real perdida por un ON DELETE CASCADE.
 *
 * Lee SUPABASE_URL/SUPABASE_ANON_KEY del propio script.js (no los
 * duplica acá a mano) para que nunca queden desactualizados si cambian
 * - ver "Conexión virgen" en AVANCES.md.
 *
 * Uso: node scripts/backup.js
 */
const fs = require("fs");
const path = require("path");

const SCRIPT_PATH = path.join(__dirname, "..", "script.js");
const src = fs.readFileSync(SCRIPT_PATH, "utf8");

function extraerConst(nombre) {
    const m = src.match(new RegExp(`const ${nombre}\\s*=\\s*'([^']+)'`));
    if (!m) throw new Error(`No se encontró ${nombre} en script.js`);
    return m[1];
}

const SUPABASE_URL = extraerConst("SUPABASE_URL");
const SUPABASE_ANON_KEY = extraerConst("SUPABASE_ANON_KEY");

async function traerTabla(tabla) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${tabla}?select=*`, {
        headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
    });
    if (!res.ok) {
        throw new Error(`Error trayendo ${tabla}: HTTP ${res.status} - ${await res.text()}`);
    }
    return res.json();
}

async function main() {
    const [carreras, materias] = await Promise.all([
        traerTabla("carreras"),
        traerTabla("materias"),
    ]);

    const backupsDir = path.join(__dirname, "..", "backups");
    fs.mkdirSync(backupsDir, { recursive: true });

    const ahora = new Date();
    const stamp = ahora.toISOString().replace(/:/g, "-").replace(/\..+/, "");
    const archivo = path.join(backupsDir, `backup_materias_${stamp}.json`);

    fs.writeFileSync(archivo, JSON.stringify({
        fecha: ahora.toISOString(),
        carreras,
        materias,
    }, null, 2), "utf8");

    console.log(`✅ Backup guardado en ${archivo}`);
    console.log(`   Carreras: ${carreras.length} | Materias: ${materias.length}`);
}

main().catch(err => {
    console.error("❌ No se pudo hacer el backup:", err.message);
    process.exit(1);
});
