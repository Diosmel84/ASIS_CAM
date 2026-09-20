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
// Challenges (ver getRandomChallenges()): en cada fichaje se eligen
// 2 o 3 al azar, en orden al azar, de este set:
//   BLINK, TURN_LEFT, TURN_RIGHT, SMILE, LOOK_UP
//
// IMPORTANTE - por qué los gestos se miden con RATIOS y no con
// píxeles sueltos (fix de una vulnerabilidad real, ver historial de
// commits): la primera versión medía "¿la nariz se movió >15px?" o
// "¿la boca se hizo un 15% más ancha?" en píxeles crudos. Eso lo
// pasaba una FOTO en otro celular con solo acercarla o correrla con
// la mano frente a la cámara - mover o acercar una imagen plana
// cambia esos píxeles exactamente igual que un gesto real. La
// solución: normalizar cada medida contra otra distancia de la
// misma cara (yaw = nariz-a-ojo izquierdo / nariz-a-ojo derecho,
// sonrisa = ancho de boca / distancia entre ojos, etc.). Trasladar o
// escalar una imagen plana no cambia esos RATIOS (las dos distancias
// se mueven/escalan juntas y se cancelan); solo una rotación o
// deformación 3D real de una cara (o un gesto real de la boca) los
// cambia. Ver computeFaceRatios().
//
// NOTA: a diferencia de face-api.js (modelos vendorizados en /models
// para funcionar offline), Face Mesh se trae de un CDN - la prueba
// de vida necesita internet la primera vez que se usa en cada
// dispositivo (el navegador cachea el WASM/modelo después de eso).
//
// Fichaje guardado (ver consumeLivenessFields(), usado en
// registerAttendance()/registerFaceEventoAttendance() de script.js):
//   { liveness_passed: true, checks: { challenges: ['TURN_RIGHT','BLINK'],
//     details: { TURN_RIGHT: { yaw_delta_pct: 0.31 }, BLINK: { ear_value: 0.19, valley_ms: 340 } } } }
// ============================================================

const LIVENESS_CHALLENGE_TYPES = ['BLINK', 'TURN_LEFT', 'TURN_RIGHT', 'SMILE', 'LOOK_UP'];
const LIVENESS_CHALLENGE_TIMEOUT_MS = 8000; // por challenge, según lo pedido
const LIVENESS_MIN_CHALLENGES = 2;
const LIVENESS_MAX_CHALLENGES = 3;
// Cambio relativo mínimo del ratio (ver computeFaceRatios) contra la
// base tomada en "Mirá al frente" para contar un gesto como real.
const LIVENESS_YAW_RATIO_DELTA = 0.15;   // TURN_LEFT/TURN_RIGHT
const LIVENESS_PITCH_RATIO_DELTA = 0.15; // LOOK_UP
const LIVENESS_SMILE_RATIO_DELTA = 0.15; // SMILE
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

// Malla de 468 puntos de MediaPipe Face Mesh. Set de 6 puntos
// "canónicos" que se usan en casi cualquier estimación de pose de
// cabeza a partir de Face Mesh (nariz, mentón, comisuras de ojos y
// de boca) + el mapeo estándar de 6 puntos por ojo para la fórmula
// EAR (Eye Aspect Ratio, Soukupová & Čech).
const LIVENESS_NOSE_TIP = 1;
const LIVENESS_CHIN = 152;
const LIVENESS_FOREHEAD = 10;
const LIVENESS_EYE_OUTER_LEFT = 33;
const LIVENESS_EYE_OUTER_RIGHT = 263;
const LIVENESS_MOUTH_LEFT = 61;
const LIVENESS_MOUTH_RIGHT = 291;
const LIVENESS_LEFT_EYE = [33, 160, 158, 133, 153, 144];
const LIVENESS_RIGHT_EYE = [362, 385, 387, 263, 373, 380];

