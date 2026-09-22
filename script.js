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
    // Clave interna para ubicar la fila del Programador en la tabla
    // `usuarios` de Supabase - no es el usuario de login (ver
    // PROGRAMADOR_LOGIN_USER en roles.js) ni un secreto: no hay
    // contraseña acá, esa vive hasheada en config.secrets.js/
    // config.example.js (ver PROGRAMADOR_BOOTSTRAP) o, una vez creada
    // la fila real, en Supabase.
    ADMIN_USER: 'ADMIN',
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
    // ~0.6 como límite superior razonable (99%+ en LFW). Bajado de 0.55
    // a 0.5 (más estricto - defensa en profundidad junto con la prueba
    // de vida, ver liveness.js): la vulnerabilidad real que dejaba
    // pasar una foto no era este umbral (la foto ERA del docente
    // registrado, así que el descriptor coincidía igual), sino la
    // prueba de vida en sí, pero no cuesta nada endurecer también acá.
    FACE_MATCH_THRESHOLD: 0.5,
    MIN_CAPTURES: 3,
    // Cuántos frames en vivo se promedian al identificar a alguien,
    // para no depender de un único frame que puede salir borroso.
    IDENTIFY_SAMPLES: 3,
    IDENTIFY_SAMPLE_INTERVAL_MS: 250,
    // Antes apuntaba al CDN de face-api.js (jsdelivr). Los pesos están
    // copiados en /models dentro del propio repo para que el service
    // worker (sw.js) pueda precachearlos en la instalación y el
    // reconocimiento facial funcione sin conexión (modo avión) después de
    // la primera visita, sin depender de que el CDN esté disponible. Ruta
    // absoluta (no relativa) para que siga resolviendo bien aunque la URL
    // activa no sea la raíz (Netlify reescribe "/*" -> "/index.html").
    FACE_MODELS_URL: '/models'
};

// Única escuela de este despliegue (ver escuelas/suscripciones en
// supabase-schema.sql). Se usa como escuela_id al guardar filas nuevas en
// tablas relacionales multi-escuela (por ahora, evento_especial).
const ESCUELA_ID = 2;

// ============================================================
// RECUPERACIÓN DE CONTRASEÑA DEL ADMIN (tabla `usuarios` + EmailJS)
// Completá estos 3 valores con los de tu cuenta de EmailJS
// (https://www.emailjs.com, plan gratuito) para que "Olvidé mi
// contraseña" y el aviso de respaldo a soporte manden mails de
// verdad. Hasta entonces la app sigue funcionando: el login normal
// y el cambio de contraseña no dependen de esto, solo el envío del
// mail de recuperación (que sin configurar muestra "contactá a
// soporte" en vez de fallar en silencio).
// ============================================================
const EMAILJS_PUBLIC_KEY = 'TU_PUBLIC_KEY_AQUI';
const EMAILJS_SERVICE_ID = 'TU_SERVICE_ID_AQUI';
const EMAILJS_TEMPLATE_ID = 'TU_TEMPLATE_ID_AQUI';
const SOPORTE_EMAIL = 'maximilianoempleo@gmail.com';

function emailjsConfigurado() {
    return typeof emailjs !== 'undefined'
        && !EMAILJS_PUBLIC_KEY.startsWith('TU_')
        && !EMAILJS_SERVICE_ID.startsWith('TU_')
        && !EMAILJS_TEMPLATE_ID.startsWith('TU_');
}

// Fila única de la tabla `usuarios` para el ADMIN (id, usuario,
// password, rol, email, email_respaldo, reset_token,
// reset_token_expira). Se carga en loadAdminUsuario() al iniciar,
// junto con el resto de los datos, y se cachea en localStorage para
// que el login del admin siga funcionando sin conexión.
let adminUsuario = null;

async function loadAdminUsuario() {
    if (sb) {
        try {
            const { data, error } = await sb.from('usuarios').select('*').eq('usuario', CONFIG.ADMIN_USER).maybeSingle();
            if (!error && data) {
                adminUsuario = data;
                localStorage.setItem('sb_cache_admin_usuario', JSON.stringify(data));
                return;
            }
            if (error) console.error('No se pudo cargar el usuario admin desde Supabase:', describeSupabaseError(error));
        } catch (e) {
            console.error('No se pudo cargar el usuario admin desde Supabase', e);
        }
    }
    try {
        const cached = localStorage.getItem('sb_cache_admin_usuario');
        if (cached) { adminUsuario = JSON.parse(cached); return; }
    } catch (e) { /* ignorar caché corrupta */ }
    // Sin fila en Supabase ni caché todavía (primerísimo arranque):
    // sin "id", login()/changeAdminPassword() saben que hay que
    // validar contra el hash de arranque (PROGRAMADOR_BOOTSTRAP) en
    // vez de comparar esta contraseña en texto plano - por eso acá no
    // se guarda ninguna.
    adminUsuario = { usuario: CONFIG.ADMIN_USER, password: null, rol: 'admin', email: null, email_respaldo: null };
}

// Hashes SHA-256 de Secretaría (ADMIN1) y Rector (ADMIN2): viven en
// filas de la misma tabla `usuarios` de Supabase que ya usaba
// Programador (ver add_secretaria_rector_usuarios.sql), en vez de un
// archivo aparte que habría que resubir a mano al hosting en cada
// redeploy. window.ASISCAM_CRED_HASHES ya viene precargado por
// roles.js con el fallback de config.secrets.js/config.example.js
// (offline o antes de correr el SQL); acá se pisa con el valor real de
// Supabase (o su caché) si está disponible.
async function loadCredencialesFijas() {
    if (!window.ASISCAM_CRED_HASHES) window.ASISCAM_CRED_HASHES = {};
    const aplicar = (porUsuario) => {
        let huboReal = false;
        if (porUsuario.ADMIN1) { window.ASISCAM_CRED_HASHES.SECRETARIA = porUsuario.ADMIN1; huboReal = true; }
        if (porUsuario.ADMIN2) { window.ASISCAM_CRED_HASHES.RECTOR = porUsuario.ADMIN2; huboReal = true; }
        if (huboReal) {
            window.ASISCAM_DEMO_MODE = false;
            document.getElementById('demoModeBanner')?.style.setProperty('display', 'none');
        }
    };
    if (sb) {
        try {
            const { data, error } = await sb.from('usuarios').select('usuario, password').in('usuario', ['ADMIN1', 'ADMIN2']);
            if (!error && data && data.length > 0) {
                const porUsuario = {};
                data.forEach(row => { porUsuario[row.usuario] = row.password; });
                aplicar(porUsuario);
                localStorage.setItem('sb_cache_cred_hashes', JSON.stringify(porUsuario));
                return;
            }
            if (error) console.error('No se pudieron cargar los hashes de Secretaría/Rector desde Supabase:', describeSupabaseError(error));
        } catch (e) {
            console.error('No se pudieron cargar los hashes de Secretaría/Rector desde Supabase', e);
        }
    }
    try {
        const cached = localStorage.getItem('sb_cache_cred_hashes');
        if (cached) aplicar(JSON.parse(cached));
    } catch (e) { /* ignorar caché corrupta */ }
}

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
        // maximumAge:0 a propósito: nunca reusar una posición cacheada por
        // el navegador/SO, siempre pedir una lectura fresca (si no, en
        // algunos Android queda pegada una posición vieja de otra app).
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: timeoutMs || 15000, maximumAge: 0 });
    });
}

// Reintenta getCurrentPositionPromise hasta 3 veces (1 intento + 2
// reintentos) antes de dar el GPS por perdido. Bug real reportado: un
// celular gama media/baja con 4G tarda en conseguir el primer fix de
// alta precisión y el primer intento tira timeout aunque el usuario
// esté parado en el punto correcto - con un solo intento eso se
// traducía en "fuera de rango"/"GPS requerido" de forma intermitente.
async function getCurrentPositionWithRetry(timeoutMs, intentos) {
    const maxIntentos = intentos || 3;
    let ultimoError;
    for (let i = 1; i <= maxIntentos; i++) {
        try {
            const position = await getCurrentPositionPromise(timeoutMs);
            console.log(`[GPS] posición obtenida en intento ${i}/${maxIntentos}, accuracy:`, position.coords.accuracy);
            return position;
        } catch (error) {
            ultimoError = error;
            console.error(`[GPS] intento ${i}/${maxIntentos} falló:`, error);
        }
    }
    throw ultimoError;
}

// Cartelito de debug SIEMPRE visible (también con modo prueba
// apagado) con la posición propia, precisión, punto objetivo,
// distancia calculada, radio permitido y resultado. Bug real
// reportado: docentes paradas en el punto correcto recibían "fuera de
// rango" sin ninguna forma de ver por qué (a cuántos metros los
// calculó, qué tan preciso era el GPS, etc.) - esto lo hace visible
// para poder diagnosticarlo en el momento, en vez de a ciegas.
// Último resultado de verifyGeofence(), cacheado para poder
// re-renderizar el cartelito de debug (p. ej. cuando cambia el modo
// prueba o se agrega ?debug=1) sin tener que pedir GPS de nuevo.
let lastGeofenceDebugInfo = null;

function renderGeofenceDebugPanel(info) {
    lastGeofenceDebugInfo = info || lastGeofenceDebugInfo;
    const panel = document.getElementById('geofenceDebugPanel');
    if (!panel) return;
    // Oculto por completo para un docente normal: es info interna
    // (kiosco/modo prueba/coordenadas exactas) que solo hace falta para
    // diagnosticar un problema puntual, no para el uso diario. Ver
    // esVistaDebugActiva() y el bug real reportado: docentes veían
    // "Tu kiosco: NO" / "Modo prueba: OFF" sin que signifique nada para
    // ellos.
    if (!esVistaDebugActiva()) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }

    const modoPrueba = getModoPrueba();
    const esKiosco = isThisDeviceKiosk();
    let html = `<div class="geofence-debug-line">Tu kiosco: ${esKiosco ? 'SI' : 'NO'} — Modo prueba: ${modoPrueba.activo ? 'ON' : 'OFF'}</div>`;

    if (!info) {
        html += `<div class="geofence-debug-line text-muted">Todavía no se verificó tu ubicación (tocá "Identificarme").</div>`;
    } else if (info.bypass) {
        html += `<div class="geofence-debug-line"><i class="bi bi-info-circle"></i> GPS no evaluado (motivo: ${info.bypass})</div>`;
    } else if (info.reason === 'gps') {
        html += `<div class="geofence-debug-line text-danger"><i class="bi bi-geo-alt-fill"></i> No se pudo obtener la ubicación GPS</div>`;
    } else {
        const resultado = info.ok ? 'DENTRO' : 'FUERA';
        const claseResultado = info.ok ? 'text-success' : 'text-danger';
        html += `
            <div class="geofence-debug-line">Tu posición: ${info.coords.lat.toFixed(6)}, ${info.coords.lng.toFixed(6)}</div>
            <div class="geofence-debug-line">Precisión GPS: ${info.precision != null ? info.precision + ' m' : 'desconocida'}</div>
            <div class="geofence-debug-line">Punto objetivo: ${info.geofence.lat.toFixed(6)}, ${info.geofence.lng.toFixed(6)} (${info.geofence.nombreLugar || ''})</div>
            <div class="geofence-debug-line">Distancia calculada: ${Math.round(info.distance)} m</div>
            <div class="geofence-debug-line">Radio permitido: ${info.geofence.radio} m (efectivo con margen GPS: ${Math.round(info.radioEfectivo)} m)</div>
            <div class="geofence-debug-line ${claseResultado}"><strong>Resultado: ${resultado}</strong></div>`;
    }
    panel.classList.remove('hidden');
    panel.innerHTML = html;
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

// Última posición GPS que se pudo obtener con éxito, cacheada en este
// dispositivo (no vive en app_data: es un dato efímero de "estuve
// parado acá la última vez", no una configuración a sincronizar entre
// dispositivos). Sirve para dejar constancia de la posición aproximada
// de un fichaje offline aunque el GPS falle justo en ese momento.
function saveLastKnownCoords(coords) {
    try {
        localStorage.setItem('last_known_coords', JSON.stringify({
            lat: coords.latitude, lng: coords.longitude, at: new Date().toISOString()
        }));
    } catch (e) { /* localStorage lleno o deshabilitado: no es crítico, se ignora */ }
}
function getLastKnownCoords() {
    try {
        const raw = localStorage.getItem('last_known_coords');
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
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

// geofenceOverride es opcional: {lat, lng, radio, nombreLugar}. Se usa
// para validar contra la geocerca de UN EVENTO ESPECIAL puntual en vez
// de la geocerca del colegio (ver confirmFaceAttendance/
// getEventoGeofenceOverride) - mismo algoritmo y mismos bypasses
// (modo prueba, admin, kiosco, sin conexión), solo cambia el punto y
// el radio contra el que se mide la distancia.
async function verifyGeofence(geofenceOverride) {
    const modoPrueba = await fetchFreshAppDataValue('modoPrueba', getModoPrueba);
    if (modoPrueba.activo) { renderGeofenceDebugPanel({ bypass: 'modoPrueba' }); return { ok: true, bypass: 'modoPrueba' }; }
    if (currentUser && currentUser.role === 'admin') { renderGeofenceDebugPanel({ bypass: 'admin' }); return { ok: true, bypass: 'admin' }; }

    const kioskPrincipal = await fetchFreshAppDataValue('kioskPrincipal', getKioskPrincipal);
    if (kioskPrincipal && kioskPrincipal.deviceId === getMyDeviceId()) { renderGeofenceDebugPanel({ bypass: 'kiosk' }); return { ok: true, bypass: 'kiosk' }; }

    // Sin conexión, no tiene sentido hacerlo esperar los 15s completos:
    // sin datos móviles que asistan al GPS (A-GPS), conseguir una
    // posición puede tardar mucho más que eso, así que se corta antes
    // (y sin reintentos: cada intento ya come varios segundos).
    const isOffline = !navigator.onLine;
    let position;
    try {
        position = isOffline
            ? await getCurrentPositionPromise(5000)
            : await getCurrentPositionWithRetry(15000, 3);
    } catch (error) {
        console.error('No se pudo obtener la ubicación GPS (agotados los reintentos):', error);
        // Sin conexión Y sin GPS: el reconocimiento facial (que ya se
        // hizo, y funciona 100% offline con los modelos autohospedados)
        // es la garantía fuerte de identidad acá. Bloquear el fichaje
        // solo porque además falló el GPS no tiene sentido si ni
        // siquiera hay señal para consultar/actualizar la geocerca. Se
        // deja pasar, marcado como pendiente de validar la ubicación
        // cuando vuelva la conexión (ver revalidatePendingGeofenceAttendance).
        if (isOffline) {
            renderGeofenceDebugPanel({ bypass: 'offline_sin_gps' });
            return { ok: true, bypass: 'offline_sin_gps', pendingGeofence: true, coords: getLastKnownCoords() };
        }
        renderGeofenceDebugPanel({ reason: 'gps' });
        return { ok: false, reason: 'gps' };
    }
    saveLastKnownCoords(position.coords);
    const geofenceConfig = geofenceOverride || await fetchFreshAppDataValue('geofence', getGeofenceConfig);
    // Radio mínimo forzado en código: un radio menor a 150m es
    // irrealista con el GPS de un celular común en Argentina (con 4G,
    // sin wifi/A-GPS de calidad, la precisión típica ronda 20-50m y
    // rebota) - si quedó guardado un radio viejo/menor por error, no
    // se confía en él para bloquear fichajes.
    const radioBase = Math.max(Number(geofenceConfig.radio) || 150, 150);
    const geofence = { ...geofenceConfig, radio: radioBase };
    const distance = haversineDistanceMeters(position.coords.latitude, position.coords.longitude, geofence.lat, geofence.lng);
    // coords real del fichaje (no solo si pasó o no la geocerca): se
    // guarda en el registro de asistencia para el reporte "ubicación
    // real vs configurada" (ver registerAttendance()/generateReport()).
    const coords = { lat: position.coords.latitude, lng: position.coords.longitude };
    const precision = Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null;
    const fakeGpsSospechoso = esGpsSospechoso(position.coords);
    // Buffer por precisión: el GPS de celular nunca da un punto exacto,
    // da un círculo de "accuracy" metros de radio alrededor del punto
    // reportado. Si no se descuenta ese margen, alguien parado EN el
    // punto correcto pero con accuracy=40m puede figurar a 60m y
    // rebotar contra un radio de 50m. Se suma además un colchón fijo de
    // 50m para celulares baratos/GPS ruidoso. Bug real reportado:
    // "fuera de rango" estando físicamente en el lugar.
    const margen = Number.isFinite(precision) ? precision : 30;
    const radioEfectivo = geofence.radio + margen + 50;
    console.log('[GPS] distancia:', Math.round(distance), 'radio:', geofence.radio, 'accuracy:', precision, 'radio efectivo:', Math.round(radioEfectivo));
    const dentro = distance <= radioEfectivo;
    const resultado = dentro
        ? { ok: true, distance, geofence, coords, precision, fakeGpsSospechoso, radioEfectivo }
        : { ok: false, reason: 'geofence', distance, geofence, coords, precision, fakeGpsSospechoso, radioEfectivo };
    renderGeofenceDebugPanel(resultado);
    return resultado;
}

// Heurística DÉBIL, no detección real: desde un navegador/PWA no hay
// forma confiable de saber si el GPS es simulado (a diferencia de una
// app nativa Android, que sí puede consultar Location.isFromMockProvider()).
// Esto solo marca como "sospechoso" un par de señales conocidas de apps
// de fake-GPS comunes (accuracy perfecta y redonda, o exactamente
// Null Island 0,0) para que el admin lo revise a mano - nunca bloquea
// el fichaje ni se usa como prueba por sí sola.
function esGpsSospechoso(coords) {
    if (coords.latitude === 0 && coords.longitude === 0) return true;
    if ([1, 5, 10, 20].includes(coords.accuracy)) return true;
    return false;
}

// Arma el {lat,lng,radio,nombreLugar} de la geocerca de UN evento
// especial puntual, para pasarlo como override a verifyGeofence().
// Devuelve null si el evento no tiene geocerca activada o le faltan
// coordenadas (en ese caso, el fichaje del evento no valida ubicación
// en absoluto - ver confirmFaceAttendance).
function getEventoGeofenceOverride(eventoInfo) {
    if (!eventoInfo || !eventoInfo.tiene_geocerca) return null;
    if (!Number.isFinite(eventoInfo.geocerca_lat) || !Number.isFinite(eventoInfo.geocerca_lng)) return null;
    return {
        lat: eventoInfo.geocerca_lat,
        lng: eventoInfo.geocerca_lng,
        radio: eventoInfo.geocerca_radio || 150,
        nombreLugar: eventoInfo.direccion_evento || eventoInfo.titulo,
        esEvento: true,
    };
}

// Cuando vuelve la conexión, revisa los fichajes que quedaron guardados
// sin poder confirmar la geocerca (bypass 'offline_sin_gps' de arriba)
// y, si hay coordenadas cacheadas de ese momento, valida contra la
// geocerca vigente. No bloquea nada retroactivamente -el fichaje ya
// está hecho, y el rostro ya se verificó-, pero deja constancia
// (geofenceStatus) y genera una alerta si terminó estando fuera de
// rango, para que el administrador lo revise.
async function revalidatePendingGeofenceAttendance() {
    const attendance = getAttendance();
    const pendientes = attendance.filter(a => a.geofenceStatus === 'pendiente_geocerca' && a.coords);
    if (pendientes.length === 0) return;

    const geofence = await fetchFreshAppDataValue('geofence', getGeofenceConfig);
    let changed = false;
    for (const registro of pendientes) {
        const distance = haversineDistanceMeters(registro.coords.lat, registro.coords.lng, geofence.lat, geofence.lng);
        registro.geofenceStatus = distance <= geofence.radio ? 'validado_dentro_de_rango' : 'validado_fuera_de_rango';
        registro.geofenceDistanciaMts = Math.round(distance);
        // Unificado con el campo que usa el fichaje online normal (ver
        // geoFichajeFields()), para que el Reporte de Asistencias no
        // tenga que distinguir "vino de un fichaje offline" o no.
        registro.fichajeLat = registro.coords.lat;
        registro.fichajeLng = registro.coords.lng;
        registro.fichajeDistanciaMts = Math.round(distance);
        registro.dentroGeocerca = registro.geofenceStatus === 'validado_dentro_de_rango';
        // hora_sync: recién ACÁ, al reconectar, se termina de confirmar
        // la ubicación - puede ser mucho después de horaFichajeReal
        // (=timestamp, el momento real en que tocó el botón offline).
        // Esa diferencia es justo lo que marca el badge "DIFERIDO".
        registro.horaFichajeReal = registro.horaFichajeReal || registro.timestamp;
        registro.horaSync = new Date().toISOString();
        registro.syncUbicacion = 'completo';
        changed = true;
        if (registro.geofenceStatus === 'validado_fuera_de_rango') {
            const teacher = getTeacherByNumericId(registro.teacherId);
            if (teacher) {
                createAlert(teacher, 'Geocerca fuera de rango (offline)',
                    `El fichaje de ${registro.teacherName} del ${registro.date} ${registro.time} se guardó sin conexión y, al validar la ubicación al reconectar, resultó a ${Math.round(distance)}mts del punto autorizado.`);
            }
        }
        // Dirección/IP: recién tiene sentido pedirlas acá porque esta
        // función solo corre al reconectar (ver onReconnectSync()) -
        // fire-and-forget, no bloquea el resto de la revalidación.
        // Acá sí se espera (a diferencia del fichaje en vivo): esta
        // función solo corre al reconectar, ya en segundo plano y sin
        // nadie esperando en pantalla, así que no hay motivo para NO
        // esperarla - y evita una condición de carrera si el 'online'
        // dispara la revalidación de nuevo antes de que termine.
        await completarDireccionEIp(registro.id, registro.coords.lat, registro.coords.lng, 'attendance');
    }
    if (changed) saveAttendance(attendance);
}

// Completa (en segundo plano, sin bloquear el fichaje ni la
// revalidación) la dirección legible - Nominatim - y el IP público -
// ipwho.is - de un registro ya guardado, una vez que hay conexión.
// tipo: 'attendance' (busca en getAttendance()) - se deja preparado
// para reusar con otras colecciones si hiciera falta más adelante.
async function completarDireccionEIp(registroId, lat, lng, tipo) {
    if (!navigator.onLine) return;
    const [direccion, ip] = await Promise.all([
        obtenerDireccionPorCoordenadas(lat, lng),
        obtenerIpPublica(),
    ]);
    if (tipo !== 'attendance') return;
    const attendance = getAttendance();
    const registro = attendance.find(a => a.id === registroId);
    if (!registro) return;
    registro.direccionFichaje = direccion;
    registro.ip = ip;
    registro.horaSync = registro.horaSync || new Date().toISOString();
    registro.syncUbicacion = 'completo';
    saveAttendance(attendance);
}

async function obtenerIpPublica() {
    try {
        const res = await fetch('https://ipwho.is/');
        const data = await res.json();
        return (data && data.success !== false) ? (data.ip || null) : null;
    } catch (error) {
        console.error('No se pudo obtener la IP pública:', error);
        return null;
    }
}

// Campos extra que se agregan a un registro de asistencia cuando se
// guardó gracias al bypass 'offline_sin_gps' de verifyGeofence(). No
// se reutiliza el campo "status" existente (present/late) para no
// romper todo lo que ya lee ese campo: la geocerca pendiente es un
// concepto aparte, en su propio campo geofenceStatus.
function pendingGeofenceFields(geo) {
    if (!geo || !geo.pendingGeofence) return {};
    return { geofenceStatus: 'pendiente_geocerca', offline: true, coords: geo.coords || null };
}

// Coordenadas reales de CUALQUIER fichaje con GPS (haya pasado la
// geocerca o no, distinto del mecanismo de pendingGeofenceFields()/
// revalidación offline) y a cuántos metros quedó del punto
// configurado, para el reporte "ubicación real vs configurada" (ver
// generateReport()/generateReportExcel()). Bypasses sin GPS real
// (admin, kiosco, modo prueba) no tienen geo.coords, quedan vacíos.
function geoFichajeFields(geo) {
    if (!geo || !geo.coords) return {};
    return {
        fichajeLat: geo.coords.lat,
        fichajeLng: geo.coords.lng,
        fichajeDistanciaMts: geo.distance != null ? Math.round(geo.distance) : null,
        fichajePrecisionM: geo.precision != null ? geo.precision : null,
        fichajeFakeGpsSospechoso: !!geo.fakeGpsSospechoso,
        // dentroGeocerca: null cuando el fichaje pasó por un bypass sin
        // geocerca real (admin/kiosco/modo prueba/evento sin geocerca) -
        // geo.distance no existe en esos casos. Se usa geo.ok directo (no
        // se recalcula acá) porque ya incluye el margen de precisión del
        // GPS aplicado en verifyGeofence() - recalcular sin ese margen
        // marcaría como "fuera" fichajes que sí se dejaron pasar.
        dentroGeocerca: geo.distance != null ? !!geo.ok : null,
        // horaSync/syncUbicacion se completan de verdad en
        // completarDireccionEIp() (fichaje online: enseguida en
        // segundo plano; offline: recién al reconectar, ver
        // revalidatePendingGeofenceAttendance()) - por eso arrancan
        // en null/'pendiente' acá, incluso para el fichaje online.
        horaSync: null,
        syncUbicacion: 'pendiente',
        direccionFichaje: null,
        ip: null,
    };
}

// Modal informativo (no bloqueante como el de fichaje: acá el
// docente solo necesita enterarse y reintentar, así que sí tiene
// botón de cierre).
function showGeofenceBlockModal(result) {
    const title = document.getElementById('geofenceModalTitle');
    const body = document.getElementById('geofenceModalBody');
    // result.geofence viene de verifyGeofence(): es la geocerca del
    // EVENTO si se le pasó un override (fichaje de Evento Especial con
    // geocerca propia), o la del colegio si no - así el mensaje siempre
    // muestra el lugar/radio contra el que realmente se validó.
    const geofence = result.geofence || getGeofenceConfig();
    const esEvento = !!(result.geofence && result.geofence.esEvento);
    if (result.reason === 'gps') {
        title.innerHTML = '<i class="bi bi-geo-alt-fill"></i> GPS requerido';
        body.innerHTML = `
            <p class="mb-1"><strong>Debes activar GPS para fichar.</strong></p>
            <p class="text-muted small mb-0">Habilitá el permiso de ubicación de este sitio en tu navegador (o activá el GPS del dispositivo) e intentá de nuevo. El sitio necesita conexión HTTPS para poder pedir tu ubicación.</p>`;
    } else {
        const metros = Math.round(result.distance);
        // radioEfectivo ya incluye el margen de precisión del GPS + el
        // colchón fijo (ver verifyGeofence()): es el número real contra
        // el que se decidió "fuera de rango", así que es el que se le
        // muestra al docente (mostrar solo geofence.radio confundía,
        // porque parecía que le faltaban menos metros de los reales).
        const radioMostrado = result.radioEfectivo != null ? Math.round(result.radioEfectivo) : geofence.radio;
        const metrosFaltantes = Math.round(result.distance - radioMostrado);
        title.innerHTML = esEvento
            ? '<i class="bi bi-geo-alt-fill"></i> Estás fuera del área del evento'
            : '<i class="bi bi-geo-alt-fill"></i> Fuera de la zona permitida';
        body.innerHTML = esEvento
            ? `<p class="mb-1">Estás a <strong>${metros} mts</strong> de ${geofence.nombreLugar}.</p>
               <p class="mb-0">Te faltan <strong>${metrosFaltantes} mts</strong> para entrar al radio permitido (${radioMostrado}mts) del evento.</p>`
            : `<p class="mb-1">Estás a <strong>${metros} mts</strong> de ${geofence.nombreLugar}.</p>
               <p class="mb-0">Debes estar a menos de ${radioMostrado}mts.</p>`;
        if (Number.isFinite(result.precision)) {
            body.innerHTML += `<p class="text-muted small mb-0 mt-1">Precisión de tu GPS en este momento: ${result.precision} mts. Probá salir a un lugar más abierto (lejos de paredes/techos) y volver a intentar.</p>`;
        }
    }
    new bootstrap.Modal(document.getElementById('geofenceModal')).show();
}

// ============================================================
// GEOCERCA: mapa interactivo con Leaflet + OpenStreetMap (sin API key).
// Un solo motor (geocercaMaps) reutilizado por las dos geocercas de la
// app: la del colegio ('config', tab Configuración) y la de cada
// Evento Especial ('evento', modal #eventoModal). Click en el mapa o
// arrastre del marcador = guarda lat/lng en los inputs hidden
// correspondientes + reverse geocode con Nominatim.
// ============================================================
const RESISTENCIA_CHACO = { lat: -27.4511, lng: -58.9853 };
const geocercaMaps = {}; // key ('config' | 'evento') -> { map, marker, circle }

function getGeocercaFieldIds(key) {
    return key === 'evento'
        ? { latId: 'eventoGeocercaLat', lngId: 'eventoGeocercaLng', radioId: 'eventoGeocercaRadio', direccionId: 'direccion-seleccionada-evento', linkId: 'eventoGeocercaMapLink' }
        : { latId: 'geofenceLat', lngId: 'geofenceLng', radioId: 'geofenceRadius', direccionId: 'direccion-seleccionada', linkId: 'geofenceMapLink' };
}

function getGeocercaRadius(key) {
    const { radioId } = getGeocercaFieldIds(key);
    const el = document.getElementById(radioId);
    const val = el ? parseInt(el.value, 10) : NaN;
    return Number.isFinite(val) && val > 0 ? val : 110;
}

function initGeocercaMap(key, containerId) {
    if (geocercaMaps[key]) return geocercaMaps[key];
    // Opciones explícitas (en vez de confiar en los defaults de Leaflet)
    // para que el mapa se pueda arrastrar con el dedo en celular:
    // dragging/touchZoom/tap/doubleClickZoom en true, y scrollWheelZoom
    // en false para que la rueda del mouse en desktop no "atrape" el
    // scroll de la página al pasar por encima del mapa.
    const map = L.map(containerId, {
        dragging: true,
        touchZoom: true,
        tap: true,
        doubleClickZoom: true,
        scrollWheelZoom: false,
    }).setView([RESISTENCIA_CHACO.lat, RESISTENCIA_CHACO.lng], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    const instance = { map, marker: null, circle: null };
    geocercaMaps[key] = instance;
    map.on('click', e => setGeocercaPoint(key, e.latlng.lat, e.latlng.lng, true));
    return instance;
}

function setGeocercaPoint(key, lat, lng, reverseGeocode) {
    const instance = geocercaMaps[key];
    if (!instance) return;
    const { latId, lngId, linkId } = getGeocercaFieldIds(key);
    const radio = getGeocercaRadius(key);

    document.getElementById(latId).value = lat;
    document.getElementById(lngId).value = lng;
    const linkEl = document.getElementById(linkId);
    if (linkEl) linkEl.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;

    if (instance.marker) {
        instance.marker.setLatLng([lat, lng]);
    } else {
        instance.marker = L.marker([lat, lng], { draggable: true }).addTo(instance.map);
        instance.marker.on('dragend', () => {
            const pos = instance.marker.getLatLng();
            setGeocercaPoint(key, pos.lat, pos.lng, true);
        });
    }
    if (instance.circle) {
        instance.circle.setLatLng([lat, lng]).setRadius(radio);
    } else {
        instance.circle = L.circle([lat, lng], { radius: radio, color: '#0066FF', fillOpacity: 0.15 }).addTo(instance.map);
    }
    instance.map.setView([lat, lng], Math.max(instance.map.getZoom(), 16));

    if (reverseGeocode) reverseGeocodeGeocerca(key, lat, lng);
}

function updateGeocercaCircleRadius(key) {
    const instance = geocercaMaps[key];
    if (!instance || !instance.circle) return;
    instance.circle.setRadius(getGeocercaRadius(key));
}

async function reverseGeocodeGeocerca(key, lat, lng) {
    const { direccionId } = getGeocercaFieldIds(key);
    const el = document.getElementById(direccionId);
    if (el) el.textContent = 'Buscando dirección...';
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`, { headers: { 'Accept-Language': 'es' } });
        const data = await res.json();
        if (el) el.textContent = data.display_name || 'Dirección no encontrada';
    } catch (error) {
        console.error('Error en reverse geocode:', error);
        if (el) el.textContent = 'No se pudo obtener la dirección';
    }
}

// Como reverseGeocodeGeocerca(), pero devuelve el texto en vez de
// escribirlo en un campo del formulario de geocerca - lo usa
// obtenerUbicacionParaLog() para armar "Ciudad, Provincia" en vez del
// display_name completo de Nominatim (muy largo para una tabla/log).
async function obtenerDireccionPorCoordenadas(lat, lng) {
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`, { headers: { 'Accept-Language': 'es' } });
        const data = await res.json();
        const a = data.address || {};
        const localidad = a.city || a.town || a.village || a.suburb || a.municipality;
        return [localidad, a.state].filter(Boolean).join(', ') || data.display_name || null;
    } catch (error) {
        console.error('Error en reverse geocode:', error);
        return null;
    }
}

// Ubicación de alta precisión para el log de auditoría: SOLO GPS del
// navegador, NUNCA por IP. La geolocalización por IP resuelve la
// dirección registrada del ISP, no la posición real del dispositivo -
// en conexiones móviles/rurales puede devolver una ciudad a cientos o
// miles de km de distancia (se detectó justo eso en producción: un
// fichaje real en Ituzaingó seguido, segundos después, de un login
// "en Dique Luján, Buenos Aires" - geográficamente imposible). Mejor
// dejar la ubicación pendiente que guardar una falsa.
//
// Hasta 3 intentos (cada uno hasta 15s, maximumAge:0 para no reusar
// una posición vieja cacheada), se queda con el de mejor precisión
// (accuracy más chico, en metros). Si ni el mejor de los 3 baja de
// UBICACION_ACCURACY_MAX_M, se descarta entero - se reintenta después
// (ver completarUbicacionLog()/reintentarLogsPendientes() en
// auditoria.js), nunca se guarda una ubicación de baja precisión.
const UBICACION_ACCURACY_MAX_M = 100;
const UBICACION_INTENTOS = 3;

async function obtenerUbicacionParaLog() {
    let mejor = null;
    for (let i = 0; i < UBICACION_INTENTOS; i++) {
        try {
            const position = await new Promise((resolve, reject) => {
                if (!navigator.geolocation) { reject({ code: 'unsupported' }); return; }
                navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
            });
            const accuracy = Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : Infinity;
            if (!mejor || accuracy < mejor.accuracy) {
                mejor = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy, coords: position.coords };
            }
            if (accuracy <= 30) break; // ya es buena, no hace falta gastar más intentos
        } catch (error) {
            console.error(`Intento ${i + 1}/${UBICACION_INTENTOS} de GPS para el log falló:`, error);
        }
    }
    if (!mejor || mejor.accuracy > UBICACION_ACCURACY_MAX_M) return null;
    const direccion = await obtenerDireccionPorCoordenadas(mejor.lat, mejor.lng);
    return {
        lat: mejor.lat, lng: mejor.lng, direccion, ip: null, fuente: 'gps',
        precision: Math.round(mejor.accuracy),
        fakeGpsSospechoso: esGpsSospechoso(mejor.coords),
    };
}

