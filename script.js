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
    // real vs configurada" (ver registrarEntradaJornada()/generateReport()).
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
        // El engranaje del header se marca como activo mientras
        // Configuración está abierta (la pestaña en sí está oculta).
        const marcarEngranaje = (activo) => document.getElementById('settingsHeaderBtn')?.classList.toggle('active', activo);
        tabConfigBtn.addEventListener('shown.bs.tab', () => marcarEngranaje(true));
        tabConfigBtn.addEventListener('hidden.bs.tab', () => marcarEngranaje(false));
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
    renderEstadoModoPrueba();
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
    const quien = currentUser ? (currentUser.username || currentUser.dni || '-') : '-';
    saveModoPruebaToStorage(activo
        ? { activo: true, desde: new Date().toISOString(), por: quien }
        : { activo: false, hasta: new Date().toISOString(), por: quien });
    logAccion('MODO_PRUEBA', activo ? 'Activó el Modo Prueba (geocerca desactivada para todos)' : 'Desactivó el Modo Prueba (geocerca activa de nuevo)', null);
    showToast(activo ? '⚠️ Modo Prueba activado: la geocerca queda desactivada para todos' : 'Modo Prueba desactivado', activo ? 'warning' : 'info');
    renderFichajeContextBadges();
    renderEstadoModoPrueba();
}

// Estado del Modo Prueba: texto al lado del switch (Configuración) y
// cartel fijo arriba del panel mientras esté activo, para que no quede
// prendido por olvido.
function renderEstadoModoPrueba() {
    const mp = getModoPrueba();
    const toggle = document.getElementById('modoPruebaToggle');
    if (toggle) toggle.checked = !!mp.activo;
    const estado = document.getElementById('modoPruebaEstado');
    if (estado) {
        estado.className = 'modo-prueba-estado ' + (mp.activo ? 'is-activo' : '');
        estado.textContent = mp.activo
            ? t('config.testModeOnSince', { fecha: mp.desde ? new Date(mp.desde).toLocaleString() : '-', por: mp.por || '-' })
            : t('config.testModeOff');
    }
    document.getElementById('modoPruebaSection')?.classList.toggle('is-activo', !!mp.activo);
    const banner = document.getElementById('modoPruebaBanner');
    if (banner) {
        const esAdmin = !!currentUser && currentUser.role === 'admin';
        banner.classList.toggle('hidden', !mp.activo);
        banner.innerHTML = mp.activo ? `
            <i class="bi bi-exclamation-triangle-fill"></i>
            <span>${t('config.testModeBanner')}</span>
            ${esAdmin && document.getElementById('modoPruebaToggle') ? `<button type="button" class="btn btn-sm btn-light" onclick="toggleModoPrueba(false)">${t('config.testModeTurnOff')}</button>` : ''}` : '';
    }
}
if (typeof onLocaleChangeRerender === 'function') onLocaleChangeRerender(renderEstadoModoPrueba);

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
// Estado de la Grilla Completa de Horarios (vista semana): offset de
// semanas respecto de la actual (0 = semana de hoy, -1 = anterior,
// 1 = siguiente) y los filtros activos. Se reinicia cada vez que se
// abre el modal (showFullScheduleGrid()).
let grillaSemanaOffset = 0;
let grillaFiltro = { profesor: '', materia: '', carrera: '', estado: '' };
let grillaEntriesPorCelda = {}; // `${teacherId}_${dateStr}_${inicio}` -> entry, usado por showGridCellDetail()
let modelsLoaded = false;
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

// Cupo anual de faltas por docente (ver getCriteria() y faltasDelAnio()).
const FALTAS_PERMITIDAS_DEFAULT = 6;
const AVISO_FALTAS_DEFAULT = 4;

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
        // Cupo anual de faltas (sin contar licencias): pasado este número,
        // los días faltados se descuentan del sueldo. Desde avisoFaltasDesde
        // se ofrece avisarle al docente por WhatsApp o mail.
        faltasPermitidasAnio: criteria.faltasPermitidasAnio ?? FALTAS_PERMITIDAS_DEFAULT,
        avisoFaltasDesde: criteria.avisoFaltasDesde ?? AVISO_FALTAS_DEFAULT,
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
// Login único: ya no se elige rol antes. El perfil se deduce del
// usuario ingresado - ADMIN1/ADMIN2 (Secretaría/Rector, ver
// CREDENCIALES_ADMIN_USUARIO), MEUDEUS (Programador) y cualquier otro
// valor se toma como DNI de docente. Los usuarios admin se comparan en
// mayúsculas para que el autocapitalizado del celular no moleste.
function detectarRolLogin(user) {
    const upper = user.toUpperCase();
    if (upper === PROGRAMADOR_LOGIN_USER) return ROLES.PROGRAMADOR;
    const rolAdmin = Object.keys(CREDENCIALES_ADMIN_USUARIO).find(r => CREDENCIALES_ADMIN_USUARIO[r] === upper);
    return rolAdmin || ROLES.DOCENTE;
}

// Ojito del campo contraseña en el login: alterna texto/password y
// cambia icono + aria-label (traducido) según el estado.
function toggleLoginPasswordVisibility() {
    const input = document.getElementById('loginPass');
    const btn = document.getElementById('loginPassToggle');
    const mostrar = input.type === 'password';
    input.type = mostrar ? 'text' : 'password';
    btn.innerHTML = mostrar ? '<i class="bi bi-eye-slash"></i>' : '<i class="bi bi-eye"></i>';
    btn.setAttribute('aria-label', t(mostrar ? 'login.hidePassword' : 'login.showPassword'));
    input.focus();
}

// Valida usuario/contraseña de Secretaría, Rector o Programador y
// devuelve el objeto de sesión admin, o null si no coinciden (o si el
// usuario no es de administración). No registra nada en auditoría: eso
// lo decide quien la llama (login() o el "Dar de alta" del fichaje
// rápido). Requiere Web Crypto (HTTPS o localhost).
async function autenticarAdmin(rawUser, pass) {
    const rol = detectarRolLogin(rawUser);
    const user = rawUser.toUpperCase();
    if (rol === ROLES.PROGRAMADOR) {
        // Si ya existe una fila real en `usuarios` (Supabase o su
        // caché local), la contraseña vigente vive ahí en texto
        // plano - es un dato de runtime propio de esta escuela,
        // nunca estuvo comprometido en git. Recién clonado el repo
        // (sin esa fila todavía) se valida contra el hash de
        // arranque de config.secrets.js/config.example.js.
        const ok = adminUsuario && adminUsuario.id
            ? pass === adminUsuario.password
            : await coincideHashCredencial('PROGRAMADOR_BOOTSTRAP', pass);
        return ok ? { role: 'admin', rol: ROLES.PROGRAMADOR, username: PROGRAMADOR_LOGIN_USER } : null;
    }
    const usuarioEsperado = CREDENCIALES_ADMIN_USUARIO[rol];
    if (usuarioEsperado && user === usuarioEsperado && await coincideHashCredencial(rol, pass)) {
        return { role: 'admin', rol, username: usuarioEsperado };
    }
    return null;
}

async function login() {
    if (!dataLoaded || !adminUsuario) {
        showToast('Todavía se están cargando los datos, esperá un momento e intentá de nuevo', 'warning');
        return;
    }
    if (!window.crypto || !window.crypto.subtle) {
        // sha256Hex() necesita Web Crypto (solo disponible en HTTPS o
        // localhost). Sin esto no hay forma segura de validar Secretaría/
        // Rector/Programador.
        showToast('Este navegador/conexión no permite validar credenciales de forma segura (hace falta HTTPS)', 'error');
        return;
    }
    const rawUser = document.getElementById('loginUser').value.trim();
    const pass = document.getElementById('loginPass').value.trim();
    const errorEl = document.getElementById('loginError');
    selectedRole = detectarRolLogin(rawUser);
    const user = selectedRole === ROLES.DOCENTE ? rawUser : rawUser.toUpperCase();
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
    } else {
        const admin = await autenticarAdmin(rawUser, pass);
        if (admin) {
            currentUser = admin;
            // 2 argumentos a propósito (sin ubicacion): logAccion() ya
            // intenta GPS de alta precisión en segundo plano sola, sin
            // bloquear el login - no hace falta un wrapper aparte.
            logAccion('LOGIN', `Login ${admin.rol}`);
            ok = true;
        }
    }

    if (ok) { showDashboard(); return; }
    errorEl.style.display = 'block';
    logAccion('LOGIN_FALLIDO', `Intento fallido - rol detectado: ${selectedRole}, usuario: ${user}`);
    setTimeout(() => errorEl.style.display = 'none', 3000);
}

function logout() {
    if (currentUser) logAccion('LOGOUT', `Logout ${currentUser.username || currentUser.dni || ''}`);
    currentUser = null;
    selectedRole = null;
    recognizedTeacher = null;
    quickFichajeActivo = false;
    quickFichajeBusy = false;
    document.getElementById('teacherDashboard').classList.remove('quick-mode');
    isFaceVerified = false;
    materiaFichajeSeleccionada = null;
    lastLivenessResult = null;
    stopLiveOverlay();
    stopRegLiveOverlay();
    document.getElementById('dashboardScreen').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('loginUser').value = '';
    document.getElementById('loginPass').value = '';
    if (document.getElementById('loginPass').type === 'text') toggleLoginPasswordVisibility();
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
    setTimeout(renderEstadoModoPrueba, 0);
    // Campanita de alertas: solo en el panel de administración.
    document.getElementById('alertsBellBtn')?.classList.toggle('hidden', !currentUser || currentUser.role !== 'admin');
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('dashboardScreen').classList.remove('hidden');
    document.getElementById('statsScreen').classList.add('hidden');
    if (currentUser.role === 'admin') {
        document.getElementById('adminDashboard').classList.remove('hidden');
        document.getElementById('teacherDashboard').classList.add('hidden');
        renderUserMenu();
        const esProgramador = currentUser.rol === ROLES.PROGRAMADOR;
        document.getElementById('tabAuditoriaNavItem').classList.toggle('hidden', !tienePermiso(currentUser.rol, 'ver_auditoria'));
        document.getElementById('tabReportesNavItem').classList.toggle('hidden', !tienePermiso(currentUser.rol, 'ver_reportes'));

        loadAdminDashboard();
        if (tienePermiso(currentUser.rol, 'ver_auditoria')) cargarLogsAuditoria().then(renderAuditoriaPanel);
        if (esProgramador && !adminUsuario.email) {
            document.getElementById('adminEmailInput').value = '';
            document.getElementById('adminEmailError').style.display = 'none';
            new bootstrap.Modal(document.getElementById('adminEmailModal')).show();
        }
    } else {
        document.getElementById('adminDashboard').classList.add('hidden');
        document.getElementById('teacherDashboard').classList.remove('hidden');
        renderUserMenu();
        loadTeacherDashboard();
        if (currentUser.debeCambiarPassword) forceChangePasswordModal();
    }
}

// Header: a la izquierda la identidad del sistema (título) y a la
// derecha el menú del usuario con quién ingresó y sus opciones
// personales. Secretaría y Rector no tienen nombre propio (usuario
// fijo ADMIN1/ADMIN2), así que ahí el rol es el dato principal.
function renderUserMenu() {
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    const toggle = (id, visible) => document.getElementById(id)?.classList.toggle('hidden', !visible);
    const avatar = document.getElementById('userAvatar');
    let titulo = 'ASISCAM PRO', nombre = '', rol = '', inicial = '';
    let puedeCambiarPass = false, puedeConfigurar = false;

    if (quickFichajeActivo && !currentUser) {
        titulo = t('fichaje.quickTitle');
        nombre = t('fichaje.quickBadge');
    } else if (currentUser && currentUser.role === 'admin') {
        rol = t('roles.' + currentUser.rol, ROL_LABEL[currentUser.rol] || 'Admin');
        nombre = rol;
        rol = `${t('header.user')} ${currentUser.username || ''}`.trim();
        inicial = nombre.charAt(0);
        // Solo PROGRAMADOR puede cambiar su contraseña: es el único rol
        // admin cuya contraseña vive en la tabla `usuarios` de Supabase.
        // Secretaría y Rector tienen contraseña fija por hash (ver
        // ASISCAM_CRED_HASHES en roles.js).
        puedeCambiarPass = currentUser.rol === ROLES.PROGRAMADOR;
        puedeConfigurar = true;
    } else if (currentUser) {
        nombre = `${currentUser.nombre || ''} ${currentUser.apellido || ''}`.trim();
        rol = t('roles.DOCENTE');
        inicial = (currentUser.nombre || '').charAt(0) + (currentUser.apellido || '').charAt(0);
        puedeCambiarPass = !quickFichajeActivo;
    }

    set('dashboardTitle', titulo);
    set('userMenuName', nombre);
    set('userMenuRole', rol);
    set('userMenuHeadName', nombre);
    set('userMenuHeadRole', rol);
    if (avatar) {
        if (inicial) avatar.textContent = inicial.toUpperCase();
        else avatar.innerHTML = `<i class="bi ${quickFichajeActivo ? 'bi-camera' : 'bi-person'}"></i>`;
    }
    document.getElementById('userMenuRole')?.classList.toggle('hidden', !rol);
    toggle('userMenuChangePasswordItem', puedeCambiarPass);
    toggle('userMenuSettingsItem', puedeConfigurar);
    toggle('userMenuDivider', puedeCambiarPass || puedeConfigurar);
    toggle('settingsHeaderBtn', puedeConfigurar);
    const btn = document.getElementById('userMenuBtn');
    if (btn) btn.setAttribute('aria-label', `${t('header.userMenu')}: ${nombre}`);
    const gear = document.getElementById('settingsHeaderBtn');
    if (gear) { gear.title = t('nav.settings'); gear.setAttribute('aria-label', t('nav.settings')); }
}

// Configuración ya no es una pestaña visible: el engranaje del header
// y el menú del usuario activan la pestaña oculta #tabConfiguracion.
function abrirConfiguracion() {
    const btn = document.querySelector('[data-bs-target="#tabConfiguracion"]');
    if (!btn || !currentUser || currentUser.role !== 'admin') return;
    bootstrap.Tab.getOrCreateInstance(btn).show();
    document.getElementById('adminTabsContent')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function abrirCambioContrasenaUsuario() {
    if (!currentUser) return;
    if (currentUser.role === 'admin') {
        if (currentUser.rol !== ROLES.PROGRAMADOR) return;
        resetAdminChangePasswordForm();
        bootstrap.Modal.getOrCreateInstance(document.getElementById('adminChangePasswordModal')).show();
    } else {
        resetChangePasswordForm();
        bootstrap.Modal.getOrCreateInstance(document.getElementById('changePasswordModal')).show();
    }
}

// Al cambiar de idioma con una sesión abierta se vuelve a pintar el
// header, sin recorrer todo showDashboard() (que además recarga datos).
function reaplicarTraduccionHeader() {
    if (document.getElementById('dashboardScreen').classList.contains('hidden')) return;
    if (!currentUser && !quickFichajeActivo) return;
    renderUserMenu();
}
if (typeof onLocaleChangeRerender === 'function') onLocaleChangeRerender(reaplicarTraduccionHeader);

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
    // Materias todavía sin cargar: no se sabe el horario real, así que
    // no se inventa uno con el horario_laboral viejo (ver materiasCargadas).
    if (!materiasCargadas) return [];
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
    const listo = count >= CONFIG.MIN_CAPTURES;
    // Con las 3 fotos la biometría está lista, pero el docente todavía
    // NO está guardado: se avisa explícito y se lleva la vista al botón
    // "Guardar Docente" (antes quedaba "3/3" y parecía que ya estaba).
    el.innerHTML = listo
        ? `<i class="bi bi-check-circle-fill"></i> ${t('teachers.captureDone', { n: count })}`
        : `Fotos válidas: ${count}/${CONFIG.MIN_CAPTURES}`;
    el.classList.toggle('ready', listo);
    const btn = document.getElementById('saveTeacherBtn');
    if (btn) btn.classList.toggle('save-teacher-ready', listo);
    if (listo && btn) setTimeout(() => btn.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400);
}

// Validación del alta: además del toast, abre la sección plegada
// del acordeón donde está el campo (Contacto/Laboral quedan cerradas
// por defecto), lo marca en rojo y le pone el foco - antes solo salía
// el toast arriba y no se veía qué faltaba.
function marcarCampoFaltante(inputId, mensaje) {
    showToast(mensaje, 'error');
    const input = document.getElementById(inputId);
    if (!input) return;
    const seccion = input.closest('.accordion-collapse');
    if (seccion && !seccion.classList.contains('show')) bootstrap.Collapse.getOrCreateInstance(seccion, { toggle: false }).show();
    input.classList.add('is-invalid');
    input.addEventListener('input', () => input.classList.remove('is-invalid'), { once: true });
    setTimeout(() => { input.scrollIntoView({ behavior: 'smooth', block: 'center' }); input.focus({ preventScroll: true }); }, 350);
}

// Confirmación clara de un alta nueva (antes era solo un toast de unos
// segundos): datos de acceso + atajo para probar el fichaje con cámara
// en el momento (cierra la sesión admin y abre el fichaje rápido).
function mostrarAltaExitosa(teacher, password) {
    const body = document.getElementById('altaExitosaBody');
    if (!body) return;
    body.innerHTML = `
        <div class="alta-exitosa-icon"><i class="bi bi-check-circle-fill"></i></div>
        <h4 class="mb-1">${t('teachers.altaOkTitle')}</h4>
        <p class="text-muted mb-3">${teacher.apellido} ${teacher.nombre}</p>
        <div class="alta-exitosa-datos text-start mb-3">
            <div><span>${t('teachers.altaOkUser')}</span><strong>${teacher.dni}</strong></div>
            <div><span>${t('teachers.altaOkPassword')}</span><strong>${password}</strong></div>
            <div><span>${t('teachers.altaOkFace')}</span><strong><i class="bi bi-check-circle-fill"></i> ${t('teachers.altaOkFaceDone')}</strong></div>
        </div>
        <p class="small text-muted mb-3">${t('teachers.altaOkHint')}</p>
        <div class="d-grid gap-2">
            <button class="btn btn-primary" onclick="irAFichajeRapidoTrasAlta()"><i class="bi bi-camera-video"></i> ${t('teachers.altaOkTryCamera')}</button>
            <button class="btn btn-secondary" data-bs-dismiss="modal">${t('teachers.altaOkStay')}</button>
        </div>`;
    bootstrap.Modal.getOrCreateInstance(document.getElementById('altaExitosaModal')).show();
}

