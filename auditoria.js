// ============================================================
// ASISCAM PRO - Log de auditoría (solo visible para MEUDEUS/PROGRAMADOR)
// auditoria.js - Script clásico (igual que roles.js/script.js).
//
// Fuente principal: tabla `auditoria_logs` de Supabase (ver
// add_tabla_auditoria_logs.sql) - así se ve el mismo historial desde
// cualquier dispositivo/navegador. localStorage (key "asiscam_logs")
// queda como respaldo: si no hay conexión, logAccion() igual guarda
// ahí y el panel lo usa como fallback para no mostrar "vacío".
//
// Se carga antes que script.js en index.html para que logAccion() ya
// exista cuando login()/saveTeacher()/etc. la llamen.
// ============================================================

const AUDIT_LOG_KEY = 'asiscam_logs';
// Techo de cuántos registros se traen/guardan de una. Al superarlo se
// quedan los más recientes (Supabase puede tener más en el historico).
const AUDIT_LOG_MAX = 5000;

// null = todavía no se cargó nada de Supabase en esta sesión (recién
// abierta la app). Una vez que cargarLogsAuditoria() corre al menos
// una vez, queda con el array real (aunque esté vacío).
let auditLogsCache = null;

function formatFechaHoraLog(date) {
    const d = date || new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getLogsBackupLocal() {
    try {
        return JSON.parse(localStorage.getItem(AUDIT_LOG_KEY) || '[]');
    } catch (e) {
        return [];
    }
}

function guardarLogsBackupLocal(logs) {
    try {
        localStorage.setItem(AUDIT_LOG_KEY, JSON.stringify(logs));
    } catch (e) { /* localStorage lleno o deshabilitado: no hay más respaldo posible */ }
}

// Devuelve lo último cargado (Supabase si ya se pudo, si no el
// respaldo local). Sincrónico a propósito: lo usan varias funciones
// (contadores, filtros, export) que no esperan una promesa - por eso
// cargarLogsAuditoria() se llama ANTES, al abrir el panel.
function getLogs() {
    return auditLogsCache !== null ? auditLogsCache : getLogsBackupLocal();
}

function clearLogs() {
    guardarLogsBackupLocal([]);
    auditLogsCache = [];
}

// Trae el historial real desde Supabase (los últimos AUDIT_LOG_MAX,
// del más viejo al más nuevo) y de paso refresca el respaldo local con
// ese mismo valor. Si Supabase no responde, cae al respaldo local sin
// romper el panel. Se llama al entrar a la pestaña "Auditoría" y justo
// después de loguearse como Programador (ver index.html/script.js).
async function cargarLogsAuditoria() {
    if (typeof sb !== 'undefined' && sb) {
        try {
            const { data, error } = await sb.from('auditoria_logs')
                .select('*').order('timestamp', { ascending: false }).limit(AUDIT_LOG_MAX);
            if (error) throw error;
            auditLogsCache = (data || []).slice().reverse();
            guardarLogsBackupLocal(auditLogsCache);
            return;
        } catch (e) {
            console.error('No se pudo traer el log de auditoría desde Supabase, se usa el respaldo local:', e);
        }
    }
    auditLogsCache = getLogsBackupLocal();
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

        // Respaldo local: sincrónico, nunca depende de la red (para
        // que un fichaje/login nunca se demore ni falle por esto).
        const logsLocal = getLogsBackupLocal();
        logsLocal.push(entry);
        if (logsLocal.length > AUDIT_LOG_MAX) logsLocal.splice(0, logsLocal.length - AUDIT_LOG_MAX);
        guardarLogsBackupLocal(logsLocal);
        if (auditLogsCache !== null) auditLogsCache.push(entry);

        // Fuente principal: se sube en segundo plano (fire-and-forget,
        // sin await) para no bloquear la acción real que disparó el
        // log. Si falla (sin conexión), el registro ya quedó en el
        // respaldo local y listo - no hay cola de reintento para
        // logs, a diferencia de app_data, porque no es información
        // crítica de negocio.
        if (typeof sb !== 'undefined' && sb) {
            sb.from('auditoria_logs').insert({
                fecha: entry.fecha, timestamp: entry.timestamp, usuario: entry.usuario, rol: entry.rol,
                accion: entry.accion, detalle: entry.detalle, dispositivo: entry.dispositivo,
                plataforma: entry.plataforma, ubicacion: entry.ubicacion,
            }).then(({ error }) => {
                if (error) console.error('No se pudo subir el log de auditoría a Supabase (queda en el respaldo local):', error);
            });
        }
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
    const soloFueraDeItuzaingo = document.getElementById('auditoriaFiltroFueraItuzaingo')?.checked;
    const soloFakeGps = document.getElementById('auditoriaFiltroFakeGps')?.checked;
    return getLogs().filter(l => {
        if (usuario && !(l.usuario || '').toLowerCase().includes(usuario)) return false;
        if (accion && !(l.accion || '').toLowerCase().includes(accion)) return false;
        if (desde || hasta) {
            const fechaLog = new Date(l.timestamp || 0).toISOString().split('T')[0];
            if (desde && fechaLog < desde) return false;
            if (hasta && fechaLog > hasta) return false;
        }
        // Aproximado por texto de la dirección ya resuelta (Nominatim),
        // no por límites administrativos reales - no tenemos esa data.
        if (soloFueraDeItuzaingo && (l.ubicacion?.direccion || '').toLowerCase().includes('ituzaingó')) return false;
        if (soloFakeGps && !l.ubicacion?.fakeGpsSospechoso) return false;
        return true;
    }).slice().reverse();
}

// HTML de la celda "Ubicación": link a Google Maps con la dirección
// aproximada como texto (o "GPS: lat,lon (pendiente sync)" con badge
// amarillo si todavía no se resolvió la dirección), "-" si el log no
// tiene ubicación en absoluto (login sin permiso GPS ni IP, o acciones
// que nunca la piden, como guardar una materia). Tooltip con el
// detalle completo (lat/lon/precisión/IP).
function celdaUbicacionLog(l) {
    if (!l.ubicacion || l.ubicacion.lat == null) return '-';
    const lat = Number(l.ubicacion.lat), lng = Number(l.ubicacion.lng);
    const tienedireccion = !!l.ubicacion.direccion;
    const texto = tienedireccion ? l.ubicacion.direccion : `GPS: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const pendienteBadge = tienedireccion ? '' : ' <span class="badge bg-warning text-dark">pendiente sync</span>';
    const fakeGpsBadge = l.ubicacion.fakeGpsSospechoso ? ' <span class="badge bg-danger" title="Heurística débil, no es detección real de GPS falso">POSIBLE UBICACIÓN FALSA</span>' : '';
    const tooltip = [
        `Lat/Lon: ${lat}, ${lng}`,
        l.ubicacion.precision != null ? `Precisión: ${l.ubicacion.precision}m` : null,
        l.ubicacion.ip ? `IP: ${l.ubicacion.ip}` : null,
        l.ubicacion.fuente ? `Fuente: ${l.ubicacion.fuente === 'gps' ? 'GPS del dispositivo' : 'aproximada por IP'}` : null,
    ].filter(Boolean).join(' · ');
    return `<a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener" title="${tooltip}"><i class="bi bi-geo-alt-fill"></i> ${texto}</a>${pendienteBadge}${fakeGpsBadge}`;
}

function hayFiltrosActivosAuditoria() {
    const textoActivo = ['auditoriaFiltroUsuario', 'auditoriaFiltroAccion', 'auditoriaFiltroDesde', 'auditoriaFiltroHasta']
        .some(id => (document.getElementById(id)?.value || '').trim() !== '');
    const checkActivo = ['auditoriaFiltroFueraItuzaingo', 'auditoriaFiltroFakeGps']
        .some(id => document.getElementById(id)?.checked);
    return textoActivo || checkActivo;
}

function renderAuditoriaPanel() {
    const tbody = document.getElementById('auditoriaTableBody');
    if (!tbody) return;
    const totalEl = document.getElementById('auditoriaCountTotal');
    const hoyEl = document.getElementById('auditoriaCountHoy');
    const semanaEl = document.getElementById('auditoriaCountSemana');
    const totalLogs = getLogs().length;
    if (totalEl) totalEl.textContent = totalLogs;
    if (hoyEl) hoyEl.textContent = contarAccionesHoy();
    if (semanaEl) semanaEl.textContent = contarAccionesSemana();

    const logs = getLogsFiltrados();
    const infoEl = document.getElementById('auditoriaFiltroInfo');
    if (infoEl) {
        infoEl.textContent = hayFiltrosActivosAuditoria()
            ? `Filtros activos - Mostrando ${logs.length} de ${totalLogs} eventos`
            : '';
    }
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
                <td><small>${celdaUbicacionLog(l)}</small></td>
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

// "Recargar" de verdad: además de limpiar los 4 inputs, vuelve a traer
// el historial completo desde Supabase (no solo re-renderiza lo que
// ya había en memoria).
function limpiarFiltrosAuditoria() {
    ['auditoriaFiltroUsuario', 'auditoriaFiltroAccion', 'auditoriaFiltroDesde', 'auditoriaFiltroHasta'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    ['auditoriaFiltroFueraItuzaingo', 'auditoriaFiltroFakeGps'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.checked = false;
    });
    cargarLogsAuditoria().then(renderAuditoriaPanel);
}

// sufijoArchivo/sufijoAccion se usan para diferenciar el backup
// automático de borrarLogsConfirm() (exporta TODO, sin filtro) del
// export manual de "Exportar Excel" (respeta el filtro activo).
function exportarLogsAExcel(logs, sufijoArchivo, sufijoAccion) {
    if (logs.length === 0) { showToast('No hay registros para exportar', 'warning'); return false; }
    const rows = logs.map(l => ({
        Fecha: l.fecha, Usuario: l.usuario, Rol: l.rol, Accion: l.accion, Detalle: l.detalle || '',
        Dispositivo: l.dispositivo || '', Plataforma: l.plataforma || '',
        Ubicacion: l.ubicacion && l.ubicacion.lat != null ? `${l.ubicacion.lat}, ${l.ubicacion.lng}` : '',
        Direccion: l.ubicacion?.direccion || '',
        PrecisionM: l.ubicacion?.precision ?? '',
        IP: l.ubicacion?.ip || '',
        FakeGpsSospechoso: l.ubicacion?.fakeGpsSospechoso ? 'SI' : '',
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 40 }, { wch: 30 }, { wch: 14 }, { wch: 20 }, { wch: 26 }, { wch: 12 }, { wch: 15 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Auditoria');
    XLSX.writeFile(wb, `asiscam_auditoria${sufijoArchivo || ''}_${new Date().toISOString().split('T')[0]}.xlsx`);
    logAccion('EXPORTAR_LOG', `Exportó ${logs.length} registro(s) a Excel${sufijoAccion || ''}`);
    return true;
}

function exportarLogExcel() {
    if (exportarLogsAExcel(getLogsFiltrados(), '', '')) renderAuditoriaPanel();
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
        const ubicacionTexto = l.ubicacion && l.ubicacion.lat != null
            ? ` | Ubicación: ${l.ubicacion.direccion || `${l.ubicacion.lat}, ${l.ubicacion.lng}`}`
            : '';
        const linea = `${l.fecha} | ${l.usuario} (${l.rol}) | ${l.accion} | ${l.detalle || ''}${ubicacionTexto}`;
        if (y > 780) { doc.addPage(); y = 40; }
        doc.text(linea.slice(0, 160), 40, y);
        y += 14;
    });
    doc.save(`asiscam_auditoria_${new Date().toISOString().split('T')[0]}.pdf`);
    logAccion('EXPORTAR_LOG', `Exportó ${logs.length} registro(s) a PDF`);
    renderAuditoriaPanel();
}

async function borrarLogsConfirm() {
    if (!confirm('¿Seguro que querés borrar TODO el log de auditoría (todos los dispositivos, no solo lo filtrado)? Se descarga un backup automático con TODO el historial antes de borrar. Esta acción no se puede deshacer.')) return;

    const todos = getLogs();
    const cantidad = todos.length;
    // Backup de TODO el historial (sin filtro), no lo que esté
    // filtrado en pantalla en ese momento - es la última copia antes
    // de un borrado irreversible.
    if (cantidad > 0) exportarLogsAExcel(todos, '_backup_antes_de_borrar', ' (backup automático antes de borrar)');

    clearLogs();
    if (typeof sb !== 'undefined' && sb) {
        const { error } = await sb.from('auditoria_logs').delete().gt('id', 0);
        if (error) {
            console.error('No se pudo borrar el log de auditoría en Supabase:', error);
            showToast('Se borró local, pero no se pudo borrar en Supabase (' + describeSupabaseError(error) + ')', 'warning');
        }
    }
    logAccion('BORRAR_LOG', `Borró ${cantidad} registro(s) del log de auditoría`);
    renderAuditoriaPanel();
    showToast('Log de auditoría borrado (backup descargado antes)', 'info');
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