// Consignas en pantalla (voseo, cortas, para que entren bien en el
// cartel que titila - ver .face-recognition-status.liveness-prompt
// en style.css) y etiqueta corta para el chip de progreso.
const LIVENESS_CHALLENGE_PROMPT = {
    BLINK: '<i class="bi bi-eye"></i> Parpadeá',
    TURN_LEFT: '<i class="bi bi-arrow-left"></i> Girá la cabeza a la izquierda',
    TURN_RIGHT: '<i class="bi bi-arrow-right"></i> Girá la cabeza a la derecha',
    SMILE: '<i class="bi bi-emoji-smile"></i> Sonreí',
    LOOK_UP: '<i class="bi bi-arrow-up"></i> Mirá hacia arriba',
};
const LIVENESS_CHALLENGE_CHIP_LABEL = {
    BLINK: 'Parpadeo',
    TURN_LEFT: 'Girar izq.',
    TURN_RIGHT: 'Girar der.',
    SMILE: 'Sonreír',
    LOOK_UP: 'Mirar arriba',
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

// Todas las medidas "de gesto" (yaw/pitch/sonrisa) como RATIOS entre
// dos distancias de la propia cara, nunca como un desplazamiento en
// píxeles sueltos: eso es lo que hace que mover o acercar una foto
// no alcance para simular un gesto (ver comentario grande arriba del
// archivo). videoW/videoH solo se usan para pasar los landmarks
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

    const eyeDist = livenessDist(eyeL, eyeR); // referencia de escala de la cara (invariante a acercar/alejar la foto)
    const noseToEyeL = livenessDist(nose, eyeL);
    const noseToEyeR = livenessDist(nose, eyeR);
    const noseToForehead = livenessDist(nose, forehead);
    const noseToChin = livenessDist(nose, chin);
    const mouthWidth = livenessDist(mouthL, mouthR);

    return {
        eyeDist,
        // yaw: al girar la cabeza, un lado se acerca a la nariz en la
        // proyección 2D y el otro se aleja - trasladar una foto plana
        // no cambia esta relación, solo una rotación real lo hace.
        yaw: noseToEyeR > 0 ? noseToEyeL / noseToEyeR : null,
        pitch: noseToChin > 0 ? noseToForehead / noseToChin : null,
        // sonrisa normalizada contra el ancho de ojos: así acercar la
        // foto (que agranda TODO por igual, boca incluida) no cuenta
        // como sonrisa, solo un ensanchamiento real de la boca.
        smile: eyeDist > 0 ? mouthWidth / eyeDist : null,
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

// 2 o 3 challenges al azar, en orden al azar. Se llama una vez por
// cada intento de fichaje (cada detectFace() -> runLivenessCheck()),
// así que dos intentos seguidos casi nunca piden lo mismo en el
// mismo orden.
function getRandomChallenges() {
    const n = Math.random() < 0.5 ? LIVENESS_MIN_CHALLENGES : LIVENESS_MAX_CHALLENGES;
    return shuffleArray(LIVENESS_CHALLENGE_TYPES).slice(0, n);
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
// Driver principal: "Mirá al frente" -> 2 o 3 challenges al azar,
// en orden al azar (ver getRandomChallenges()), 8s de margen cada
// uno. Devuelve { passed: true, checks } o { passed: false, reason }.
// video es el <video id="teacherVideo"> ya en vivo.
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

    // Gesto medido como cambio relativo de un ratio contra su base
    // (ver computeFaceRatios): invariante a que el atacante acerque o
    // traslade una foto, a diferencia de un desplazamiento en píxeles.
    async function runRatioChallenge(ratioKey, baselineValue, minDeltaPct, timeoutMs) {
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

    async function runChallenge(type, baseline, timeoutMs) {
        switch (type) {
            case 'BLINK':
                return runBlinkChallenge(timeoutMs);
            case 'TURN_LEFT':
            case 'TURN_RIGHT':
                // Igual que antes: acepta el giro en cualquier sentido - la
                // cámara no está espejada, así que "izquierda/derecha" en
                // pantalla no siempre coincide con la anatómica de quien
                // gira. Lo que importa es que el ratio de yaw cambie de
                // verdad (giro real en 3D), no en qué sentido.
                return runRatioChallenge('yaw', baseline.yaw, LIVENESS_YAW_RATIO_DELTA, timeoutMs);
            case 'LOOK_UP':
                return runRatioChallenge('pitch', baseline.pitch, LIVENESS_PITCH_RATIO_DELTA, timeoutMs);
            case 'SMILE':
                return runRatioChallenge('smile', baseline.smile, LIVENESS_SMILE_RATIO_DELTA, timeoutMs);
            default:
                return { ok: false };
        }
    }

    try {
        // ===== Mirá al frente: fija los ratios base y de paso chequea
        // que la cara no esté sospechosamente quieta (ver
        // LIVENESS_STATIC_MOVE_EPSILON_PX) =====
        livenessSetRing(null);
        const ring = document.getElementById('livenessRing');
        if (ring) ring.classList.remove('hidden');
        livenessSetStatus('<i class="bi bi-person-bounding-box"></i> Mirá al frente', 'liveness-prompt');

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
        const baseline = { yaw: state.ratios.yaw, pitch: state.ratios.pitch, smile: state.ratios.smile };

        // ===== Challenges al azar (Nivel 2: orden/set imprevisible,
        // no sirve un video grabado de un fichaje anterior) =====
        const challenges = getRandomChallenges();
        livenessRenderSteps(challenges);
        const details = {};
        for (let i = 0; i < challenges.length; i++) {
            const type = challenges[i];
            livenessSetActiveStepIndex(i);
            livenessSetStatus(LIVENESS_CHALLENGE_PROMPT[type], 'liveness-prompt');
            const result = await runChallenge(type, baseline, LIVENESS_CHALLENGE_TIMEOUT_MS);
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
        setTimeout(livenessReset, 600); // deja ver el anillo verde/rojo un instante antes de ocultarlo
    }
}
