// ============================================================
// ASIS_CAM - Sistema de Control de Asistencia Docente
// script.js - Lógica de la aplicación (cliente)
//
// Este archivo concentra toda la lógica de negocio del lado del
// cliente: persistencia (Supabase + localStorage + sincronización
// diferida offline-first), reconocimiento facial (face-api.js) con
// modelos autohospedados en /models, geocerca obligatoria y
// kioscos, fichaje de asistencia, licencias, eventos especiales,
// alertas, estadísticas y registro del service worker (sw.js).
//
// index.html lo carga con <script src="script.js"></script> (script
// clásico, no ES module) para que las funciones sigan expuestas en
// window: buena parte del HTML dispara acciones con atributos
// onclick=/onchange= que necesitan encontrarlas ahí.
// ============================================================

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
    MIN_HOURS: 4,
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
    // Antes apuntaba al CDN de face-api.js (jsdelivr). Se copiaron los 7
    // archivos de pesos a /models dentro del propio repo para que el
    // service worker (sw.js) pueda precachearlos en la instalación y el
    // reconocimiento facial funcione sin conexión (modo avión) después de
    // la primera visita, sin depender de que el CDN esté disponible.
    FACE_MODELS_URL: 'models'
};

// Confianza mínima (%) para aceptar una identificación y disparar el
// fichaje obligatorio. face-api.js no da un "% de confianza" nativo,
// solo una distancia euclidiana entre descriptores, así que la
// convertimos a una escala 0-100 calibrada contra CONFIG.FACE_MATCH_THRESHOLD:
// distancia 0 (coincidencia perfecta) = 100%, distancia = umbral = 85%
// (el piso mínimo aceptado). Con esta calibración, "isMatch" y
// "confidence >= 85" son equivalentes por construcción.
const FACE_CONFIDENCE_MIN_MATCH = 85;
function computeFaceConfidence(distance) {
    const t = CONFIG.FACE_MATCH_THRESHOLD;
    return Math.max(0, Math.round((1 - (distance / t) * 0.15) * 100));
}

// ============================================================
// GEOCERCA OBLIGATORIA DE FICHAJE (config dinámica compartida)
// El docente solo puede fichar (reconocimiento facial) estando
// dentro del radio configurado alrededor del punto activo. La
// config (lat/lng/radio/nombreLugar), el kiosco autorizado y el
// modo prueba viven en app_data de Supabase (mismo mecanismo que
// teachers/attendance/alerts) — NO hay Firestore en este proyecto
// (solo Firebase Hosting para servir el sitio), así que se usa el
// backend real de la app en vez de uno inexistente. Los getters/
// setters (getGeofenceConfig, getModoPrueba, getKioskPrincipal,
// getKioskCodes y sus saveXToStorage) están más abajo, junto a
// getCriteria()/saveCriteriaToStorage() con el mismo patrón.
//
// Se verifica en dos puntos del mismo flujo: al arrancar
// detectFace() (antes de gastar tiempo en cámara/reconocimiento) y
// de nuevo justo antes de confirmar Ingreso/Salida en el modal
// obligatorio (por si se movió entre medio, o si alguien intenta
// forzar el registro desde la consola). El fichaje MANUAL del
// administrador (registerManualAttendance) queda exento a
// propósito: es la vía para cuando cámara/GPS/geocerca del docente
// no sirve.
// ============================================================
const DEFAULT_GEOFENCE_CONFIG = { lat: -27.747601, lng: -55.888582, radio: 150, nombreLugar: 'Colegio Secundario De San Carlos', actualizadoPor: 'sistema', actualizadoEn: null };

// Distancia en metros entre dos coordenadas (fórmula de Haversine).
function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function getCurrentPositionPromise(timeoutMs) {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) { reject({ code: 'unsupported' }); return; }
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: timeoutMs || 15000 });
    });
}

// Id único de ESTE navegador/dispositivo (no del usuario: sirve
// para reconocer "esta es la PC de preceptoría" sin login especial).
function getMyDeviceId() {
    let id = localStorage.getItem('my_device_id');
    if (!id) {
        id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('dev_' + Date.now() + '_' + Math.random().toString(36).slice(2));
        localStorage.setItem('my_device_id', id);
    }
    return id;
}

function isThisDeviceKiosk() {
    const kiosk = getKioskPrincipal();
    return !!(kiosk && kiosk.deviceId === getMyDeviceId());
}

// Devuelve {ok:true, ...} si puede fichar, o {ok:false, reason:
// 'gps'|'geofence', distance} si no. El orden de las excepciones
// importa: modo prueba y admin cubren TODO sin pedir GPS siquiera;
// el kiosco autorizado también lo saltea. Recién si ninguna
// excepción aplica se pide ubicación real y se mide contra
// getGeofenceConfig(). Nunca tira excepción: cualquier falla de
// geolocalización se traduce en reason:'gps'.
// Trae el valor MÁS RECIENTE de una clave de app_data directo de
// Supabase (no el que quedó cacheado en memoria desde que se abrió
// la página). Es la pieza que faltaba: sin esto, un docente que ya
// tenía la pestaña abierta (o recién logueado, si loadAllData()
// corrió antes de que el admin guardara el cambio) seguía validando
// contra el punto/kiosco/modo-prueba viejo hasta recargar. Si falla
// la consulta (sin conexión), se degrada a la última copia conocida
// en vez de romper el fichaje.
//
// IMPORTANTE: si esta clave todavía está pendiente de sincronizar
// (ver sb_pending_sync / markPendingSync), NO hay que pisarla con lo
// que devuelva Supabase: por definición, lo que hay en Supabase en
// ese momento es viejo (el guardado local todavía no se subió, por
// ejemplo por wifi inestable en el momento en que el admin guardó).
// Sobrescribir acá dataStore/localStorage con ese valor viejo perdía
// para siempre el cambio recién guardado -y encima confundía al
// reintento automático, que termina resubiendo el valor viejo porque
// ya no encuentra el nuevo en dataStore-. Bug real reportado: el
// admin cambiaba la ubicación de la geocerca, y el docente seguía
// viendo la ubicación anterior (Colegio Secundario De San Carlos por
// defecto) hasta que alguien volvía a guardar.
async function fetchFreshAppDataValue(key, fallbackGetter) {
    if (sb && !getPendingSyncKeys().includes(key)) {
        try {
            const { data, error } = await sb.from('app_data').select('value').eq('key', key).maybeSingle();
            if (error) throw error;
            if (data && data.value !== undefined && data.value !== null) {
                dataStore[key] = data.value;
                writeLocalCache(key, data.value);
            }
        } catch (error) {
            console.error(`No se pudo refrescar "${key}" desde Supabase, se usa la última copia conocida:`, error);
        }
    }
    return fallbackGetter();
}

async function verifyGeofence() {
    const modoPrueba = await fetchFreshAppDataValue('modoPrueba', getModoPrueba);
    if (modoPrueba.activo) return { ok: true, bypass: 'modoPrueba' };
    if (currentUser && currentUser.role === 'admin') return { ok: true, bypass: 'admin' };

    const kioskPrincipal = await fetchFreshAppDataValue('kioskPrincipal', getKioskPrincipal);
    if (kioskPrincipal && kioskPrincipal.deviceId === getMyDeviceId()) return { ok: true, bypass: 'kiosk' };

    let position;
    try {
        position = await getCurrentPositionPromise(15000);
    } catch (error) {
        console.error('No se pudo obtener la ubicación GPS:', error);
        return { ok: false, reason: 'gps' };
    }
    const geofence = await fetchFreshAppDataValue('geofence', getGeofenceConfig);
    const distance = haversineDistanceMeters(position.coords.latitude, position.coords.longitude, geofence.lat, geofence.lng);
    if (distance > geofence.radio) return { ok: false, reason: 'geofence', distance };
    return { ok: true, distance };
}

// Modal informativo (no bloqueante como el de fichaje: acá el
// docente solo necesita enterarse y reintentar, así que sí tiene
// botón de cierre).
function showGeofenceBlockModal(result) {
    const title = document.getElementById('geofenceModalTitle');
    const body = document.getElementById('geofenceModalBody');
    const geofence = getGeofenceConfig();
    if (result.reason === 'gps') {
        title.innerHTML = '<i class="bi bi-geo-alt-fill"></i> GPS requerido';
        body.innerHTML = `
            <p class="mb-1"><strong>Debes activar GPS para fichar.</strong></p>
            <p class="text-muted small mb-0">Habilitá el permiso de ubicación de este sitio en tu navegador (o activá el GPS del dispositivo) e intentá de nuevo. El sitio necesita conexión HTTPS para poder pedir tu ubicación.</p>`;
    } else {
        const metros = Math.round(result.distance);
        title.innerHTML = '<i class="bi bi-geo-alt-fill"></i> Fuera de la zona permitida';
        body.innerHTML = `
            <p class="mb-1">Estás a <strong>${metros} mts</strong> de ${geofence.nombreLugar}.</p>
            <p class="mb-0">Debes estar a menos de ${geofence.radio}mts.</p>`;
    }
    new bootstrap.Modal(document.getElementById('geofenceModal')).show();
}

