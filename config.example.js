// ============================================================
// ASISCAM PRO - Config de EJEMPLO (este archivo SÍ se sube a git)
//
// config.secrets.js (gitignored, ver .gitignore) tiene los hashes
// reales de Secretaría/Rector/Programador y se carga ANTES que este
// archivo (ver index.html). Si existe, ya dejó cargado
// window.ASISCAM_CRED_HASHES y este bloque no hace nada.
//
// Si alguien clona el repo sin ese archivo (porque nunca existió en su
// máquina, o porque el <script src="config.secrets.js"> no encontró el
// archivo y el navegador lo ignoró en silencio), la app arranca igual
// en "modo demo": usa esta contraseña de ejemplo para los 3 roles
// admin y muestra el cartel "MODO DEMO - Configurar config.secrets.js"
// para que quede claro que no son las credenciales reales.
//
// Contraseña de ejemplo para los 3 roles en modo demo: asiscam-demo-2026
if (!window.ASISCAM_CRED_HASHES) {
    window.ASISCAM_CRED_HASHES = {
        SECRETARIA: 'bb52a0e122fc97d0c29190409e04ddf1263675fc6459c82ffe0724e8784d223e',
        RECTOR: 'bb52a0e122fc97d0c29190409e04ddf1263675fc6459c82ffe0724e8784d223e',
        PROGRAMADOR_BOOTSTRAP: 'bb52a0e122fc97d0c29190409e04ddf1263675fc6459c82ffe0724e8784d223e',
    };
    window.ASISCAM_DEMO_MODE = true;
}
