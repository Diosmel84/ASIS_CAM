// ============================================================
// ASISCAM PRO - Log de auditoría (solo visible para MEUDEUS/PROGRAMADOR)
// auditoria.js - Script clásico (igual que roles.js/script.js).
// Guarda cada acción importante en localStorage (key "asiscam_logs"),
// 100% offline, sin depender de Supabase. Se carga antes que
// script.js en index.html para que logAccion() ya exista cuando
// login()/saveTeacher()/etc. la llamen.
// ============================================================

const AUDIT_LOG_KEY = 'asiscam_logs';
// Techo de seguridad para que el log no crezca sin límite en
// localStorage (que tiene un cupo chico, ~5-10MB según navegador).
// Al superarlo se descartan los registros más viejos.
const AUDIT_LOG_MAX = 5000;

function formatFechaHoraLog(date) {
    const d = date || new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getLogs() {
    try {
        return JSON.parse(localStorage.getItem(AUDIT_LOG_KEY) || '[]');
    } catch (e) {
        return [];
    }
}

function clearLogs() {
    localStorage.setItem(AUDIT_LOG_KEY, '[]');
}

// currentUser/adminUsuario viven en script.js (cargado después de este
// archivo), pero logAccion() solo se llama en respuesta a acciones del
// usuario, es decir, mucho después de que todos los <script> ya
// terminaron de ejecutarse - para ese momento la variable ya existe.
function logAccion(accion, detalle, ubicacion) {
    try {
        const user = typeof currentUser !== 'undefined' ? currentUser : null;
        const entry = {
            fecha: formatFechaHoraLog(),
            timestamp: Date.now(),
            usuario: user ? (user.username || user.dni || '-') : '-',
            rol: user ? (user.rol || user.role || '-') : '-',
            accion,
            detalle: detalle || '',
            dispositivo: navigator.userAgent,
            plataforma: navigator.platform,
            ubicacion: ubicacion || null,
        };
        const logs = getLogs();
        logs.push(entry);
        if (logs.length > AUDIT_LOG_MAX) logs.splice(0, logs.length - AUDIT_LOG_MAX);
        localStorage.setItem(AUDIT_LOG_KEY, JSON.stringify(logs));
    } catch (e) {
        console.error('No se pudo guardar el log de auditoría', e);
    }
}

function contarAccionesHoy() {
    const today = new Date().toDateString();
    return getLogs().filter(l => new Date(l.timestamp || 0).toDateString() === today).length;
}

function contarAccionesSemana() {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return getLogs().filter(l => (l.timestamp || 0) >= weekAgo).length;
}

function getLogsFiltrados() {
    const usuario = (document.getElementById('auditoriaFiltroUsuario')?.value || '').trim().toLowerCase();
    const accion = (document.getElementById('auditoriaFiltroAccion')?.value || '').trim().toLowerCase();
    const desde = document.getElementById('auditoriaFiltroDesde')?.value || '';
    const hasta = document.getElementById('auditoriaFiltroHasta')?.value || '';
    return getLogs().filter(l => {
        if (usuario && !(l.usuario || '').toLowerCase().includes(usuario)) return false;
        if (accion && !(l.accion || '').toLowerCase().includes(accion)) return false;
        if (desde || hasta) {
            const fechaLog = new Date(l.timestamp || 0).toISOString().split('T')[0];
            if (desde && fechaLog < desde) return false;
            if (hasta && fechaLog > hasta) return false;
        }
        return true;
    }).slice().reverse();
}

function renderAuditoriaPanel() {
    const tbody = document.getElementById('auditoriaTableBody');
    if (!tbody) return;
    const totalEl = document.getElementById('auditoriaCountTotal');
    const hoyEl = document.getElementById('auditoriaCountHoy');
    const semanaEl = document.getElementById('auditoriaCountSemana');
    if (totalEl) totalEl.textContent = getLogs().length;
    if (hoyEl) hoyEl.textContent = contarAccionesHoy();
    if (semanaEl) semanaEl.textContent = contarAccionesSemana();

    const logs = getLogsFiltrados();
    if (logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Sin registros</td></tr>';
    } else {
        // Se listan como máximo los 500 más recientes en pantalla (ya
        // filtrados) para no colgar el navegador; la exportación a
        // Excel/PDF sí toma todo lo filtrado.
        tbody.innerHTML = logs.slice(0, 500).map(l => `
            <tr>
                <td><small>${l.fecha}</small></td>
                <td>${l.usuario}<br><span class="badge bg-secondary">${l.rol}</span></td>
                <td>${l.accion}</td>
                <td><small>${l.detalle || ''}</small></td>
                <td><small>${(l.dispositivo || '').slice(0, 70)}</small></td>
                <td><small>${l.ubicacion && l.ubicacion.lat != null ? `${Number(l.ubicacion.lat).toFixed(4)}, ${Number(l.ubicacion.lng).toFixed(4)}` : '-'}</small></td>
            </tr>
        `).join('');
    }
    renderCredencialesPanel();
}

// Desde que Secretaría/Rector/Programador(bootstrap) se validan por
// hash SHA-256 (ver roles.js), la app ya no tiene la contraseña en
// texto plano en memoria para estos 3 casos - ni siquiera este panel
// "ver claves" puede mostrarla, es la consecuencia lógica de hashear.
// Lo único que se puede mostrar es el hash cargado (útil para
// verificar que config.secrets.js quedó bien puesto) o, si querés
// cambiarla, editar config.secrets.js y volver a calcular el hash.
function renderCredencialesPanel() {
    const el = document.getElementById('auditoriaCredenciales');
    if (!el) return;
    const hashes = window.ASISCAM_CRED_HASHES || {};
    const esProgramadorBootstrap = !(typeof adminUsuario !== 'undefined' && adminUsuario && adminUsuario.id);
    const progCelda = esProgramadorBootstrap
        ? `Protegida por hash SHA-256 (config.secrets.js) — <code>${hashes.PROGRAMADOR_BOOTSTRAP || '(no cargado)'}</code>`
        : `${adminUsuario.password || '(no cargado)'} <small class="text-muted">(guardada en Supabase, cambiable desde "Cambiar Contraseña")</small>`;
    el.innerHTML = `
        ${window.ASISCAM_DEMO_MODE ? '<p class="text-warning small mb-2"><i class="bi bi-exclamation-triangle"></i> MODO DEMO: estos hashes son los de config.example.js, no las credenciales reales.</p>' : ''}
        <table class="table table-sm table-bordered mb-0">
            <thead><tr><th>Rol</th><th>Usuario</th><th>Contraseña</th></tr></thead>
            <tbody>
                <tr><td>Docente</td><td colspan="2">DNI de cada docente / contraseña individual (ver pestaña Docentes)</td></tr>
                <tr><td>Secretaría</td><td>${CREDENCIALES_ADMIN_USUARIO[ROLES.SECRETARIA]}</td><td>Protegida por hash SHA-256 (config.secrets.js) — <code>${hashes.SECRETARIA || '(no cargado)'}</code></td></tr>
                <tr><td>Rector</td><td>${CREDENCIALES_ADMIN_USUARIO[ROLES.RECTOR]}</td><td>Protegida por hash SHA-256 (config.secrets.js) — <code>${hashes.RECTOR || '(no cargado)'}</code></td></tr>
                <tr><td>Programador</td><td>${PROGRAMADOR_LOGIN_USER}</td><td>${progCelda}</td></tr>
            </tbody>
        </table>
    `;
}

function filtrarAuditoria() { renderAuditoriaPanel(); }

function limpiarFiltrosAuditoria() {
    ['auditoriaFiltroUsuario', 'auditoriaFiltroAccion', 'auditoriaFiltroDesde', 'auditoriaFiltroHasta'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    renderAuditoriaPanel();
}

function exportarLogExcel() {
    const logs = getLogsFiltrados();
    if (logs.length === 0) { showToast('No hay registros para exportar', 'warning'); return; }
    const rows = logs.map(l => ({
        Fecha: l.fecha, Usuario: l.usuario, Rol: l.rol, Accion: l.accion, Detalle: l.detalle || '',
        Dispositivo: l.dispositivo || '', Plataforma: l.plataforma || '',
        Ubicacion: l.ubicacion && l.ubicacion.lat != null ? `${l.ubicacion.lat}, ${l.ubicacion.lng}` : '',
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 40 }, { wch: 30 }, { wch: 14 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Auditoria');
    XLSX.writeFile(wb, `asiscam_auditoria_${new Date().toISOString().split('T')[0]}.xlsx`);
    logAccion('EXPORTAR_LOG', `Exportó ${logs.length} registro(s) a Excel`);
    renderAuditoriaPanel();
}

function exportarLogPDF() {
    const logs = getLogsFiltrados();
    if (logs.length === 0) { showToast('No hay registros para exportar', 'warning'); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    doc.setFontSize(14);
    doc.text('ASISCAM PRO - Panel de Auditoría', 40, 40);
    doc.setFontSize(9);
    let y = 65;
    logs.slice(0, 500).forEach(l => {
        const linea = `${l.fecha} | ${l.usuario} (${l.rol}) | ${l.accion} | ${l.detalle || ''}`;
        if (y > 780) { doc.addPage(); y = 40; }
        doc.text(linea.slice(0, 130), 40, y);
        y += 14;
    });
    doc.save(`asiscam_auditoria_${new Date().toISOString().split('T')[0]}.pdf`);
    logAccion('EXPORTAR_LOG', `Exportó ${logs.length} registro(s) a PDF`);
    renderAuditoriaPanel();
}

function borrarLogsConfirm() {
    if (!confirm('¿Borrar TODO el log de auditoría? Esta acción no se puede deshacer.')) return;
    const cantidad = getLogs().length;
    clearLogs();
    logAccion('BORRAR_LOG', `Borró ${cantidad} registro(s) del log de auditoría`);
    renderAuditoriaPanel();
    showToast('Log de auditoría borrado', 'info');
}

function backupLocalStorage() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        data[key] = localStorage.getItem(key);
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `asiscam_backup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logAccion('BACKUP', 'Descargó backup completo de localStorage');
    showToast('✅ Backup descargado', 'success');
}

function restoreLocalStorageFile(inputEl) {
    const file = inputEl.files && inputEl.files[0];
    if (!file) return;
    if (!confirm('¿Restaurar este backup? Esto REEMPLAZA todos los datos guardados localmente (docentes, asistencias, configuración) y recarga la página. Esta acción no se puede deshacer.')) {
        inputEl.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            Object.keys(data).forEach(key => localStorage.setItem(key, data[key]));
            logAccion('RESTORE', `Restauró backup (${file.name})`);
            showToast('✅ Backup restaurado, recargando...', 'success');
            setTimeout(() => location.reload(), 1200);
        } catch (err) {
            console.error('Backup inválido', err);
            showToast('El archivo no es un backup válido', 'error');
        } finally {
            inputEl.value = '';
        }
    };
    reader.readAsText(file);
}