// ============================================================
// ADMIN > CONFIGURACIÓN > GEOCERCA (formulario) Y DISPOSITIVOS
// (kiosco autorizado)
// ============================================================
function updateGeofenceMapPreview() {
    const lat = parseFloat(document.getElementById('geofenceLat').value);
    const lng = parseFloat(document.getElementById('geofenceLng').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    document.getElementById('geofenceMapPreview').src = `https://maps.google.com/maps?q=${lat},${lng}&z=17&output=embed`;
    document.getElementById('geofenceMapLink').href = `https://www.google.com/maps?q=${lat},${lng}`;
}

function loadGeofenceAdminForm() {
    const geofence = getGeofenceConfig();
    document.getElementById('geofenceName').value = geofence.nombreLugar;
    document.getElementById('geofenceLat').value = geofence.lat;
    document.getElementById('geofenceLng').value = geofence.lng;
    document.getElementById('geofenceRadius').value = geofence.radio;
    document.getElementById('geofenceRadiusLabel').textContent = geofence.radio;
    document.getElementById('geofenceUpdatedInfo').textContent = geofence.actualizadoEn
        ? `Última actualización: ${new Date(geofence.actualizadoEn).toLocaleString()} (por ${geofence.actualizadoPor || 'desconocido'})`
        : '';
    document.getElementById('modoPruebaToggle').checked = !!getModoPrueba().activo;
    updateGeofenceMapPreview();
}

function saveGeofenceAdminForm() {
    const lat = parseFloat(document.getElementById('geofenceLat').value);
    const lng = parseFloat(document.getElementById('geofenceLng').value);
    const radio = parseInt(document.getElementById('geofenceRadius').value, 10);
    const nombreLugar = document.getElementById('geofenceName').value.trim() || DEFAULT_GEOFENCE_CONFIG.nombreLugar;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { showToast('Latitud y longitud deben ser números válidos', 'error'); return; }
    if (!Number.isFinite(radio) || radio < 50 || radio > 500) { showToast('El radio debe estar entre 50 y 500 metros', 'error'); return; }
    saveGeofenceConfig({
        lat, lng, radio, nombreLugar,
        actualizadoPor: currentUser ? (currentUser.username || currentUser.dni || 'admin') : 'admin',
        actualizadoEn: new Date().toISOString(),
    });
    loadGeofenceAdminForm();
    showToast('✅ Ubicación de fichaje guardada', 'success');
}

function resetGeofenceAdminForm() {
    saveGeofenceConfig({
        ...DEFAULT_GEOFENCE_CONFIG,
        actualizadoPor: currentUser ? (currentUser.username || currentUser.dni || 'admin') : 'admin',
        actualizadoEn: new Date().toISOString(),
    });
    loadGeofenceAdminForm();
    showToast('Ubicación restablecida al Colegio Secundario De San Carlos', 'info');
}

// Atajo para cargar rápido la ubicación real (parado en la escuela,
// o en la plaza/salón de un acto) sin tener que buscar coordenadas.
function useCurrentLocationForGeofence() {
    if (!navigator.geolocation) { showToast('Este navegador no soporta geolocalización', 'error'); return; }
    showToast('Obteniendo tu ubicación actual...', 'info');
    navigator.geolocation.getCurrentPosition(
        pos => {
            document.getElementById('geofenceLat').value = pos.coords.latitude;
            document.getElementById('geofenceLng').value = pos.coords.longitude;
            updateGeofenceMapPreview();
            showToast('✅ Ubicación actual cargada en el formulario. Revisá y guardá.', 'success');
        },
        error => {
            console.error('No se pudo obtener la ubicación actual:', error);
            showToast('No se pudo obtener tu ubicación actual', 'error');
        },
        { enableHighAccuracy: true, timeout: 15000 }
    );
}

function toggleModoPrueba(activo) {
    saveModoPruebaToStorage({ activo });
    showToast(activo ? '⚠️ Modo Prueba activado: la geocerca queda desactivada para todos' : 'Modo Prueba desactivado', activo ? 'warning' : 'info');
    renderFichajeContextBadges();
}

// ===== Dispositivos / kiosco =====
function formatKioskDeviceId(id) { return id ? (id.length > 12 ? id.slice(0, 8) + '…' + id.slice(-4) : id) : '-'; }

function loadKioskAdminPanel() {
    const kiosk = getKioskPrincipal();
    const info = document.getElementById('kioskAdminInfo');
    if (!kiosk) {
        info.innerHTML = '<span class="badge bg-secondary">Sin PC autorizada como kiosco</span>';
    } else {
        info.innerHTML = `
            <p class="mb-1"><span class="badge bg-success">Kiosco autorizado</span> ${kiosk.nombreLugar || ''}</p>
            <p class="mb-1 small text-muted">Dispositivo: <code>${formatKioskDeviceId(kiosk.deviceId)}</code>${kiosk.deviceId === getMyDeviceId() ? ' <strong>(esta PC)</strong>' : ''}</p>
            <p class="mb-0 small text-muted">Autorizado el ${kiosk.authorizedAt ? new Date(kiosk.authorizedAt).toLocaleString() : '-'} por ${kiosk.authorizedBy || '-'}</p>
        `;
    }
    // Limpia códigos vencidos de la vista (no hace falta guardarlo:
    // se re-filtran solos la próxima vez que alguien intente usarlos).
    const vigente = getKioskCodes().find(c => new Date(c.expiresAt) > new Date());
    document.getElementById('kioskCodeDisplay').innerHTML = vigente
        ? `<div class="alert alert-info mb-0"><i class="bi bi-key"></i> Código vigente: <strong style="font-size:1.4rem;letter-spacing:3px;">${vigente.code}</strong> — válido hasta ${new Date(vigente.expiresAt).toLocaleTimeString()}</div>`
        : '';
}

function generateKioskCode() {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    saveKioskCodes([{ code, expiresAt }]);
    loadKioskAdminPanel();
    showToast(`✅ Código generado: ${code} (válido 10 minutos)`, 'success');
}

function deauthorizeKiosk() {
    if (!confirm('¿Desautorizar la PC actualmente configurada como kiosco? Va a necesitar geocerca para fichar hasta que se autorice otra.')) return;
    saveKioskPrincipal(null);
    loadKioskAdminPanel();
    showToast('Kiosco desautorizado', 'info');
}

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
// Cuando no es null, el formulario de "Registrar Nuevo Docente" está
// en modo edición: saveTeacher() actualiza a este docente en vez de
// crear uno nuevo. Ver editTeacher() / cancelEditTeacher().
let editingTeacherId = null;
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

const DATA_KEYS = ['teachers', 'attendance', 'alerts', 'licencias', 'criteria', 'geofence', 'modoPrueba', 'kioskPrincipal', 'kioskCodes'];
const DATA_DEFAULTS = { teachers: [], attendance: [], alerts: [], licencias: [], criteria: {}, geofence: null, modoPrueba: { activo: false }, kioskPrincipal: null, kioskCodes: [] };
let dataStore = { teachers: [], attendance: [], alerts: [], licencias: [], criteria: {}, geofence: null, modoPrueba: { activo: false }, kioskPrincipal: null, kioskCodes: [] };
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
        const pending = getPendingSyncKeys();
        DATA_KEYS.forEach(key => {
            // Si esta clave tiene un guardado local todavía sin subir, ese
            // guardado es más nuevo que lo que hay en Supabase por
            // definición: se mantiene la copia local en vez de pisarla con
            // el valor viejo del servidor (mismo motivo que en
            // fetchFreshAppDataValue). flushPendingSync() se encarga de
            // subirla apenas haya conexión.
            if (pending.includes(key)) {
                dataStore[key] = readLocalCache(key);
                return;
            }
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
        minAttendance: criteria.minAttendance || CONFIG.MIN_ATTENDANCE,
        minHours: criteria.minHours || CONFIG.MIN_HOURS
    };
}
function saveCriteriaToStorage(criteria) { dataStore.criteria = criteria; persistToSupabase('criteria', criteria); }

// ===== Geocerca / kiosco / modo prueba: mismo patrón getX/saveXToStorage =====
function getGeofenceConfig() { return dataStore.geofence || DEFAULT_GEOFENCE_CONFIG; }
function saveGeofenceConfig(config) { dataStore.geofence = config; persistToSupabase('geofence', config); }

// Si nadie configuró la geocerca todavía (primera vez que corre la
// app contra este Supabase), la crea con los datos base — pedido
// explícito: "si no existe, creala con datos base".
function ensureGeofenceConfig() {
    if (!dataStore.geofence) {
        saveGeofenceConfig({ ...DEFAULT_GEOFENCE_CONFIG, actualizadoEn: new Date().toISOString() });
    }
}

function getModoPrueba() { return (dataStore.modoPrueba && typeof dataStore.modoPrueba.activo === 'boolean') ? dataStore.modoPrueba : { activo: false }; }
function saveModoPruebaToStorage(modoPrueba) { dataStore.modoPrueba = modoPrueba; persistToSupabase('modoPrueba', modoPrueba); }

function getKioskPrincipal() { return dataStore.kioskPrincipal || null; }
function saveKioskPrincipal(kiosk) { dataStore.kioskPrincipal = kiosk; persistToSupabase('kioskPrincipal', kiosk); }

function getKioskCodes() { return Array.isArray(dataStore.kioskCodes) ? dataStore.kioskCodes : []; }
function saveKioskCodes(codes) { dataStore.kioskCodes = codes; persistToSupabase('kioskCodes', codes); }

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

// Botoncito verde de WhatsApp para poner al lado de un nombre de docente.
// Si no tiene teléfono cargado, no se muestra nada (en vez de un botón roto).
function renderWhatsAppButton(telefono, nombre, mensaje) {
    const texto = mensaje || `Hola ${nombre}`;
    const link = buildWhatsAppLink(telefono, texto);
    if (!link) return '';
    return `<a href="${link}" target="_blank" class="btn btn-sm btn-whatsapp" title="Enviar WhatsApp a ${nombre}"><i class="bi bi-whatsapp"></i></a>`;
}

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
    editingTeacherId = null;
    document.getElementById('regFormTitle').innerHTML = '<i class="bi bi-person-plus"></i> Registrar Nuevo Docente';
    document.getElementById('saveTeacherBtn').innerHTML = '<i class="bi bi-save"></i> Guardar Docente';
    document.getElementById('cancelEditTeacherBtn').classList.add('hidden');
    document.getElementById('regExistingPhotoWrap').classList.add('hidden');
    document.getElementById('regExistingPhoto').src = '';
    document.getElementById('regApellido').value = '';
    document.getElementById('regNombre').value = '';
    document.getElementById('regDni').value = '';
    document.getElementById('regTelefono').value = '';
    document.getElementById('regTelefonoFamiliar').value = '';
    document.getElementById('regEmail').value = '';
    document.getElementById('regDireccion').value = '';
    document.getElementById('regPassword').value = CONFIG.DEFAULT_PASSWORD;
    resetHorarioLaboralForm();
    capturedPhotos = [];
    capturedDescriptors = [];
    renderCaptureThumbs();
    updateCaptureStatusUI();
    showToast('Formulario limpiado', 'info');
}