async function buscarGeocercaDireccion(key, query) {
    if (!query || query.trim().length < 3) return;
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ar&q=${encodeURIComponent(query)}`, { headers: { 'Accept-Language': 'es' } });
        const results = await res.json();
        if (!results.length) { showToast('No se encontró esa dirección', 'warning'); return; }
        const lat = parseFloat(results[0].lat);
        const lng = parseFloat(results[0].lon);
        setGeocercaPoint(key, lat, lng, false);
        const instance = geocercaMaps[key];
        if (instance) instance.map.setView([lat, lng], 17);
        const { direccionId } = getGeocercaFieldIds(key);
        const el = document.getElementById(direccionId);
        if (el) el.textContent = results[0].display_name;
    } catch (error) {
        console.error('Error buscando dirección:', error);
        showToast('No se pudo buscar esa dirección', 'error');
    }
}

function wireGeocercaSearchInput(key, inputId) {
    const input = document.getElementById(inputId);
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            buscarGeocercaDireccion(key, input.value);
        }
    });
}

// Verifica que la geocerca tenga lat/lng cargados (marcados en el mapa)
// antes de permitir guardar.
function validarGeocerca(latId, lngId) {
    const lat = parseFloat(document.getElementById(latId).value);
    const lng = parseFloat(document.getElementById(lngId).value);
    return Number.isFinite(lat) && Number.isFinite(lng);
}

function resetGeocercaMap(key) {
    const instance = geocercaMaps[key];
    if (!instance) return;
    if (instance.marker) { instance.map.removeLayer(instance.marker); instance.marker = null; }
    if (instance.circle) { instance.map.removeLayer(instance.circle); instance.circle = null; }
    instance.map.setView([RESISTENCIA_CHACO.lat, RESISTENCIA_CHACO.lng], 15);
    const { direccionId } = getGeocercaFieldIds(key);
    const el = document.getElementById(direccionId);
    if (el) el.textContent = 'Hacé clic en el mapa, buscá una dirección o usá tu ubicación actual.';
}

function useMyLocationForGeocerca(key) {
    if (!navigator.geolocation) { showToast('Este navegador no soporta geolocalización', 'error'); return; }
    showToast('Obteniendo tu ubicación actual...', 'info');
    navigator.geolocation.getCurrentPosition(
        pos => {
            setGeocercaPoint(key, pos.coords.latitude, pos.coords.longitude, true);
            showToast('✅ Ubicación actual cargada en el formulario. Revisá y guardá.', 'success');
        },
        error => {
            console.error('No se pudo obtener la ubicación actual:', error);
            showToast('No se pudo obtener tu ubicación actual', 'error');
        },
        { enableHighAccuracy: true, timeout: 15000 }
    );
}

// Los mapas se crean mientras su contenedor puede estar oculto (tab
// pane / modal todavía no mostrados), y Leaflet calcula mal el tamaño
// en ese caso: hay que forzar un recálculo cuando se muestran.
document.addEventListener('DOMContentLoaded', () => {
    const tabConfigBtn = document.querySelector('[data-bs-target="#tabConfiguracion"]');
    if (tabConfigBtn) {
        tabConfigBtn.addEventListener('shown.bs.tab', () => {
            if (geocercaMaps.config) geocercaMaps.config.map.invalidateSize();
        });
    }
    const eventoModalEl = document.getElementById('eventoModal');
    if (eventoModalEl) {
        eventoModalEl.addEventListener('shown.bs.modal', () => {
            if (geocercaMaps.evento) geocercaMaps.evento.map.invalidateSize();
        });
    }
});

// ============================================================
// ADMIN > CONFIGURACIÓN > GEOCERCA (formulario) Y DISPOSITIVOS
// (kiosco autorizado)
// ============================================================
function updateGeofenceMapPreview() {
    initGeocercaMap('config', 'geofenceMapContainer');
    wireGeocercaSearchInput('config', 'buscador-geocerca');
    const lat = parseFloat(document.getElementById('geofenceLat').value);
    const lng = parseFloat(document.getElementById('geofenceLng').value);
    if (Number.isFinite(lat) && Number.isFinite(lng)) setGeocercaPoint('config', lat, lng, true);
    setTimeout(() => geocercaMaps.config && geocercaMaps.config.map.invalidateSize(), 200);
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

    // Geocerca: exclusiva de Rector/Programador (ver MATRIZ_PERMISOS).
    // Secretaría puede ver la pantalla pero no guardar/restablecer.
    const puedeEditarGeo = tienePermiso(currentUser.rol, 'editar_geo');
    const saveBtn = document.getElementById('geofenceSaveBtn');
    const resetBtn = document.getElementById('geofenceResetBtn');
    if (saveBtn) saveBtn.disabled = !puedeEditarGeo;
    if (resetBtn) resetBtn.disabled = !puedeEditarGeo;
}

async function saveGeofenceAdminForm() {
    if (!tienePermiso(currentUser.rol, 'editar_geo')) {
        showToast(mensajeSinPermiso('editar_geo'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó guardar la geocerca de la escuela sin permiso');
        return;
    }
    const lat = parseFloat(document.getElementById('geofenceLat').value);
    const lng = parseFloat(document.getElementById('geofenceLng').value);
    const radio = parseInt(document.getElementById('geofenceRadius').value, 10);
    const nombreLugar = document.getElementById('geofenceName').value.trim() || DEFAULT_GEOFENCE_CONFIG.nombreLugar;
    if (!validarGeocerca('geofenceLat', 'geofenceLng')) { showToast('Marcá una ubicación en el mapa antes de guardar', 'error'); return; }
    if (!Number.isFinite(radio) || radio < 150 || radio > 500) { showToast('El radio debe estar entre 150 y 500 metros (con menos, el GPS de un celular común en Argentina rebota y bloquea fichajes válidos)', 'error'); return; }
    const resultado = await persistToSupabaseEsperando('geofence', {
        lat, lng, radio, nombreLugar,
        actualizadoPor: currentUser ? (currentUser.username || currentUser.dni || 'admin') : 'admin',
        actualizadoEn: new Date().toISOString(),
    });
    loadGeofenceAdminForm();
    if (resultado.ok) logAccion('EDITAR_GEOCERCA', `Actualizó la ubicación de fichaje a "${nombreLugar}" (${lat}, ${lng}), radio ${radio}m`);
    toastSegunConfirmacion(resultado, '✅ Ubicación de fichaje guardada');
}

async function resetGeofenceAdminForm() {
    if (!tienePermiso(currentUser.rol, 'editar_geo')) {
        showToast(mensajeSinPermiso('editar_geo'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó restablecer la geocerca de la escuela sin permiso');
        return;
    }
    const resultado = await persistToSupabaseEsperando('geofence', {
        ...DEFAULT_GEOFENCE_CONFIG,
        actualizadoPor: currentUser ? (currentUser.username || currentUser.dni || 'admin') : 'admin',
        actualizadoEn: new Date().toISOString(),
    });
    loadGeofenceAdminForm();
    if (resultado.ok) logAccion('EDITAR_GEOCERCA', 'Restableció la ubicación de fichaje al valor por defecto');
    toastSegunConfirmacion(resultado, 'Ubicación restablecida al Colegio Secundario De San Carlos');
}

// Atajo para cargar rápido la ubicación real (parado en la escuela,
// o en la plaza/salón de un acto) sin tener que buscar coordenadas.
function useCurrentLocationForGeofence() {
    useMyLocationForGeocerca('config');
}

// ============================================================
// GEOCERCA POR EVENTO ESPECIAL
// Mismo motor que la geocerca del colegio (geocercaMaps / setGeocercaPoint
// más arriba), con su propia instancia de mapa ('evento'). Vive dentro
// del modal de Nuevo/Editar Evento Especial (#eventoModal).
// ============================================================
function toggleEventoGeocerca(checked) {
    document.getElementById('eventoGeocercaFields').classList.toggle('hidden', !checked);
    if (checked) updateEventoGeocercaMapPreview();
}

function updateEventoGeocercaMapPreview() {
    initGeocercaMap('evento', 'eventoGeocercaMapContainer');
    wireGeocercaSearchInput('evento', 'buscador-geocerca-evento');
    updateGeocercaCircleRadius('evento');
    const lat = parseFloat(document.getElementById('eventoGeocercaLat').value);
    const lng = parseFloat(document.getElementById('eventoGeocercaLng').value);
    if (Number.isFinite(lat) && Number.isFinite(lng)) setGeocercaPoint('evento', lat, lng, false);
    setTimeout(() => geocercaMaps.evento && geocercaMaps.evento.map.invalidateSize(), 200);
}

function useCurrentLocationForEventoGeocerca() {
    useMyLocationForGeocerca('evento');
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

const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const FULL_DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// ============================================================
// FECHA/HORA EN ARGENTINA: fuente única para "hoy"/"ahora" en toda
// la lógica de asistencia (fichaje, faltas, "Esperados Hoy", ventana
// de salida). Argentina está en UTC-3 todo el año (no tiene horario
// de verano desde 2009), pero acá se fuerza la zona horaria EXPLÍCITA
// con Intl en vez de confiar en:
//   - new Date().toISOString() -> SIEMPRE es UTC, nunca la hora de
//     Argentina.
//   - new Date().getDay()/getHours() -> usan la zona horaria que
//     tenga configurada el propio dispositivo (PC de secretaría,
//     tablet de kiosco, celular del docente), que puede estar mal
//     puesta o en otro huso.
//
// Bug real reportado ("Esperados Hoy" en 0 / día equivocado): varias
// funciones de fichaje guardaban `date` con toISOString() (UTC) pero
// calculaban a qué día de la semana correspondía ("todayDay") con
// getDay() (hora local del dispositivo). A partir de las 21hs en
// Argentina, toISOString() YA está en el día siguiente en UTC (21:50
// ARG = 00:50 UTC del día siguiente) mientras que getDay() todavía
// decía el día real - un fichaje de esa franja horaria quedaba
// guardado con la fecha de MAÑANA, y dejaba de calzar con el bloque
// de horario de HOY en "Esperados Hoy", "Mi último fichaje", Fichaje
// Manual, etc. Reemplaza todos los new Date().toISOString()/getDay()/
// getHours() usados para "hoy"/"ahora" en fichaje y asistencia.
const ARGENTINA_TZ = 'America/Argentina/Buenos_Aires';
function getFechaHoyArgentina(date) {
    // en-CA imprime directo en formato YYYY-MM-DD (mismo formato que
    // ya usaba toISOString().split('T')[0] en todos lados).
    return (date || new Date()).toLocaleDateString('en-CA', { timeZone: ARGENTINA_TZ });
}
function getDiaSemanaArgentina(date) {
    const nombre = (date || new Date()).toLocaleDateString('es-AR', { timeZone: ARGENTINA_TZ, weekday: 'long' });
    return nombre.charAt(0).toUpperCase() + nombre.slice(1); // 'lunes' -> 'Lunes', matchea FULL_DAYS/DAYS
}
function getHoraHHMMArgentina(date) {
    return (date || new Date()).toLocaleTimeString('es-AR', { timeZone: ARGENTINA_TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}
function getHoraHHMMSSArgentina(date) {
    return (date || new Date()).toLocaleTimeString('es-AR', { timeZone: ARGENTINA_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function getMinutosDesdeMedianocheArgentina(date) {
    const [h, m] = getHoraHHMMArgentina(date).split(':').map(Number);
    return h * 60 + m;
}

// Fecha REAL (Argentina) de un fichaje: se recalcula siempre desde
// `timestamp` (el instante real capturado con toISOString(), nunca
// ambiguo) en vez de confiar ciegamente en el campo `date` ya
// guardado. Así, un fichaje cuyo `date` haya quedado desincronizado
// por el bug viejo de huso horario (ver getFechaHoyArgentina() más
// arriba) se filtra bien en "Esperados Hoy"/hasEntryToday/etc. SIN
// depender de que alguien corra antes la reparación manual
// (repararFechasFichajes()) - la corrección queda al día
// automáticamente para cualquier lógica que compare "es de hoy".
// Fallback al `date` guardado solo si no hay timestamp (fichajes
// viejísimos, o el bypass offline_sin_gps que puede no tenerlo).
function getFechaRealFichaje(registro) {
    if (registro && registro.timestamp) {
        const instante = new Date(registro.timestamp);
        if (!isNaN(instante.getTime())) return getFechaHoyArgentina(instante);
    }
    return registro ? registro.date : null;
}

// Repara `date`/`time` de fichajes que quedaron mal calculados por el
// bug de huso horario de más arriba (ver getFechaHoyArgentina()):
// registros escritos ANTES de ese fix guardaban `date` con
// new Date().toISOString() (UTC), así que un fichaje de noche (21hs+
// en Argentina) podía quedar fechado un día adelantado - y esos
// fichajes viejos siguen mal en la base aunque el código ya esté
// arreglado (el fix solo corrige los fichajes NUEVOS, no repara los
// que ya se guardaron mal). `timestamp` (el instante real capturado
// con Date.toISOString(), que es un instante único y no sufre este
// problema - la ambigüedad es solo al separarlo en fecha/hora local)
// nunca tuvo este problema, así que sirve de fuente de verdad para
// recalcular `date`/`time` correctos. Bug real reportado: un fichaje
// del domingo 21:50 seguía apareciendo como "hoy" en Esperados Hoy el
// lunes siguiente, porque su `date` había quedado guardado con la
// fecha del lunes.
// Solo toca date/time (nunca status/type/geo/etc.) y solo en los
// registros donde de verdad no coinciden - así es segura de correr
// más de una vez (converge a "no hay nada para reparar").
async function repararFechasFichajes() {
    if (!tienePermiso(currentUser.rol, 'backup_restore')) {
        showToast(mensajeSinPermiso('backup_restore'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó reparar fechas de fichajes sin permiso');
        return;
    }
    const attendance = getAttendance();
    const afectados = [];
    attendance.forEach(a => {
        if (!a.timestamp) return; // sin timestamp no hay de dónde recalcular: se deja como está
        const instante = new Date(a.timestamp);
        if (isNaN(instante.getTime())) return;
        const fechaCorrecta = getFechaHoyArgentina(instante);
        const horaCorrecta = getHoraHHMMSSArgentina(instante);
        if (a.date !== fechaCorrecta) {
            afectados.push({ id: a.id, teacherName: a.teacherName, dateAntes: a.date, dateDespues: fechaCorrecta });
            a.date = fechaCorrecta;
            a.time = horaCorrecta;
        }
    });
    if (afectados.length === 0) {
        showToast('No se encontraron fichajes con la fecha desincronizada. No hay nada para reparar.', 'info');
        return;
    }
    if (!confirm(`Se encontraron ${afectados.length} fichaje(s) con la fecha mal calculada por un bug de huso horario ya corregido en el código (esto solo repara datos viejos, no cambia nada del comportamiento actual). ¿Corregir su fecha/hora ahora? No se puede deshacer - se recomienda descargar un backup antes si no se hizo.`)) return;

    saveAttendance(attendance);
    logAccion('REPARAR_FECHAS_FICHAJES', `Corrigió la fecha de ${afectados.length} fichaje(s) desincronizados por el bug de huso horario: ${afectados.map(a => `${a.teacherName} (${a.dateAntes} -> ${a.dateDespues})`).join('; ')}`);
    showToast(`✅ Se corrigieron ${afectados.length} fichaje(s) con fecha desincronizada`, 'success');
    renderDocentesEsperadosHoy();
    checkFaltas();
}

const START_HOUR = 7;
const END_HOUR = 23;
const SCHEDULE_CALENDAR_YEAR = 2026;

let currentUser = null;
// Rol elegido en el paso 1 de la pantalla de login (ROLES.DOCENTE/
// SECRETARIA/RECTOR/PROGRAMADOR, ver roles.js), antes de escribir
// usuario/contraseña.
let selectedRole = null;
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
// Cuál de sus materias eligió el docente para fichar hoy (ver
// renderMateriaFichajeInfo()) - null si todavía no tiene materias
// asignadas (usa su horario_laboral propio) o si tiene una sola (se
// autoselecciona sola, sin mostrar nada para elegir).
let materiaFichajeSeleccionada = null;
let annualCalendarByDate = {}; // último cálculo de showAnnualCalendar(), usado por showDayDetail()
// Estado de la Grilla Completa de Horarios (vista semana): offset de
// semanas respecto de la actual (0 = semana de hoy, -1 = anterior,
// 1 = siguiente) y los filtros activos. Se reinicia cada vez que se
// abre el modal (showFullScheduleGrid()).
let grillaSemanaOffset = 0;
let grillaFiltro = { profesor: '', materia: '', carrera: '', estado: '' };
let grillaEntriesPorCelda = {}; // `${teacherId}_${dateStr}_${inicio}` -> entry, usado por showGridCellDetail()
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

// Además de subir lo pendiente (flushPendingSync), revalida contra la
// geocerca vigente cualquier fichaje que se haya guardado offline sin
// poder confirmar la ubicación (ver verifyGeofence/
// revalidatePendingGeofenceAttendance). flushPendingSync() en sí no se
// toca: sigue siendo la función genérica de sincronización diferida,
// ya cubierta por sus propias pruebas.
async function onReconnectSync() {
    await flushPendingSync();
    await revalidatePendingGeofenceAttendance();
    if (typeof reintentarLogsPendientes === 'function') await reintentarLogsPendientes();
}

window.addEventListener('online', onReconnectSync);
window.addEventListener('offline', () => {
    showToast('Sin conexión a internet. Los cambios se guardarán en este dispositivo y se subirán solos al reconectar.', 'warning');
});
// Respaldo por si el evento 'online' no es confiable (p. ej. wifi
// conectado pero sin salida real a internet): reintenta cada 20s
// mientras queden claves pendientes.
setInterval(() => {
    if (getPendingSyncKeys().length > 0) onReconnectSync();
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

// Como persistToSupabase(), pero para las pocas acciones donde el
// toast de éxito tiene que esperar la confirmación real de Supabase en
// vez de ser optimista (ver saveCriteria()/saveGeofenceAdminForm()):
// devuelve el resultado en vez de mostrar un toast genérico solo.
async function persistToSupabaseEsperando(key, value) {
    dataStore[key] = value;
    writeLocalCache(key, value);
    if (!sb) {
        markPendingSync(key);
        return { ok: false, offline: true };
    }
    try {
        const { error } = await sb.from('app_data')
            .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
        if (error) throw error;
        clearPendingSync(key);
        supabaseAvailable = true;
        return { ok: true };
    } catch (error) {
        console.error('Error guardando "' + key + '" en Supabase:', error);
        markPendingSync(key);
        supabaseAvailable = false;
        return { ok: false, error };
    }
}

function toastSegunConfirmacion({ ok, offline, error }, mensajeExito) {
    if (ok) {
        showToast(mensajeExito, 'success');
    } else if (offline) {
        showToast('Sin conexión: se guardó en este dispositivo y se sincronizará solo al reconectar.', 'warning');
    } else {
        showToast('No se pudo confirmar el guardado (' + describeSupabaseError(error) + '). Se guardó localmente y se sincronizará al reconectar.', 'warning');
    }
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
        minHours: criteria.minHours || CONFIG.MIN_HOURS,
        // Criterios de puntualidad (semáforo de "Docentes que deberían
        // presentarse hoy" en Inicio, ver getDocentesEsperadosHoy()):
        // minutos desde la hora asignada, cada uno el techo del
        // anterior. Defaults en CRITERIA_PUNTUALIDAD_DEFAULT
        // (presencia-logic.js): 15/30/60, pedidos explícitamente por el
        // instituto (0-15 Presente, 16-30 Tardanza, 31-60 Media Falta,
        // +60 Ausente) - reemplaza al default viejo de 10/15/20.
        limitePresenteMin: criteria.limitePresenteMin ?? CRITERIA_PUNTUALIDAD_DEFAULT.limitePresenteMin,
        limiteTardanzaMin: criteria.limiteTardanzaMin ?? CRITERIA_PUNTUALIDAD_DEFAULT.limiteTardanzaMin,
        limiteMediaFaltaMin: criteria.limiteMediaFaltaMin ?? CRITERIA_PUNTUALIDAD_DEFAULT.limiteMediaFaltaMin,
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
        // Nota: la app solo usa TinyFaceDetector (ver detectorOptions más
        // abajo, y getDescriptorFromImageElement/VideoElement), así que
        // solo se cargan los 3 modelos que realmente se usan. No se carga
        // SsdMobilenetv1: no lo usa ninguna detección real, y agregarlo
        // sumaría ~5.5MB de descarga innecesaria en cada login (justo lo
        // que se quiere evitar en una app pensada para andar bien con wifi
        // de escuela / en modo avión).
        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(CONFIG.FACE_MODELS_URL),
            faceapi.nets.faceLandmark68Net.loadFromUri(CONFIG.FACE_MODELS_URL),
            faceapi.nets.faceRecognitionNet.loadFromUri(CONFIG.FACE_MODELS_URL)
        ]);
        detectorOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
        modelsLoaded = true;
        console.log('Modelos faciales cargados OK');
        setModelsBanner('ok', '<i class="bi bi-check-circle"></i> Módulo de reconocimiento facial listo');
    } catch (error) {
        console.error('No se pudieron cargar los modelos de reconocimiento facial:', error);
        modelsLoaded = false;
        // El error se muestra solo donde el reconocimiento facial se usa de
        // verdad (registro de docente y fichaje), nunca en la pantalla de
        // login: ahí solo se pide DNI/contraseña, que no depende de esto -
        // no tiene sentido asustar a nadie con un error de cámara antes de
        // haber iniciado sesión.
        setModelsBanner('error', '<i class="bi bi-exclamation-triangle"></i> No se pudo cargar el reconocimiento facial. Verificá tu conexión a internet.', { excludeLogin: true });
    }
}

function setModelsBanner(state, html, options) {
    const excludeLogin = options && options.excludeLogin;
    document.querySelectorAll('.models-banner').forEach(el => {
        if (excludeLogin && el.id === 'loginModelsBanner') {
            el.classList.add('hidden');
            return;
        }
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
// Paso 1 del login: elige rol y pasa al paso 2 (usuario/contraseña),
// adaptando la etiqueta del campo usuario (DNI para docente, Usuario
// para los 3 roles de tipo admin).
function selectRole(role) {
    selectedRole = role;
    document.getElementById('roleSelectStep').classList.add('hidden');
    document.getElementById('credentialsStep').classList.remove('hidden');
    document.getElementById('selectedRoleLabel').textContent = ROL_LABEL[role] || role;
    document.getElementById('loginUserLabel').textContent = role === ROLES.DOCENTE ? 'Usuario (DNI)' : 'Usuario';
    document.getElementById('loginUser').placeholder = role === ROLES.DOCENTE ? 'Ingresa tu DNI' : 'Ingresa tu usuario';
    document.getElementById('loginUser').value = '';
    document.getElementById('loginPass').value = '';
    document.getElementById('loginError').style.display = 'none';
    document.getElementById('loginUser').focus();
}

function backToRoleSelect() {
    selectedRole = null;
    document.getElementById('credentialsStep').classList.add('hidden');
    document.getElementById('roleSelectStep').classList.remove('hidden');
}

async function login() {
    if (!dataLoaded || !adminUsuario) {
        showToast('Todavía se están cargando los datos, esperá un momento e intentá de nuevo', 'warning');
        return;
    }
    if (!selectedRole) { showToast('Elegí un rol para continuar', 'warning'); return; }
    if (!window.crypto || !window.crypto.subtle) {
        // sha256Hex() necesita Web Crypto (solo disponible en HTTPS o
        // localhost). Sin esto no hay forma segura de validar Secretaría/
        // Rector/Programador.
        showToast('Este navegador/conexión no permite validar credenciales de forma segura (hace falta HTTPS)', 'error');
        return;
    }
    const user = document.getElementById('loginUser').value.trim();
    const pass = document.getElementById('loginPass').value.trim();
    const errorEl = document.getElementById('loginError');
    let ok = false;

    if (selectedRole === ROLES.DOCENTE) {
        const teachers = getTeachers();
        const teacher = teachers.find(t => t.dni === user && t.password === pass);
        if (teacher) {
            currentUser = { role: 'teacher', rol: ROLES.DOCENTE, ...teacher };
            // ubicacion explícita en null (no "sin pasar"): a diferencia
            // del resto de las acciones, acá NO se intenta GPS en
            // segundo plano - el docente ya lo va a hacer segundos
            // después al fichar (con todo el pipeline de geocerca), pedir
            // el permiso 2 veces sería redundante y confuso.
            logAccion('LOGIN', `Login docente DNI ${teacher.dni}`, null);
            ok = true;
        }
    } else if (selectedRole === ROLES.PROGRAMADOR) {
        if (user === PROGRAMADOR_LOGIN_USER) {
            // Si ya existe una fila real en `usuarios` (Supabase o su
            // caché local), la contraseña vigente vive ahí en texto
            // plano - es un dato de runtime propio de esta escuela,
            // nunca estuvo comprometido en git. Recién clonado el repo
            // (sin esa fila todavía) se valida contra el hash de
            // arranque de config.secrets.js/config.example.js.
            if (adminUsuario.id) {
                ok = pass === adminUsuario.password;
            } else {
                ok = await coincideHashCredencial('PROGRAMADOR_BOOTSTRAP', pass);
            }
        }
        if (ok) {
            currentUser = { role: 'admin', rol: ROLES.PROGRAMADOR, username: PROGRAMADOR_LOGIN_USER };
            // 2 argumentos a propósito (sin ubicacion): logAccion() ya
            // intenta GPS de alta precisión en segundo plano sola, sin
            // bloquear el login - no hace falta un wrapper aparte.
            logAccion('LOGIN', 'Login PROGRAMADOR');
        }
    } else {
        const usuarioEsperado = CREDENCIALES_ADMIN_USUARIO[selectedRole];
        if (usuarioEsperado && user === usuarioEsperado && await coincideHashCredencial(selectedRole, pass)) {
            currentUser = { role: 'admin', rol: selectedRole, username: usuarioEsperado };
            logAccion('LOGIN', `Login ${selectedRole}`);
            ok = true;
        }
    }

    if (ok) { showDashboard(); return; }
    errorEl.style.display = 'block';
    logAccion('LOGIN_FALLIDO', `Intento fallido - rol elegido: ${selectedRole}, usuario: ${user}`);
    setTimeout(() => errorEl.style.display = 'none', 3000);
}

function logout() {
    if (currentUser) logAccion('LOGOUT', `Logout ${currentUser.username || currentUser.dni || ''}`);
    currentUser = null;
    selectedRole = null;
    recognizedTeacher = null;
    isFaceVerified = false;
    materiaFichajeSeleccionada = null;
    lastLivenessResult = null;
    stopLiveOverlay();
    stopRegLiveOverlay();
    stopExitWindowPoll();
    document.getElementById('dashboardScreen').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('credentialsStep').classList.add('hidden');
    document.getElementById('roleSelectStep').classList.remove('hidden');
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
    teachers[index].debeCambiarPassword = false;
    saveTeachers(teachers);
    currentUser.password = newPass;
    currentUser.debeCambiarPassword = false;
    logAccion('CAMBIO_PASSWORD', `Docente DNI ${currentUser.dni} cambió su contraseña`);

    unforceChangePasswordModal();
    const modal = bootstrap.Modal.getInstance(document.getElementById('changePasswordModal'));
    if (modal) modal.hide();
    resetChangePasswordForm();
    showToast('✅ Contraseña actualizada correctamente', 'success');
}

// Fuerza el modal de "Cambiar Contraseña" a abrirse sin posibilidad de
// cerrarlo (backdrop estático, sin tecla Escape, sin botón de cierre)
// cuando el docente todavía tiene la contraseña por defecto o recién
// se la blanquearon. unforceChangePasswordModal() lo vuelve a dejar
// como un modal normal una vez que la cambia.
function forceChangePasswordModal() {
    const modalEl = document.getElementById('changePasswordModal');
    modalEl.setAttribute('data-bs-backdrop', 'static');
    modalEl.setAttribute('data-bs-keyboard', 'false');
    document.getElementById('changePasswordCloseBtn').classList.add('hidden');
    document.getElementById('changePasswordCancelBtn').classList.add('hidden');
    document.getElementById('changePasswordForcedBanner').classList.remove('hidden');
    resetChangePasswordForm();
    new bootstrap.Modal(modalEl, { backdrop: 'static', keyboard: false }).show();
}

function unforceChangePasswordModal() {
    const modalEl = document.getElementById('changePasswordModal');
    modalEl.removeAttribute('data-bs-backdrop');
    modalEl.removeAttribute('data-bs-keyboard');
    document.getElementById('changePasswordCloseBtn').classList.remove('hidden');
    document.getElementById('changePasswordCancelBtn').classList.remove('hidden');
    document.getElementById('changePasswordForcedBanner').classList.add('hidden');
}

// ============================================================
// CAMBIAR CONTRASEÑA DEL ADMIN (tabla `usuarios`)
// ============================================================
function resetAdminChangePasswordForm() {
    document.getElementById('adminCurrentPasswordInput').value = '';
    document.getElementById('adminNewPasswordInput').value = '';
    document.getElementById('adminConfirmPasswordInput').value = '';
    document.getElementById('adminChangePasswordError').style.display = 'none';
}

async function changeAdminPassword() {
    const errorEl = document.getElementById('adminChangePasswordError');
    const current = document.getElementById('adminCurrentPasswordInput').value;
    const newPass = document.getElementById('adminNewPasswordInput').value;
    const confirm = document.getElementById('adminConfirmPasswordInput').value;

    // Sin fila real en Supabase todavía (bootstrap, ver loadAdminUsuario()):
    // no hay contraseña en texto plano para comparar, se valida contra
    // el hash de arranque.
    const currentOk = adminUsuario.id
        ? current === adminUsuario.password
        : await coincideHashCredencial('PROGRAMADOR_BOOTSTRAP', current);
    if (!currentOk) {
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

    const ok = await guardarUsuarioAdmin({ password: newPass });
    if (!ok) {
        errorEl.textContent = 'No se pudo guardar la nueva contraseña. Probá de nuevo.';
        errorEl.style.display = 'block';
        return;
    }

    logAccion('CAMBIO_PASSWORD', 'PROGRAMADOR cambió su contraseña');
    const modal = bootstrap.Modal.getInstance(document.getElementById('adminChangePasswordModal'));
    if (modal) modal.hide();
    resetAdminChangePasswordForm();
    showToast('✅ Contraseña actualizada correctamente', 'success');
}

// Aplica cambios parciales (password y/o email/email_respaldo/token)
// a la fila del admin en `usuarios`, y actualiza el estado en
// memoria + el caché local. Si Supabase no responde, igual aplica
// el cambio en memoria/local para no dejar al admin bloqueado; se
// resincroniza solo la próxima vez que loadAdminUsuario() encuentre
// conexión.
async function guardarUsuarioAdmin(cambios) {
    const actualizado = { ...adminUsuario, ...cambios };
    if (sb && adminUsuario.id) {
        try {
            const { error } = await sb.from('usuarios').update(cambios).eq('id', adminUsuario.id);
            if (error) {
                console.error('No se pudo actualizar usuarios (admin):', describeSupabaseError(error));
                showToast('No se pudo sincronizar con Supabase, se guardó localmente.', 'warning');
            }
        } catch (e) {
            console.error('No se pudo actualizar usuarios (admin)', e);
            showToast('No se pudo sincronizar con Supabase, se guardó localmente.', 'warning');
        }
    }
    adminUsuario = actualizado;
    localStorage.setItem('sb_cache_admin_usuario', JSON.stringify(adminUsuario));
    return true;
}

// ============================================================
// E-MAIL OBLIGATORIO DEL ADMIN (primer login)
// email_respaldo se fija siempre a SOPORTE_EMAIL: es la cuenta que
// recibe copia de todo pedido de recuperación de contraseña.
// ============================================================
async function guardarAdminEmail() {
    const errorEl = document.getElementById('adminEmailError');
    const email = document.getElementById('adminEmailInput').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errorEl.textContent = 'Ingresá un e-mail válido.';
        errorEl.style.display = 'block';
        return;
    }
    const ok = await guardarUsuarioAdmin({ email: email, email_respaldo: SOPORTE_EMAIL });
    if (!ok) {
        errorEl.textContent = 'No se pudo guardar el e-mail. Probá de nuevo.';
        errorEl.style.display = 'block';
        return;
    }
    const modal = bootstrap.Modal.getInstance(document.getElementById('adminEmailModal'));
    if (modal) modal.hide();
    showToast('✅ E-mail guardado', 'success');
}

// ============================================================
// RECUPERAR CONTRASEÑA (link de un solo uso enviado por e-mail vía
// EmailJS). Solo el ADMIN vive en la tabla `usuarios`, así que es
// el único que puede autorecuperar su contraseña por e-mail; para
// un docente (DNI) se lo redirige directo a soporte.
// ============================================================
function resetForgotPasswordForm() {
    document.getElementById('forgotUserInput').value = '';
    document.getElementById('forgotPasswordMsg').innerHTML = '';
}

function generarResetToken() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    return 'tok' + Date.now() + Math.random().toString(36).slice(2);
}

async function solicitarRecuperacionPassword() {
    const msgEl = document.getElementById('forgotPasswordMsg');
    const input = document.getElementById('forgotUserInput').value.trim();
    const btn = document.getElementById('forgotPasswordSubmitBtn');
    const contactarSoporte = () => {
        msgEl.innerHTML = `<div class="login-error" style="display:block;">Contactá a soporte: ${SOPORTE_EMAIL}</div>`;
    };

    if (!input) {
        msgEl.innerHTML = '<div class="login-error" style="display:block;">Ingresá tu usuario o DNI.</div>';
        return;
    }
    if (!adminUsuario || input.toUpperCase() !== PROGRAMADOR_LOGIN_USER.toUpperCase()) {
        // Docente, Secretaría, Rector u otro usuario desconocido: solo
        // el Programador (MEUDEUS) vive en `usuarios` y tiene
        // autorecuperación por e-mail. El resto tiene contraseña fija
        // o la cambia desde su propio panel.
        contactarSoporte();
        return;
    }
    if (!adminUsuario.email) {
        contactarSoporte();
        return;
    }

    btn.disabled = true;
    try {
        const token = generarResetToken();
        const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const ok = await guardarUsuarioAdmin({ reset_token: token, reset_token_expira: expira });
        if (!ok) {
            msgEl.innerHTML = '<div class="login-error" style="display:block;">No se pudo generar el link de recuperación. Probá de nuevo.</div>';
            return;
        }
        const enviado = await enviarEmailRecuperacion(adminUsuario.email, token, PROGRAMADOR_LOGIN_USER);
        if (enviado) {
            msgEl.innerHTML = '<div class="text-success">✅ Te enviamos un link a tu e-mail para restablecer la contraseña.</div>';
        } else {
            contactarSoporte();
        }
    } finally {
        btn.disabled = false;
    }
}

async function enviarEmailRecuperacion(destinatarioEmail, token, usuario) {
    if (!emailjsConfigurado()) {
        console.warn('EmailJS no está configurado (EMAILJS_PUBLIC_KEY/SERVICE_ID/TEMPLATE_ID en script.js): no se pudo enviar el mail de recuperación.');
        return false;
    }
    const resetLink = `${location.origin}${location.pathname}?resetToken=${token}`;
    try {
        await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
            to_email: destinatarioEmail,
            soporte_email: SOPORTE_EMAIL,
            usuario: usuario,
            reset_link: resetLink
        }, EMAILJS_PUBLIC_KEY);
        return true;
    } catch (e) {
        console.error('Error enviando el e-mail de recuperación', e);
        return false;
    }
}

// Si la URL trae ?resetToken=... (el link del mail), valida el
// token contra `usuarios` y, si es válido y no venció, abre el
// modal para cargar la nueva contraseña.
async function checkResetTokenFromUrl() {
    const params = new URLSearchParams(location.search);
    const token = params.get('resetToken');
    if (!token) return;
    history.replaceState(null, '', location.pathname);

    if (!adminUsuario || adminUsuario.reset_token !== token) {
        showToast('El link de recuperación no es válido o ya fue usado.', 'error');
        return;
    }
    if (!adminUsuario.reset_token_expira || new Date(adminUsuario.reset_token_expira) < new Date()) {
        showToast('El link de recuperación venció. Pedí uno nuevo.', 'error');
        return;
    }
    document.getElementById('resetNewPasswordInput').value = '';
    document.getElementById('resetConfirmPasswordInput').value = '';
    document.getElementById('resetPasswordError').style.display = 'none';
    new bootstrap.Modal(document.getElementById('resetPasswordModal')).show();
}

async function confirmarNuevaPassword() {
    const errorEl = document.getElementById('resetPasswordError');
    const newPass = document.getElementById('resetNewPasswordInput').value;
    const confirm = document.getElementById('resetConfirmPasswordInput').value;

    if (!newPass || newPass.length < 4) {
        errorEl.textContent = 'La nueva contraseña debe tener al menos 4 caracteres.';
        errorEl.style.display = 'block';
        return;
    }
    if (newPass !== confirm) {
        errorEl.textContent = 'Las contraseñas no coinciden.';
        errorEl.style.display = 'block';
        return;
    }

    const ok = await guardarUsuarioAdmin({ password: newPass, reset_token: null, reset_token_expira: null });
    if (!ok) {
        errorEl.textContent = 'No se pudo guardar la nueva contraseña. Probá de nuevo.';
        errorEl.style.display = 'block';
        return;
    }
    const modal = bootstrap.Modal.getInstance(document.getElementById('resetPasswordModal'));
    if (modal) modal.hide();
    showToast('✅ Contraseña actualizada. Ya podés ingresar con la nueva.', 'success');
}

function showDashboard() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('dashboardScreen').classList.remove('hidden');
    document.getElementById('statsScreen').classList.add('hidden');
    if (currentUser.role === 'admin') {
        document.getElementById('adminDashboard').classList.remove('hidden');
        document.getElementById('teacherDashboard').classList.add('hidden');
        document.getElementById('dashboardTitle').textContent = `Panel de ${ROL_LABEL[currentUser.rol] || 'Administración'}`;
        document.getElementById('userRoleBadge').textContent = ROL_LABEL[currentUser.rol] || 'Admin';
        document.getElementById('userRoleBadge').className = 'badge bg-danger me-2';

        // El cambio de contraseña por e-mail (recuperación) es
        // exclusivo de PROGRAMADOR: es el único de los 3 roles admin
        // cuya contraseña vive en la tabla `usuarios` de Supabase y se
        // puede cambiar/recuperar. Secretaría y Rector tienen
        // contraseña fija por hash (ver ASISCAM_CRED_HASHES en roles.js).
        const esProgramador = currentUser.rol === ROLES.PROGRAMADOR;
        document.getElementById('adminChangePasswordBtnDesktop').classList.toggle('hidden', !esProgramador);
        document.getElementById('adminChangePasswordBtnMobile').classList.toggle('hidden', !esProgramador);
        document.getElementById('tabAuditoriaNavItem').classList.toggle('hidden', !tienePermiso(currentUser.rol, 'ver_auditoria'));
        document.getElementById('tabReportesNavItem').classList.toggle('hidden', !tienePermiso(currentUser.rol, 'ver_reportes'));

        loadAdminDashboard();
        resetHorarioLaboralForm();
        if (tienePermiso(currentUser.rol, 'ver_auditoria')) cargarLogsAuditoria().then(renderAuditoriaPanel);
        if (esProgramador && !adminUsuario.email) {
            document.getElementById('adminEmailInput').value = '';
            document.getElementById('adminEmailError').style.display = 'none';
            new bootstrap.Modal(document.getElementById('adminEmailModal')).show();
        }
    } else {
        document.getElementById('adminDashboard').classList.add('hidden');
        document.getElementById('teacherDashboard').classList.remove('hidden');
        document.getElementById('dashboardTitle').textContent = `Bienvenido, ${currentUser.nombre} ${currentUser.apellido}`;
        document.getElementById('userRoleBadge').textContent = 'Docente';
        document.getElementById('userRoleBadge').className = 'badge bg-success me-2';
        loadTeacherDashboard();
        if (currentUser.debeCambiarPassword) forceChangePasswordModal();
    }
}

// ============================================================
// HORARIO LABORAL DEL DOCENTE (alta/edición: día + inicio + fin)
// Se guarda por docente como horario_laboral: [{dia, inicio, fin}].
// ============================================================
const DIAS_HORARIO_RAPIDO = [
    { id: 'horarioRapidoLunes', dia: 'Lunes' },
    { id: 'horarioRapidoMartes', dia: 'Martes' },
    { id: 'horarioRapidoMiercoles', dia: 'Miércoles' },
    { id: 'horarioRapidoJueves', dia: 'Jueves' },
    { id: 'horarioRapidoViernes', dia: 'Viernes' },
    { id: 'horarioRapidoSabado', dia: 'Sábado' },
    { id: 'horarioRapidoDomingo', dia: 'Domingo' },
];

function resetHorarioLaboralForm() {
    horarioLaboralList = [];
    const dia = document.getElementById('horarioDiaInput');
    const inicio = document.getElementById('horarioInicioInput');
    const fin = document.getElementById('horarioFinInput');
    if (dia) dia.selectedIndex = 0;
    if (inicio) inicio.value = '';
    if (fin) fin.value = '';
    DIAS_HORARIO_RAPIDO.forEach(({ id }) => {
        const checkbox = document.getElementById(id);
        if (checkbox) checkbox.checked = false;
    });
    const rapidoInicio = document.getElementById('horarioRapidoInicioInput');
    const rapidoFin = document.getElementById('horarioRapidoFinInput');
    if (rapidoInicio) rapidoInicio.value = '';
    if (rapidoFin) rapidoFin.value = '';
    renderHorarioLaboralChips();
}

// Atajo para el caso típico (mismo horario Lunes a Viernes): tilda los
// días con checkbox y aplica un único inicio/fin a todos de una vez,
// agregándolos a la misma horarioLaboralList que usa el selector
// día-por-día de abajo (incluye el mismo chequeo antiduplicados).
function aplicarHorarioRapido() {
    const inicio = document.getElementById('horarioRapidoInicioInput').value;
    const fin = document.getElementById('horarioRapidoFinInput').value;
    if (!inicio || !fin) { showToast('Completá la hora de inicio y de finalización', 'error'); return; }
    if (fin <= inicio) { showToast('La hora de finalización debe ser posterior a la de inicio', 'error'); return; }

    const diasMarcados = DIAS_HORARIO_RAPIDO.filter(({ id }) => document.getElementById(id).checked);
    if (diasMarcados.length === 0) { showToast('Marcá al menos un día', 'error'); return; }

    let agregados = 0;
    diasMarcados.forEach(({ dia }) => {
        if (horarioLaboralList.some(h => h.dia === dia && h.inicio === inicio && h.fin === fin)) return;
        horarioLaboralList.push({ dia, inicio, fin });
        agregados++;
    });
    renderHorarioLaboralChips();
    showToast(agregados > 0 ? `✅ Horario aplicado a ${agregados} día(s)` : 'Esos horarios ya estaban agregados', agregados > 0 ? 'success' : 'info');
}

function agregarHorarioLaboral() {
    const dia = document.getElementById('horarioDiaInput').value;
    const inicio = document.getElementById('horarioInicioInput').value;
    const fin = document.getElementById('horarioFinInput').value;
    if (!inicio || !fin) { showToast('Completá la hora de inicio y de finalización', 'error'); return; }
    if (fin <= inicio) { showToast('La hora de finalización debe ser posterior a la de inicio', 'error'); return; }
    if (horarioLaboralList.some(h => h.dia === dia && h.inicio === inicio && h.fin === fin)) {
        showToast('Ese horario ya fue agregado', 'warning');
        return;
    }
    horarioLaboralList.push({ dia, inicio, fin });
    document.getElementById('horarioInicioInput').value = '';
    document.getElementById('horarioFinInput').value = '';
    renderHorarioLaboralChips();
}

function quitarHorarioLaboral(index) {
    horarioLaboralList = horarioLaboralList.filter((_, i) => i !== index);
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

// Materias asignadas a un docente: no es un campo nuevo en el docente,
// se deriva de materias.profesor_id (cruzado por dni vía
// materiaProfesorPorDocenteId, ver sección MATERIAS) - un docente
// puede tener 0, 1 o varias, sin límite.
function getMateriasDeDocente(teacherId) {
    if (!teacherId || typeof currentMaterias === 'undefined') return [];
    return currentMaterias.filter(m => {
        if (m.profesor_id == null) return false;
        const profesor = materiaProfesorPorDocenteId[m.profesor_id];
        return profesor && profesor.id === teacherId;
    });
}

// Horario "efectivo" para calendario/grilla/perfil y para el chequeo
// automático de faltas: si el docente tiene 1+ materias asignadas, la
// UNIÓN de los horarios de todas ellas (cada bloque queda etiquetado
// con de qué materia es). Si todavía no tiene ninguna, se sigue
// usando su horario_laboral propio tal cual - a propósito, para no
// dejar sin horario a un docente que no tiene materia asignada
// todavía (ver getHorarioLaboral()).
function getHorarioEfectivo(teacher) {
    const materias = getMateriasDeDocente(teacher.id);
    if (materias.length === 0) return getHorarioLaboral(teacher);
    const bloques = [];
    materias.forEach(m => materiaHorarios(m).forEach(h => bloques.push({ dia: h.dia, inicio: h.inicio, fin: h.fin, materiaId: m.id, materiaNombre: m.nombre })));
    return bloques;
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
    document.querySelector('#tabDocentes .form-section').classList.remove('editing');
    document.getElementById('regExistingPhotoWrap').classList.add('hidden');
    document.getElementById('regExistingPhoto').src = '';
    document.getElementById('regApellido').value = '';
    document.getElementById('regNombre').value = '';
    document.getElementById('regDni').value = '';
    document.getElementById('regMateria').value = '';
    document.getElementById('regTelefono').value = '';
    document.getElementById('regTelefonoFamiliar').value = '';
    document.getElementById('regEmail').value = '';
    document.getElementById('regCalle').value = '';
    document.getElementById('regNumero').value = '';
    document.getElementById('regBarrio').value = '';
    document.getElementById('regLocalidad').value = 'Resistencia';
    document.getElementById('regProvincia').value = 'Chaco';
    document.getElementById('regPais').value = 'Argentina';
    document.getElementById('regPassword').value = CONFIG.DEFAULT_PASSWORD;
    resetHorarioLaboralForm();
    renderMateriasDocenteChecklist(null);
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
    document.querySelector('#tabDocentes .form-section').classList.add('editing');

    document.getElementById('regApellido').value = teacher.apellido || '';
    document.getElementById('regNombre').value = teacher.nombre || '';
    document.getElementById('regDni').value = teacher.dni || '';
    document.getElementById('regMateria').value = teacher.materia || '';
    document.getElementById('regTelefono').value = teacher.telefono || '';
    document.getElementById('regTelefonoFamiliar').value = teacher.telefonoFamiliar || '';
    document.getElementById('regEmail').value = teacher.email || '';
    document.getElementById('regCalle').value = teacher.calle || '';
    document.getElementById('regNumero').value = teacher.numero || '';
    document.getElementById('regBarrio').value = teacher.barrio || '';
    document.getElementById('regLocalidad').value = teacher.localidad || 'Resistencia';
    document.getElementById('regProvincia').value = teacher.provincia || 'Chaco';
    document.getElementById('regPais').value = teacher.pais || 'Argentina';
    document.getElementById('regPassword').value = teacher.password || CONFIG.DEFAULT_PASSWORD;

    renderMateriasDocenteChecklist(teacher.id);

    // Abre directamente "Laboral" (horarios + foto) porque es lo que
    // más se edita; el resto de los datos ya quedó cargado en sus
    // campos aunque esa sección esté colapsada.
    const dfLaboral = document.getElementById('dfLaboral');
    if (dfLaboral && window.bootstrap) {
        bootstrap.Collapse.getOrCreateInstance(dfLaboral, { toggle: false }).show();
    }

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

// Normaliza un campo de domicilio (calle/numero/barrio/localidad/
// provincia/pais): recorta espacios de los extremos, colapsa espacios
// internos repetidos y pasa a MAYÚSCULA, para que no queden variantes
// tipo "  resistencia" / "Resistencia " / "Resistencia" como valores
// distintos.
function normalizarCampoDomicilio(value) {
    return (value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

// Arma "CALLE NUMERO - BARRIO - LOCALIDAD, PROVINCIA" a partir de los 6
// campos estructurados de domicilio. Si el docente no tiene ninguno
// cargado (registro viejo), cae al campo único teacher.direccion; si
// tampoco tiene eso, "-". Se usa en la ficha del docente (admin), su
// propio panel y el reporte individual en PDF.
function getDomicilioCompleto(teacher) {
    const tieneEstructurado = teacher.calle || teacher.numero || teacher.barrio || teacher.localidad;
    if (tieneEstructurado) {
        // localidad es texto libre (lo que haya escrito el usuario, tal
        // cual): NO se le concatena provincia acá, para no duplicar
        // (ej: "Resistencia Chaco, Chaco"). provincia sigue existiendo
        // como campo propio (se guarda igual), solo no entra en este texto.
        const calleNumero = [teacher.calle, teacher.numero].filter(Boolean).join(' ');
        const partes = [calleNumero, teacher.barrio, teacher.localidad].filter(Boolean);
        if (partes.length > 0) return partes.join(' - ');
    }
    return teacher.direccion || '-';
}

async function saveTeacher() {
    const accionPermiso = editingTeacherId ? 'editar_docente' : 'agregar_docente';
    if (!tienePermiso(currentUser.rol, accionPermiso)) {
        showToast(mensajeSinPermiso(accionPermiso), 'error');
        logAccion('PERMISO_DENEGADO', `Intentó ${accionPermiso} sin permiso`);
        return;
    }
    const apellido = document.getElementById('regApellido').value.trim();
    const nombre = document.getElementById('regNombre').value.trim();
    const dni = document.getElementById('regDni').value.trim();
    const materia = document.getElementById('regMateria').value.trim();
    const telefono = document.getElementById('regTelefono').value.trim();
    const telefonoFamiliar = document.getElementById('regTelefonoFamiliar').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    // El viejo campo único "Dirección" (teacher.direccion) ya no se
    // completa desde el formulario - queda en los docentes viejos solo
    // para mostrarlo como respaldo (ver loadTeachersTable/showTeacherDetail).
    // Ahora se guarda como 6 campos separados y normalizados.
    const calle = normalizarCampoDomicilio(document.getElementById('regCalle').value);
    const numero = normalizarCampoDomicilio(document.getElementById('regNumero').value);
    const barrio = normalizarCampoDomicilio(document.getElementById('regBarrio').value);
    const localidad = normalizarCampoDomicilio(document.getElementById('regLocalidad').value);
    const provincia = normalizarCampoDomicilio(document.getElementById('regProvincia').value);
    const pais = normalizarCampoDomicilio(document.getElementById('regPais').value);
    const password = document.getElementById('regPassword').value.trim() || CONFIG.DEFAULT_PASSWORD;

    if (!apellido) { showToast('El apellido es obligatorio', 'error'); return; }
    if (!nombre) { showToast('El nombre es obligatorio', 'error'); return; }
    if (!dni) { showToast('El DNI es obligatorio', 'error'); return; }
    if (!telefono) { showToast('El teléfono personal es obligatorio', 'error'); return; }
    if (!telefonoFamiliar) { showToast('El teléfono de contacto familiar es obligatorio', 'error'); return; }
    if (!email) { showToast('El e-mail es obligatorio', 'error'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('El e-mail no tiene un formato válido', 'error'); return; }
    // Ya no se pide horario acá: el horario de cátedra se carga y edita
    // solo desde el CRUD de Materias (ver checklist "Materias asignadas"
    // más abajo en este mismo formulario). Un docente sin materias
    // todavía queda sin horario hasta que se le asigne una.

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

    let savedTeacher;
    if (editingTeacherId) {
        const idx = teachers.findIndex(t => t.id === editingTeacherId);
        teachers[idx] = {
            ...teachers[idx],
            apellido, nombre, dni, materia, telefono, telefonoFamiliar, email,
            calle, numero, barrio, localidad, provincia, pais,
            // horario_laboral NO se toca acá a propósito: ya no hay UI
            // para editarlo (ver checklist de materias) y el spread de
            // arriba ya conserva el valor que tenía, sea cual sea.
            photo, faceDescriptor, password,
        };
        savedTeacher = teachers[idx];
        saveTeachers(teachers);
        logAccion('EDITAR_DOCENTE', `Editó al docente DNI ${dni}`);
        showToast(`✅ Docente actualizado`, 'success');
    } else {
        const newTeacher = {
            id: Date.now().toString(),
            apellido, nombre, dni, telefono, telefonoFamiliar, email,
            calle, numero, barrio, localidad, provincia, pais,
            // Sin horario_laboral: un docente nuevo arranca sin horario
            // propio, se le asigna una materia (que trae su horario)
            // desde el checklist de abajo o después desde su ficha.
            materia,
            photo, faceDescriptor,
            // Contraseña por defecto (o la que haya puesto el admin):
            // se obliga a cambiarla en el primer login (ver
            // showDashboard()/forceChangePasswordModal()).
            password, debeCambiarPassword: true, createdAt: new Date().toISOString(), active: true
        };
        teachers.push(newTeacher);
        savedTeacher = newTeacher;
        saveTeachers(teachers);
        logAccion('ALTA_DOCENTE', `Registró al docente DNI ${dni}`);
        showToast(`✅ Docente registrado. Usuario: ${dni}, Contraseña: ${password}`, 'success');
    }

    await guardarMateriasAsignadasDocente(savedTeacher);
    // Fuerza a que la próxima vez que se abra el formulario (edición u
    // otro alta) vuelva a inicializar la selección desde cero, en vez
    // de arrastrar lo que se acababa de tildar acá - sin esto, crear un
    // docente nuevo y enseguida abrir "Registrar Nuevo Docente" de
    // nuevo mostraría las materias del que se acaba de guardar.
    materiasSeleccionDocenteIdActual = undefined;

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
    const today = getFechaHoyArgentina();
    document.getElementById('teacherCountBadge').textContent = teachers.length;
    if (teachers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="12" class="text-center">No hay docentes registrados</td></tr>';
        return;
    }
    tbody.innerHTML = teachers.map(teacher => {
        const attendance = getAttendance().filter(a => a.teacherId === teacher.id && getFechaRealFichaje(a) === today);
        const status = attendance.length > 0 ? `<span class="badge bg-success">Presente (${attendance.length})</span>` : `<span class="badge bg-danger">Ausente</span>`;
        const horarioTeacher = getHorarioEfectivo(teacher);
        const scheduleDisplay = horarioTeacher.length > 0 ?
            horarioTeacher.slice(0, 3).map(h => `${h.dia} ${h.inicio}-${h.fin}`).join(', ') + (horarioTeacher.length > 3 ? '...' : '') : 'Sin horario';
        const bioBadge = teacher.faceDescriptor ? '<span class="badge bg-success">Registrada</span>' : '<span class="badge bg-warning text-dark">Sin datos</span>';
        // Domicilio: calle + número + barrio en una sola columna. Si el
        // docente es viejo y no tiene esos 3 campos cargados, se muestra
        // el domicilio (campo único, sin estructurar) como respaldo.
        const domicilioParts = [teacher.calle, teacher.numero, teacher.barrio].filter(Boolean);
        const domicilioDisplay = domicilioParts.length > 0 ? domicilioParts.join(' ') : (teacher.direccion || '-');
        const localidadDisplay = teacher.localidad || '-';
        const searchText = `${teacher.apellido} ${teacher.nombre} ${teacher.dni} ${teacher.materia || ''}`.toLowerCase();
        return `
            <tr data-search="${searchText}" onclick="showTeacherDetail('${teacher.id}')">
                <td data-label="Foto"><img src="${teacher.photo}" alt="Foto" style="width:50px;height:50px;border-radius:50%;object-fit:cover;"></td>
                <td data-label="DNI"><strong>${teacher.dni}</strong></td>
                <td data-label="Nombre">${teacher.apellido} ${teacher.nombre}</td>
                <td data-label="Teléfono">${teacher.telefono || '-'}</td>
                <td data-label="Domicilio">${domicilioDisplay}</td>
                <td data-label="Localidad">${localidadDisplay}</td>
                <td data-label="Materia">${teacher.materia}</td>
                <td data-label="Horario"><small>${scheduleDisplay}</small></td>
                <td data-label="Contraseña"><span class="badge bg-info">${tienePermiso(currentUser.rol, 'ver_claves') ? teacher.password : '••••••'}</span></td>
                <td data-label="Biometría">${bioBadge}</td>
                <td data-label="Estado hoy">${status}</td>
                <td data-label="Acciones" onclick="event.stopPropagation()">
                    ${renderWhatsAppButton(teacher.telefono, teacher.nombre)}
                    <button class="btn btn-sm btn-primary" title="Editar docente" onclick="editTeacher('${teacher.id}')"><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-sm btn-info" title="Calendario ${SCHEDULE_CALENDAR_YEAR}" onclick="showTeacherCalendar('${teacher.id}')"><i class="bi bi-calendar3"></i></button>
                    <button class="btn btn-sm btn-warning" title="Fichaje manual" onclick="openManualAttendanceModal('${teacher.id}')"><i class="bi bi-fingerprint"></i></button>
                    <button class="btn btn-sm btn-secondary" title="Restablecer contraseña" onclick="resetTeacherPassword('${teacher.id}')"><i class="bi bi-key"></i></button>
                    ${tienePermiso(currentUser.rol, 'borrar') ? `<button class="btn btn-sm btn-danger" title="Eliminar" onclick="deleteTeacher('${teacher.id}')"><i class="bi bi-trash"></i></button>` : ''}
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

// Todos los contadores de "Hoy" se calculan sobre el set de docentes
// que deberían presentarse hoy (getDocentesEsperadosHoyPorDocente),
// nunca sobre el total de la planta: un docente sin grilla hoy, de
// licencia, o en un día sin clases no debe contarse como ausente.
function updateStats() {
    const teachers = getTeachers();
    document.getElementById('totalTeachers').textContent = teachers.length;

    const esperadosHoy = getDocentesEsperadosHoyPorDocente();
    document.getElementById('expectedToday').textContent = esperadosHoy.length;
    document.getElementById('presentToday').textContent = esperadosHoy.filter(e => e.semaforo.code === 'presente').length;
    document.getElementById('lateToday').textContent = esperadosHoy.filter(e => e.semaforo.code === 'tardanza').length;
    document.getElementById('halfAbsentToday').textContent = esperadosHoy.filter(e => e.semaforo.code === 'media_falta').length;
    document.getElementById('absentToday').textContent = esperadosHoy.filter(e => e.semaforo.code === 'ausente').length;

    renderDocentesEsperadosHoy();
}

function loadAlerts() {
    // Más reciente arriba, más antigua abajo.
    const alerts = getAlerts().slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const container = document.getElementById('alertsList');
    if (alerts.length === 0) { container.innerHTML = '<p class="text-muted">No hay alertas pendientes</p>'; return; }
    const puedeJustificar = tienePermiso(currentUser.rol, 'justificar_alerta');
    const puedeBorrarAlerta = tienePermiso(currentUser.rol, 'borrar');
    container.innerHTML = alerts.map((alert) => {
        const isJustified = alert.justified || false;
        const isPendienteRectoria = !isJustified && alert.justification === 'pendiente_aprobacion_rectoria';
        const isEarlyExit = alert.type === 'Salida Anticipada';
        const isDenied = isJustified && alert.justification === 'injustificada';

        let badgeClass, badgeText;
        if (isPendienteRectoria) {
            badgeClass = 'badge-unjustified'; badgeText = 'Enviada a Rectoría';
        } else if (isEarlyExit) {
            if (!isJustified) { badgeClass = 'badge-unjustified'; badgeText = 'Pendiente'; }
            else if (isDenied) { badgeClass = 'badge-unjustified'; badgeText = 'Injustificada'; }
            else { badgeClass = 'badge-justified'; badgeText = 'Justificada'; }
        } else {
            badgeClass = isJustified ? 'badge-justified' : 'badge-unjustified';
            badgeText = isJustified ? 'Justificado' : 'Injustificado';
        }

        // Justificar/Injustificar una alerta es exclusivo de Rector
        // (justificar_alerta en MATRIZ_PERMISOS) - incluye las que
        // Secretaría ya mandó a aprobación, Rector sigue viendo sus
        // botones de resolución para esas. Secretaría solo puede
        // mandarla a aprobación de Rectoría (un único botón, que
        // desaparece una vez enviada); Programador no interactúa acá.
        let justificationOptions = '';
        if (!isJustified) {
            if (puedeJustificar) {
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
            } else if (currentUser.rol === ROLES.SECRETARIA && !isPendienteRectoria) {
                justificationOptions = `
                    <div class="mt-2">
                        <button class="btn btn-sm btn-outline-primary" onclick="justifyAlert('${alert.id}', 'pendiente_aprobacion_rectoria')"><i class="bi bi-send"></i> Enviar a Rectoría</button>
                    </div>`;
            }
        }

        const resolutionLabel = alert.justification === 'justificada' ? 'Justificada'
            : alert.justification === 'injustificada' ? 'Injustificada'
            : alert.justification === 'pendiente_aprobacion_rectoria' ? 'Enviada a Rectoría, pendiente de resolución'
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
                        ${puedeBorrarAlerta ? `<button class="btn btn-sm btn-link text-danger" title="Eliminar alerta" onclick="dismissAlert('${alert.id}')"><i class="bi bi-x-circle"></i></button>` : ''}
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

// reason === 'pendiente_aprobacion_rectoria' es el único valor que
// puede setear alguien SIN el permiso justificar_alerta (Secretaría,
// ver loadAlerts()): no resuelve la alerta, solo la marca para que
// Rector la vea y decida. Cualquier otro valor (resolución real)
// requiere el permiso.
function justifyAlert(id, reason) {
    const esEnvioARectoria = reason === 'pendiente_aprobacion_rectoria';
    if (!esEnvioARectoria && !tienePermiso(currentUser.rol, 'justificar_alerta')) {
        showToast(mensajeSinPermiso('justificar_alerta'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó justificar/injustificar una alerta sin permiso');
        return;
    }
    if (esEnvioARectoria && currentUser.rol !== ROLES.SECRETARIA && !tienePermiso(currentUser.rol, 'justificar_alerta')) {
        showToast(mensajeSinPermiso('justificar_alerta'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó enviar una alerta a aprobación de Rectoría sin permiso');
        return;
    }
    const alerts = getAlerts();
    const alert = alerts.find(a => a.id === id);
    if (alert) {
        alert.justified = !esEnvioARectoria;
        alert.justification = reason;
        saveAlerts(alerts);
        loadAlerts();
        if (esEnvioARectoria) {
            showToast('📨 Alerta enviada a Rectoría para su resolución', 'info');
            return;
        }
        const msg = alert.type === 'Salida Anticipada'
            ? (reason === 'justificada' ? '✅ Salida anticipada justificada' : '❌ Salida anticipada marcada como injustificada')
            : 'Ausencia justificada como: ' + reason;
        showToast(msg, reason === 'injustificada' ? 'warning' : 'success');
    }
}

function dismissAlert(id) {
    if (!tienePermiso(currentUser.rol, 'borrar')) {
        showToast(mensajeSinPermiso('borrar'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó borrar una alerta sin permiso');
        return;
    }
    if (!confirm('¿Eliminar esta alerta? Esta acción no se puede deshacer.')) return;
    const alerts = getAlerts().filter(a => a.id !== id);
    saveAlerts(alerts);
    loadAlerts();
    showToast('Alerta eliminada', 'info');
}

function loadCriteria() {
    const criteria = getCriteria();
    document.getElementById('minAttendance').value = criteria.minAttendance;
    document.getElementById('minHours').value = criteria.minHours;
    loadCriteriosPuntualidad();
}

// A diferencia de saveCriteriaToStorage()/persistToSupabase() (que
// guardan optimista: local ya, Supabase en segundo plano, sin avisar
// éxito), acá el toast de éxito espera la confirmación real de
// Supabase a propósito - se llama solo al clickear "Guardar", nunca
// en un onchange de los inputs.
// Parte de getCriteria() (spread primero): así este botón nunca pisa
// los criterios de puntualidad guardados por guardarCriteriosPuntualidad()
// (y viceversa) - son 2 secciones/botones separados sobre el mismo
// objeto criteria en Supabase. lateLimit ya no tiene campo propio acá
// (se sacó de "Criterios de Asistencia" a pedido) - el spread lo deja
// tal cual estaba guardado, sin tocarlo; lo sigue usando la lógica de
// tardanza existente (checkFaltas, registerAttendance, etc.).
async function saveCriteria() {
    const criteria = {
        ...getCriteria(),
        minAttendance: parseInt(document.getElementById('minAttendance').value) || 80,
        minHours: parseInt(document.getElementById('minHours').value) || 4
    };
    const resultado = await persistToSupabaseEsperando('criteria', criteria);
    toastSegunConfirmacion(resultado, 'Criterios guardados');
}

// ===== Criterios de Puntualidad (semáforo de "Docentes que deberían
// presentarse hoy") - sección aparte de "Criterios de Asistencia" de
// arriba, exclusiva de Rector (editar_criterios_puntualidad). =====
function loadCriteriosPuntualidad() {
    const criteria = getCriteria();
    const presenteEl = document.getElementById('limitePresenteMin');
    const tardanzaEl = document.getElementById('limiteTardanzaMin');
    const mediaFaltaEl = document.getElementById('limiteMediaFaltaMin');
    if (!presenteEl || !tardanzaEl || !mediaFaltaEl) return;
    presenteEl.value = criteria.limitePresenteMin;
    tardanzaEl.value = criteria.limiteTardanzaMin;
    mediaFaltaEl.value = criteria.limiteMediaFaltaMin;

    const puedeEditar = tienePermiso(currentUser.rol, 'editar_criterios_puntualidad');
    [presenteEl, tardanzaEl, mediaFaltaEl].forEach(el => el.disabled = !puedeEditar);
    const saveBtn = document.getElementById('guardarCriteriosPuntualidadBtn');
    if (saveBtn) saveBtn.disabled = !puedeEditar;
    actualizarLeyendaCriteriosPuntualidad();
}

// Refleja en la leyenda ("Presente: de X a Y min"...) lo que hay
// cargado en los 3 inputs en ESE momento (incluso sin guardar todavía
// - así Rectoría ve el efecto de un cambio antes de confirmarlo).
function actualizarLeyendaCriteriosPuntualidad() {
    const presente = parseInt(document.getElementById('limitePresenteMin')?.value, 10);
    const tardanza = parseInt(document.getElementById('limiteTardanzaMin')?.value, 10);
    const mediaFalta = parseInt(document.getElementById('limiteMediaFaltaMin')?.value, 10);
    if (!Number.isFinite(presente) || !Number.isFinite(tardanza) || !Number.isFinite(mediaFalta)) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('leyendaPresenteMax', presente);
    set('leyendaTardanzaMin', presente + 1);
    set('leyendaTardanzaMax', tardanza);
    set('leyendaMediaFaltaMin', tardanza + 1);
    set('leyendaMediaFaltaMax', mediaFalta);
    set('leyendaAusenteMin', mediaFalta);
}

async function guardarCriteriosPuntualidad() {
    if (!tienePermiso(currentUser.rol, 'editar_criterios_puntualidad')) {
        showToast(mensajeSinPermiso('editar_criterios_puntualidad'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó guardar los criterios de puntualidad sin permiso');
        return;
    }
    const presente = parseInt(document.getElementById('limitePresenteMin').value, 10);
    const tardanza = parseInt(document.getElementById('limiteTardanzaMin').value, 10);
    const mediaFalta = parseInt(document.getElementById('limiteMediaFaltaMin').value, 10);
    if (!Number.isFinite(presente) || !Number.isFinite(tardanza) || !Number.isFinite(mediaFalta) || presente < 0) {
        showToast('Completá los 3 límites con números válidos', 'error');
        return;
    }
    if (!(presente < tardanza && tardanza < mediaFalta)) {
        showToast('Cada límite tiene que ser mayor que el anterior (Presente < Tardanza < Media Falta)', 'error');
        return;
    }
    const criteria = { ...getCriteria(), limitePresenteMin: presente, limiteTardanzaMin: tardanza, limiteMediaFaltaMin: mediaFalta };
    const resultado = await persistToSupabaseEsperando('criteria', criteria);
    toastSegunConfirmacion(resultado, '✅ Criterios de puntualidad guardados');
    logAccion('EDITAR_CRITERIOS_PUNTUALIDAD', `Presente ≤${presente}m, Tardanza ≤${tardanza}m, Media Falta ≤${mediaFalta}m`);
    updateStats();
}

function loadReportTeachers() {
    const teachers = getTeachers();
    const select = document.getElementById('reportTeacher');
    select.innerHTML = '<option value="all">Todos</option>' + teachers.map(t => `<option value="${t.id}">${t.apellido} ${t.nombre} (${t.dni})</option>`).join('');
}

// Reporte de asistencia en PDF (antes era un .txt). Si se filtra por un
// docente puntual (no "Todos" - es el caso de generateIndividualReport(),
// el botón "Generar Reporte" de la ficha del docente), arranca con un
// encabezado tipo legajo: datos personales + getDomicilioCompleto().
// Helpers compartidos por generateReport()/generateReportExcel() para
// mostrar "ubicación real vs configurada" de cada fichaje.
function textoDistanciaFichaje(r) {
    if (r.fichajeDistanciaMts == null) return '-';
    return r.dentroGeocerca === false ? `FUERA DE RANGO - ${r.fichajeDistanciaMts}m` : `EN ESCUELA - ${r.fichajeDistanciaMts}m`;
}

function minutosDiferidoFichaje(r) {
    if (!r.horaSync || !r.horaFichajeReal) return null;
    return Math.round((new Date(r.horaSync) - new Date(r.horaFichajeReal)) / 60000);
}

// "Diferido": fichó offline y recién se terminó de confirmar la
// ubicación bastante después, al reconectar (ver
// revalidatePendingGeofenceAttendance()). Con conexión normal,
// horaSync se completa a los pocos segundos - nunca da diferido.
function esFichajeDiferido(r) {
    const min = minutosDiferidoFichaje(r);
    return min != null && min > 15;
}

// Link de Google Maps con 2 pines (escuela y fichaje) y la línea de
// distancia entre ambos: es el esquema público de "Cómo llegar" de
// Google Maps (origen -> destino) - no existe una URL más simple que
// dibuje una línea entre 2 puntos sin usar su API de mapas embebida.
function linkMapaFichaje(r, geofence) {
    if (r.fichajeLat == null) return null;
    return `https://www.google.com/maps/dir/?api=1&origin=${geofence.lat},${geofence.lng}&destination=${r.fichajeLat},${r.fichajeLng}`;
}

function generateReport() {
    if (!tienePermiso(currentUser.rol, 'ver_reportes')) {
        showToast(mensajeSinPermiso('ver_reportes'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó generar un reporte PDF sin permiso');
        return;
    }
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
    const singleTeacher = teacherId !== 'all' ? teacherMap[teacherId] : null;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const marginX = 40;
    const pageHeight = doc.internal.pageSize.getHeight();
    let y = 50;
    const ensureSpace = needed => { if (y + needed > pageHeight - 40) { doc.addPage(); y = 50; } };

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(32, 78, 74);
    doc.text('Reporte de Asistencia Docente', marginX, y);
    y += 20;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(111, 109, 100);
    doc.text(`Período: ${from} al ${to}  ·  Generado el ${new Date().toLocaleString('es-AR')}`, marginX, y);
    y += 14;
    // Ubicación configurada de la geocerca UNA sola vez acá arriba (es
    // la misma para todo el reporte) - cada fichaje abajo solo indica a
    // cuántos metros de este punto quedó registrado.
    const geofenceReporte = getGeofenceConfig();
    doc.text(`Geocerca configurada: ${geofenceReporte.nombreLugar} (${geofenceReporte.lat}, ${geofenceReporte.lng})`, marginX, y);
    y += 24;

    if (singleTeacher) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(40, 40, 40);
        doc.text(`${singleTeacher.apellido} ${singleTeacher.nombre}`, marginX, y);
        y += 16;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        [
            `DNI: ${singleTeacher.dni}`,
            `Materia: ${singleTeacher.materia || '-'}`,
            `Teléfono: ${singleTeacher.telefono || '-'}`,
            `Tel. familiar: ${singleTeacher.telefonoFamiliar || '-'}`,
            `E-mail: ${singleTeacher.email || '-'}`,
            `Domicilio: ${getDomicilioCompleto(singleTeacher)}`,
        ].forEach(line => { ensureSpace(14); doc.text(line, marginX, y); y += 14; });
        y += 10;
    }

    const typeMap = { entry: 'ENTRADA', exit: 'SALIDA', early_exit: 'SALIDA ANTES DE TIEMPO' };
    const grouped = {};
    filtered.forEach(a => { if (!grouped[a.teacherId]) grouped[a.teacherId] = []; grouped[a.teacherId].push(a); });

    for (const [id, records] of Object.entries(grouped)) {
        const teacher = teacherMap[id];
        if (!teacher) continue;

        ensureSpace(40);
        if (!singleTeacher) {
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(11);
            doc.setTextColor(32, 78, 74);
            doc.text(`${teacher.apellido} ${teacher.nombre} — DNI ${teacher.dni}`, marginX, y);
            y += 16;
        }

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(40, 40, 40);
        doc.text(`Total de registros: ${records.length}`, marginX, y);
        y += 14;

        records
            .slice()
            .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
            .forEach(r => {
                ensureSpace(14);
                const categoriaTag = r.categoria === 'evento' ? `  [EVENTO: ${r.eventoTitulo || r.eventoId}]` : '';
                // Sin emoji acá a propósito: jsPDF con las fuentes
                // estándar (helvetica) no las renderiza, quedan vacías
                // o rotas - mismo motivo por el que el resto de este
                // reporte tampoco usa ninguno.
                const ubicacionTexto = r.direccionFichaje || (r.fichajeLat != null ? `${r.fichajeLat.toFixed(5)}, ${r.fichajeLng.toFixed(5)}` : null);
                const ubicacionTag = ubicacionTexto ? `  |  ${ubicacionTexto} (${textoDistanciaFichaje(r)})` : '';
                const diferidoMin = minutosDiferidoFichaje(r);
                const diferidoTag = esFichajeDiferido(r)
                    ? `  |  DIFERIDO: fichó ${r.time} pero sincronizó ${new Date(r.horaSync).toLocaleTimeString('es-AR').slice(0, 5)} (${diferidoMin}min después)`
                    : '';
                const fakeGpsTag = r.fichajeFakeGpsSospechoso ? '  |  POSIBLE UBICACIÓN FALSA' : '';
                const corregidoTag = r.corregidoPorDocente ? '  |  GENERADO POR CORRECCIÓN DEL DOCENTE' : '';
                const anuladoTag = r.anulado ? '  |  ANULADO POR EL DOCENTE (reemplazado por un fichaje nuevo)' : '';
                doc.text(`${r.date} ${r.time}  |  ${typeMap[r.type] || r.type}${categoriaTag}  |  ${r.status}${ubicacionTag}${diferidoTag}${fakeGpsTag}${corregidoTag}${anuladoTag}`, marginX + 10, y);
                y += 13;
            });
        y += 12;
    }

    const fileSuffix = singleTeacher ? `_${singleTeacher.dni}` : '';
    doc.save(`reporte${fileSuffix}_${from}_${to}.pdf`);
    logAccion('EXPORTAR_REPORTE', `Exportó reporte PDF ${from} a ${to}${singleTeacher ? ' - DNI ' + singleTeacher.dni : ''}`);
    showToast('Reporte generado', 'success');
}

// Mismo filtro que generateReport() (período + docente), pero en
// planilla .xlsx (una fila por fichaje) en vez de PDF. Usa SheetJS
// (libs/xlsx.full.min.js, autohospedado) para no depender de internet.
function generateReportExcel() {
    if (!tienePermiso(currentUser.rol, 'exportar_reportes')) {
        showToast(mensajeSinPermiso('exportar_reportes'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó exportar un reporte a Excel sin permiso');
        return;
    }
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
    const typeMap = { entry: 'ENTRADA', exit: 'SALIDA', early_exit: 'SALIDA ANTES DE TIEMPO' };

    const geofenceReporte = getGeofenceConfig();
    const rows = filtered
        .slice()
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map(r => {
            const teacher = teacherMap[r.teacherId];
            const diferidoMin = minutosDiferidoFichaje(r);
            return {
                Fecha: r.date,
                Hora: r.time,
                Apellido: teacher ? teacher.apellido : '-',
                Nombre: teacher ? teacher.nombre : '-',
                DNI: teacher ? teacher.dni : '-',
                Materia: teacher ? (teacher.materia || '-') : '-',
                Tipo: typeMap[r.type] || r.type,
                Estado: r.status || '-',
                Evento: r.categoria === 'evento' ? (r.eventoTitulo || r.eventoId) : '',
                Ubicacion: r.direccionFichaje || '',
                LatLon: r.fichajeLat != null ? `${r.fichajeLat}, ${r.fichajeLng}` : '',
                Distancia: textoDistanciaFichaje(r),
                DentroFuera: r.dentroGeocerca == null ? '' : (r.dentroGeocerca ? 'DENTRO' : 'FUERA'),
                HoraReal: r.horaFichajeReal ? new Date(r.horaFichajeReal).toLocaleTimeString('es-AR').slice(0, 5) : '',
                HoraSync: r.horaSync ? new Date(r.horaSync).toLocaleTimeString('es-AR').slice(0, 5) : (r.syncUbicacion === 'pendiente' ? 'pendiente' : ''),
                DiferenciaMin: diferidoMin != null ? diferidoMin : '',
                Diferido: esFichajeDiferido(r) ? 'SI' : '',
                IP: r.ip || '',
                FakeGpsSospechoso: r.fichajeFakeGpsSospechoso ? 'SI' : '',
                CorregidoPorDocente: r.corregidoPorDocente ? 'SI' : '',
                AnuladoPorDocente: r.anulado ? 'SI' : '',
                LinkMapa: linkMapaFichaje(r, geofenceReporte) || '',
            };
        });

    const singleTeacher = teacherId !== 'all' ? teacherMap[teacherId] : null;
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [
        { wch: 12 }, { wch: 8 }, { wch: 16 }, { wch: 16 }, { wch: 10 }, { wch: 18 }, { wch: 22 }, { wch: 12 }, { wch: 20 },
        { wch: 26 }, { wch: 20 }, { wch: 20 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 15 }, { wch: 12 }, { wch: 45 },
    ];
    // Fila de referencia con la geocerca configurada, para poder
    // comparar a ojo contra UbicacionFichaje/DistanciaGeocercaMts de
    // cada fila de arriba.
    XLSX.utils.sheet_add_json(ws, [{
        Fecha: '', Hora: '', Apellido: '', Nombre: '', DNI: '', Materia: '', Tipo: '', Estado: '', Evento: '',
        Ubicacion: `Geocerca configurada: ${geofenceReporte.nombreLugar}`,
        LatLon: `${geofenceReporte.lat}, ${geofenceReporte.lng}`,
        Distancia: `Radio: ${geofenceReporte.radio}m`,
    }], { skipHeader: true, origin: -1 });
    XLSX.utils.book_append_sheet(wb, ws, 'Asistencia');

    const fileSuffix = singleTeacher ? `_${singleTeacher.dni}` : '';
    XLSX.writeFile(wb, `reporte${fileSuffix}_${from}_${to}.xlsx`);
    logAccion('EXPORTAR_REPORTE', `Exportó reporte Excel ${from} a ${to}${singleTeacher ? ' - DNI ' + singleTeacher.dni : ''}`);
    showToast('Reporte Excel generado', 'success');
}

function deleteTeacher(id) {
    if (!tienePermiso(currentUser.rol, 'borrar')) {
        showToast(mensajeSinPermiso('borrar'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó borrar un docente sin permiso');
        return;
    }
    if (!confirm('¿Eliminar este docente?')) return;
    const teachers = getTeachers();
    const teacher = teachers.find(t => t.id === id);
    saveTeachers(teachers.filter(t => t.id !== id));
    loadTeachersTable();
    updateStats();
    loadReportTeachers();
    populateTeacherSelect();
    logAccion('BORRAR_DOCENTE', `Eliminó al docente DNI ${teacher ? teacher.dni : id}`);
    showToast('Docente eliminado', 'info');
}

function resetTeacherPassword(id) {
    if (!tienePermiso(currentUser.rol, 'blanquear_password')) {
        showToast(mensajeSinPermiso('blanquear_password'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó blanquear contraseña sin permiso');
        return;
    }
    const teachers = getTeachers();
    const teacher = teachers.find(t => t.id === id);
    if (!teacher) return;
    const input = prompt(`Nueva contraseña para ${teacher.apellido} ${teacher.nombre}\n(dejar vacío para restablecer a la contraseña por defecto: ${CONFIG.DEFAULT_PASSWORD})`);
    if (input === null) return;
    const newPass = input.trim() || CONFIG.DEFAULT_PASSWORD;
    teacher.password = newPass;
    // Al blanquear, se obliga a elegir una nueva en el próximo login
    // (mismo mecanismo que un docente recién registrado).
    teacher.debeCambiarPassword = true;
    saveTeachers(teachers);
    loadTeachersTable();
    logAccion('BLANQUEO_PASSWORD', `DNI ${teacher.dni} reseteado a: ${newPass}`);
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
    lastLivenessResult = null;
    const status = document.getElementById('faceRecognitionStatus');
    status.className = 'face-recognition-status waiting';
    status.innerHTML = '<i class="bi bi-info-circle"></i> Esperando identificación...';
    document.getElementById('recognitionProgress').style.display = 'none';
    updateAttendanceButtonsState();
    startExitWindowPoll();
    renderFichajeContextBadges();
    renderMateriaFichajeInfo();
    // Si este DNI sigue bloqueado por prueba de vida (ver liveness.js),
    // que se vea desde que entra a la pantalla, no recién al primer
    // intento fallido de "Identificarme".
    if (typeof isLivenessLocked === 'function' && currentUser && isLivenessLocked(currentUser.dni)) {
        livenessStartLockCountdown(currentUser.dni);
    }
}

// Info/selector de con qué materia ficha el docente hoy - reemplaza la
// vieja edición de horario propio en el fichaje: acá es solo
// informativo, o para ELEGIR entre materias ya cargadas por el admin
// (nunca para editar horas, eso es exclusivo del CRUD de Materias).
// Sin materias asignadas todavía: no muestra nada, sigue usando su
// horario_laboral propio como hasta ahora (ver getHorarioEfectivo()).
function renderMateriaFichajeInfo() {
    const el = document.getElementById('materiaFichajeInfo');
    if (!el || !currentUser || currentUser.role !== 'teacher') return;
    const materias = getMateriasDeDocente(currentUser.id);
    if (materias.length === 0) {
        materiaFichajeSeleccionada = null;
        el.innerHTML = '';
        return;
    }
    if (materias.length === 1) {
        materiaFichajeSeleccionada = materias[0].id;
        el.innerHTML = `<div class="alert alert-info py-1 px-2 mb-0 small"><i class="bi bi-journal-bookmark"></i> Materia: <strong>${materias[0].nombre}</strong> - Horario: ${formatoHorariosCorto(materias[0])}</div>`;
        return;
    }
    if (!materiaFichajeSeleccionada || !materias.some(m => m.id === materiaFichajeSeleccionada)) {
        materiaFichajeSeleccionada = materias[0].id;
    }
    const actual = materias.find(m => m.id === materiaFichajeSeleccionada);
    el.innerHTML = `
        <label class="form-label small mb-1"><i class="bi bi-journal-bookmark"></i> ¿Para qué materia fichás hoy?</label>
        <select class="form-control form-control-sm mb-1" onchange="seleccionarMateriaFichaje(Number(this.value))">
            ${materias.map(m => `<option value="${m.id}" ${m.id === materiaFichajeSeleccionada ? 'selected' : ''}>${m.nombre}</option>`).join('')}
        </select>
        <div class="alert alert-info py-1 px-2 mb-0 small">Horario: ${formatoHorariosCorto(actual)}</div>`;
}

function seleccionarMateriaFichaje(materiaId) {
    materiaFichajeSeleccionada = materiaId;
    renderMateriaFichajeInfo();
}

// ¿Corresponde mostrarle a ESTE usuario los detalles internos de
// kiosco/modo prueba (ruido para un docente normal en el día a día)?
// Solo si modo prueba está prendido (ya afecta a todos, hay que
// avisar), es admin, o se pidió explícitamente con ?debug=1 en la URL
// (para que soporte/rectoría pueda diagnosticar un fichaje puntual sin
// tener que prender modo prueba para todo el mundo).
function esVistaDebugActiva() {
    const modoPrueba = getModoPrueba();
    const esAdmin = !!(currentUser && currentUser.role === 'admin');
    let debugParam = false;
    try { debugParam = new URLSearchParams(window.location.search).get('debug') === '1'; } catch (e) { /* URL no parseable: se ignora */ }
    return modoPrueba.activo || esAdmin || debugParam;
}

// Indicadores de la "pantalla de fichaje": punto activo (siempre
// visible, el docente necesita saber a qué lugar está fichando), y si
// esta PC es el kiosco autorizado / si el Modo Prueba está encendido
// (eso último queda oculto para un docente normal - ver
// esVistaDebugActiva() - porque era ruido/info interna que un docente
// no necesita ver en el día a día; se movió al cartelito de debug de
// GPS, ver renderGeofenceDebugPanel()). También muestra/oculta el
// link para autorizar esta PC como kiosco dentro de "Opciones avanzadas".
function renderFichajeContextBadges() {
    const el = document.getElementById('fichajeContextBadges');
    if (!el) return;
    const geofence = getGeofenceConfig();
    const modoPrueba = getModoPrueba();
    const esKiosco = isThisDeviceKiosk();
    const debug = esVistaDebugActiva();

    let html = `<div class="mb-1"><i class="bi bi-geo-alt"></i> Evento actual: <strong>${geofence.nombreLugar}</strong></div>`;
    if (debug) {
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
    }
    el.innerHTML = html;

    const wrap = document.getElementById('kioskAuthorizeWrap');
    if (wrap) wrap.classList.toggle('hidden', esKiosco);
    renderGeofenceDebugPanel(lastGeofenceDebugInfo);
}

function toggleKioskAuthorizeForm() {
    document.getElementById('kioskAuthorizeForm').classList.toggle('hidden');
}

// Sección "Opciones avanzadas" de la vista docente: agrupa lo que no
// es uso diario (autorizar PC como kiosco, anular el propio fichaje)
// para que la pantalla principal quede limpia (ver renderFichajeContextBadges()).
function toggleOpcionesAvanzadasDocente() {
    document.getElementById('opcionesAvanzadasDocente').classList.toggle('hidden');
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
// anulado excluido a propósito: un fichaje que el propio docente anuló
// dentro de los 10 minutos (ver anularYRegenerarPropioFichaje()) queda
// guardado para auditoría, pero deja de contar como fichaje real en
// todos lados (acá, faltas, ventana de salida) - el reemplazo
// automático que genera esa función sí cuenta normal.
function hasEntryToday(teacherId, categoria, eventoId) {
    categoria = categoria || 'regular';
    const todayStr = getFechaHoyArgentina();
    return getAttendance().some(a => a.teacherId === teacherId && a.type === 'entry' && getFechaRealFichaje(a) === todayStr &&
        (a.categoria || 'regular') === categoria &&
        (categoria !== 'evento' || a.eventoId === eventoId) && !a.anulado);
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
    const exitInfo = currentUser && currentUser.role === 'teacher' ? getExitWindowInfo(currentUser, materiaFichajeSeleccionada) : { isExitTime: false };
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
        document.getElementById('teacherAddress').textContent = getDomicilioCompleto(currentUser);
        const horarioUsuario = getHorarioEfectivo(currentUser);
        const scheduleDisplay = horarioUsuario.length > 0 ?
            horarioUsuario.slice(0, 5).map(h => `${h.dia} ${h.inicio}-${h.fin}`).join(', ') + (horarioUsuario.length > 5 ? '...' : '') : 'Sin horario';
        document.getElementById('teacherSchedule').textContent = scheduleDisplay;
        document.getElementById('teacherPhoto').src = currentUser.photo;
    }
    renderMiUltimoFichaje();
}

// Corrección propia de fichaje (RBAC docente): el fichaje NUNCA es
// manual, siempre automático del servidor con GPS - así que "corregir"
// acá NO es tipear una hora. Es UNA sola acción, "Anular", disponible
// solo dentro de los 10 minutos del propio último fichaje: anula el
// original (queda como anulado, nunca se borra) y el sistema pide GPS
// de nuevo (misma verifyGeofence() que cualquier fichaje normal) para
// generar automáticamente el reemplazo con la hora real del momento.
// Pasados los 10 minutos ya no aparece el botón - de ahí en más
// cualquier corrección pasa por las herramientas que ya tiene Rectoría
// (fichaje manual / alertas), no por acá.
// Rastro que queda: original con anulado=true + anuladoEn (hora
// original anulada); el reemplazo es un fichaje nuevo normal con
// corregidoPorDocente=true + fichajeAnuladoId apuntando al original
// (hora nueva automática).
const CORRECCION_PROPIA_VENTANA_MS = 10 * 60 * 1000;

function puedeCorregirFichaje(record) {
    return !!record && !!currentUser && currentUser.role === 'teacher' && record.teacherId === currentUser.id &&
        (record.categoria || 'regular') === 'regular' && !record.anulado &&
        (Date.now() - new Date(record.timestamp).getTime()) <= CORRECCION_PROPIA_VENTANA_MS;
}

const TIPO_FICHAJE_LABEL = { entry: 'Entrada', exit: 'Salida', early_exit: 'Salida antes de tiempo' };

function renderMiUltimoFichaje() {
    const box = document.getElementById('miUltimoFichajeBox');
    if (!box || !currentUser || currentUser.role !== 'teacher') return;
    const todayStr = getFechaHoyArgentina();
    const propios = getAttendance().filter(a => a.teacherId === currentUser.id && getFechaRealFichaje(a) === todayStr && (a.categoria || 'regular') === 'regular' && !a.anulado);
    if (propios.length === 0) { box.innerHTML = ''; return; }
    const ultimo = propios.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    if (!puedeCorregirFichaje(ultimo)) { box.innerHTML = ''; return; }
    const minutosRestantes = Math.max(1, Math.ceil((CORRECCION_PROPIA_VENTANA_MS - (Date.now() - new Date(ultimo.timestamp).getTime())) / 60000));
    box.innerHTML = `
        <small class="text-muted d-block mb-1">Último fichaje: ${TIPO_FICHAJE_LABEL[ultimo.type] || ultimo.type} a las ${ultimo.time}</small>
        <button class="btn btn-outline-warning btn-sm" id="btnAnularMiFichaje" onclick="anularYRegenerarPropioFichaje('${ultimo.id}')">
            <i class="bi bi-arrow-counterclockwise"></i> Anular y volver a fichar ahora (quedan ${minutosRestantes} min)
        </button>`;
}

// Recalcula "present"/"late" para el fichaje de reemplazo exactamente
// como registerAttendance() lo hace para un tipo 'entry' (mismo
// margen de tolerancia, misma alerta de Tardanza) - una salida/
// retirada nunca queda "late" acá tampoco, igual que en el fichaje
// normal.
function calcularEstadoFichajeAutomatico(teacher, type, now, time) {
    if (type !== 'entry') return 'present';
    const criteria = getCriteria();
    const lateLimit = criteria.lateLimit || 15;
    const todayDay = getDiaSemanaArgentina(now);
    const earliestStart = getEarliestScheduleTime(teacher, todayDay, materiaFichajeSeleccionada);
    if (!earliestStart) return 'present';
    const [startH, startM] = earliestStart.split(':').map(Number);
    const scheduledMinutes = startH * 60 + startM;
    const nowMinutes = getMinutosDesdeMedianocheArgentina(now);
    if (nowMinutes > scheduledMinutes + lateLimit) {
        createAlert(teacher, 'Tardanza', `Llegó tarde (${time}). Hora prevista: ${earliestStart}. Más de ${lateLimit} minutos de retraso.`);
        return 'late';
    }
    return 'present';
}

async function anularYRegenerarPropioFichaje(id) {
    const attendance = getAttendance();
    const record = attendance.find(a => a.id === id);
    if (!puedeCorregirFichaje(record)) {
        showToast('Ya no podés anular este fichaje (pasaron los 10 minutos o no es tuyo)', 'error');
        renderMiUltimoFichaje();
        return;
    }
    if (!confirm(`¿Anular tu fichaje de ${TIPO_FICHAJE_LABEL[record.type] || record.type} de las ${record.time}? Se te va a pedir tu ubicación de nuevo para generar uno nuevo automáticamente, con la hora actual.`)) return;

    const btn = document.getElementById('btnAnularMiFichaje');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Verificando tu ubicación...'; }

    // Igual que cualquier fichaje normal (confirmFaceAttendance()): GPS
    // automático del dispositivo, validado contra la geocerca - nunca
    // se genera el reemplazo sin esa verificación, para no abrir una
    // puerta a fichar "desde cualquier lado" con la excusa de corregir.
    const geo = await verifyGeofence();
    if (!geo.ok) {
        showGeofenceBlockModal(geo);
        renderMiUltimoFichaje();
        return;
    }

    const now = new Date();
    const date = getFechaHoyArgentina(now);
    const time = getHoraHHMMSSArgentina(now);
    const attStatus = calcularEstadoFichajeAutomatico(currentUser, record.type, now, time);

    record.anulado = true;
    record.anuladoEn = now.toISOString();

    const nuevoId = Date.now().toString();
    attendance.push({
        id: nuevoId,
        teacherId: currentUser.id,
        teacherName: `${currentUser.apellido} ${currentUser.nombre}`,
        date, time, type: record.type, status: attStatus, timestamp: now.toISOString(),
        horaFichajeReal: now.toISOString(),
        categoria: 'regular',
        materiaId: record.materiaId || null,
        corregidoPorDocente: true,
        fichajeAnuladoId: record.id,
        ...pendingGeofenceFields(geo),
        ...geoFichajeFields(geo),
    });
    saveAttendance(attendance);
    logAccion('CORRECCION_PROPIA_FICHAJE', `${currentUser.apellido} ${currentUser.nombre} anuló su fichaje de ${TIPO_FICHAJE_LABEL[record.type] || record.type} (${record.time}) y el sistema generó uno nuevo automático (${time})`, geo.coords || null);
    showToast('✅ Fichaje anterior anulado. Se generó tu nuevo fichaje automático.', 'success');
    renderMiUltimoFichaje();
    updateAttendanceButtonsState();
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

    // Anti-spoofing: si este DNI encadenó 3 pruebas de vida fallidas
    // seguidas (ver liveness.js), el fichaje queda bloqueado 2 minutos.
    // Se chequea antes que nada, ni siquiera se pide GPS.
    if (typeof isLivenessLocked === 'function' && isLivenessLocked(currentUser.dni)) {
        livenessStartLockCountdown(currentUser.dni);
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

    // Prueba de vida (Anti-Spoofing Nivel 1+2, ver liveness.js): "Mirá
    // al frente" + 3 gestos al azar (de un pool de 9: parpadeo,
    // sonrisa, giro, abrir boca, cejas, mirar arriba/abajo, fruncir
    // el ceño), en orden al azar, ANTES de gastar el reconocimiento
    // facial en una foto o un video grabado. Solo si esto pasa se
    // sigue a la comparación de rostro de siempre.
    if (typeof runLivenessCheck === 'function') {
        const liveness = await runLivenessCheck(video, currentUser.dni);
        if (!liveness.passed) {
            // Una falla real de la prueba de vida (no giró, no parpadeó,
            // más de un rostro) suma a las 3 seguidas que bloquean el DNI.
            // Que el modelo no haya podido cargar (sin internet) NO cuenta:
            // es un problema de conexión, no un intento de burlar el
            // fichaje.
            if (!liveness.unavailable) registerLivenessFailure(currentUser.dni);
            status.className = 'face-recognition-status error';
            status.innerHTML = `<i class="bi bi-shield-x"></i> ${liveness.reason}`;
            showToast(liveness.reason, 'error');
            if (isLivenessLocked(currentUser.dni)) livenessStartLockCountdown(currentUser.dni);
            return;
        }
        resetLivenessFailures(currentUser.dni);
        lastLivenessResult = liveness.checks;
    }

    if (typeof livenessReset === 'function') livenessReset(); // oculta el anillo/pasos de la prueba de vida, ya cumplida
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
        !(hasEntryToday(teacher.id, 'evento', ev.id) && hasExitToday(teacher.id, 'evento', ev.id))
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
                ${buildFichajeManualBlock(teacher, 'evento', ev.id, `'evento', ${ev.id}`, 'confirmFaceAttendance', { entrada: 'REGISTRAR INGRESO A EVENTO', salida: 'REGISTRAR SALIDA DE EVENTO' }, evExitType)}
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
    const nowMinutes = getMinutosDesdeMedianocheArgentina();
    const tolerance = CONFIG.EXIT_TOLERANCE_MINUTES;
    return { isExitTime: nowMinutes >= (scheduledMinutes - tolerance), scheduledEnd };
}

function registerFaceEventoAttendance(type, teacher, eventoInfo, geo) {
    const yaEntro = hasEntryToday(teacher.id, 'evento', eventoInfo.id);
    const yaSalio = hasExitToday(teacher.id, 'evento', eventoInfo.id);
    if (type === 'entry' && yaEntro) { showToast('⚠️ Ya registraste tu ingreso a este evento.', 'warning'); return false; }
    if ((type === 'exit' || type === 'early_exit') && (!yaEntro || yaSalio)) { showToast('⚠️ Todavía no registraste tu ingreso a este evento.', 'warning'); return false; }

    const now = new Date();
    const date = getFechaHoyArgentina(now);
    const time = getHoraHHMMSSArgentina(now);
    let attStatus = 'present';

    if (type === 'entry') {
        const earliestStart = (eventoInfo.hora_entrada || '').slice(0, 5) || null;
        if (earliestStart) {
            const criteria = getCriteria();
            const lateLimit = criteria.lateLimit || 15;
            const [startH, startM] = earliestStart.split(':').map(Number);
            const scheduledMinutes = startH * 60 + startM;
            const nowMinutes = getMinutosDesdeMedianocheArgentina(now);
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
    const attendanceId = Date.now().toString();
    attendance.push({
        id: attendanceId,
        teacherId: teacher.id,
        teacherName: `${teacher.apellido} ${teacher.nombre}`,
        date, time, type, status: attStatus, timestamp: now.toISOString(),
        horaFichajeReal: now.toISOString(),
        categoria: 'evento',
        eventoId: eventoInfo.id,
        eventoTitulo: eventoInfo.titulo,
        eventoHoraEntrada: (eventoInfo.hora_entrada || '').slice(0, 5),
        eventoHoraSalida: (eventoInfo.hora_salida || '').slice(0, 5),
        salidaAnticipada,
        ...pendingGeofenceFields(geo),
        ...geoFichajeFields(geo),
        ...consumeLivenessFields(),
    });
    saveAttendance(attendance);
    logAccion('FICHAJE_EVENTO', `${type.toUpperCase()} evento "${eventoInfo.titulo}" - ${teacher.apellido} ${teacher.nombre} - ${time}`, geo && geo.coords ? geo.coords : null);
    if (geo && geo.coords && navigator.onLine) completarDireccionEIp(attendanceId, geo.coords.lat, geo.coords.lng, 'attendance');

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
        eventoInfo = getEventosDeHoyParaDocente(teacher.id).find(ev => ev.id === eventoId);
        if (!eventoInfo) { showToast('Evento no encontrado', 'error'); renderFaceAttendanceModalBody(); return; }
    }

    // Segunda verificación de geocerca, justo antes de confirmar el
    // registro (por si se movió entre que se abrió el modal y tocó
    // el botón, o si alguien intenta forzar el registro sin pasar
    // por acá). Se pausa el timeout de 60s mientras se espera el GPS.
    //
    // Para categoria 'evento': si el evento tiene geocerca propia, se
    // valida CONTRA ESA (no contra la del colegio) - ver
    // getEventoGeofenceOverride(). Si el evento no tiene geocerca
    // activada, se ficha "normal" (solo reconocimiento facial, sin
    // pedir ni validar ubicación) exactamente como cualquier evento
    // hasta ahora.
    const geofenceOverride = categoria === 'evento' ? getEventoGeofenceOverride(eventoInfo) : undefined;
    const skipGeofence = categoria === 'evento' && !geofenceOverride;

    let geo;
    if (skipGeofence) {
        geo = { ok: true, bypass: 'evento_sin_geocerca' };
    } else {
        clearFaceModalTimeout();
        const body0 = document.getElementById('faceAttendanceModalBody');
        body0.innerHTML = `<div class="spinner-border text-primary mb-2"></div><p class="mb-0">Verificando tu ubicación...</p>`;
        geo = await verifyGeofence(geofenceOverride);
    }
    if (!geo.ok) {
        showGeofenceBlockModal(geo);
        renderFaceAttendanceModalBody();
        resetFaceModalTimeout();
        return;
    }

    const ok = categoria === 'evento' ? registerFaceEventoAttendance(type, teacher, eventoInfo, geo) : registerAttendance(type, geo);
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
    const pendingNote = (geo && geo.pendingGeofence)
        ? `<div class="alert alert-warning py-2 px-3 mb-3 small"><i class="bi bi-wifi-off"></i> Fichaje offline guardado — se validará tu ubicación cuando vuelva la conexión.</div>`
        : '';
    const body = document.getElementById('faceAttendanceModalBody');
    body.innerHTML = `
        <div class="text-success mb-2" style="font-size:3rem;"><i class="bi bi-check-circle-fill"></i></div>
        <h5>${label} registrado ${time}</h5>
        <p class="text-muted mb-3">${teacher.apellido} ${teacher.nombre}</p>
        ${pendingNote}
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
    lastLivenessResult = null; // no reusar una prueba de vida vieja en un fichaje futuro
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
function registerAttendance(type, geo) {
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
    const date = getFechaHoyArgentina(now);
    const time = getHoraHHMMSSArgentina(now);
    const status = document.getElementById('faceRecognitionStatus');
    let attStatus = 'present';
    const criteria = getCriteria();
    const lateLimit = criteria.lateLimit || 15;

    if (type === 'entry') {
        const todayDay = getDiaSemanaArgentina(now);
        const earliestStart = getEarliestScheduleTime(recognizedTeacher, todayDay, materiaFichajeSeleccionada);
        if (earliestStart) {
            const [startH, startM] = earliestStart.split(':').map(Number);
            const scheduledMinutes = startH * 60 + startM;
            const nowMinutes = getMinutosDesdeMedianocheArgentina(now);
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
    const todayDay = getDiaSemanaArgentina(now);
    const exitInfo = getExitWindowInfo(recognizedTeacher, materiaFichajeSeleccionada);

    if (type === 'exit' && !exitInfo.isExitTime) {
        showToast('⚠️ Todavía no es tu horario de salida. Usá "Salir antes de tiempo".', 'warning');
        updateAttendanceButtonsState();
        return false;
    }

    if (type === 'early_exit') {
        const scheduledEnd = exitInfo.scheduledEnd || getLatestScheduleEndTime(recognizedTeacher, todayDay, materiaFichajeSeleccionada);
        const horarioTexto = scheduledEnd ? `${todayDay} hasta las ${scheduledEnd}` : 'sin horario cargado para hoy';
        createAlert(recognizedTeacher, 'Salida Anticipada', `Salida anticipada - ${teacherFullName} - ${time} - Horario que correspondía: ${horarioTexto}`);
    }

    const typeMap = { 'entry': 'ENTRADA', 'exit': 'SALIDA', 'early_exit': 'SALIDA ANTES DE TIEMPO' };
    const attendance = getAttendance();
    const attendanceId = Date.now().toString();
    attendance.push({
        id: attendanceId,
        teacherId: recognizedTeacher.id,
        teacherName: `${recognizedTeacher.apellido} ${recognizedTeacher.nombre}`,
        date, time, type, status: attStatus, timestamp: now.toISOString(),
        horaFichajeReal: now.toISOString(),
        categoria: 'regular',
        materiaId: materiaFichajeSeleccionada || null,
        ...pendingGeofenceFields(geo),
        ...geoFichajeFields(geo),
        ...consumeLivenessFields(),
    });
    saveAttendance(attendance);
    logAccion('FICHAJE', `${typeMap[type]} - ${teacherFullName} - ${time}`, geo && geo.coords ? geo.coords : null);
    // Dirección/IP en segundo plano: si hay conexión ahora mismo (no
    // pasó por el bypass offline), no hace falta esperar a reconectar.
    if (geo && geo.coords && navigator.onLine) completarDireccionEIp(attendanceId, geo.coords.lat, geo.coords.lng, 'attendance');
    renderMiUltimoFichaje();

    const needsAttention = attStatus === 'late' || type === 'early_exit';
    const warningNote = attStatus === 'late' ? ' ⚠️ Tardanza'
        : type === 'early_exit' ? ' ⚠️ Queda pendiente de justificación' : '';
    status.className = `face-recognition-status ${needsAttention ? 'warning' : 'success'}`;
    status.innerHTML = `<i class="bi bi-check-circle"></i> ✅ ${typeMap[type]} a las ${time}${warningNote}<br><small>Verificado facialmente</small>`;
    showToast(`${needsAttention ? '⚠️' : '✅'} ${typeMap[type]} registrada${type === 'early_exit' ? ' — queda pendiente de justificación' : ''}`, needsAttention ? 'warning' : 'success');
    if (geo && geo.pendingGeofence) {
        showToast('🟡 Fichaje offline guardado — se validará tu ubicación cuando vuelva la conexión.', 'warning');
    }

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
    const todayStr = getFechaHoyArgentina();
    return getAttendance().some(a => a.teacherId === teacherId && (a.type === 'exit' || a.type === 'early_exit') && getFechaRealFichaje(a) === todayStr &&
        (a.categoria || 'regular') === categoria &&
        (categoria !== 'evento' || a.eventoId === eventoId) && !a.anulado);
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
    const todayStr = getFechaHoyArgentina();
    const registros = getAttendance().filter(a => a.teacherId === teacher.id && getFechaRealFichaje(a) === todayStr &&
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
                ${buildFichajeManualBlock(teacher, 'evento', ev.id, `'evento', ${ev.id}`)}
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
    if (!tienePermiso(currentUser.rol, 'fichaje_manual')) {
        showToast(mensajeSinPermiso('fichaje_manual'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó hacer un fichaje manual sin permiso');
        return;
    }
    categoria = categoria || 'regular';
    const teacher = getTeachers().find(t => t.id === manualAttendanceTeacherId);
    if (!teacher) { showToast('Docente no encontrado', 'error'); return; }

    let eventoInfo = null;
    if (categoria === 'evento') {
        eventoInfo = getEventosDeHoyParaDocente(teacher.id).find(ev => ev.id === eventoId);
        if (!eventoInfo) { showToast('Evento no encontrado', 'error'); return; }
    }

    const yaEntro = hasEntryToday(teacher.id, categoria, eventoId);
    const yaSalio = hasExitToday(teacher.id, categoria, eventoId);
    if (type === 'entry' && yaEntro) { showToast('⚠️ Ya tiene un ingreso registrado' + (categoria === 'evento' ? ' para este evento' : ' hoy'), 'warning'); return; }
    if (type === 'exit' && (!yaEntro || yaSalio)) { showToast('⚠️ No corresponde registrar salida en este estado', 'warning'); return; }

    const now = new Date();
    const date = getFechaHoyArgentina(now);
    const time = getHoraHHMMSSArgentina(now);
    let attStatus = 'present';
    const criteria = getCriteria();
    const lateLimit = criteria.lateLimit || 15;

    if (type === 'entry') {
        const earliestStart = categoria === 'evento'
            ? ((eventoInfo.hora_entrada || '').slice(0, 5) || null)
            : getEarliestScheduleTime(teacher, getDiaSemanaArgentina(now));
        if (earliestStart) {
            const [startH, startM] = earliestStart.split(':').map(Number);
            const scheduledMinutes = startH * 60 + startM;
            const nowMinutes = getMinutosDesdeMedianocheArgentina(now);
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
        record.eventoId = eventoInfo.id;
        record.eventoTitulo = eventoInfo.titulo;
        record.eventoHoraEntrada = (eventoInfo.hora_entrada || '').slice(0, 5);
        record.eventoHoraSalida = (eventoInfo.hora_salida || '').slice(0, 5);
    }
    const attendance = getAttendance();
    attendance.push(record);
    saveAttendance(attendance);
    logAccion('FICHAJE_MANUAL', `${type.toUpperCase()} manual - ${teacher.apellido} ${teacher.nombre} - ${time}`);

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
// materiaId opcional: si el docente tiene 2+ materias, el fichaje usa
// el horario de LA materia elegida (ver materiaFichajeSeleccionada),
// no la unión de todas. Sin materiaId (o docente sin materias todavía)
// cae a getHorarioEfectivo() = unión de materias, o horario_laboral si
// no tiene ninguna.
function getEarliestScheduleTime(teacher, dayName, materiaId) {
    let horario = getHorarioEfectivo(teacher);
    if (materiaId) horario = horario.filter(h => h.materiaId === materiaId);
    const times = horario.filter(h => h.dia === dayName).map(h => h.inicio);
    if (times.length === 0) return null;
    return times.sort()[0];
}

// Hora de fin (HH:MM) más tardía que tiene el docente agendada
// para un día de la semana dado. Es la hora de salida "oficial"
// contra la que se valida el botón de Salida.
function getLatestScheduleEndTime(teacher, dayName, materiaId) {
    let horario = getHorarioEfectivo(teacher);
    if (materiaId) horario = horario.filter(h => h.materiaId === materiaId);
    const times = horario.filter(h => h.dia === dayName).map(h => h.fin);
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
function getExitWindowInfo(teacher, materiaId) {
    const now = new Date();
    const todayDay = getDiaSemanaArgentina(now);
    const scheduledEnd = getLatestScheduleEndTime(teacher, todayDay, materiaId);
    if (!scheduledEnd) return { isExitTime: false, scheduledEnd: null };
    const [endH, endM] = scheduledEnd.split(':').map(Number);
    const scheduledMinutes = endH * 60 + endM;
    const nowMinutes = getMinutosDesdeMedianocheArgentina(now);
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
    if (!tienePermiso(currentUser.rol, 'borrar')) {
        showToast(mensajeSinPermiso('borrar'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó borrar una licencia sin permiso');
        return;
    }
    const licencias = getLicencias().filter(l => l.id !== id);
    saveLicenciasToStorage(licencias);
    loadLicenciasList();
    logAccion('BORRAR_LICENCIA', `Eliminó la licencia ${id}`);
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
            <td data-label="Docente">${l.teacherName}</td>
            <td data-label="Desde">${l.from}</td>
            <td data-label="Hasta">${l.to}</td>
            <td data-label="Motivo">${l.motivo}</td>
            <td data-label="Acciones">${tienePermiso(currentUser.rol, 'borrar') ? `<button class="btn btn-sm btn-danger" title="Eliminar" onclick="deleteLicencia('${l.id}')"><i class="bi bi-trash"></i></button>` : ''}</td>
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

// evento_especial guarda fecha_inicio/fecha_fin como timestamp SIN zona
// horaria (no fecha + hora_entrada + hora_salida por separado). Se
// derivan esos 3 campos acá, una sola vez al cargar cada evento, para
// que el resto del código (tardanza, salida anticipada, renders del
// fichaje) siga funcionando sin tener que tocar cada lugar que los usa.
// Se parsea con split('T') a propósito, nunca con new Date(...): al no
// tener offset, new Date() lo reinterpreta como hora local o UTC según
// el navegador y corre la fecha/hora mostrada.
function normalizeEventoEspecial(ev) {
    const [fechaInicio, horaInicio] = (ev.fecha_inicio || '').split('T');
    const [, horaFin] = (ev.fecha_fin || '').split('T');
    return {
        ...ev,
        fecha: fechaInicio || '',
        hora_entrada: (horaInicio || '').slice(0, 5),
        hora_salida: (horaFin || '').slice(0, 5),
    };
}

// Inversa de normalizeEventoEspecial: arma el string que espera la
// columna fecha_inicio/fecha_fin (timestamp SIN zona horaria) a partir
// de un <input type="date"> + <input type="time"> del formulario.
// Ojo: nunca pasar esto por new Date()/toISOString() - eso reinterpreta
// la hora local como si fuera UTC (o viceversa) y desplaza fecha/hora
// según la zona horaria del navegador.
function combinarFechaHora(fechaStr, horaStr) {
    return `${fechaStr}T${horaStr || '00:00'}:00`;
}
// Convocatorias a eventos especiales por docente (id numérico ->
// array de {id, titulo, fecha, hora_entrada, hora_salida}).
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

// Refleja un docente de app_data.teachers en la tabla relacional
// `docentes` (id autogenerado, escuela_id, dni, nombre, apellido, email,
// teléfono, password - ver supabase-schema.sql), para que evento_docente
// pueda referenciarlo sin violar la FK. Se llama para cada docente
// convocado justo antes de guardar un Evento Especial.
//
// La tabla `docente` (singular) vieja ya no existe: usaba el mismo id de
// app_data.teachers como PK, así que evento_docente.docente_id coincidía
// directo con teacher.id. `docentes` (plural) genera su propio id, así
// que el cruce ahora es por DNI (único y estable entre ambos lados) en
// vez de por id. Devuelve el id real de `docentes`, o null si falló (en
// cuyo caso ese docente se omite del evento).
async function syncTeacherToDocenteTable(teacher) {
    if (!sb) return null;
    try {
        const { data, error } = await sb.from('docentes').upsert({
            escuela_id: ESCUELA_ID,
            dni: teacher.dni,
            nombre: teacher.nombre,
            apellido: teacher.apellido,
            email: teacher.email || null,
            telefono: teacher.telefono || null,
            password: teacher.password,
            calle: normalizarCampoDomicilio(teacher.calle),
            numero: normalizarCampoDomicilio(teacher.numero),
            barrio: normalizarCampoDomicilio(teacher.barrio),
            localidad: normalizarCampoDomicilio(teacher.localidad) || 'RESISTENCIA',
            provincia: normalizarCampoDomicilio(teacher.provincia) || 'CHACO',
            pais: normalizarCampoDomicilio(teacher.pais) || 'ARGENTINA',
        }, { onConflict: 'dni' }).select('id').single();
        if (error) throw error;
        return data.id;
    } catch (error) {
        console.error('No se pudo sincronizar el docente "' + teacher.apellido + '" a la tabla docentes:', error);
        showToast(`No se pudo sincronizar a ${teacher.apellido} ${teacher.nombre} con Supabase (${describeSupabaseError(error)})`, 'warning');
        return null;
    }
}

// Inversa de syncTeacherToDocenteTable: dado un array de ids de
// `docentes` (evento_docente.docente_id), devuelve un mapa
// { docente_id: teacher de app_data } cruzando por DNI.
async function getTeachersByDocenteIds(docenteIds) {
    const result = {};
    if (!sb || !docenteIds || docenteIds.length === 0) return result;
    const { data, error } = await sb.from('docentes').select('id, dni').in('id', docenteIds);
    if (error) throw error;
    const teachers = getTeachers();
    (data || []).forEach(d => {
        const teacher = teachers.find(t => t.dni === d.dni);
        if (teacher) result[d.id] = teacher;
    });
    return result;
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
        // Mismo fix que loadEventosEspeciales(): en vez del embed
        // `evento_docente(docente_id, evento_especial(...))` (que depende
        // de que PostgREST tenga detectada la FK y puede fallar con
        // PGRST200), se hacen 2 queries separadas y se cruzan acá.
        // evento_docente usa evento_id/docente_id (no id_evento/id_docente).
        const { data: convocatorias, error: convError } = await sb
            .from('evento_docente')
            .select('docente_id, evento_id');
        if (convError) throw convError;
        if (!convocatorias || convocatorias.length === 0) return;

        const idsEventos = [...new Set(convocatorias.map(row => row.evento_id))];
        const { data: eventos, error: eventosError } = await sb
            .from('evento_especial')
            .select('id,escuela_id,titulo,fecha_inicio,fecha_fin,tiene_geocerca,geocerca_lat,geocerca_lng,geocerca_radio,direccion_evento,tipo_cumplimiento')
            .in('id', idsEventos);
        if (eventosError) throw eventosError;

        const eventoPorId = {};
        (eventos || []).forEach(ev => { eventoPorId[ev.id] = normalizeEventoEspecial(ev); });

        convocatorias.forEach(row => {
            const ev = eventoPorId[row.evento_id];
            if (!ev || !ev.fecha) return;
            const id = Number(row.docente_id);
            if (!eventoConvocatoriasPorDocente[id]) eventoConvocatoriasPorDocente[id] = [];
            eventoConvocatoriasPorDocente[id].push(ev);
        });
    } catch (error) {
        console.error('No se pudieron cargar las convocatorias a eventos especiales por docente:', error);
    }
}

// Solo cuenta los eventos "con perjuicio de funciones": son los únicos
// que eximen al docente de su cátedra regular ese día (ver
// checkFaltas() y getDocentesEsperadosHoy()). Los "sin perjuicio" NO
// eximen nada - son una obligación aparte, además de la cátedra normal.
function teacherHasEventoConPerjuicioOnDate(teacherId, dateStr) {
    const eventos = eventoConvocatoriasPorDocente[Number(teacherId)] || [];
    return eventos.some(ev => ev.fecha === dateStr && (ev.tipo_cumplimiento || 'CON_PERJUICIO') === 'CON_PERJUICIO');
}

// Eventos especiales de HOY a los que está convocado un docente.
// Sincrónico: usa el caché ya cargado por loadEventoConvocatoriasPorDocente(),
// que loadAdminDashboard() garantiza fresco antes de que el admin
// pueda abrir el modal de Fichaje Manual.
function getEventosDeHoyParaDocente(teacherId) {
    const todayStr = getFechaHoyArgentina();
    const eventos = eventoConvocatoriasPorDocente[Number(teacherId)] || [];
    const eventosDeHoy = eventos.filter(ev => ev.fecha === todayStr);
    // Deduplicar por id_evento: si evento_docente tiene más de una
    // fila para el mismo docente+evento (convocatoria cargada dos
    // veces), esto evita que el mismo evento se renderice repetido
    // en el modal de fichaje. Se corrige acá porque este helper es
    // el único punto de entrada para ambos flujos (facial y manual).
    return [...new Map(eventosDeHoy.map(e => [e.id, e])).values()];
}

async function loadEventosEspeciales() {
    const tbody = document.getElementById('eventosTableBody');
    if (!tbody) return;
    if (!sb) { tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Sin conexión a Supabase</td></tr>'; return; }
    try {
        // Antes esto pedía evento_docente(count) como embed de PostgREST,
        // que depende de que su caché de esquema tenga detectada la FK
        // entre evento_especial y evento_docente - si no la tiene, devuelve
        // PGRST200 ("Could not find a relationship..."). Se reemplaza por
        // 2 queries separadas (sin join automático) y se cruzan acá.
        const { data: eventosData, error: eventosError } = await sb
            .from('evento_especial')
            .select('id,escuela_id,titulo,descripcion,fecha_inicio,fecha_fin,tiene_geocerca,geocerca_lat,geocerca_lng,geocerca_radio,direccion_evento,tipo_cumplimiento')
            .order('fecha_inicio', { ascending: false });
        if (eventosError) throw eventosError;
        currentEventos = (eventosData || []).map(normalizeEventoEspecial);

        if (currentEventos.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No hay eventos</td></tr>';
            return;
        }

        // Segunda query: conteo de docentes por evento. Si esta falla (o
        // evento_docente está vacía), no se trata como error de la tabla -
        // se muestra "Sin docentes asignados" en esa columna en vez de 0
        // silencioso o un mensaje de error.
        const idsEventos = currentEventos.map(ev => ev.id);
        const conteoPorEvento = {};
        try {
            const { data: docentesData, error: docentesError } = await sb
                .from('evento_docente')
                .select('evento_id')
                .in('evento_id', idsEventos);
            if (docentesError) throw docentesError;
            (docentesData || []).forEach(row => {
                conteoPorEvento[row.evento_id] = (conteoPorEvento[row.evento_id] || 0) + 1;
            });
        } catch (docentesError) {
            console.error('No se pudo cargar evento_docente (se muestra la tabla de eventos igual, sin conteo):', docentesError);
        }

        tbody.innerHTML = currentEventos.map(ev => {
            const cantDocentes = conteoPorEvento[ev.id] || 0;
            const docentesCell = cantDocentes > 0 ? cantDocentes : '<span class="text-muted">Sin docentes asignados</span>';
            return `
                <tr>
                    <td data-label="Título">${ev.titulo}</td>
                    <td data-label="Descripción">${ev.descripcion || '-'}</td>
                    <td data-label="Fecha inicio → Fin">${ev.fecha} ${ev.hora_entrada} &rarr; ${ev.hora_salida}</td>
                    <td data-label="Escuela">${ev.escuela_id}</td>
                    <td data-label="Docentes">${docentesCell}</td>
                    <td data-label="Acciones">
                        <button class="btn btn-sm btn-info" title="Ver" onclick="viewEvento(${ev.id})"><i class="bi bi-eye"></i></button>
                        <button class="btn btn-sm btn-primary" title="Editar" onclick="editEvento(${ev.id})"><i class="bi bi-pencil"></i></button>
                        ${tienePermiso(currentUser.rol, 'borrar') ? `<button class="btn btn-sm btn-danger" title="Eliminar" onclick="deleteEvento(${ev.id})"><i class="bi bi-trash"></i></button>` : ''}
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
    document.getElementById('eventoTipoCumplimientoCon').checked = true;
    document.getElementById('eventoTieneGeocerca').checked = false;
    document.getElementById('eventoTieneGeocerca').disabled = !tienePermiso(currentUser.rol, 'editar_geo');
    document.getElementById('eventoGeocercaLat').value = '';
    document.getElementById('eventoGeocercaLng').value = '';
    document.getElementById('eventoGeocercaRadio').value = 150;
    document.getElementById('eventoGeocercaRadioLabel').textContent = 150;
    document.getElementById('eventoGeocercaFields').classList.add('hidden');
    resetGeocercaMap('evento');
    document.getElementById('eventoDocenteSearch').value = '';
    renderEventoDocenteChecklist();
    new bootstrap.Modal(document.getElementById('eventoModal')).show();
}

async function editEvento(idEvento) {
    const ev = currentEventos.find(e => e.id === idEvento);
    if (!ev) { showToast('Evento no encontrado', 'error'); return; }
    editingEventoId = idEvento;
    document.getElementById('eventoModalTitle').innerHTML = '<i class="bi bi-pencil"></i> Editar Evento Especial';
    document.getElementById('eventoTitulo').value = ev.titulo || '';
    document.getElementById('eventoDescripcion').value = ev.descripcion || '';
    document.getElementById('eventoFecha').value = ev.fecha || '';
    document.getElementById('eventoHoraEntrada').value = (ev.hora_entrada || '').slice(0, 5);
    document.getElementById('eventoHoraSalida').value = (ev.hora_salida || '').slice(0, 5);
    document.getElementById('eventoLugar').value = ev.direccion_evento || '';
    const esSinPerjuicio = ev.tipo_cumplimiento === 'SIN_PERJUICIO';
    document.getElementById('eventoTipoCumplimientoSin').checked = esSinPerjuicio;
    document.getElementById('eventoTipoCumplimientoCon').checked = !esSinPerjuicio;
    document.getElementById('eventoTieneGeocerca').checked = !!ev.tiene_geocerca;
    document.getElementById('eventoTieneGeocerca').disabled = !tienePermiso(currentUser.rol, 'editar_geo');
    document.getElementById('eventoGeocercaLat').value = ev.geocerca_lat ?? '';
    document.getElementById('eventoGeocercaLng').value = ev.geocerca_lng ?? '';
    document.getElementById('eventoGeocercaRadio').value = ev.geocerca_radio || 150;
    document.getElementById('eventoGeocercaRadioLabel').textContent = ev.geocerca_radio || 150;
    document.getElementById('eventoGeocercaFields').classList.toggle('hidden', !ev.tiene_geocerca);
    if (ev.tiene_geocerca) updateEventoGeocercaMapPreview();
    else resetGeocercaMap('evento');
    document.getElementById('eventoDocenteSearch').value = '';

    try {
        const { data, error } = await sb.from('evento_docente').select('docente_id').eq('evento_id', idEvento);
        if (error) throw error;
        const docenteIds = (data || []).map(row => row.docente_id);
        const teacherPorDocenteId = await getTeachersByDocenteIds(docenteIds);
        eventoSelectedTeacherIds = docenteIds
            .map(id => teacherPorDocenteId[id] ? teacherPorDocenteId[id].id : null)
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
    const ev = currentEventos.find(e => e.id === idEvento);
    if (!ev) { showToast('Evento no encontrado', 'error'); return; }
    document.getElementById('eventoViewModalTitle').innerHTML = `<i class="bi bi-calendar-event"></i> ${ev.titulo}`;
    const geocercaInfo = ev.tiene_geocerca
        ? `Sí — radio ${ev.geocerca_radio}mts (<a href="https://www.google.com/maps?q=${ev.geocerca_lat},${ev.geocerca_lng}" target="_blank" rel="noopener">ver punto</a>)`
        : 'No';
    const tipoCumplimientoTxt = ev.tipo_cumplimiento === 'SIN_PERJUICIO'
        ? 'SIN perjuicio (va al evento Y debe dar clases igual)'
        : 'CON perjuicio (solo va al evento, no da clases ese día)';
    document.getElementById('eventoViewBody').innerHTML = `
        <p><strong>Fecha:</strong> ${ev.fecha}</p>
        <p><strong>Horario:</strong> ${(ev.hora_entrada || '').slice(0, 5)} - ${(ev.hora_salida || '').slice(0, 5)}</p>
        <p><strong>Cumplimiento:</strong> ${tipoCumplimientoTxt}</p>
        <p><strong>Escuela:</strong> ${ev.escuela_id}</p>
        <p><strong>Lugar / Dirección:</strong> ${ev.direccion_evento || '-'}</p>
        <p><strong>Geocerca:</strong> ${geocercaInfo}</p>
        <p><strong>Descripción:</strong> ${ev.descripcion || '-'}</p>
        <p class="mb-1"><strong>Docentes convocados:</strong></p>
        <div id="eventoViewDocentes"><span class="text-muted">Cargando...</span></div>
    `;
    new bootstrap.Modal(document.getElementById('eventoViewModal')).show();

    try {
        const { data, error } = await sb.from('evento_docente').select('docente_id').eq('evento_id', idEvento);
        if (error) throw error;
        const docenteIds = (data || []).map(row => row.docente_id);
        const teacherPorDocenteId = await getTeachersByDocenteIds(docenteIds);
        const names = docenteIds.map(id => {
            const t = teacherPorDocenteId[id];
            return t ? `${t.apellido} ${t.nombre}` : `Docente #${id}`;
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
    const direccionEvento = document.getElementById('eventoLugar').value.trim();
    const tipoCumplimiento = document.getElementById('eventoTipoCumplimientoSin').checked ? 'SIN_PERJUICIO' : 'CON_PERJUICIO';
    const tieneGeocerca = document.getElementById('eventoTieneGeocerca').checked;

    if (tieneGeocerca && !tienePermiso(currentUser.rol, 'editar_geo')) {
        showToast(mensajeSinPermiso('editar_geo'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó crear geocerca de evento sin permiso');
        return;
    }
    if (!titulo) { showToast('El título es obligatorio', 'error'); return; }
    if (!fecha) { showToast('La fecha es obligatoria', 'error'); return; }
    if (!horaEntrada || !horaSalida) { showToast('Completá la hora de entrada y de salida', 'error'); return; }
    if (horaSalida <= horaEntrada) { showToast('La hora de salida debe ser posterior a la de entrada', 'error'); return; }
    if (!sb) { showToast('Sin conexión a Supabase, no se puede guardar', 'error'); return; }

    // Geocerca del evento: opcional, solo si se tildó el switch. Mismo
    // rango de radio que la geocerca del colegio (150-500mts: menos de
    // 150m el GPS de un celular común en Argentina rebota y bloquea
    // fichajes válidos, ver verifyGeofence()).
    let geocercaLat = null, geocercaLng = null, geocercaRadio = null;
    if (tieneGeocerca) {
        geocercaLat = parseFloat(document.getElementById('eventoGeocercaLat').value);
        geocercaLng = parseFloat(document.getElementById('eventoGeocercaLng').value);
        geocercaRadio = parseInt(document.getElementById('eventoGeocercaRadio').value, 10);
        if (!validarGeocerca('eventoGeocercaLat', 'eventoGeocercaLng')) {
            showToast('Marcá una ubicación válida para la geocerca del evento (hacé clic en el mapa, buscá una dirección, o usá "Usar mi ubicación actual")', 'error');
            return;
        }
        if (!Number.isFinite(geocercaRadio) || geocercaRadio < 150 || geocercaRadio > 500) {
            showToast('El radio de la geocerca del evento debe estar entre 150 y 500 metros', 'error');
            return;
        }
    }

    // fecha_inicio/fecha_fin son timestamp sin zona horaria: se arman
    // combinando la fecha + cada hora del formulario tal cual el usuario
    // las eligió (ver combinarFechaHora arriba).
    const fechaInicio = combinarFechaHora(fecha, horaEntrada);
    const fechaFin = combinarFechaHora(fecha, horaSalida);
    const payload = {
        titulo, descripcion: descripcion || null, escuela_id: ESCUELA_ID, fecha_inicio: fechaInicio, fecha_fin: fechaFin,
        direccion_evento: direccionEvento || null,
        tipo_cumplimiento: tipoCumplimiento,
        tiene_geocerca: tieneGeocerca,
        geocerca_lat: tieneGeocerca ? geocercaLat : null,
        geocerca_lng: tieneGeocerca ? geocercaLng : null,
        geocerca_radio: tieneGeocerca ? geocercaRadio : null,
    };

    // Anti-duplicado: si ya existe un evento con el mismo título +
    // fecha_inicio (p. ej. por un doble clic en "Guardar"), se avisa y
    // no se inserta uno nuevo. Al editar, se excluye el propio evento de
    // la búsqueda (si no, siempre "chocaría" contra sí mismo). Esto es
    // la validación de UX; el freno real contra la condición de carrera
    // (dos clics casi simultáneos) es la constraint UNIQUE en Supabase
    // (si existe todavía sobre las columnas viejas, puede no aplicar más
    // - ver "unique_evento_dia_horario" en fix_unique_evento.sql).
    let dupQuery = sb.from('evento_especial').select('id').eq('titulo', titulo).eq('fecha_inicio', fechaInicio).limit(1);
    if (editingEventoId) dupQuery = dupQuery.neq('id', editingEventoId);
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
            const { error } = await sb.from('evento_especial').update(payload).eq('id', idEvento);
            if (error) throw error;
            const { error: delError } = await sb.from('evento_docente').delete().eq('evento_id', idEvento);
            if (delError) throw delError;
        } else {
            const { data, error } = await sb.from('evento_especial').insert(payload).select('id').single();
            if (error) throw error;
            idEvento = data.id;
        }

        // Sincroniza cada docente convocado a la tabla `docente` (para que
        // la FK de evento_docente no falle) y arma las filas a insertar.
        // PENDIENTE: `docente` (singular) ya no existe en Supabase - la
        // tabla real ahora es `docentes` (con escuela_id, dni, etc., ver
        // supabase-schema.sql). syncTeacherToDocenteTable() todavía apunta
        // a la tabla vieja, así que esto siempre devuelve null por ahora
        // y no se convoca a ningún docente hasta que se defina cómo
        // vincular app_data.teachers con la tabla `docentes` nueva.
        const teachers = getTeachers();
        const rows = [];
        for (const teacherId of eventoSelectedTeacherIds) {
            const teacher = teachers.find(t => t.id === teacherId);
            if (!teacher) continue;
            const idDocente = await syncTeacherToDocenteTable(teacher);
            if (idDocente !== null) rows.push({ evento_id: idEvento, docente_id: idDocente });
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
    if (!tienePermiso(currentUser.rol, 'borrar')) {
        showToast(mensajeSinPermiso('borrar'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó borrar un evento especial sin permiso');
        return;
    }
    if (!confirm('¿Eliminar este evento especial? Esta acción no se puede deshacer.')) return;
    try {
        // Primero los vínculos con docentes (por si la FK no tiene cascade),
        // después el evento en sí.
        const { error: delDocError } = await sb.from('evento_docente').delete().eq('evento_id', idEvento);
        if (delDocError) throw delDocError;
        const { error } = await sb.from('evento_especial').delete().eq('id', idEvento);
        if (error) throw error;
        // Las alertas de Falta/Tardanza de este evento ya no aplican.
        const alerts = getAlerts().filter(a => a.eventoId !== idEvento);
        saveAlerts(alerts);

        logAccion('BORRAR_EVENTO', `Eliminó el evento especial ${idEvento}`);
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
// MATERIAS - grilla de cátedra por carrera/año/cuatrimestre
// (tablas `carreras`/`materias`, ver add_tabla_materias.sql).
//
// Capa APARTE del horario_laboral de cada docente: el horario que usa
// checkFaltas/getExitWindowInfo/registerAttendance para tardanzas,
// faltas y fichaje no cambia ni se toca acá. Esto es solo para armar y
// visualizar qué materia dicta cada docente en qué carrera/año/
// cuatrimestre. Un docente puede tener 0, 1 o varias materias.
//
// materias.profesor_id apunta a `docentes.id` (no a teacher.id de
// app_data - son ids distintos, ver syncTeacherToDocenteTable): por
// eso toda esta sección resuelve el docente real vía esa función y vía
// getTeachersByDocenteIds(), igual que ya hace el módulo de Eventos.
// ============================================================
let currentCarreras = [];
let currentMaterias = [];
let materiaProfesorPorDocenteId = {};
let editingMateriaId = null;
let grillaAnioSeleccionado = 1;
let grillaCuatSeleccionado = 1;

const DIAS_MATERIA_IDS = ['Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado', 'Domingo'];
function diaMateriaLabel(diaSinTilde) {
    return { Miercoles: 'Miércoles', Sabado: 'Sábado' }[diaSinTilde] || diaSinTilde;
}
function diaMateriaSinTilde(dia) {
    return dia.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function loadCarreras() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from('carreras').select('*').order('nombre');
        if (error) throw error;
        currentCarreras = data || [];
    } catch (error) {
        console.error('No se pudieron cargar las carreras:', error);
    }
    populateCarrerasSelects();
}

function populateCarrerasSelects() {
    const opciones = currentCarreras.map(c => `<option value="${c.id}">${c.nombre}</option>`).join('');
    const materiaSel = document.getElementById('materiaCarrera');
    const grillaSel = document.getElementById('grillaMateriasCarrera');
    if (materiaSel) {
        const actual = materiaSel.value;
        materiaSel.innerHTML = '<option value="">Seleccioná...</option>' + opciones;
        if (actual) materiaSel.value = actual;
    }
    if (grillaSel) {
        const actual = grillaSel.value;
        grillaSel.innerHTML = '<option value="">Seleccioná una carrera...</option>' + opciones;
        if (actual && currentCarreras.some(c => String(c.id) === actual)) grillaSel.value = actual;
    }
}

async function promptNuevaCarrera() {
    if (!tienePermiso(currentUser.rol, 'agregar_docente')) {
        showToast(mensajeSinPermiso('agregar_docente'), 'error');
        return;
    }
    const nombre = prompt('Nombre de la nueva carrera:');
    if (!nombre || !nombre.trim()) return;
    try {
        const { data, error } = await sb.from('carreras').insert({ nombre: nombre.trim(), escuela_id: ESCUELA_ID }).select('*').single();
        if (error) throw error;
        logAccion('ALTA_CARRERA', `Creó la carrera "${data.nombre}"`);
        await loadCarreras();
        const materiaSel = document.getElementById('materiaCarrera');
        if (materiaSel) materiaSel.value = data.id;
        showToast(`✅ Carrera "${data.nombre}" creada`, 'success');
    } catch (error) {
        console.error('No se pudo crear la carrera:', error);
        showToast('No se pudo crear la carrera (' + describeSupabaseError(error) + ')', 'error');
    }
}

async function loadMaterias() {
    if (!sb) return;
    try {
        const { data, error } = await sb.from('materias').select('*').order('nombre');
        if (error) throw error;
        currentMaterias = data || [];
        const idsAsignados = [...new Set(currentMaterias.map(m => m.profesor_id).filter(Boolean))];
        materiaProfesorPorDocenteId = await getTeachersByDocenteIds(idsAsignados);
    } catch (error) {
        console.error('No se pudieron cargar las materias:', error);
    }
}

// Dispara la carga de carreras/materias y pinta la grilla; se llama al
// entrar a la pestaña "Materias" (ver onclick en index.html).
async function loadMateriasTab() {
    await loadCarreras();
    await loadMaterias();
    renderGrillaMaterias();
}

function diasCorto(dias) {
    const abrev = { Lunes: 'Lun', Martes: 'Mar', Miércoles: 'Mié', Jueves: 'Jue', Viernes: 'Vie', Sábado: 'Sáb', Domingo: 'Dom' };
    return (dias || []).map(d => abrev[d] || d).join(' ');
}

// Case-insensitive a propósito: tipo puede haber quedado guardado como
// "Anual"/"ANUAL"/"anual" según quién la haya cargado.
function esMateriaAnual(m) {
    return (m.tipo || '').toUpperCase() === 'ANUAL';
}

// Normaliza el horario de una materia al formato nuevo, un horario por
// día: [{dia, inicio, fin}]. Compatibilidad con materias viejas que
// todavía no tienen `horarios` cargado (antes de add_horarios_por_dia_
// materias.sql: un solo hora_inicio/hora_fin para todos los `dias`) -
// se arma el mismo array al vuelo a partir de esas columnas.
function materiaHorarios(m) {
    if (Array.isArray(m.horarios) && m.horarios.length > 0) return m.horarios;
    return (m.dias || []).map(dia => ({
        dia,
        inicio: (m.hora_inicio || '').slice(0, 5),
        fin: (m.hora_fin || '').slice(0, 5),
    }));
}

// "Lun 18:00-19:20 | Mié 20:00-21:30" - usado en la grilla, el
// checklist del docente y la impresión (misma tabla).
function formatoHorariosCorto(m) {
    return materiaHorarios(m).map(h => `${diasCorto([h.dia])} ${h.inicio}-${h.fin}`).join(' | ');
}

function seleccionarAnioCuatGrilla(anio, cuat, btnEl) {
    grillaAnioSeleccionado = anio;
    grillaCuatSeleccionado = cuat;
    document.querySelectorAll('.grilla-anio-cuat-btn').forEach(b => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    renderGrillaMaterias();
}

function renderGrillaMaterias() {
    const tbody = document.getElementById('grillaMateriasTableBody');
    if (!tbody) return;
    const carreraId = document.getElementById('grillaMateriasCarrera')?.value;
    if (!carreraId) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Elegí una carrera</td></tr>';
        return;
    }
    // Anual = dura todo el año: aparece en los 2 cuatrimestres sin
    // importar en cuál se haya cargado, no se duplica en la base.
    const filtradas = currentMaterias.filter(m => String(m.carrera_id) === String(carreraId) && m.anio === grillaAnioSeleccionado && (esMateriaAnual(m) || m.cuatrimestre === grillaCuatSeleccionado));
    if (filtradas.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Sin materias cargadas para este año/cuatrimestre</td></tr>';
        return;
    }
    const puedeBorrar = tienePermiso(currentUser.rol, 'borrar');
    tbody.innerHTML = filtradas.map(m => {
        const profesor = m.profesor_id ? materiaProfesorPorDocenteId[m.profesor_id] : null;
        const profesorNombre = profesor ? `${profesor.apellido} ${profesor.nombre}` : '<span class="text-muted">Sin asignar</span>';
        return `
            <tr>
                <td data-label="Materia">${m.nombre}${esMateriaAnual(m) ? ' <span class="badge bg-info text-dark">ANUAL</span>' : ''}</td>
                <td data-label="Tipo">${esMateriaAnual(m) ? 'Anual' : 'Cuatrimestral'}</td>
                <td data-label="Días y Horario">${formatoHorariosCorto(m)}</td>
                <td data-label="Profesor Asignado">${profesorNombre}</td>
                <td data-label="Acciones">
                    <button class="btn btn-sm btn-primary" title="Editar" onclick="editMateria(${m.id})"><i class="bi bi-pencil"></i></button>
                    ${puedeBorrar ? `<button class="btn btn-sm btn-danger" title="Eliminar" onclick="deleteMateria(${m.id})"><i class="bi bi-trash"></i></button>` : ''}
                </td>
            </tr>`;
    }).join('');
}

function populateMateriaProfesorSelect(selectedTeacherId) {
    const sel = document.getElementById('materiaProfesor');
    if (!sel) return;
    const teachers = getTeachers().slice().sort((a, b) => a.apellido.localeCompare(b.apellido));
    sel.innerHTML = '<option value="">Sin asignar</option>' + teachers.map(t => `<option value="${t.id}">${t.apellido} ${t.nombre}</option>`).join('');
    sel.value = selectedTeacherId || '';
}

// Fila dinámica "Lunes: [inicio] - [fin]" que aparece/desaparece al
// tildar/destildar el checkbox de ese día (ver onchange en
// index.html). inicioPrefill/finPrefill se usan al editar una materia
// existente, para no perder el horario que ya tenía cargado ese día.
function toggleMateriaHorarioDia(diaSinTilde, checked, inicioPrefill, finPrefill) {
    const cont = document.getElementById('materiaHorariosPorDia');
    if (!cont) return;
    const filaId = 'materiaHorarioFila_' + diaSinTilde;
    if (!checked) {
        document.getElementById(filaId)?.remove();
        return;
    }
    if (document.getElementById(filaId)) return;
    const fila = document.createElement('div');
    fila.id = filaId;
    fila.className = 'row g-2 align-items-end mb-2';
    fila.innerHTML = `
        <div class="col-4"><span class="fw-semibold">${diaMateriaLabel(diaSinTilde)}</span></div>
        <div class="col-4">
            <label class="form-label small mb-1 text-muted">Inicio</label>
            <input type="time" class="form-control form-control-sm" id="materiaHorarioInicio_${diaSinTilde}" value="${inicioPrefill || ''}">
        </div>
        <div class="col-4">
            <label class="form-label small mb-1 text-muted">Fin</label>
            <input type="time" class="form-control form-control-sm" id="materiaHorarioFin_${diaSinTilde}" value="${finPrefill || ''}">
        </div>`;
    cont.appendChild(fila);
}

function openMateriaModal(id) {
    const accionPermiso = id ? 'editar_docente' : 'agregar_docente';
    if (!tienePermiso(currentUser.rol, accionPermiso)) {
        showToast(mensajeSinPermiso(accionPermiso), 'error');
        return;
    }
    editingMateriaId = id || null;
    document.getElementById('materiaModalTitle').innerHTML = id
        ? '<i class="bi bi-pencil"></i> Editar Materia'
        : '<i class="bi bi-journal-bookmark"></i> Nueva Materia';
    DIAS_MATERIA_IDS.forEach(d => {
        const el = document.getElementById('materiaDia' + d);
        if (el) el.checked = false;
    });
    document.getElementById('materiaHorariosPorDia').innerHTML = '';
    populateCarrerasSelects();

    const m = id ? currentMaterias.find(x => x.id === id) : null;
    if (id && !m) { showToast('Materia no encontrada', 'error'); return; }

    document.getElementById('materiaCarrera').value = m ? m.carrera_id : '';
    document.getElementById('materiaAnio').value = m ? m.anio : 1;
    document.getElementById('materiaCuatrimestre').value = m ? m.cuatrimestre : 1;
    document.getElementById('materiaNombre').value = m ? m.nombre : '';
    document.getElementById('materiaTipo').value = m ? (esMateriaAnual(m) ? 'ANUAL' : 'CUATRIMESTRAL') : 'ANUAL';
    (m ? materiaHorarios(m) : []).forEach(h => {
        const diaSinTilde = diaMateriaSinTilde(h.dia);
        const chk = document.getElementById('materiaDia' + diaSinTilde);
        if (chk) chk.checked = true;
        toggleMateriaHorarioDia(diaSinTilde, true, h.inicio, h.fin);
    });
    const profesorAsignado = m && m.profesor_id ? materiaProfesorPorDocenteId[m.profesor_id] : null;
    populateMateriaProfesorSelect(profesorAsignado ? profesorAsignado.id : '');

    new bootstrap.Modal(document.getElementById('materiaModal')).show();
}

function editMateria(id) { openMateriaModal(id); }

// Choque de horario: mismo profesor, mismo día, franjas que se
// solapan (no hace falta que sean exactamente iguales - un
// solapamiento parcial ya es un choque real e igual de imposible de
// cumplir). Se compara contra TODAS las materias ya cargadas de ese
// profesor (cualquier carrera/año, no solo la misma), excluyendo la
// propia materia si se está editando. Bug real reportado: Docente
// DePrueba quedó con "BASE DE DATOS 1" y "PRÁCTICA PROFESIONALIZANTE
// I" las dos Lunes 20:00-21:20 porque nada frenaba esto al guardar.
function buscarChoqueHorarioProfesor(profesorId, horariosNuevos, materiaIdExcluir) {
    if (!profesorId) return null;
    const otras = currentMaterias.filter(m => m.profesor_id === profesorId && m.id !== materiaIdExcluir);
    for (const otra of otras) {
        for (const hExistente of materiaHorarios(otra)) {
            for (const hNuevo of horariosNuevos) {
                if (hExistente.dia === hNuevo.dia && hExistente.inicio < hNuevo.fin && hExistente.fin > hNuevo.inicio) {
                    return { materia: otra, horario: hExistente };
                }
            }
        }
    }
    return null;
}

async function saveMateria() {
    const accionPermiso = editingMateriaId ? 'editar_docente' : 'agregar_docente';
    if (!tienePermiso(currentUser.rol, accionPermiso)) {
        showToast(mensajeSinPermiso(accionPermiso), 'error');
        return;
    }
    const carreraId = Number(document.getElementById('materiaCarrera').value) || null;
    const anio = parseInt(document.getElementById('materiaAnio').value, 10);
    const cuatrimestre = parseInt(document.getElementById('materiaCuatrimestre').value, 10);
    const nombre = document.getElementById('materiaNombre').value.trim();
    const tipo = document.getElementById('materiaTipo').value;
    const diasTildados = DIAS_MATERIA_IDS.filter(d => document.getElementById('materiaDia' + d)?.checked);

    if (!carreraId) { showToast('Elegí una carrera', 'error'); return; }
    if (!nombre) { showToast('El nombre de la materia es obligatorio', 'error'); return; }
    if (diasTildados.length === 0) { showToast('Marcá al menos un día', 'error'); return; }

    // Un horario por día (ver toggleMateriaHorarioDia): cada día
    // tildado tiene que tener su propia fila con inicio/fin cargados.
    const horarios = [];
    for (const diaSinTilde of diasTildados) {
        const label = diaMateriaLabel(diaSinTilde);
        const inicio = document.getElementById('materiaHorarioInicio_' + diaSinTilde)?.value;
        const fin = document.getElementById('materiaHorarioFin_' + diaSinTilde)?.value;
        if (!inicio || !fin) { showToast(`Completá el horario de ${label}`, 'error'); return; }
        if (fin <= inicio) { showToast(`En ${label}, la hora de fin debe ser posterior a la de inicio`, 'error'); return; }
        horarios.push({ dia: label, inicio, fin });
    }

    let profesorId = null;
    const teacherIdSeleccionado = document.getElementById('materiaProfesor').value;
    if (teacherIdSeleccionado) {
        const teacher = getTeachers().find(t => t.id === teacherIdSeleccionado);
        if (teacher) profesorId = await syncTeacherToDocenteTable(teacher);
    }

    if (profesorId) {
        const choque = buscarChoqueHorarioProfesor(profesorId, horarios, editingMateriaId);
        if (choque) {
            showToast(`⚠️ El docente ya tiene "${choque.materia.nombre}" el ${choque.horario.dia} de ${choque.horario.inicio} a ${choque.horario.fin}`, 'error');
            return;
        }
    }

    // dias se sigue guardando (por compatibilidad con quien todavía lea
    // esa columna vieja), pero para mostrar la materia ya no se usa -
    // eso ahora sale de `horarios` (ver materiaHorarios()).
    const payload = { carrera_id: carreraId, nombre, anio, cuatrimestre, tipo, horarios, dias: horarios.map(h => h.dia), profesor_id: profesorId, escuela_id: ESCUELA_ID };
    try {
        if (editingMateriaId) {
            const { error } = await sb.from('materias').update(payload).eq('id', editingMateriaId);
            if (error) throw error;
            logAccion('EDITAR_MATERIA', `Editó la materia "${nombre}"`);
        } else {
            const { error } = await sb.from('materias').insert(payload);
            if (error) throw error;
            logAccion('ALTA_MATERIA', `Creó la materia "${nombre}"`);
        }
        bootstrap.Modal.getInstance(document.getElementById('materiaModal'))?.hide();
        await loadMaterias();
        renderGrillaMaterias();
        renderMateriasDocenteChecklist(editingTeacherId);
        showToast('✅ Materia guardada', 'success');
    } catch (error) {
        console.error('No se pudo guardar la materia:', error);
        showToast('No se pudo guardar la materia (' + describeSupabaseError(error) + ')', 'error');
    }
}

async function deleteMateria(id) {
    if (!tienePermiso(currentUser.rol, 'borrar')) {
        showToast(mensajeSinPermiso('borrar'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó borrar una materia sin permiso');
        return;
    }
    if (!confirm('¿Eliminar esta materia?')) return;
    try {
        const { error } = await sb.from('materias').delete().eq('id', id);
        if (error) throw error;
        logAccion('BORRAR_MATERIA', `Eliminó la materia ${id}`);
        await loadMaterias();
        renderGrillaMaterias();
        renderMateriasDocenteChecklist(editingTeacherId);
        showToast('Materia eliminada', 'info');
    } catch (error) {
        console.error('No se pudo eliminar la materia:', error);
        showToast('No se pudo eliminar la materia (' + describeSupabaseError(error) + ')', 'error');
    }
}

// ===== "Materias asignadas" dentro del alta/edición de docente: chips
// (ya asignadas, con X para sacarlas) + filtro en cascada Carrera ->
// Año -> checklist (para agregar nuevas), en vez de listar las 10+
// materias sueltas de un tirón. Una única fuente de verdad en memoria
// (materiasSeleccionadasDocenteIds); los chips y el checklist filtrado
// son 2 vistas de lo mismo, se resincronizan solas al tocar cualquiera
// de las dos. Se confirma recién al guardar el docente (ver
// guardarMateriasAsignadasDocente()), no al tocar la X o el checkbox.
let materiasSeleccionadasDocenteIds = new Set();
// undefined = todavía no se inicializó nunca en esta sesión. Distinto
// de null (que sí es un valor válido: "docente nuevo, sin id todavía") -
// así, si saveMateria()/deleteMateria() vuelven a llamar a
// renderMateriasDocenteChecklist() con el MISMO editingTeacherId de
// antes (solo refrescando datos), no se pierde lo que ya se había
// tildado sin guardar todavía.
let materiasSeleccionDocenteIdActual;
let materiaAsignarCarreraFiltro = '';
let materiaAsignarAnioFiltro = '';

function renderMateriasDocenteChecklist(teacherId) {
    if (materiasSeleccionDocenteIdActual !== teacherId) {
        materiasSeleccionDocenteIdActual = teacherId;
        materiasSeleccionadasDocenteIds = new Set(getMateriasDeDocente(teacherId).map(m => m.id));
        materiaAsignarCarreraFiltro = '';
        materiaAsignarAnioFiltro = '';
    }
    if (currentMaterias.length === 0) {
        const chips = document.getElementById('materiasDocenteChips');
        if (chips) chips.innerHTML = '<span class="text-muted small">No hay materias cargadas todavía (pestaña "Materias").</span>';
        const cont = document.getElementById('materiasDocenteChecklist');
        if (cont) cont.innerHTML = '';
        return;
    }
    renderMateriasDocenteChips();
    poblarSelectCarreraAsignar();
    poblarSelectAnioAsignar();
    renderMateriasDocenteFiltrado();
}

function renderMateriasDocenteChips() {
    const cont = document.getElementById('materiasDocenteChips');
    if (!cont) return;
    const carrerasPorId = {};
    currentCarreras.forEach(c => { carrerasPorId[c.id] = c.nombre; });
    const seleccionadas = currentMaterias.filter(m => materiasSeleccionadasDocenteIds.has(m.id));
    if (seleccionadas.length === 0) {
        cont.innerHTML = '<span class="text-muted small">Todavía no tiene ninguna materia asignada.</span>';
        return;
    }
    cont.innerHTML = seleccionadas.map(m => `
        <span class="badge bg-secondary me-1 mb-1 p-2">
            ${m.nombre} <small>[${carrerasPorId[m.carrera_id] || '?'} - ${m.anio}° Año]</small>
            <button type="button" class="btn-close btn-close-white ms-1" style="font-size:0.55rem;vertical-align:middle;" onclick="quitarMateriaSeleccionadaDocente(${m.id})" aria-label="Quitar ${m.nombre}"></button>
        </span>`).join('');
}

function quitarMateriaSeleccionadaDocente(materiaId) {
    materiasSeleccionadasDocenteIds.delete(materiaId);
    renderMateriasDocenteChips();
    renderMateriasDocenteFiltrado();
}

function poblarSelectCarreraAsignar() {
    const sel = document.getElementById('materiaAsignarCarrera');
    if (!sel) return;
    sel.innerHTML = '<option value="">Seleccioná...</option>' +
        currentCarreras.map(c => `<option value="${c.id}" ${String(c.id) === String(materiaAsignarCarreraFiltro) ? 'selected' : ''}>${c.nombre}</option>`).join('');
}

function onCambioCarreraAsignar(carreraId) {
    materiaAsignarCarreraFiltro = carreraId;
    materiaAsignarAnioFiltro = '';
    poblarSelectAnioAsignar();
    renderMateriasDocenteFiltrado();
}

// Año: deshabilitado hasta elegir carrera, y solo lista los años que
// realmente tienen materias cargadas en ESA carrera (pedido explícito),
// no los 3 siempre.
function poblarSelectAnioAsignar() {
    const sel = document.getElementById('materiaAsignarAnio');
    if (!sel) return;
    if (!materiaAsignarCarreraFiltro) {
        sel.innerHTML = '<option value="">Elegí una carrera primero</option>';
        sel.disabled = true;
        return;
    }
    const anios = [...new Set(currentMaterias.filter(m => String(m.carrera_id) === String(materiaAsignarCarreraFiltro)).map(m => m.anio))].sort((a, b) => a - b);
    sel.disabled = false;
    sel.innerHTML = '<option value="">Seleccioná...</option>' +
        anios.map(a => `<option value="${a}" ${String(a) === String(materiaAsignarAnioFiltro) ? 'selected' : ''}>${a}° Año</option>`).join('');
}

function onCambioAnioAsignar(anio) {
    materiaAsignarAnioFiltro = anio;
    renderMateriasDocenteFiltrado();
}

function renderMateriasDocenteFiltrado() {
    const cont = document.getElementById('materiasDocenteChecklist');
    if (!cont) return;
    if (!materiaAsignarCarreraFiltro || !materiaAsignarAnioFiltro) {
        cont.innerHTML = '<span class="text-muted small">Elegí carrera y año para ver sus materias.</span>';
        return;
    }
    const filtradas = currentMaterias.filter(m => String(m.carrera_id) === String(materiaAsignarCarreraFiltro) && m.anio === Number(materiaAsignarAnioFiltro));
    if (filtradas.length === 0) {
        cont.innerHTML = '<span class="text-muted small">No hay materias cargadas para ese año de esa carrera.</span>';
        return;
    }
    cont.innerHTML = filtradas.map(m => {
        const seleccionada = materiasSeleccionadasDocenteIds.has(m.id);
        const profesorActual = m.profesor_id ? materiaProfesorPorDocenteId[m.profesor_id] : null;
        const asignadoAOtro = !!(profesorActual && profesorActual.id !== materiasSeleccionDocenteIdActual && !seleccionada);
        const etiquetaOtro = asignadoAOtro ? ` <small class="text-muted">(hoy: ${profesorActual.apellido})</small>` : '';
        return `
            <div class="form-check">
                <input class="form-check-input" type="checkbox" id="materiaChk_${m.id}" onchange="toggleMateriaSeleccionadaDocente(${m.id}, this.checked)" ${seleccionada ? 'checked' : ''}>
                <label class="form-check-label" for="materiaChk_${m.id}">${m.nombre} (${formatoHorariosCorto(m)})${etiquetaOtro}</label>
            </div>`;
    }).join('');
}

function toggleMateriaSeleccionadaDocente(materiaId, checked) {
    if (checked) materiasSeleccionadasDocenteIds.add(materiaId);
    else materiasSeleccionadasDocenteIds.delete(materiaId);
    renderMateriasDocenteChips();
}

// Se llama al final de saveTeacher(): resuelve el docente real (ver
// syncTeacherToDocenteTable) y aplica materiasSeleccionadasDocenteIds -
// asigna las materias tildadas y libera (profesor_id = null) las que
// tenía este docente y ya no están en la selección.
async function guardarMateriasAsignadasDocente(teacher) {
    if (currentMaterias.length === 0) return;
    const docenteId = await syncTeacherToDocenteTable(teacher);
    if (!docenteId) return;
    const tildadas = materiasSeleccionadasDocenteIds;
    const cambios = currentMaterias.filter(m => {
        const eraDeEste = m.profesor_id === docenteId;
        const ahoraTildada = tildadas.has(m.id);
        return (ahoraTildada && !eraDeEste) || (!ahoraTildada && eraDeEste);
    });
    for (const m of cambios) {
        const nuevoProfesorId = tildadas.has(m.id) ? docenteId : null;
        const { error } = await sb.from('materias').update({ profesor_id: nuevoProfesorId }).eq('id', m.id);
        if (error) console.error('No se pudo actualizar la asignación de la materia', m.id, error);
    }
    if (cambios.length > 0) {
        logAccion('ASIGNAR_MATERIAS', `Actualizó materias asignadas a ${teacher.apellido} ${teacher.nombre} (${cambios.length})`);
        await loadMaterias();
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
    const horario = getHorarioEfectivo(teacher);
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
    const todayStr = getFechaHoyArgentina(now);
    const nowMinutes = getMinutosDesdeMedianocheArgentina(now);
    let created = false;

    teachers.forEach(teacher => {
        const createdDateStr = teacher.createdAt ? teacher.createdAt.split('T')[0] : todayStr;
        const scheduleDates = generateTeacherScheduleDates(teacher, SCHEDULE_CALENDAR_YEAR);
        scheduleDates.forEach(sd => {
            if (sd.date < createdDateStr || sd.date > todayStr) return;
            if (getLicenciaForDate(teacher.id, sd.date)) return;
            // Solo un evento CON perjuicio exime la cátedra regular ese
            // día (ver teacherHasEventoConPerjuicioOnDate()) - uno SIN
            // perjuicio no la exime, son obligaciones separadas.
            if (teacherHasEventoConPerjuicioOnDate(teacher.id, sd.date)) return;

            if (sd.date === todayStr) {
                const earliestStart = sd.startTimes.slice().sort()[0];
                const [startH, startM] = earliestStart.split(':').map(Number);
                const scheduledMinutes = startH * 60 + startM;
                if (nowMinutes <= scheduledMinutes + lateLimit) return; // todavía dentro del margen, no es falta (todavía)
            }

            const hasEntry = attendance.some(a => a.teacherId === teacher.id && a.type === 'entry' && getFechaRealFichaje(a) === sd.date && (a.categoria || 'regular') === 'regular');
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
    const todayStr = getFechaHoyArgentina(now);
    const nowMinutes = getMinutosDesdeMedianocheArgentina(now);
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

            const hasEntry = attendance.some(a => a.teacherId === teacher.id && a.type === 'entry' && a.categoria === 'evento' && a.eventoId === ev.id);
            if (hasEntry) return;
            const alreadyAlerted = alerts.some(a => a.teacherId === teacher.id && a.type === 'Falta Evento' && a.eventoId === ev.id);
            if (alreadyAlerted) return;

            alerts.push({
                id: `${teacher.id}_faltaevento_${ev.id}`,
                teacherId: teacher.id,
                teacherName: `${teacher.apellido} ${teacher.nombre}`,
                type: 'Falta Evento',
                message: `No registró ingreso al evento "${ev.titulo}" del ${ev.fecha} (horario: ${horaEntrada || '-'} - ${(ev.hora_salida || '').slice(0, 5)}).`,
                date: new Date().toISOString(),
                faltaDate: ev.fecha,
                eventoId: ev.id,
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

const SCHEDULE_STATUS_ICON = { present: '✓', late: '⏰', falta: '✗', licencia: '🏥', scheduled: '○' };
const SCHEDULE_STATUS_LABEL = { present: 'Presente', late: 'Tardanza', falta: 'Ausente', licencia: 'Licencia', scheduled: 'Pendiente' };

// Cruza horario efectivo (getHorarioEfectivo, ya trae materiaId/
// materiaNombre cuando el docente tiene materias asignadas) +
// asistencias + licencias para UNA fecha puntual: devuelve una
// entrada por cada bloque materia+docente que tiene clase ese día,
// con el estado ya resuelto (present/late/falta/licencia/scheduled).
// La usan tanto el Calendario Anual del Establecimiento como la
// Grilla Completa de Horarios, para no repetir la lógica de cruce.
function getScheduleEntriesForDate(dateStr) {
    const dayName = FULL_DAYS[new Date(dateStr + 'T00:00:00Z').getUTCDay()];
    const teachers = getTeachers();
    const attendance = getAttendance();
    const criteria = getCriteria();
    const lateLimit = criteria.lateLimit || 15;
    const now = new Date();
    const todayStr = getFechaHoyArgentina(now);
    const nowMinutes = getMinutosDesdeMedianocheArgentina(now);
    const carrerasPorId = {};
    (typeof currentCarreras !== 'undefined' ? currentCarreras : []).forEach(c => { carrerasPorId[c.id] = c.nombre; });
    const materiasPorId = {};
    (typeof currentMaterias !== 'undefined' ? currentMaterias : []).forEach(m => { materiasPorId[m.id] = m; });

    const entries = [];
    teachers.forEach(teacher => {
        const createdDateStr = teacher.createdAt ? teacher.createdAt.split('T')[0] : null;
        if (createdDateStr && dateStr < createdDateStr) return;
        const licencia = getLicenciaForDate(teacher.id, dateStr);
        const bloques = getHorarioEfectivo(teacher).filter(h => h.dia === dayName);
        bloques.forEach(h => {
            const materia = h.materiaId != null ? materiasPorId[h.materiaId] : null;
            let status, entryRecord = null, tardanzaMin = null;
            if (licencia) {
                status = 'licencia';
            } else {
                entryRecord = attendance.find(a => a.teacherId === teacher.id && a.type === 'entry' && getFechaRealFichaje(a) === dateStr &&
                    (a.categoria || 'regular') === 'regular' && !a.anulado && (h.materiaId != null ? a.materiaId === h.materiaId : true)) || null;
                if (entryRecord) {
                    status = entryRecord.status === 'late' ? 'late' : 'present';
                    const [sh, sm] = h.inicio.split(':').map(Number);
                    const [eh, em] = (entryRecord.time || '00:00').split(':').map(Number);
                    tardanzaMin = (eh * 60 + em) - (sh * 60 + sm);
                } else if (dateStr < todayStr) {
                    status = 'falta';
                } else if (dateStr === todayStr) {
                    const [sh, sm] = h.inicio.split(':').map(Number);
                    status = nowMinutes > (sh * 60 + sm + lateLimit) ? 'falta' : 'scheduled';
                } else {
                    status = 'scheduled';
                }
            }
            entries.push({
                teacherId: teacher.id,
                teacherName: `${teacher.apellido} ${teacher.nombre}`,
                teacherApellido: teacher.apellido,
                materiaId: h.materiaId || null,
                materiaNombre: h.materiaNombre || teacher.materia || 'Clase',
                carreraId: materia ? materia.carrera_id : null,
                carreraNombre: materia ? (carrerasPorId[materia.carrera_id] || null) : null,
                anio: materia ? materia.anio : null,
                inicio: h.inicio,
                fin: h.fin,
                dia: dayName,
                date: dateStr,
                status,
                entryRecord,
                licenciaMotivo: licencia ? licencia.motivo : null,
                tardanzaMin
            });
        });
    });
    return entries.sort((a, b) => a.inicio.localeCompare(b.inicio) || a.teacherName.localeCompare(b.teacherName));
}

// ============================================================
// INICIO: "Docentes que deberían presentarse hoy" (semáforo de
// puntualidad, ver Configuración > Criterios de Puntualidad).
// SEMAFORO_PUNTUALIDAD/SEMAFORO_ORDEN/calcularSemaforoPuntualidad/
// CRITERIA_PUNTUALIDAD_DEFAULT viven en presencia-logic.js (cargado
// ANTES que este script en index.html, así que quedan disponibles acá
// como globales) para que test-presencia.js pueda testear la lógica
// real con node, sin duplicar la función y arriesgar que las dos
// copias se desincronicen.
// ============================================================

// Entradas de "Esperados Hoy" para los Eventos Especiales de hoy
// (independiente de getScheduleEntriesForDate(), que solo mira
// materias/horario) - mismo shape que esas entradas ({teacherId,
// teacherName, materiaNombre, inicio, entryRecord, tardanzaMin,
// semaforo}), más esEvento:true y tipoCumplimiento para que el render
// pueda distinguir la tarjeta y getDocentesEsperadosHoy() sepa a
// quién eximir de sus materias (ver ahí abajo).
function getEventoEntriesParaHoy() {
    const todayStr = getFechaHoyArgentina();
    const criteria = getCriteria();
    const nowMinutes = getMinutosDesdeMedianocheArgentina();
    const attendance = getAttendance();
    const entries = [];
    getTeachers().forEach(teacher => {
        const eventosHoy = (eventoConvocatoriasPorDocente[Number(teacher.id)] || []).filter(ev => ev.fecha === todayStr);
        // Dedup por id (misma razón que getEventosDeHoyParaDocente()):
        // evento_docente puede tener más de una fila para el mismo
        // docente+evento.
        const eventosUnicos = [...new Map(eventosHoy.map(e => [e.id, e])).values()];
        eventosUnicos.forEach(ev => {
            const entryRecord = attendance.find(a => a.teacherId === teacher.id && a.type === 'entry' &&
                a.categoria === 'evento' && a.eventoId === ev.id && !a.anulado && getFechaRealFichaje(a) === todayStr) || null;
            const [sh, sm] = (ev.hora_entrada || '00:00').split(':').map(Number);
            const scheduledMinutes = sh * 60 + sm;
            let elapsedMin;
            if (entryRecord) {
                const [eh, em] = (entryRecord.time || '00:00').split(':').map(Number);
                elapsedMin = (eh * 60 + em) - scheduledMinutes;
            } else {
                elapsedMin = nowMinutes - scheduledMinutes;
                if (elapsedMin < 0) elapsedMin = null;
            }
            entries.push({
                teacherId: teacher.id,
                teacherName: `${teacher.apellido} ${teacher.nombre}`,
                materiaNombre: ev.titulo,
                carreraNombre: null,
                anio: null,
                inicio: ev.hora_entrada || '',
                entryRecord,
                tardanzaMin: elapsedMin,
                esEvento: true,
                tipoCumplimiento: ev.tipo_cumplimiento || 'CON_PERJUICIO',
                semaforo: calcularSemaforoPuntualidad(elapsedMin, criteria, !!entryRecord),
            });
        });
    });
    return entries;
}

// Defensa extra para datos que ya hayan quedado con un choque de
// horario real (cargados antes de este fix, o editados directo en
// Supabase sin pasar por saveMateria()/buscarChoqueHorarioProfesor()):
// agrupa las tarjetas de materia de HOY por docente y detecta pares
// que se solapan en horario. Si ya fichó UNA de las que chocan, se
// muestra solo esa (si no, quedaba una tarjeta "Ausente" sin sentido
// al lado de la que sí fichó). Si ninguna fichó todavía, o fichó más
// de una (corrupción real), se marcan TODAS como conflicto en rojo
// para que el admin lo vea y lo corrija en Materias.
function resolverChoquesHorario(entries) {
    const porDocente = new Map();
    entries.forEach(e => {
        if (!porDocente.has(e.teacherId)) porDocente.set(e.teacherId, []);
        porDocente.get(e.teacherId).push(e);
    });
    const resultado = [];
    porDocente.forEach(bloques => {
        const usados = new Set();
        bloques.forEach((e, i) => {
            if (usados.has(i)) return;
            const grupo = [i];
            bloques.forEach((otro, j) => {
                if (j === i || usados.has(j)) return;
                if (otro.dia === e.dia && otro.inicio < e.fin && otro.fin > e.inicio) grupo.push(j);
            });
            grupo.forEach(idx => usados.add(idx));
            if (grupo.length === 1) { resultado.push(e); return; }
            const conGrupo = grupo.map(idx => bloques[idx]);
            const fichados = conGrupo.filter(b => b.entryRecord);
            if (fichados.length === 1) { resultado.push(fichados[0]); return; }
            conGrupo.forEach(b => resultado.push({ ...b, choqueHorario: true }));
        });
    });
    return resultado;
}

// Reutiliza getScheduleEntriesForDate() (mismo cruce horario+asistencia
// que el calendario/grilla) y le suma el semáforo de puntualidad de
// cada bloque de hoy. Las licencias no cuentan como "debería
// presentarse" - se excluyen.
// Eventos Especiales de hoy (ver getEventoEntriesParaHoy()) se suman
// aparte: un evento CON perjuicio reemplaza las tarjetas de materia de
// ESE docente ese día (no da clases, ver checkFaltas()); uno SIN
// perjuicio se agrega además de sus materias normales - son
// obligaciones independientes, cada una con su propio semáforo.
function getDocentesEsperadosHoy() {
    const now = new Date();
    const todayStr = getFechaHoyArgentina(now);
    const criteria = getCriteria();
    const nowMinutes = getMinutosDesdeMedianocheArgentina(now);

    const eventoEntries = getEventoEntriesParaHoy();
    const teacherIdsConPerjuicioHoy = new Set(
        eventoEntries.filter(e => e.tipoCumplimiento === 'CON_PERJUICIO').map(e => e.teacherId)
    );

    const materiaEntries = getScheduleEntriesForDate(todayStr)
        .filter(e => e.status !== 'licencia')
        .filter(e => !teacherIdsConPerjuicioHoy.has(e.teacherId))
        .map(e => {
            let elapsedMin;
            if (e.entryRecord) {
                elapsedMin = e.tardanzaMin;
            } else {
                const [sh, sm] = e.inicio.split(':').map(Number);
                elapsedMin = nowMinutes - (sh * 60 + sm);
                if (elapsedMin < 0) elapsedMin = null;
            }
            return { ...e, semaforo: calcularSemaforoPuntualidad(elapsedMin, criteria, !!e.entryRecord) };
        });

    return [...resolverChoquesHorario(materiaEntries), ...eventoEntries]
        .sort((a, b) => SEMAFORO_ORDEN[a.semaforo.code] - SEMAFORO_ORDEN[b.semaforo.code] || a.inicio.localeCompare(b.inicio));
}

// Un docente puede tener varios bloques hoy (varias materias/horarios).
// Para los contadores de arriba (Esperados/Presentes/Ausentes/etc.) se
// cuenta cada docente una sola vez, quedándose con su peor semáforo del
// día (ausente > media falta > tardanza > esperado > presente), ya que
// getDocentesEsperadosHoy() viene ordenada de peor a mejor.
function getDocentesEsperadosHoyPorDocente() {
    const porDocente = new Map();
    getDocentesEsperadosHoy().forEach(e => {
        if (!porDocente.has(e.teacherId)) porDocente.set(e.teacherId, e);
    });
    return Array.from(porDocente.values());
}

function renderDocentesEsperadosHoy() {
    const container = document.getElementById('docentesEsperadosHoyList');
    if (!container || !currentUser || currentUser.role !== 'admin') return;
    // Cartelito de debug pedido: "hoy" y "ahora" calculados con la hora
    // de Argentina explícita (ver ARGENTINA_TZ), no con el reloj/huso del
    // dispositivo - así se puede confirmar de un vistazo si un reporte
    // de "no aparecen los docentes de hoy" es un problema real del
    // horario cargado o el dispositivo tenía la fecha/hora mal.
    const debugEl = document.getElementById('hoyArgentinaDebug');
    if (debugEl) debugEl.textContent = `Hoy es: ${getDiaSemanaArgentina()} ${getFechaHoyArgentina()} - ${getHoraHHMMArgentina()} ARG`;
    const entries = getDocentesEsperadosHoy();
    if (entries.length === 0) {
        container.innerHTML = '<p class="text-muted mb-0">No hay docentes con clase asignada hoy.</p>';
        return;
    }
    container.innerHTML = entries.map(e => {
        const cursoTxt = e.carreraNombre ? `${e.carreraNombre} - ${e.anio}° Año` : '';
        // "(fuera de horario)": aclara el caso que confunde a primera
        // vista - SÍ fichó, pero tan tarde respecto del inicio del
        // bloque (no de la duración de la clase) que ya cae en Media
        // Falta/Ausente. Sin esto, un admin ve "fichó 21:50" al lado de
        // un badge rojo "Ausente" y no entiende por qué.
        const fueraDeHorario = e.entryRecord && (e.semaforo.code === 'media_falta' || e.semaforo.code === 'ausente');
        const horaTxt = e.entryRecord && e.entryRecord.time
            ? ` · fichó ${e.entryRecord.time.slice(0, 5)}${fueraDeHorario ? ' (fuera de horario)' : ''}`
            : '';
        // Tarjeta de Evento Especial: amarillo flúo + badge CON/SIN
        // perjuicio pedido, para que se distinga de un bloque de
        // materia normal de un vistazo (ver getEventoEntriesParaHoy()).
        const claseFila = e.esEvento ? 'semaforo-row semaforo-row-evento' : 'semaforo-row';
        const badgeCumplimiento = e.esEvento
            ? `<span class="badge-cumplimiento ${e.tipoCumplimiento === 'SIN_PERJUICIO' ? 'badge-sin-perjuicio' : 'badge-con-perjuicio'}">${e.tipoCumplimiento === 'SIN_PERJUICIO' ? 'SIN perjuicio' : 'CON perjuicio'}</span>`
            : '';
        const etiquetaMateria = e.esEvento ? `<i class="bi bi-calendar-event"></i> Evento: ${e.materiaNombre}` : e.materiaNombre;
        // Choque de horario real en los datos (ver resolverChoquesHorario()):
        // se pinta todo en rojo encima de lo que sea, con un aviso
        // explícito, en vez de dejar que se vea como un semáforo normal.
        const filaConChoque = e.choqueHorario ? `${claseFila} semaforo-row-choque` : claseFila;
        const avisoChoque = e.choqueHorario
            ? `<div class="alert alert-danger py-1 px-2 small mb-0 mt-1"><i class="bi bi-exclamation-triangle-fill"></i> CONFLICTO DE HORARIO: este docente tiene otra materia superpuesta el mismo día/horario. Corregí en Materias.</div>`
            : '';
        return `
            <div class="${filaConChoque}" style="border-left-color:${e.choqueHorario ? '#ef4444' : e.semaforo.color}">
                <div class="semaforo-row-main">
                    <span class="semaforo-row-name">${e.teacherName}${badgeCumplimiento}</span>
                    <span class="semaforo-row-detail">${etiquetaMateria}${cursoTxt ? ' · ' + cursoTxt : ''} · ${e.inicio}${horaTxt}</span>
                    ${avisoChoque}
                </div>
                <span class="semaforo-badge" style="background:${e.choqueHorario ? '#ef4444' : e.semaforo.color}">${e.choqueHorario ? 'CONFLICTO' : e.semaforo.label}</span>
            </div>`;
    }).join('');
}

// ============================================================
// GRILLA COMPLETA DE HORARIOS (vista semana, con estado de
// asistencia por celda). Se arma en el momento cruzando el horario
// efectivo de cada docente (getHorarioEfectivo) con la asistencia y
// las licencias del día vía getScheduleEntriesForDate() — no se
// persiste por separado. Navegación por semana (grillaSemanaOffset)
// + filtros (grillaFiltro), ambos con estado propio para que
// sobrevivan a los re-render sin perder lo elegido.
// ============================================================

// Lunes..Domingo (alineado con DAYS) de la semana actual + offset
// semanas (0 = esta semana, -1 = anterior, 1 = siguiente).
function getWeekDates(offsetWeeks) {
    // "Hoy" en Argentina (no en la zona horaria del dispositivo, ver
    // ARGENTINA_TZ): a partir de ahí, el resto es aritmética de
    // calendario pura en UTC (para no pisarse con horario de verano de
    // otros husos, aunque Argentina ya no lo tenga).
    const [yy, mm, dd] = getFechaHoyArgentina().split('-').map(Number);
    const today = new Date(Date.UTC(yy, mm - 1, dd));
    const dow = today.getUTCDay(); // 0=Domingo..6=Sábado
    const diffToMonday = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(today);
    monday.setUTCDate(today.getUTCDate() + diffToMonday + offsetWeeks * 7);
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setUTCDate(monday.getUTCDate() + i);
        dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
}

function formatFechaCorta(dateStr) {
    const [, m, d] = dateStr.split('-');
    return `${d}/${m}`;
}

function showFullScheduleGrid() {
    grillaSemanaOffset = 0;
    grillaFiltro = { profesor: '', materia: '', carrera: '', estado: '' };
    renderFullScheduleGrid();
    new bootstrap.Modal(document.getElementById('fullScheduleGridModal')).show();
}

function cambiarSemanaGrilla(delta) {
    grillaSemanaOffset += delta;
    renderFullScheduleGrid();
}

function irHoyGrilla() {
    grillaSemanaOffset = 0;
    renderFullScheduleGrid();
}

function onGrillaFiltroChange(campo, valor) {
    grillaFiltro[campo] = valor;
    renderFullScheduleGrid();
}

function entryPasaFiltroGrilla(e) {
    if (grillaFiltro.profesor && String(e.teacherId) !== String(grillaFiltro.profesor)) return false;
    if (grillaFiltro.materia && String(e.materiaId) !== String(grillaFiltro.materia)) return false;
    if (grillaFiltro.carrera && String(e.carreraId) !== String(grillaFiltro.carrera)) return false;
    if (grillaFiltro.estado && e.status !== grillaFiltro.estado) return false;
    return true;
}

function buildGrillaFiltrosHtml(teachers) {
    const docentesOpts = teachers.slice().sort((a, b) => a.apellido.localeCompare(b.apellido))
        .map(t => `<option value="${t.id}" ${String(grillaFiltro.profesor) === String(t.id) ? 'selected' : ''}>${t.apellido} ${t.nombre}</option>`).join('');
    const materiasOpts = (typeof currentMaterias !== 'undefined' ? currentMaterias : []).slice().sort((a, b) => a.nombre.localeCompare(b.nombre))
        .map(m => `<option value="${m.id}" ${String(grillaFiltro.materia) === String(m.id) ? 'selected' : ''}>${m.nombre}</option>`).join('');
    const carrerasOpts = (typeof currentCarreras !== 'undefined' ? currentCarreras : []).slice().sort((a, b) => a.nombre.localeCompare(b.nombre))
        .map(c => `<option value="${c.id}" ${String(grillaFiltro.carrera) === String(c.id) ? 'selected' : ''}>${c.nombre}</option>`).join('');
    const estadoOpts = Object.keys(SCHEDULE_STATUS_LABEL)
        .map(k => `<option value="${k}" ${grillaFiltro.estado === k ? 'selected' : ''}>${SCHEDULE_STATUS_LABEL[k]}</option>`).join('');
    return `
        <div class="grid-horarios-filtros">
            <select class="form-select form-select-sm" onchange="onGrillaFiltroChange('profesor', this.value)">
                <option value="">Todos los profesores</option>${docentesOpts}
            </select>
            <select class="form-select form-select-sm" onchange="onGrillaFiltroChange('materia', this.value)">
                <option value="">Todas las materias</option>${materiasOpts}
            </select>
            <select class="form-select form-select-sm" onchange="onGrillaFiltroChange('carrera', this.value)">
                <option value="">Todas las carreras</option>${carrerasOpts}
            </select>
            <select class="form-select form-select-sm" onchange="onGrillaFiltroChange('estado', this.value)">
                <option value="">Todos los estados</option>${estadoOpts}
            </select>
        </div>`;
}

// Una "tarjetita" con materia + profesor + estado, usada tanto en la
// celda de la tabla (desktop) como en la card por día (mobile) — el
// mismo dato en los dos formatos, como pidió el ticket.
function buildGridCellItemHtml(e) {
    const cursoTxt = e.carreraNombre ? `${e.carreraNombre} - ${e.anio}° Año` : '';
    let estadoHtml;
    if (e.status === 'licencia') {
        estadoHtml = `<span class="grid-item-status">🏥 Licencia</span>`;
    } else if (e.status === 'present' || e.status === 'late') {
        const hora = e.entryRecord && e.entryRecord.time ? e.entryRecord.time.slice(0, 5) : '';
        const minTxt = e.tardanzaMin > 0 ? ` (${e.tardanzaMin}m)` : (e.tardanzaMin < 0 ? ` (${Math.abs(e.tardanzaMin)}m antes)` : '');
        estadoHtml = `<span class="grid-item-status">${SCHEDULE_STATUS_ICON[e.status]} ${hora}${minTxt}</span>`;
    } else if (e.status === 'falta') {
        estadoHtml = `<span class="grid-item-status">✗ Ausente</span>`;
    } else {
        estadoHtml = `<span class="grid-item-status">○ Pendiente</span>`;
    }
    const cellKey = `${e.teacherId}|${e.date}|${e.inicio}`;
    return `
        <div class="grid-item status-${e.status}" title="${e.inicio}-${e.fin} · ${cursoTxt || 'Sin carrera asociada'}" onclick="showGridCellDetail('${cellKey}')" role="button">
            <div class="grid-item-time">${e.inicio}-${e.fin}</div>
            <div class="grid-item-materia">${e.materiaNombre}</div>
            <div class="grid-item-profesor">Prof. ${e.teacherApellido}${cursoTxt ? ' · ' + cursoTxt : ''}</div>
            ${estadoHtml}
        </div>`;
}

function renderFullScheduleGrid() {
    const teachers = getTeachers();
    const body = document.getElementById('fullScheduleGridBody');
    if (!body) return;

    if (teachers.length === 0) {
        body.innerHTML = '<p class="text-muted text-center mb-0">No hay docentes registrados</p>';
        return;
    }

    const weekDates = getWeekDates(grillaSemanaOffset);
    const todayStr = getFechaHoyArgentina();

    const entriesByDate = {};
    weekDates.forEach(dateStr => { entriesByDate[dateStr] = getScheduleEntriesForDate(dateStr).filter(entryPasaFiltroGrilla); });

    // cellData: `${dateStr}_${hora}` -> [entry, ...] (un bloque puede
    // ocupar varias horas, se repite en cada fila que cruza, igual que
    // hacía la versión anterior de esta grilla).
    const cellData = {};
    grillaEntriesPorCelda = {};
    weekDates.forEach(dateStr => {
        entriesByDate[dateStr].forEach(e => {
            const [inicioH] = e.inicio.split(':').map(Number);
            const [finH, finM] = e.fin.split(':').map(Number);
            const finExclusivo = finM > 0 ? finH + 1 : finH;
            grillaEntriesPorCelda[`${e.teacherId}|${e.date}|${e.inicio}`] = e;
            for (let hora = inicioH; hora < finExclusivo; hora++) {
                const key = `${dateStr}_${hora}`;
                if (!cellData[key]) cellData[key] = [];
                cellData[key].push(e);
            }
        });
    });

    const rangoTxt = `${formatFechaCorta(weekDates[0])} al ${formatFechaCorta(weekDates[6])}`;

    let table = '<div class="table-responsive d-none d-md-block"><table class="table table-bordered table-sm text-center align-middle mb-0 grid-horarios-table"><thead><tr><th>Hora</th>';
    DAYS.forEach((day, i) => {
        const dateStr = weekDates[i];
        const esHoy = dateStr === todayStr ? ' grid-day-today' : '';
        table += `<th class="${esHoy}">${day}<br><small class="fw-normal">${formatFechaCorta(dateStr)}</small></th>`;
    });
    table += '</tr></thead><tbody>';
    for (let hora = START_HOUR; hora < END_HOUR; hora++) {
        const label = `${hora.toString().padStart(2, '0')}:00`;
        table += `<tr><td class="fw-semibold">${label}</td>`;
        weekDates.forEach(dateStr => {
            const entries = cellData[`${dateStr}_${hora}`] || [];
            table += entries.length === 0 ? '<td></td>' : `<td>${entries.map(buildGridCellItemHtml).join('')}</td>`;
        });
        table += '</tr>';
    }
    table += '</tbody></table></div>';

    let cards = '<div class="d-md-none grid-mobile-cards">';
    DAYS.forEach((day, i) => {
        const dateStr = weekDates[i];
        const entries = entriesByDate[dateStr];
        const esHoy = dateStr === todayStr ? ' grid-day-today' : '';
        cards += `<div class="grid-mobile-day${esHoy}"><div class="grid-mobile-day-title">${day} <small>${formatFechaCorta(dateStr)}</small></div>`;
        cards += entries.length > 0 ? entries.map(buildGridCellItemHtml).join('') : '<p class="text-muted small mb-0">Sin clases</p>';
        cards += '</div>';
    });
    cards += '</div>';

    body.innerHTML = `
        <div class="grid-horarios-toolbar mb-3">
            ${buildGrillaFiltrosHtml(teachers)}
            <div class="grid-horarios-nav">
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="cambiarSemanaGrilla(-1)"><i class="bi bi-chevron-left"></i></button>
                <button type="button" class="btn btn-sm btn-outline-primary" onclick="irHoyGrilla()">Hoy</button>
                <button type="button" class="btn btn-sm btn-outline-secondary" onclick="cambiarSemanaGrilla(1)"><i class="bi bi-chevron-right"></i></button>
                <span class="ms-2 small text-muted">${rangoTxt}</span>
            </div>
        </div>
        <div class="schedule-legend mb-3">
            <div class="schedule-legend-item"><div class="schedule-legend-color status-present"></div><span>Presente</span></div>
            <div class="schedule-legend-item"><div class="schedule-legend-color status-late"></div><span>Tardanza</span></div>
            <div class="schedule-legend-item"><div class="schedule-legend-color status-falta"></div><span>Ausente</span></div>
            <div class="schedule-legend-item"><div class="schedule-legend-color status-scheduled"></div><span>Pendiente</span></div>
            <div class="schedule-legend-item"><div class="schedule-legend-color status-licencia"></div><span>Licencia</span></div>
        </div>
        ${table}
        ${cards}
    `;
}

// Click en una celda/card de la grilla: popup con el detalle del
// fichaje (hora real, ubicación, precisión, si fue offline) cuando
// hay uno; si todavía no fichó o está de licencia, muestra igual
// materia/docente/curso/estado sin la parte de ubicación.
function showGridCellDetail(cellKey) {
    const e = grillaEntriesPorCelda[cellKey];
    if (!e) return;
    const cursoTxt = e.carreraNombre ? `${e.carreraNombre} - ${e.anio}° Año` : 'Sin carrera asociada';
    const estadoTxt = e.status === 'licencia'
        ? `Licencia${e.licenciaMotivo ? ': ' + e.licenciaMotivo : ''}`
        : SCHEDULE_STATUS_LABEL[e.status] || e.status;

    let horaFichadaHtml = '<span class="text-muted">Sin fichaje registrado</span>';
    let ubicacionHtml = '<span class="text-muted">Sin datos de ubicación</span>';
    if (e.entryRecord) {
        const r = e.entryRecord;
        horaFichadaHtml = r.time ? r.time.slice(0, 5) : '-';
        if (e.tardanzaMin != null) {
            horaFichadaHtml += e.tardanzaMin > 0 ? ` (${e.tardanzaMin}m tarde)` : (e.tardanzaMin < 0 ? ` (${Math.abs(e.tardanzaMin)}m antes)` : ' (a horario)');
        }
        if (r.fichajeLat != null && r.fichajeLng != null) {
            const precisionTxt = r.fichajePrecisionM != null ? `±${r.fichajePrecisionM}m` : 'sin dato';
            const distanciaTxt = r.fichajeDistanciaMts != null ? ` · ${r.fichajeDistanciaMts}m de la geocerca` : '';
            ubicacionHtml = `${r.fichajeLat.toFixed(5)}, ${r.fichajeLng.toFixed(5)} (precisión ${precisionTxt})${distanciaTxt}`;
        } else if (r.coords) {
            ubicacionHtml = `${r.coords.lat.toFixed(5)}, ${r.coords.lng.toFixed(5)}`;
        }
        if (r.offline) {
            ubicacionHtml += `<br><span class="badge bg-warning text-dark mt-1"><i class="bi bi-wifi-off"></i> Fichaje offline (firstOffline) — ${r.syncUbicacion === 'completo' ? 'ubicación ya confirmada al reconectar' : 'esperando confirmar ubicación al reconectar'}</span>`;
        }
    }

    document.getElementById('gridCellDetailModalTitle').textContent = `${e.materiaNombre} — ${e.inicio}-${e.fin}`;
    document.getElementById('gridCellDetailBody').innerHTML = `
        <div class="teacher-detail-info-grid">
            <div class="teacher-detail-info-row"><div class="teacher-detail-info-label">Docente</div><div class="teacher-detail-info-value">${e.teacherName}</div></div>
            <div class="teacher-detail-info-row"><div class="teacher-detail-info-label">Materia</div><div class="teacher-detail-info-value">${e.materiaNombre}</div></div>
            <div class="teacher-detail-info-row"><div class="teacher-detail-info-label">Carrera</div><div class="teacher-detail-info-value">${cursoTxt}</div></div>
            <div class="teacher-detail-info-row"><div class="teacher-detail-info-label">Fecha</div><div class="teacher-detail-info-value">${e.date} (${e.dia})</div></div>
            <div class="teacher-detail-info-row"><div class="teacher-detail-info-label">Estado</div><div class="teacher-detail-info-value">${estadoTxt}</div></div>
            <div class="teacher-detail-info-row"><div class="teacher-detail-info-label">Hora fichada</div><div class="teacher-detail-info-value">${horaFichadaHtml}</div></div>
            <div class="teacher-detail-info-row"><div class="teacher-detail-info-label">Ubicación</div><div class="teacher-detail-info-value">${ubicacionHtml}</div></div>
        </div>`;
    new bootstrap.Modal(document.getElementById('gridCellDetailModal')).show();
}

// ============================================================
// FICHA / REPORTE INDIVIDUAL DEL DOCENTE (buscador)
// ============================================================
// Ficha del docente: vista de detalle full-screen (tipo iOS), mismo
// patron de show/hide que showStatsScreen()/hideStatsScreen(). Antes
// esto abria un modal de Bootstrap; los datos que muestra son
// exactamente los mismos (mismas funciones locales getAttendance()/
// getAlerts()/getLicencias()/getHorarioLaboral()), solo cambio donde
// se pintan.
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

    const today = getFechaHoyArgentina();
    const attendanceToday = attendance.filter(a => getFechaRealFichaje(a) === today);
    const estadoHoy = attendanceToday.length > 0 ? `Presente (${attendanceToday.length})` : 'Ausente';

    const horarioTeacherDetail = getHorarioEfectivo(teacher);
    const scheduleDisplay = horarioTeacherDetail.length > 0 ?
        horarioTeacherDetail.map(h => `${h.dia} ${h.inicio}-${h.fin}`).join('<br>') : 'Sin horario asignado';
    const licenciasDisplay = licencias.length > 0 ?
        licencias.map(l => `${l.from} al ${l.to} — ${l.motivo}`).join('<br>') : 'Sin licencias registradas';

    document.getElementById('teacherDetailHeaderActions').innerHTML = `
        <button class="btn btn-sm btn-secondary" title="Fichaje manual" onclick="openManualAttendanceModal('${teacher.id}')"><i class="bi bi-fingerprint"></i></button>
        ${tienePermiso(currentUser.rol, 'ver_reportes') ? `<button class="btn btn-sm btn-success" title="Generar reporte PDF" onclick="generateIndividualReport('${teacher.id}')"><i class="bi bi-file-earmark-pdf"></i></button>` : ''}
        <button class="btn btn-sm btn-secondary" title="Restablecer contraseña" onclick="resetTeacherPassword('${teacher.id}')"><i class="bi bi-key"></i></button>
        ${tienePermiso(currentUser.rol, 'borrar') ? `<button class="btn btn-sm btn-danger" title="Eliminar" onclick="deleteTeacher('${teacher.id}')"><i class="bi bi-trash"></i></button>` : ''}
    `;

    document.getElementById('teacherDetailFullBody').innerHTML = `
        <img class="teacher-detail-avatar" src="${teacher.photo || ''}" alt="Foto">
        <div class="teacher-detail-name">${teacher.apellido} ${teacher.nombre}</div>
        <div class="teacher-detail-dni">DNI ${teacher.dni}</div>
        <div class="teacher-detail-info-grid">
            <div class="teacher-detail-info-row">
                <div class="teacher-detail-info-label">Materia</div>
                <div class="teacher-detail-info-value">${teacher.materia || '-'}</div>
            </div>
            <div class="teacher-detail-info-row">
                <div class="teacher-detail-info-label">Horario</div>
                <div class="teacher-detail-info-value">${scheduleDisplay}</div>
            </div>
            <div class="teacher-detail-info-row">
                <div class="teacher-detail-info-label">Estado hoy</div>
                <div class="teacher-detail-info-value">${estadoHoy}</div>
            </div>
            <div class="teacher-detail-info-row">
                <div class="teacher-detail-info-label">Resumen</div>
                <div class="teacher-detail-info-value">${presentCount} entradas a horario · ${lateCount} tardanzas · ${faltaCount} faltas sin justificar</div>
            </div>
            <div class="teacher-detail-info-row">
                <div class="teacher-detail-info-label">Licencias</div>
                <div class="teacher-detail-info-value">${licenciasDisplay}</div>
            </div>
            <div class="teacher-detail-info-row">
                <div class="teacher-detail-info-label">Contacto</div>
                <div class="teacher-detail-info-value">${teacher.telefono || '-'} · ${teacher.email || '-'}<br>${getDomicilioCompleto(teacher)}</div>
            </div>
        </div>
    `;

    document.getElementById('teacherDetailBottomActions').innerHTML = `
        <button class="btn btn-primary" onclick="showTeacherCalendar('${teacher.id}')"><i class="bi bi-calendar-check"></i> Ver Asistencias</button>
        <button class="btn btn-secondary" onclick="editTeacherFromDetail('${teacher.id}')"><i class="bi bi-pencil"></i> Editar</button>
        <button class="btn btn-secondary" onclick="goToLicenciaForTeacher('${teacher.id}')"><i class="bi bi-file-medical"></i> Licencia</button>
    `;

    document.getElementById('adminDashboard').classList.add('hidden');
    document.getElementById('teacherDetailScreen').classList.remove('hidden');
    window.scrollTo(0, 0);
}

function hideTeacherFullDetail() {
    document.getElementById('teacherDetailScreen').classList.add('hidden');
    document.getElementById('adminDashboard').classList.remove('hidden');
    window.scrollTo(0, 0);
}

// Vuelve al listado de Docentes y abre el formulario de edicion ya
// cargado con los datos del docente (editTeacher() hace el resto,
// igual que si se hubiera tocado el lapiz en la fila).
function editTeacherFromDetail(teacherId) {
    hideTeacherFullDetail();
    bootstrap.Tab.getOrCreateInstance(document.querySelector('[data-bs-target="#tabDocentes"]')).show();
    editTeacher(teacherId);
}

// Vuelve al panel y abre la pestaña Licencias con este docente ya
// seleccionado en el combo (mismo flujo de addLicencia() de siempre,
// solo se le ahorra al admin tener que volver a buscarlo).
function goToLicenciaForTeacher(teacherId) {
    hideTeacherFullDetail();
    bootstrap.Tab.getOrCreateInstance(document.querySelector('[data-bs-target="#tabLicencias"]')).show();
    const select = document.getElementById('licenciaTeacher');
    if (select) select.value = teacherId;
    document.getElementById('licenciaFrom')?.focus();
}

function generateIndividualReport(teacherId) {
    const teacher = getTeachers().find(t => t.id === teacherId);
    if (!teacher) return;
    document.getElementById('reportTeacher').value = teacherId;
    document.getElementById('reportFrom').value = teacher.createdAt ? teacher.createdAt.split('T')[0] : `${SCHEDULE_CALENDAR_YEAR}-01-01`;
    document.getElementById('reportTo').value = getFechaHoyArgentina();
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
    const todayStr = getFechaHoyArgentina(now);
    const nowMinutes = getMinutosDesdeMedianocheArgentina(now);

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
// Cada día muestra un chip por bloque materia+docente ("Matemática -
// Gómez [✓ Presente]"), coloreado según su estado real (ver
// getScheduleEntriesForDate()); las licencias quedan incluidas como
// un estado más (no se resta el día, se marca aparte).
function showAnnualCalendar() {
    // "Hoy" en Argentina (ver ARGENTINA_TZ) como año/mes/día de
    // calendario puro, no la hora del dispositivo.
    const [todayYear, todayMonth, todayDayNum] = getFechaHoyArgentina().split('-').map(Number);
    const todayStr = `${todayYear}-${String(todayMonth).padStart(2, '0')}-${String(todayDayNum).padStart(2, '0')}`;

    // Mapa fecha -> entradas (materia+docente+estado) de ese día, desde
    // hoy hasta el 31/12 de SCHEDULE_CALENDAR_YEAR.
    const byDate = {};
    const startTime = todayYear === SCHEDULE_CALENDAR_YEAR
        ? Date.UTC(todayYear, todayMonth - 1, todayDayNum)
        : Date.UTC(SCHEDULE_CALENDAR_YEAR, 0, 1);
    const endTime = Date.UTC(SCHEDULE_CALENDAR_YEAR, 11, 31);
    for (let t = startTime; t <= endTime; t += 86400000) {
        const dateStr = new Date(t).toISOString().split('T')[0];
        const entries = getScheduleEntriesForDate(dateStr);
        if (entries.length > 0) byDate[dateStr] = entries;
    }
    annualCalendarByDate = byDate;

    const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const startMonth = todayYear === SCHEDULE_CALENDAR_YEAR ? (todayMonth - 1) : 0;
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
            const chips = entries.map(e => {
                const label = `${e.materiaNombre} - ${e.teacherApellido}`;
                const title = `${e.materiaNombre} - ${e.teacherName} (${SCHEDULE_STATUS_LABEL[e.status]})`;
                return `<span class="annual-teacher-chip status-${e.status}" title="${title}">${SCHEDULE_STATUS_ICON[e.status]} ${label}</span>`;
            }).join('');
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
// en grande el detalle de cada bloque (horario, materia, curso,
// docente y estado con hora real) — los chips del calendario son
// chicos para que entren todos los meses en pantalla, así que este
// detalle es donde se leen cómodos.
function showDayDetail(dateStr) {
    const entries = annualCalendarByDate[dateStr] || [];
    const dateObj = new Date(dateStr + 'T00:00:00Z');
    let formatted = dateObj.toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    formatted = formatted.charAt(0).toUpperCase() + formatted.slice(1);
    document.getElementById('dayDetailModalTitle').textContent = formatted;

    document.getElementById('dayDetailBody').innerHTML = entries.length > 0
        ? entries.map(e => {
            const cursoTxt = e.carreraNombre ? ` ${e.carreraNombre} ${e.anio}°` : '';
            let estadoTxt;
            if (e.status === 'licencia') estadoTxt = `Licencia${e.licenciaMotivo ? ': ' + e.licenciaMotivo : ''}`;
            else if (e.status === 'present' || e.status === 'late') {
                const hora = e.entryRecord && e.entryRecord.time ? e.entryRecord.time.slice(0, 5) : '-';
                const minTxt = e.tardanzaMin > 0 ? ` (${e.tardanzaMin}m tarde)` : '';
                estadoTxt = `✓ ${hora}${minTxt}`;
            }
            else if (e.status === 'falta') estadoTxt = '✗ Ausente';
            else estadoTxt = '○ Pendiente';
            return `
            <div class="day-detail-teacher status-${e.status}" onclick="openTeacherDetailFromDay('${e.teacherId}')">
                <span class="day-detail-name">${e.inicio}-${e.fin} ${e.materiaNombre}${cursoTxt} - Prof. ${e.teacherName}</span>
                <span class="day-detail-status">${estadoTxt}</span>
            </div>
        `;
        }).join('')
        : '<p class="text-muted">No hay clases programadas este día.</p>';
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

    doc.save(`resumen_estadisticas_${getFechaHoyArgentina()}.pdf`);
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
    // EmailJS todavía no está configurado (EMAILJS_PUBLIC_KEY/SERVICE_ID/
    // TEMPLATE_ID siguen con los placeholders "TU_..." en script.js), así
    // que "¿Olvidaste tu contraseña?" hoy nunca manda un mail real -
    // siempre termina en "Contactá a soporte" (ver solicitarRecuperacionPassword).
    // Se oculta el botón para no mostrar una función a medio terminar; en
    // cuanto se carguen las credenciales reales de EmailJS, vuelve a
    // aparecer solo.
    document.getElementById('forgotPasswordBtnWrap')?.classList.toggle('hidden', !emailjsConfigurado());
    loadFaceApiModels();
    await loadAllData();
    await loadAdminUsuario();
    await loadCredencialesFijas();
    await checkResetTokenFromUrl();
    const criteria = getCriteria();
    saveCriteriaToStorage(criteria);
    ensureGeofenceConfig();
    await loadEventoConvocatoriasPorDocente();
    checkFaltas();
    checkFaltasEvento();
    await loadCarreras();
    await loadMaterias();
    // El semáforo de "Docentes que deberían presentarse hoy" también se
    // recalcula acá: sus franjas dependen de minutos transcurridos, así
    // que tiene que avanzar solo aunque nadie toque nada en la pantalla.
    setInterval(() => { loadEventoConvocatoriasPorDocente().then(() => { checkFaltas(); checkFaltasEvento(); renderDocentesEsperadosHoy(); }); }, 5 * 60 * 1000);
    onReconnectSync(); // sube lo pendiente y revalida geocerca de fichajes offline, por si quedaron de una sesión anterior
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
