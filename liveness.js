// ============================================================
// ASISCAM PRO - Prueba de vida / Anti-Spoofing (Nivel 1+2) del
// fichaje facial. Script clásico (igual que roles.js/auditoria.js),
// se carga después de script.js en index.html.
//
// Corre DENTRO de detectFace() (ver script.js), justo después de la
// geocerca y ANTES de comparar el rostro con el descriptor guardado:
// exige una cabeza real reaccionando a gestos al azar (challenges),
// para que una foto de un celular -o un video grabado con el mismo
// gesto de siempre- no alcancen para fichar. Usa MediaPipe Face Mesh
// (CDN, ver index.html) en vez de face-api.js para esto: más
// liviano, y de paso el mismo modelo (con maxNumFaces:2) sirve para
// detectar "más de un rostro" sin sumar un modelo de Face Detection
// aparte.
//
// Pool de 10 gestos (ver LIVENESS_CHALLENGE_TYPES): "Mirá al frente"
// es SIEMPRE el primer paso, fijo (fija la base de todos los ratios,
// ver computeFaceRatios) - no se sortea, porque sin un punto de
// referencia inicial no hay contra qué medir ningún otro gesto. Los
// otros 9 (BLINK, SMILE, TURN_LEFT, TURN_RIGHT, MOUTH_OPEN,
// EYEBROWS_UP, LOOK_UP, LOOK_DOWN, FROWN) son el pool del que se
// sortean 3, en orden al azar, en cada fichaje (getRandomChallenges).
//
// TIME-GATING: la base de CADA challenge (contra la que se mide su
// gesto) se toma recién al mostrar su cartel, no la base original de
// "Mirá al frente". Así, un gesto hecho ANTES del cartel (o que
// "quedó pegado" del challenge anterior, p.ej. la cabeza todavía
// girada del challenge anterior) no cuenta como reacción a ESTE
// cartel - fuerza a que el movimiento ocurra DESPUÉS de la consigna,
// dentro de sus 8s.
//
// IMPORTANTE - por qué los gestos se miden con RATIOS y no con
// píxeles sueltos (fix de una vulnerabilidad real, ver historial de
// commits): la primera versión medía "¿la nariz se movió >15px?" o
// "¿la boca se hizo un 15% más ancha?" en píxeles crudos. Eso lo
// pasaba una FOTO en otro celular con solo acercarla o correrla con
// la mano frente a la cámara - mover o acercar una imagen plana
// cambia esos píxeles exactamente igual que un gesto real. La
// solución: normalizar cada medida contra otra distancia de la misma
// cara (yaw = nariz-a-ojo izquierdo / nariz-a-ojo derecho, sonrisa =
// ancho de boca / distancia entre ojos, boca abierta = separación de
// labios / distancia entre ojos, cejas arriba = distancia ceja-párpado
// / distancia entre ojos, fruncir el ceño = distancia entre cejas
// internas / distancia entre ojos). Trasladar o escalar una imagen plana no
// cambia esos RATIOS (las dos distancias se mueven/escalan juntas y
// se cancelan); solo una rotación o deformación 3D real de una cara
// los cambia. Ver computeFaceRatios().
//
// DIRECCIÓN: TURN_LEFT/TURN_RIGHT y LOOK_UP/LOOK_DOWN aceptan el
// cambio de ratio en cualquier sentido (no exigen el sentido exacto
// pedido en el cartel). Es a propósito: sin espejar el video no hay
// forma de calibrar en el servidor qué signo de yaw/pitch corresponde
// a "izquierda" o "arriba" para TODOS los dispositivos/cámaras, y
// exigir el sentido exacto arriesgaba dejar el challenge imposible de
// pasar (bloqueo permanente) si el signo queda al revés en algún
// dispositivo. Lo que importa para anti-spoofing es que haya una
// rotación 3D real, no en qué sentido exacto. MOUTH_OPEN, EYEBROWS_UP
// y FROWN sí son direccionales (abrir/cerrar, subir/bajar cejas): son
// gestos locales sin ambigüedad de cámara, así que si conviene después
// de probar en vivo se puede endurecer TURN_*/LOOK_* de la misma
// forma - ver LIVENESS_YAW_RATIO_DELTA/LIVENESS_PITCH_RATIO_DELTA.
//
// VOZ: cada consigna se dicta con la Web Speech API
// (window.speechSynthesis), además de mostrarse en pantalla. En la
// mayoría de los navegadores de escritorio (Chrome/Edge en Windows,
// Safari en Mac) usa una voz del propio sistema operativo, sin
// depender de internet; en algunos Android puede recurrir a una voz
// de red según el dispositivo. Si el navegador no soporta
// speechSynthesis, livenessSpeak() no hace nada y la consigna se ve
// igual en el cartel - la voz es un refuerzo, nunca el único canal.
//
// NOTA: a diferencia de face-api.js (modelos vendorizados en /models
// para funcionar offline), Face Mesh se trae de un CDN - la prueba
// de vida necesita internet la primera vez que se usa en cada
// dispositivo (el navegador cachea el WASM/modelo después de eso).
//
// Fichaje guardado (ver consumeLivenessFields(), usado en
// registerAttendance()/registerFaceEventoAttendance() de script.js):
//   { liveness_passed: true, checks: { challenges: ['MOUTH_OPEN','TURN_RIGHT','BLINK'],
//     details: { MOUTH_OPEN: { mouthOpen_delta: 0.21 }, TURN_RIGHT: { yaw_delta_pct: 0.31 },
//                BLINK: { ear_value: 0.19, valley_ms: 340 } } } }
// ============================================================

