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
// ubicacion: 3 estados posibles, a propósito -
//   - no se pasa (undefined): "todavía no se sabe" - se intenta
//     conseguir GPS/IP en segundo plano (ver completarUbicacionLog()),
//     SIN bloquear la acción que disparó el log. Es el caso por
//     defecto: cubre LOGOUT, EDITAR_DOCENTE, ASIGNAR_MATERIAS, y en
//     general cualquier logAccion(accion, detalle) de 2 argumentos.
//   - null explícito: "no intentes" - login de docente (ya pide GPS
//     al fichar segundos después, sería un permiso redundante).
//   - un objeto {lat,lng,...}: ya viene resuelta por el llamador
//     (FICHAJE/FICHAJE_EVENTO, que ya hicieron su propio pedido de GPS
//     como parte de la validación de geocerca - no se vuelve a pedir
//     una segunda vez para lo mismo).
function logAccion(accion, detalle, ubicacion) {
    try {
        const user = typeof currentUser !== 'undefined' ? currentUser : null;
        const intentarUbicacion = ubicacion === undefined;
        const id = 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const entry = {
            id,
            fecha: formatFechaHoraLog(),
            timestamp: Date.now(),
            usuario: user ? (user.username || user.dni || '-') : '-',
            rol: user ? (user.rol || user.role || '-') : '-',
            accion,
            detalle: detalle || '',
            dispositivo: navigator.userAgent,
            plataforma: navigator.platform,
            ubicacion: intentarUbicacion ? null : (ubicacion || null),
            ubicacionPendiente: intentarUbicacion,
        };

        // Respaldo local: sincrónico, nunca depende de la red (para
        // que ninguna acción se demore o falle por esto).
        const logsLocal = getLogsBackupLocal();
        logsLocal.push(entry);
        if (logsLocal.length > AUDIT_LOG_MAX) logsLocal.splice(0, logsLocal.length - AUDIT_LOG_MAX);
        guardarLogsBackupLocal(logsLocal);
        if (auditLogsCache !== null) auditLogsCache.push(entry);

        // Fuente principal: se sube en segundo plano (fire-and-forget,
        // sin await). Si falla (sin conexión u otro error), queda en
        // una cola local para reintentar al reconectar (ver
        // reintentarLogsPendientes(), enganchado a onReconnectSync()
        // en script.js) - el registro ya está a salvo en el respaldo
        // local mientras tanto.
        if (typeof sb !== 'undefined' && sb) {
            sb.from('auditoria_logs').insert({
                fecha: entry.fecha, timestamp: entry.timestamp, usuario: entry.usuario, rol: entry.rol,
                accion: entry.accion, detalle: entry.detalle, dispositivo: entry.dispositivo,
                plataforma: entry.plataforma, ubicacion: entry.ubicacion,
            }).select('id').single().then(({ data, error }) => {
                if (error) {
                    console.error('No se pudo subir el log de auditoría a Supabase, queda pendiente de reintentar:', error);
                    encolarLogPendienteDeSync(entry);
                    return;
                }
                actualizarLogLocal(entry.id, { supabaseId: data.id });
            });
        } else {
            encolarLogPendienteDeSync(entry);
        }

        // La ubicación se intenta SIEMPRE en segundo plano cuando
        // corresponde (intentarUbicacion), haya o no conexión a
        // Supabase en este instante: si hay GPS pero no hay red
        // todavía, igual queda guardada localmente y se sube sola
        // cuando el log pendiente se reintente.
        if (intentarUbicacion) completarUbicacionLog(entry.id);
    } catch (e) {
        console.error('No se pudo guardar el log de auditoría', e);
    }
}

// Busca un log por id (respaldo local + cache en memoria si está
// cargado) y le aplica cambios - lo usan completarUbicacionLog() y el
// insert a Supabase (para anotar el id real que le tocó ahí).
function actualizarLogLocal(logId, cambios) {
    const logsLocal = getLogsBackupLocal();
    const idx = logsLocal.findIndex(l => l.id === logId);
    if (idx !== -1) { Object.assign(logsLocal[idx], cambios); guardarLogsBackupLocal(logsLocal); }
    if (auditLogsCache !== null) {
        const entry = auditLogsCache.find(l => l.id === logId);
        if (entry) Object.assign(entry, cambios);
    }
}