// Carga los datos de un docente existente en el formulario de alta
// para editarlo. No fuerza a recapturar biometría: si el admin no
// toma fotos nuevas, saveTeacher() conserva la foto y el descriptor
// facial actuales (ver más abajo).
function editTeacher(id) {
    const teacher = getTeachers().find(t => t.id === id);
    if (!teacher) { showToast('Docente no encontrado', 'error'); return; }
    editingTeacherId = id;
    document.getElementById('regFormTitle').innerHTML = '<i class="bi bi-pencil-square"></i> Editar Docente';
    document.getElementById('saveTeacherBtn').innerHTML = '<i class="bi bi-save"></i> Guardar Cambios';
    document.getElementById('cancelEditTeacherBtn').classList.remove('hidden');

    document.getElementById('regApellido').value = teacher.apellido || '';
    document.getElementById('regNombre').value = teacher.nombre || '';
    document.getElementById('regDni').value = teacher.dni || '';
    document.getElementById('regTelefono').value = teacher.telefono || '';
    document.getElementById('regTelefonoFamiliar').value = teacher.telefonoFamiliar || '';
    document.getElementById('regEmail').value = teacher.email || '';
    document.getElementById('regDireccion').value = teacher.direccion || '';
    document.getElementById('regPassword').value = teacher.password || CONFIG.DEFAULT_PASSWORD;

    horarioLaboralList = getHorarioLaboral(teacher).slice();
    renderHorarioLaboralChips();

    capturedPhotos = [];
    capturedDescriptors = [];
    renderCaptureThumbs();
    updateCaptureStatusUI();

    const photoWrap = document.getElementById('regExistingPhotoWrap');
    if (teacher.photo) {
        document.getElementById('regExistingPhoto').src = teacher.photo;
        photoWrap.classList.remove('hidden');
    } else {
        photoWrap.classList.add('hidden');
    }

    showToast(`Editando a ${teacher.apellido} ${teacher.nombre}`, 'info');
    document.getElementById('regFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditTeacher() {
    clearRegistrationForm();
}

function saveTeacher() {
    const apellido = document.getElementById('regApellido').value.trim();
    const nombre = document.getElementById('regNombre').value.trim();
    const dni = document.getElementById('regDni').value.trim();
    const telefono = document.getElementById('regTelefono').value.trim();
    const telefonoFamiliar = document.getElementById('regTelefonoFamiliar').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const direccion = document.getElementById('regDireccion').value.trim();
    const password = document.getElementById('regPassword').value.trim() || CONFIG.DEFAULT_PASSWORD;

    if (!apellido) { showToast('El apellido es obligatorio', 'error'); return; }
    if (!nombre) { showToast('El nombre es obligatorio', 'error'); return; }
    if (!dni) { showToast('El DNI es obligatorio', 'error'); return; }
    if (!telefono) { showToast('El teléfono personal es obligatorio', 'error'); return; }
    if (!telefonoFamiliar) { showToast('El teléfono de contacto familiar es obligatorio', 'error'); return; }
    if (!email) { showToast('El e-mail es obligatorio', 'error'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('El e-mail no tiene un formato válido', 'error'); return; }
    if (horarioLaboralList.length === 0) { showToast('Agregá al menos un horario', 'error'); return; }

    const teachers = getTeachers();
    if (teachers.some(t => t.dni === dni && t.id !== editingTeacherId)) {
        showToast('Ya existe un docente con el DNI ' + dni, 'error');
        return;
    }

    let photo, faceDescriptor;
    if (editingTeacherId) {
        // Editando: si no se capturaron fotos nuevas, se conserva la
        // biometría actual. Si se capturaron algunas pero no las 3
        // requeridas, se pide completar en vez de guardar a medias.
        const original = teachers.find(t => t.id === editingTeacherId);
        if (!original) { showToast('El docente ya no existe', 'error'); return; }
        if (capturedDescriptors.length === 0) {
            photo = original.photo;
            faceDescriptor = original.faceDescriptor;
        } else if (capturedDescriptors.length < CONFIG.MIN_CAPTURES) {
            showToast(`Capturaste ${capturedDescriptors.length} foto(s) nueva(s). Completá las ${CONFIG.MIN_CAPTURES} para actualizar la biometría, o "Limpiar" para conservar la actual.`, 'error');
            return;
        } else {
            photo = capturedPhotos[0];
            faceDescriptor = averageDescriptors(capturedDescriptors);
        }
    } else {
        if (capturedDescriptors.length < CONFIG.MIN_CAPTURES) {
            showToast(`Necesitás ${CONFIG.MIN_CAPTURES} fotos válidas para el registro facial (llevás ${capturedDescriptors.length})`, 'error');
            return;
        }
        photo = capturedPhotos[0];
        faceDescriptor = averageDescriptors(capturedDescriptors);
    }

    if (editingTeacherId) {
        const idx = teachers.findIndex(t => t.id === editingTeacherId);
        teachers[idx] = {
            ...teachers[idx],
            apellido, nombre, dni, telefono, telefonoFamiliar, email, direccion,
            horario_laboral: horarioLaboralList,
            photo, faceDescriptor, password,
        };
        saveTeachers(teachers);
        showToast(`✅ Docente actualizado`, 'success');
    } else {
        const newTeacher = {
            id: Date.now().toString(),
            apellido, nombre, dni, telefono, telefonoFamiliar, email, direccion,
            materia: '', horario_laboral: horarioLaboralList,
            photo, faceDescriptor,
            password, createdAt: new Date().toISOString(), active: true
        };
        teachers.push(newTeacher);
        saveTeachers(teachers);
        showToast(`✅ Docente registrado. Usuario: ${dni}, Contraseña: ${password}`, 'success');
    }

    clearRegistrationForm();
    loadTeachersTable();
    updateStats();
    loadReportTeachers();
    populateTeacherSelect();
}

// ============================================================
// ADMIN - DASHBOARD
// ============================================================
async function loadAdminDashboard() {
    await loadEventoConvocatoriasPorDocente();
    checkFaltas();
    checkFaltasEvento();
    loadTeachersTable();
    loadAlerts();
    updateStats();
    loadReportTeachers();
    loadCriteria();
    loadGeofenceAdminForm();
    loadKioskAdminPanel();
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
                <td>${teacher.apellido} ${teacher.nombre} ${renderWhatsAppButton(teacher.telefono, teacher.nombre)} <button class="btn btn-sm btn-primary" title="Editar docente" onclick="editTeacher('${teacher.id}')"><i class="bi bi-pencil"></i></button></td>
                <td>${teacher.telefono || '-'}</td>
                <td>${teacher.materia}</td>
                <td><small>${scheduleDisplay}</small></td>
                <td><span class="badge bg-info">${teacher.password}</span></td>
                <td>${bioBadge}</td>
                <td>${status}</td>
                <td>
                    <button class="btn btn-sm btn-primary" title="Ficha / Reporte individual" onclick="showTeacherDetail('${teacher.id}')"><i class="bi bi-search"></i></button>
                    <button class="btn btn-sm btn-info" title="Calendario ${SCHEDULE_CALENDAR_YEAR}" onclick="showTeacherCalendar('${teacher.id}')"><i class="bi bi-calendar3"></i></button>
                    <button class="btn btn-sm btn-warning" title="Fichaje manual" onclick="openManualAttendanceModal('${teacher.id}')"><i class="bi bi-fingerprint"></i></button>
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

function loadAlerts() {
    // Más reciente arriba, más antigua abajo.
    const alerts = getAlerts().slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const container = document.getElementById('alertsList');
    if (alerts.length === 0) { container.innerHTML = '<p class="text-muted">No hay alertas pendientes</p>'; return; }
    container.innerHTML = alerts.map((alert) => {
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

        return `
            <div class="alert-card ${isJustified && !isDenied ? 'justified' : ''}">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <strong>${alert.teacherName}</strong>
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

function updateAlertCount() {
    const alerts = getAlerts();
    document.getElementById('alertCount').textContent = alerts.filter(a => !a.justified).length;
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

function dismissAlert(id) {
    if (!confirm('¿Eliminar esta alerta? Esta acción no se puede deshacer.')) return;
    const alerts = getAlerts().filter(a => a.id !== id);
    saveAlerts(alerts);
    loadAlerts();
    showToast('Alerta eliminada', 'info');
}

function loadCriteria() {
    const criteria = getCriteria();
    document.getElementById('lateLimit').value = criteria.lateLimit;
    document.getElementById('minAttendance').value = criteria.minAttendance;
    document.getElementById('minHours').value = criteria.minHours;
}

function saveCriteria() {
    const criteria = {
        lateLimit: parseInt(document.getElementById('lateLimit').value) || 15,
        minAttendance: parseInt(document.getElementById('minAttendance').value) || 80,
        minHours: parseInt(document.getElementById('minHours').value) || 4
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
            const categoriaTag = r.categoria === 'evento' ? ` [EVENTO: ${r.eventoTitulo || r.eventoId}]` : '';
            report += `  - ${r.date} ${r.time} | ${typeMap[r.type] || r.type}${categoriaTag} | ${r.status}\n`;
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
    renderFichajeContextBadges();
}

// Indicadores de la "pantalla de fichaje": punto activo, si esta PC
// es el kiosco autorizado, y si el Modo Prueba está encendido (en
// cuyo caso nadie necesita geocerca, ni siquiera GPS). También
// muestra/oculta el link para autorizar esta PC como kiosco.
function renderFichajeContextBadges() {
    const el = document.getElementById('fichajeContextBadges');
    if (!el) return;
    const geofence = getGeofenceConfig();
    const modoPrueba = getModoPrueba();
    const esKiosco = isThisDeviceKiosk();

    let html = `<div class="mb-1"><i class="bi bi-geo-alt"></i> Evento actual: <strong>${geofence.nombreLugar}</strong></div>`;
    html += `<div class="mb-1">Tu kiosco: ${esKiosco ? '<span class="badge bg-success">SI</span>' : '<span class="badge bg-secondary">NO</span>'}</div>`;
    html += `<div class="mb-1">Modo prueba: ${modoPrueba.activo ? '<span class="badge bg-danger">ON</span>' : '<span class="badge bg-secondary">OFF</span>'}</div>`;
    if (modoPrueba.activo) {
        html += `<div class="alert alert-danger py-1 px-2 small mb-1"><i class="bi bi-exclamation-triangle-fill"></i> MODO PRUEBA ACTIVO — la geocerca está desactivada para todos.</div>`;
    }
    if (esKiosco) {
        html += `<div class="alert alert-success py-1 px-2 small mb-1"><i class="bi bi-pc-display"></i> KIOSCO AUTORIZADO - ${geofence.nombreLugar}</div>`;
    }
    if (currentUser && currentUser.role === 'admin') {
        html += `<div class="alert alert-warning py-1 px-2 small mb-1"><i class="bi bi-person-badge"></i> MODO PRUEBA ADMIN - Geocerca desactivada para tu usuario</div>`;
    }
    el.innerHTML = html;

    const wrap = document.getElementById('kioskAuthorizeWrap');
    if (wrap) wrap.classList.toggle('hidden', esKiosco);
}

function toggleKioskAuthorizeForm() {
    document.getElementById('kioskAuthorizeForm').classList.toggle('hidden');
}

// Valida el código de 6 dígitos contra kioskCodes (o "0000" si
// todavía no hay ningún kiosco configurado: primera instalación) y,
// si es válido, autoriza ESTE dispositivo como kiosco principal.
function submitKioskAuthorizeCode() {
    const input = document.getElementById('kioskAuthorizeCodeInput');
    const code = (input.value || '').trim();
    if (!code) { showToast('Ingresá el código', 'warning'); return; }

    const kioskActual = getKioskPrincipal();
    const esPrimeraInstalacion = !kioskActual;
    let valido = false;
    let codeToConsume = null;

    if (esPrimeraInstalacion && code === '0000') {
        valido = true;
    } else {
        const vigente = getKioskCodes().find(c => c.code === code && new Date(c.expiresAt) > new Date());
        if (vigente) { valido = true; codeToConsume = vigente; }
    }

    if (!valido) { showToast('❌ Código inválido o vencido', 'error'); return; }

    const geofence = getGeofenceConfig();
    saveKioskPrincipal({
        deviceId: getMyDeviceId(),
        authorizedAt: new Date().toISOString(),
        authorizedBy: currentUser ? (currentUser.username || currentUser.dni || 'docente') : 'desconocido',
        nombreLugar: geofence.nombreLugar,
    });
    if (codeToConsume) saveKioskCodes(getKioskCodes().filter(c => c.code !== codeToConsume.code));

    input.value = '';
    document.getElementById('kioskAuthorizeForm').classList.add('hidden');
    showToast('✅ Esta PC quedó autorizada como kiosco', 'success');
    renderFichajeContextBadges();
}

// ¿El docente ya registró su entrada hoy? Se usa para la regla de
// "entrada única diaria": hasta que no marque entrada, Salida y
// Retirada quedan deshabilitados (no tiene sentido salir de algo a
// lo que no entró, y evita que por error se toque "Salida antes de
// tiempo" justo después de identificarse por primera vez), y una
// vez que entró, no puede volver a marcar otra entrada.
//
// categoria/eventoId permiten preguntar por la cátedra regular
// (default) o por un Evento Especial puntual, de forma
// independiente: la cátedra completa de hoy no bloquea ni habilita
// el fichaje de un evento, y viceversa (cada evento convocado tiene
// su propio estado de ingreso/salida).
function hasEntryToday(teacherId, categoria, eventoId) {
    categoria = categoria || 'regular';
    const todayStr = new Date().toISOString().split('T')[0];
    return getAttendance().some(a => a.teacherId === teacherId && a.type === 'entry' && a.date === todayStr &&
        (a.categoria || 'regular') === categoria &&
        (categoria !== 'evento' || a.eventoId === eventoId));
}

// Habilita/deshabilita los botones de Entrada/Salida/Retirada según
// si hay una identificación facial vigente y si ya registró la
// entrada de hoy, y además decide cuál de los dos botones de salida
// corresponde mostrar: "Salida" normal solo dentro de la ventana de
// horario de salida (con tolerancia), "Retirada antes de tiempo" en
// cualquier otro momento. Se requiere identificarse de nuevo antes
// de CADA registro (por seguridad, para que nadie marque por otra
// persona), así que los botones quedan visualmente apagados en vez
// de fallar en silencio con solo un toast.
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
        document.getElementById('teacherEmail').textContent = currentUser.email || '-';
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

    // Geocerca obligatoria: antes de gastar tiempo en cámara/
    // reconocimiento, hay que estar dentro del radio permitido.
    status.className = 'face-recognition-status processing';
    status.innerHTML = '<i class="bi bi-geo-alt"></i> Verificando tu ubicación...';
    const geo = await verifyGeofence();
    renderFichajeContextBadges(); // refleja al toque el punto/kiosco/modo prueba recién traídos de Supabase
    if (!geo.ok) {
        showGeofenceBlockModal(geo);
        status.className = 'face-recognition-status error';
        status.innerHTML = geo.reason === 'gps'
            ? '<i class="bi bi-geo-alt-fill"></i> Debes activar GPS para fichar.'
            : `<i class="bi bi-geo-alt-fill"></i> Estás a ${Math.round(geo.distance)} mts de la escuela. Acercate y volvé a intentar.`;
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
        const confidence = computeFaceConfidence(distance);
        const isMatch = distance <= CONFIG.FACE_MATCH_THRESHOLD && confidence >= FACE_CONFIDENCE_MIN_MATCH;
        progress.style.display = 'none';
        progressBar.style.width = '0%';
        console.log(`Distancia facial: ${distance.toFixed(3)} (umbral: ${CONFIG.FACE_MATCH_THRESHOLD}, confianza: ${confidence}%, muestras: ${samples.length}/${CONFIG.IDENTIFY_SAMPLES})`);

        if (isMatch) {
            recognizedTeacher = currentUser;
            isFaceVerified = true;
            status.className = 'face-recognition-status success';
            status.innerHTML = `<i class="bi bi-check-circle"></i> ✅ Identificado: ${currentUser.nombre} ${currentUser.apellido} (${confidence}%)<br><small>Coincidencia facial confirmada</small>`;
            showToast(`✅ Identificación exitosa (${confidence}%)`, 'success');
            // A partir de acá el fichaje es obligatorio: se congela el
            // video y se abre el modal bloqueante (no se puede cerrar
            // con X/ESC/clic afuera) hasta que el docente registre
            // Ingreso/Salida o cancele explícitamente con "No soy yo".
            openFaceAttendanceModal();
        } else {
            recognizedTeacher = null;
            isFaceVerified = false;
            status.className = 'face-recognition-status error';
            status.innerHTML = `<i class="bi bi-x-circle"></i> ❌ El rostro no coincide con el registrado (${confidence}%)<br><small>Intentá de nuevo con mejor iluminación</small>`;
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

// ============================================================
// FICHAJE OBLIGATORIO TRAS RECONOCIMIENTO FACIAL (evita "fichaje
// fantasma": identificarse y después irse sin registrar nada).
// Una vez reconocido con >=85% de confianza, el video se congela y
// se abre un modal bloqueante: no tiene botón de cierre, y se crea
// con backdrop:'static' + keyboard:false (además de los atributos
// data-bs-* del HTML) para que ni ESC ni un clic afuera lo cierren.
// Solo dos salidas posibles: registrar Ingreso/Salida, o "No soy yo
// / Cancelar". Un timeout de 60s libera la cámara si no se toca
// nada, y un listener de beforeunload avisa si intenta cerrar la
// pestaña con el fichaje todavía sin confirmar.
// ============================================================
let faceModalInstance = null;
let faceModalTimeoutHandle = null;
let faceModalPending = false; // true = reconocido pero todavía no eligió Ingreso/Salida/Cancelar

function freezeTeacherVideo(freeze) {
    const video = document.getElementById('teacherVideo');
    if (!video) return;
    if (freeze) {
        stopLiveOverlay();
        video.pause();
    } else {
        if (currentUser && currentUser.role === 'teacher') startLiveOverlay();
        video.play().catch(() => {});
    }
}

function setFaceNavLocksDisabled(disabled) {
    const header = document.getElementById('dashboardLogoutBtn');
    const camera = document.getElementById('teacherLogoutBtn');
    if (header) header.disabled = disabled;
    if (camera) camera.disabled = disabled;
}

function openFaceAttendanceModal() {
    faceModalPending = true;
    freezeTeacherVideo(true);
    setFaceNavLocksDisabled(true);
    renderFaceAttendanceModalBody();
    const el = document.getElementById('faceAttendanceModal');
    faceModalInstance = bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static', keyboard: false });
    faceModalInstance.show();
    resetFaceModalTimeout();
}

// Cátedra regular y Eventos Especiales de hoy son independientes acá
// también (mismo criterio que el Fichaje Manual del admin): la
// validación de "ya fichó" es POR EVENTO (categoria:'evento' +
// eventoId), nunca "por día" en general. Antes esta función solo
// miraba la cátedra regular, así que un docente con el día regular
// completo pero con un Evento Especial pendiente se encontraba con
// "ya completaste tu registro de hoy" sin poder fichar el evento.
function renderFaceAttendanceModalBody() {
    const teacher = recognizedTeacher;
    const body = document.getElementById('faceAttendanceModalBody');
    if (!teacher || !body) return;

    const yaEntroRegular = hasEntryToday(teacher.id);
    const yaSalioRegular = hasExitToday(teacher.id);
    const regularCompleta = yaEntroRegular && yaSalioRegular;

    const eventosHoy = getEventosDeHoyParaDocente(teacher.id);
    const eventosPendientes = eventosHoy.filter(ev =>
        !(hasEntryToday(teacher.id, 'evento', ev.id_evento) && hasExitToday(teacher.id, 'evento', ev.id_evento))
    );

    if (regularCompleta && eventosPendientes.length === 0) {
        body.innerHTML = `
            <h4>Hola ${teacher.nombre}!</h4>
            <p class="text-muted">Ya completaste tu registro de hoy${eventosHoy.length > 0 ? ' (cátedra y eventos especiales)' : ' (ingreso y salida)'}.</p>
            <button class="btn btn-secondary mt-2" onclick="cancelFaceAttendanceModal()">Cerrar</button>
        `;
        return;
    }

    let html = `<h4 class="mb-1">Hola ${teacher.nombre}! 👋</h4><p class="text-muted mb-3">¿Qué deseas registrar?</p>`;

    if (!regularCompleta) {
        const exitInfo = getExitWindowInfo(teacher);
        const exitType = exitInfo.isExitTime ? 'exit' : 'early_exit';
        html += `<div class="d-flex flex-column gap-2 mb-2">
            ${!yaEntroRegular ? `<button class="btn btn-entry btn-lg" onclick="confirmFaceAttendance('entry')"><i class="bi bi-box-arrow-in-right"></i> REGISTRAR INGRESO</button>` : ''}
            ${yaEntroRegular && !yaSalioRegular ? `<button class="btn btn-exit btn-lg" onclick="confirmFaceAttendance('${exitType}')"><i class="bi bi-box-arrow-left"></i> REGISTRAR SALIDA</button>` : ''}
        </div>`;
    }

    if (eventosPendientes.length > 0) {
        html += `<p class="mb-1 small text-muted text-start"><strong><i class="bi bi-calendar-event"></i> Eventos especiales de hoy</strong></p>`;
        html += eventosPendientes.map(ev => {
            // Mismo criterio que la cátedra regular: el botón ya pide
            // el tipo correcto ('exit' o 'early_exit') según la hora
            // real contra la hora de salida DEL EVENTO, para que
            // registerFaceEventoAttendance() dispare la alerta de
            // Salida Anticipada exactamente igual que en cátedra.
            const evExitInfo = getEventoExitInfo(ev);
            const evExitType = evExitInfo.isExitTime ? 'exit' : 'early_exit';
            return `
            <div class="border rounded p-2 mb-2 text-start">
                <p class="mb-1"><strong>${ev.titulo}</strong> <small class="text-muted">(${(ev.hora_entrada || '').slice(0, 5)} - ${(ev.hora_salida || '').slice(0, 5)})</small></p>
                ${buildFichajeManualBlock(teacher, 'evento', ev.id_evento, `'evento', ${ev.id_evento}`, 'confirmFaceAttendance', { entrada: 'REGISTRAR INGRESO A EVENTO', salida: 'REGISTRAR SALIDA DE EVENTO' }, evExitType)}
            </div>`;
        }).join('');
    }

    html += `<div class="mt-3"><button class="btn btn-link btn-sm text-muted" onclick="cancelFaceAttendanceModal()">No soy yo / Cancelar</button></div>`;
    body.innerHTML = html;
}

// Registra la asistencia a UN Evento Especial puntual (independiente
// de la cátedra regular): usa categoria:'evento' + eventoId, así que
// hasEntryToday/hasExitToday lo tratan como una franja separada del
// día regular. No pasa por registerAttendance() porque esa función
// está atada a la ventana de salida de la cátedra (isExitTime), que
// no aplica a un evento con su propio horario.
// Igual que getExitWindowInfo(teacher), pero contra el horario del
// EVENTO (hora_salida) en vez del horario habitual del docente. Se
// reutiliza la misma tolerancia (CONFIG.EXIT_TOLERANCE_MINUTES) para
// que "salida a tiempo" vs "salida anticipada" se calcule con el
// mismo criterio en ambas categorías.
function getEventoExitInfo(eventoInfo) {
    const scheduledEnd = (eventoInfo.hora_salida || '').slice(0, 5) || null;
    if (!scheduledEnd) return { isExitTime: false, scheduledEnd: null };
    const [endH, endM] = scheduledEnd.split(':').map(Number);
    const scheduledMinutes = endH * 60 + endM;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const tolerance = CONFIG.EXIT_TOLERANCE_MINUTES;
    return { isExitTime: nowMinutes >= (scheduledMinutes - tolerance), scheduledEnd };
}

function registerFaceEventoAttendance(type, teacher, eventoInfo) {
    const yaEntro = hasEntryToday(teacher.id, 'evento', eventoInfo.id_evento);
    const yaSalio = hasExitToday(teacher.id, 'evento', eventoInfo.id_evento);
    if (type === 'entry' && yaEntro) { showToast('⚠️ Ya registraste tu ingreso a este evento.', 'warning'); return false; }
    if ((type === 'exit' || type === 'early_exit') && (!yaEntro || yaSalio)) { showToast('⚠️ Todavía no registraste tu ingreso a este evento.', 'warning'); return false; }

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];
    let attStatus = 'present';

    if (type === 'entry') {
        const earliestStart = (eventoInfo.hora_entrada || '').slice(0, 5) || null;
        if (earliestStart) {
            const criteria = getCriteria();
            const lateLimit = criteria.lateLimit || 15;
            const [startH, startM] = earliestStart.split(':').map(Number);
            const scheduledMinutes = startH * 60 + startM;
            const nowMinutes = now.getHours() * 60 + now.getMinutes();
            if (nowMinutes > scheduledMinutes + lateLimit) {
                attStatus = 'late';
                createAlert(teacher, 'Tardanza Evento', `Llegó tarde al evento "${eventoInfo.titulo}" (${time}). Hora prevista: ${earliestStart}.`);
            }
        }
    }

    // Misma lógica que registerAttendance() con la cátedra regular:
    // no confiar en qué botón quedó visible en la UI, recalcular acá
    // con la hora real. Si pide "exit" pero todavía no es la hora de
    // salida del evento, se rechaza; si es "early_exit", se genera
    // la misma alerta "Salida Anticipada" que en cátedra regular.
    if (type === 'exit') {
        const evExitInfo = getEventoExitInfo(eventoInfo);
        if (!evExitInfo.isExitTime) {
            showToast('⚠️ Todavía no es la hora de salida del evento. Usá "Salir antes de tiempo".', 'warning');
            return false;
        }
    }
    let salidaAnticipada = false;
    if (type === 'early_exit') {
        salidaAnticipada = true;
        const evExitInfo = getEventoExitInfo(eventoInfo);
        const horarioTexto = evExitInfo.scheduledEnd ? `hasta las ${evExitInfo.scheduledEnd}` : 'sin horario de salida cargado';
        createAlert(teacher, 'Salida Anticipada', `Salida anticipada del evento "${eventoInfo.titulo}" - ${teacher.apellido} ${teacher.nombre} - ${time} - Horario que correspondía: ${horarioTexto}`);
        showToast('⚠️ Salida anticipada del evento registrada — queda pendiente de justificación', 'warning');
    }

    const attendance = getAttendance();
    attendance.push({
        id: Date.now().toString(),
        teacherId: teacher.id,
        teacherName: `${teacher.apellido} ${teacher.nombre}`,
        date, time, type, status: attStatus, timestamp: now.toISOString(),
        categoria: 'evento',
        eventoId: eventoInfo.id_evento,
        eventoTitulo: eventoInfo.titulo,
        eventoHoraEntrada: (eventoInfo.hora_entrada || '').slice(0, 5),
        eventoHoraSalida: (eventoInfo.hora_salida || '').slice(0, 5),
        salidaAnticipada,
    });
    saveAttendance(attendance);

    if (document.getElementById('adminDashboard').classList.contains('hidden') === false) updateStats();
    checkFaltasEvento();
    return true;
}

async function confirmFaceAttendance(type, categoria, eventoId) {
    categoria = categoria || 'regular';
    const teacher = recognizedTeacher;
    if (!teacher) { cancelFaceAttendanceModal(); return; }

    let eventoInfo = null;
    if (categoria === 'evento') {
        eventoInfo = getEventosDeHoyParaDocente(teacher.id).find(ev => ev.id_evento === eventoId);
        if (!eventoInfo) { showToast('Evento no encontrado', 'error'); renderFaceAttendanceModalBody(); return; }
    }

    // Segunda verificación de geocerca, justo antes de confirmar el
    // registro (por si se movió entre que se abrió el modal y tocó
    // el botón, o si alguien intenta forzar el registro sin pasar
    // por acá). Se pausa el timeout de 60s mientras se espera el GPS.
    clearFaceModalTimeout();
    const body0 = document.getElementById('faceAttendanceModalBody');
    body0.innerHTML = `<div class="spinner-border text-primary mb-2"></div><p class="mb-0">Verificando tu ubicación...</p>`;
    const geo = await verifyGeofence();
    if (!geo.ok) {
        showGeofenceBlockModal(geo);
        renderFaceAttendanceModalBody();
        resetFaceModalTimeout();
        return;
    }

    const ok = categoria === 'evento' ? registerFaceEventoAttendance(type, teacher, eventoInfo) : registerAttendance(type);
    if (!ok) {
        // Estado cambió entre que se abrió el modal y se tocó el
        // botón (p.ej. otra pestaña ya registró algo): se
        // re-renderiza con las opciones vigentes en vez de dejar el
        // modal colgado.
        renderFaceAttendanceModalBody();
        resetFaceModalTimeout();
        return;
    }

    faceModalPending = false; // ya quedó guardado: no hay más riesgo de fichaje fantasma
    const time = new Date().toTimeString().split(' ')[0].slice(0, 5);
    const label = (type === 'entry') ? (categoria === 'evento' ? 'Ingreso a evento' : 'Ingreso') : (categoria === 'evento' ? 'Salida de evento' : 'Salida');
    const body = document.getElementById('faceAttendanceModalBody');
    body.innerHTML = `
        <div class="text-success mb-2" style="font-size:3rem;"><i class="bi bi-check-circle-fill"></i></div>
        <h5>${label} registrado ${time}</h5>
        <p class="text-muted mb-3">${teacher.apellido} ${teacher.nombre}</p>
        <button class="btn btn-success" onclick="finishFaceAttendance()"><i class="bi bi-check2"></i> Finalizar</button>
    `;
    resetFaceModalTimeout();
}

// "No soy yo / Cancelar": vuelve a la cámara sin guardar nada.
function cancelFaceAttendanceModal() {
    clearFaceModalTimeout();
    faceModalPending = false;
    if (faceModalInstance) faceModalInstance.hide();
    isFaceVerified = false;
    recognizedTeacher = null;
    setFaceNavLocksDisabled(false);
    freezeTeacherVideo(false);
    const status = document.getElementById('faceRecognitionStatus');
    if (status) {
        status.className = 'face-recognition-status waiting';
        status.innerHTML = '<i class="bi bi-info-circle"></i> Esperando identificación...';
    }
    updateAttendanceButtonsState();
}

// Cierra el modal después de un registro exitoso (botón "Finalizar").
function finishFaceAttendance() {
    clearFaceModalTimeout();
    faceModalPending = false;
    if (faceModalInstance) faceModalInstance.hide();
    isFaceVerified = false;
    recognizedTeacher = null;
    setFaceNavLocksDisabled(false);
    freezeTeacherVideo(false);
    const status = document.getElementById('faceRecognitionStatus');
    if (status) {
        status.className = 'face-recognition-status waiting';
        status.innerHTML = '<i class="bi bi-info-circle"></i> Esperando identificación...';
    }
    updateAttendanceButtonsState();
}

function resetFaceModalTimeout() {
    clearFaceModalTimeout();
    faceModalTimeoutHandle = setTimeout(handleFaceModalTimeout, 60000);
}

function clearFaceModalTimeout() {
    if (faceModalTimeoutHandle) { clearTimeout(faceModalTimeoutHandle); faceModalTimeoutHandle = null; }
}

// Seguridad: si pasan 60s sin tocar nada en el modal bloqueante,
// se libera solo (evita dejar la cámara congelada para siempre si
// el docente se va sin elegir nada).
function handleFaceModalTimeout() {
    if (faceModalPending) {
        showToast('⏱️ Se agotó el tiempo para confirmar el fichaje. Volviendo a la cámara.', 'warning');
        cancelFaceAttendanceModal();
    } else {
        showToast('⏱️ Se cerró la confirmación por inactividad.', 'info');
        finishFaceAttendance();
    }
}

// Avisa si se intenta cerrar la pestaña, recargar o navegar hacia
// atrás mientras hay un fichaje reconocido pero todavía sin
// confirmar (antes de elegir Ingreso/Salida/Cancelar).
window.addEventListener('beforeunload', function(e) {
    if (faceModalPending) {
        e.preventDefault();
        e.returnValue = 'Tienes un fichaje pendiente por confirmar';
        return e.returnValue;
    }
});

// Defensa extra: aunque backdrop:'static' + keyboard:false ya evitan
// que ESC o un clic afuera disparen el cierre, este listener bloquea
// CUALQUIER intento de ocultar el modal (así sea por otro código, una
// extensión del navegador, o Bootstrap internamente) mientras el
// fichaje siga sin confirmar. cancelFaceAttendanceModal()/
// finishFaceAttendance() siempre ponen faceModalPending en false
// ANTES de llamar a .hide(), así que un cierre legítimo nunca queda
// bloqueado por esto.
document.addEventListener('DOMContentLoaded', function() {
    const faceModalEl = document.getElementById('faceAttendanceModal');
    if (faceModalEl) {
        faceModalEl.addEventListener('hide.bs.modal', function(e) {
            if (faceModalPending) e.preventDefault();
        });
    }
});

// Devuelve true si el registro se guardó, false si se rechazó (por
// ejemplo, entrada duplicada o fuera de horario) — el modal de
// fichaje obligatorio usa este valor para saber si puede pasar a la
// pantalla de "registrado" o si tiene que quedarse mostrando botones.
function registerAttendance(type) {
    if (!isFaceVerified || !recognizedTeacher) { showToast('⚠️ Identifícate primero con "Identificarme"', 'warning'); return false; }

    // Entrada única diaria: se recalcula acá (no solo en la UI) para
    // que tampoco se pueda saltear llamando a esta función directo
    // desde la consola. No se puede salir de algo a lo que no
    // entró, ni volver a marcar una segunda entrada el mismo día.
    const yaEntroHoy = hasEntryToday(recognizedTeacher.id);
    if (type === 'entry' && yaEntroHoy) {
        showToast('⚠️ Ya registraste tu entrada de hoy.', 'warning');
        updateAttendanceButtonsState();
        return false;
    }
    if ((type === 'exit' || type === 'early_exit') && !yaEntroHoy) {
        showToast('⚠️ Todavía no registraste tu entrada de hoy.', 'warning');
        updateAttendanceButtonsState();
        return false;
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
        return false;
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
        date, time, type, status: attStatus, timestamp: now.toISOString(),
        categoria: 'regular'
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
    return true;
}

// ============================================================
// FICHAJE MANUAL (admin) — para cuando la cámara no está
// disponible. Respeta la misma regla de "entrada única diaria"
// que el fichaje facial (solo Ingreso si no fichó, solo Salida si
// ya tiene Ingreso y todavía no Salida), pero sin pasar por el
// reconocimiento facial. Queda marcado con origen: 'manual-admin'.
//
// Cátedra regular y Eventos Especiales son INDEPENDIENTES entre sí
// (cada attendance queda con categoria: 'regular' | 'evento', y las
// de evento además con eventoId/eventoTitulo/eventoHora*): un
// docente puede tener la cátedra de hoy completa y un evento
// pendiente, o viceversa — nunca se bloquean entre sí.
// ============================================================
let manualAttendanceTeacherId = null;

function hasExitToday(teacherId, categoria, eventoId) {
    categoria = categoria || 'regular';
    const todayStr = new Date().toISOString().split('T')[0];
    return getAttendance().some(a => a.teacherId === teacherId && (a.type === 'exit' || a.type === 'early_exit') && a.date === todayStr &&
        (a.categoria || 'regular') === categoria &&
        (categoria !== 'evento' || a.eventoId === eventoId));
}

function openManualAttendanceModal(teacherId) {
    const teacher = getTeachers().find(t => t.id === teacherId);
    if (!teacher) { showToast('Docente no encontrado', 'error'); return; }
    manualAttendanceTeacherId = teacherId;
    renderManualAttendanceModalBody();
    new bootstrap.Modal(document.getElementById('manualAttendanceModal')).show();
}

// Arma el bloque de estado + botones para UNA franja (cátedra
// regular o un evento puntual). Se reutiliza para la Sección A y
// para cada evento de la Sección B.
// fnName/labels son opcionales: por defecto arma el bloque para el
// Fichaje Manual del admin (registerManualAttendance), pero
// renderFaceAttendanceModalBody() lo reutiliza para la sección de
// Eventos Especiales del modal facial del propio docente, pasando
// fnName:'confirmFaceAttendance' y labels propias.
function buildFichajeManualBlock(teacher, categoria, eventoId, onclickArgs, fnName, labels, salidaType) {
    fnName = fnName || 'registerManualAttendance';
    salidaType = salidaType || 'exit';
    labels = labels || {
        entrada: categoria === 'evento' ? 'Ingreso Manual a Evento' : 'Ingreso Manual',
        salida: categoria === 'evento' ? 'Salida Manual de Evento' : 'Salida Manual',
    };
    const todayStr = new Date().toISOString().split('T')[0];
    const registros = getAttendance().filter(a => a.teacherId === teacher.id && a.date === todayStr &&
        (a.categoria || 'regular') === categoria && (categoria !== 'evento' || a.eventoId === eventoId));
    const entrada = registros.find(a => a.type === 'entry');
    const salida = registros.find(a => a.type === 'exit' || a.type === 'early_exit');
    const yaEntro = !!entrada;
    const yaSalio = !!salida;

    let estadoHtml;
    if (!yaEntro) {
        estadoHtml = '<span class="badge bg-danger">No registrado</span>';
    } else if (!yaSalio) {
        estadoHtml = `<span class="badge bg-success">Ingreso: ${entrada.time.slice(0, 5)}${entrada.status === 'late' ? ' (tardanza)' : ''}</span> <span class="badge bg-warning text-dark ms-1">Sin salida</span>`;
    } else {
        estadoHtml = `<span class="badge bg-success">Ingreso: ${entrada.time.slice(0, 5)}</span> <span class="badge bg-secondary ms-1">Salida: ${salida.time.slice(0, 5)}${salida.type === 'early_exit' ? ' (anticipada)' : ''}</span>`;
    }
    if (yaEntro && yaSalio) estadoHtml += ' <span class="badge bg-dark ms-1">Completo</span>';

    return `
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
            <div>${estadoHtml}</div>
            <div class="d-flex gap-2">
                <button class="btn btn-sm btn-entry" ${yaEntro ? 'disabled' : ''} onclick="${fnName}('entry', ${onclickArgs})"><i class="bi bi-box-arrow-in-right"></i> ${labels.entrada}</button>
                <button class="btn btn-sm btn-exit" ${(!yaEntro || yaSalio) ? 'disabled' : ''} onclick="${fnName}('${salidaType}', ${onclickArgs})"><i class="bi bi-box-arrow-left"></i> ${labels.salida}</button>
            </div>
        </div>`;
}

function renderManualAttendanceModalBody() {
    const teacher = getTeachers().find(t => t.id === manualAttendanceTeacherId);
    if (!teacher) return;

    document.getElementById('manualAttendanceModalTitle').innerHTML = `<i class="bi bi-fingerprint"></i> Fichaje Manual — ${teacher.apellido} ${teacher.nombre}`;

    const catedraHtml = buildFichajeManualBlock(teacher, 'regular', null, `'regular'`);

    const eventosHoy = getEventosDeHoyParaDocente(teacher.id);
    const eventosHtml = eventosHoy.length === 0
        ? '<p class="text-muted mb-0">No tiene eventos especiales convocados hoy.</p>'
        : eventosHoy.map(ev => `
            <div class="border rounded p-2 mb-2">
                <p class="mb-1"><strong>${ev.titulo}</strong> <small class="text-muted">(${(ev.hora_entrada || '').slice(0, 5)} - ${(ev.hora_salida || '').slice(0, 5)})</small></p>
                ${buildFichajeManualBlock(teacher, 'evento', ev.id_evento, `'evento', ${ev.id_evento}`)}
            </div>`).join('');

    document.getElementById('manualAttendanceBody').innerHTML = `
        <div class="alert alert-warning py-2 small mb-2"><i class="bi bi-exclamation-triangle"></i> Registrado manualmente por administrador - cámara no disponible.</div>
        <div class="alert alert-warning py-1 px-2 small mb-3"><i class="bi bi-person-badge"></i> MODO PRUEBA ADMIN - Geocerca desactivada (el fichaje manual no la requiere).</div>
        <p class="mb-1"><strong><i class="bi bi-easel"></i> Cátedra de hoy</strong></p>
        ${catedraHtml}
        <hr>
        <p class="mb-2"><strong><i class="bi bi-calendar-event"></i> Eventos especiales de hoy</strong></p>
        ${eventosHtml}
    `;
}

function registerManualAttendance(type, categoria, eventoId) {
    categoria = categoria || 'regular';
    const teacher = getTeachers().find(t => t.id === manualAttendanceTeacherId);
    if (!teacher) { showToast('Docente no encontrado', 'error'); return; }

    let eventoInfo = null;
    if (categoria === 'evento') {
        eventoInfo = getEventosDeHoyParaDocente(teacher.id).find(ev => ev.id_evento === eventoId);
        if (!eventoInfo) { showToast('Evento no encontrado', 'error'); return; }
    }

    const yaEntro = hasEntryToday(teacher.id, categoria, eventoId);
    const yaSalio = hasExitToday(teacher.id, categoria, eventoId);
    if (type === 'entry' && yaEntro) { showToast('⚠️ Ya tiene un ingreso registrado' + (categoria === 'evento' ? ' para este evento' : ' hoy'), 'warning'); return; }
    if (type === 'exit' && (!yaEntro || yaSalio)) { showToast('⚠️ No corresponde registrar salida en este estado', 'warning'); return; }

    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toTimeString().split(' ')[0];
    let attStatus = 'present';
    const criteria = getCriteria();
    const lateLimit = criteria.lateLimit || 15;

    if (type === 'entry') {
        const earliestStart = categoria === 'evento'
            ? ((eventoInfo.hora_entrada || '').slice(0, 5) || null)
            : getEarliestScheduleTime(teacher, FULL_DAYS[now.getDay()]);
        if (earliestStart) {
            const [startH, startM] = earliestStart.split(':').map(Number);
            const scheduledMinutes = startH * 60 + startM;
            const nowMinutes = now.getHours() * 60 + now.getMinutes();
            if (nowMinutes > scheduledMinutes + lateLimit) {
                attStatus = 'late';
                if (categoria === 'evento') {
                    createAlert(teacher, 'Tardanza Evento', `Llegó tarde al evento "${eventoInfo.titulo}" (${time}). Hora prevista: ${earliestStart}. Registrado manualmente por el administrador.`);
                } else {
                    createAlert(teacher, 'Tardanza', `Llegó tarde (${time}). Hora prevista: ${earliestStart}. Más de ${lateLimit} minutos de retraso. Registrado manualmente por el administrador.`);
                }
            }
        }
        if (categoria === 'regular') clearTodaysFaltaAlert(teacher.id, date);
    }

    const typeMap = {
        entry: categoria === 'evento' ? 'Ingreso manual a evento' : 'Ingreso manual',
        exit: categoria === 'evento' ? 'Salida manual de evento' : 'Salida manual',
    };
    const record = {
        id: Date.now().toString(),
        teacherId: teacher.id,
        teacherName: `${teacher.apellido} ${teacher.nombre}`,
        date, time, type, status: attStatus, timestamp: now.toISOString(),
        categoria,
        origen: 'manual-admin',
        observacion: 'Registrado manualmente por administrador - cámara no disponible',
    };
    if (categoria === 'evento') {
        record.eventoId = eventoInfo.id_evento;
        record.eventoTitulo = eventoInfo.titulo;
        record.eventoHoraEntrada = (eventoInfo.hora_entrada || '').slice(0, 5);
        record.eventoHoraSalida = (eventoInfo.hora_salida || '').slice(0, 5);
    }
    const attendance = getAttendance();
    attendance.push(record);
    saveAttendance(attendance);

    const quien = `${teacher.apellido} ${teacher.nombre}`;
    showToast(`✅ ${typeMap[type]} registrado para ${quien} a las ${time.slice(0, 5)}`, 'success');

    renderManualAttendanceModalBody();
    loadTeachersTable();
    updateStats();
    checkFaltas();
    checkFaltasEvento();
    loadAlerts();
    updateAlertCount();
}

function createAlert(teacher, type, message) {
    const alerts = getAlerts();
    alerts.push({
        id: `${Date.now().toString()}_${Math.random().toString(36).slice(2, 8)}`,
        teacherId: teacher.id, teacherName: `${teacher.apellido} ${teacher.nombre}`,
        type, message, date: new Date().toISOString(), justified: false, justification: null
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
// evento_docente, docente), separadas de app_data. `docente` se
// mantiene como espejo de app_data.teachers (mismo id, convertido a
// número) solo para poder cumplir la FK de evento_docente.id_docente
// sin duplicar la gestión real de docentes, que sigue siendo
// app_data.teachers.
// ============================================================
let currentEventos = [];
let eventoSelectedTeacherIds = [];
let editingEventoId = null;
// Convocatorias a eventos especiales por docente (id numérico ->
// array de {id_evento, titulo, fecha, hora_entrada, hora_salida}).
// checkFaltas() lo usa para no computar Falta de cátedra regular en
// la fecha de un evento; checkFaltasEvento() y el modal de Fichaje
// Manual lo usan para saber a qué eventos está convocado cada
// docente y en qué fechas.
let eventoConvocatoriasPorDocente = {};

// Busca en app_data.teachers el docente cuyo id (convertido a número)
// coincide con un id_docente de las tablas relacionales (docente,
// evento_docente). Se usa porque `docente` es un espejo de
// app_data.teachers con el mismo id.
function getTeacherByNumericId(idDocente) {
    return getTeachers().find(t => Number(t.id) === Number(idDocente));
}

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

// Trae, para cada docente convocado a algún evento especial, la
// lista de esos eventos (id, título, fecha y horario). Alimenta
// checkFaltas() (saltear Falta de cátedra regular ese día),
// checkFaltasEvento() (Falta/Tardanza propias del evento) y la
// sección "Eventos especiales de hoy" del modal de Fichaje Manual.
async function loadEventoConvocatoriasPorDocente() {
    eventoConvocatoriasPorDocente = {};
    if (!sb) return;
    try {
        const { data, error } = await sb.from('evento_docente').select('id_docente, evento_especial(id_evento,titulo,fecha,hora_entrada,hora_salida)');
        if (error) throw error;
        (data || []).forEach(row => {
            const ev = row.evento_especial;
            if (!ev || !ev.fecha) return;
            const id = Number(row.id_docente);
            if (!eventoConvocatoriasPorDocente[id]) eventoConvocatoriasPorDocente[id] = [];
            eventoConvocatoriasPorDocente[id].push(ev);
        });
    } catch (error) {
        console.error('No se pudieron cargar las convocatorias a eventos especiales por docente:', error);
    }
}

function teacherHasEventoOnDate(teacherId, dateStr) {
    const eventos = eventoConvocatoriasPorDocente[Number(teacherId)] || [];
    return eventos.some(ev => ev.fecha === dateStr);
}

// Eventos especiales de HOY a los que está convocado un docente.
// Sincrónico: usa el caché ya cargado por loadEventoConvocatoriasPorDocente(),
// que loadAdminDashboard() garantiza fresco antes de que el admin
// pueda abrir el modal de Fichaje Manual.
function getEventosDeHoyParaDocente(teacherId) {
    const todayStr = new Date().toISOString().split('T')[0];
    const eventos = eventoConvocatoriasPorDocente[Number(teacherId)] || [];
    const eventosDeHoy = eventos.filter(ev => ev.fecha === todayStr);
    // Deduplicar por id_evento: si evento_docente tiene más de una
    // fila para el mismo docente+evento (convocatoria cargada dos
    // veces), esto evita que el mismo evento se renderice repetido
    // en el modal de fichaje. Se corrige acá porque este helper es
    // el único punto de entrada para ambos flujos (facial y manual).
    return [...new Map(eventosDeHoy.map(e => [e.id_evento, e])).values()];
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
    renderEventoDocenteChecklist();
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
    renderEventoDocenteChecklist();
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

// Lista con checkbox de todos los docentes (filtrable por el buscador),
// más el checkbox "Seleccionar todos". Reemplaza al viejo dropdown +
// chips: acá se ve el estado marcado/desmarcado de cada docente de un
// vistazo, y "Seleccionar todos" opera sobre TODOS los docentes
// (no solo los que el filtro de búsqueda esté mostrando).
function renderEventoDocenteChecklist() {
    const container = document.getElementById('eventoDocenteChecklist');
    const query = document.getElementById('eventoDocenteSearch').value.trim().toLowerCase();
    const teachers = getTeachers().filter(t => {
        if (!query) return true;
        const full = `${t.apellido} ${t.nombre}`.toLowerCase();
        return full.includes(query) || (t.materia || '').toLowerCase().includes(query);
    });

    container.innerHTML = teachers.length === 0
        ? '<div class="dropdown-empty">No se encontraron docentes</div>'
        : teachers.map(t => {
            const checked = eventoSelectedTeacherIds.includes(t.id) ? 'checked' : '';
            return `
                <div class="form-check">
                    <input class="form-check-input" type="checkbox" id="eventoDocenteCheck_${t.id}" ${checked} onchange="toggleEventoDocente('${t.id}', this.checked)">
                    <label class="form-check-label" for="eventoDocenteCheck_${t.id}">${t.apellido} ${t.nombre}${t.materia ? ' - ' + t.materia : ''}</label>
                </div>`;
        }).join('');

    updateEventoSelectAllCheckboxState();
}

function toggleEventoDocente(teacherId, checked) {
    if (checked) {
        if (!eventoSelectedTeacherIds.includes(teacherId)) eventoSelectedTeacherIds.push(teacherId);
    } else {
        eventoSelectedTeacherIds = eventoSelectedTeacherIds.filter(id => id !== teacherId);
    }
    updateEventoSelectAllCheckboxState();
}

// Tilda/destilda TODOS los docentes (no solo los filtrados por el
// buscador), y re-renderiza el checklist para reflejar el cambio.
function toggleAllEventoDocentes(checked) {
    eventoSelectedTeacherIds = checked ? getTeachers().map(t => t.id) : [];
    renderEventoDocenteChecklist();
}

// Mantiene el checkbox "Seleccionar todos" sincronizado: tildado si
// están todos los docentes seleccionados, destildado si no hay
// ninguno, e indeterminado (guion) si hay una selección parcial.
function updateEventoSelectAllCheckboxState() {
    const selectAll = document.getElementById('eventoSelectAllDocentes');
    if (!selectAll) return;
    const total = getTeachers().length;
    const selected = eventoSelectedTeacherIds.length;
    selectAll.checked = total > 0 && selected === total;
    selectAll.indeterminate = selected > 0 && selected < total;
}

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

    // Anti-duplicado: si ya existe un evento con el mismo título +
    // fecha + hora de entrada (p. ej. por un doble clic en
    // "Guardar"), se avisa y no se inserta uno nuevo. Al editar, se
    // excluye el propio evento de la búsqueda (si no, siempre
    // "chocaría" contra sí mismo). Esto es la validación de UX; el
    // freno real contra la condición de carrera (dos clics casi
    // simultáneos) es la constraint UNIQUE en Supabase — ver el
    // catch de abajo y el comentario con el SQL más arriba en el
    // archivo (buscar "unique_evento_dia_horario").
    let dupQuery = sb.from('evento_especial').select('id_evento').eq('titulo', titulo).eq('fecha', fecha).eq('hora_entrada', horaEntrada).limit(1);
    if (editingEventoId) dupQuery = dupQuery.neq('id_evento', editingEventoId);
    const { data: existente, error: dupError } = await dupQuery.maybeSingle();
    if (dupError) {
        console.error('No se pudo verificar duplicados de evento:', dupError);
    } else if (existente) {
        showToast('⚠️ Ya existe un evento con ese título y horario para esa fecha', 'error');
        return;
    }

    const saveBtn = document.querySelector('#eventoModal .modal-footer .btn-primary');
    if (saveBtn) saveBtn.disabled = true;

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
        loadEventoConvocatoriasPorDocente().then(() => { checkFaltas(); checkFaltasEvento(); });
    } catch (error) {
        console.error('Error guardando evento especial:', error);
        // 23505 = unique_violation: la constraint UNIQUE de Supabase
        // frenó una condición de carrera (dos clics casi
        // simultáneos) que la verificación de arriba no llegó a
        // atajar. Mismo mensaje claro en vez del error crudo de Postgres.
        if (error && error.code === '23505') {
            showToast('⚠️ Ya existe un evento con ese título y horario para esa fecha', 'error');
        } else {
            showToast('No se pudo guardar el evento (' + describeSupabaseError(error) + ')', 'error');
        }
    } finally {
        if (saveBtn) saveBtn.disabled = false;
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
        // Las alertas de Falta/Tardanza de este evento ya no aplican.
        const alerts = getAlerts().filter(a => a.eventoId !== idEvento);
        saveAlerts(alerts);

        showToast('Evento eliminado', 'info');
        loadEventosEspeciales();
        loadEventoConvocatoriasPorDocente();
        loadAlerts();
        updateAlertCount();
    } catch (error) {
        console.error('Error eliminando evento especial:', error);
        showToast('No se pudo eliminar el evento (' + describeSupabaseError(error) + ')', 'error');
    }
}

// ============================================================
// CALENDARIO ANUAL (proyección del horario del docente sobre
// todas las fechas del año) Y DETECCIÓN DE FALTAS
// ============================================================

// A partir del horario semanal de un docente (día + hora), arma
// la lista de fechas concretas de "year" en las que le toca dar
// clase. Usa fechas en UTC para que coincidan con el formato
// (toISOString) con el que se guarda la fecha de cada asistencia.
function generateTeacherScheduleDates(teacher, year) {
    const horario = getHorarioLaboral(teacher);
    if (horario.length === 0) return [];
    const dayRangesMap = {};
    horario.forEach(h => {
        if (!dayRangesMap[h.dia]) dayRangesMap[h.dia] = [];
        dayRangesMap[h.dia].push({ inicio: h.inicio, fin: h.fin });
    });
    const results = [];
    const start = Date.UTC(year, 0, 1);
    const end = Date.UTC(year, 11, 31);
    for (let t = start; t <= end; t += 86400000) {
        const d = new Date(t);
        const dayName = FULL_DAYS[d.getUTCDay()];
        const ranges = dayRangesMap[dayName];
        if (ranges) {
            results.push({
                date: d.toISOString().split('T')[0],
                day: dayName,
                times: ranges.map(r => `${r.inicio}-${r.fin}`),
                startTimes: ranges.map(r => r.inicio)
            });
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
            if (teacherHasEventoOnDate(teacher.id, sd.date)) return;

            if (sd.date === todayStr) {
                const earliestStart = sd.startTimes.slice().sort()[0];
                const [startH, startM] = earliestStart.split(':').map(Number);
                const scheduledMinutes = startH * 60 + startM;
                if (nowMinutes <= scheduledMinutes + lateLimit) return; // todavía dentro del margen, no es falta (todavía)
            }

            const hasEntry = attendance.some(a => a.teacherId === teacher.id && a.type === 'entry' && a.date === sd.date && (a.categoria || 'regular') === 'regular');
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
                justified: false, justification: null
            });
            created = true;
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

// Igual que checkFaltas(), pero para la asistencia a Eventos
// Especiales: independiente de la cátedra regular (usa
// categoria: 'evento' + eventoId, nunca las entradas regulares).
// Un docente puede tener la cátedra completa y una Falta de evento
// pendiente, o viceversa. Genera alertas "Falta Evento" (una por
// docente + evento, sin duplicar).
function checkFaltasEvento() {
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
        const eventos = eventoConvocatoriasPorDocente[Number(teacher.id)] || [];
        eventos.forEach(ev => {
            if (ev.fecha > todayStr) return; // evento futuro, todavía no corresponde
            if (getLicenciaForDate(teacher.id, ev.fecha)) return;

            const horaEntrada = (ev.hora_entrada || '').slice(0, 5);
            if (ev.fecha === todayStr && horaEntrada) {
                const [startH, startM] = horaEntrada.split(':').map(Number);
                const scheduledMinutes = startH * 60 + startM;
                if (nowMinutes <= scheduledMinutes + lateLimit) return; // todavía dentro del margen
            }

            const hasEntry = attendance.some(a => a.teacherId === teacher.id && a.type === 'entry' && a.categoria === 'evento' && a.eventoId === ev.id_evento);
            if (hasEntry) return;
            const alreadyAlerted = alerts.some(a => a.teacherId === teacher.id && a.type === 'Falta Evento' && a.eventoId === ev.id_evento);
            if (alreadyAlerted) return;

            alerts.push({
                id: `${teacher.id}_faltaevento_${ev.id_evento}`,
                teacherId: teacher.id,
                teacherName: `${teacher.apellido} ${teacher.nombre}`,
                type: 'Falta Evento',
                message: `No registró ingreso al evento "${ev.titulo}" del ${ev.fecha} (horario: ${horaEntrada || '-'} - ${(ev.hora_salida || '').slice(0, 5)}).`,
                date: new Date().toISOString(),
                faltaDate: ev.fecha,
                eventoId: ev.id_evento,
                justified: false, justification: null
            });
            created = true;
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
// GRILLA COMPLETA DE HORARIOS (vista panorámica, solo lectura)
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
                <p><strong>E-mail:</strong> ${teacher.email || '-'}</p>
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
                const earliestStart = sd.startTimes.slice().sort()[0];
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
            const earliestStart = sd.startTimes.slice().sort()[0];
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
    // Puntualidad/presentismo: solo cátedra regular (los eventos
    // especiales tienen su propia serie de stats más abajo, para no
    // mezclar ambas cosas en un mismo porcentaje).
    const entries = attendance.filter(a => a.type === 'entry' && (a.categoria || 'regular') === 'regular');
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

    const unjustifiedAlerts = alerts.filter(a => !a.justified && a.type !== 'Falta Evento' && a.type !== 'Tardanza Evento').length;
    const earlyExitCount = alerts.filter(a => a.type === 'Salida Anticipada').length;

    // Faltas/tardanzas de Eventos Especiales, diferenciadas de las de
    // cátedra regular (esas ya están en unjustifiedAlerts/lateCount).
    const eventoEntries = attendance.filter(a => a.type === 'entry' && a.categoria === 'evento');
    const eventoLateCount = eventoEntries.filter(a => a.status === 'late').length;
    const eventoFaltaCount = alerts.filter(a => a.type === 'Falta Evento' && !a.justified).length;
    const eventoTardanzaCount = alerts.filter(a => a.type === 'Tardanza Evento' && !a.justified).length;

    return {
        totalRegistros: attendance.length,
        totalEntries, presentCount, lateCount, punctuality,
        teacherRows, topTeacher, dates, byDate, unjustifiedAlerts, earlyExitCount,
        eventoLateCount, eventoFaltaCount, eventoTardanzaCount,
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
        <div class="col-md-3"><div class="stat-card"><div class="number">${stats.eventoFaltaCount}</div><div class="label">Faltas a Eventos Especiales</div></div></div>
        <div class="col-md-3"><div class="stat-card"><div class="number">${stats.eventoTardanzaCount}</div><div class="label">Tardanzas a Eventos Especiales</div></div></div>
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
    ensureGeofenceConfig();
    await loadEventoConvocatoriasPorDocente();
    checkFaltas();
    checkFaltasEvento();
    setInterval(() => { loadEventoConvocatoriasPorDocente().then(() => { checkFaltas(); checkFaltasEvento(); }); }, 5 * 60 * 1000);
    flushPendingSync(); // por si quedaron cambios sin subir de una sesión offline anterior
    showToast('Sistema iniciado', 'info');
});

// ============================================================
// SERVICE WORKER (funcionamiento sin conexión / modo avión)
// Precachea la app (index.html, style.css), las librerías de
// terceros y los pesos del reconocimiento facial (/models) en la
// primera visita, para que el fichaje por rostro siga funcionando
// sin internet en visitas posteriores. Ver sw.js.
// ============================================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('Service worker registrado', reg.scope))
            .catch(err => console.error('No se pudo registrar el service worker', err));
    });
}