// Pool de 9 gestos sorteables (todo menos "Mirá al frente", que es
// siempre el primer paso fijo - ver comentario grande arriba).
const LIVENESS_CHALLENGE_TYPES = ['BLINK', 'SMILE', 'TURN_LEFT', 'TURN_RIGHT', 'MOUTH_OPEN', 'EYEBROWS_UP', 'LOOK_UP', 'LOOK_DOWN', 'FROWN'];
const LIVENESS_CHALLENGE_COUNT = 3; // "pida 3 gestos aleatorios"
const LIVENESS_CHALLENGE_TIMEOUT_MS = 8000; // por challenge, según lo pedido

// Cambio relativo mínimo (porcentaje contra la base) para los ratios
// que parten de un valor "normal" bien distinto de cero.
const LIVENESS_YAW_RATIO_DELTA = 0.15;   // TURN_LEFT/TURN_RIGHT
const LIVENESS_PITCH_RATIO_DELTA = 0.15; // LOOK_UP/LOOK_DOWN
const LIVENESS_SMILE_RATIO_DELTA = 0.15; // SMILE
// Cambio absoluto mínimo (no porcentual) para los ratios que parten
// de una base cercana a 0 con boca/cejas en reposo (un % contra ~0
// es inestable: un cambio minúsculo ya se vería como "infinito%").
const LIVENESS_MOUTH_OPEN_DELTA = 0.15;  // MOUTH_OPEN
const LIVENESS_BROW_DELTA = 0.06;        // EYEBROWS_UP (distancia ceja-párpado, sube al levantar cejas)
// FROWN usa un ratio y un umbral DISTINTOS de EYEBROWS_UP (ver
// LIVENESS_BROW_INNER_LEFT/RIGHT arriba): el punto de arco medio de
// la ceja (105/334) apenas se mueve al fruncir, así que reusar el
// mismo par y solo bajar el umbral no alcanzaba - el problema real
// era la métrica, no el número. 0.025 es una primera estimación (más
// chico que LIVENESS_BROW_DELTA porque el frunce mueve las cejas bastante
// menos que levantarlas); mirá la consola (runAbsoluteRatioChallenge
// loguea el ratio en vivo) para calibrarlo si hace falta.
const LIVENESS_BROW_INNER_DELTA = 0.025; // FROWN (distancia entre cejas internas, baja al fruncir)

const LIVENESS_BLINK_CLOSED_EAR = 0.22;  // "ojo cerrado"
const LIVENESS_BLINK_OPEN_EAR = 0.28;    // "ojo abierto" (deja un margen contra 0.22 para que el ruido de una foto no cuente como parpadeo)
const LIVENESS_BLINK_VALLEY_MAX_MS = 1500; // abierto->cerrado->abierto tiene que pasar en <=1.5s
const LIVENESS_BLINK_HISTORY_SAMPLES = 20; // "las últimas 20 frames" de EAR para buscar el valle
const LIVENESS_FACE_WAIT_TIMEOUT_MS = 15000;
// "Mirá al frente": además de fijar la base de los ratios, se usa
// esta ventana para el chequeo de staticidad (ver abajo) - una foto
// sostenida con la mano o en un atril tiende a quedar MUCHO más
// quieta cuadro a cuadro que una cara real (micro-temblor, parpadeo
// involuntario, respiración).
const LIVENESS_CENTER_HOLD_MS = 1500;
const LIVENESS_STATIC_MOVE_EPSILON_PX = 1.5; // movimiento total acumulado de la nariz durante el hold, por debajo de esto se rechaza como "demasiado estático"
const LIVENESS_MAX_FAILS = 3;
const LIVENESS_LOCKOUT_MS = 2 * 60 * 1000;
const LIVENESS_LOCK_STORAGE_KEY = 'asiscam_liveness_lock';

