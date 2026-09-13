// ============================================================
// CONFIGURACIÓN Y ESTADO GLOBAL
// ============================================================
const CONFIG = {
    ADMIN_USER: 'ADMIN',
    ADMIN_PASS: 'SantaMarta',
    LATE_LIMIT: 15,
    // Ventana, en minutos, previa a la hora de salida agendada
    // dentro de la cual "Salida" ya se considera a horario (para
    // no exigir que marque el segundo exacto en que termina su
    // horario laboral).
    EXIT_TOLERANCE_MINUTES: 15,
    MIN_ATTENDANCE: 80,
    DEFAULT_PASSWORD: '123456',
    // Distancia euclidiana máxima entre descriptores faciales para
    // considerar que son la misma persona. face-api.js/dlib recomienda
    // ~0.6 como límite superior razonable (99%+ en LFW); usamos un poco
    // menos estricto que 0.5 para tolerar variaciones de luz en vivo.
    FACE_MATCH_THRESHOLD: 0.55,
    MIN_CAPTURES: 3,
    // Cuántos frames en vivo se promedian al identificar a alguien,
    // para no depender de un único frame que puede salir borroso.
    IDENTIFY_SAMPLES: 3,
    IDENTIFY_SAMPLE_INTERVAL_MS: 250,
    FACE_MODELS_URL: 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights'
};

const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const FULL_DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const START_HOUR = 7;
const END_HOUR = 23;
const SCHEDULE_CALENDAR_YEAR = 2026;

let currentUser = null;
let currentCamera = null;
let capturedPhotos = [];       // dataURLs (solo para mostrar/almacenar la foto de perfil)
let capturedDescriptors = [];  // descriptores faciales (arrays de 128 floats)
let recognizedTeacher = null;
let horarioLaboralList = [];
let isFaceVerified = false;
let annualCalendarByDate = {}; // último cálculo de showAnnualCalendar(), usado por showDayDetail()
let modelsLoaded = false;
let exitWindowPollInterval = null;
let liveOverlayInterval = null;
let regLiveOverlayInterval = null;
let detectorOptions = null;
let chartPieInstance = null;
let chartBarInstance = null;
let chartLineInstance = null;

// ============================================================
// PERSISTENCIA (Supabase + respaldo local)
// Los datos viven en la tabla `app_data` de Supabase (una fila por
// colección, key/value jsonb) y se cachean en memoria en
// `dataStore` para que el resto de la app siga leyendo/escribiendo
// de forma síncrona como antes con localStorage. Además, cada
// colección se espeja en localStorage (prefijo "sb_cache_"): si
// Supabase no responde al cargar, la app arranca con esa copia
// local en vez de quedar vacía; y cada guardado escribe primero en
// localStorage (inmediato) y después intenta sincronizar con
// Supabase en segundo plano.
// ============================================================
const SUPABASE_URL = 'https://kclnaabvcxdovvgblyoc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Zp4yPHc5wue0xjDmo9r2-g_xFsLav8i';
const sb = (typeof supabase !== 'undefined')
    ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

const DATA_KEYS = ['teachers', 'attendance', 'alerts', 'licencias', 'criteria'];
const DATA_DEFAULTS = { teachers: [], attendance: [], alerts: [], licencias: [], criteria: {} };
let dataStore = { teachers: [], attendance: [], alerts: [], licencias: [], criteria: {} };
let dataLoaded = false;
let supabaseAvailable = false;

function readLocalCache(key) {
    try {
        const raw = localStorage.getItem('sb_cache_' + key);
        return raw !== null ? JSON.parse(raw) : DATA_DEFAULTS[key];
    } catch (e) {
        console.error('No se pudo leer la caché local de "' + key + '"', e);
        return DATA_DEFAULTS[key];
    }
}

function writeLocalCache(key, value) {
    try {
        localStorage.setItem('sb_cache_' + key, JSON.stringify(value));
    } catch (e) {
        console.error('No se pudo escribir la caché local de "' + key + '"', e);
    }
}

function describeSupabaseError(error) {
    if (!error) return 'Error desconocido';
    return [error.message, error.code, error.details, error.hint].filter(Boolean).join(' | ');
}

// ------------------------------------------------------------
// SINCRONIZACIÓN DIFERIDA
// Si un guardado a Supabase falla (sin conexión, CDN caído, etc.)
// la clave queda marcada como "pendiente" en localStorage. En
// cuanto el navegador avisa que hay conexión de nuevo (evento
// 'online'), o cada cierto tiempo mientras haya pendientes (por si
// ese evento no es confiable), se reintenta subir la versión más
// reciente de esa colección. Como dataStore ya tiene siempre el
// último valor guardado, si se guardó varias veces sin conexión se
// sube de una sola vez la versión final, no cada guardado intermedio.
// ------------------------------------------------------------
const PENDING_SYNC_KEY = 'sb_pending_sync';

function getPendingSyncKeys() {
    try {
        const raw = localStorage.getItem(PENDING_SYNC_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

function markPendingSync(key) {
    const pending = getPendingSyncKeys();
    if (!pending.includes(key)) {
        pending.push(key);
        localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(pending));
    }
}

function clearPendingSync(key) {
    const pending = getPendingSyncKeys().filter(k => k !== key);
    if (pending.length > 0) {
        localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(pending));
    } else {
        localStorage.removeItem(PENDING_SYNC_KEY);
    }
}

let isFlushingPendingSync = false;

async function flushPendingSync() {
    if (!sb || isFlushingPendingSync) return;
    const pending = getPendingSyncKeys();
    if (pending.length === 0) return;

    isFlushingPendingSync = true;
    let syncedCount = 0;
    for (const key of pending) {
        try {
            const { error } = await sb.from('app_data')
                .upsert({ key, value: dataStore[key], updated_at: new Date().toISOString() }, { onConflict: 'key' });
            if (error) throw error;
            clearPendingSync(key);
            syncedCount++;
        } catch (e) {
            console.error('Reintento de sincronización falló para "' + key + '":', e);
            // Se deja marcado como pendiente: se reintenta en el próximo 'online' o tick del intervalo.
        }
    }
    isFlushingPendingSync = false;

    if (syncedCount > 0) {
        supabaseAvailable = true;
        showToast('Conexión restablecida: se sincronizaron ' + syncedCount + ' cambio(s) guardado(s) sin conexión.', 'success');
    }
}

window.addEventListener('online', flushPendingSync);
window.addEventListener('offline', () => {
    showToast('Sin conexión a internet. Los cambios se guardarán en este dispositivo y se subirán solos al reconectar.', 'warning');
});
// Respaldo por si el evento 'online' no es confiable (p. ej. wifi
// conectado pero sin salida real a internet): reintenta cada 20s
// mientras queden claves pendientes.
setInterval(() => {
    if (getPendingSyncKeys().length > 0) flushPendingSync();
}, 20000);

async function loadAllData() {
    if (!sb) {
        console.error('El cliente de Supabase no se pudo inicializar (¿no cargó el script de supabase-js?)');
        showToast('No se pudo cargar Supabase (sin conexión al CDN). Usando datos guardados localmente.', 'error');
        DATA_KEYS.forEach(key => { dataStore[key] = readLocalCache(key); });
        dataLoaded = true;
        return;
    }
    try {
        const { data, error } = await sb.from('app_data').select('key,value').in('key', DATA_KEYS);
        if (error) throw error;
        const byKey = Object.fromEntries((data || []).map(row => [row.key, row.value]));
        DATA_KEYS.forEach(key => {
            const value = (byKey[key] !== undefined) ? byKey[key] : readLocalCache(key);
            dataStore[key] = value;
            writeLocalCache(key, value);
        });
        supabaseAvailable = true;
    } catch (error) {
        console.error('Error cargando desde Supabase:', error);
        showToast('No se pudo conectar con Supabase (' + describeSupabaseError(error) + '). Usando datos guardados localmente.', 'error');
        supabaseAvailable = false;
        DATA_KEYS.forEach(key => { dataStore[key] = readLocalCache(key); });
    }
    dataLoaded = true;
}

function persistToSupabase(key, value) {
    writeLocalCache(key, value);
    if (!sb) {
        markPendingSync(key);
        return;
    }
    sb.from('app_data')
        .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
        .then(({ error }) => {
            if (error) {
                console.error('Error guardando "' + key + '" en Supabase:', error);
                markPendingSync(key);
                showToast('Sin conexión con la base de datos (' + describeSupabaseError(error) + '). Se guardó localmente y se sincronizará solo al reconectar.', 'warning');
                supabaseAvailable = false;
            } else {
                clearPendingSync(key);
                supabaseAvailable = true;
            }
        });
}

function getTeachers() { return dataStore.teachers; }
function saveTeachers(teachers) { dataStore.teachers = teachers; persistToSupabase('teachers', teachers); }
function getAttendance() { return dataStore.attendance; }
function saveAttendance(attendance) { dataStore.attendance = attendance; persistToSupabase('attendance', attendance); }
function getAlerts() { return dataStore.alerts; }
function saveAlerts(alerts) { dataStore.alerts = alerts; persistToSupabase('alerts', alerts); }
function getLicencias() { return dataStore.licencias; }
function saveLicenciasToStorage(licencias) { dataStore.licencias = licencias; persistToSupabase('licencias', licencias); }
function getCriteria() {
    const criteria = dataStore.criteria || {};
    return {
        lateLimit: criteria.lateLimit || CONFIG.LATE_LIMIT,
        minAttendance: criteria.minAttendance || CONFIG.MIN_ATTENDANCE
    };
}
function saveCriteriaToStorage(criteria) { dataStore.criteria = criteria; persistToSupabase('criteria', criteria); }

// ============================================================
// RECONOCIMIENTO FACIAL REAL (face-api.js)
// Detecta el rostro (TinyFaceDetector), ubica sus puntos de
// referencia (landmarks) y calcula un descriptor de 128
// dimensiones que representa los rasgos faciales. Dos rostros
// se consideran la misma persona si la distancia euclidiana
// entre sus descriptores es menor al umbral configurado.
// ============================================================
async function loadFaceApiModels() {
    try {
        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(CONFIG.FACE_MODELS_URL),
            faceapi.nets.faceLandmark68Net.loadFromUri(CONFIG.FACE_MODELS_URL),
            faceapi.nets.faceRecognitionNet.loadFromUri(CONFIG.FACE_MODELS_URL)
        ]);
        detectorOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
        modelsLoaded = true;
        setModelsBanner('ok', '<i class="bi bi-check-circle"></i> Módulo de reconocimiento facial listo');
    } catch (error) {
        console.error(error);
        modelsLoaded = false;
        setModelsBanner('error', '<i class="bi bi-exclamation-triangle"></i> No se pudo cargar el reconocimiento facial. Verificá tu conexión a internet.');
    }
}

function setModelsBanner(state, html) {
    document.querySelectorAll('.models-banner').forEach(el => {
        el.className = 'models-banner' + (state ? ' ' + state : '');
        el.innerHTML = html;
    });
}

async function getDescriptorFromImageElement(imgEl) {
    if (!modelsLoaded) return null;
    const result = await faceapi.detectSingleFace(imgEl, detectorOptions).withFaceLandmarks().withFaceDescriptor();
    return result ? Array.from(result.descriptor) : null;
}

async function getDescriptorFromVideoElement(videoEl) {
    if (!modelsLoaded) return null;
    const result = await faceapi.detectSingleFace(videoEl, detectorOptions).withFaceLandmarks().withFaceDescriptor();
    return result ? Array.from(result.descriptor) : null;
}

function averageDescriptors(list) {
    const len = list[0].length;
    const avg = new Array(len).fill(0);
    list.forEach(d => { for (let i = 0; i < len; i++) avg[i] += d[i]; });
    for (let i = 0; i < len; i++) avg[i] /= list.length;
    return avg;
}

function euclideanDistance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum);
}

function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
    });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ============================================================
// NAVEGACIÓN
// ============================================================
function login() {
    if (!dataLoaded) {
        showToast('Todavía se están cargando los datos, esperá un momento e intentá de nuevo', 'warning');
        return;
    }
    const user = document.getElementById('loginUser').value.trim();
    const pass = document.getElementById('loginPass').value.trim();
    const errorEl = document.getElementById('loginError');
    if (user === CONFIG.ADMIN_USER && pass === CONFIG.ADMIN_PASS) {
        currentUser = { role: 'admin', username: 'ADMIN' };
        showDashboard();
        return;
    }
    const teachers = getTeachers();
    const teacher = teachers.find(t => t.dni === user && t.password === pass);
    if (teacher) {
        currentUser = { role: 'teacher', ...teacher };
        showDashboard();
        return;
    }
    errorEl.style.display = 'block';
    setTimeout(() => errorEl.style.display = 'none', 3000);
}

function logout() {
    currentUser = null;
    recognizedTeacher = null;
    isFaceVerified = false;
    stopLiveOverlay();
    stopRegLiveOverlay();
    stopExitWindowPoll();
    document.getElementById('dashboardScreen').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('loginUser').value = '';
    document.getElementById('loginPass').value = '';
    if (currentCamera) {
        currentCamera.getTracks().forEach(track => track.stop());
        currentCamera = null;
    }
    showToast('Sesión cerrada', 'info');
}

function resetChangePasswordForm() {
    document.getElementById('currentPasswordInput').value = '';
    document.getElementById('newPasswordInput').value = '';
    document.getElementById('confirmPasswordInput').value = '';
    document.getElementById('changePasswordError').style.display = 'none';
}