// Intenta conseguir la ubicación (GPS o IP, ver obtenerUbicacionParaLog()
// en script.js) DESPUÉS de haber guardado el log, sin bloquear la
// acción que lo disparó - fecha/timestamp del log (el momento real del
// hecho) nunca se tocan, solo se completa ubicacion una vez que se
// consigue (ubicacionResueltaEn deja constancia de cuándo).
async function completarUbicacionLog(logId) {
    if (typeof obtenerUbicacionParaLog !== 'function') return;
    const ubicacion = await obtenerUbicacionParaLog();
    if (!ubicacion) {
        // Ni GPS ni IP funcionaron (típicamente: sin conexión en este
        // instante). Se deja ubicacionPendiente:true - reintentarLogsPendientes()
        // lo vuelve a intentar al reconectar, en vez de darlo por
        // perdido para siempre.
        return;
    }
    const cambios = { ubicacion, ubicacionPendiente: false, ubicacionResueltaEn: new Date().toISOString() };
    actualizarLogLocal(logId, cambios);
    const entry = getLogsBackupLocal().find(l => l.id === logId);
    if (entry && entry.supabaseId && typeof sb !== 'undefined' && sb) {
        sb.from('auditoria_logs').update({ ubicacion: cambios.ubicacion }).eq('id', entry.supabaseId)
            .then(({ error }) => { if (error) console.error('No se pudo actualizar la ubicación del log en Supabase:', error); });
    }
    // Si el panel de Auditoría está abierto en este momento, refleja la
    // ubicación recién resuelta sin que el admin tenga que recargar.
    if (typeof renderAuditoriaPanel === 'function' && document.getElementById('auditoriaTableBody')) renderAuditoriaPanel();
}

// Logs que no se pudieron subir a Supabase (sin conexión u otro error)
// quedan acá para reintentar al reconectar.
const LOGS_PENDIENTES_KEY = 'asiscam_logs_pendientes_sync';

function encolarLogPendienteDeSync(entry) {
    try {
        const raw = localStorage.getItem(LOGS_PENDIENTES_KEY);
        const pendientes = raw ? JSON.parse(raw) : [];
        if (!pendientes.some(p => p.id === entry.id)) pendientes.push(entry);
        localStorage.setItem(LOGS_PENDIENTES_KEY, JSON.stringify(pendientes));
    } catch (e) { /* localStorage lleno o deshabilitado: no hay más respaldo posible */ }
}