// Malla de 468 puntos de MediaPipe Face Mesh.
const LIVENESS_NOSE_TIP = 1;
const LIVENESS_CHIN = 152;
const LIVENESS_FOREHEAD = 10;
const LIVENESS_EYE_OUTER_LEFT = 33;
const LIVENESS_EYE_OUTER_RIGHT = 263;
const LIVENESS_MOUTH_LEFT = 61;
const LIVENESS_MOUTH_RIGHT = 291;
const LIVENESS_MOUTH_UPPER_INNER = 13;
const LIVENESS_MOUTH_LOWER_INNER = 14;
const LIVENESS_BROW_LEFT = 105;
const LIVENESS_EYE_TOP_LEFT = 159;
const LIVENESS_BROW_RIGHT = 334;
const LIVENESS_EYE_TOP_RIGHT = 386;
// Extremo interno (medial) de cada ceja, cerca de la glabela - lo que
// el músculo corrugador junta de verdad al fruncir el ceño. Distinto
// del arco medio (105/334) que usa EYEBROWS_UP: ese punto casi no se
// mueve al fruncir (el frunce es sobre todo horizontal e interno, no
// vertical), por eso FROWN necesita su propio par de landmarks.
const LIVENESS_BROW_INNER_LEFT = 55;
const LIVENESS_BROW_INNER_RIGHT = 285;
const LIVENESS_LEFT_EYE = [33, 160, 158, 133, 153, 144];
const LIVENESS_RIGHT_EYE = [362, 385, 387, 263, 373, 380];

// Consignas en pantalla (voseo, cortas, para el cartel que titila -
// ver .face-recognition-status.liveness-prompt en style.css) y para
// dictar por voz (texto plano, sin el ícono). FRONT no es un
// challenge sorteable, es el paso fijo inicial.
const LIVENESS_PROMPT_TEXT = {
    FRONT: 'Mirá al frente',
    BLINK: 'Parpadeá',
    SMILE: 'Sonreí',
    TURN_LEFT: 'Girá la cabeza a la izquierda',
    TURN_RIGHT: 'Girá la cabeza a la derecha',
    MOUTH_OPEN: 'Abrí la boca',
    EYEBROWS_UP: 'Levantá las cejas',
    LOOK_UP: 'Mirá hacia arriba',
    LOOK_DOWN: 'Mirá hacia abajo',
    FROWN: 'Fruncí el ceño',
};
const LIVENESS_PROMPT_ICON = {
    FRONT: 'bi-person-bounding-box',
    BLINK: 'bi-eye',
    SMILE: 'bi-emoji-smile',
    TURN_LEFT: 'bi-arrow-left',
    TURN_RIGHT: 'bi-arrow-right',
    MOUTH_OPEN: 'bi-emoji-astonished',
    EYEBROWS_UP: 'bi-emoji-surprise',
    LOOK_UP: 'bi-arrow-up',
    LOOK_DOWN: 'bi-arrow-down',
    FROWN: 'bi-emoji-frown',
};
const LIVENESS_CHALLENGE_CHIP_LABEL = {
    BLINK: 'Parpadeo',
    SMILE: 'Sonreír',
    TURN_LEFT: 'Girar izq.',
    TURN_RIGHT: 'Girar der.',
    MOUTH_OPEN: 'Abrir boca',
    EYEBROWS_UP: 'Cejas arriba',
    LOOK_UP: 'Mirar arriba',
    LOOK_DOWN: 'Mirar abajo',
    FROWN: 'Fruncir ceño',
};

let faceMeshInstance = null;
let faceMeshLoading = null;
// Resultado de la última prueba de vida aprobada, lista para
// adjuntarse al próximo fichaje que se guarde (ver
// consumeLivenessFields()). Se consume una sola vez.
let lastLivenessResult = null;