function changeTeacherPassword() {
    const errorEl = document.getElementById('changePasswordError');
    const current = document.getElementById('currentPasswordInput').value;
    const newPass = document.getElementById('newPasswordInput').value;
    const confirm = document.getElementById('confirmPasswordInput').value;

    if (current !== currentUser.password) {
        errorEl.textContent = 'La contraseña actual no es correcta.';
        errorEl.style.display = 'block';
        return;
    }
    if (!newPass || newPass.length < 4) {
        errorEl.textContent = 'La nueva contraseña debe tener al menos 4 caracteres.';
        errorEl.style.display = 'block';
        return;
    }
    if (newPass !== confirm) {
        errorEl.textContent = 'Las contraseñas nuevas no coinciden.';
        errorEl.style.display = 'block';
        return;
    }

    const teachers = getTeachers();
    const index = teachers.findIndex(t => t.dni === currentUser.dni);
    if (index === -1) {
        errorEl.textContent = 'No se pudo encontrar tu usuario.';
        errorEl.style.display = 'block';
        return;
    }
    teachers[index].password = newPass;
    saveTeachers(teachers);
    currentUser.password = newPass;

    const modal = bootstrap.Modal.getInstance(document.getElementById('changePasswordModal'));
    if (modal) modal.hide();
    resetChangePasswordForm();
    showToast('✅ Contraseña actualizada correctamente', 'success');
}

function showDashboard() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('dashboardScreen').classList.remove('hidden');
    document.getElementById('statsScreen').classList.add('hidden');
    if (currentUser.role === 'admin') {
        document.getElementById('adminDashboard').classList.remove('hidden');
        document.getElementById('teacherDashboard').classList.add('hidden');
        document.getElementById('dashboardTitle').textContent = 'Panel de Administración';
        document.getElementById('userRoleBadge').textContent = 'Admin';
        document.getElementById('userRoleBadge').className = 'badge bg-danger me-2';
        loadAdminDashboard();
        resetHorarioLaboralForm();
    } else {
        document.getElementById('adminDashboard').classList.add('hidden');
        document.getElementById('teacherDashboard').classList.remove('hidden');
        document.getElementById('dashboardTitle').textContent = `Bienvenido, ${currentUser.nombre} ${currentUser.apellido}`;
        document.getElementById('userRoleBadge').textContent = 'Docente';
        document.getElementById('userRoleBadge').className = 'badge bg-success me-2';
        loadTeacherDashboard();
    }
}

// ============================================================
// HORARIO LABORAL DEL DOCENTE (alta/edición: día + inicio + fin)
// Se guarda por docente como horario_laboral: [{dia, inicio, fin}].
// ============================================================
function resetHorarioLaboralForm() {
    horarioLaboralList = [];
    const dia = document.getElementById('horarioDiaInput');
    const inicio = document.getElementById('horarioInicioInput');
    const fin = document.getElementById('horarioFinInput');
    if (dia) dia.selectedIndex = 0;
    if (inicio) inicio.value = '';
    if (fin) fin.value = '';
    renderHorarioLaboralChips();
}

function agregarHorarioLaboral() {
    const dia = document.getElementById('horarioDiaInput').value;
    const inicio = document.getElementById('horarioInicioInput').value;
    const fin = document.getElementById('horarioFinInput').value;
    if (!inicio || !fin) { showToast('Completá la hora de inicio y de finalización', 'error'); return; }
    if (fin <= inicio) { showToast('La hora de finalización debe ser posterior a la de inicio', 'error'); return; }
    horarioLaboralList.push({ dia, inicio, fin });
    document.getElementById('horarioInicioInput').value = '';
    document.getElementById('horarioFinInput').value = '';
    renderHorarioLaboralChips();
}

function quitarHorarioLaboral(index) {
    horarioLaboralList.splice(index, 1);
    renderHorarioLaboralChips();
}

function renderHorarioLaboralChips() {
    const container = document.getElementById('horarioLaboralChips');
    if (!container) return;
    if (horarioLaboralList.length === 0) {
        container.innerHTML = '<span class="text-muted">No se ha agregado ningún horario</span>';
        return;
    }
    container.innerHTML = horarioLaboralList.map((h, i) => `
        <span class="horario-chip">
            ${h.dia} ${h.inicio}-${h.fin}
            <button type="button" class="horario-chip-remove" onclick="quitarHorarioLaboral(${i})" aria-label="Quitar horario">&times;</button>
        </span>
    `).join('');
}

// Devuelve el horario de un docente como [{dia, inicio, fin}]. Si el
// docente fue registrado con el formato viejo (schedule: bloques
// sueltos de 40 min, ej. {day:'Lunes', time:'07:00 - 07:40'}), lo
// convierte agrupando por día y fusionando bloques consecutivos en
// un único rango inicio-fin, para no perder los datos ya cargados.
function getHorarioLaboral(teacher) {
    if (Array.isArray(teacher.horario_laboral)) return teacher.horario_laboral;
    if (!Array.isArray(teacher.schedule) || teacher.schedule.length === 0) return [];
    const byDay = {};
    teacher.schedule.forEach(s => {
        const [inicio, fin] = s.time.split(' - ');
        if (!byDay[s.day]) byDay[s.day] = [];
        byDay[s.day].push({ inicio, fin: fin || inicio });
    });
    const result = [];
    Object.keys(byDay).forEach(dia => {
        const slots = byDay[dia].slice().sort((a, b) => a.inicio.localeCompare(b.inicio));
        let current = null;
        slots.forEach(slot => {
            if (current && slot.inicio === current.fin) {
                current.fin = slot.fin;
            } else {
                if (current) result.push({ dia, inicio: current.inicio, fin: current.fin });
                current = { inicio: slot.inicio, fin: slot.fin };
            }
        });
        if (current) result.push({ dia, inicio: current.inicio, fin: current.fin });
    });
    return result;
}

// ============================================================
// WHATSAPP (botón rápido para contactar a un docente)
// ============================================================

// Limpia un teléfono para armar el link de wa.me: saca espacios, guiones,
// puntos y paréntesis, y un 0 o 15 inicial (prefijos de larga distancia /
// celular argentino que no van en el formato internacional de WhatsApp).
function cleanPhone(telefono) {
    if (!telefono) return '';
    let limpio = String(telefono).replace(/[\s\-.()]/g, '');
    limpio = limpio.replace(/^0/, '');
    limpio = limpio.replace(/^15/, '');
    return limpio;
}

// Arma el link de wa.me con el código de país de Argentina (54) + 9. Si no
// hay teléfono cargado, devuelve null (no hay a quién escribirle).
function buildWhatsAppLink(telefono, mensaje) {
    const limpio = cleanPhone(telefono);
    if (!limpio) return null;
    return `https://wa.me/549${limpio}?text=${encodeURIComponent(mensaje || '')}`;
}

// Botoncito verde de WhatsApp para poner al lado de un nombre de docente,
// tanto en el listado como en el buzón de alertas. Si no tiene teléfono
// cargado, no se muestra nada (en vez de un botón roto).
function renderWhatsAppButton(telefono, nombre, mensaje) {
    const texto = mensaje || `Hola ${nombre}`;
    const link = buildWhatsAppLink(telefono, texto);
    if (!link) return '';
    return `<a href="${link}" target="_blank" class="btn btn-sm btn-whatsapp" title="Enviar WhatsApp a ${nombre}"><i class="bi bi-whatsapp"></i></a>`;
}

// ============================================================
// ADMIN - REGISTRO DE DOCENTES (captura + validación facial)
// ============================================================
function startCamera() {
    const video = document.getElementById('regVideo');
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        if (currentCamera) currentCamera.getTracks().forEach(track => track.stop());
        navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } } })
            .then(stream => {
                video.srcObject = stream;
                currentCamera = stream;
                video.play();
                video.onloadeddata = () => startRegLiveOverlay();
            })
            .catch(err => showToast('No se pudo acceder a la cámara: ' + err.message, 'error'));
    }
}

// Recuadro en vivo sobre el rostro detectado durante el registro,
// para que quien capture la foto pueda encuadrar bien antes de
// hacer clic en "Capturar" (antes la cámara estaba oculta).
async function runRegLiveOverlay() {
    if (!modelsLoaded) return;
    const video = document.getElementById('regVideo');
    const overlay = document.getElementById('regOverlay');
    if (!video || !overlay || !video.videoWidth) return;
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    const ctx = overlay.getContext('2d');
    try {
        const result = await faceapi.detectSingleFace(video, detectorOptions);
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        if (result) {
            ctx.strokeStyle = '#7c8f57';
            ctx.lineWidth = 3;
            ctx.strokeRect(result.box.x, result.box.y, result.box.width, result.box.height);
        }
    } catch (e) { /* silencioso, se reintenta en el próximo intervalo */ }
}

function startRegLiveOverlay() {
    stopRegLiveOverlay();
    if (!modelsLoaded) return;
    regLiveOverlayInterval = setInterval(runRegLiveOverlay, 500);
}

function stopRegLiveOverlay() {
    if (regLiveOverlayInterval) { clearInterval(regLiveOverlayInterval); regLiveOverlayInterval = null; }
    const overlay = document.getElementById('regOverlay');
    if (overlay) { const ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, overlay.width, overlay.height); }
}

function updateCaptureStatusUI() {
    const el = document.getElementById('captureStatus');
    const count = capturedDescriptors.length;
    el.textContent = `Fotos válidas: ${count}/${CONFIG.MIN_CAPTURES}`;
    el.classList.toggle('ready', count >= CONFIG.MIN_CAPTURES);
}

function renderCaptureThumbs() {
    const el = document.getElementById('captureThumbs');
    el.innerHTML = capturedPhotos.map(src => `<img src="${src}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;border:2px solid var(--olive-600);">`).join('');
}

async function capturePhoto() {
    const video = document.getElementById('regVideo');
    const canvas = document.getElementById('regCanvas');
    if (!video.srcObject) { showToast('Primero inicia la cámara', 'warning'); return; }
    if (!modelsLoaded) { showToast('El módulo de reconocimiento facial todavía está cargando, esperá unos segundos', 'warning'); return; }

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg');

    showToast('Analizando rostro...', 'info');
    try {
        const img = await loadImageFromDataUrl(dataUrl);
        const descriptor = await getDescriptorFromImageElement(img);
        if (!descriptor) {
            showToast('No se detectó un rostro claro en la foto. Probá con mejor iluminación y de frente a la cámara.', 'error');
            return;
        }
        capturedPhotos.push(dataUrl);
        capturedDescriptors.push(descriptor);
        renderCaptureThumbs();
        updateCaptureStatusUI();
        showToast(`✅ Foto ${capturedDescriptors.length} válida`, 'success');
    } catch (error) {
        console.error(error);
        showToast('Ocurrió un error al analizar la foto', 'error');
    }
}

function clearRegistrationForm() {
    document.getElementById('regApellido').value = '';
    document.getElementById('regNombre').value = '';
    document.getElementById('regDni').value = '';
    document.getElementById('regTelefono').value = '';
    document.getElementById('regTelefonoFamiliar').value = '';
    document.getElementById('regDireccion').value = '';
    document.getElementById('regPassword').value = CONFIG.DEFAULT_PASSWORD;
    resetHorarioLaboralForm();
    capturedPhotos = [];
    capturedDescriptors = [];
    renderCaptureThumbs();
    updateCaptureStatusUI();
    showToast('Formulario limpiado', 'info');
}

function saveTeacher() {
    const apellido = document.getElementById('regApellido').value.trim();
    const nombre = document.getElementById('regNombre').value.trim();
    const dni = document.getElementById('regDni').value.trim();
    const telefono = document.getElementById('regTelefono').value.trim();
    const telefonoFamiliar = document.getElementById('regTelefonoFamiliar').value.trim();
    const direccion = document.getElementById('regDireccion').value.trim();
    const password = document.getElementById('regPassword').value.trim() || CONFIG.DEFAULT_PASSWORD;

    if (!apellido) { showToast('El apellido es obligatorio', 'error'); return; }
    if (!nombre) { showToast('El nombre es obligatorio', 'error'); return; }
    if (!dni) { showToast('El DNI es obligatorio', 'error'); return; }
    // Teléfono obligatorio: solo números, mínimo 10 dígitos (se usa para
    // armar el link de WhatsApp, por eso no se acepta cualquier formato).
    if (!telefono) { showToast('El teléfono es obligatorio', 'error'); return; }
    if (!/^\d{10,}$/.test(telefono)) { showToast('El teléfono debe tener solo números, mínimo 10 dígitos', 'error'); return; }
    if (capturedDescriptors.length < CONFIG.MIN_CAPTURES) {
        showToast(`Necesitás ${CONFIG.MIN_CAPTURES} fotos válidas para el registro facial (llevás ${capturedDescriptors.length})`, 'error');
        return;
    }
    if (horarioLaboralList.length === 0) { showToast('Agregá al menos un horario', 'error'); return; }

    const teachers = getTeachers();
    if (teachers.some(t => t.dni === dni)) { showToast('Ya existe un docente con el DNI ' + dni, 'error'); return; }

    const newTeacher = {
        id: Date.now().toString(),
        apellido, nombre, dni, telefono, telefonoFamiliar, direccion,
        materia: '', horario_laboral: horarioLaboralList,
        photo: capturedPhotos[0],
        faceDescriptor: averageDescriptors(capturedDescriptors),
        password, createdAt: new Date().toISOString(), active: true
    };

    teachers.push(newTeacher);
    saveTeachers(teachers);
    showToast(`✅ Docente registrado. Usuario: ${dni}, Contraseña: ${password}`, 'success');
    clearRegistrationForm();
    loadTeachersTable();
    updateStats();
    loadReportTeachers();
    populateTeacherSelect();
}