// Se llama desde onReconnectSync() (window 'online', script.js) igual
// que flushPendingSync()/revalidatePendingGeofenceAttendance(). Usa la
// versión MÁS RECIENTE de cada log guardada en el respaldo local (por
// si mientras tanto completarUbicacionLog() ya le resolvió la
// ubicación), nunca la que tenía en el momento de encolarse.
async function reintentarLogsPendientes() {
    // 1) Reintentar la UBICACIÓN de cualquier log que haya quedado
    // pendiente (haya podido subirse a Supabase en su momento o no) -
    // ahora que hay señal, GPS/IP tienen otra chance.
    const pendientesDeUbicacion = getLogsBackupLocal().filter(l => l.ubicacionPendiente);
    for (const l of pendientesDeUbicacion) {
        await completarUbicacionLog(l.id);
    }

    // 2) Reintentar el INSERT a Supabase de los que no se habían
    // podido subir en absoluto, usando la versión más reciente del
    // log (por si el paso 1 de arriba ya le resolvió la ubicación).
    if (typeof sb === 'undefined' || !sb) return;
    let pendientesDeInsert;
    try {
        pendientesDeInsert = JSON.parse(localStorage.getItem(LOGS_PENDIENTES_KEY) || '[]');
    } catch (e) { return; }
    if (pendientesDeInsert.length === 0) return;
    const siguenPendientes = [];
    for (const entry of pendientesDeInsert) {
        const actual = getLogsBackupLocal().find(l => l.id === entry.id) || entry;
        try {
            const { data, error } = await sb.from('auditoria_logs').insert({
                fecha: actual.fecha, timestamp: actual.timestamp, usuario: actual.usuario, rol: actual.rol,
                accion: actual.accion, detalle: actual.detalle, dispositivo: actual.dispositivo,
                plataforma: actual.plataforma, ubicacion: actual.ubicacion,
            }).select('id').single();
            if (error) throw error;
            actualizarLogLocal(entry.id, { supabaseId: data.id });
        } catch (e) {
            console.error('Reintento de sincronización de log falló, sigue pendiente:', e);
            siguenPendientes.push(entry);
        }
    }
    localStorage.setItem(LOGS_PENDIENTES_KEY, JSON.stringify(siguenPendientes));
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
// Nunca "-": o hay ubicación, o se está por conseguir (⏳), o se probó
// de verdad y no se pudo (GPS apagado/permiso denegado, IP también
// falló). "-" no distingue "no se pidió" de "se pidió y falló"; estos
// 3 mensajes sí.
function celdaUbicacionLog(l) {
    if (l.ubicacionPendiente) {
        const desde = l.fecha ? l.fecha.split(' ')[1] || l.fecha : '';
        return `<span class="badge bg-warning text-dark" title="Intentando conseguir GPS/IP desde las ${desde}"><i class="bi bi-hourglass-split"></i> Sin señal al momento de la acción (desde ${desde}) - pendiente ubicación</span>`;
    }
    if (!l.ubicacion || l.ubicacion.lat == null) {
        // ubicacionPendiente ya es false acá: no es que falló, es que
        // esta acción puntual no la pide a propósito (login de
        // docente, que ya la pide al fichar; o un fichaje con bypass
        // de admin/kiosco/modo prueba sin geocerca real de por medio).
        return '<span class="text-muted small">Ubicación no solicitada para esta acción</span>';
    }
    const lat = Number(l.ubicacion.lat), lng = Number(l.ubicacion.lng);
    const texto = l.ubicacion.direccion || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const fakeGpsBadge = l.ubicacion.fakeGpsSospechoso ? ' <span class="badge bg-danger" title="Heurística débil, no es detección real de GPS falso">POSIBLE UBICACIÓN FALSA</span>' : '';
    // Si tardó en resolverse (guardó el log antes de tener ubicación,
    // ver ubicacionPendiente más arriba), se nota - no es lo mismo que
    // "se resolvió al toque".
    const horaAccion = l.fecha ? l.fecha.split(' ')[1] : null;
    const horaResuelta = l.ubicacionResueltaEn ? new Date(l.ubicacionResueltaEn).toLocaleTimeString('es-AR').slice(0, 5) : null;
    const recuperadaBadge = (horaResuelta && horaAccion && horaResuelta.slice(0, 5) !== horaAccion.slice(0, 5))
        ? ` <span class="badge bg-info text-dark" title="La acción fue a las ${horaAccion}, la ubicación recién se pudo confirmar a las ${horaResuelta}">ubicación recuperada</span>`
        : '';
    const tooltip = [
        `Lat/Lon: ${lat}, ${lng}`,
        l.ubicacion.precision != null ? `Precisión: ${l.ubicacion.precision}m` : null,
        l.ubicacion.ip ? `IP: ${l.ubicacion.ip}` : null,
        l.ubicacion.fuente ? `Fuente: ${l.ubicacion.fuente === 'gps' ? 'GPS del dispositivo' : 'aproximada por IP'}` : null,
        horaAccion ? `Hecho a las: ${horaAccion}` : null,
        horaResuelta ? `Ubicación confirmada a las: ${horaResuelta}` : null,
    ].filter(Boolean).join(' · ');
    return `<a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noopener" title="${tooltip}"><i class="bi bi-geo-alt-fill"></i> ${texto}</a>${recuperadaBadge}${fakeGpsBadge}`;
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