function loadLivenessModel() {
    if (faceMeshInstance) return Promise.resolve(faceMeshInstance);
    if (faceMeshLoading) return faceMeshLoading;
    faceMeshLoading = new Promise((resolve, reject) => {
        try {
            if (typeof FaceMesh === 'undefined') {
                reject(new Error('FaceMesh no disponible (falló la carga del CDN de MediaPipe)'));
                return;
            }
            const fm = new FaceMesh({
                locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619/${file}`,
            });
            fm.setOptions({
                maxNumFaces: 2, // 2 (no 1): así el mismo modelo detecta "más de un rostro" sin sumar Face Detection aparte
                refineLandmarks: false,
                minDetectionConfidence: 0.5,
                minTrackingConfidence: 0.5,
            });
            faceMeshInstance = fm;
            resolve(fm);
        } catch (err) {
            reject(err);
        }
    });
    return faceMeshLoading;
}

function livenessDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function livenessLandmarkPx(lm, videoW, videoH) {
    return { x: lm.x * videoW, y: lm.y * videoH };
}

function computeEAR(landmarks, eyeIdx, videoW, videoH) {
    const [p1, p2, p3, p4, p5, p6] = eyeIdx.map(i => livenessLandmarkPx(landmarks[i], videoW, videoH));
    const vertical = livenessDist(p2, p6) + livenessDist(p3, p5);
    const horizontal = livenessDist(p1, p4) * 2;
    return horizontal > 0 ? vertical / horizontal : 0;
}

// Todas las medidas "de gesto" (yaw/pitch/sonrisa/boca/cejas) como
// RATIOS entre dos distancias de la propia cara, nunca como un
// desplazamiento en píxeles sueltos (ver comentario grande arriba
// del archivo). videoW/videoH solo se usan para pasar los landmarks
// normalizados (0-1) a píxeles antes de medir distancias.
function computeFaceRatios(lm, videoW, videoH) {
    const px = (i) => livenessLandmarkPx(lm[i], videoW, videoH);
    const nose = px(LIVENESS_NOSE_TIP);
    const chin = px(LIVENESS_CHIN);
    const forehead = px(LIVENESS_FOREHEAD);
    const eyeL = px(LIVENESS_EYE_OUTER_LEFT);
    const eyeR = px(LIVENESS_EYE_OUTER_RIGHT);
    const mouthL = px(LIVENESS_MOUTH_LEFT);
    const mouthR = px(LIVENESS_MOUTH_RIGHT);
    const lipUpper = px(LIVENESS_MOUTH_UPPER_INNER);
    const lipLower = px(LIVENESS_MOUTH_LOWER_INNER);
    const browL = px(LIVENESS_BROW_LEFT);
    const eyeTopL = px(LIVENESS_EYE_TOP_LEFT);
    const browR = px(LIVENESS_BROW_RIGHT);
    const eyeTopR = px(LIVENESS_EYE_TOP_RIGHT);
    const browInnerL = px(LIVENESS_BROW_INNER_LEFT);
    const browInnerR = px(LIVENESS_BROW_INNER_RIGHT);

    const eyeDist = livenessDist(eyeL, eyeR); // referencia de escala de la cara (invariante a acercar/alejar la foto)
    const noseToEyeL = livenessDist(nose, eyeL);
    const noseToEyeR = livenessDist(nose, eyeR);
    const noseToForehead = livenessDist(nose, forehead);
    const noseToChin = livenessDist(nose, chin);
    const mouthWidth = livenessDist(mouthL, mouthR);
    const lipGap = livenessDist(lipUpper, lipLower);
    const browGap = (livenessDist(browL, eyeTopL) + livenessDist(browR, eyeTopR)) / 2;
    const browInnerGap = livenessDist(browInnerL, browInnerR);

    return {
        eyeDist,
        // yaw: al girar la cabeza, un lado se acerca a la nariz en la
        // proyección 2D y el otro se aleja - trasladar una foto plana
        // no cambia esta relación, solo una rotación real lo hace.
        yaw: noseToEyeR > 0 ? noseToEyeL / noseToEyeR : null,
        pitch: noseToChin > 0 ? noseToForehead / noseToChin : null,
        // sonrisa/boca/cejas normalizadas contra el ancho de ojos: así
        // acercar la foto (que agranda TODO por igual) no cuenta como
        // gesto, solo un cambio real de la cara.
        smile: eyeDist > 0 ? mouthWidth / eyeDist : null,
        mouthOpen: eyeDist > 0 ? lipGap / eyeDist : null,
        brow: eyeDist > 0 ? browGap / eyeDist : null, // EYEBROWS_UP (arco medio de la ceja vs párpado)
        browInner: eyeDist > 0 ? browInnerGap / eyeDist : null, // FROWN (separación entre cejas internas)
    };
}

// Fisher-Yates (shuffle real, sin sesgo hacia el principio del
// array como tendría un sort(() => Math.random() - 0.5)).
function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// 3 challenges al azar, en orden al azar, de entre los 9 del pool
// (ver LIVENESS_CHALLENGE_TYPES - "Mirá al frente" no se sortea, es
// siempre el primer paso). Se llama una vez por cada intento de
// fichaje (cada detectFace() -> runLivenessCheck()), así que dos
// intentos seguidos casi nunca piden lo mismo en el mismo orden; si
// un challenge falla, se corta el intento entero y el PRÓXIMO
// intento vuelve a sortear 3 nuevos desde cero.
function getRandomChallenges() {
    return shuffleArray(LIVENESS_CHALLENGE_TYPES).slice(0, LIVENESS_CHALLENGE_COUNT);
}

// Dicta la consigna por voz (Web Speech API), además del cartel en
// pantalla. Si el navegador no soporta speechSynthesis, no hace nada
// - la consigna visual siempre es la fuente de verdad.
function livenessSpeak(text) {
    try {
        if (!('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel(); // corta cualquier locución anterior en curso, para que no se solapen entre challenges
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'es-AR';
        utter.rate = 1;
        window.speechSynthesis.speak(utter);
    } catch (e) { /* TTS no disponible en este navegador/dispositivo: la consigna igual se ve en pantalla */ }
}

// Muestra Y dictá una consigna (cartel titilando + voz) en un solo
// paso - se usa tanto para "Mirá al frente" como para cada challenge.
function livenessPrompt(type) {
    livenessSetStatus(`<i class="bi ${LIVENESS_PROMPT_ICON[type]}"></i> ${LIVENESS_PROMPT_TEXT[type]}`, 'liveness-prompt');
    livenessSpeak(LIVENESS_PROMPT_TEXT[type]);
}

// ===== UI: anillo guía + pasos dinámicos (ver #livenessRing y
// #livenessSteps en index.html, camera-container del docente) =====
function livenessSetRing(state) {
    const ring = document.getElementById('livenessRing');
    if (!ring) return;
    ring.classList.remove('hidden', 'ok', 'fail');
    if (state === 'ok') ring.classList.add('ok');
    else if (state === 'fail') ring.classList.add('fail');
}

// Arma los chips "1/3 Girar der." ... "OK" para el set de challenges
// de ESTE intento (cambia de intento a intento, no es fijo).
function livenessRenderSteps(challenges) {
    const wrap = document.getElementById('livenessSteps');
    if (!wrap) return;
    wrap.classList.remove('hidden');
    const total = challenges.length;
    wrap.innerHTML = challenges.map((type, i) =>
        `<span class="liveness-step" data-idx="${i}">${i + 1}/${total} ${LIVENESS_CHALLENGE_CHIP_LABEL[type]}</span>`
    ).join('') + `<span class="liveness-step" data-idx="${total}">OK</span>`;
}

function livenessSetActiveStepIndex(idx) {
    const wrap = document.getElementById('livenessSteps');
    if (!wrap) return;
    wrap.querySelectorAll('.liveness-step').forEach(el => {
        const i = Number(el.dataset.idx);
        el.classList.toggle('active', i === idx);
        el.classList.toggle('done', i < idx);
    });
}

function livenessHideSteps() {
    const wrap = document.getElementById('livenessSteps');
    if (wrap) wrap.classList.add('hidden');
}

function livenessSetStatus(html, cls) {
    const status = document.getElementById('faceRecognitionStatus');
    if (!status) return;
    status.className = 'face-recognition-status ' + (cls || 'processing');
    status.innerHTML = html;
}

// Oculta el anillo/pasos sin tocar el mensaje de estado (lo llama
// detectFace() en script.js apenas la prueba de vida pasa, antes de
// arrancar la comparación facial de siempre).
function livenessReset() {
    livenessSetRing(null);
    const ring = document.getElementById('livenessRing');
    if (ring) ring.classList.add('hidden');
    livenessHideSteps();
}

// ===== Bloqueo de 3 fallos seguidos, 2 minutos, por DNI =====
// Persistido en localStorage (no en una variable) para que recargar
// la página no sirva para esquivar el bloqueo.
function livenessLoadLockState() {
    try { return JSON.parse(localStorage.getItem(LIVENESS_LOCK_STORAGE_KEY) || '{}'); }
    catch (e) { return {}; }
}
function livenessSaveLockState(state) {
    try { localStorage.setItem(LIVENESS_LOCK_STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { /* localStorage lleno/no disponible: el bloqueo no persiste, no es crítico */ }
}
function isLivenessLocked(dni) {
    if (!dni) return null;
    const entry = livenessLoadLockState()[dni];
    return (entry && entry.lockUntil && entry.lockUntil > Date.now()) ? entry.lockUntil : null;
}
function registerLivenessFailure(dni) {
    if (!dni) return;
    const state = livenessLoadLockState();
    const entry = state[dni] || { fails: 0, lockUntil: null };
    entry.fails = (entry.fails || 0) + 1;
    if (entry.fails >= LIVENESS_MAX_FAILS) {
        entry.lockUntil = Date.now() + LIVENESS_LOCKOUT_MS;
        entry.fails = 0;
    }
    state[dni] = entry;
    livenessSaveLockState(state);
}
function resetLivenessFailures(dni) {
    if (!dni) return;
    const state = livenessLoadLockState();
    if (state[dni]) { delete state[dni]; livenessSaveLockState(state); }
}

let livenessLockInterval = null;
// Deshabilita "Identificarme" y muestra la cuenta regresiva mientras
// dure el bloqueo; se reactiva solo al vencer.
function livenessStartLockCountdown(dni) {
    const btn = document.querySelector('.teacher-camera-layout .btn-capture');
    if (livenessLockInterval) clearInterval(livenessLockInterval);
    const tick = () => {
        const lockUntil = isLivenessLocked(dni);
        if (!lockUntil) {
            clearInterval(livenessLockInterval);
            livenessLockInterval = null;
            if (btn) btn.disabled = false;
            livenessSetStatus('<i class="bi bi-info-circle"></i> Esperando identificación...', 'waiting');
            return;
        }
        if (btn) btn.disabled = true;
        const secs = Math.max(0, Math.ceil((lockUntil - Date.now()) / 1000));
        livenessSetStatus(`<i class="bi bi-shield-lock"></i> Fichaje bloqueado por seguridad (prueba de vida fallida 3 veces). Reintentá en ${secs}s.`, 'error');
    };
    tick();
    livenessLockInterval = setInterval(tick, 1000);
}

// Fichaje ya guardado -> se consume una sola vez (no debe quedar
// pegado a un fichaje futuro que no pasó por su propia prueba de
// vida). Se usa con spread: ...consumeLivenessFields().
function consumeLivenessFields() {
    if (!lastLivenessResult) return {};
    const fields = { liveness_passed: true, checks: lastLivenessResult };
    lastLivenessResult = null;
    return fields;
}

// Busca un parpadeo real (abierto -> cerrado (>=2 muestras seguidas)
// -> abierto de nuevo) en el historial reciente de EAR, con el
// "valle" completo en <=LIVENESS_BLINK_VALLEY_MAX_MS. history es un
// array de { t, ear } (las últimas ~20 muestras, ver
// LIVENESS_BLINK_HISTORY_SAMPLES). Devuelve { ms } si encuentra un
// valle válido, o null. Que dos frames sueltos bajen de 0.22 por
// ruido de detección (típico de una foto con reflejos/compresión) ya
// NO alcanza: hace falta el "abierto" de antes Y el "abierto" de
// después, dentro de la ventana de tiempo.
function findBlinkValley(history) {
    for (let i = 0; i < history.length; i++) {
        if (history[i].ear <= LIVENESS_BLINK_OPEN_EAR) continue; // ancla: un frame claramente "abierto"
        let j = i + 1;
        let closedStart = -1;
        let closedCount = 0;
        while (j < history.length && history[j].ear < LIVENESS_BLINK_CLOSED_EAR) {
            if (closedCount === 0) closedStart = j;
            closedCount++;
            j++;
        }
        if (closedCount < 2) continue; // necesita al menos 2 muestras seguidas "cerrado"
        for (let k = j; k < history.length; k++) {
            if (history[k].ear > LIVENESS_BLINK_OPEN_EAR) {
                const ms = history[k].t - history[closedStart].t;
                if (ms <= LIVENESS_BLINK_VALLEY_MAX_MS) return { ms };
                break; // reabrió pero tardó demasiado - no cuenta, sigue buscando otra ancla más adelante
            }
        }
    }
    return null;
}

// ============================================================
// Driver principal: "Mirá al frente" (fijo) -> 3 challenges al azar,
// en orden al azar (ver getRandomChallenges()), 8s de margen cada
// uno, cada uno con su propia base tomada al mostrar su cartel
// (time-gating). Devuelve { passed: true, checks } o
// { passed: false, reason }. video es el <video id="teacherVideo">
// ya en vivo.
// ============================================================
async function runLivenessCheck(video, dni) {
    let faceMesh;
    try {
        faceMesh = await loadLivenessModel();
    } catch (err) {
        console.error('No se pudo cargar el modelo de prueba de vida (MediaPipe Face Mesh):', err);
        // unavailable:true = problema de infraestructura (sin internet la
        // primera vez, CDN caído), no un intento de burlar la prueba de
        // vida - no debe sumar a las 3 fallas seguidas que bloquean el DNI.
        return { passed: false, unavailable: true, reason: '⚠️ No se pudo cargar el módulo de prueba de vida. Verificá tu conexión a internet.' };
    }

    const state = { multiFace: false, noseX: null, noseY: null, ear: null, ratios: null };
    faceMesh.onResults((results) => {
        const faces = results.multiFaceLandmarks || [];
        state.multiFace = faces.length > 1;
        if (faces.length >= 1 && video.videoWidth) {
            const lm = faces[0];
            const nose = livenessLandmarkPx(lm[LIVENESS_NOSE_TIP], video.videoWidth, video.videoHeight);
            state.noseX = nose.x;
            state.noseY = nose.y;
            const earL = computeEAR(lm, LIVENESS_LEFT_EYE, video.videoWidth, video.videoHeight);
            const earR = computeEAR(lm, LIVENESS_RIGHT_EYE, video.videoWidth, video.videoHeight);
            state.ear = (earL + earR) / 2;
            state.ratios = computeFaceRatios(lm, video.videoWidth, video.videoHeight);
        } else {
            state.noseX = null;
            state.noseY = null;
            state.ear = null;
            state.ratios = null;
        }
    });

    let running = true;
    let multiFaceStrikes = 0;
    let abortReason = null;

    (async function frameLoop() {
        while (running) {
            try { await faceMesh.send({ image: video }); } catch (e) { /* frame perdido, se reintenta en el próximo tick */ }
            await sleep(60); // ~15fps: de sobra para gestos de vida, sin ahogar el hilo principal
        }
    })();

    function multiFaceDetected() {
        if (state.multiFace) {
            multiFaceStrikes++;
            if (multiFaceStrikes >= 2) { // 2 frames seguidos: evita un falso positivo de un único frame ruidoso
                abortReason = '❌ Se detectó más de un rostro. Debe estar solo frente a la cámara.';
                return true;
            }
        } else {
            multiFaceStrikes = 0;
        }
        return false;
    }

    // Sondea `predicate` hasta que se cumpla o venza timeoutMs.
    // Devuelve 'ok' | 'timeout' | 'multiface'.
    async function waitFor(predicate, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        do {
            if (multiFaceDetected()) return 'multiface';
            if (predicate()) return 'ok';
            await sleep(80);
        } while (Date.now() < deadline);
        return 'timeout';
    }

    // ----- Challenges individuales: cada uno devuelve
    // { ok, abort?, detail? } - abort:true == se cortó por "más de
    // un rostro" (mensaje ya armado en abortReason). -----
    async function runBlinkChallenge(timeoutMs) {
        const history = [];
        let minEar = 1;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (multiFaceDetected()) return { ok: false, abort: true };
            if (state.ear != null) {
                minEar = Math.min(minEar, state.ear);
                history.push({ t: Date.now(), ear: state.ear });
                if (history.length > LIVENESS_BLINK_HISTORY_SAMPLES) history.shift();
                const valley = findBlinkValley(history);
                if (valley) return { ok: true, detail: { ear_value: Number(minEar.toFixed(2)), valley_ms: valley.ms } };
            }
            await sleep(80);
        }
        return { ok: false };
    }

    // Gesto medido como cambio RELATIVO (%) de un ratio contra su
    // base: para ratios que parten de un valor bien distinto de 0
    // (yaw/pitch/smile, todos ~0.7-1.3 en reposo).
    async function runRelativeRatioChallenge(ratioKey, baselineValue, minDeltaPct, timeoutMs) {
        const predicate = () => {
            if (!state.ratios || state.ratios[ratioKey] == null || !baselineValue) return false;
            const current = state.ratios[ratioKey];
            return Math.abs(current - baselineValue) / baselineValue > minDeltaPct;
        };
        const r = await waitFor(predicate, timeoutMs);
        if (r === 'multiface') return { ok: false, abort: true };
        if (r === 'timeout') return { ok: false };
        const current = state.ratios[ratioKey];
        return { ok: true, detail: { [`${ratioKey}_delta_pct`]: Number(((current - baselineValue) / baselineValue).toFixed(2)) } };
    }

    // Gesto medido como cambio ABSOLUTO de un ratio contra su base,
    // en el sentido `sign` (+1 = aumenta, -1 = disminuye): para ratios
    // que parten de una base cercana a 0 en reposo (boca cerrada,
    // cejas relajadas), donde un % contra ~0 es inestable/gameable.
    // debugLabel, si se pasa, loguea el ratio en vivo (throttleado a
    // ~400ms) para poder calibrar LIVENESS_*_DELTA mirando la consola.
    async function runAbsoluteRatioChallenge(ratioKey, baselineValue, minAbsDelta, sign, timeoutMs, debugLabel) {
        let lastLogAt = 0;
        const predicate = () => {
            if (!state.ratios || state.ratios[ratioKey] == null || baselineValue == null) return false;
            const delta = (state.ratios[ratioKey] - baselineValue) * sign;
            if (debugLabel && Date.now() - lastLogAt > 400) {
                lastLogAt = Date.now();
                console.log(`[liveness] ${debugLabel} ratioKey=${ratioKey} base=${baselineValue.toFixed(4)} actual=${state.ratios[ratioKey].toFixed(4)} delta(signo aplicado)=${delta.toFixed(4)} umbral=${minAbsDelta}`);
            }
            return delta > minAbsDelta;
        };
        const r = await waitFor(predicate, timeoutMs);
        if (r === 'multiface') return { ok: false, abort: true };
        if (r === 'timeout') return { ok: false };
        const current = state.ratios[ratioKey];
        return { ok: true, detail: { [`${ratioKey}_delta`]: Number((current - baselineValue).toFixed(3)) } };
    }

    async function runChallenge(type, baseline, timeoutMs) {
        switch (type) {
            case 'BLINK':
                return runBlinkChallenge(timeoutMs);
            case 'TURN_LEFT':
            case 'TURN_RIGHT':
                return runRelativeRatioChallenge('yaw', baseline.yaw, LIVENESS_YAW_RATIO_DELTA, timeoutMs);
            case 'LOOK_UP':
            case 'LOOK_DOWN':
                return runRelativeRatioChallenge('pitch', baseline.pitch, LIVENESS_PITCH_RATIO_DELTA, timeoutMs);
            case 'SMILE':
                return runRelativeRatioChallenge('smile', baseline.smile, LIVENESS_SMILE_RATIO_DELTA, timeoutMs);
            case 'MOUTH_OPEN':
                return runAbsoluteRatioChallenge('mouthOpen', baseline.mouthOpen, LIVENESS_MOUTH_OPEN_DELTA, 1, timeoutMs, 'MOUTH_OPEN');
            case 'EYEBROWS_UP':
                return runAbsoluteRatioChallenge('brow', baseline.brow, LIVENESS_BROW_DELTA, 1, timeoutMs, 'EYEBROWS_UP');
            case 'FROWN':
                // Antes reusaba el mismo ratio que EYEBROWS_UP (105/334,
                // arco medio de la ceja) solo con el signo invertido - ese
                // punto casi no se mueve al fruncir, por eso nunca
                // detectaba. Ahora usa browInner (55/285, extremo interno
                // de cada ceja, cerca de la glabela): fruncir el ceño las
                // junta de verdad (músculo corrugador), así que esa
                // distancia SÍ baja de forma medible.
                return runAbsoluteRatioChallenge('browInner', baseline.browInner, LIVENESS_BROW_INNER_DELTA, -1, timeoutMs, 'FROWN');
            default:
                return { ok: false };
        }
    }

    try {
        // ===== Mirá al frente (fijo, no se sortea): fija los ratios
        // base y de paso chequea que la cara no esté sospechosamente
        // quieta (ver LIVENESS_STATIC_MOVE_EPSILON_PX) =====
        livenessSetRing(null);
        const ring = document.getElementById('livenessRing');
        if (ring) ring.classList.remove('hidden');
        livenessPrompt('FRONT');

        let r = await waitFor(() => state.noseX != null && state.ratios != null, LIVENESS_FACE_WAIT_TIMEOUT_MS);
        if (r === 'multiface') throw new Error(abortReason);
        if (r === 'timeout') throw new Error('❌ No se detectó ningún rostro. Ubicate frente a la cámara con buena iluminación.');

        // Mantiene el rostro estable un instante, midiendo cuánto se
        // mueve de verdad la nariz cuadro a cuadro (micro-temblor de
        // una persona real) antes de fijar la base de los ratios.
        const holdSamples = [];
        const holdDeadline = Date.now() + LIVENESS_CENTER_HOLD_MS;
        while (Date.now() < holdDeadline) {
            if (multiFaceDetected()) throw new Error(abortReason);
            if (state.noseX != null) holdSamples.push({ x: state.noseX, y: state.noseY });
            await sleep(80);
        }
        if (holdSamples.length >= 3) {
            let totalMove = 0;
            for (let i = 1; i < holdSamples.length; i++) totalMove += livenessDist(holdSamples[i - 1], holdSamples[i]);
            if (totalMove < LIVENESS_STATIC_MOVE_EPSILON_PX) {
                throw new Error('❌ Rostro sospechosamente estático (sin micro-movimiento natural). Prueba de vida fallida - posible foto.');
            }
        }
        if (!state.ratios) throw new Error('❌ Se perdió el rostro. Ubicate frente a la cámara con buena iluminación.');

        // ===== 3 challenges al azar (Nivel 2: pool de 9, orden
        // imprevisible - no sirve un video grabado de un fichaje
        // anterior). Cada uno toma su PROPIA base recién al mostrar
        // su cartel (time-gating: ver comentario grande arriba). =====
        const challenges = getRandomChallenges();
        livenessRenderSteps(challenges);
        const details = {};
        for (let i = 0; i < challenges.length; i++) {
            const type = challenges[i];
            if (!state.ratios) throw new Error('❌ Se perdió el rostro. Ubicate frente a la cámara con buena iluminación.');
            const challengeBaseline = { ...state.ratios };
            livenessSetActiveStepIndex(i);
            livenessPrompt(type);
            const result = await runChallenge(type, challengeBaseline, LIVENESS_CHALLENGE_TIMEOUT_MS);
            if (!result.ok) {
                if (result.abort) throw new Error(abortReason);
                throw new Error(`❌ Prueba de vida fallida - posible foto (${LIVENESS_CHALLENGE_CHIP_LABEL[type]} no detectado a tiempo)`);
            }
            details[type] = result.detail;
        }

        livenessSetActiveStepIndex(challenges.length);
        livenessSetRing('ok');
        livenessSetStatus('<i class="bi bi-shield-check"></i> Prueba de vida OK', 'success');
        return { passed: true, checks: { challenges, details } };
    } catch (err) {
        livenessSetRing('fail');
        return { passed: false, reason: err.message || '❌ Prueba de vida fallida' };
    } finally {
        running = false;
        try { faceMesh.onResults(() => {}); } catch (e) { /* instancia ya liberada */ }
        try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) { /* no soportado */ }
        setTimeout(livenessReset, 600); // deja ver el anillo verde/rojo un instante antes de ocultarlo
    }
}