// ============================================================
// ADMIN - DASHBOARD
// ============================================================
function loadAdminDashboard() {
    checkFaltas();
    loadTeachersTable();
    loadAlerts();
    updateStats();
    loadReportTeachers();
    loadCriteria();
    startCamera();
    updateAlertCount();
    populateTeacherSelect();
    loadLicenciasList();
    loadEventosEspeciales();
}

function loadTeachersTable() {
    const teachers = getTeachers();
    const tbody = document.getElementById('teachersTableBody');
    const today = new Date().toDateString();
    document.getElementById('teacherCountBadge').textContent = teachers.length;
    if (teachers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="text-center">No hay docentes registrados</td></tr>';
        return;
    }
    tbody.innerHTML = teachers.map(teacher => {
        const attendance = getAttendance().filter(a => a.teacherId === teacher.id && new Date(a.date).toDateString() === today);
        const status = attendance.length > 0 ? `<span class="badge bg-success">Presente (${attendance.length})</span>` : `<span class="badge bg-danger">Ausente</span>`;
        const horarioTeacher = getHorarioLaboral(teacher);
        const scheduleDisplay = horarioTeacher.length > 0 ?
            horarioTeacher.slice(0, 3).map(h => `${h.dia} ${h.inicio}-${h.fin}`).join(', ') + (horarioTeacher.length > 3 ? '...' : '') : 'Sin horario';
        const bioBadge = teacher.faceDescriptor ? '<span class="badge bg-success">Registrada</span>' : '<span class="badge bg-warning text-dark">Sin datos</span>';
        const searchText = `${teacher.apellido} ${teacher.nombre} ${teacher.dni} ${teacher.materia || ''}`.toLowerCase();
        return `
            <tr data-search="${searchText}">
                <td><img src="${teacher.photo}" alt="Foto" style="width:50px;height:50px;border-radius:50%;object-fit:cover;"></td>
                <td><strong>${teacher.dni}</strong></td>
                <td>${teacher.apellido} ${teacher.nombre} ${renderWhatsAppButton(teacher.telefono, teacher.nombre)}</td>
                <td>${teacher.telefono || '-'}</td>
                <td>${teacher.materia}</td>
                <td><small>${scheduleDisplay}</small></td>
                <td><span class="badge bg-info">${teacher.password}</span></td>
                <td>${bioBadge}</td>
                <td>${status}</td>
                <td>
                    <button class="btn btn-sm btn-primary" title="Ficha / Reporte individual" onclick="showTeacherDetail('${teacher.id}')"><i class="bi bi-search"></i></button>
                    <button class="btn btn-sm btn-info" title="Calendario ${SCHEDULE_CALENDAR_YEAR}" onclick="showTeacherCalendar('${teacher.id}')"><i class="bi bi-calendar3"></i></button>
                    <button class="btn btn-sm btn-outline-secondary" title="Ver histórico de alertas" onclick="verHistoricoDocente('${teacher.id}')"><i class="bi bi-clock-history"></i></button>
                    <button class="btn btn-sm btn-secondary" title="Restablecer contraseña" onclick="resetTeacherPassword('${teacher.id}')"><i class="bi bi-key"></i></button>
                    <button class="btn btn-sm btn-danger" onclick="deleteTeacher('${teacher.id}')"><i class="bi bi-trash"></i></button>
                </td>
            </tr>
        `;
    }).join('');
    filterTeachersTable();
}

// Filtra en vivo las filas de la tabla de docentes (no vuelve a
// pedir datos, solo oculta/muestra filas ya renderizadas) según lo
// que el administrador va tipeando en el buscador.
function filterTeachersTable() {
    const input = document.getElementById('teacherSearchInput');
    if (!input) return;
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll('#teachersTableBody tr[data-search]').forEach(tr => {
        tr.style.display = (!q || tr.dataset.search.includes(q)) ? '' : 'none';
    });
}

function updateStats() {
    const teachers = getTeachers();
    const attendance = getAttendance();
    const today = new Date().toDateString();
    document.getElementById('totalTeachers').textContent = teachers.length;
    const todayAttendance = attendance.filter(a => new Date(a.date).toDateString() === today);
    const presentTeachers = new Set(todayAttendance.map(a => a.teacherId));
    document.getElementById('presentToday').textContent = presentTeachers.size;
    document.getElementById('absentToday').textContent = teachers.filter(t => !presentTeachers.has(t.id)).length;
    document.getElementById('lateToday').textContent = todayAttendance.filter(a => a.status === 'late').length;
}

// Tipos de alerta que genera automáticamente Supabase (tabla `alerta`,
// función/consulta del lado del servidor) cuando un docente llega tarde,
// se retira antes o falta a un Evento Especial. Viven en una tabla
// separada de app_data.alerts, así que hay que traerlas aparte y
// combinarlas para el buzón.
const EVENTO_ALERT_TYPES = ['TARDANZA_EVENTO', 'SALIDA_ANTES_EVENTO', 'AUSENTE_EVENTO'];
const EVENTO_ALERT_LABELS = {
    TARDANZA_EVENTO: 'Tardanza en Evento',
    SALIDA_ANTES_EVENTO: 'Salida Antes en Evento',
    AUSENTE_EVENTO: 'Ausente en Evento',
};
const EVENTO_ALERT_BADGE_CLASS = {
    TARDANZA_EVENTO: 'badge-evento-tardanza',
    SALIDA_ANTES_EVENTO: 'badge-evento-salida',
    AUSENTE_EVENTO: 'badge-evento-ausente',
};

// Busca en app_data.teachers el docente cuyo id (convertido a número)
// coincide con un id_docente de las tablas relacionales (docente,
// evento_docente, alerta). Se usa en vez de otra consulta a Supabase
// porque `docente` es un espejo de app_data.teachers con el mismo id.
function getTeacherByNumericId(idDocente) {
    return getTeachers().find(t => Number(t.id) === Number(idDocente));
}

// Trae las alertas de Eventos Especiales ya generadas del lado de
// Supabase (tabla `alerta`). No selecciona fecha_creacion porque no está
// confirmado que exista esa columna en todos los entornos; si la consulta
// falla, se degrada a "sin alertas de evento" en vez de romper el buzón.
async function fetchEventoAlerts() {
    if (!sb) return [];
    try {
        const { data, error } = await sb
            .from('alerta')
            .select('id_alerta,tipo_alerta,descripcion,id_docente,id_asistencia')
            .in('tipo_alerta', EVENTO_ALERT_TYPES);
        if (error) throw error;
        return data || [];
    } catch (error) {
        console.error('No se pudieron cargar las alertas de eventos especiales:', error);
        return [];
    }
}

// Como loadAlerts() y updateAlertCount() son async (esperan a Supabase
// para traer las alertas de eventos), dos llamadas disparadas casi juntas
// (p. ej. login() -> loadAdminDashboard() y, un instante después,
// createAlert()) pueden resolver en un orden distinto al que arrancaron.
// Sin este control, la llamada más vieja podía terminar después y pisar
// el buzón con un estado desactualizado. Con el token, solo la llamada
// más reciente tiene permiso de escribir en el DOM.
let alertsRenderToken = 0;
let alertCountToken = 0;

async function loadAlerts() {
    const myToken = ++alertsRenderToken;
    const filter = document.getElementById('alertTypeFilter')?.value || '';

    // Más reciente arriba, más antigua abajo (solo aplica a las alertas
    // locales: las de evento no tienen fecha confiable, así que van
    // siempre arriba de todo). El buzón por defecto solo muestra las
    // "visibles": borrar una alerta local no la elimina de verdad, solo le
    // pone visible=false (ver dismissAlert), para que quede en el histórico.
    const localAlerts = getAlerts().filter(a => a.visible !== false).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const eventoAlertsRaw = await fetchEventoAlerts();
    if (myToken !== alertsRenderToken) return; // llegó una llamada más nueva mientras esperábamos: descartamos esta
    const eventoAlerts = eventoAlertsRaw.map(a => {
        const teacher = getTeacherByNumericId(a.id_docente);
        return {
            id: `evt_${a.id_alerta}`,
            teacherName: teacher ? `${teacher.apellido} ${teacher.nombre}` : `Docente #${a.id_docente}`,
            teacherPhone: teacher ? teacher.telefono : null,
            type: a.tipo_alerta,
            message: a.descripcion,
            isEvento: true,
        };
    });

    let alerts = eventoAlerts.concat(localAlerts.map(a => ({ ...a, isEvento: false })));
    if (filter === 'evento') alerts = alerts.filter(a => a.isEvento);

    const container = document.getElementById('alertsList');
    if (alerts.length === 0) { container.innerHTML = '<p class="text-muted">No hay alertas pendientes</p>'; updateAlertCount(); return; }
    container.innerHTML = alerts.map((alert) => {
        if (alert.isEvento) {
            const badgeClass = EVENTO_ALERT_BADGE_CLASS[alert.type] || 'badge-evento-tardanza';
            const label = EVENTO_ALERT_LABELS[alert.type] || alert.type;
            return `
                <div class="alert-card">
                    <div class="d-flex justify-content-between align-items-center">
                        <div>
                            <strong>${alert.teacherName}</strong> ${renderWhatsAppButton(alert.teacherPhone, alert.teacherName)}
                            <span class="badge ${badgeClass}"><i class="bi bi-exclamation-triangle-fill"></i> ${label}</span>
                        </div>
                    </div>
                    <p class="mt-2">${alert.message || ''}</p>
                </div>`;
        }

        const isJustified = alert.justified || false;
        const isEarlyExit = alert.type === 'Salida Anticipada';
        const isDenied = isJustified && alert.justification === 'injustificada';

        let badgeClass, badgeText;
        if (isEarlyExit) {
            if (!isJustified) { badgeClass = 'badge-unjustified'; badgeText = 'Pendiente'; }
            else if (isDenied) { badgeClass = 'badge-unjustified'; badgeText = 'Injustificada'; }
            else { badgeClass = 'badge-justified'; badgeText = 'Justificada'; }
        } else {
            badgeClass = isJustified ? 'badge-justified' : 'badge-unjustified';
            badgeText = isJustified ? 'Justificado' : 'Injustificado';
        }

        let justificationOptions = '';
        if (!isJustified) {
            justificationOptions = isEarlyExit ? `
                <div class="mt-2">
                    <button class="btn btn-sm btn-success" onclick="justifyAlert('${alert.id}', 'justificada')"><i class="bi bi-check-circle"></i> Justificada</button>
                    <button class="btn btn-sm btn-danger" onclick="justifyAlert('${alert.id}', 'injustificada')"><i class="bi bi-x-circle"></i> Injustificada</button>
                </div>` : `
                <div class="mt-2">
                    <button class="btn btn-sm btn-success" onclick="justifyAlert('${alert.id}', 'enfermedad')"><i class="bi bi-heart"></i> Enfermedad</button>
                    <button class="btn btn-sm btn-primary" onclick="justifyAlert('${alert.id}', 'personal')"><i class="bi bi-person"></i> Personal</button>
                    <button class="btn btn-sm btn-secondary" onclick="justifyAlert('${alert.id}', 'otro')"><i class="bi bi-three-dots"></i> Otro</button>
                </div>`;
        }

        const resolutionLabel = alert.justification === 'justificada' ? 'Justificada'
            : alert.justification === 'injustificada' ? 'Injustificada'
            : alert.justification;

        // Para las ausencias (tipo "Falta") el mensaje de WhatsApp es el
        // aviso institucional pedido, no el saludo genérico por defecto.
        const teacherForWa = getTeachers().find(t => t.id === alert.teacherId);
        const waMensaje = alert.type === 'Falta'
            ? 'Se registró una ausencia en el sistema, comuníquese con la institución.'
            : undefined;

        return `
            <div class="alert-card ${isJustified && !isDenied ? 'justified' : ''}">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <strong>${alert.teacherName}</strong> ${renderWhatsAppButton(teacherForWa ? teacherForWa.telefono : null, alert.teacherName, waMensaje)}
                        <span class="badge ${badgeClass}">${badgeText}</span>
                        <span class="text-muted ms-2">${alert.type}</span>
                    </div>
                    <div>
                        <span class="text-muted">${new Date(alert.date).toLocaleString()}</span>
                        <button class="btn btn-sm btn-link text-danger" title="Eliminar alerta" onclick="dismissAlert('${alert.id}')"><i class="bi bi-x-circle"></i></button>
                    </div>
                </div>
                <p class="mt-2">${alert.message}</p>
                ${justificationOptions}
                ${alert.justification ? `<small class="text-muted">${isEarlyExit ? 'Resolución' : 'Justificación'}: ${resolutionLabel}</small>` : ''}
            </div>`;
    }).join('');
    updateAlertCount();
}

async function updateAlertCount() {
    const myToken = ++alertCountToken;
    const localUnjustified = getAlerts().filter(a => !a.justified).length;
    const eventoAlerts = await fetchEventoAlerts();
    if (myToken !== alertCountToken) return; // llegó una llamada más nueva mientras esperábamos: descartamos esta
    const el = document.getElementById('alertCount');
    if (el) el.textContent = localUnjustified + eventoAlerts.length;
}

function justifyAlert(id, reason) {
    const alerts = getAlerts();
    const alert = alerts.find(a => a.id === id);
    if (alert) {
        alert.justified = true;
        alert.justification = reason;
        saveAlerts(alerts);
        loadAlerts();
        const msg = alert.type === 'Salida Anticipada'
            ? (reason === 'justificada' ? '✅ Salida anticipada justificada' : '❌ Salida anticipada marcada como injustificada')
            : 'Ausencia justificada como: ' + reason;
        showToast(msg, reason === 'injustificada' ? 'warning' : 'success');
    }
}