function irAFichajeRapidoTrasAlta() {
    const el = document.getElementById('altaExitosaModal');
    const modal = bootstrap.Modal.getOrCreateInstance(el);
    el.addEventListener('hidden.bs.modal', () => { logout(); enterQuickFichaje(); }, { once: true });
    modal.hide();
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
    renderMateriasDocenteChecklist(null);
    capturedPhotos = [];
    capturedDescriptors = [];
    renderCaptureThumbs();
    updateCaptureStatusUI();
    document.querySelectorAll('#tabDocentes .is-invalid').forEach(el => el.classList.remove('is-invalid'));
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

    if (!apellido) { marcarCampoFaltante('regApellido', 'El apellido es obligatorio'); return; }
    if (!nombre) { marcarCampoFaltante('regNombre', 'El nombre es obligatorio'); return; }
    if (!dni) { marcarCampoFaltante('regDni', 'El DNI es obligatorio'); return; }
    if (!telefono) { marcarCampoFaltante('regTelefono', 'El teléfono personal es obligatorio'); return; }
    // Completo con característica: se usa para avisarle por WhatsApp
    // cuando se acerca al cupo anual de faltas (ver botonesAvisoFaltas()).
    if (!telefonoValidoParaWhatsApp(telefono)) { marcarCampoFaltante('regTelefono', t('teachers.phoneIncomplete')); return; }
    if (!telefonoFamiliar) { marcarCampoFaltante('regTelefonoFamiliar', 'El teléfono de contacto familiar es obligatorio'); return; }
    if (!email) { marcarCampoFaltante('regEmail', 'El e-mail es obligatorio'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { marcarCampoFaltante('regEmail', 'El e-mail no tiene un formato válido'); return; }
    // Alta nueva: tiene que salir con al menos una materia, porque de
    // ahí sale su horario (y contra ese horario se controla tarde/
    // presente/falta). Solo si hay materias cargadas en el sistema.
    if (!editingTeacherId && currentMaterias.length > 0 && materiasSeleccionadasDocenteIds.size === 0) {
        marcarCampoFaltante('materiaAsignarCarrera', t('teachers.subjectRequired'));
        return;
    }
    // Un docente no puede dar dos materias a la misma hora (el
    // calendario ya las marca en rojo; acá se impide guardar).
    const elegidas = currentMaterias.filter(m => materiasSeleccionadasDocenteIds.has(m.id));
    for (let i = 0; i < elegidas.length; i++) {
        for (let j = i + 1; j < elegidas.length; j++) {
            const h1 = materiaHorarios(elegidas[i]).find(a => materiaHorarios(elegidas[j]).some(b => horariosSeSuperponen(a, b)));
            if (h1) {
                marcarCampoFaltante('materiaAsignarCarrera', `"${elegidas[i].nombre}" y "${elegidas[j].nombre}" se superponen el ${h1.dia}. Un docente no puede dar dos materias a la vez.`);
                return;
            }
        }
    }
    // Ya no se pide horario acá: el horario de cátedra se carga y edita
    // solo desde el CRUD de Materias (ver checklist "Materias asignadas"
    // más abajo en este mismo formulario). Un docente sin materias
    // todavía queda sin horario hasta que se le asigne una.

    const teachers = getTeachers();
    if (teachers.some(t => t.dni === dni && t.id !== editingTeacherId)) {
        marcarCampoFaltante('regDni', 'Ya existe un docente con el DNI ' + dni);
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
    }
    const esAltaNueva = !editingTeacherId;

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
    if (esAltaNueva) mostrarAltaExitosa(savedTeacher, password);
}

// ============================================================
// ADMIN - DASHBOARD
// ============================================================
async function loadAdminDashboard() {
    // Si se entró al panel antes de que terminara la carga inicial, se
    // esperan las materias acá: checkFaltas()/updateStats() las necesitan.
    if (!materiasCargadas) { await loadCarreras(); await loadMaterias(); }
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
    // "Materias asignadas" del formulario de alta: antes solo se pintaba
    // al tocar Limpiar/Editar, así que al entrar al panel el selector de
    // Carrera quedaba vacío.
    renderMateriasDocenteChecklist(editingTeacherId || null);
}

function loadTeachersTable() {
    const teachers = getTeachers();
    const tbody = document.getElementById('teachersTableBody');
    const today = getFechaHoyArgentina();
    document.getElementById('teacherCountBadge').textContent = teachers.length;
    if (teachers.length === 0) {
        tbody.innerHTML = `<tr><td colspan="12" class="text-center">${t('teachers.noneRegistered')}</td></tr>`;
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
                <td data-label="Materia"><span class="teacher-row-dni">DNI ${teacher.dni}</span> · ${teacher.materia || '-'}${teacher.faceDescriptor ? '' : ` · <span class="teacher-row-warn"><i class="bi bi-exclamation-circle"></i> ${t('teachers.noBiometrics')}</span>`}</td>
                <td data-label="Horario"><small>${scheduleDisplay}</small></td>
                <td data-label="Contraseña"><span class="badge bg-info">${tienePermiso(currentUser.rol, 'ver_claves') ? teacher.password : '••••••'}</span></td>
                <td data-label="Biometría">${bioBadge}</td>
                <td data-label="Estado hoy">${status}</td>
                <td data-label="Acciones" onclick="event.stopPropagation()">
                    ${renderWhatsAppButton(teacher.telefono, teacher.nombre)}
                    <button class="btn btn-sm teacher-action" title="Editar docente" aria-label="Editar docente" onclick="editTeacher('${teacher.id}')"><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-sm teacher-action" title="Calendario ${SCHEDULE_CALENDAR_YEAR}" aria-label="Calendario" onclick="showTeacherCalendar('${teacher.id}')"><i class="bi bi-calendar3"></i></button>
                    <button class="btn btn-sm teacher-action" title="Fichaje manual" aria-label="Fichaje manual" onclick="openManualAttendanceModal('${teacher.id}')"><i class="bi bi-fingerprint"></i></button>
                    <button class="btn btn-sm teacher-action" title="Restablecer contraseña" aria-label="Restablecer contraseña" onclick="resetTeacherPassword('${teacher.id}')"><i class="bi bi-key"></i></button>
                    ${tienePermiso(currentUser.rol, 'borrar') ? `<button class="btn btn-sm teacher-action teacher-action-danger" title="Eliminar" aria-label="Eliminar" onclick="deleteTeacher('${teacher.id}')"><i class="bi bi-trash"></i></button>` : ''}
                </td>
            </tr>
        `;
    }).join('');
    filterTeachersTable();
}

// Filtra en vivo las filas de la tabla de docentes (no vuelve a
// pedir datos, solo oculta/muestra filas ya renderizadas) según lo
// que el administrador va tipeando en el buscador. Sin texto no se
// lista a nadie (la planta puede ser larga): solo un aviso con el
// total y el link "Ver todos", que muestra la lista completa hasta
// que se vuelva a escribir algo. Ignora tildes y mayúsculas.
let teachersShowAll = false;
const normalizarBusqueda = (txt) => String(txt || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function filterTeachersTable() {
    const input = document.getElementById('teacherSearchInput');
    if (!input) return;
    const q = normalizarBusqueda(input.value.trim());
    if (q) teachersShowAll = false;
    const rows = document.querySelectorAll('#teachersTableBody tr[data-search]');
    let visibles = 0;
    rows.forEach(tr => {
        const mostrar = q ? normalizarBusqueda(tr.dataset.search).includes(q) : teachersShowAll;
        tr.style.display = mostrar ? '' : 'none';
        if (mostrar) visibles++;
    });

    // Sin filas visibles no se deja la caja de la tabla vacía a la vista.
    const tabla = document.querySelector('#teachersAccordionBody .admin-table');
    if (tabla) tabla.classList.toggle('hidden', visibles === 0);

    const hint = document.getElementById('teacherSearchHint');
    if (!hint) return;
    const total = rows.length;
    if (total === 0) { hint.innerHTML = ''; return; }
    if (q) {
        hint.innerHTML = visibles === 0
            ? `<i class="bi bi-emoji-frown"></i> ${t('teachers.searchNoResults')}`
            : `${t('teachers.searchResults', { n: visibles })}`;
    } else if (teachersShowAll) {
        hint.innerHTML = `${t('teachers.searchShowingAll', { n: total })} · <button type="button" class="btn btn-link btn-sm p-0 align-baseline" onclick="toggleTeachersShowAll(false)">${t('teachers.searchHideAll')}</button>`;
    } else {
        hint.innerHTML = `<i class="bi bi-search"></i> ${t('teachers.searchPrompt', { n: total })} · <button type="button" class="btn btn-link btn-sm p-0 align-baseline" onclick="toggleTeachersShowAll(true)">${t('teachers.searchShowAll')}</button>`;
    }
}
if (typeof onLocaleChangeRerender === 'function') onLocaleChangeRerender(filterTeachersTable);

function toggleTeachersShowAll(mostrar) {
    teachersShowAll = mostrar;
    filterTeachersTable();
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

// ===== Envío múltiple a Rectoría =====
// Secretaría puede tildar varias alertas y mandarlas juntas, en vez de
// tocar "Enviar a Rectoría" una por una. Solo son seleccionables las
// que tendrían ese botón (no resueltas y todavía no enviadas).
let alertasSeleccionadas = new Set();

function alertaSeleccionablePorMi(alert) {
    return !!currentUser && currentUser.rol === ROLES.SECRETARIA && !alert.justified &&
        alert.justification !== 'pendiente_aprobacion_rectoria';
}

function renderBarraAlertasMasivo() {
    const bar = document.getElementById('alertsBulkBar');
    if (!bar) return;
    const seleccionables = getAlerts().filter(alertaSeleccionablePorMi);
    const ids = new Set(seleccionables.map(a => a.id));
    alertasSeleccionadas = new Set([...alertasSeleccionadas].filter(id => ids.has(id)));
    if (seleccionables.length === 0) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    const n = alertasSeleccionadas.size;
    const todas = n === seleccionables.length;
    bar.classList.remove('hidden');
    bar.innerHTML = `
        <label class="alerts-bulk-all">
            <input type="checkbox" class="form-check-input" ${todas ? 'checked' : ''} onchange="seleccionarTodasLasAlertas(this.checked)">
            <span>${t('alerts.selectAll', { n: seleccionables.length })}</span>
        </label>
        <button type="button" class="btn btn-primary btn-sm" ${n === 0 ? 'disabled' : ''} onclick="enviarAlertasSeleccionadasARectoria()">
            <i class="bi bi-send"></i> ${t('alerts.sendSelected', { n })}
        </button>`;
}

function toggleSeleccionAlerta(id, checked) {
    if (checked) alertasSeleccionadas.add(id);
    else alertasSeleccionadas.delete(id);
    document.querySelector(`.alert-card[data-alert-id="${id}"]`)?.classList.toggle('is-selected', checked);
    renderBarraAlertasMasivo();
}

function seleccionarTodasLasAlertas(checked) {
    alertasSeleccionadas = checked ? new Set(getAlerts().filter(alertaSeleccionablePorMi).map(a => a.id)) : new Set();
    loadAlerts();
}

// Mismo efecto que justifyAlert(id, 'pendiente_aprobacion_rectoria')
// alerta por alerta, pero guardando una sola vez.
function enviarAlertasSeleccionadasARectoria() {
    if (!currentUser || currentUser.rol !== ROLES.SECRETARIA) {
        showToast(mensajeSinPermiso('justificar_alerta'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó enviar alertas a Rectoría sin permiso');
        return;
    }
    const alerts = getAlerts();
    const aEnviar = alerts.filter(a => alertasSeleccionadas.has(a.id) && alertaSeleccionablePorMi(a));
    if (aEnviar.length === 0) return;
    if (!confirm(t('alerts.confirmSendSelected', { n: aEnviar.length }))) return;
    aEnviar.forEach(a => { a.justified = false; a.justification = 'pendiente_aprobacion_rectoria'; });
    saveAlerts(alerts);
    logAccion('ENVIAR_ALERTAS_RECTORIA', `Envió ${aEnviar.length} alerta(s) a Rectoría: ${aEnviar.map(a => `${a.type} - ${a.teacherName}`).join('; ')}`);
    alertasSeleccionadas = new Set();
    loadAlerts();
    showToast(t('alerts.sentSelected', { n: aEnviar.length }), 'info');
}

function loadAlerts() {
    // Más reciente arriba, más antigua abajo.
    const alerts = getAlerts().slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const container = document.getElementById('alertsList');
    renderBarraAlertasMasivo();
    if (alerts.length === 0) { container.innerHTML = `<p class="text-muted">${t('alerts.none')}</p>`; return; }
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

        const seleccionable = alertaSeleccionablePorMi(alert);
        const seleccionada = seleccionable && alertasSeleccionadas.has(alert.id);
        const checkbox = seleccionable
            ? `<input type="checkbox" class="form-check-input alert-select" ${seleccionada ? 'checked' : ''} onchange="toggleSeleccionAlerta('${alert.id}', this.checked)" aria-label="Seleccionar alerta">`
            : '';
        return `
            <div class="alert-card ${isJustified && !isDenied ? 'justified' : ''} ${seleccionada ? 'is-selected' : ''}" data-alert-id="${alert.id}">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        ${checkbox}
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
    const pendientes = alerts.filter(a => !a.justified).length;
    const countEl = document.getElementById('alertCount');
    countEl.textContent = pendientes > 99 ? '99+' : pendientes;
    countEl.classList.toggle('hidden', pendientes === 0);
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
    document.getElementById('lateLimitInput').value = criteria.lateLimit;
    document.getElementById('faltasPermitidasInput').value = criteria.faltasPermitidasAnio;
    document.getElementById('avisoFaltasInput').value = criteria.avisoFaltasDesde;
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
// objeto criteria en Supabase. lateLimit volvió a tener campo propio
// ("Tolerancia de fichaje", pedido para el fichaje automático): antes
// había quedado guardado sin forma de editarlo desde la pantalla.
async function saveCriteria() {
    const criteria = {
        ...getCriteria(),
        minAttendance: parseInt(document.getElementById('minAttendance').value) || 80,
        minHours: parseInt(document.getElementById('minHours').value) || 4,
        // Tolerancia de fichaje (tardanza): la usan el fichaje automático
        // (toleranciaFichajeMin()), checkFaltas() y calcularEstadoFichajeAutomatico().
        lateLimit: Math.max(0, parseInt(document.getElementById('lateLimitInput').value, 10) || CONFIG.LATE_LIMIT),
        faltasPermitidasAnio: Math.max(0, parseInt(document.getElementById('faltasPermitidasInput').value, 10) || FALTAS_PERMITIDAS_DEFAULT),
        avisoFaltasDesde: Math.max(1, parseInt(document.getElementById('avisoFaltasInput').value, 10) || AVISO_FALTAS_DEFAULT),
    };
    if (criteria.avisoFaltasDesde > criteria.faltasPermitidasAnio) {
        marcarCampoFaltante('avisoFaltasInput', t('config.warnAfterLimit'));
        return;
    }
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
        select.innerHTML = `<option value="">${t('licencias.select')}</option>`;
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
    renderFichajeContextBadges();
    renderMateriaFichajeInfo();
    loadMisLicenciasDocente();
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
        quickFichajeOnFrame(!!result);
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
// como registrarEntradaJornada() lo hace para un tipo 'entry' (mismo
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
    ultimoGeoFichaje = geo.ok ? { geo, at: Date.now() } : null;
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
    } catch (error) {
        console.error(error);
        progress.style.display = 'none';
        status.className = 'face-recognition-status error';
        status.innerHTML = '<i class="bi bi-exclamation-triangle"></i> Error en el reconocimiento';
        showToast('Error en el reconocimiento', 'error');
    }
}

// ============================================================
// FICHAJE RÁPIDO CON CÁMARA (sin usuario/contraseña)
// Desde el login, "Fichar con cámara" abre la misma pantalla de
// cámara del docente pero SIN sesión: el docente solo se para frente
// a la cámara, el sistema lo busca entre TODOS los docentes (1:N) y,
// si lo encuentra, sigue exactamente el pipeline de siempre -
// detectFace(): geocerca + prueba de vida + comparación 1:1 contra
// ese docente + modal de Ingreso/Salida. La búsqueda 1:N solo elige
// al candidato; la validación real sigue siendo la de detectFace(),
// así que no se relaja ningún control.
// La materia se elige sola según el horario del momento (ver
// elegirMateriaPorHorario()). Al terminar (o cancelar), la pantalla
// queda lista para el próximo docente, sin mostrar datos personales
// (.quick-mode en style.css oculta "Mis Datos" y los botones manuales).
// ============================================================
let quickFichajeActivo = false;
let quickFichajeBusy = false;
let quickFaceStreak = 0;
let quickCooldownUntil = 0;
// Margen mínimo de distancia entre el mejor candidato y el segundo:
// si dos docentes se parecen demasiado a la cara en vivo, no se
// adivina - se pide ingresar con usuario y contraseña.
const QUICK_AMBIGUITY_MARGIN = 0.06;
// Frames seguidos con cara detectada (cada 500ms, ver startLiveOverlay())
// antes de arrancar solo, y pausa después de cada ciclo para no volver
// a disparar con el mismo docente que todavía no se alejó.
const QUICK_AUTOSTART_FRAMES = 3;
const QUICK_COOLDOWN_MS = 6000;

function enterQuickFichaje() {
    if (!dataLoaded) { showToast(t('fichaje.quickDataLoading'), 'warning'); return; }
    quickFichajeActivo = true;
    quickFichajeBusy = false;
    quickFaceStreak = 0;
    quickCooldownUntil = 0;
    currentUser = null;
    recognizedTeacher = null;
    isFaceVerified = false;
    materiaFichajeSeleccionada = null;
    lastLivenessResult = null;

    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('dashboardScreen').classList.remove('hidden');
    document.getElementById('statsScreen').classList.add('hidden');
    document.getElementById('adminDashboard').classList.add('hidden');
    const td = document.getElementById('teacherDashboard');
    td.classList.remove('hidden');
    td.classList.add('quick-mode');
    renderQuickFichajeHeader();
    setQuickAltaVisible(false);
    renderEstadoModoPrueba();
    document.getElementById('alertsBellBtn')?.classList.add('hidden');
    document.getElementById('materiaFichajeInfo').innerHTML = '';
    document.getElementById('miUltimoFichajeBox').innerHTML = '';
    setQuickWaitingStatus();
    renderFichajeContextBadges();
    startTeacherCamera();
    logAccion('FICHAJE_RAPIDO_INICIO', 'Se abrió el fichaje rápido con cámara', null);
}

function setQuickWaitingStatus() {
    const status = document.getElementById('faceRecognitionStatus');
    if (!status) return;
    status.className = 'face-recognition-status waiting';
    status.innerHTML = `<i class="bi bi-person-bounding-box"></i> ${t('fichaje.quickWaiting')}`;
}

// Título/badge del header en modo rápido. No usan data-i18n (el header
// es compartido con el panel admin/docente), así que se vuelven a
// pintar al cambiar de idioma - ver onLocaleChangeRerender() abajo.
function renderQuickFichajeHeader() {
    if (!quickFichajeActivo) return;
    renderUserMenu();
    const status = document.getElementById('faceRecognitionStatus');
    if (status && status.classList.contains('waiting') && !currentUser) setQuickWaitingStatus();
}
if (typeof onLocaleChangeRerender === 'function') onLocaleChangeRerender(renderQuickFichajeHeader);

// ===== Dar de alta desde el fichaje rápido =====
// Si la cámara no reconoce a nadie, se ofrece "Dar de alta". Solo un
// usuario de administración con permiso agregar_docente (Secretaría,
// Rector o Programador) puede continuar: se sale del modo rápido, se
// inicia sesión como ese admin y se abre directo el formulario
// "Registrar Nuevo Docente" (pestaña Docentes) con su cámara.
function setQuickAltaVisible(visible) {
    const wrap = document.getElementById('quickAltaWrap');
    if (wrap) wrap.classList.toggle('hidden', !visible);
}

function openQuickAltaModal() {
    document.getElementById('quickAltaUser').value = '';
    document.getElementById('quickAltaPass').value = '';
    document.getElementById('quickAltaError').classList.add('hidden');
    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('quickAltaModal'));
    modal.show();
    setTimeout(() => document.getElementById('quickAltaUser').focus(), 300);
}

async function submitQuickAlta() {
    const errorEl = document.getElementById('quickAltaError');
    const btn = document.getElementById('quickAltaSubmitBtn');
    const rawUser = document.getElementById('quickAltaUser').value.trim();
    const pass = document.getElementById('quickAltaPass').value.trim();
    if (!window.crypto || !window.crypto.subtle) {
        showToast('Este navegador/conexión no permite validar credenciales de forma segura (hace falta HTTPS)', 'error');
        return;
    }
    btn.disabled = true;
    let admin = null;
    try { admin = await autenticarAdmin(rawUser, pass); } finally { btn.disabled = false; }

    if (!admin || !tienePermiso(admin.rol, 'agregar_docente')) {
        errorEl.textContent = t('fichaje.quickAltaError');
        errorEl.classList.remove('hidden');
        logAccion('LOGIN_FALLIDO', `Intento fallido de "Dar de alta" desde fichaje rápido - usuario: ${rawUser.toUpperCase()}`, null);
        return;
    }

    bootstrap.Modal.getOrCreateInstance(document.getElementById('quickAltaModal')).hide();
    quickFichajeActivo = false;
    quickFichajeBusy = false;
    stopLiveOverlay();
    document.getElementById('teacherDashboard').classList.remove('quick-mode');
    currentUser = admin;
    logAccion('LOGIN', `Login ${admin.rol} (Dar de alta desde fichaje rápido)`);
    showDashboard();
    // Directo al formulario de alta: pestaña Docentes (showDashboard()
    // ya arranca la cámara de registro vía loadAdminDashboard()).
    const tabBtn = document.querySelector('[data-bs-target="#tabDocentes"]');
    if (tabBtn) bootstrap.Tab.getOrCreateInstance(tabBtn).show();
    setTimeout(() => {
        const title = document.getElementById('regFormTitle');
        if (title) title.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 250);
    showToast(t('fichaje.quickAltaReady'), 'info');
}

// Limpia al docente del ciclo que terminó y deja la pantalla lista
// para el siguiente. Se llama al cerrar el modal (finalizar/cancelar/
// timeout) o cuando el pipeline cortó antes de abrirlo.
function endQuickFichajeCycle() {
    if (!quickFichajeActivo) return;
    currentUser = null;
    recognizedTeacher = null;
    isFaceVerified = false;
    materiaFichajeSeleccionada = null;
    quickFichajeBusy = false;
    quickFaceStreak = 0;
    quickCooldownUntil = Date.now() + QUICK_COOLDOWN_MS;
    setTimeout(() => {
        if (quickFichajeActivo && !quickFichajeBusy && !faceModalPending) setQuickWaitingStatus();
    }, QUICK_COOLDOWN_MS);
}

// Elige con qué materia ficha el docente AHORA según su horario de
// hoy: la que está en curso, o si no hay ninguna, la más cercana en
// el tiempo (la próxima a empezar o la que acaba de terminar). Sin
// materias asignadas devuelve null y se usa su horario_laboral, igual
// que en el fichaje con login.
function elegirMateriaPorHorario(teacher, now) {
    const materias = getMateriasDeDocente(teacher.id);
    if (materias.length === 0) return null;
    if (materias.length === 1) return materias[0].id;
    now = now || new Date();
    const hoy = getDiaSemanaArgentina(now);
    const ahora = getMinutosDesdeMedianocheArgentina(now);
    const aMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
    let mejor = null;
    materias.forEach(m => materiaHorarios(m).filter(h => h.dia === hoy).forEach(h => {
        const ini = aMin(h.inicio), fin = aMin(h.fin);
        const lejania = ahora < ini ? ini - ahora : ahora > fin ? ahora - fin : 0;
        if (!mejor || lejania < mejor.lejania) mejor = { id: m.id, lejania };
    }));
    return mejor ? mejor.id : materias[0].id;
}

// Búsqueda 1:N: compara la cara en vivo contra todos los docentes con
// datos biométricos. Devuelve { teacher, confidence } si hay un único
// candidato claro, o { error } si no reconoce a nadie o es ambiguo.
async function identificarDocenteEntreTodos(video) {
    const samples = [];
    for (let i = 0; i < CONFIG.IDENTIFY_SAMPLES; i++) {
        const d = await getDescriptorFromVideoElement(video);
        if (d) samples.push(d);
        if (i < CONFIG.IDENTIFY_SAMPLES - 1) await sleep(CONFIG.IDENTIFY_SAMPLE_INTERVAL_MS);
    }
    if (samples.length === 0) return { error: 'noface' };
    const live = averageDescriptors(samples);
    const ranking = getTeachers()
        .filter(tc => Array.isArray(tc.faceDescriptor) && tc.faceDescriptor.length > 0)
        .map(tc => ({ teacher: tc, distance: euclideanDistance(live, tc.faceDescriptor) }))
        .sort((a, b) => a.distance - b.distance);
    if (ranking.length === 0) return { error: 'nomatch' };
    const best = ranking[0];
    const confidence = computeFaceConfidence(best.distance);
    console.log(`Fichaje rápido: mejor ${best.teacher.dni} dist ${best.distance.toFixed(3)} (${confidence}%)` +
        (ranking[1] ? `, segundo dist ${ranking[1].distance.toFixed(3)}` : ''));
    if (best.distance > CONFIG.FACE_MATCH_THRESHOLD || confidence < FACE_CONFIDENCE_MIN_MATCH) return { error: 'nomatch' };
    if (ranking[1] && ranking[1].distance - best.distance < QUICK_AMBIGUITY_MARGIN) return { error: 'ambiguous' };
    return { teacher: best.teacher, confidence };
}

async function detectFaceQuick() {
    if (!quickFichajeActivo || quickFichajeBusy || faceModalPending) return;
    const video = document.getElementById('teacherVideo');
    const status = document.getElementById('faceRecognitionStatus');
    if (!video.srcObject) { showToast('La cámara no está disponible', 'error'); return; }
    if (!modelsLoaded) { showToast('El módulo de reconocimiento facial todavía está cargando, esperá unos segundos', 'warning'); return; }

    quickFichajeBusy = true;
    status.className = 'face-recognition-status processing';
    status.innerHTML = `<i class="bi bi-hourglass-split"></i> ${t('fichaje.quickSearching')}`;
    let result;
    try {
        result = await identificarDocenteEntreTodos(video);
    } catch (e) {
        console.error(e);
        result = { error: 'nomatch' };
    }

    if (!result.teacher) {
        const msg = result.error === 'noface' ? t('fichaje.quickNoFace')
            : result.error === 'ambiguous' ? t('fichaje.quickAmbiguous')
            : t('fichaje.quickNotRecognized');
        status.className = 'face-recognition-status error';
        status.innerHTML = `<i class="bi bi-x-circle"></i> ${msg}`;
        // Solo "no coincide con nadie" ofrece dar de alta: si fue
        // ambiguo, la persona SÍ está cargada (se parece a 2+ docentes).
        if (result.error === 'nomatch') setQuickAltaVisible(true);
        else if (result.error === 'ambiguous') setQuickAltaVisible(false);
        if (result.error !== 'noface') logAccion('FICHAJE_RAPIDO_NO_RECONOCIDO', `Fichaje rápido sin coincidencia (${result.error})`, null);
        endQuickFichajeCycle();
        return;
    }

    // Candidato encontrado: a partir de acá es el fichaje de siempre,
    // como si ese docente hubiera iniciado sesión.
    const teacher = result.teacher;
    setQuickAltaVisible(false);
    currentUser = { role: 'teacher', rol: ROLES.DOCENTE, ...teacher };
    materiaFichajeSeleccionada = elegirMateriaPorHorario(teacher);
    logAccion('FICHAJE_RAPIDO_CANDIDATO', `Fichaje rápido: reconocido ${teacher.apellido} ${teacher.nombre} (DNI ${teacher.dni}, ${result.confidence}%) - sigue geocerca + prueba de vida`, null);
    await detectFace();

    // Si detectFace() no abrió el modal (fuera de geocerca, prueba de
    // vida fallida, no coincidió 1:1...), se libera para el siguiente
    // intento dejando visible el motivo que ya mostró detectFace().
    if (!faceModalPending && !isFaceVerified) endQuickFichajeCycle();
    else quickFichajeBusy = false;
}

// Arranque automático: si hay una cara frente a la cámara durante
// QUICK_AUTOSTART_FRAMES chequeos seguidos, se identifica sola (el
// botón "Identificarme" sigue estando por si se prefiere tocarlo).
function quickFichajeOnFrame(hayCara) {
    const altaAbierta = document.getElementById('quickAltaModal')?.classList.contains('show');
    if (!quickFichajeActivo || quickFichajeBusy || faceModalPending || currentUser || altaAbierta) { quickFaceStreak = 0; return; }
    if (Date.now() < quickCooldownUntil) { quickFaceStreak = 0; return; }
    quickFaceStreak = hayCara ? quickFaceStreak + 1 : 0;
    if (quickFaceStreak >= QUICK_AUTOSTART_FRAMES) {
        quickFaceStreak = 0;
        detectFaceQuick();
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
        if ((currentUser && currentUser.role === 'teacher') || quickFichajeActivo) startLiveOverlay();
        video.play().catch(() => {});
    }
}

function setFaceNavLocksDisabled(disabled) {
    const header = document.getElementById('dashboardLogoutBtn');
    const menu = document.getElementById('userMenuBtn');
    const camera = document.getElementById('teacherLogoutBtn');
    if (header) header.disabled = disabled;
    if (menu) menu.disabled = disabled;
    if (camera) camera.disabled = disabled;
}

// ============================================================
// FICHAJE AUTOMÁTICO SEGÚN EL HORARIO DEL DOCENTE
// Al identificarse, el sistema decide solo qué corresponde según sus
// días y horarios registrados (materias), con una tolerancia (la de
// "Tolerancia de fichaje" de Configuración, 15 min por defecto):
//  - Entrada (lo ÚNICO obligatorio): desde TOL min antes del inicio.
//    Hasta inicio+TOL = Presente; después = Tardanza + alerta. La
//    entrada cubre todo el horario: no hace falta registrar salida.
//  - Retiro anticipado (opcional): con la entrada hecha y la clase
//    todavía en curso, pregunta y, si confirma, la clase queda como
//    MEDIA FALTA (+ alerta de Salida Anticipada); las que todavía no
//    empezaron quedan como falta.
//  - Fuera de horario / día sin clases: lo dice y NO registra nada.
// Las clases seguidas (hueco <= TOL) forman una "jornada": una sola
// identificación deja la entrada de todas las que todavía no
// terminaron (cada una con su materiaId, como las lee
// getScheduleEntriesForDate()). Si se retira antes, las que todavía
// no empezaron se anulan para no quedar como presentes.
// ============================================================
let faceDecision = null;
let ultimoGeoFichaje = null;

function toleranciaFichajeMin() {
    return Number(getCriteria().lateLimit) || 15;
}

const minutosDeHora = (hhmm) => { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const horaDeMinutos = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function jornadasDeHoy(teacher, now) {
    const tol = toleranciaFichajeMin();
    const dia = getDiaSemanaArgentina(now);
    const fecha = getFechaHoyArgentina(now);
    const registros = getAttendance().filter(a => a.teacherId === teacher.id && getFechaRealFichaje(a) === fecha &&
        (a.categoria || 'regular') === 'regular' && !a.anulado);
    const mismaMateria = (a, b) => (a.materiaId || null) === (b.materiaId || null);
    const bloques = getHorarioEfectivo(teacher)
        .filter(h => h.dia === dia && h.inicio && h.fin)
        .map(h => ({ ...h, ini: minutosDeHora(h.inicio), end: minutosDeHora(h.fin) }))
        .sort((a, b) => a.ini - b.ini);
    bloques.forEach(b => {
        b.entrada = registros.find(a => a.type === 'entry' && mismaMateria(a, b) && fichajeValidoParaClase(a.time, b.inicio)) || null;
        b.salida = b.entrada ? (registros.find(a => (a.type === 'exit' || a.type === 'early_exit') && mismaMateria(a, b) && (a.time || '') >= (b.entrada.time || '')) || null) : null;
    });
    const jornadas = [];
    bloques.forEach(b => {
        const ultima = jornadas[jornadas.length - 1];
        if (ultima && b.ini <= ultima.end + tol) { ultima.bloques.push(b); ultima.end = Math.max(ultima.end, b.end); }
        else jornadas.push({ bloques: [b], ini: b.ini, end: b.end });
    });
    return jornadas;
}

function decidirFichaje(teacher, now) {
    now = now || new Date();
    const tol = toleranciaFichajeMin();
    const ahora = getMinutosDesdeMedianocheArgentina(now);
    const jornadas = jornadasDeHoy(teacher, now);
    if (jornadas.length === 0) return { tipo: 'sin_clases_hoy', dia: getDiaSemanaArgentina(now), jornadas, ahora, tol };
    const enVentana = jornadas.find(j => ahora >= j.ini - tol && ahora <= j.end);
    if (enVentana) {
        const conEntrada = enVentana.bloques.filter(b => b.entrada);
        if (conEntrada.length === 0) {
            const bloque = enVentana.bloques.find(b => ahora <= b.end);
            return { tipo: 'entrada', jornada: enVentana, bloque, tardeMin: Math.max(0, ahora - bloque.ini), jornadas, ahora, tol };
        }
        // Ya entró: la salida no es obligatoria. Solo se ofrece el retiro
        // anticipado si la jornada sigue en curso y no se retiró ya.
        const yaSeRetiro = conEntrada.some(b => b.salida && b.salida.type === 'early_exit');
        const entrada = conEntrada[0].entrada;
        if (!yaSeRetiro && ahora < enVentana.end - tol) {
            return { tipo: 'salida', anticipada: true, jornada: enVentana, entrada, jornadas, ahora, tol };
        }
        return { tipo: 'completo', jornada: enVentana, entrada, yaSeRetiro, jornadas, ahora, tol };
    }
    const proxima = jornadas.find(j => j.ini - tol > ahora) || null;
    return { tipo: 'fuera_de_horario', proxima, jornadas, ahora, tol };
}

async function geoParaFichajeAutomatico() {
    if (ultimoGeoFichaje && Date.now() - ultimoGeoFichaje.at < 2 * 60 * 1000) return ultimoGeoFichaje.geo;
    return await verifyGeofence();
}

function registrarEntradaJornada(teacher, dec, geo) {
    const now = new Date();
    const fecha = getFechaHoyArgentina(now);
    const hora = getHoraHHMMSSArgentina(now);
    const liveness = consumeLivenessFields();
    const attendance = getAttendance();
    const aRegistrar = dec.jornada.bloques.filter(b => !b.entrada && b.end >= dec.ahora);
    const esTarde = dec.tardeMin > dec.tol;
    aRegistrar.forEach((b, i) => {
        const tardeEste = b === dec.bloque && esTarde;
        const id = `${Date.now()}${i}`;
        attendance.push({
            id, teacherId: teacher.id, teacherName: `${teacher.apellido} ${teacher.nombre}`,
            date: fecha, time: hora, type: 'entry', status: tardeEste ? 'late' : 'present',
            timestamp: now.toISOString(), horaFichajeReal: now.toISOString(),
            categoria: 'regular', materiaId: b.materiaId || null, fichajeAutomatico: true,
            ...pendingGeofenceFields(geo), ...geoFichajeFields(geo), ...liveness,
        });
        if (i === 0 && geo && geo.coords && navigator.onLine) completarDireccionEIp(id, geo.coords.lat, geo.coords.lng, 'attendance');
    });
    saveAttendance(attendance);
    clearTodaysFaltaAlert(teacher.id, fecha);
    if (esTarde) {
        createAlert(teacher, 'Tardanza', `Llegó ${dec.tardeMin} min tarde (${hora.slice(0, 5)}) a ${dec.bloque.materiaNombre || 'su clase'}. Hora prevista: ${dec.bloque.inicio}. Tolerancia: ${dec.tol} min.`);
    }
    logAccion('FICHAJE', `ENTRADA automática - ${teacher.apellido} ${teacher.nombre} - ${hora} - ${aRegistrar.map(b => `${b.materiaNombre || 'clase'} ${b.inicio}-${b.fin}`).join(', ')}${esTarde ? ` (${dec.tardeMin} min tarde)` : ''}`, geo && geo.coords ? geo.coords : null);
    return { hora: hora.slice(0, 5), bloques: aRegistrar, esTarde };
}

function registrarSalidaJornada(teacher, dec, geo) {
    const now = new Date();
    const fecha = getFechaHoyArgentina(now);
    const hora = getHoraHHMMSSArgentina(now);
    const type = 'early_exit'; // la salida normal ya no se registra: solo el retiro anticipado
    const attendance = getAttendance();
    const abiertos = dec.jornada.bloques.filter(b => b.entrada && !b.salida);
    const anulados = [];
    abiertos.forEach((b, i) => {
        if (dec.anticipada && b.ini > dec.ahora) {
            // Clase de la jornada que todavía no empezó: se anula su
            // entrada adelantada, así no queda como presente.
            const rec = attendance.find(a => a.id === b.entrada.id);
            if (rec) { rec.anulado = true; rec.anuladoEn = now.toISOString(); rec.motivoAnulacion = 'retiro_anticipado'; anulados.push(b); }
            return;
        }
        attendance.push({
            id: `${Date.now()}${i}`, teacherId: teacher.id, teacherName: `${teacher.apellido} ${teacher.nombre}`,
            date: fecha, time: hora, type, status: 'present',
            timestamp: now.toISOString(), horaFichajeReal: now.toISOString(),
            categoria: 'regular', materiaId: b.materiaId || null, fichajeAutomatico: true,
            salidaAnticipada: dec.anticipada,
            ...pendingGeofenceFields(geo), ...geoFichajeFields(geo),
        });
    });
    saveAttendance(attendance);
    if (dec.anticipada) {
        createAlert(teacher, 'Salida Anticipada', `Salida anticipada - ${teacher.apellido} ${teacher.nombre} - ${hora.slice(0, 5)} - Horario que correspondía: hasta las ${horaDeMinutos(dec.jornada.end)}`);
    }
    logAccion('FICHAJE', `${dec.anticipada ? 'SALIDA ANTES DE TIEMPO' : 'SALIDA'} automática - ${teacher.apellido} ${teacher.nombre} - ${hora}`, geo && geo.coords ? geo.coords : null);
    return { hora: hora.slice(0, 5), anulados };
}

async function ejecutarFichajeAutomatico(tipo) {
    const teacher = recognizedTeacher;
    if (!teacher || !faceDecision) return;
    faceDecision.estado = 'registrando';
    renderFaceAttendanceModalBody();
    clearFaceModalTimeout();
    const geo = await geoParaFichajeAutomatico();
    if (!geo.ok) {
        faceDecision.estado = 'listo';
        showGeofenceBlockModal(geo);
        renderFaceAttendanceModalBody();
        resetFaceModalTimeout();
        return;
    }
    // Se recalcula con la hora real de este instante (no la del momento
    // en que se abrió el modal) antes de guardar.
    const dec = decidirFichaje(teacher);
    if (dec.tipo !== tipo) { faceDecision = { dec, estado: 'listo' }; renderFaceAttendanceModalBody(); resetFaceModalTimeout(); return; }
    faceDecision.dec = dec;
    faceDecision.resultado = tipo === 'entrada' ? registrarEntradaJornada(teacher, dec, geo) : registrarSalidaJornada(teacher, dec, geo);
    faceDecision.pendingGeofence = !!(geo && geo.pendingGeofence);
    faceDecision.estado = 'hecho';
    faceModalPending = false;
    renderMiUltimoFichaje();
    if (document.getElementById('adminDashboard').classList.contains('hidden') === false) updateStats();
    renderFaceAttendanceModalBody();
    clearFaceModalTimeout();
    faceModalTimeoutHandle = setTimeout(finishFaceAttendance, quickFichajeActivo ? 6000 : 30000);
}

function listaClasesDeHoyHtml(dec) {
    const items = dec.jornadas.flatMap(j => j.bloques).map(b =>
        `<li><strong>${b.inicio}–${b.fin}</strong> ${b.materiaNombre || ''}${b.entrada ? ` <span class="text-success">✓ ${t('fichaje.autoRegistered')}</span>` : ''}</li>`).join('');
    return items ? `<ul class="fichaje-auto-clases">${items}</ul>` : '';
}

// Parte "cátedra regular" del modal según la decisión automática.
function htmlFichajeAutomatico(teacher) {
    if (!faceDecision) {
        faceDecision = { dec: decidirFichaje(teacher), estado: 'listo' };
        const tipo = faceDecision.dec.tipo;
        const auto = tipo === 'entrada';
        if (auto) setTimeout(() => ejecutarFichajeAutomatico(tipo), 0);
        if (!auto && tipo !== 'salida') faceModalPending = false; // nada para registrar
        if (!auto && tipo !== 'salida' && quickFichajeActivo) {
            clearFaceModalTimeout();
            faceModalTimeoutHandle = setTimeout(finishFaceAttendance, 8000);
        }
    }
    const { dec, estado, resultado } = faceDecision;
    const tol = dec.tol;
    if (estado === 'registrando') {
        return `<div class="fichaje-auto"><div class="spinner-border text-primary mb-2"></div><p class="mb-0">${t('fichaje.autoRegistering')}</p></div>`;
    }
    if (estado === 'hecho' && dec.tipo === 'entrada') {
        const materias = resultado.bloques.map(b => `${b.materiaNombre || ''} (${b.inicio}–${b.fin})`).join(', ');
        const pending = faceDecision.pendingGeofence ? `<div class="alert alert-warning py-2 px-3 small mt-2"><i class="bi bi-wifi-off"></i> Fichaje offline guardado — se validará tu ubicación cuando vuelva la conexión.</div>` : '';
        return resultado.esTarde
            ? `<div class="fichaje-auto is-tarde"><div class="fichaje-auto-icon"><i class="bi bi-clock-history"></i></div>
                <h5>${t('fichaje.autoLateTitle', { min: dec.tardeMin })}</h5>
                <p class="mb-1">${t('fichaje.autoEntryAt', { hora: resultado.hora })} · ${materias}</p>
                <p class="small text-muted mb-0">${t('fichaje.autoLateHint', { inicio: dec.bloque.inicio, tol })}</p>${pending}</div>`
            : `<div class="fichaje-auto is-ok"><div class="fichaje-auto-icon"><i class="bi bi-check-circle-fill"></i></div>
                <h5>${t('fichaje.autoOnTimeTitle')}</h5>
                <p class="mb-0">${t('fichaje.autoEntryAt', { hora: resultado.hora })} · ${materias}</p>${pending}</div>`;
    }
    if (estado === 'hecho' && dec.tipo === 'salida') {
        return `<div class="fichaje-auto ${dec.anticipada ? 'is-tarde' : 'is-ok'}"><div class="fichaje-auto-icon"><i class="bi bi-box-arrow-left"></i></div>
            <h5>${dec.anticipada ? t('fichaje.autoEarlyDone') : t('fichaje.autoExitDone')}</h5>
            <p class="mb-0">${t('fichaje.autoExitAt', { hora: resultado.hora })}</p></div>`;
    }
    switch (dec.tipo) {
        case 'salida':
            return `<div class="fichaje-auto is-tarde"><div class="fichaje-auto-icon"><i class="bi bi-door-open"></i></div>
                <h5>${t('fichaje.autoAlreadyIn', { hora: (dec.entrada.time || '').slice(0, 5) })}</h5>
                <p class="mb-1">${t('fichaje.autoNoExitNeeded')}</p>
                <p class="mb-3 small text-muted">${t('fichaje.autoEarlyHint', { fin: horaDeMinutos(dec.jornada.end) })}</p>
                <div class="d-flex flex-column gap-2">
                    <button class="btn btn-exit btn-lg" onclick="ejecutarFichajeAutomatico('salida')"><i class="bi bi-box-arrow-left"></i> ${t('fichaje.autoEarlyConfirm')}</button>
                    <button class="btn btn-secondary" onclick="cancelFaceAttendanceModal()">${t('fichaje.autoEarlyCancel')}</button>
                </div></div>`;
        case 'fuera_de_horario':
            return `<div class="fichaje-auto is-info"><div class="fichaje-auto-icon"><i class="bi bi-alarm"></i></div>
                <h5>${t('fichaje.autoNotYourTime')}</h5>
                ${dec.proxima
                    ? `<p class="mb-1">${t('fichaje.autoNextClass', { hora: dec.proxima.bloques[0].inicio, materia: dec.proxima.bloques[0].materiaNombre || '' })}</p>
                       <p class="small text-muted">${t('fichaje.autoFrom', { hora: horaDeMinutos(dec.proxima.ini - tol), tol })}</p>`
                    : `<p class="mb-1">${t('fichaje.autoDayOver')}</p>`}
                <p class="small text-muted mb-1">${t('fichaje.autoTodayClasses')}</p>${listaClasesDeHoyHtml(dec)}
                <p class="small text-muted mb-0">${t('fichaje.autoNothingSaved')}</p></div>`;
        case 'sin_clases_hoy':
            return `<div class="fichaje-auto is-info"><div class="fichaje-auto-icon"><i class="bi bi-calendar-x"></i></div>
                <h5>${t('fichaje.autoNoClassesToday', { dia: dec.dia })}</h5>
                <p class="small text-muted mb-0">${t('fichaje.autoNothingSaved')}</p></div>`;
        case 'completo':
            return `<div class="fichaje-auto is-ok"><div class="fichaje-auto-icon"><i class="bi bi-check2-all"></i></div>
                <h5>${dec.yaSeRetiro ? t('fichaje.autoAlreadyLeft') : t('fichaje.autoAlreadyIn', { hora: (dec.entrada.time || '').slice(0, 5) })}</h5>
                <p class="small text-muted mb-1">${dec.yaSeRetiro ? '' : t('fichaje.autoNoExitNeeded')}</p>${listaClasesDeHoyHtml(dec)}</div>`;
        default:
            return '';
    }
}

function openFaceAttendanceModal() {
    faceDecision = null;
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

    const eventosHoy = getEventosDeHoyParaDocente(teacher.id);
    const eventosPendientes = eventosHoy.filter(ev =>
        !(hasEntryToday(teacher.id, 'evento', ev.id) && hasExitToday(teacher.id, 'evento', ev.id))
    );

    // Cátedra regular: decisión automática según días/horarios (ver
    // decidirFichaje()) - sin botones de Entrada/Salida a elegir.
    let html = `<h4 class="mb-2">${t('fichaje.hello', { name: teacher.nombre })} 👋</h4>`;
    html += htmlFichajeAutomatico(teacher);

    if (eventosPendientes.length > 0) {
        html += `<p class="mb-1 small text-muted text-start"><strong><i class="bi bi-calendar-event"></i> ${t('fichaje.specialEventsToday')}</strong></p>`;
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
                ${buildFichajeManualBlock(teacher, 'evento', ev.id, `'evento', ${ev.id}`, 'confirmFaceAttendance', { entrada: t('fichaje.registerEntryEvent'), salida: t('fichaje.registerExitEvent') }, evExitType)}
            </div>`;
        }).join('');
    }

    html += faceDecision && faceDecision.estado === 'hecho'
        ? `<div class="mt-3"><button class="btn btn-success" onclick="finishFaceAttendance()"><i class="bi bi-check2"></i> ${t('fichaje.finish')}</button></div>`
        : (faceDecision && faceDecision.estado === 'registrando' ? '' : `<div class="mt-3"><button class="btn btn-link btn-sm text-muted" onclick="cancelFaceAttendanceModal()">${faceDecision && ['fuera_de_horario', 'sin_clases_hoy', 'completo'].includes(faceDecision.dec.tipo) ? t('fichaje.close') : t('fichaje.notMeCancel')}</button></div>`);
    body.innerHTML = html;
}
if (typeof onLocaleChangeRerender === 'function') onLocaleChangeRerender(renderFaceAttendanceModalBody);

// Registra la asistencia a UN Evento Especial puntual (independiente
// de la cátedra regular): usa categoria:'evento' + eventoId, así que
// hasEntryToday/hasExitToday lo tratan como una franja separada del
// día regular. No pasa por registrarEntradaJornada() porque esa función
// está atada a la ventana de salida de la cátedra (isExitTime), que
// no aplica a un evento con su propio horario.
// Ventana de salida contra el horario del
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

    // Misma regla que en la cátedra regular:
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

    // Solo Eventos Especiales pasan por acá: la cátedra regular se ficha
    // sola (ver ejecutarFichajeAutomatico()).
    const ok = registerFaceEventoAttendance(type, teacher, eventoInfo, geo);
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
    if (quickFichajeActivo) {
        // Fichaje rápido: se cierra solo para dejar la cámara libre al
        // próximo docente (reusa el mismo handle, así "Finalizar" lo cancela).
        clearFaceModalTimeout();
        faceModalTimeoutHandle = setTimeout(finishFaceAttendance, 4000);
        return;
    }
    resetFaceModalTimeout();
}

// "No soy yo / Cancelar": vuelve a la cámara sin guardar nada.
function cancelFaceAttendanceModal() {
    clearFaceModalTimeout();
    faceModalPending = false;
    faceDecision = null;
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
    if (quickFichajeActivo) { endQuickFichajeCycle(); setQuickWaitingStatus(); }
}

// Cierra el modal después de un registro exitoso (botón "Finalizar").
function finishFaceAttendance() {
    clearFaceModalTimeout();
    faceModalPending = false;
    faceDecision = null;
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
    if (quickFichajeActivo) { endQuickFichajeCycle(); setQuickWaitingStatus(); }
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

// ============================================================
// LICENCIAS / PERMISOS
// ============================================================
function getLicenciaForDate(teacherId, dateStr) {
    return getLicencias().find(l => l.teacherId === teacherId && dateStr >= l.from && dateStr <= l.to) || null;
}

async function addLicencia() {
    const teacherId = document.getElementById('licenciaTeacher').value;
    const from = document.getElementById('licenciaFrom').value;
    const to = document.getElementById('licenciaTo').value;
    const motivo = document.getElementById('licenciaMotivo').value.trim();
    const certInput = document.getElementById('licenciaCertificado');
    const certFile = certInput && certInput.files[0];
    if (!teacherId) { showToast('Selecciona un docente', 'warning'); return; }
    if (!from || !to) { showToast('Completa las fechas desde/hasta', 'warning'); return; }
    if (to < from) { showToast('La fecha "Hasta" no puede ser anterior a "Desde"', 'error'); return; }
    const teacher = getTeachers().find(t => t.id === teacherId);
    if (!teacher) { showToast('Docente no encontrado', 'error'); return; }
    // El certificado es opcional, pero si se eligió uno se valida ANTES
    // de registrar la licencia (formato/tamaño), para no dejarla a medias.
    if (certFile && !validarArchivoCertificado(certFile)) return;

    const licencias = getLicencias();
    const licencia = {
        id: Date.now().toString(), teacherId, teacherName: `${teacher.apellido} ${teacher.nombre}`,
        from, to, motivo: motivo || 'Sin especificar', createdAt: new Date().toISOString()
    };
    licencias.push(licencia);
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
    if (certInput) certInput.value = '';
    loadLicenciasList();
    loadAlerts();
    updateAlertCount();
    showToast('✅ Licencia registrada', 'success');

    if (certFile && await subirCertificadoLicencia(licencia, certFile)) loadLicenciasList();
}

async function deleteLicencia(id) {
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
    await borrarCertificadosDeLicencia(id);
}

function loadLicenciasList() {
    const tbody = document.getElementById('licenciasTableBody');
    if (!tbody) return;
    const licencias = getLicencias().slice().sort((a, b) => b.from.localeCompare(a.from));
    if (licencias.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">${t('licencias.none')}</td></tr>`;
        return;
    }
    const puedeCert = puedeAdjuntarCertificadoLicencia();
    tbody.innerHTML = licencias.map(l => `
        <tr>
            <td data-label="Docente">${l.teacherName}</td>
            <td data-label="Desde">${l.from}</td>
            <td data-label="Hasta">${l.to}</td>
            <td data-label="Motivo">${l.motivo}</td>
            <td data-label="Certificados">${puedeCert ? `<div id="licCert_${l.id}"><span class="text-muted small">Cargando...</span></div>` : '-'}</td>
            <td data-label="Acciones">${tienePermiso(currentUser.rol, 'borrar') ? `<button class="btn btn-sm btn-danger" title="Eliminar" onclick="deleteLicencia('${l.id}')"><i class="bi bi-trash"></i></button>` : ''}</td>
        </tr>
    `).join('');
    if (puedeCert) renderCertificadosTablaLicencias(licencias);
}

// ============================================================
// CERTIFICADOS DE LICENCIAS
// Archivos JPG/PNG/PDF adjuntos a una licencia. El archivo va al
// bucket privado "certificados-licencias" de Supabase Storage y la fila
// a licencia_certificado (ver add_certificados_licencia.sql). Las
// licencias siguen viviendo en app_data: la fila se vincula por el id
// de la licencia y del docente. Lo pueden adjuntar Secretaría (ADMIN1)
// y Rector (ADMIN2) desde la pestaña Licencias (al registrarla o
// después, desde la tabla), y el Docente desde "Mis licencias y
// certificados" en su panel, solo a sus propias licencias.
// ============================================================
const CERT_BUCKET = 'certificados-licencias';
const CERT_MAX_BYTES = 5 * 1024 * 1024;
const CERT_TIPOS = {
    'image/jpeg': ['jpg', 'jpeg'],
    'image/png': ['png'],
    'application/pdf': ['pdf'],
};
const CERT_ACCEPT = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf';
// Filas de licencia_certificado ya mostradas, para abrir/borrar por id
// sin volver a consultar.
let certificadosCache = {};

function puedeAdjuntarCertificadoLicencia() {
    return !!currentUser && tienePermiso(currentUser.rol, 'adjuntar_certificado_licencia');
}

// Los nombres de archivo los elige el usuario: se escapan antes de
// meterlos en innerHTML.
function escapeHtmlCert(texto) {
    return String(texto ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function extensionArchivo(nombre) {
    const partes = String(nombre || '').split('.');
    return partes.length > 1 ? partes.pop().toLowerCase() : '';
}

// Valida tipo (por MIME y por extensión, porque algunos navegadores
// dejan el MIME vacío) y tamaño. Devuelve el MIME normalizado o null.
function validarArchivoCertificado(file) {
    if (!file) { showToast('Elegí un archivo', 'error'); return null; }
    const ext = extensionArchivo(file.name);
    const mime = Object.keys(CERT_TIPOS).find(m => CERT_TIPOS[m].includes(ext));
    if (!mime || (file.type && file.type !== mime)) {
        showToast('Formato no permitido: solo JPG, PNG o PDF', 'error');
        return null;
    }
    if (file.size > CERT_MAX_BYTES) {
        showToast('El archivo supera los 5 MB', 'error');
        return null;
    }
    return mime;
}

// Sube el archivo a Storage y registra la fila en licencia_certificado.
async function subirCertificadoLicencia(licencia, file) {
    if (!puedeAdjuntarCertificadoLicencia()) {
        showToast(mensajeSinPermiso('adjuntar_certificado_licencia'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó adjuntar un certificado de licencia sin permiso');
        return false;
    }
    if (currentUser.rol === ROLES.DOCENTE && licencia.teacherId !== currentUser.id) {
        showToast('Solo podés adjuntar certificados a tus propias licencias', 'error');
        return false;
    }
    if (!sb) { showToast('Sin conexión a Supabase, no se puede subir el certificado', 'error'); return false; }
    const mime = validarArchivoCertificado(file);
    if (!mime) return false;

    const ruta = `licencia_${licencia.id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extensionArchivo(file.name)}`;
    const subidoPor = currentUser.rol === ROLES.DOCENTE
        ? `${currentUser.apellido} ${currentUser.nombre}`
        : (ROL_LABEL[currentUser.rol] || currentUser.rol);

    try {
        const { error: upError } = await sb.storage.from(CERT_BUCKET).upload(ruta, file, { contentType: mime, upsert: false });
        if (upError) throw upError;
        const { error } = await sb.from('licencia_certificado').insert({
            licencia_id: licencia.id,
            teacher_id: licencia.teacherId,
            nombre_archivo: file.name,
            ruta,
            tipo_mime: mime,
            tamano_bytes: file.size,
            subido_por_rol: currentUser.rol,
            subido_por: subidoPor,
        });
        if (error) {
            // Sin fila no tiene sentido dejar el archivo huérfano.
            await sb.storage.from(CERT_BUCKET).remove([ruta]);
            throw error;
        }
        logAccion('ADJUNTAR_CERTIFICADO', `Adjuntó "${file.name}" a la licencia ${licencia.id} de ${licencia.teacherName}`);
        showToast('✅ Certificado adjuntado', 'success');
        return true;
    } catch (error) {
        console.error('Error subiendo certificado de licencia:', error);
        showToast('No se pudo adjuntar el certificado (' + describeSupabaseError(error) + ')', 'error');
        return false;
    }
}

// Docente: solo borra lo que subió él mismo. Secretaría/Rector: todo.
function puedeBorrarCertificado(cert) {
    if (tienePermiso(currentUser.rol, 'borrar_certificado_licencia')) return true;
    return currentUser.rol === ROLES.DOCENTE && cert.subido_por_rol === ROLES.DOCENTE && cert.teacher_id === currentUser.id;
}

function renderListaCertificados(certs, onDeleteFn) {
    if (certs.length === 0) return '<div class="text-muted small">Sin certificados</div>';
    return `<ul class="cert-lista">${certs.map(c => {
        certificadosCache[c.id] = c;
        const icono = c.tipo_mime === 'application/pdf' ? 'bi-file-earmark-pdf' : 'bi-file-earmark-image';
        const fecha = c.created_at ? new Date(c.created_at).toLocaleDateString('es-AR') : '';
        return `
            <li class="cert-item">
                <i class="bi ${icono}"></i>
                <div class="cert-info">
                    <button type="button" class="btn btn-link p-0 cert-nombre" onclick="abrirCertificado(${c.id})">${escapeHtmlCert(c.nombre_archivo)}</button>
                    <small class="text-muted d-block">Subido por ${escapeHtmlCert(c.subido_por || c.subido_por_rol)} · ${fecha}</small>
                </div>
                ${puedeBorrarCertificado(c) ? `<button type="button" class="btn btn-sm btn-outline-danger" title="Eliminar certificado" aria-label="Eliminar certificado" onclick="${onDeleteFn}(${c.id})"><i class="bi bi-trash"></i></button>` : ''}
            </li>`;
    }).join('')}</ul>`;
}

// Botón "Adjuntar" que abre el selector de archivos y sube apenas se
// elige uno (onUploadFn recibe el id de la licencia y el <input>).
function botonAdjuntarCertificado(licenciaId, onUploadFn) {
    return `
        <label class="btn btn-sm btn-outline-primary mt-1 mb-0">
            <i class="bi bi-paperclip"></i> Adjuntar
            <input type="file" class="hidden" accept="${CERT_ACCEPT}" onchange="${onUploadFn}('${licenciaId}', this)">
        </label>`;
}

async function getCertificadosLicencias(licenciaIds) {
    if (licenciaIds.length === 0) return [];
    const { data, error } = await sb.from('licencia_certificado').select('*')
        .in('licencia_id', licenciaIds).order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
}

// Abre el archivo con una URL firmada de 5 minutos (el bucket es privado).
async function abrirCertificado(idCert) {
    const cert = certificadosCache[idCert];
    if (!cert) return;
    // Se abre la pestaña ya (sincrónico con el clic) para que el
    // bloqueador de popups no la frene, y se le asigna la URL después.
    const win = window.open('', '_blank');
    try {
        const { data, error } = await sb.storage.from(CERT_BUCKET).createSignedUrl(cert.ruta, 300);
        if (error) throw error;
        if (win) win.location.href = data.signedUrl;
        else window.location.href = data.signedUrl;
    } catch (error) {
        if (win) win.close();
        console.error('No se pudo abrir el certificado:', error);
        showToast('No se pudo abrir el certificado (' + describeSupabaseError(error) + ')', 'error');
    }
}

async function borrarCertificado(idCert) {
    const cert = certificadosCache[idCert];
    if (!cert) return false;
    if (!puedeBorrarCertificado(cert)) {
        showToast('No tenés permiso para eliminar este certificado', 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó borrar un certificado de licencia sin permiso');
        return false;
    }
    if (!confirm(`¿Eliminar el certificado "${cert.nombre_archivo}"?`)) return false;
    try {
        const { error } = await sb.from('licencia_certificado').delete().eq('id', idCert);
        if (error) throw error;
        const { error: stError } = await sb.storage.from(CERT_BUCKET).remove([cert.ruta]);
        if (stError) console.error('Se borró la fila pero no el archivo del certificado:', stError);
        delete certificadosCache[idCert];
        logAccion('BORRAR_CERTIFICADO', `Eliminó el certificado "${cert.nombre_archivo}" de la licencia ${cert.licencia_id}`);
        showToast('Certificado eliminado', 'info');
        return true;
    } catch (error) {
        console.error('Error eliminando certificado:', error);
        showToast('No se pudo eliminar el certificado (' + describeSupabaseError(error) + ')', 'error');
        return false;
    }
}

// Al borrar una licencia, sus certificados también (fila + archivo).
async function borrarCertificadosDeLicencia(licenciaId) {
    if (!sb) return;
    try {
        const certs = await getCertificadosLicencias([licenciaId]);
        if (certs.length === 0) return;
        const { error } = await sb.from('licencia_certificado').delete().eq('licencia_id', licenciaId);
        if (error) throw error;
        await sb.storage.from(CERT_BUCKET).remove(certs.map(c => c.ruta));
    } catch (error) {
        console.error('No se pudieron borrar los certificados de la licencia ' + licenciaId + ':', error);
    }
}

// ----- Admin (Secretaría / Rector): columna Certificados de la tabla -----
async function renderCertificadosTablaLicencias(licencias) {
    let certs = [];
    let fallo = null;
    if (!sb) fallo = 'sin conexión';
    else {
        try { certs = await getCertificadosLicencias(licencias.map(l => l.id)); }
        catch (error) { fallo = describeSupabaseError(error); console.error('No se pudieron cargar los certificados de licencias:', error); }
    }
    licencias.forEach(l => {
        const cell = document.getElementById(`licCert_${l.id}`);
        if (!cell) return;
        cell.innerHTML = fallo
            ? `<span class="text-danger small">No disponible (${escapeHtmlCert(fallo)})</span>`
            : renderListaCertificados(certs.filter(c => c.licencia_id === l.id), 'borrarCertificadoAdmin') + botonAdjuntarCertificado(l.id, 'subirCertificadoAdmin');
    });
}

async function subirCertificadoAdmin(licenciaId, input) {
    const licencia = getLicencias().find(l => l.id === licenciaId);
    const file = input.files[0];
    input.value = '';
    if (licencia && file && await subirCertificadoLicencia(licencia, file)) loadLicenciasList();
}

async function borrarCertificadoAdmin(idCert) {
    if (await borrarCertificado(idCert)) loadLicenciasList();
}

// ----- Docente: "Mis licencias y certificados" en su panel -----
async function loadMisLicenciasDocente() {
    const cont = document.getElementById('misLicenciasDocente');
    if (!cont || !currentUser || currentUser.rol !== ROLES.DOCENTE) return;
    const misLicencias = getLicencias().filter(l => l.teacherId === currentUser.id)
        .sort((a, b) => b.from.localeCompare(a.from));
    if (misLicencias.length === 0) { cont.innerHTML = '<p class="text-muted small mb-0">No tenés licencias registradas</p>'; return; }
    if (!sb) { cont.innerHTML = '<p class="text-muted small mb-0">Sin conexión a Supabase</p>'; return; }
    cont.innerHTML = '<p class="text-muted small mb-0">Cargando...</p>';
    try {
        const certs = await getCertificadosLicencias(misLicencias.map(l => l.id));
        cont.innerHTML = misLicencias.map(l => `
            <div class="cert-licencia">
                <div class="fw-semibold">${escapeHtmlCert(l.motivo)}</div>
                <small class="text-muted d-block mb-1">${l.from.split('-').reverse().join('/')} al ${l.to.split('-').reverse().join('/')}</small>
                ${renderListaCertificados(certs.filter(c => c.licencia_id === l.id), 'borrarCertificadoDocente')}
                ${botonAdjuntarCertificado(l.id, 'subirCertificadoDocente')}
            </div>`).join('') + '<small class="text-muted">JPG, PNG o PDF · máx. 5 MB</small>';
    } catch (error) {
        console.error('No se pudieron cargar los certificados del docente:', error);
        cont.innerHTML = `<p class="text-danger small mb-0">No se pudieron cargar tus certificados (${escapeHtmlCert(describeSupabaseError(error))})</p>`;
    }
}

async function subirCertificadoDocente(licenciaId, input) {
    const licencia = getLicencias().find(l => l.id === licenciaId);
    const file = input.files[0];
    input.value = '';
    if (licencia && file && await subirCertificadoLicencia(licencia, file)) loadMisLicenciasDocente();
}

async function borrarCertificadoDocente(idCert) {
    if (await borrarCertificado(idCert)) loadMisLicenciasDocente();
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
// Estado del evento (evento_especial.tipo_cumplimiento):
//  CON_PERJUICIO  = Obligatorio, reemplaza sus clases de ese día
//  SIN_PERJUICIO  = Obligatorio, además da sus clases
//  NO_OBLIGATORIO = No obligatorio: si no va, no es falta
function eventoEsObligatorio(ev) {
    return (ev.tipo_cumplimiento || ev.tipoCumplimiento || 'CON_PERJUICIO') !== 'NO_OBLIGATORIO';
}

// Etiquetas cortas del estado para listas/badges.
function etiquetasEstadoEvento(tipo) {
    if (tipo === 'NO_OBLIGATORIO') return `<span class="evento-tag is-optativo">${t('eventos.stateOptional')}</span>`;
    return `<span class="evento-tag is-perjuicio">${t('eventos.stateMandatory')}</span>` +
        ` <span class="evento-tag">${tipo === 'SIN_PERJUICIO' ? t('eventos.tagAlsoClasses') : t('eventos.tagReplacesClasses')}</span>`;
}

function toggleEventoObligatorio() {
    const obligatorio = document.getElementById('eventoObligatorioSi').checked;
    document.getElementById('eventoReemplazaWrap').classList.toggle('hidden', !obligatorio);
}

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

// Lista de eventos en filas: fecha destacada, título con etiquetas,
// horario/lugar/docentes y acciones. Próximos (incluye hoy) ordenados
// del más cercano al más lejano; pasados después, del más reciente al
// más viejo y atenuados.
function renderListaEventos(conteoPorEvento) {
    const hoy = getFechaHoyArgentina();
    const meses = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
    const puedeBorrar = tienePermiso(currentUser.rol, 'borrar');
    const fila = (ev) => {
        const [, mm, dd] = String(ev.fecha || '').split('-');
        const esHoy = ev.fecha === hoy;
        const esPasado = ev.fecha < hoy;
        const dia = ev.fecha ? FULL_DAYS[new Date(ev.fecha + 'T00:00:00Z').getUTCDay()] : '';
        const cant = conteoPorEvento[ev.id] || 0;
        const perjuicio = etiquetasEstadoEvento(ev.tipo_cumplimiento || 'CON_PERJUICIO');
        const geo = ev.tiene_geocerca ? `<span class="evento-tag"><i class="bi bi-geo-alt"></i> ${t('eventos.withGeofence')}</span>` : '';
        const lugar = ev.direccion_evento || ev.descripcion || '';
        return `
            <div class="evento-row ${esPasado ? 'is-pasado' : ''} ${esHoy ? 'is-hoy' : ''}">
                <div class="evento-fecha">
                    ${esHoy ? `<span class="evento-hoy">${t('eventos.today')}</span>` : ''}
                    <span class="evento-dia">${Number(dd) || '?'}</span>
                    <span class="evento-mes">${meses[Number(mm) - 1] || ''}</span>
                </div>
                <div class="evento-info">
                    <div class="evento-titulo">${ev.titulo} ${perjuicio} ${geo}</div>
                    <div class="evento-meta">
                        <span><i class="bi bi-clock"></i> ${dia} ${ev.hora_entrada}–${ev.hora_salida}</span>
                        ${lugar ? `<span><i class="bi bi-geo"></i> ${lugar}</span>` : ''}
                        <span><i class="bi bi-people"></i> ${cant > 0 ? t('eventos.teachersCount', { n: cant }) : t('eventos.noTeachers')}</span>
                    </div>
                </div>
                <div class="evento-acciones">
                    <button class="btn btn-sm evento-btn" title="Ver" aria-label="Ver" onclick="viewEvento(${ev.id})"><i class="bi bi-eye"></i></button>
                    <button class="btn btn-sm evento-btn" title="Editar" aria-label="Editar" onclick="editEvento(${ev.id})"><i class="bi bi-pencil"></i></button>
                    ${puedeBorrar ? `<button class="btn btn-sm evento-btn evento-btn-danger" title="Eliminar" aria-label="Eliminar" onclick="deleteEvento(${ev.id})"><i class="bi bi-trash"></i></button>` : ''}
                </div>
            </div>`;
    };
    const clave = (ev) => `${ev.fecha || ''} ${ev.hora_entrada || ''}`;
    const proximos = currentEventos.filter(ev => ev.fecha >= hoy).sort((a, b) => clave(a).localeCompare(clave(b)));
    const pasados = currentEventos.filter(ev => ev.fecha < hoy).sort((a, b) => clave(b).localeCompare(clave(a)));
    return `
        <div class="eventos-grupo-titulo">${t('eventos.upcoming')} <span>${proximos.length}</span></div>
        ${proximos.length ? proximos.map(fila).join('') : `<p class="text-muted small mb-3">${t('eventos.noUpcoming')}</p>`}
        ${pasados.length ? `<div class="eventos-grupo-titulo mt-3">${t('eventos.past')} <span>${pasados.length}</span></div>${pasados.map(fila).join('')}` : ''}`;
}

async function loadEventosEspeciales() {
    const tbody = document.getElementById('eventosLista');
    if (!tbody) return;
    if (!sb) { tbody.innerHTML = '<p class="text-muted">Sin conexión a Supabase</p>'; return; }
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
            tbody.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="bi bi-calendar-plus"></i></div><div class="empty-state-title">${t('eventos.none')}</div></div>`;
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

        tbody.innerHTML = renderListaEventos(conteoPorEvento);
    } catch (error) {
        console.error('Error cargando eventos especiales:', error);
        tbody.innerHTML = '<p class="text-danger">No se pudieron cargar los eventos</p>';
        showToast('No se pudieron cargar los eventos especiales (' + describeSupabaseError(error) + ')', 'error');
    }
}

function openEventoModal() {
    editingEventoId = null;
    eventoSelectedTeacherIds = [];
    document.getElementById('eventoModalTitle').innerHTML = `<i class="bi bi-calendar-event"></i> ${t('eventos.modalNewTitle')}`;
    document.getElementById('eventoTitulo').value = '';
    document.getElementById('eventoDescripcion').value = '';
    document.getElementById('eventoFecha').value = '';
    document.getElementById('eventoHoraEntrada').value = '';
    document.getElementById('eventoHoraSalida').value = '';
    document.getElementById('eventoLugar').value = '';
    document.getElementById('eventoTipoCumplimientoCon').checked = true;
    document.getElementById('eventoObligatorioSi').checked = true;
    toggleEventoObligatorio();
    document.getElementById('eventoTieneGeocerca').checked = false;
    document.getElementById('eventoTieneGeocerca').disabled = !tienePermiso(currentUser.rol, 'editar_geo_evento');
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
    document.getElementById('eventoModalTitle').innerHTML = `<i class="bi bi-pencil"></i> ${t('eventos.modalEditTitle')}`;
    document.getElementById('eventoTitulo').value = ev.titulo || '';
    document.getElementById('eventoDescripcion').value = ev.descripcion || '';
    document.getElementById('eventoFecha').value = ev.fecha || '';
    document.getElementById('eventoHoraEntrada').value = (ev.hora_entrada || '').slice(0, 5);
    document.getElementById('eventoHoraSalida').value = (ev.hora_salida || '').slice(0, 5);
    document.getElementById('eventoLugar').value = ev.direccion_evento || '';
    const esSinPerjuicio = ev.tipo_cumplimiento === 'SIN_PERJUICIO';
    document.getElementById('eventoTipoCumplimientoSin').checked = esSinPerjuicio;
    document.getElementById('eventoTipoCumplimientoCon').checked = !esSinPerjuicio;
    const esObligatorio = eventoEsObligatorio(ev);
    document.getElementById('eventoObligatorioSi').checked = esObligatorio;
    document.getElementById('eventoObligatorioNo').checked = !esObligatorio;
    toggleEventoObligatorio();
    document.getElementById('eventoTieneGeocerca').checked = !!ev.tiene_geocerca;
    document.getElementById('eventoTieneGeocerca').disabled = !tienePermiso(currentUser.rol, 'editar_geo_evento');
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
    const tipoCumplimientoTxt = !eventoEsObligatorio(ev)
        ? t('eventos.stateOptionalFull')
        : (ev.tipo_cumplimiento === 'SIN_PERJUICIO' ? t('eventos.stateAlsoFull') : t('eventos.stateReplacesFull'));
    const dia = ev.fecha ? FULL_DAYS[new Date(ev.fecha + 'T00:00:00Z').getUTCDay()] : '';
    const fechaTxt = ev.fecha ? `${dia} ${ev.fecha.split('-').reverse().join('/')}` : '-';
    const filaDet = (icono, label, valor) => `<div class="evento-detalle-fila"><i class="bi ${icono}"></i><div><div class="evento-detalle-label">${label}</div><div class="evento-detalle-valor">${valor}</div></div></div>`;
    document.getElementById('eventoViewBody').innerHTML = `
        <div class="evento-detalle">
            ${filaDet('bi-calendar3', 'Fecha', fechaTxt)}
            ${filaDet('bi-clock', 'Horario', `${(ev.hora_entrada || '').slice(0, 5)} – ${(ev.hora_salida || '').slice(0, 5)}`)}
            ${filaDet('bi-clipboard-check', t('eventos.stateQuestion'), tipoCumplimientoTxt)}
            ${filaDet('bi-geo-alt', 'Lugar / Dirección', ev.direccion_evento || '-')}
            ${filaDet('bi-bullseye', 'Geocerca', geocercaInfo)}
            ${ev.descripcion ? filaDet('bi-card-text', 'Descripción', ev.descripcion) : ''}
            <div class="evento-detalle-fila"><i class="bi bi-people"></i><div class="flex-grow-1"><div class="evento-detalle-label">Docentes convocados</div><div id="eventoViewDocentes" class="evento-detalle-docentes"><span class="text-muted">Cargando...</span></div></div></div>
        </div>
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
            ? names.map(n => `<span>${n}</span>`).join('')
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
        ? `<div class="dropdown-empty">${t('teachers.noneFound')}</div>`
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

// "No obligatorio" necesita que la base acepte NO_OBLIGATORIO en
// tipo_cumplimiento (migrate_evento_no_obligatorio.sql). Si todavía no
// se corrió, se explica en vez de mostrar el error crudo de Postgres.
function avisoSiFaltaMigracionEstadoEvento(error, tipoCumplimiento) {
    if (tipoCumplimiento === 'NO_OBLIGATORIO' && (error.code === '23514' || /tipo_cumplimiento/.test(error.message || ''))) {
        showToast(t('eventos.needsMigration'), 'error');
    }
    return error;
}

async function saveEvento() {
    const titulo = document.getElementById('eventoTitulo').value.trim();
    const descripcion = document.getElementById('eventoDescripcion').value.trim();
    const fecha = document.getElementById('eventoFecha').value;
    const horaEntrada = document.getElementById('eventoHoraEntrada').value;
    const horaSalida = document.getElementById('eventoHoraSalida').value;
    const direccionEvento = document.getElementById('eventoLugar').value.trim();
    const tipoCumplimiento = document.getElementById('eventoObligatorioNo').checked
        ? 'NO_OBLIGATORIO'
        : (document.getElementById('eventoTipoCumplimientoSin').checked ? 'SIN_PERJUICIO' : 'CON_PERJUICIO');
    const tieneGeocerca = document.getElementById('eventoTieneGeocerca').checked;

    if (tieneGeocerca && !tienePermiso(currentUser.rol, 'editar_geo_evento')) {
        showToast(mensajeSinPermiso('editar_geo_evento'), 'error');
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
            if (error) throw avisoSiFaltaMigracionEstadoEvento(error, tipoCumplimiento);
            const { error: delError } = await sb.from('evento_docente').delete().eq('evento_id', idEvento);
            if (delError) throw delError;
        } else {
            const { data, error } = await sb.from('evento_especial').insert(payload).select('id').single();
            if (error) throw avisoSiFaltaMigracionEstadoEvento(error, tipoCumplimiento);
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
// checkFaltas/decidirFichaje/registrarEntradaJornada para tardanzas,
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
        materiaSel.innerHTML = `<option value="">${t('teachers.selectEllipsis')}</option>` + opciones;
        if (actual) materiaSel.value = actual;
    }
    if (grillaSel) {
        const actual = grillaSel.value;
        grillaSel.innerHTML = `<option value="">${t('materias.selectCareer')}</option>` + opciones;
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

// true recién cuando currentMaterias refleja las materias reales (de
// Supabase o, sin conexión, de la última copia local). Mientras sea
// false, getHorarioEfectivo() NO cae al horario_laboral viejo del
// docente: antes, si el panel o checkFaltas() corrían antes de que
// terminaran de bajar las materias, se usaba ese horario viejo (datos
// de prueba, ej. sábados) y aparecían clases/faltas que no existen.
let materiasCargadas = false;
const MATERIAS_CACHE_KEY = 'sb_cache_materias';

async function loadMaterias() {
    if (!sb) { cargarMateriasDesdeCache(); return; }
    try {
        const { data, error } = await sb.from('materias').select('*').order('nombre');
        if (error) throw error;
        currentMaterias = data || [];
        const idsAsignados = [...new Set(currentMaterias.map(m => m.profesor_id).filter(Boolean))];
        materiaProfesorPorDocenteId = await getTeachersByDocenteIds(idsAsignados);
        materiasCargadas = true;
        try {
            const profesorTeacherId = {};
            Object.keys(materiaProfesorPorDocenteId).forEach(k => { profesorTeacherId[k] = materiaProfesorPorDocenteId[k].id; });
            localStorage.setItem(MATERIAS_CACHE_KEY, JSON.stringify({ materias: currentMaterias, profesorTeacherId }));
        } catch (e) { /* sin espacio/almacenamiento bloqueado: se sigue sin copia local */ }
    } catch (error) {
        console.error('No se pudieron cargar las materias:', error);
        cargarMateriasDesdeCache();
    }
}

// Sin conexión: última copia de materias + a qué docente está asignada
// cada una, para que horarios, tardanzas y faltas sigan funcionando.
function cargarMateriasDesdeCache() {
    try {
        const cache = JSON.parse(localStorage.getItem(MATERIAS_CACHE_KEY) || 'null');
        if (!cache || !Array.isArray(cache.materias)) return;
        currentMaterias = cache.materias;
        const teachers = getTeachers();
        materiaProfesorPorDocenteId = {};
        Object.keys(cache.profesorTeacherId || {}).forEach(k => {
            const teacher = teachers.find(tc => tc.id === cache.profesorTeacherId[k]);
            if (teacher) materiaProfesorPorDocenteId[k] = teacher;
        });
        materiasCargadas = true;
    } catch (e) { /* copia local corrupta: se ignora */ }
}

// Dispara la carga de carreras/materias y pinta la grilla; se llama al
// entrar a la pestaña "Materias" (ver onclick en index.html).
let grillaMateriasInicializada = false;
async function loadMateriasTab() {
    // Se pinta YA con lo que está en memoria (carreras/materias se cargan
    // al iniciar la app) y recién después se refresca desde Supabase: así
    // la pestaña no queda vacía mientras bajan los datos.
    const pintar = () => {
        populateCarrerasSelects();
        const sel = document.getElementById('grillaMateriasCarrera');
        // Primera vez: arranca con la primera carrera, 1° año y el
        // cuatrimestre en curso, en vez de una grilla vacía "Elegí una carrera".
        if (!grillaMateriasInicializada && currentCarreras.length > 0) {
            grillaMateriasInicializada = true;
            if (sel && !sel.value) sel.value = String(currentCarreras[0].id);
            grillaAnioSeleccionado = 1;
            grillaCuatSeleccionado = cuatrimestreActual();
        }
        marcarPeriodoGrillaActivo();
        renderGrillaMaterias();
    };
    pintar();
    await loadCarreras();
    await loadMaterias();
    pintar();
}

function marcarPeriodoGrillaActivo() {
    document.querySelectorAll('.grilla-anio-cuat-btn').forEach(b => {
        b.classList.toggle('active', Number(b.dataset.anio) === grillaAnioSeleccionado && Number(b.dataset.cuat) === grillaCuatSeleccionado);
    });
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
    marcarPeriodoGrillaActivo();
    renderGrillaMaterias();
}

function renderGrillaMaterias() {
    const tbody = document.getElementById('grillaMateriasTableBody');
    if (!tbody) return;
    const titulo = document.getElementById('grillaTituloPeriodo');
    if (titulo) {
        const carrera = currentCarreras.find(c => String(c.id) === document.getElementById('grillaMateriasCarrera')?.value);
        titulo.textContent = carrera
            ? t('materias.periodTitle', { anio: grillaAnioSeleccionado, cuat: grillaCuatSeleccionado })
            : '';
    }
    renderPlanillaEditor();
    const carreraId = document.getElementById('grillaMateriasCarrera')?.value;
    if (!carreraId) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">${t('materias.chooseCareer')}</td></tr>`;
        return;
    }
    // Anual = dura todo el año: aparece en los 2 cuatrimestres sin
    // importar en cuál se haya cargado, no se duplica en la base.
    const filtradas = currentMaterias.filter(m => String(m.carrera_id) === String(carreraId) && m.anio === grillaAnioSeleccionado && (esMateriaAnual(m) || m.cuatrimestre === grillaCuatSeleccionado));
    if (filtradas.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">${t('materias.noneForPeriod')}</td></tr>`;
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

// ===== Planilla semanal editable (FullCalendar) =====
// Misma carrera/año/cuatrimestre que la tabla de abajo, dibujada como
// la planilla de horarios: Lunes a Viernes, franja del instituto en
// bloques de 40 min. Se usa una semana de referencia fija (el horario
// es semanal, no de una fecha). Arrastrar = mover, estirar = cambiar
// duración, seleccionar un hueco = agregar clase, clic = editar. Todo
// cambio pasa por validarHorariosMateria() antes de guardarse; si no
// cumple, el bloque vuelve a su lugar y se explica por qué.
let planillaCalendar = null;
const PLANILLA_LUNES_REF = '2026-01-05'; // un lunes cualquiera: solo importa el día de la semana
const PLANILLA_DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

function planillaFechaDeDia(dia) {
    const idx = PLANILLA_DIAS.findIndex(d => normalizarBusqueda(d) === normalizarBusqueda(dia));
    if (idx < 0) return null;
    const d = new Date(PLANILLA_LUNES_REF + 'T00:00:00');
    d.setDate(d.getDate() + idx);
    return aFechaLocalISO(d);
}

const hhmmDe = (date) => `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;

function materiasDePlanilla() {
    const carreraId = document.getElementById('grillaMateriasCarrera')?.value;
    if (!carreraId) return [];
    return currentMaterias.filter(m => String(m.carrera_id) === String(carreraId) && m.anio === grillaAnioSeleccionado &&
        (esMateriaAnual(m) || m.cuatrimestre === grillaCuatSeleccionado));
}

function eventosPlanilla(info, success) {
    const eventos = [];
    materiasDePlanilla().forEach(m => {
        const prof = m.profesor_id ? materiaProfesorPorDocenteId[m.profesor_id] : null;
        materiaHorarios(m).forEach((h, idx) => {
            const fecha = planillaFechaDeDia(h.dia);
            if (!fecha) return;
            eventos.push({
                id: `${m.id}-${idx}`,
                title: m.nombre,
                start: `${fecha}T${h.inicio}`,
                end: `${fecha}T${h.fin}`,
                classNames: [prof ? 'planilla-con-docente' : 'planilla-sin-docente', esMateriaAnual(m) ? 'planilla-anual' : ''],
                extendedProps: { materiaId: m.id, idx, profesor: prof ? `${prof.apellido} ${prof.nombre}` : t('calendar.noTeacher'), anual: esMateriaAnual(m) },
            });
        });
    });
    success(eventos);
}

async function guardarHorariosMateriaDesdePlanilla(materia, horariosNuevos) {
    const { error } = await sb.from('materias').update({ horarios: horariosNuevos, dias: horariosNuevos.map(h => h.dia) }).eq('id', materia.id);
    if (error) throw error;
    logAccion('EDITAR_MATERIA', `Cambió el horario de "${materia.nombre}" desde la planilla: ${horariosNuevos.map(h => `${h.dia} ${h.inicio}-${h.fin}`).join(', ')}`);
    await loadMaterias();
    renderGrillaMaterias();
    renderMateriasDocenteChecklist(editingTeacherId);
}

// Mover o estirar un bloque existente.
async function onCambioBloquePlanilla(info) {
    const { materiaId, idx } = info.event.extendedProps;
    const materia = currentMaterias.find(m => m.id === materiaId);
    if (!materia || !tienePermiso(currentUser.rol, 'editar_docente')) { info.revert(); return; }
    const horarios = materiaHorarios(materia).map(h => ({ ...h }));
    const inicio = hhmmDe(info.event.start), fin = hhmmDe(info.event.end);
    horarios[idx] = { dia: FULL_DAYS[info.event.start.getDay()], inicio, fin, turno: getTurnoPorHora(inicio) };
    const problema = validarHorariosMateria(materia, horarios, materia.id);
    if (problema) { info.revert(); showToast('⚠️ ' + problema, 'error'); return; }
    if (!confirmarFueraDeFranja([horarios[idx]])) { info.revert(); return; }
    try {
        await guardarHorariosMateriaDesdePlanilla(materia, horarios);
        showToast(`✅ ${materia.nombre}: ${horarios[idx].dia} ${inicio}–${fin}`, 'success');
    } catch (e) {
        info.revert();
        console.error(e);
        showToast('No se pudo guardar el cambio (' + describeSupabaseError(e) + ')', 'error');
    }
}

// Selección de un hueco vacío: agregar ese bloque a una materia del
// curso que todavía no tiene clase ese día, o crear una materia nueva
// con el día/horario ya completados.
let planillaSeleccion = null;
function onSeleccionPlanilla(info) {
    planillaCalendar.unselect();
    if (!tienePermiso(currentUser.rol, 'agregar_docente')) { showToast(mensajeSinPermiso('agregar_docente'), 'error'); return; }
    const dia = FULL_DAYS[info.start.getDay()];
    planillaSeleccion = { dia, inicio: hhmmDe(info.start), fin: hhmmDe(info.end) };
    const candidatas = materiasDePlanilla().filter(m => !materiaHorarios(m).some(h => normalizarBusqueda(h.dia) === normalizarBusqueda(dia)));
    document.getElementById('planillaAgregarTitulo').textContent = `${dia} ${planillaSeleccion.inicio}–${planillaSeleccion.fin}`;
    const sel = document.getElementById('planillaAgregarMateria');
    sel.innerHTML = candidatas.length
        ? candidatas.map(m => `<option value="${m.id}">${m.nombre}${esMateriaAnual(m) ? ' (anual)' : ''}</option>`).join('')
        : `<option value="">${t('materias.plannerNoCandidates')}</option>`;
    document.getElementById('planillaAgregarExistenteBtn').disabled = candidatas.length === 0;
    bootstrap.Modal.getOrCreateInstance(document.getElementById('planillaAgregarModal')).show();
}

async function planillaAgregarAExistente() {
    const materia = currentMaterias.find(m => String(m.id) === document.getElementById('planillaAgregarMateria').value);
    if (!materia || !planillaSeleccion) return;
    const { dia, inicio, fin } = planillaSeleccion;
    const horarios = [...materiaHorarios(materia).map(h => ({ ...h })), { dia, inicio, fin, turno: getTurnoPorHora(inicio) }];
    const problema = validarHorariosMateria(materia, horarios, materia.id);
    if (problema) { showToast('⚠️ ' + problema, 'error'); return; }
    if (!confirmarFueraDeFranja([horarios[horarios.length - 1]])) return;
    try {
        await guardarHorariosMateriaDesdePlanilla(materia, horarios);
        bootstrap.Modal.getInstance(document.getElementById('planillaAgregarModal'))?.hide();
        showToast(`✅ ${materia.nombre}: se agregó ${dia} ${inicio}–${fin}`, 'success');
    } catch (e) {
        console.error(e);
        showToast('No se pudo guardar (' + describeSupabaseError(e) + ')', 'error');
    }
}

function planillaCrearMateriaNueva() {
    if (!planillaSeleccion) return;
    const { dia, inicio, fin } = planillaSeleccion;
    const modalEl = document.getElementById('planillaAgregarModal');
    modalEl.addEventListener('hidden.bs.modal', () => {
        openMateriaModal(null);
        document.getElementById('materiaCarrera').value = document.getElementById('grillaMateriasCarrera').value;
        document.getElementById('materiaAnio').value = grillaAnioSeleccionado;
        document.getElementById('materiaCuatrimestre').value = grillaCuatSeleccionado;
        document.getElementById('materiaTipo').value = 'CUATRIMESTRAL';
        const diaSinTilde = diaMateriaSinTilde(dia);
        const chk = document.getElementById('materiaDia' + diaSinTilde);
        if (chk) chk.checked = true;
        toggleMateriaHorarioDia(diaSinTilde, true, inicio, fin);
    }, { once: true });
    bootstrap.Modal.getInstance(modalEl)?.hide();
}

function renderAvisoChoquesMaterias() {
    const el = document.getElementById('grillaMateriasConflictos');
    if (!el) return;
    const problemas = auditarChoquesMaterias();
    el.innerHTML = problemas.length === 0 ? '' : `
        <div class="alert alert-warning py-2 px-3 small mb-3">
            <strong><i class="bi bi-exclamation-triangle-fill"></i> ${t('materias.conflictsTitle', { n: problemas.length })}</strong>
            <ul class="mb-0 mt-1 ps-3">${problemas.map(p => `<li>${p}</li>`).join('')}</ul>
        </div>`;
}

async function renderPlanillaEditor() {
    const cont = document.getElementById('grillaMateriasCalendar');
    if (!cont) return;
    renderAvisoChoquesMaterias();
    if (!document.getElementById('grillaMateriasCarrera')?.value) {
        if (planillaCalendar) { planillaCalendar.destroy(); planillaCalendar = null; }
        cont.innerHTML = '';
        return;
    }
    if (!(await asegurarFullCalendar())) return;
    const rango = rangoGrillaHorarios(materiasDePlanilla());
    if (planillaCalendar) {
        planillaCalendar.setOption('slotMinTime', rango.slotMinTime);
        planillaCalendar.setOption('slotMaxTime', rango.slotMaxTime);
        planillaCalendar.setOption('hiddenDays', rango.hiddenDays);
        planillaCalendar.refetchEvents();
        planillaCalendar.updateSize();
        return;
    }
    const puedeEditar = tienePermiso(currentUser.rol, 'editar_docente');
    planillaCalendar = new FullCalendar.Calendar(cont, {
        locale: 'es',
        firstDay: 1,
        initialView: 'timeGridWeek',
        initialDate: PLANILLA_LUNES_REF,
        headerToolbar: false,
        hiddenDays: rango.hiddenDays,
        dayHeaderFormat: { weekday: window.matchMedia('(max-width: 767px)').matches ? 'short' : 'long' },
        slotMinTime: rango.slotMinTime,
        slotMaxTime: rango.slotMaxTime,
        slotDuration: '00:40:00',
        snapDuration: '00:40:00',
        slotLabelInterval: '00:40:00',
        slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
        eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
        allDaySlot: false,
        expandRows: true,
        height: 'auto',
        nowIndicator: false,
        editable: puedeEditar,
        selectable: puedeEditar,
        selectMirror: true,
        eventOverlap: false,
        selectOverlap: false,
        slotEventOverlap: false,
        events: eventosPlanilla,
        eventContent: (arg) => ({
            html: `<div class="planilla-evento"><div class="planilla-evento-hora">${arg.timeText}</div><div class="planilla-evento-nombre">${arg.event.title}${arg.event.extendedProps.anual ? ' <span class="planilla-anual-tag">ANUAL</span>' : ''}</div><div class="planilla-evento-prof">${arg.event.extendedProps.profesor}</div></div>`,
        }),
        eventDrop: onCambioBloquePlanilla,
        eventResize: onCambioBloquePlanilla,
        select: onSeleccionPlanilla,
        eventClick: (arg) => openMateriaModal(arg.event.extendedProps.materiaId),
    });
    planillaCalendar.render();
}

// La pestaña Materias arranca oculta: al mostrarse, FullCalendar se re-mide.
document.addEventListener('DOMContentLoaded', () => {
    const tabBtn = document.querySelector('[data-bs-target="#tabMaterias"]');
    if (tabBtn) tabBtn.addEventListener('shown.bs.tab', () => { if (planillaCalendar) planillaCalendar.updateSize(); else renderPlanillaEditor(); });
});

function populateMateriaProfesorSelect(selectedTeacherId) {
    const sel = document.getElementById('materiaProfesor');
    if (!sel) return;
    const teachers = getTeachers().slice().sort((a, b) => a.apellido.localeCompare(b.apellido));
    sel.innerHTML = `<option value="">${t('materias.unassigned')}</option>` + teachers.map(t => `<option value="${t.id}">${t.apellido} ${t.nombre}</option>`).join('');
    sel.value = selectedTeacherId || '';
}

// Turno (Mañana/Tarde/Noche, ver TURNOS/getTurnoPorHora() en
// presencia-logic.js) de cada día cargado en el form de Materia: se
// autocalcula en vivo a partir de la hora de INICIO (oninput de los
// campos de hora, ver toggleMateriaHorarioDia() debajo) y se muestra
// como badge de color junto al horario, para que quede claro de un
// vistazo en qué franja cae la clase ANTES de guardar. El campo real
// que se persiste sale de acá mismo al armar `horarios` en
// saveMateria() (turno: getTurnoPorHora(inicio) por cada bloque).
const TURNO_I18N_KEY = { MANANA: 'turnos.manana', TARDE: 'turnos.tarde', NOCHE: 'turnos.noche' };
const TURNO_BADGE_CLASS = { MANANA: 'turno-badge-manana', TARDE: 'turno-badge-tarde', NOCHE: 'turno-badge-noche' };
function actualizarTurnoMateriaBadge(diaSinTilde) {
    const badge = document.getElementById('materiaHorarioTurno_' + diaSinTilde);
    if (!badge) return;
    const inicio = document.getElementById('materiaHorarioInicio_' + diaSinTilde)?.value;
    const turno = inicio ? getTurnoPorHora(inicio) : null;
    if (!turno) { badge.className = 'turno-badge hidden'; badge.textContent = ''; return; }
    badge.className = 'turno-badge ' + TURNO_BADGE_CLASS[turno];
    badge.innerHTML = `<i class="bi bi-clock-history"></i> ${t(TURNO_I18N_KEY[turno])}`;
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
            <input type="time" class="form-control form-control-sm" id="materiaHorarioInicio_${diaSinTilde}" value="${inicioPrefill || ''}" oninput="actualizarTurnoMateriaBadge('${diaSinTilde}')">
        </div>
        <div class="col-4">
            <label class="form-label small mb-1 text-muted">Fin</label>
            <input type="time" class="form-control form-control-sm" id="materiaHorarioFin_${diaSinTilde}" value="${finPrefill || ''}">
        </div>
        <div class="col-12"><span class="turno-badge hidden" id="materiaHorarioTurno_${diaSinTilde}"></span></div>`;
    cont.appendChild(fila);
    actualizarTurnoMateriaBadge(diaSinTilde);
}

function openMateriaModal(id) {
    const accionPermiso = id ? 'editar_docente' : 'agregar_docente';
    if (!tienePermiso(currentUser.rol, accionPermiso)) {
        showToast(mensajeSinPermiso(accionPermiso), 'error');
        return;
    }
    editingMateriaId = id || null;
    document.getElementById('materiaModalTitle').innerHTML = id
        ? `<i class="bi bi-pencil"></i> ${t('materias.modalEditTitle')}`
        : `<i class="bi bi-journal-bookmark"></i> ${t('materias.modalNewTitle')}`;
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
                if (horariosSeSuperponen(hExistente, hNuevo)) {
                    return { materia: otra, horario: hExistente };
                }
            }
        }
    }
    return null;
}

// Dos materias del MISMO curso (misma carrera y año) no pueden
// superponerse en horario: los alumnos no pueden estar en dos aulas a
// la vez. Solo chocan si comparten cuatrimestre - una ANUAL comparte
// los dos; una cuatrimestral de 1° no choca con una de 2°.
function materiasCompartenCuatrimestre(a, b) {
    if (a.tipo === 'ANUAL' || b.tipo === 'ANUAL') return true;
    return Number(a.cuatrimestre) === Number(b.cuatrimestre);
}

function horariosSeSuperponen(h1, h2) {
    return normalizarBusqueda(h1.dia) === normalizarBusqueda(h2.dia) && h1.inicio < h2.fin && h1.fin > h2.inicio;
}

function buscarChoqueHorarioCurso(materiaNueva, horariosNuevos, materiaIdExcluir) {
    const otras = currentMaterias.filter(m => m.id !== materiaIdExcluir &&
        String(m.carrera_id) === String(materiaNueva.carrera_id) && Number(m.anio) === Number(materiaNueva.anio) &&
        materiasCompartenCuatrimestre(m, materiaNueva));
    for (const otra of otras) {
        for (const hExistente of materiaHorarios(otra)) {
            for (const hNuevo of horariosNuevos) {
                if (horariosSeSuperponen(hExistente, hNuevo)) return { materia: otra, horario: hExistente };
            }
        }
    }
    return null;
}

// Franja horaria HABITUAL del instituto (turno noche). No es un límite
// duro: al cargar una materia se puede salir de ella (se pide
// confirmación), y la grilla (planilla y calendario) se estira sola
// para mostrar cualquier clase cargada fuera de la franja.
const FRANJA_INSTITUTO = { inicio: '18:00', fin: '22:40', bloqueMin: 40 };

function estaFueraDeFranja(h) {
    return h.inicio < FRANJA_INSTITUTO.inicio || h.fin > FRANJA_INSTITUTO.fin;
}

// Rango visible de la grilla semanal: la franja del instituto, ampliada
// si hay clases cargadas antes/después, y Sábado/Domingo solo si hay
// alguna clase esos días.
// ajustado = true: la grilla arranca en la primera clase y termina en
// la última de las materias recibidas (sin filas vacías); si no hay
// ninguna, cae a la franja del instituto.
function rangoGrillaHorarios(materias, ajustado) {
    let ini = FRANJA_INSTITUTO.inicio, fin = FRANJA_INSTITUTO.fin;
    const lista = materias || currentMaterias;
    if (ajustado) {
        const bloques = lista.flatMap(m => materiaHorarios(m)).filter(h => h.inicio && h.fin);
        if (bloques.length > 0) {
            ini = bloques.reduce((a, h) => (h.inicio < a ? h.inicio : a), '99:99');
            fin = bloques.reduce((a, h) => (h.fin > a ? h.fin : a), '00:00');
        }
    }
    let sab = false, dom = false;
    lista.forEach(m => materiaHorarios(m).forEach(h => {
        if (h.inicio && h.inicio < ini) ini = h.inicio;
        if (h.fin && h.fin > fin) fin = h.fin;
        const d = normalizarBusqueda(h.dia);
        if (d === 'sabado') sab = true;
        if (d === 'domingo') dom = true;
    }));
    const hidden = [];
    if (!dom) hidden.push(0);
    if (!sab) hidden.push(6);
    // Fuera de la franja se redondea a la hora en punto (12:17 -> 12:00),
    // para que las filas de la grilla no arranquen en un minuto raro.
    if (!ajustado && ini < FRANJA_INSTITUTO.inicio) ini = ini.slice(0, 2) + ':00';
    if (!ajustado && fin > FRANJA_INSTITUTO.fin && fin.slice(3) !== '00') fin = String(Math.min(24, Number(fin.slice(0, 2)) + 1)).padStart(2, '0') + ':00';
    return { slotMinTime: ini + ':00', slotMaxTime: fin + ':00', hiddenDays: hidden };
}

// Reglas de un horario de materia, en un solo lugar (formulario de
// Materia y planilla editable usan esta misma función): sin
// superponerse con otra materia del mismo curso y sin que el profesor
// asignado quede en dos clases a la vez. Devuelve el texto del
// problema, o null si está todo bien. (Salir de la franja habitual no
// es un error: lo confirma quien carga, ver confirmarFueraDeFranja().)
function validarHorariosMateria(materia, horarios, materiaIdExcluir) {
    const dias = new Set();
    for (const h of horarios) {
        if (!h.inicio || !h.fin || h.fin <= h.inicio) return `En ${h.dia}, la hora de fin debe ser posterior a la de inicio.`;
        const d = normalizarBusqueda(h.dia);
        if (dias.has(d)) return `La materia ya tiene clase el ${h.dia}: un solo bloque por día.`;
        dias.add(d);
    }
    const choqueCurso = buscarChoqueHorarioCurso(materia, horarios, materiaIdExcluir);
    if (choqueCurso) {
        return `Se superpone con "${choqueCurso.materia.nombre}" (${choqueCurso.materia.anio}° año) el ${choqueCurso.horario.dia} de ${choqueCurso.horario.inicio} a ${choqueCurso.horario.fin}. Un mismo curso no puede tener dos materias a la vez.`;
    }
    if (materia.profesor_id) {
        const choqueProf = buscarChoqueHorarioProfesor(materia.profesor_id, horarios, materiaIdExcluir);
        if (choqueProf) {
            return `El profesor ya tiene "${choqueProf.materia.nombre}" (${choqueProf.materia.anio}° año) el ${choqueProf.horario.dia} de ${choqueProf.horario.inicio} a ${choqueProf.horario.fin}.`;
        }
    }
    return null;
}

// Pide confirmación si algún bloque cae fuera de la franja habitual.
function confirmarFueraDeFranja(horarios) {
    const fuera = horarios.filter(estaFueraDeFranja);
    if (fuera.length === 0) return true;
    return confirm(`${fuera.map(h => `${h.dia} ${h.inicio}–${h.fin}`).join(', ')} queda fuera del horario habitual del instituto (${FRANJA_INSTITUTO.inicio} a ${FRANJA_INSTITUTO.fin}). ¿Guardar igual?`);
}

// Revisión de TODO lo cargado: choques de profesor y de curso. Se
// muestra como aviso arriba de la planilla para que lo que ya estaba
// mal cargado no quede escondido.
function auditarChoquesMaterias() {
    const problemas = [];
    const ms = currentMaterias;
    for (let i = 0; i < ms.length; i++) {
        for (let j = i + 1; j < ms.length; j++) {
            const a = ms[i], b = ms[j];
            const h = materiaHorarios(a).find(x => materiaHorarios(b).some(y => horariosSeSuperponen(x, y)));
            if (!h) continue;
            if (a.profesor_id && a.profesor_id === b.profesor_id) {
                const prof = materiaProfesorPorDocenteId[a.profesor_id];
                problemas.push(`Profesor ${prof ? prof.apellido + ' ' + prof.nombre : ''}: "${a.nombre}" (${a.anio}°) y "${b.nombre}" (${b.anio}°) a la vez el ${h.dia}.`);
            }
            if (String(a.carrera_id) === String(b.carrera_id) && Number(a.anio) === Number(b.anio) && materiasCompartenCuatrimestre(a, b)) {
                problemas.push(`${a.anio}° año: "${a.nombre}" y "${b.nombre}" se superponen el ${h.dia}.`);
            }
        }
    }
    return problemas;
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
    // `turno` (Mañana/Tarde/Noche, ver getTurnoPorHora() en
    // presencia-logic.js) se recalcula acá mismo a partir del inicio
    // real en vez de leer el badge ya pintado en pantalla - así queda
    // siempre correcto aunque el badge no se haya alcanzado a repintar.
    const horarios = [];
    for (const diaSinTilde of diasTildados) {
        const label = diaMateriaLabel(diaSinTilde);
        const inicio = document.getElementById('materiaHorarioInicio_' + diaSinTilde)?.value;
        const fin = document.getElementById('materiaHorarioFin_' + diaSinTilde)?.value;
        if (!inicio || !fin) { showToast(`Completá el horario de ${label}`, 'error'); return; }
        if (fin <= inicio) { showToast(`En ${label}, la hora de fin debe ser posterior a la de inicio`, 'error'); return; }
        horarios.push({ dia: label, inicio, fin, turno: getTurnoPorHora(inicio) });
    }

    let profesorId = null;
    const teacherIdSeleccionado = document.getElementById('materiaProfesor').value;
    if (teacherIdSeleccionado) {
        const teacher = getTeachers().find(t => t.id === teacherIdSeleccionado);
        if (teacher) profesorId = await syncTeacherToDocenteTable(teacher);
    }

    const problema = validarHorariosMateria({ carrera_id: carreraId, anio, cuatrimestre, tipo, profesor_id: profesorId }, horarios, editingMateriaId);
    if (problema) { showToast('⚠️ ' + problema, 'error'); return; }
    if (!confirmarFueraDeFranja(horarios)) return;

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

// Migración one-shot: agrega `turno` (Mañana/Tarde/Noche) a cada
// bloque de `horarios` de las materias que ya estaban cargadas ANTES
// de este cambio (saveMateria() ya lo calcula solo para materias
// nuevas/editadas desde ahora). Recalcula con la misma
// getTurnoPorHora() a partir del `inicio` real de cada bloque -
// también arma `horarios` desde cero para materias viejísimas que
// todavía no lo tenían poblado (ver materiaHorarios()). Segura de
// correr más de una vez: una materia con todos sus bloques ya
// migrados no se vuelve a tocar.
async function migrarTurnosMaterias() {
    if (!tienePermiso(currentUser.rol, 'backup_restore')) {
        showToast(mensajeSinPermiso('backup_restore'), 'error');
        logAccion('PERMISO_DENEGADO', 'Intentó migrar el turno de las materias sin permiso');
        return;
    }
    await loadMaterias();
    const pendientes = currentMaterias.filter(m => materiaHorarios(m).some(h => !h.turno));
    if (pendientes.length === 0) {
        showToast('Todas las materias ya tienen el turno calculado. No hay nada para migrar.', 'info');
        return;
    }
    if (!confirm(`Se va a calcular el turno (Mañana/Tarde/Noche) de ${pendientes.length} materia(s) que todavía no lo tienen. ¿Continuar?`)) return;

    let migradas = 0, fallidas = 0;
    for (const m of pendientes) {
        const horariosConTurno = materiaHorarios(m).map(h => ({ ...h, turno: h.turno || getTurnoPorHora(h.inicio) }));
        try {
            const { error } = await sb.from('materias').update({ horarios: horariosConTurno, dias: horariosConTurno.map(h => h.dia) }).eq('id', m.id);
            if (error) throw error;
            migradas++;
        } catch (error) {
            console.error(`No se pudo migrar el turno de la materia ${m.id} (${m.nombre}):`, error);
            fallidas++;
        }
    }
    logAccion('MIGRAR_TURNOS_MATERIAS', `Calculó el turno de ${migradas} materia(s)${fallidas ? ` (${fallidas} fallaron)` : ''}`);
    await loadMaterias();
    renderGrillaMaterias();
    showToast(`✅ Turno calculado en ${migradas} materia(s)${fallidas ? ` (${fallidas} fallaron, ver consola)` : ''}`, fallidas ? 'error' : 'success');
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
        // Puede ser que todavía no haya ninguna materia cargada en el
        // sistema, o que la carga inicial (loadCarreras/loadMaterias en
        // DOMContentLoaded) haya fallado o no haya terminado todavía -
        // se reintenta una vez en segundo plano y se re-pinta solo si
        // trae algo, para no dejar el combo "Carrera" vacío para
        // siempre por una falla de carga transitoria.
        if (!renderMateriasDocenteChecklist._reintentando) {
            renderMateriasDocenteChecklist._reintentando = true;
            Promise.all([loadCarreras(), loadMaterias()]).then(() => {
                renderMateriasDocenteChecklist._reintentando = false;
                // Re-pinta con el docente que esté abierto EN ESE MOMENTO
                // (materiasSeleccionDocenteIdActual), no con el `teacherId`
                // de cuando arrancó el reintento: si el admin cambió de
                // docente mientras esto cargaba, usar el `teacherId`
                // cerrado acá pisaría la selección del docente que está
                // viendo ahora con la del que tenía abierto antes.
                if (currentMaterias.length > 0) renderMateriasDocenteChecklist(materiasSeleccionDocenteIdActual);
            });
        }
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
    renderCalendarioDocente();
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
    sel.innerHTML = `<option value="">${t('teachers.selectEllipsis')}</option>` +
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
        sel.innerHTML = `<option value="">${t('teachers.selectCareerFirst')}</option>`;
        sel.disabled = true;
        return;
    }
    const anios = [...new Set(currentMaterias.filter(m => String(m.carrera_id) === String(materiaAsignarCarreraFiltro)).map(m => m.anio))].sort((a, b) => a - b);
    sel.disabled = false;
    sel.innerHTML = `<option value="">${t('teachers.allYears')}</option>` +
        anios.map(a => `<option value="${a}" ${String(a) === String(materiaAsignarAnioFiltro) ? 'selected' : ''}>${a}° Año</option>`).join('');
}

function onCambioAnioAsignar(anio) {
    materiaAsignarAnioFiltro = anio;
    renderMateriasDocenteFiltrado();
}

function renderMateriasDocenteFiltrado() {
    const cont = document.getElementById('materiasDocenteChecklist');
    if (!cont) return;
    // Alcanza con la carrera: se listan todas sus materias agrupadas por
    // año, cada una con su horario, y el año queda como filtro opcional.
    if (!materiaAsignarCarreraFiltro) {
        cont.innerHTML = `<span class="text-muted small">${t('teachers.selectCareerHint')}</span>`;
        return;
    }
    const filtradas = currentMaterias
        .filter(m => String(m.carrera_id) === String(materiaAsignarCarreraFiltro) &&
            (!materiaAsignarAnioFiltro || m.anio === Number(materiaAsignarAnioFiltro)))
        .sort((a, b) => (a.anio - b.anio) || a.nombre.localeCompare(b.nombre));
    if (filtradas.length === 0) {
        cont.innerHTML = '<span class="text-muted small">No hay materias cargadas para ese año de esa carrera.</span>';
        return;
    }
    const porAnio = {};
    filtradas.forEach(m => { (porAnio[m.anio] = porAnio[m.anio] || []).push(m); });
    cont.innerHTML = Object.keys(porAnio).sort((a, b) => a - b).map(anio => `
        <div class="materias-asignar-anio">${anio}° ${t('teachers.yearWord')}</div>
        ${porAnio[anio].slice().sort((a, b) => Number(materiaAsignadaAOtroDocente(a)) - Number(materiaAsignadaAOtroDocente(b))).map(m => {
            const seleccionada = materiasSeleccionadasDocenteIds.has(m.id);
            const profesorActual = m.profesor_id ? materiaProfesorPorDocenteId[m.profesor_id] : null;
            // Asignada a otro docente: sin casilla, en gris y al final del año.
            const asignadoAOtro = materiaAsignadaAOtroDocente(m);
            const etiquetaOtro = asignadoAOtro ? `<span class="materia-asignar-otro"><i class="bi bi-lock-fill"></i> ${t('teachers.assignedToOther', { name: `${profesorActual.apellido} ${profesorActual.nombre}` })}</span>` : '';
            const horarios = materiaHorarios(m).map(h => `<span class="materia-horario-chip">${diasCorto([h.dia])} ${h.inicio}–${h.fin}</span>`).join('');
            return `
            <label class="materia-asignar-item ${seleccionada ? 'is-selected' : ''} ${asignadoAOtro ? 'is-ocupada' : ''}" ${asignadoAOtro ? '' : `for="materiaChk_${m.id}"`}>
                ${asignadoAOtro
                    ? '<span class="materia-asignar-lock"><i class="bi bi-lock"></i></span>'
                    : `<input class="form-check-input" type="checkbox" id="materiaChk_${m.id}" onchange="toggleMateriaSeleccionadaDocente(${m.id}, this.checked)" ${seleccionada ? 'checked' : ''}>`}
                <span class="materia-asignar-info">
                    <span class="materia-asignar-nombre">${m.nombre} ${etiquetaOtro}</span>
                    <span class="materia-asignar-horarios">${horarios || `<span class="text-muted small">${t('teachers.noScheduleLoaded')}</span>`}</span>
                </span>
            </label>`;
        }).join('')}`).join('');
}

// ¿La materia ya tiene OTRO profesor (distinto del docente que se está
// dando de alta/editando)? Esas se muestran en el formulario solo como
// referencia, sin casilla: una materia tiene un único profesor y no se
// le puede quitar a otro docente desde acá (se reasigna en Materias).
function materiaAsignadaAOtroDocente(m) {
    const profesorActual = m.profesor_id ? materiaProfesorPorDocenteId[m.profesor_id] : null;
    return !!profesorActual && profesorActual.id !== materiasSeleccionDocenteIdActual;
}

function toggleMateriaSeleccionadaDocente(materiaId, checked) {
    const materia = currentMaterias.find(m => m.id === materiaId);
    if (checked && materia && materiaAsignadaAOtroDocente(materia)) {
        const chk = document.getElementById(`materiaChk_${materiaId}`);
        if (chk) chk.checked = false;
        return;
    }
    if (checked) materiasSeleccionadasDocenteIds.add(materiaId);
    else materiasSeleccionadasDocenteIds.delete(materiaId);
    renderMateriasDocenteChips();
    const chk = document.getElementById(`materiaChk_${materiaId}`);
    if (chk) chk.closest('.materia-asignar-item')?.classList.toggle('is-selected', checked);
    document.getElementById('materiaAsignarCarrera')?.classList.remove('is-invalid');
}

// Calendario semanal del docente según las materias tildadas: una
// columna por día (Lun-Vie siempre, Sáb/Dom solo si hay clases) con
// los bloques de cada materia. Es exactamente el horario contra el que
// se controla la asistencia (ver getHorarioEfectivo()), así el admin
// lo ve antes de guardar. Marca en rojo los bloques que se superponen.
const DIAS_CALENDARIO = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
function renderCalendarioDocente() {
    const cont = document.getElementById('materiasDocenteCalendario');
    if (!cont) return;
    const seleccionadas = currentMaterias.filter(m => materiasSeleccionadasDocenteIds.has(m.id));
    if (seleccionadas.length === 0) { cont.innerHTML = ''; return; }
    const aMin = (hhmm) => { const [h, mi] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + mi; };
    const bloquesPorDia = {};
    DIAS_CALENDARIO.forEach(d => { bloquesPorDia[d] = []; });
    seleccionadas.forEach(m => materiaHorarios(m).forEach(h => {
        const dia = DIAS_CALENDARIO.find(d => normalizarBusqueda(d) === normalizarBusqueda(h.dia));
        if (dia) bloquesPorDia[dia].push({ nombre: m.nombre, inicio: h.inicio, fin: h.fin, ini: aMin(h.inicio), end: aMin(h.fin) });
    }));
    let minutosSemana = 0;
    let haySuperposicion = false;
    Object.values(bloquesPorDia).forEach(bloques => {
        bloques.sort((a, b) => a.ini - b.ini);
        bloques.forEach((b, i) => {
            minutosSemana += Math.max(0, b.end - b.ini);
            const sig = bloques[i + 1];
            if (sig && sig.ini < b.end) { b.choca = true; sig.choca = true; haySuperposicion = true; }
        });
    });
    const dias = DIAS_CALENDARIO.filter((d, i) => i < 5 || bloquesPorDia[d].length > 0);
    const horas = Math.floor(minutosSemana / 60), mins = minutosSemana % 60;
    cont.innerHTML = `
        <div class="calendario-docente">
            ${dias.map(d => `
            <div class="calendario-dia ${bloquesPorDia[d].length ? '' : 'is-libre'}">
                <div class="calendario-dia-nombre">${d}</div>
                ${bloquesPorDia[d].length ? bloquesPorDia[d].map(b => `
                    <div class="calendario-bloque ${b.choca ? 'is-conflicto' : ''}">
                        <span class="calendario-bloque-hora">${b.inicio}–${b.fin}</span>
                        <span class="calendario-bloque-materia">${b.nombre}</span>
                    </div>`).join('') : `<div class="calendario-libre">${t('teachers.noClasses')}</div>`}
            </div>`).join('')}
        </div>
        <div class="calendario-resumen">
            <i class="bi bi-clock"></i> ${t('teachers.weeklyTotal', { h: horas, m: String(mins).padStart(2, '0') })}
            ${haySuperposicion ? `<span class="calendario-aviso"><i class="bi bi-exclamation-triangle-fill"></i> ${t('teachers.scheduleOverlap')}</span>` : ''}
        </div>`;
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
    // Nunca se le quita una materia a otro docente desde este formulario
    // (la UI ya no deja tildarlas; esto cubre selecciones viejas o datos
    // que cambiaron mientras el formulario estaba abierto).
    const ocupadas = currentMaterias.filter(m => tildadas.has(m.id) && m.profesor_id && m.profesor_id !== docenteId && materiaProfesorPorDocenteId[m.profesor_id]);
    if (ocupadas.length > 0) {
        showToast(`⚠️ No se asignó ${ocupadas.map(m => `"${m.nombre}"`).join(', ')}: ya tiene otro profesor. Reasignala desde la pestaña Materias.`, 'warning');
    }
    const cambios = currentMaterias.filter(m => {
        if (ocupadas.includes(m)) return false;
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
            if (!eventoEsObligatorio(ev)) return; // No obligatorio: no ir no es falta
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

const SCHEDULE_STATUS_ICON = { present: '✓', late: '⏰', media_falta: '◐', falta: '✗', licencia: '🏥', scheduled: '○' };
const SCHEDULE_STATUS_LABEL = { present: 'Presente', late: 'Tardanza', media_falta: 'Media falta', falta: 'Ausente', licencia: 'Licencia', scheduled: 'Pendiente' };

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
                // fichajeValidoParaClase() (presencia-logic.js): además de
                // coincidir teacherId+materiaId+fecha, el fichaje tiene que
                // haber caído DENTRO de la ventana del turno de ESTE bloque
                // (ver comentario ahí) - sin esto, un fichaje real pero de
                // otra franja horaria (ej. 00:29 para una clase de las
                // 21:00) podía marcar presente una clase a la que nunca fue.
                entryRecord = attendance.find(a => a.teacherId === teacher.id && a.type === 'entry' && getFechaRealFichaje(a) === dateStr &&
                    (a.categoria || 'regular') === 'regular' && !a.anulado && (h.materiaId != null ? a.materiaId === h.materiaId : true) &&
                    fichajeValidoParaClase(a.time, h.inicio)) || null;
                // Retiro anticipado durante esta clase (salida antes de su
                // fin, posterior a la entrada): la clase queda como media
                // falta. La salida normal no es obligatoria (ver
                // decidirFichaje()), así que sin retiro la entrada cubre todo.
                const earlyExitRecord = entryRecord ? (attendance.find(a => a.teacherId === teacher.id && a.type === 'early_exit' &&
                    getFechaRealFichaje(a) === dateStr && (a.categoria || 'regular') === 'regular' && !a.anulado &&
                    (h.materiaId != null && a.materiaId != null ? a.materiaId === h.materiaId : true) &&
                    (a.time || '') >= (entryRecord.time || '') && (a.time || '').slice(0, 5) < h.fin) || null) : null;
                if (entryRecord && earlyExitRecord) {
                    status = 'media_falta';
                    const [sh, sm] = h.inicio.split(':').map(Number);
                    const [eh, em] = (entryRecord.time || '00:00').split(':').map(Number);
                    tardanzaMin = (eh * 60 + em) - (sh * 60 + sm);
                } else if (entryRecord) {
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
                semaforo: (!eventoEsObligatorio(ev) && !entryRecord)
                    ? { code: 'esperado', ...SEMAFORO_PUNTUALIDAD.esperado }
                    : calcularSemaforoPuntualidad(elapsedMin, criteria, !!entryRecord),
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
            if (e.status === 'media_falta') return { ...e, semaforo: { code: 'media_falta', ...SEMAFORO_PUNTUALIDAD.media_falta } };
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

// Una fila de "Esperados Hoy" (una materia, o un Evento Especial). Se
// usa una sola vez por entrada, sin importar en qué sección de turno
// termine cayendo - ver renderDocentesEsperadosHoy().
function renderFilaEsperadoHoy(e) {
    const cursoTxt = e.carreraNombre ? `${e.carreraNombre} - ${e.anio}° Año` : '';
    // "(fuera de horario)": aclara el caso que confunde a primera
    // vista - SÍ fichó, pero tan tarde respecto del inicio del
    // bloque (no de la duración de la clase) que ya cae en Media
    // Falta/Ausente. Sin esto, un admin ve "fichó 21:50" al lado de
    // un badge rojo "Ausente" y no entiende por qué.
    const fueraDeHorario = e.entryRecord && (e.semaforo.code === 'media_falta' || e.semaforo.code === 'ausente');
    const horaTxt = e.entryRecord && e.entryRecord.time
        ? ` · ${t('esperadosHoy.checkedIn')} ${e.entryRecord.time.slice(0, 5)}${fueraDeHorario ? ' ' + t('esperadosHoy.outOfSchedule') : ''}`
        : '';
    // Tarjeta de Evento Especial: amarillo flúo + badge CON/SIN
    // perjuicio pedido, para que se distinga de un bloque de
    // materia normal de un vistazo (ver getEventoEntriesParaHoy()).
    const claseFila = e.esEvento ? 'semaforo-row semaforo-row-evento' : 'semaforo-row';
    const badgeCumplimiento = e.esEvento
        ? ` ${etiquetasEstadoEvento(e.tipoCumplimiento)}`
        : '';
    const etiquetaMateria = e.esEvento ? `<i class="bi bi-calendar-event"></i> ${t('esperadosHoy.event')}: ${e.materiaNombre}` : e.materiaNombre;
    // Choque de horario real en los datos (ver resolverChoquesHorario()):
    // se pinta todo en rojo encima de lo que sea, con un aviso
    // explícito, en vez de dejar que se vea como un semáforo normal.
    const filaConChoque = e.choqueHorario ? `${claseFila} semaforo-row-choque` : claseFila;
    const avisoChoque = e.choqueHorario
        ? `<div class="alert alert-danger py-1 px-2 small mb-0 mt-1"><i class="bi bi-exclamation-triangle-fill"></i> ${t('esperadosHoy.conflictWarning')}</div>`
        : '';
    return `
        <div class="${filaConChoque}" style="border-left-color:${e.choqueHorario ? '#ef4444' : e.semaforo.color}">
            <div class="semaforo-row-main">
                <span class="semaforo-row-name">${e.teacherName}${badgeCumplimiento}</span>
                <span class="semaforo-row-detail">${etiquetaMateria}${cursoTxt ? ' · ' + cursoTxt : ''} · ${e.inicio}${horaTxt}</span>
                ${avisoChoque}
            </div>
            <span class="semaforo-badge" style="background:${e.choqueHorario ? '#ef4444' : e.semaforo.color}">${e.choqueHorario ? t('esperadosHoy.conflict') : t('semaforo.' + e.semaforo.code)}</span>
        </div>`;
}

// Agrupa TODAS las entradas de hoy (getDocentesEsperadosHoy() ya trae
// todo el día completo, desde las 00:00, sin filtrar por si ya pasó o
// no esa hora) en 3 secciones fijas Mañana/Tarde/Noche según el turno
// de cada bloque (getTurnoPorHora(), sobre `inicio`) - a diferencia de
// getDocentesEsperadosHoy() (ordenada de peor a mejor semáforo), acá
// DENTRO de cada sección se ordena por hora real, para que se lea como
// la agenda del día. El contador del header ("Noche 2/3 presentes")
// cuenta cuántos de esa franja ya tienen fichaje registrado
// (entryRecord), sin importar si llegaron a horario o tarde, sobre el
// total de bloques esperados en esa franja. Las secciones sin ninguna
// entrada no se muestran.
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
        container.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><i class="bi bi-cup-hot"></i></div><div class="empty-state-title">${t('esperadosHoy.noTeachers')}</div><div class="empty-state-text">${t('esperadosHoy.noTeachersHint', { dia: getDiaSemanaArgentina() })}</div></div>`;
        return;
    }
    const secciones = TURNO_ORDEN
        .map(codigo => ({
            codigo,
            entries: entries.filter(e => getTurnoPorHora(e.inicio) === codigo).sort((a, b) => a.inicio.localeCompare(b.inicio)),
        }))
        .filter(s => s.entries.length > 0);

    container.innerHTML = secciones.map(s => {
        const presentes = s.entries.filter(e => e.entryRecord).length;
        return `
            <div class="esperados-turno-header turno-header-${s.codigo.toLowerCase()}">
                <span>${t(TURNO_I18N_KEY[s.codigo])}</span>
                <span class="esperados-turno-count">${presentes}/${s.entries.length} ${t('esperadosHoy.present')}</span>
            </div>
            ${s.entries.map(renderFilaEsperadoHoy).join('')}`;
    }).join('');
}
if (typeof onLocaleChangeRerender === 'function') onLocaleChangeRerender(renderDocentesEsperadosHoy);

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
    } else if (e.status === 'present' || e.status === 'late' || e.status === 'media_falta') {
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
        body.innerHTML = `<p class="text-muted text-center mb-0">${t('teachers.noneRegistered')}</p>`;
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
// Calendario del Establecimiento con FullCalendar (libs/, MIT): SOLO
// horarios, semana tipo, filtros Carrera/Año/Cuatrimestre/Materia/
// Docente. Ver eventosCalendarioEstablecimiento().
let establecimientoCalendar = null;

function aFechaLocalISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Filtros en cascada: Carrera -> Año -> Cuatrimestre -> Materia (cada
// uno solo ofrece lo que existe dentro del anterior) + Docente aparte.
// Cuatrimestre: una materia ANUAL entra en los dos.
let calFiltrosInicializados = false;

function materiasSegunFiltrosCalendario(hasta) {
    const carrera = document.getElementById('calFiltroCarrera').value;
    const anio = document.getElementById('calFiltroAnio').value;
    const cuatri = document.getElementById('calFiltroCuatri').value;
    return currentMaterias.filter(m =>
        (!carrera || String(m.carrera_id) === carrera) &&
        (hasta === 'anio' || !anio || String(m.anio) === anio) &&
        (hasta === 'anio' || hasta === 'cuatri' || !cuatri || m.tipo === 'ANUAL' || String(m.cuatrimestre) === cuatri));
}

function llenarSelect(sel, opcionTodos, opciones, valorActual) {
    sel.innerHTML = `<option value="">${opcionTodos}</option>` + opciones.map(o => `<option value="${o.value}">${o.text}</option>`).join('');
    sel.value = opciones.some(o => String(o.value) === String(valorActual)) ? valorActual : '';
}

function poblarFiltrosCalendario() {
    const selCarrera = document.getElementById('calFiltroCarrera');
    const selAnio = document.getElementById('calFiltroAnio');
    const selCuatri = document.getElementById('calFiltroCuatri');
    const selMateria = document.getElementById('calFiltroMateria');
    const selDocente = document.getElementById('calFiltroDocente');

    // Primera vez: arranca mostrando un curso concreto (primera carrera,
    // primer año), como la planilla de horarios, en vez de todo junto.
    let carreraInicial = selCarrera.value, anioInicial = selAnio.value;
    if (!calFiltrosInicializados && currentCarreras.length > 0) {
        carreraInicial = String(currentCarreras[0].id);
        const anios0 = currentMaterias.filter(m => String(m.carrera_id) === carreraInicial).map(m => m.anio).sort((a, b) => a - b);
        anioInicial = anios0.length ? String(anios0[0]) : '';
        calFiltrosInicializados = true;
    }

    llenarSelect(selCarrera, t('calendar.allCareers'), currentCarreras.map(c => ({ value: c.id, text: c.nombre })), carreraInicial);
    const anios = [...new Set(materiasSegunFiltrosCalendario('anio').map(m => m.anio))].sort((a, b) => a - b);
    llenarSelect(selAnio, t('calendar.allYears'), anios.map(a => ({ value: a, text: `${a}° ${t('teachers.yearWord')}` })), anioInicial);
    const conAnio = materiasSegunFiltrosCalendario('cuatri');
    const cuatris = [...new Set(conAnio.filter(m => m.tipo !== 'ANUAL').map(m => m.cuatrimestre))].filter(Boolean).sort((a, b) => a - b);
    llenarSelect(selCuatri, t('calendar.allTerms'), cuatris.map(c => ({ value: c, text: `${c}° ${t('calendar.termWord')}` })), selCuatri.value);
    const materias = materiasSegunFiltrosCalendario().slice().sort((a, b) => (a.anio - b.anio) || a.nombre.localeCompare(b.nombre));
    llenarSelect(selMateria, t('calendar.allSubjects'), materias.map(m => ({ value: m.id, text: selAnio.value ? m.nombre : `${m.nombre} (${m.anio}°)` })), selMateria.value);
    const docentes = getTeachers().slice().sort((a, b) => `${a.apellido} ${a.nombre}`.localeCompare(`${b.apellido} ${b.nombre}`));
    llenarSelect(selDocente, t('calendar.allTeachers'), docentes.map(tc => ({ value: tc.id, text: `${tc.apellido} ${tc.nombre}` })), selDocente.value);
}

// Ampliar: el modal pasa a pantalla completa y la grilla a filas altas;
// Reducir: vuelve a la vista compacta.
function toggleAmpliarCalendario(forzar) {
    const dialog = document.querySelector('#annualCalendarModal .modal-dialog');
    const cal = document.getElementById('establecimientoCalendar');
    const ampliado = typeof forzar === 'boolean' ? forzar : !dialog.classList.contains('modal-fullscreen');
    dialog.classList.toggle('modal-fullscreen', ampliado);
    dialog.classList.toggle('modal-xl', !ampliado);
    cal.classList.toggle('is-ampliado', ampliado);
    const btn = document.getElementById('calAmpliarBtn');
    if (btn) btn.innerHTML = ampliado
        ? `<i class="bi bi-fullscreen-exit"></i> ${t('calendar.shrink')}`
        : `<i class="bi bi-arrows-fullscreen"></i> ${t('calendar.expand')}`;
    if (establecimientoCalendar) setTimeout(() => establecimientoCalendar.updateSize(), 50);
}

// Vuelve todos los filtros a "Todos" (carrera, año, cuatrimestre,
// materia y docente) y muestra la grilla completa.
function limpiarFiltrosCalendario() {
    ['calFiltroCarrera', 'calFiltroAnio', 'calFiltroCuatri', 'calFiltroMateria', 'calFiltroDocente'].forEach(id => {
        document.getElementById(id).value = '';
    });
    onCambioFiltroCalendario();
}

function onCambioFiltroCalendario() {
    poblarFiltrosCalendario();
    if (!establecimientoCalendar) return;
    const rango = rangoGrillaHorarios(materiasVisiblesCalendario(), true);
    establecimientoCalendar.setOption('slotMinTime', rango.slotMinTime);
    establecimientoCalendar.setOption('slotMaxTime', rango.slotMaxTime);
    establecimientoCalendar.setOption('hiddenDays', rango.hiddenDays);
    establecimientoCalendar.refetchEvents();
}

// Solo horarios (sin presente/ausente: eso está en Grilla Completa,
// Alertas, Reportes y Estadísticas): cada materia que pasa los filtros
// en su bloque semanal, con su profesor o "Sin docente". Semana tipo
// fija (misma referencia que la planilla de Materias), sin fechas.
function materiasVisiblesCalendario() {
    const docente = document.getElementById('calFiltroDocente').value;
    const materiaSel = document.getElementById('calFiltroMateria').value;
    return materiasSegunFiltrosCalendario().filter(m => {
        if (materiaSel && String(m.id) !== materiaSel) return false;
        if (!docente) return true;
        const prof = m.profesor_id ? materiaProfesorPorDocenteId[m.profesor_id] : null;
        return !!prof && prof.id === docente;
    });
}

// ¿Hay clases de más de un año a la vista? Entonces: etiqueta "1°/2°"
// en cada bloque, leyenda de colores por año y filas más altas
// (clase is-multi) para que los nombres entren en columnas angostas.
let calVariosAnios = false;
function actualizarLeyendaAniosCalendario(materias) {
    const anios = [...new Set(materias.map(m => Number(m.anio) || 1))].sort((a, b) => a - b);
    calVariosAnios = anios.length > 1;
    document.getElementById('establecimientoCalendar')?.classList.toggle('is-multi', calVariosAnios);
    const cont = document.getElementById('calLeyendaAnios');
    if (cont) cont.innerHTML = calVariosAnios
        ? anios.map(a => `<div class="schedule-legend-item"><div class="schedule-legend-color cal-anio-dot-${Math.min(a, 5)}"></div><span>${a}° ${t('teachers.yearWord')}</span></div>`).join('')
        : `<div class="schedule-legend-item"><div class="schedule-legend-color cal-dot-scheduled"></div><span>${t('calendar.withTeacher')}</span></div>`;
}

function eventosCalendarioEstablecimiento(info, success) {
    actualizarLeyendaAniosCalendario(materiasVisiblesCalendario());
    const eventos = [];
    materiasVisiblesCalendario()
        .forEach(m => {
            const prof = m.profesor_id ? materiaProfesorPorDocenteId[m.profesor_id] : null;
            materiaHorarios(m).forEach(h => {
                const fecha = planillaFechaDeDia(h.dia);
                if (!fecha) return;
                eventos.push({
                    title: m.nombre,
                    start: `${fecha}T${h.inicio}`,
                    end: `${fecha}T${h.fin}`,
                    // Color por año (cal-anio-N): con varios años a la vista
                    // se distingue de un vistazo a qué curso es cada clase.
                    classNames: [prof ? 'planilla-con-docente' : 'planilla-sin-docente', `cal-anio-${Math.min(Number(m.anio) || 1, 5)}`],
                    extendedProps: { materia: m, profesor: prof ? `${prof.apellido} ${prof.nombre}` : t('calendar.noTeacher'), anual: esMateriaAnual(m) },
                });
            });
        });
    // Sin clases para esta combinación: aviso en vez de una grilla vacía.
    const aviso = document.getElementById('calSinResultados');
    if (aviso) {
        aviso.classList.toggle('hidden', eventos.length > 0);
        aviso.innerHTML = eventos.length > 0 ? '' :
            `<i class="bi bi-info-circle"></i> ${t('calendar.noResults')} <button type="button" class="btn btn-link btn-sm p-0 align-baseline" onclick="limpiarFiltrosCalendario()">${t('calendar.clearFilters')}</button>`;
    }
    const hayFiltro = ['calFiltroCarrera', 'calFiltroAnio', 'calFiltroCuatri', 'calFiltroMateria', 'calFiltroDocente'].some(id => document.getElementById(id).value);
    document.getElementById('calLimpiarFiltrosBtn')?.toggleAttribute('disabled', !hayFiltro);
    success(eventos);
}

// Cuatrimestre en curso según la fecha (1° hasta julio, 2° desde agosto),
// para que el calendario abra mostrando lo que se está dictando.
function cuatrimestreActual() {
    const mes = Number(getFechaHoyArgentina().split('-')[1]);
    return mes <= 7 ? 1 : 2;
}

async function showAnnualCalendar() {
    if (!(await asegurarFullCalendar())) {
        showToast('No se pudo cargar el calendario. Recargá la página con Ctrl+Shift+R.', 'error');
        return;
    }
    if (currentCarreras.length === 0) await loadCarreras();
    if (currentMaterias.length === 0) await loadMaterias();
    const primeraVez = !calFiltrosInicializados;
    poblarFiltrosCalendario();
    if (primeraVez) {
        const selCuatri = document.getElementById('calFiltroCuatri');
        if ([...selCuatri.options].some(o => o.value === String(cuatrimestreActual()))) selCuatri.value = String(cuatrimestreActual());
        poblarFiltrosCalendario();
    }
    const modalEl = document.getElementById('annualCalendarModal');
    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    // FullCalendar necesita el contenedor visible para medirse: se crea
    // (o se re-mide) recién cuando el modal terminó de abrirse.
    modalEl.addEventListener('shown.bs.modal', () => {
        const rango = rangoGrillaHorarios(materiasVisiblesCalendario(), true);
        if (!establecimientoCalendar) {
            establecimientoCalendar = new FullCalendar.Calendar(document.getElementById('establecimientoCalendar'), {
                locale: 'es',
                firstDay: 1,
                initialView: 'timeGridWeek',
                initialDate: PLANILLA_LUNES_REF,
                headerToolbar: false,
                dayHeaderFormat: { weekday: 'long' },
                hiddenDays: rango.hiddenDays,
                slotMinTime: rango.slotMinTime,
                slotMaxTime: rango.slotMaxTime,
                slotDuration: '00:40:00',
                slotLabelInterval: '00:40:00',
                slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
                eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
                allDaySlot: false,
                // Clases simultáneas (p. ej. 1° y 2° año a la misma hora)
                // lado a lado, nunca una encima de la otra.
                slotEventOverlap: false,
                nowIndicator: false,
                expandRows: true,
                height: 'auto',
                events: eventosCalendarioEstablecimiento,
                eventContent: (arg) => {
                    const m = arg.event.extendedProps.materia;
                    const tagAnio = calVariosAnios ? `<span class="cal-anio-tag">${m.anio}°</span> ` : '';
                    return {
                        // Con varios años (columnas angostas) solo la hora de inicio:
                        // el fin se ve por el alto del bloque y en el tooltip.
                        html: `<div class="planilla-evento"><div class="planilla-evento-hora">${tagAnio}${calVariosAnios ? hhmmDe(arg.event.start) : arg.timeText}</div><div class="planilla-evento-nombre">${arg.event.title}${arg.event.extendedProps.anual ? ' <span class="planilla-anual-tag">ANUAL</span>' : ''}</div><div class="planilla-evento-prof">${arg.event.extendedProps.profesor}</div></div>`,
                    };
                },
                eventDidMount: (arg) => {
                    const m = arg.event.extendedProps.materia;
                    arg.el.title = `${hhmmDe(arg.event.start)}–${hhmmDe(arg.event.end)} ${m.nombre} (${m.anio}° año)\n${arg.event.extendedProps.profesor}`;
                },
            });
            establecimientoCalendar.render();
        } else {
            establecimientoCalendar.updateSize();
            onCambioFiltroCalendario();
        }
    }, { once: true });
    modal.show();
}

// ============================================================
// ASISTENCIAS: una fila por clase programada (horario de la materia)
// en el rango de fechas, con su fichaje real. Usa
// getScheduleEntriesForDate() - el mismo cruce horario + fichajes +
// licencias que Inicio, Grilla Completa y Reportes -, así que los
// estados coinciden en todo el sistema. Solo hasta hoy: lo futuro
// todavía no tiene asistencia.
// ============================================================
const ASIS_MAX_DIAS = 92;
const ASIS_ESTADO_CLASE = { present: 'asis-presente', late: 'asis-tarde', media_falta: 'asis-media', falta: 'asis-falta', licencia: 'asis-licencia', scheduled: 'asis-pendiente' };
let asistenciasInicializado = false;
let asistenciasFilas = [];

function fechaMasDias(fechaStr, dias) {
    const d = new Date(fechaStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().split('T')[0];
}

function setRangoAsistencias(diasAtras) {
    const hoy = getFechaHoyArgentina();
    document.getElementById('asisDesde').value = fechaMasDias(hoy, -diasAtras);
    document.getElementById('asisHasta').value = hoy;
    renderAsistencias();
}

function poblarFiltrosAsistencias() {
    const selCarrera = document.getElementById('asisCarrera');
    const selAnio = document.getElementById('asisAnio');
    const selMateria = document.getElementById('asisMateria');
    const selDocente = document.getElementById('asisDocente');
    const selEstado = document.getElementById('asisEstado');
    llenarSelect(selCarrera, t('calendar.allCareers'), currentCarreras.map(c => ({ value: c.id, text: c.nombre })), selCarrera.value);
    const deCarrera = currentMaterias.filter(m => !selCarrera.value || String(m.carrera_id) === selCarrera.value);
    const anios = [...new Set(deCarrera.map(m => m.anio))].sort((a, b) => a - b);
    llenarSelect(selAnio, t('calendar.allYears'), anios.map(a => ({ value: a, text: `${a}° ${t('teachers.yearWord')}` })), selAnio.value);
    const materias = deCarrera.filter(m => !selAnio.value || String(m.anio) === selAnio.value)
        .sort((a, b) => (a.anio - b.anio) || a.nombre.localeCompare(b.nombre));
    llenarSelect(selMateria, t('calendar.allSubjects'), materias.map(m => ({ value: m.id, text: selAnio.value ? m.nombre : `${m.nombre} (${m.anio}°)` })), selMateria.value);
    const docentes = getTeachers().slice().sort((a, b) => `${a.apellido} ${a.nombre}`.localeCompare(`${b.apellido} ${b.nombre}`));
    llenarSelect(selDocente, t('calendar.allTeachers'), docentes.map(tc => ({ value: tc.id, text: `${tc.apellido} ${tc.nombre}` })), selDocente.value);
    llenarSelect(selEstado, t('asistencias.allStatus'), ['present', 'late', 'media_falta', 'falta', 'licencia', 'scheduled'].map(k => ({ value: k, text: SCHEDULE_STATUS_LABEL[k] })), selEstado.value);
}

function onCambioFiltroAsistencias() {
    poblarFiltrosAsistencias();
    renderAsistencias();
}

function limpiarFiltrosAsistencias() {
    ['asisCarrera', 'asisAnio', 'asisMateria', 'asisDocente', 'asisEstado'].forEach(id => { document.getElementById(id).value = ''; });
    poblarFiltrosAsistencias();
    setRangoAsistencias(6);
}

async function loadAsistenciasTab() {
    if (currentCarreras.length === 0) await loadCarreras();
    if (currentMaterias.length === 0) await loadMaterias();
    poblarFiltrosAsistencias();
    if (!asistenciasInicializado) {
        asistenciasInicializado = true;
        setRangoAsistencias(6);
        return;
    }
    renderAsistencias();
}

// Salida real de ese docente ese día para ese bloque: la primera
// salida (normal o anticipada) posterior a su entrada, de la misma
// materia si el fichaje la tiene.
function buscarSalidaDeClase(entry, dateStr) {
    const desde = entry.entryRecord ? entry.entryRecord.time : entry.inicio;
    return getAttendance()
        .filter(a => a.teacherId === entry.teacherId && (a.type === 'exit' || a.type === 'early_exit') &&
            getFechaRealFichaje(a) === dateStr && (a.categoria || 'regular') === 'regular' && !a.anulado &&
            (!entry.materiaId || !a.materiaId || a.materiaId === entry.materiaId) && (a.time || '') >= desde)
        .sort((a, b) => (a.time || '').localeCompare(b.time || ''))[0] || null;
}

function calcularFilasAsistencias() {
    const hoy = getFechaHoyArgentina();
    let desde = document.getElementById('asisDesde').value || hoy;
    let hasta = document.getElementById('asisHasta').value || hoy;
    if (hasta > hoy) hasta = hoy;
    if (desde > hasta) desde = hasta;
    let recortado = false;
    if (fechaMasDias(desde, ASIS_MAX_DIAS) < hasta) { desde = fechaMasDias(hasta, -ASIS_MAX_DIAS); recortado = true; }
    const carrera = document.getElementById('asisCarrera').value;
    const anio = document.getElementById('asisAnio').value;
    const materia = document.getElementById('asisMateria').value;
    const docente = document.getElementById('asisDocente').value;
    const estado = document.getElementById('asisEstado').value;
    const filas = [];
    for (let f = hasta; f >= desde; f = fechaMasDias(f, -1)) {
        getScheduleEntriesForDate(f).forEach(e => {
            if (carrera && String(e.carreraId) !== carrera) return;
            if (anio && String(e.anio) !== anio) return;
            if (materia && String(e.materiaId) !== materia) return;
            if (docente && e.teacherId !== docente) return;
            if (estado && e.status !== estado) return;
            const salida = e.entryRecord ? buscarSalidaDeClase(e, f) : null;
            filas.push({ fecha: f, entry: e, salida });
        });
    }
    return { filas, desde, hasta, recortado };
}

function formatoFechaCorta(fechaStr) {
    const d = new Date(fechaStr + 'T00:00:00Z');
    const txt = d.toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
    return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function renderAsistencias() {
    const tbody = document.getElementById('asisTablaBody');
    if (!tbody) return;
    const { filas, recortado } = calcularFilasAsistencias();
    asistenciasFilas = filas;

    const cuenta = { present: 0, late: 0, media_falta: 0, falta: 0, licencia: 0, scheduled: 0 };
    filas.forEach(r => { cuenta[r.entry.status] = (cuenta[r.entry.status] || 0) + 1; });

    // Cupo anual de faltas de cada docente que aparece en la lista (una
    // sola vez por docente y año, no por fila).
    const criteria = getCriteria();
    const teachersPorId = {};
    getTeachers().forEach(tc => { teachersPorId[String(tc.id)] = tc; });
    const cupoCache = {};
    const cupo = (teacherId, anio) => {
        const k = `${teacherId}|${anio}`;
        if (!cupoCache[k]) {
            const fechas = faltasDelAnio(teacherId, anio);
            cupoCache[k] = { fechas, cantidad: fechas.length, nivel: nivelCupoFaltas(fechas.length, criteria) };
        }
        return cupoCache[k];
    };
    const docentesPorNivel = { aviso: new Set(), limite: new Set(), descuento: new Set() };
    filas.forEach(({ fecha, entry: e }) => {
        const c = cupo(e.teacherId, fecha.slice(0, 4));
        if (docentesPorNivel[c.nivel]) docentesPorNivel[c.nivel].add(e.teacherId);
    });
    const cercaDelLimite = docentesPorNivel.aviso.size + docentesPorNivel.limite.size;

    document.getElementById('asisResumen').innerHTML = `
        <span class="asis-chip"><strong>${filas.length}</strong> ${t('asistencias.classes')}</span>
        ${['present', 'late', 'media_falta', 'falta', 'licencia', 'scheduled'].map(k => `<span class="asis-chip ${ASIS_ESTADO_CLASE[k]}"><strong>${cuenta[k]}</strong> ${SCHEDULE_STATUS_LABEL[k]}</span>`).join('')}
        ${cercaDelLimite ? `<span class="asis-chip asis-cupo-aviso"><i class="bi bi-exclamation-triangle"></i> <strong>${cercaDelLimite}</strong> ${t('asistencias.chipNear')}</span>` : ''}
        ${docentesPorNivel.descuento.size ? `<span class="asis-chip asis-cupo-descuento"><i class="bi bi-cash-coin"></i> <strong>${docentesPorNivel.descuento.size}</strong> ${t('asistencias.chipOver', { n: criteria.faltasPermitidasAnio })}</span>` : ''}
        ${recortado ? `<span class="asis-aviso">${t('asistencias.rangeLimited', { n: ASIS_MAX_DIAS })}</span>` : ''}`;

    if (filas.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-4">${t('asistencias.empty')}</td></tr>`;
        return;
    }
    tbody.innerHTML = filas.map(({ fecha, entry: e, salida }) => {
        const anio = fecha.slice(0, 4);
        const c = cupo(e.teacherId, anio);
        // Esta ausencia en particular, ¿es posterior al cupo? (su orden
        // dentro de las faltas del año supera las permitidas)
        const ordenFalta = e.status === 'falta' ? c.fechas.indexOf(fecha) + 1 : 0;
        const seDescuenta = ordenFalta > criteria.faltasPermitidasAnio;
        const faltasTxt = `<span class="asis-cupo asis-cupo-${c.nivel}" title="${t('asistencias.absencesTitle', { n: c.cantidad, max: criteria.faltasPermitidasAnio, anio })}">${c.cantidad}/${criteria.faltasPermitidasAnio}</span>`;
        const teacher = teachersPorId[String(e.teacherId)];
        const aviso = teacher && c.nivel !== 'ok' ? botonesAvisoFaltas(teacher, c.cantidad, anio, criteria) : '—';
        const curso = e.carreraNombre ? `<small class="text-muted d-block">${e.anio}° ${t('teachers.yearWord')}</small>` : '';
        const entrada = e.entryRecord ? `${(e.entryRecord.time || '').slice(0, 5)}${e.tardanzaMin > 0 ? ` <small class="asis-tarde-txt">+${e.tardanzaMin}m</small>` : ''}` : '—';
        const salidaTxt = salida ? `${(salida.time || '').slice(0, 5)}${salida.type === 'early_exit' ? ` <small class="asis-tarde-txt">${t('asistencias.early')}</small>` : ''}` : '—';
        const estadoTxt = e.status === 'licencia' && e.licenciaMotivo ? `${SCHEDULE_STATUS_LABEL[e.status]}: ${e.licenciaMotivo}` : SCHEDULE_STATUS_LABEL[e.status];
        return `<tr class="${seDescuenta ? 'asis-fila-descuento' : ''}">
            <td>${formatoFechaCorta(fecha)}</td>
            <td class="asis-mono">${e.inicio}–${e.fin}</td>
            <td>${e.materiaNombre}${curso}</td>
            <td>${e.teacherName}</td>
            <td class="asis-mono">${entrada}</td>
            <td class="asis-mono">${salidaTxt}</td>
            <td><span class="asis-badge ${ASIS_ESTADO_CLASE[e.status]}">${estadoTxt}</span>${seDescuenta ? ` <span class="asis-badge asis-descuento"><i class="bi bi-cash-coin"></i> ${t('asistencias.discount')}</span>` : ''}</td>
            <td class="asis-mono">${faltasTxt}</td>
            <td class="asis-aviso-col">${aviso}</td>
        </tr>`;
    }).join('');
}
if (typeof onLocaleChangeRerender === 'function') onLocaleChangeRerender(() => { if (asistenciasInicializado) { poblarFiltrosAsistencias(); renderAsistencias(); } });

// ===== Cupo anual de faltas =====
// Un docente puede faltar hasta criteria.faltasPermitidasAnio días por año
// calendario sin contar licencias; desde la siguiente, los días faltados se
// descuentan del sueldo. Se cuentan las alertas "Falta" (una por día de
// clases sin ninguna entrada) y "Falta Evento" (evento obligatorio sin
// fichar) de ese año. No cuentan las justificadas por una licencia.
function faltasDelAnio(teacherId, anio) {
    const prefijo = String(anio);
    return getAlerts()
        .filter(a => a.teacherId === teacherId && (a.type === 'Falta' || a.type === 'Falta Evento')
            && (a.faltaDate || '').startsWith(prefijo) && a.justification !== 'licencia')
        .map(a => a.faltaDate)
        .sort();
}

// Nivel del docente respecto del cupo: 'ok', 'aviso' (desde avisoFaltasDesde),
// 'limite' (llegó justo al cupo) o 'descuento' (lo superó).
function nivelCupoFaltas(cantidad, criteria) {
    if (cantidad > criteria.faltasPermitidasAnio) return 'descuento';
    if (cantidad === criteria.faltasPermitidasAnio && cantidad > 0) return 'limite';
    if (cantidad >= criteria.avisoFaltasDesde) return 'aviso';
    return 'ok';
}

function mensajeAvisoFaltas(teacher, cantidad, anio, criteria) {
    const permitidas = criteria.faltasPermitidasAnio;
    let detalle;
    if (cantidad > permitidas) detalle = `Superaste el límite: las faltas a partir de la ${permitidas + 1}.ª se descuentan del sueldo.`;
    else if (cantidad === permitidas) detalle = 'Llegaste al límite: a partir de la próxima falta, los días faltados se descuentan del sueldo.';
    else detalle = `Te ${permitidas - cantidad === 1 ? 'queda 1 falta' : `quedan ${permitidas - cantidad} faltas`} antes de que empiecen a descontarse del sueldo.`;
    return `Hola ${teacher.nombre}, te escribimos de Secretaría. Registrás ${cantidad} ${cantidad === 1 ? 'falta' : 'faltas'} en ${anio} (de ${permitidas} permitidas por año, sin contar licencias). ${detalle} Si alguna corresponde a una licencia, acercá la documentación.`;
}

function telefonoValidoParaWhatsApp(telefono) {
    return cleanPhone(telefono).length >= 10;
}

// Botones de aviso (WhatsApp y mail) de la columna "Aviso" de Asistencias.
function botonesAvisoFaltas(teacher, cantidad, anio, criteria) {
    const mensaje = mensajeAvisoFaltas(teacher, cantidad, anio, criteria);
    const partes = [];
    if (telefonoValidoParaWhatsApp(teacher.telefono)) {
        partes.push(`<a class="asis-aviso-btn is-wa" href="${buildWhatsAppLink(teacher.telefono, mensaje)}" target="_blank" rel="noopener" title="${t('asistencias.sendWa')}" onclick="registrarAvisoFaltas('${teacher.id}', 'WhatsApp', ${cantidad})"><i class="bi bi-whatsapp"></i></a>`);
    } else {
        partes.push(`<span class="asis-aviso-falta" title="${t('asistencias.phoneIncomplete')}"><i class="bi bi-telephone-x"></i></span>`);
    }
    if (teacher.email) {
        const asunto = `Aviso de faltas ${anio} - ${teacher.apellido} ${teacher.nombre}`;
        partes.push(`<a class="asis-aviso-btn is-mail" href="mailto:${encodeURIComponent(teacher.email)}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(mensaje)}" title="${t('asistencias.sendMail')}" onclick="registrarAvisoFaltas('${teacher.id}', 'mail', ${cantidad})"><i class="bi bi-envelope"></i></a>`);
    }
    return partes.join(' ');
}

function registrarAvisoFaltas(teacherId, canal, cantidad) {
    const teacher = getTeachers().find(x => String(x.id) === String(teacherId));
    logAccion('AVISO_FALTAS', `Aviso de faltas por ${canal} a ${teacher ? `${teacher.apellido} ${teacher.nombre}` : teacherId} (${cantidad} faltas en el año)`);
}

function exportarAsistenciasExcel() {
    if (typeof XLSX === 'undefined') { showToast('No se pudo cargar la librería de Excel', 'error'); return; }
    const { filas, desde, hasta } = calcularFilasAsistencias();
    if (filas.length === 0) { showToast(t('asistencias.empty'), 'warning'); return; }
    const criteria = getCriteria();
    const cupoCache = {};
    const faltasDe = (teacherId, anio) => (cupoCache[`${teacherId}|${anio}`] = cupoCache[`${teacherId}|${anio}`] || faltasDelAnio(teacherId, anio));
    const rows = filas.map(({ fecha, entry: e, salida }) => ({
        ...filaExcelAsistencia(fecha, e, salida),
        'Faltas del año': `${faltasDe(e.teacherId, fecha.slice(0, 4)).length}/${criteria.faltasPermitidasAnio}`,
        'Se descuenta': e.status === 'falta' && faltasDe(e.teacherId, fecha.slice(0, 4)).indexOf(fecha) + 1 > criteria.faltasPermitidasAnio ? 'Sí' : '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Asistencias');
    XLSX.writeFile(wb, `asistencias_${desde}_${hasta}.xlsx`);
    logAccion('EXPORTAR_ASISTENCIAS', `Exportó ${rows.length} fila(s) de asistencias (${desde} a ${hasta})`);
}

function filaExcelAsistencia(fecha, e, salida) {
    return {
        Fecha: fecha,
        Día: e.dia,
        Inicio: e.inicio,
        Fin: e.fin,
        Carrera: e.carreraNombre || '',
        Año: e.anio ? `${e.anio}°` : '',
        Materia: e.materiaNombre,
        Docente: e.teacherName,
        Entrada: e.entryRecord ? (e.entryRecord.time || '').slice(0, 5) : '',
        'Min. tarde': e.tardanzaMin > 0 ? e.tardanzaMin : '',
        Salida: salida ? (salida.time || '').slice(0, 5) : '',
        'Salida anticipada': salida && salida.type === 'early_exit' ? 'Sí' : '',
        Estado: SCHEDULE_STATUS_LABEL[e.status],
        Observación: e.status === 'licencia' ? (e.licenciaMotivo || '') : '',
    };
}

// Carga un <script> bajo demanda (resuelve al terminar de cargar).
function cargarScript(src) {
    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => reject(new Error('No se pudo cargar ' + src));
        document.head.appendChild(el);
    });
}

// Normalmente FullCalendar ya viene cargado desde index.html. Si la
// página quedó de una versión anterior (index.html viejo en caché, sin
// esos <script>), se trae acá mismo en vez de fallar.
async function asegurarFullCalendar() {
    if (typeof FullCalendar !== 'undefined') return true;
    try {
        await cargarScript('libs/fullcalendar.global.min.js');
        await cargarScript('libs/fullcalendar-es.global.min.js');
    } catch (e) {
        console.error(e);
    }
    return typeof FullCalendar !== 'undefined';
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
    // carreras/materias se cargan temprano, antes de checkFaltas() (que
    // ya las necesita para calcular el horario efectivo vía
    // getHorarioEfectivo/getMateriasDeDocente) y antes de cualquier paso
    // de acá abajo que pueda tirar una excepción sin capturar - así una
    // falla en checkResetTokenFromUrl/checkFaltas/checkFaltasEvento no
    // deja a currentCarreras/currentMaterias vacíos para el resto de la
    // sesión (eso es lo que dejaba el combo "Carrera" de Docentes sin
    // opciones al asignar materias).
    await loadCarreras();
    await loadMaterias();
    try {
        await checkResetTokenFromUrl();
    } catch (error) {
        console.error('Error en checkResetTokenFromUrl:', error);
    }
    const criteria = getCriteria();
    saveCriteriaToStorage(criteria);
    try {
        ensureGeofenceConfig();
    } catch (error) {
        console.error('Error en ensureGeofenceConfig:', error);
    }
    await loadEventoConvocatoriasPorDocente();
    try {
        checkFaltas();
        checkFaltasEvento();
    } catch (error) {
        console.error('Error calculando faltas al iniciar:', error);
    }
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