// "Borrar" una alerta del buzón no la elimina de verdad: le pone
// visible=false para que deje de mostrarse en el buzón activo pero siga
// disponible en el histórico (ver verHistoricoInstitucional/Docente).
function dismissAlert(id) {
    if (!confirm('¿Quitar esta alerta del buzón? Va a seguir disponible en el histórico.')) return;
    const alerts = getAlerts();
    const alert = alerts.find(a => a.id === id);
    if (alert) alert.visible = false;
    saveAlerts(alerts);
    loadAlerts();
    showToast('Alerta movida al histórico', 'info');
}

// ============================================================
// HISTÓRICO DE ALERTAS (institucional y por docente)
// Solo cubre las alertas locales (app_data.alerts: Falta, Tardanza,
// Salida Anticipada, etc.), que son las que soportan el soft-delete de
// arriba. Las alertas de Eventos Especiales (tabla `alerta`) no tienen
// columna de estado, así que no participan del histórico ni del borrado.
// ============================================================

// Arma una fila de tarjeta para el modal de histórico, reutilizando el
// mismo formato visual que el buzón pero sin botones de acción (es de
// solo lectura).
function renderHistoricoCard(alert) {
    const badgeClass = alert.justified ? 'badge-justified' : 'badge-unjustified';
    const badgeText = alert.justified ? 'Justificado' : 'Injustificado';
    const visibilidad = alert.visible === false ? '<span class="badge bg-secondary">Archivada</span>' : '<span class="badge bg-info">Activa</span>';
    return `
        <div class="alert-card">
            <div class="d-flex justify-content-between align-items-center">
                <div>
                    <strong>${alert.teacherName}</strong>
                    <span class="badge ${badgeClass}">${badgeText}</span>
                    <span class="text-muted ms-2">${alert.type}</span>
                    ${visibilidad}
                </div>
                <span class="text-muted">${new Date(alert.date).toLocaleString()}</span>
            </div>
            <p class="mt-2">${alert.message}</p>
        </div>`;
}

function showHistoricoModal(titulo, alerts) {
    document.getElementById('historicoModalTitle').innerHTML = `<i class="bi bi-clock-history"></i> ${titulo}`;
    document.getElementById('historicoModalBody').innerHTML = alerts.length > 0
        ? alerts.map(renderHistoricoCard).join('')
        : '<p class="text-muted">No hay alertas registradas.</p>';
    new bootstrap.Modal(document.getElementById('historicoModal')).show();
}

// Todas las alertas locales (visibles y archivadas) de todos los
// docentes, más recientes primero.
function verHistoricoInstitucional() {
    const alerts = getAlerts().slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    showHistoricoModal('Histórico Institucional de Alertas', alerts);
}

// Todas las alertas locales (visibles y archivadas) de un docente puntual.
function verHistoricoDocente(teacherId) {
    const teacher = getTeachers().find(t => t.id === teacherId);
    const alerts = getAlerts().filter(a => a.teacherId === teacherId).sort((a, b) => new Date(b.date) - new Date(a.date));
    const nombre = teacher ? `${teacher.apellido} ${teacher.nombre}` : 'Docente';
    showHistoricoModal(`Histórico de ${nombre}`, alerts);
}

function loadCriteria() {
    const criteria = getCriteria();
    document.getElementById('lateLimit').value = criteria.lateLimit;
    document.getElementById('minAttendance').value = criteria.minAttendance;
}

function saveCriteria() {
    const criteria = {
        lateLimit: parseInt(document.getElementById('lateLimit').value) || 15,
        minAttendance: parseInt(document.getElementById('minAttendance').value) || 80
    };
    saveCriteriaToStorage(criteria);
    showToast('Criterios guardados', 'success');
}

function loadReportTeachers() {
    const teachers = getTeachers();
    const select = document.getElementById('reportTeacher');
    select.innerHTML = '<option value="all">Todos</option>' + teachers.map(t => `<option value="${t.id}">${t.apellido} ${t.nombre} (${t.dni})</option>`).join('');
}

function generateReport() {
    const from = document.getElementById('reportFrom').value;
    const to = document.getElementById('reportTo').value;
    const teacherId = document.getElementById('reportTeacher').value;
    if (!from || !to) { showToast('Selecciona un período', 'warning'); return; }
    const attendance = getAttendance();
    const teachers = getTeachers();
    let filtered = attendance.filter(a => a.date >= from && a.date <= to);
    if (teacherId !== 'all') filtered = filtered.filter(a => a.teacherId === teacherId);
    if (filtered.length === 0) { showToast('No hay registros', 'warning'); return; }
    const teacherMap = {};
    teachers.forEach(t => teacherMap[t.id] = t);
    let report = `=== REPORTE DE ASISTENCIA ===\nPeríodo: ${from} al ${to}\n================================\n\n`;
    const grouped = {};
    filtered.forEach(a => { if (!grouped[a.teacherId]) grouped[a.teacherId] = []; grouped[a.teacherId].push(a); });
    for (const [id, records] of Object.entries(grouped)) {
        const teacher = teacherMap[id];
        if (!teacher) continue;
        report += `Docente: ${teacher.apellido} ${teacher.nombre}\nDNI: ${teacher.dni}\nMateria: ${teacher.materia}\nTotal: ${records.length}\nDetalle:\n`;
        records.forEach(r => {
            const typeMap = { 'entry': 'ENTRADA', 'exit': 'SALIDA', 'early_exit': 'SALIDA ANTES DE TIEMPO' };
            report += `  - ${r.date} ${r.time} | ${typeMap[r.type] || r.type} | ${r.status}\n`;
        });
        report += '\n';
    }
    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `reporte_${from}_${to}.txt`;
    link.click();
    showToast('Reporte generado', 'success');
}

function deleteTeacher(id) {
    if (!confirm('¿Eliminar este docente?')) return;
    const teachers = getTeachers();
    saveTeachers(teachers.filter(t => t.id !== id));
    loadTeachersTable();
    updateStats();
    loadReportTeachers();
    populateTeacherSelect();
    showToast('Docente eliminado', 'info');
}

function resetTeacherPassword(id) {
    const teachers = getTeachers();
    const teacher = teachers.find(t => t.id === id);
    if (!teacher) return;
    const input = prompt(`Nueva contraseña para ${teacher.apellido} ${teacher.nombre}\n(dejar vacío para restablecer a la contraseña por defecto: ${CONFIG.DEFAULT_PASSWORD})`);
    if (input === null) return;
    const newPass = input.trim() || CONFIG.DEFAULT_PASSWORD;
    teacher.password = newPass;
    saveTeachers(teachers);
    loadTeachersTable();
    showToast(`✅ Contraseña de ${teacher.apellido} ${teacher.nombre} restablecida a: ${newPass}`, 'success');
}

function populateTeacherSelect() {
    const teachers = getTeachers();
    const select = document.getElementById('licenciaTeacher');
    if (select) {
        const currentValue = select.value;
        select.innerHTML = '<option value="">Seleccionar...</option>';
        teachers.forEach(t => {
            const option = document.createElement('option');
            option.value = t.id;
            option.textContent = t.materia ? `${t.apellido} ${t.nombre} - ${t.materia}` : `${t.apellido} ${t.nombre}`;
            select.appendChild(option);
        });
        if (currentValue) select.value = currentValue;
    }
}

// ============================================================
// TEACHER DASHBOARD — identificación facial real
// ============================================================
function loadTeacherDashboard() {
    startTeacherCamera();
    updateTeacherInfo();
    isFaceVerified = false;
    recognizedTeacher = null;
    const status = document.getElementById('faceRecognitionStatus');
    status.className = 'face-recognition-status waiting';
    status.innerHTML = '<i class="bi bi-info-circle"></i> Esperando identificación...';
    document.getElementById('recognitionProgress').style.display = 'none';
    updateAttendanceButtonsState();
    startExitWindowPoll();
}

// ¿El docente ya registró su entrada hoy? Se usa para la regla de
// "entrada única diaria": hasta que no marque entrada, Salida y Retirada
// quedan deshabilitados (no tiene sentido salir de algo a lo que no
// entró), y una vez que entró, no puede volver a marcar otra entrada.
function hasEntryToday(teacherId) {
    const todayStr = new Date().toISOString().split('T')[0];
    return getAttendance().some(a => a.teacherId === teacherId && a.type === 'entry' && a.date === todayStr);
}

// Habilita/deshabilita los botones de Entrada/Salida/Retirada según
// si hay una identificación facial vigente, si ya registró la entrada de
// hoy, y además decide cuál de los dos botones de salida corresponde
// mostrar: "Salida" normal solo dentro de la ventana de horario de salida
// (con tolerancia), "Retirada antes de tiempo" en cualquier otro momento.
// Se requiere identificarse de nuevo antes de CADA registro (por
// seguridad, para que nadie marque por otra persona), así que los
// botones quedan visualmente apagados en vez de fallar en silencio con
// solo un toast.
function updateAttendanceButtonsState() {
    const yaEntroHoy = currentUser && currentUser.role === 'teacher' ? hasEntryToday(currentUser.id) : false;

    const btnEntrada = document.getElementById('btnEntrada');
    if (btnEntrada) btnEntrada.disabled = !isFaceVerified || yaEntroHoy;

    const btnSalida = document.getElementById('btnSalida');
    const btnRetirada = document.getElementById('btnRetirada');
    const exitInfo = currentUser && currentUser.role === 'teacher' ? getExitWindowInfo(currentUser) : { isExitTime: false };
    if (btnSalida) {
        btnSalida.classList.toggle('hidden', !exitInfo.isExitTime);
        btnSalida.disabled = !isFaceVerified || !yaEntroHoy;
    }
    if (btnRetirada) {
        btnRetirada.classList.toggle('hidden', exitInfo.isExitTime);
        btnRetirada.disabled = !isFaceVerified || !yaEntroHoy;
    }

    const hint = document.getElementById('attendanceButtonsHint');
    if (hint) hint.classList.toggle('hidden', isFaceVerified);
}

// Reevalúa cuál botón de salida corresponde cada cierto tiempo,
// aunque el docente no haya vuelto a identificarse, para que el
// cambio de "Retirada antes de tiempo" a "Salida" (o viceversa) se
// refleje solo al cruzar el horario, sin depender de una acción del
// usuario.
function startExitWindowPoll() {
    stopExitWindowPoll();
    exitWindowPollInterval = setInterval(updateAttendanceButtonsState, 30000);
}

function stopExitWindowPoll() {
    if (exitWindowPollInterval) { clearInterval(exitWindowPollInterval); exitWindowPollInterval = null; }
}

function startTeacherCamera() {
    const video = document.getElementById('teacherVideo');
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        if (currentCamera) currentCamera.getTracks().forEach(track => track.stop());
        navigator.mediaDevices.getUserMedia({ video: true })
            .then(stream => {
                video.srcObject = stream;
                currentCamera = stream;
                video.play();
                video.onloadeddata = () => startLiveOverlay();
            })
            .catch(err => showToast('No se pudo acceder a la cámara: ' + err.message, 'error'));
    }
}

// Dibuja un recuadro sobre el rostro detectado en vivo, como
// referencia visual para el docente (no reemplaza la verificación
// que se hace al presionar "Identificarme").
async function runLiveOverlay() {
    if (!modelsLoaded) return;
    const video = document.getElementById('teacherVideo');
    const overlay = document.getElementById('teacherOverlay');
    if (!video || !video.videoWidth) return;
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
    const ctx = overlay.getContext('2d');
    try {
        const result = await faceapi.detectSingleFace(video, detectorOptions);
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        if (result) {
            ctx.strokeStyle = '#7c8f57';
            ctx.lineWidth = 3;
            ctx.strokeRect(result.box.x, result.box.y, result.box.width, result.box.height);
        }
    } catch (e) { /* silencioso, se reintenta en el próximo intervalo */ }
}

function startLiveOverlay() {
    stopLiveOverlay();
    if (!modelsLoaded) return;
    liveOverlayInterval = setInterval(runLiveOverlay, 500);
}

function stopLiveOverlay() {
    if (liveOverlayInterval) { clearInterval(liveOverlayInterval); liveOverlayInterval = null; }
    const overlay = document.getElementById('teacherOverlay');
    if (overlay) { const ctx = overlay.getContext('2d'); ctx.clearRect(0, 0, overlay.width, overlay.height); }
}

function updateTeacherInfo() {
    if (currentUser) {
        document.getElementById('teacherDni').textContent = currentUser.dni;
        document.getElementById('teacherName').textContent = `${currentUser.apellido} ${currentUser.nombre}`;
        document.getElementById('teacherSubject').textContent = currentUser.materia || '-';
        document.getElementById('teacherPhone').textContent = currentUser.telefono || '-';
        document.getElementById('teacherAddress').textContent = currentUser.direccion || '-';
        const horarioUsuario = getHorarioLaboral(currentUser);
        const scheduleDisplay = horarioUsuario.length > 0 ?
            horarioUsuario.slice(0, 5).map(h => `${h.dia} ${h.inicio}-${h.fin}`).join(', ') + (horarioUsuario.length > 5 ? '...' : '') : 'Sin horario';
        document.getElementById('teacherSchedule').textContent = scheduleDisplay;
        document.getElementById('teacherPhoto').src = currentUser.photo;
    }
}

async function detectFace() {
    const video = document.getElementById('teacherVideo');
    const status = document.getElementById('faceRecognitionStatus');
    const progress = document.getElementById('recognitionProgress');
    const progressBar = progress.querySelector('.progress-bar');

    if (!video.srcObject) { showToast('La cámara no está disponible', 'error'); return; }
    if (!modelsLoaded) { showToast('El módulo de reconocimiento facial todavía está cargando, esperá unos segundos', 'warning'); return; }
    if (!currentUser.faceDescriptor) {
        status.className = 'face-recognition-status error';
        status.innerHTML = '<i class="bi bi-exclamation-triangle"></i> Este docente no tiene datos biométricos registrados. Contactá al administrador.';
        return;
    }

    status.className = 'face-recognition-status processing';
    status.innerHTML = '<i class="bi bi-hourglass-split"></i> Verificando identidad...';
    progress.style.display = 'block';
    progressBar.style.width = '15%';

    try {
        // Se toman varias muestras en vivo y se promedian los
        // descriptores: un único frame puede salir borroso o con
        // mal ángulo y rechazar a la persona correcta.
        const samples = [];
        for (let i = 0; i < CONFIG.IDENTIFY_SAMPLES; i++) {
            const d = await getDescriptorFromVideoElement(video);
            if (d) samples.push(d);
            progressBar.style.width = `${15 + Math.round(((i + 1) / CONFIG.IDENTIFY_SAMPLES) * 70)}%`;
            if (i < CONFIG.IDENTIFY_SAMPLES - 1) await sleep(CONFIG.IDENTIFY_SAMPLE_INTERVAL_MS);
        }
        progressBar.style.width = '100%';

        if (samples.length === 0) {
            progress.style.display = 'none';
            status.className = 'face-recognition-status error';
            status.innerHTML = '<i class="bi bi-x-circle"></i> No se detectó un rostro. Ubicate frente a la cámara con buena iluminación.';
            showToast('❌ No se detectó un rostro', 'error');
            return;
        }

        const liveDescriptor = averageDescriptors(samples);
        const distance = euclideanDistance(liveDescriptor, currentUser.faceDescriptor);
        const isMatch = distance <= CONFIG.FACE_MATCH_THRESHOLD;
        progress.style.display = 'none';
        progressBar.style.width = '0%';
        console.log(`Distancia facial: ${distance.toFixed(3)} (umbral: ${CONFIG.FACE_MATCH_THRESHOLD}, muestras: ${samples.length}/${CONFIG.IDENTIFY_SAMPLES})`);

        if (isMatch) {
            recognizedTeacher = currentUser;
            isFaceVerified = true;
            status.className = 'face-recognition-status success';
            status.innerHTML = `<i class="bi bi-check-circle"></i> ✅ Identificado: ${currentUser.nombre} ${currentUser.apellido}<br><small>Coincidencia facial confirmada</small>`;
            showToast('✅ Identificación exitosa', 'success');
        } else {
            recognizedTeacher = null;
            isFaceVerified = false;
            status.className = 'face-recognition-status error';
            status.innerHTML = `<i class="bi bi-x-circle"></i> ❌ El rostro no coincide con el registrado<br><small>Intentá de nuevo con mejor iluminación</small>`;
            showToast('❌ Reconocimiento fallido', 'error');
        }
        updateAttendanceButtonsState();
    } catch (error) {
        console.error(error);
        progress.style.display = 'none';
        status.className = 'face-recognition-status error';
        status.innerHTML = '<i class="bi bi-exclamation-triangle"></i> Error en el reconocimiento';
        showToast('Error en el reconocimiento', 'error');
    }
}

function registerAttendance(type) {
    if (!isFaceVerified || !recognizedTeacher) { showToast('⚠️ Identifícate primero con "Identificarme"', 'warning'); return; }

    // Entrada única diaria: se recalcula acá (no solo en la UI) para que
    // tampoco se pueda saltear llamando a esta función directo desde la
    // consola. No se puede salir de algo a lo que no entró, ni volver a
    // marcar una segunda entrada el mismo día.
    const yaEntroHoy = hasEntryToday(recognizedTeacher.id);
    if (type === 'entry' && yaEntroHoy) {
        showToast('⚠️ Ya registraste tu entrada de hoy.', 'warning');
        updateAttendanceButtonsState();
        return;
    }
    if ((type === 'exit' || type === 'early_exit') && !yaEntroHoy) {
        showToast('⚠️ Todavía no registraste tu entrada de hoy.', 'warning');
        updateAttendanceButtonsState();
        return;
    }

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];
    const status = document.getElementById('faceRecognitionStatus');
    let attStatus = 'present';
    const criteria = getCriteria();
    const lateLimit = criteria.lateLimit || 15;

    if (type === 'entry') {
        const todayDay = FULL_DAYS[now.getDay()];
        const earliestStart = getEarliestScheduleTime(recognizedTeacher, todayDay);
        if (earliestStart) {
            const [startH, startM] = earliestStart.split(':').map(Number);
            const scheduledMinutes = startH * 60 + startM;
            const nowMinutes = now.getHours() * 60 + now.getMinutes();
            if (nowMinutes > scheduledMinutes + lateLimit) {
                attStatus = 'late';
                createAlert(recognizedTeacher, 'Tardanza', `Llegó tarde (${time}). Hora prevista: ${earliestStart}. Más de ${lateLimit} minutos de retraso.`);
            }
        }
        // Si ya se había generado una alerta de Falta hoy (porque pasó el
        // margen de tolerancia antes de que el docente marcara entrada),
        // la retiramos: llegó, aunque sea tarde, así que ya no es una falta.
        clearTodaysFaltaAlert(recognizedTeacher.id, date);
    }

    // No confiar en qué botón haya quedado visible en la UI: se
    // vuelve a calcular la ventana de salida con la hora real en
    // este mismo momento. Así, aunque alguien reactive el botón
    // "Salida" manipulando el DOM o llame a esta función desde la
    // consola, el registro se rechaza si en verdad no es la hora.
    const teacherFullName = `${recognizedTeacher.apellido} ${recognizedTeacher.nombre}`;
    const todayDay = FULL_DAYS[now.getDay()];
    const exitInfo = getExitWindowInfo(recognizedTeacher);

    if (type === 'exit' && !exitInfo.isExitTime) {
        showToast('⚠️ Todavía no es tu horario de salida. Usá "Salir antes de tiempo".', 'warning');
        updateAttendanceButtonsState();
        return;
    }

    if (type === 'early_exit') {
        const scheduledEnd = exitInfo.scheduledEnd || getLatestScheduleEndTime(recognizedTeacher, todayDay);
        const horarioTexto = scheduledEnd ? `${todayDay} hasta las ${scheduledEnd}` : 'sin horario cargado para hoy';
        createAlert(recognizedTeacher, 'Salida Anticipada', `Salida anticipada - ${teacherFullName} - ${time} - Horario que correspondía: ${horarioTexto}`);
    }

    const typeMap = { 'entry': 'ENTRADA', 'exit': 'SALIDA', 'early_exit': 'SALIDA ANTES DE TIEMPO' };
    const attendance = getAttendance();
    attendance.push({
        id: Date.now().toString(),
        teacherId: recognizedTeacher.id,
        teacherName: `${recognizedTeacher.apellido} ${recognizedTeacher.nombre}`,
        date, time, type, status: attStatus, timestamp: now.toISOString()
    });
    saveAttendance(attendance);

    const needsAttention = attStatus === 'late' || type === 'early_exit';
    const warningNote = attStatus === 'late' ? ' ⚠️ Tardanza'
        : type === 'early_exit' ? ' ⚠️ Queda pendiente de justificación' : '';
    status.className = `face-recognition-status ${needsAttention ? 'warning' : 'success'}`;
    status.innerHTML = `<i class="bi bi-check-circle"></i> ✅ ${typeMap[type]} a las ${time}${warningNote}<br><small>Verificado facialmente</small>`;
    showToast(`${needsAttention ? '⚠️' : '✅'} ${typeMap[type]} registrada${type === 'early_exit' ? ' — queda pendiente de justificación' : ''}`, needsAttention ? 'warning' : 'success');

    setTimeout(() => {
        isFaceVerified = false;
        recognizedTeacher = null;
        status.className = 'face-recognition-status waiting';
        status.innerHTML = '<i class="bi bi-info-circle"></i> Esperando identificación...';
        updateAttendanceButtonsState();
    }, 5000);

    if (document.getElementById('adminDashboard').classList.contains('hidden') === false) updateStats();
}

function createAlert(teacher, type, message) {
    const alerts = getAlerts();
    alerts.push({
        id: `${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`,
        teacherId: teacher.id, teacherName: `${teacher.apellido} ${teacher.nombre}`,
        type, message, date: new Date().toISOString(), justified: false, justification: null, visible: true
    });
    saveAlerts(alerts);
    if (document.getElementById('adminDashboard').classList.contains('hidden') === false) loadAlerts();
    showToast(`⚠️ Alerta: ${type}`, 'warning');
}

// Quita una alerta de Falta puntual (teacherId + fecha) del docente,
// por ejemplo cuando termina llegando (tarde) el mismo día en que
// ya se había generado la falta por pasar el margen de tolerancia.
function clearTodaysFaltaAlert(teacherId, dateStr) {
    let alerts = getAlerts();
    const before = alerts.length;
    alerts = alerts.filter(a => !(a.teacherId === teacherId && a.type === 'Falta' && a.faltaDate === dateStr));
    if (alerts.length !== before) {
        saveAlerts(alerts);
        if (document.getElementById('adminDashboard').classList.contains('hidden') === false) {
            loadAlerts();
            updateAlertCount();
        }
    }
}

// Hora de inicio (HH:MM) más temprana que tiene el docente agendada
// para un día de la semana dado (p. ej. "Lunes"). Es contra esa hora
// que se mide la tolerancia de tardanza / falta.
function getEarliestScheduleTime(teacher, dayName) {
    const times = getHorarioLaboral(teacher).filter(h => h.dia === dayName).map(h => h.inicio);
    if (times.length === 0) return null;
    return times.sort()[0];
}

// Hora de fin (HH:MM) más tardía que tiene el docente agendada
// para un día de la semana dado. Es la hora de salida "oficial"
// contra la que se valida el botón de Salida.
function getLatestScheduleEndTime(teacher, dayName) {
    const times = getHorarioLaboral(teacher).filter(h => h.dia === dayName).map(h => h.fin);
    if (times.length === 0) return null;
    return times.sort().slice(-1)[0];
}

// Determina si, en este preciso momento, corresponde el botón de
// "Salida" normal (ya llegó/pasó la hora de salida, con los
// EXIT_TOLERANCE_MINUTES de margen) o si todavía es una salida
// antes de tiempo. Se recalcula siempre con la hora actual real
// (Date), nunca con un valor guardado en variables, así una vez
// ocultado el botón "Salida" no hay forma de reactivarlo antes de
// horario manipulando el estado de la UI: registerAttendance()
// vuelve a correr este mismo cálculo antes de guardar el registro.
// Si el docente no tiene horario cargado para hoy, no hay forma de
// validar que sea su hora de salida, así que se trata siempre
// como salida antes de tiempo (queda pendiente de autorización).
function getExitWindowInfo(teacher) {
    const now = new Date();
    const todayDay = FULL_DAYS[now.getDay()];
    const scheduledEnd = getLatestScheduleEndTime(teacher, todayDay);
    if (!scheduledEnd) return { isExitTime: false, scheduledEnd: null };
    const [endH, endM] = scheduledEnd.split(':').map(Number);
    const scheduledMinutes = endH * 60 + endM;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const tolerance = CONFIG.EXIT_TOLERANCE_MINUTES;
    const isExitTime = nowMinutes >= (scheduledMinutes - tolerance);
    return { isExitTime, scheduledEnd };
}

// ============================================================
// LICENCIAS / PERMISOS
// ============================================================
function getLicenciaForDate(teacherId, dateStr) {
    return getLicencias().find(l => l.teacherId === teacherId && dateStr >= l.from && dateStr <= l.to) || null;
}

function addLicencia() {
    const teacherId = document.getElementById('licenciaTeacher').value;
    const from = document.getElementById('licenciaFrom').value;
    const to = document.getElementById('licenciaTo').value;
    const motivo = document.getElementById('licenciaMotivo').value.trim();
    if (!teacherId) { showToast('Selecciona un docente', 'warning'); return; }
    if (!from || !to) { showToast('Completa las fechas desde/hasta', 'warning'); return; }
    if (to < from) { showToast('La fecha "Hasta" no puede ser anterior a "Desde"', 'error'); return; }
    const teacher = getTeachers().find(t => t.id === teacherId);
    if (!teacher) { showToast('Docente no encontrado', 'error'); return; }

    const licencias = getLicencias();
    licencias.push({
        id: Date.now().toString(), teacherId, teacherName: `${teacher.apellido} ${teacher.nombre}`,
        from, to, motivo: motivo || 'Sin especificar', createdAt: new Date().toISOString()
    });
    saveLicenciasToStorage(licencias);

    // Justifica retroactivamente cualquier alerta de Falta que ya
    // existiera para ese docente dentro del rango de la licencia.
    const alerts = getAlerts();
    let justifiedAny = false;
    alerts.forEach(a => {
        if (a.teacherId === teacherId && a.type === 'Falta' && !a.justified && a.faltaDate >= from && a.faltaDate <= to) {
            a.justified = true;
            a.justification = 'licencia';
            justifiedAny = true;
        }
    });
    if (justifiedAny) saveAlerts(alerts);

    document.getElementById('licenciaTeacher').value = '';
    document.getElementById('licenciaFrom').value = '';
    document.getElementById('licenciaTo').value = '';
    document.getElementById('licenciaMotivo').value = '';
    loadLicenciasList();
    loadAlerts();
    updateAlertCount();
    showToast('✅ Licencia registrada', 'success');
}

function deleteLicencia(id) {
    const licencias = getLicencias().filter(l => l.id !== id);
    saveLicenciasToStorage(licencias);
    loadLicenciasList();
    showToast('Licencia eliminada', 'info');
}

function loadLicenciasList() {
    const tbody = document.getElementById('licenciasTableBody');
    if (!tbody) return;
    const licencias = getLicencias().slice().sort((a, b) => b.from.localeCompare(a.from));
    if (licencias.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Sin licencias registradas</td></tr>';
        return;
    }
    tbody.innerHTML = licencias.map(l => `
        <tr>
            <td>${l.teacherName}</td>
            <td>${l.from}</td>
            <td>${l.to}</td>
            <td>${l.motivo}</td>
            <td><button class="btn btn-sm btn-danger" onclick="deleteLicencia('${l.id}')"><i class="bi bi-trash"></i></button></td>
        </tr>
    `).join('');
}

// ============================================================
// EVENTOS ESPECIALES (admin)
// Vive en tablas relacionales propias de Supabase (evento_especial,
// evento_docente, docente), separadas de app_data. `docente` se mantiene
// como espejo de app_data.teachers (mismo id, convertido a número) solo
// para poder cumplir la FK de evento_docente.id_docente sin duplicar la
// gestión real de docentes, que sigue siendo app_data.teachers.
// ============================================================
let currentEventos = [];
let eventoSelectedTeacherIds = [];
let editingEventoId = null;

// Refleja un docente de app_data.teachers en la tabla `docente`, usando su
// mismo id (convertido a número) como clave, para que evento_docente pueda
// referenciarlo sin violar la FK. Se llama para cada docente convocado
// justo antes de guardar un Evento Especial. Devuelve el id numérico
// usado, o null si falló (en cuyo caso ese docente se omite del evento).
async function syncTeacherToDocenteTable(teacher) {
    if (!sb) return null;
    const idDocente = Number(teacher.id);
    if (!Number.isFinite(idDocente)) return null;
    try {
        const { error } = await sb.from('docente').upsert({
            id_docente: idDocente,
            apellido: teacher.apellido,
            nombre: teacher.nombre,
            dni: teacher.dni,
        }, { onConflict: 'id_docente' });
        if (error) throw error;
        return idDocente;
    } catch (error) {
        console.error('No se pudo sincronizar el docente "' + teacher.apellido + '" a la tabla docente:', error);
        showToast(`No se pudo sincronizar a ${teacher.apellido} ${teacher.nombre} con Supabase (${describeSupabaseError(error)})`, 'warning');
        return null;
    }
}

async function loadEventosEspeciales() {
    const tbody = document.getElementById('eventosTableBody');
    if (!tbody) return;
    if (!sb) { tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Sin conexión a Supabase</td></tr>'; return; }
    try {
        const { data, error } = await sb
            .from('evento_especial')
            .select('id_evento,titulo,descripcion,fecha,hora_entrada,hora_salida,lugar,evento_docente(count)')
            .order('fecha', { ascending: false });
        if (error) throw error;
        currentEventos = data || [];
        if (currentEventos.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Sin eventos registrados</td></tr>';
            return;
        }
        tbody.innerHTML = currentEventos.map(ev => {
            const cantDocentes = (ev.evento_docente && ev.evento_docente[0] && ev.evento_docente[0].count) || 0;
            return `
                <tr>
                    <td>${ev.titulo}</td>
                    <td>${ev.fecha}</td>
                    <td>${(ev.hora_entrada || '').slice(0, 5)} - ${(ev.hora_salida || '').slice(0, 5)}</td>
                    <td>${ev.lugar || '-'}</td>
                    <td>${cantDocentes}</td>
                    <td>
                        <button class="btn btn-sm btn-info" title="Ver" onclick="viewEvento(${ev.id_evento})"><i class="bi bi-eye"></i></button>
                        <button class="btn btn-sm btn-primary" title="Editar" onclick="editEvento(${ev.id_evento})"><i class="bi bi-pencil"></i></button>
                        <button class="btn btn-sm btn-danger" title="Eliminar" onclick="deleteEvento(${ev.id_evento})"><i class="bi bi-trash"></i></button>
                    </td>
                </tr>`;
        }).join('');
    } catch (error) {
        console.error('Error cargando eventos especiales:', error);
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger">No se pudieron cargar los eventos</td></tr>';
        showToast('No se pudieron cargar los eventos especiales (' + describeSupabaseError(error) + ')', 'error');
    }
}

function openEventoModal() {
    editingEventoId = null;
    eventoSelectedTeacherIds = [];
    document.getElementById('eventoModalTitle').innerHTML = '<i class="bi bi-calendar-event"></i> Nuevo Evento Especial';
    document.getElementById('eventoTitulo').value = '';
    document.getElementById('eventoDescripcion').value = '';
    document.getElementById('eventoFecha').value = '';
    document.getElementById('eventoHoraEntrada').value = '';
    document.getElementById('eventoHoraSalida').value = '';
    document.getElementById('eventoLugar').value = '';
    document.getElementById('eventoDocenteSearch').value = '';
    document.getElementById('eventoDocenteDropdown').classList.add('hidden');
    renderEventoDocenteChips();
    new bootstrap.Modal(document.getElementById('eventoModal')).show();
}

async function editEvento(idEvento) {
    const ev = currentEventos.find(e => e.id_evento === idEvento);
    if (!ev) { showToast('Evento no encontrado', 'error'); return; }
    editingEventoId = idEvento;
    document.getElementById('eventoModalTitle').innerHTML = '<i class="bi bi-pencil"></i> Editar Evento Especial';
    document.getElementById('eventoTitulo').value = ev.titulo || '';
    document.getElementById('eventoDescripcion').value = ev.descripcion || '';
    document.getElementById('eventoFecha').value = ev.fecha || '';
    document.getElementById('eventoHoraEntrada').value = (ev.hora_entrada || '').slice(0, 5);
    document.getElementById('eventoHoraSalida').value = (ev.hora_salida || '').slice(0, 5);
    document.getElementById('eventoLugar').value = ev.lugar || '';
    document.getElementById('eventoDocenteSearch').value = '';
    document.getElementById('eventoDocenteDropdown').classList.add('hidden');

    try {
        const { data, error } = await sb.from('evento_docente').select('id_docente').eq('id_evento', idEvento);
        if (error) throw error;
        eventoSelectedTeacherIds = (data || [])
            .map(row => { const t = getTeacherByNumericId(row.id_docente); return t ? t.id : null; })
            .filter(Boolean);
    } catch (error) {
        console.error('No se pudieron cargar los docentes del evento:', error);
        eventoSelectedTeacherIds = [];
        showToast('No se pudieron cargar los docentes convocados de este evento', 'warning');
    }
    renderEventoDocenteChips();
    new bootstrap.Modal(document.getElementById('eventoModal')).show();
}

async function viewEvento(idEvento) {
    const ev = currentEventos.find(e => e.id_evento === idEvento);
    if (!ev) { showToast('Evento no encontrado', 'error'); return; }
    document.getElementById('eventoViewModalTitle').innerHTML = `<i class="bi bi-calendar-event"></i> ${ev.titulo}`;
    document.getElementById('eventoViewBody').innerHTML = `
        <p><strong>Fecha:</strong> ${ev.fecha}</p>
        <p><strong>Horario:</strong> ${(ev.hora_entrada || '').slice(0, 5)} - ${(ev.hora_salida || '').slice(0, 5)}</p>
        <p><strong>Lugar:</strong> ${ev.lugar || '-'}</p>
        <p><strong>Descripción:</strong> ${ev.descripcion || '-'}</p>
        <p class="mb-1"><strong>Docentes convocados:</strong></p>
        <div id="eventoViewDocentes"><span class="text-muted">Cargando...</span></div>
    `;
    new bootstrap.Modal(document.getElementById('eventoViewModal')).show();

    try {
        const { data, error } = await sb.from('evento_docente').select('id_docente').eq('id_evento', idEvento);
        if (error) throw error;
        const names = (data || []).map(row => {
            const t = getTeacherByNumericId(row.id_docente);
            return t ? `${t.apellido} ${t.nombre}` : `Docente #${row.id_docente}`;
        });
        document.getElementById('eventoViewDocentes').innerHTML = names.length > 0
            ? names.map(n => `<span class="horario-chip">${n}</span>`).join(' ')
            : '<span class="text-muted">Sin docentes convocados</span>';
    } catch (error) {
        console.error('No se pudieron cargar los docentes del evento:', error);
        document.getElementById('eventoViewDocentes').innerHTML = '<span class="text-danger">No se pudieron cargar los docentes</span>';
    }
}

// Autocompletado del buscador de docentes del modal: filtra
// app_data.teachers por apellido/nombre y excluye a los ya seleccionados.
function filterEventoDocenteOptions() {
    const dropdown = document.getElementById('eventoDocenteDropdown');
    const query = document.getElementById('eventoDocenteSearch').value.trim().toLowerCase();
    const matches = getTeachers().filter(t => {
        if (eventoSelectedTeacherIds.includes(t.id)) return false;
        if (!query) return true;
        const full = `${t.apellido} ${t.nombre}`.toLowerCase();
        return t.apellido.toLowerCase().includes(query) || t.nombre.toLowerCase().includes(query) || full.includes(query);
    }).slice(0, 8);

    dropdown.innerHTML = matches.length === 0
        ? '<div class="dropdown-empty">No se encontraron docentes</div>'
        : matches.map(t => `<div class="dropdown-option" onclick="selectEventoDocente('${t.id}')">${t.apellido} ${t.nombre}${t.materia ? ' - ' + t.materia : ''}</div>`).join('');
    dropdown.classList.remove('hidden');
}

function selectEventoDocente(teacherId) {
    if (!eventoSelectedTeacherIds.includes(teacherId)) eventoSelectedTeacherIds.push(teacherId);
    document.getElementById('eventoDocenteSearch').value = '';
    document.getElementById('eventoDocenteDropdown').classList.add('hidden');
    renderEventoDocenteChips();
}

function removeEventoDocente(teacherId) {
    eventoSelectedTeacherIds = eventoSelectedTeacherIds.filter(id => id !== teacherId);
    renderEventoDocenteChips();
}

function renderEventoDocenteChips() {
    const container = document.getElementById('eventoDocenteChips');
    if (eventoSelectedTeacherIds.length === 0) {
        container.innerHTML = '<span class="text-muted">No se seleccionó ningún docente</span>';
        return;
    }
    const teachers = getTeachers();
    container.innerHTML = eventoSelectedTeacherIds.map(id => {
        const t = teachers.find(t => t.id === id);
        const label = t ? `${t.apellido} ${t.nombre}` : `Docente #${id}`;
        return `
            <span class="horario-chip">
                ${label}
                <button type="button" class="horario-chip-remove" onclick="removeEventoDocente('${id}')" aria-label="Quitar docente">&times;</button>
            </span>`;
    }).join('');
}

// Cierra el dropdown de autocompletado al hacer clic fuera del buscador.
document.addEventListener('click', function(e) {
    const search = document.getElementById('eventoDocenteSearch');
    const dropdown = document.getElementById('eventoDocenteDropdown');
    if (!search || !dropdown) return;
    if (!search.contains(e.target) && !dropdown.contains(e.target)) dropdown.classList.add('hidden');
});

async function saveEvento() {
    const titulo = document.getElementById('eventoTitulo').value.trim();
    const descripcion = document.getElementById('eventoDescripcion').value.trim();
    const fecha = document.getElementById('eventoFecha').value;
    const horaEntrada = document.getElementById('eventoHoraEntrada').value;
    const horaSalida = document.getElementById('eventoHoraSalida').value;
    const lugar = document.getElementById('eventoLugar').value.trim();

    if (!titulo) { showToast('El título es obligatorio', 'error'); return; }
    if (!fecha) { showToast('La fecha es obligatoria', 'error'); return; }
    if (!horaEntrada || !horaSalida) { showToast('Completá la hora de entrada y de salida', 'error'); return; }
    if (horaSalida <= horaEntrada) { showToast('La hora de salida debe ser posterior a la de entrada', 'error'); return; }
    if (!sb) { showToast('Sin conexión a Supabase, no se puede guardar', 'error'); return; }

    const payload = { titulo, descripcion: descripcion || null, fecha, hora_entrada: horaEntrada, hora_salida: horaSalida, lugar: lugar || null };

    try {
        let idEvento = editingEventoId;
        if (idEvento) {
            const { error } = await sb.from('evento_especial').update(payload).eq('id_evento', idEvento);
            if (error) throw error;
            const { error: delError } = await sb.from('evento_docente').delete().eq('id_evento', idEvento);
            if (delError) throw delError;
        } else {
            const { data, error } = await sb.from('evento_especial').insert(payload).select('id_evento').single();
            if (error) throw error;
            idEvento = data.id_evento;
        }

        // Sincroniza cada docente convocado a la tabla `docente` (para que
        // la FK de evento_docente no falle) y arma las filas a insertar.
        const teachers = getTeachers();
        const rows = [];
        for (const teacherId of eventoSelectedTeacherIds) {
            const teacher = teachers.find(t => t.id === teacherId);
            if (!teacher) continue;
            const idDocente = await syncTeacherToDocenteTable(teacher);
            if (idDocente !== null) rows.push({ id_evento: idEvento, id_docente: idDocente });
        }
        if (rows.length > 0) {
            const { error: insError } = await sb.from('evento_docente').insert(rows);
            if (insError) throw insError;
        }

        showToast(`✅ Evento "${titulo}" guardado con ${rows.length} docente(s) convocado(s)`, 'success');
        bootstrap.Modal.getInstance(document.getElementById('eventoModal'))?.hide();
        loadEventosEspeciales();
    } catch (error) {
        console.error('Error guardando evento especial:', error);
        showToast('No se pudo guardar el evento (' + describeSupabaseError(error) + ')', 'error');
    }
}

async function deleteEvento(idEvento) {
    if (!confirm('¿Eliminar este evento especial? Esta acción no se puede deshacer.')) return;
    try {
        // Primero los vínculos con docentes (por si la FK no tiene cascade),
        // después el evento en sí.
        const { error: delDocError } = await sb.from('evento_docente').delete().eq('id_evento', idEvento);
        if (delDocError) throw delDocError;
        const { error } = await sb.from('evento_especial').delete().eq('id_evento', idEvento);
        if (error) throw error;
        showToast('Evento eliminado', 'info');
        loadEventosEspeciales();
    } catch (error) {
        console.error('Error eliminando evento especial:', error);
        showToast('No se pudo eliminar el evento (' + describeSupabaseError(error) + ')', 'error');
    }
}

// ============================================================
// CALENDARIO ANUAL (proyección del horario del docente sobre
// todas las fechas del año) Y DETECCIÓN DE FALTAS
// ============================================================

// A partir del horario laboral de un docente (día + inicio + fin),
// arma la lista de fechas concretas de "year" en las que le toca
// dar clase. Usa fechas en UTC para que coincidan con el formato
// (toISOString) con el que se guarda la fecha de cada asistencia.
function generateTeacherScheduleDates(teacher, year) {
    const horario = getHorarioLaboral(teacher);
    if (!horario || horario.length === 0) return [];
    const dayTimesMap = {};
    horario.forEach(h => {
        if (!dayTimesMap[h.dia]) dayTimesMap[h.dia] = [];
        if (!dayTimesMap[h.dia].includes(h.inicio)) dayTimesMap[h.dia].push(h.inicio);
    });
    const results = [];
    const start = Date.UTC(year, 0, 1);
    const end = Date.UTC(year, 11, 31);
    for (let t = start; t <= end; t += 86400000) {
        const d = new Date(t);
        const dayName = FULL_DAYS[d.getUTCDay()];
        if (dayTimesMap[dayName]) {
            results.push({ date: d.toISOString().split('T')[0], day: dayName, times: dayTimesMap[dayName] });
        }
    }
    return results;
}

// Recorre el calendario anual de cada docente y, por cada fecha con
// clase asignada (incluido el día de hoy, una vez que ya pasó el
// margen de tolerancia de la franja más temprana) en la que no
// registró "entrada", genera una alerta de "Falta" (una sola por
// día, no por bloque horario). Los días cubiertos por una licencia
// se saltean por completo. Evita duplicados comparando contra las
// alertas ya creadas para ese docente y esa fecha puntual.
function checkFaltas() {
    const teachers = getTeachers();
    if (teachers.length === 0) return;
    const attendance = getAttendance();
    const alerts = getAlerts();
    const criteria = getCriteria();
    const lateLimit = criteria.lateLimit || 15;
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    let created = false;

    teachers.forEach(teacher => {
        const createdDateStr = teacher.createdAt ? teacher.createdAt.split('T')[0] : todayStr;
        const scheduleDates = generateTeacherScheduleDates(teacher, SCHEDULE_CALENDAR_YEAR);
        scheduleDates.forEach(sd => {
            if (sd.date < createdDateStr || sd.date > todayStr) return;
            if (getLicenciaForDate(teacher.id, sd.date)) return;

            if (sd.date === todayStr) {
                const earliestStart = sd.times.slice().sort()[0];
                const [startH, startM] = earliestStart.split(':').map(Number);
                const scheduledMinutes = startH * 60 + startM;
                if (nowMinutes <= scheduledMinutes + lateLimit) return; // todavía dentro del margen, no es falta (todavía)
            }

            const hasEntry = attendance.some(a => a.teacherId === teacher.id && a.type === 'entry' && a.date === sd.date);
            if (hasEntry) return;
            const alreadyAlerted = alerts.some(a => a.teacherId === teacher.id && a.type === 'Falta' && a.faltaDate === sd.date);
            if (alreadyAlerted) return;
            alerts.push({
                id: `${teacher.id}_falta_${sd.date}`,
                teacherId: teacher.id,
                teacherName: `${teacher.apellido} ${teacher.nombre}`,
                type: 'Falta',
                message: `No registró entrada el ${sd.date} (${sd.day}, horario: ${sd.times.join(', ')}).`,
                date: new Date().toISOString(),
                faltaDate: sd.date,
                justified: false, justification: null, visible: true
            });
            created = true;

            // Aviso automático por WhatsApp: se PREPARA el link con el texto
            // pedido, pero no se envía solo — queda logueado y disponible
            // como botón en la alerta (ver renderWhatsAppButton en loadAlerts)
            // para que el administrador lo mande con un clic si corresponde.
            const waLink = buildWhatsAppLink(teacher.telefono, 'Se registró una ausencia en el sistema, comuníquese con la institución.');
            if (waLink) console.log(`Aviso de ausencia disponible para ${teacher.apellido} ${teacher.nombre}: ${waLink}`);
        });
    });

    if (created) {
        saveAlerts(alerts);
        if (document.getElementById('adminDashboard').classList.contains('hidden') === false) {
            loadAlerts();
            updateAlertCount();
        }
    }
}

// Estado (para calendario) de un docente en una fecha con clase
// asignada: licencia > presente > falta (si ya pasó) > programado.
function getDayStatus(teacherId, dateStr, hasScheduleToday, earliestStart, attendedDates, todayStr, nowMinutes, lateLimit) {
    if (getLicenciaForDate(teacherId, dateStr)) return 'licencia';
    if (attendedDates.has(dateStr)) return 'present';
    if (dateStr < todayStr) return 'falta';
    if (dateStr === todayStr && hasScheduleToday) {
        const [startH, startM] = earliestStart.split(':').map(Number);
        if (nowMinutes > startH * 60 + startM + lateLimit) return 'falta';
    }
    return 'scheduled';
}

// ============================================================
// GRILLA COMPLETA DE HORARIOS (solo lectura, panel del admin)
// Se arma en el momento a partir de horario_laboral de cada
// docente (día + inicio + fin), no se persiste por separado.
// ============================================================
function showFullScheduleGrid() {
    const teachers = getTeachers();
    const body = document.getElementById('fullScheduleGridBody');

    if (teachers.length === 0) {
        body.innerHTML = '<p class="text-muted text-center mb-0">No hay docentes registrados</p>';
        new bootstrap.Modal(document.getElementById('fullScheduleGridModal')).show();
        return;
    }

    const cellData = {}; // `${dia}_${hora}` -> [{ name, range }]
    teachers.forEach(teacher => {
        getHorarioLaboral(teacher).forEach(h => {
            const [inicioH] = h.inicio.split(':').map(Number);
            const [finH, finM] = h.fin.split(':').map(Number);
            const finExclusivo = finM > 0 ? finH + 1 : finH;
            for (let hora = inicioH; hora < finExclusivo; hora++) {
                const key = `${h.dia}_${hora}`;
                if (!cellData[key]) cellData[key] = [];
                cellData[key].push({ name: `${teacher.apellido} ${teacher.nombre}`, range: `${h.inicio}-${h.fin}` });
            }
        });
    });

    let html = '<div class="table-responsive"><table class="table table-bordered table-sm text-center align-middle mb-0"><thead><tr><th>Hora</th>';
    DAYS.forEach(day => { html += `<th>${day}</th>`; });
    html += '</tr></thead><tbody>';
    for (let hora = START_HOUR; hora < END_HOUR; hora++) {
        const label = `${hora.toString().padStart(2, '0')}:00`;
        html += `<tr><td class="fw-semibold">${label}</td>`;
        DAYS.forEach(day => {
            const entries = cellData[`${day}_${hora}`] || [];
            if (entries.length === 0) {
                html += '<td></td>';
            } else {
                const badges = entries.map(e => `<span class="badge bg-secondary d-block mb-1" title="${e.range}">${e.name}</span>`).join('');
                html += `<td>${badges}</td>`;
            }
        });
        html += '</tr>';
    }
    html += '</tbody></table></div>';

    body.innerHTML = html;
    new bootstrap.Modal(document.getElementById('fullScheduleGridModal')).show();
}

// ============================================================
// FICHA / REPORTE INDIVIDUAL DEL DOCENTE (buscador)
// ============================================================
function showTeacherDetail(teacherId) {
    const teacher = getTeachers().find(t => t.id === teacherId);
    if (!teacher) return;

    const attendance = getAttendance().filter(a => a.teacherId === teacherId);
    const entries = attendance.filter(a => a.type === 'entry');
    const presentCount = entries.filter(a => a.status === 'present').length;
    const lateCount = entries.filter(a => a.status === 'late').length;
    const alerts = getAlerts().filter(a => a.teacherId === teacherId);
    const faltaCount = alerts.filter(a => a.type === 'Falta' && !a.justified).length;
    const licencias = getLicencias().filter(l => l.teacherId === teacherId);

    const horarioTeacherDetail = getHorarioLaboral(teacher);
    const scheduleDisplay = horarioTeacherDetail.length > 0 ?
        horarioTeacherDetail.map(h => `${h.dia} ${h.inicio}-${h.fin}`).join('<br>') : 'Sin horario asignado';
    const licenciasDisplay = licencias.length > 0 ?
        licencias.map(l => `${l.from} al ${l.to} — ${l.motivo}`).join('<br>') : 'Sin licencias registradas';

    document.getElementById('teacherDetailModalTitle').textContent = `Ficha de ${teacher.apellido} ${teacher.nombre}`;
    document.getElementById('teacherDetailBody').innerHTML = `
        <div class="text-center mb-3">
            <img src="${teacher.photo || ''}" alt="Foto" style="width:90px;height:90px;border-radius:50%;object-fit:cover;border:3px solid var(--olive-600);">
        </div>
        <div class="row">
            <div class="col-md-6">
                <p><strong>DNI:</strong> ${teacher.dni}</p>
                <p><strong>Teléfono:</strong> ${teacher.telefono || '-'}</p>
                <p><strong>Tel. familiar:</strong> ${teacher.telefonoFamiliar || '-'}</p>
                <p><strong>Dirección:</strong> ${teacher.direccion || '-'}</p>
                <p><strong>Materia:</strong> ${teacher.materia || '-'}</p>
            </div>
            <div class="col-md-6">
                <p><strong>Entradas a horario:</strong> ${presentCount}</p>
                <p><strong>Tardanzas:</strong> ${lateCount}</p>
                <p><strong>Faltas sin justificar:</strong> ${faltaCount}</p>
                <p><strong>Licencias:</strong><br>${licenciasDisplay}</p>
            </div>
        </div>
        <p><strong>Horario de trabajo:</strong><br>${scheduleDisplay}</p>
    `;
    document.getElementById('teacherDetailModal').dataset.teacherId = teacherId;
    new bootstrap.Modal(document.getElementById('teacherDetailModal')).show();
}

function openCalendarFromDetail() {
    const teacherId = document.getElementById('teacherDetailModal').dataset.teacherId;
    if (!teacherId) return;
    const modalEl = document.getElementById('teacherDetailModal');
    bootstrap.Modal.getInstance(modalEl)?.hide();
    showTeacherCalendar(teacherId);
}

function generateIndividualReport() {
    const teacherId = document.getElementById('teacherDetailModal').dataset.teacherId;
    const teacher = getTeachers().find(t => t.id === teacherId);
    if (!teacher) return;
    document.getElementById('reportTeacher').value = teacherId;
    document.getElementById('reportFrom').value = teacher.createdAt ? teacher.createdAt.split('T')[0] : `${SCHEDULE_CALENDAR_YEAR}-01-01`;
    document.getElementById('reportTo').value = new Date().toISOString().split('T')[0];
    generateReport();
}

// ===== Vista de calendario anual 2026 por docente =====
function showTeacherCalendar(teacherId) {
    const teacher = getTeachers().find(t => t.id === teacherId);
    if (!teacher) return;
    const scheduleDates = generateTeacherScheduleDates(teacher, SCHEDULE_CALENDAR_YEAR);
    const scheduledByDate = {};
    scheduleDates.forEach(sd => { scheduledByDate[sd.date] = sd; });

    const attendance = getAttendance();
    const attendedDates = new Set(
        attendance.filter(a => a.teacherId === teacherId && a.type === 'entry').map(a => a.date)
    );
    const criteria = getCriteria();
    const lateLimit = criteria.lateLimit || 15;
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    document.getElementById('calendarModalTitle').textContent =
        `Calendario ${SCHEDULE_CALENDAR_YEAR} — ${teacher.apellido} ${teacher.nombre}`;

    const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    let html = '';
    for (let m = 0; m < 12; m++) {
        html += `<div class="mini-calendar"><div class="mini-calendar-title">${monthNames[m]}</div><div class="mini-calendar-grid">`;
        ['D','L','M','X','J','V','S'].forEach(l => html += `<div class="mini-calendar-dow">${l}</div>`);
        const firstDow = new Date(Date.UTC(SCHEDULE_CALENDAR_YEAR, m, 1)).getUTCDay();
        const daysInMonth = new Date(Date.UTC(SCHEDULE_CALENDAR_YEAR, m + 1, 0)).getUTCDate();
        for (let i = 0; i < firstDow; i++) html += `<div class="mini-calendar-day empty"></div>`;
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = new Date(Date.UTC(SCHEDULE_CALENDAR_YEAR, m, day)).toISOString().split('T')[0];
            let cls = 'mini-calendar-day';
            let title = dateStr;
            const licencia = getLicenciaForDate(teacherId, dateStr);
            if (licencia) {
                cls += ' day-licencia';
                title += ` (Licencia: ${licencia.motivo})`;
            } else if (scheduledByDate[dateStr]) {
                const sd = scheduledByDate[dateStr];
                title += ` — ${sd.times.join(', ')}`;
                const earliestStart = sd.times.slice().sort()[0];
                const status = getDayStatus(teacherId, dateStr, true, earliestStart, attendedDates, todayStr, nowMinutes, lateLimit);
                if (status === 'present') { cls += ' day-present'; title += ' (presente)'; }
                else if (status === 'falta') { cls += ' day-falta'; title += ' (FALTA)'; }
                else { cls += ' day-scheduled'; title += ' (programado)'; }
            }
            html += `<div class="${cls}" title="${title}">${day}</div>`;
        }
        html += `</div></div>`;
    }
    document.getElementById('calendarModalBody').innerHTML = html;
    new bootstrap.Modal(document.getElementById('calendarModal')).show();
}

// ===== Vista de calendario anual del establecimiento (todos los
// docentes, desde hoy hasta diciembre de SCHEDULE_CALENDAR_YEAR) =====
function showAnnualCalendar() {
    const teachers = getTeachers();
    const attendance = getAttendance();
    const criteria = getCriteria();
    const lateLimit = criteria.lateLimit || 15;
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    // Mapa fecha -> [{teacherName, status}], acumulando a todos los
    // docentes que tienen clase asignada ese día.
    const byDate = {};
    teachers.forEach(teacher => {
        const attendedDates = new Set(
            attendance.filter(a => a.teacherId === teacher.id && a.type === 'entry').map(a => a.date)
        );
        const createdDateStr = teacher.createdAt ? teacher.createdAt.split('T')[0] : todayStr;
        generateTeacherScheduleDates(teacher, SCHEDULE_CALENDAR_YEAR).forEach(sd => {
            if (sd.date < todayStr || sd.date < createdDateStr) return; // desde hoy en adelante
            const earliestStart = sd.times.slice().sort()[0];
            const status = getDayStatus(teacher.id, sd.date, true, earliestStart, attendedDates, todayStr, nowMinutes, lateLimit);
            if (!byDate[sd.date]) byDate[sd.date] = [];
            byDate[sd.date].push({ teacherId: teacher.id, name: `${teacher.apellido} ${teacher.nombre}`, status });
        });
    });
    annualCalendarByDate = byDate;

    const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const todayDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const startMonth = todayDate.getUTCFullYear() === SCHEDULE_CALENDAR_YEAR ? todayDate.getUTCMonth() : 0;
    let html = '';
    for (let m = startMonth; m < 12; m++) {
        html += `<div class="annual-month"><div class="annual-month-title">${monthNames[m]} ${SCHEDULE_CALENDAR_YEAR}</div><div class="annual-month-grid">`;
        ['D','L','M','X','J','V','S'].forEach(l => html += `<div class="annual-month-dow">${l}</div>`);
        const firstDow = new Date(Date.UTC(SCHEDULE_CALENDAR_YEAR, m, 1)).getUTCDay();
        const daysInMonth = new Date(Date.UTC(SCHEDULE_CALENDAR_YEAR, m + 1, 0)).getUTCDate();
        for (let i = 0; i < firstDow; i++) html += `<div class="annual-day-cell empty"></div>`;
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = new Date(Date.UTC(SCHEDULE_CALENDAR_YEAR, m, day)).toISOString().split('T')[0];
            if (dateStr < todayStr) { html += `<div class="annual-day-cell empty"></div>`; continue; }
            const entries = byDate[dateStr] || [];
            const chips = entries.map(e => `<span class="annual-teacher-chip status-${e.status}" title="${e.name} (${e.status})">${e.name}</span>`).join('');
            const cellCls = entries.length > 0 ? 'annual-day-cell has-entries' : 'annual-day-cell';
            const cellClick = entries.length > 0 ? ` onclick="showDayDetail('${dateStr}')"` : '';
            html += `<div class="${cellCls}"${cellClick}><div class="annual-day-num">${day}</div>${chips}</div>`;
        }
        html += `</div></div>`;
    }
    document.getElementById('annualCalendarBody').innerHTML = html || '<p class="text-muted">No hay docentes con horario asignado.</p>';
    new bootstrap.Modal(document.getElementById('annualCalendarModal')).show();
}

// Al hacer clic en un día del calendario del establecimiento, muestra
// en grande los nombres de los docentes asignados a ese día (los
// "chips" del calendario son chicos para que entren todos los meses
// en pantalla, así que este detalle es donde se leen cómodos).
function showDayDetail(dateStr) {
    const entries = annualCalendarByDate[dateStr] || [];
    const dateObj = new Date(dateStr + 'T00:00:00Z');
    let formatted = dateObj.toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    formatted = formatted.charAt(0).toUpperCase() + formatted.slice(1);
    document.getElementById('dayDetailModalTitle').textContent = formatted;

    const statusLabel = { present: 'Presente', falta: 'Falta', licencia: 'Licencia', scheduled: 'Programado' };
    document.getElementById('dayDetailBody').innerHTML = entries.length > 0
        ? entries.map(e => `
            <div class="day-detail-teacher status-${e.status}" onclick="openTeacherDetailFromDay('${e.teacherId}')">
                <span class="day-detail-name">${e.name}</span>
                <span class="day-detail-status">${statusLabel[e.status] || e.status}</span>
            </div>
        `).join('')
        : '<p class="text-muted">No hay docentes con clase asignada este día.</p>';
    new bootstrap.Modal(document.getElementById('dayDetailModal')).show();
}

function openTeacherDetailFromDay(teacherId) {
    bootstrap.Modal.getInstance(document.getElementById('dayDetailModal'))?.hide();
    showTeacherDetail(teacherId);
}

// ============================================================
// ESTADÍSTICAS
// ============================================================
function showStatsScreen() {
    document.getElementById('adminDashboard').classList.add('hidden');
    document.getElementById('statsScreen').classList.remove('hidden');
    renderStatsScreen();
}

function hideStatsScreen() {
    document.getElementById('statsScreen').classList.add('hidden');
    document.getElementById('adminDashboard').classList.remove('hidden');
}

// Calcula los indicadores y los datos agregados que alimentan los
// gráficos, a partir de los movimientos (entradas/salidas/retiros)
// guardados en localStorage. Todo se recalcula en el momento, no
// hay estado propio: siempre refleja los registros actuales.
function computeAttendanceStats() {
    const attendance = getAttendance();
    const alerts = getAlerts();
    const entries = attendance.filter(a => a.type === 'entry');
    const presentCount = entries.filter(a => a.status === 'present').length;
    const lateCount = entries.filter(a => a.status === 'late').length;
    const totalEntries = entries.length;
    const punctuality = totalEntries > 0 ? Math.round((presentCount / totalEntries) * 100) : 0;

    const byTeacher = {};
    entries.forEach(a => {
        if (!byTeacher[a.teacherId]) byTeacher[a.teacherId] = { name: a.teacherName, present: 0, late: 0 };
        if (a.status === 'late') byTeacher[a.teacherId].late++;
        else byTeacher[a.teacherId].present++;
    });
    const teacherRows = Object.values(byTeacher).sort((a, b) => (b.present + b.late) - (a.present + a.late));
    const topTeacher = teacherRows[0] || null;

    const byDate = {};
    attendance.forEach(a => { byDate[a.date] = (byDate[a.date] || 0) + 1; });
    const dates = Object.keys(byDate).sort();

    const unjustifiedAlerts = alerts.filter(a => !a.justified).length;
    const earlyExitCount = alerts.filter(a => a.type === 'Salida Anticipada').length;

    return {
        totalRegistros: attendance.length,
        totalEntries, presentCount, lateCount, punctuality,
        teacherRows, topTeacher, dates, byDate, unjustifiedAlerts, earlyExitCount,
    };
}

function renderStatsScreen() {
    const stats = computeAttendanceStats();

    document.getElementById('statsIndicators').innerHTML = `
        <div class="col-md-3"><div class="stat-card"><div class="number">${stats.totalRegistros}</div><div class="label">Total de Movimientos</div></div></div>
        <div class="col-md-3"><div class="stat-card"><div class="number">${stats.punctuality}%</div><div class="label">Puntualidad</div></div></div>
        <div class="col-md-3"><div class="stat-card"><div class="number" style="font-size:1.15rem;">${stats.topTeacher ? stats.topTeacher.name : '—'}</div><div class="label">Docente con más registros</div></div></div>
        <div class="col-md-3"><div class="stat-card"><div class="number">${stats.unjustifiedAlerts}</div><div class="label">Alertas sin Justificar</div></div></div>
        <div class="col-md-3"><div class="stat-card"><div class="number">${stats.earlyExitCount}</div><div class="label">Salidas antes de tiempo</div></div></div>
    `;

    const noData = document.getElementById('statsNoData');
    const chartsContainer = document.getElementById('statsChartsContainer');
    if (stats.totalRegistros === 0) {
        noData.classList.remove('hidden');
        chartsContainer.classList.add('hidden');
        return;
    }
    noData.classList.add('hidden');
    chartsContainer.classList.remove('hidden');
    renderStatsCharts(stats);
}

function renderStatsCharts(stats) {
    const commonOptions = { animation: false, responsive: true, maintainAspectRatio: false };

    if (chartPieInstance) chartPieInstance.destroy();
    chartPieInstance = new Chart(document.getElementById('chartPie'), {
        type: 'pie',
        data: {
            labels: ['Presentes', 'Tardanzas'],
            datasets: [{ data: [stats.presentCount, stats.lateCount], backgroundColor: ['#4f5f34', '#96752c'] }]
        },
        options: { ...commonOptions, plugins: { legend: { position: 'bottom' } } }
    });

    if (chartBarInstance) chartBarInstance.destroy();
    chartBarInstance = new Chart(document.getElementById('chartBar'), {
        type: 'bar',
        data: {
            labels: stats.teacherRows.map(t => t.name),
            datasets: [
                { label: 'Presentes', data: stats.teacherRows.map(t => t.present), backgroundColor: '#4f5f34' },
                { label: 'Tardanzas', data: stats.teacherRows.map(t => t.late), backgroundColor: '#96752c' },
            ]
        },
        options: {
            ...commonOptions,
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } },
            plugins: { legend: { position: 'bottom' } }
        }
    });

    if (chartLineInstance) chartLineInstance.destroy();
    chartLineInstance = new Chart(document.getElementById('chartLine'), {
        type: 'line',
        data: {
            labels: stats.dates,
            datasets: [{
                label: 'Movimientos por día', data: stats.dates.map(d => stats.byDate[d]),
                borderColor: '#4f5f34', backgroundColor: 'rgba(79,95,52,0.15)', fill: true, tension: 0.25
            }]
        },
        options: { ...commonOptions, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
}

function exportStatsToPDF() {
    const stats = computeAttendanceStats();
    if (stats.totalRegistros === 0) { showToast('No hay registros para exportar todavía', 'warning'); return; }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const marginX = 40;
    const pageHeight = doc.internal.pageSize.getHeight();
    let y = 50;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(52, 64, 31);
    doc.text('Resumen Estadístico de Asistencia Docente', marginX, y);
    y += 20;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(111, 109, 100);
    doc.text(`Generado el ${new Date().toLocaleString('es-AR')}`, marginX, y);
    y += 24;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(40, 40, 40);
    const lines = [
        `Total de movimientos registrados: ${stats.totalRegistros}`,
        `Total de entradas: ${stats.totalEntries}  (Presentes: ${stats.presentCount} · Tardanzas: ${stats.lateCount})`,
        `Puntualidad general: ${stats.punctuality}%`,
        `Docente con más registros: ${stats.topTeacher ? stats.topTeacher.name + ' (' + (stats.topTeacher.present + stats.topTeacher.late) + ')' : '—'}`,
        `Alertas sin justificar: ${stats.unjustifiedAlerts}`,
        `Salidas antes de tiempo: ${stats.earlyExitCount}`,
    ];
    lines.forEach(line => { doc.text(line, marginX, y); y += 16; });
    y += 12;

    const addChartImage = (canvasId, title) => {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const imgWidth = 500;
        const imgHeight = (canvas.height / canvas.width) * imgWidth;
        if (y + 20 + imgHeight > pageHeight - 40) { doc.addPage(); y = 50; }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(52, 64, 31);
        doc.text(title, marginX, y);
        y += 14;
        doc.addImage(canvas.toDataURL('image/png', 1.0), 'PNG', marginX, y, imgWidth, imgHeight);
        y += imgHeight + 24;
    };

    addChartImage('chartPie', 'Distribución de Registros');
    addChartImage('chartBar', 'Presentes y Tardanzas por Docente');
    addChartImage('chartLine', 'Evolución de Registros por Día');

    doc.save(`resumen_estadisticas_${new Date().toISOString().split('T')[0]}.pdf`);
    showToast('✅ Resumen exportado a PDF', 'success');
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast-custom ${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️';
    toast.innerHTML = `${icon} ${message}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.5s ease';
        setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 500);
    }, 4000);
}

// ============================================================
// INICIALIZACIÓN
// ============================================================
document.addEventListener('DOMContentLoaded', async function() {
    loadFaceApiModels();
    await loadAllData();
    const criteria = getCriteria();
    saveCriteriaToStorage(criteria);
    checkFaltas();
    setInterval(checkFaltas, 5 * 60 * 1000);
    flushPendingSync(); // por si quedaron cambios sin subir de una sesión offline anterior
    showToast('Sistema iniciado', 'info');
});
