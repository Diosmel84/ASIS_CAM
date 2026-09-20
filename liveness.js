// ============================================================
// ASISCAM PRO - Prueba de vida / Anti-Spoofing (Nivel 1+2) del
// fichaje facial. Script clásico (igual que roles.js/auditoria.js),
// se carga después de script.js en index.html.
//
// Corre DENTRO de detectFace() (ver script.js), justo después de la
// geocerca y ANTES de comparar el rostro con el descriptor guardado:
// exige una cabeza real moviéndose en 3D (gira levemente) y ojos que
// parpadean de verdad (Eye Aspect Ratio), para que una foto de un
// celular no alcance para fichar. Usa MediaPipe Face Mesh (CDN, ver
// index.html) en vez de face-api.js para esto: más liviano, y de
// paso el mismo modelo (con maxNumFaces:2) sirve para detectar
// "más de un rostro" sin sumar un modelo de Face Detection aparte.
//
// NOTA: a diferencia de face-api.js (modelos vendorizados en /models
// para funcionar offline), Face Mesh se trae de un CDN - la prueba
// de vida necesita internet la primera vez que se usa en cada
// dispositivo (el navegador cachea el WASM/modelo después de eso).
//
// Fichaje guardado (ver consumeLivenessFields(), usado en
// registerAttendance()/registerFaceEventoAttendance() de script.js):
//   { liveness_passed: true, checks: { head_turn: true, blink: true, ear_value: 0.19, head_turn_px: 22 } }
// ============================================================

const LIVENESS_HEAD_TURN_PX = 15;
const LIVENESS_HEAD_TURN_TIMEOUT_MS = 4000;
const LIVENESS_BLINK_EAR_THRESHOLD = 0.22;
const LIVENESS_BLINK_TIMEOUT_MS = 5000;
const LIVENESS_FACE_WAIT_TIMEOUT_MS = 15000;
const LIVENESS_CENTER_HOLD_MS = 700;
const LIVENESS_MAX_FAILS = 3;
const LIVENESS_LOCKOUT_MS = 2 * 60 * 1000;
const LIVENESS_LOCK_STORAGE_KEY = 'asiscam_liveness_lock';

// Malla de 468 puntos de MediaPipe Face Mesh. Punta de la nariz +
// mapeo estándar de 6 puntos por ojo para la fórmula EAR (Eye Aspect
// Ratio, Soukupová & Čech) adaptada a los índices de Face Mesh.
const LIVENESS_NOSE_TIP = 1;
const LIVENESS_LEFT_EYE = [33, 160, 158, 133, 153, 144];
const LIVENESS_RIGHT_EYE = [362, 385, 387, 263, 373, 380];

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

// ===== UI: anillo guía + pasos 1/3-2/3-3/3 (ver #livenessRing y
// #livenessSteps en index.html, camera-container del docente) =====
function livenessSetRing(state) {
    const ring = document.getElementById('livenessRing');
    if (!ring) return;
    ring.classList.remove('hidden', 'ok', 'fail');
    if (state === 'ok') ring.classList.add('ok');
    else if (state === 'fail') ring.classList.add('fail');
}

function livenessSetStep(stepKey) {
    const order = ['mirando', 'girando', 'parpadeo', 'ok'];
    const wrap = document.getElementById('livenessSteps');
    if (!wrap) return;
    wrap.classList.toggle('hidden', !stepKey);
    if (!stepKey) return;
    const idx = order.indexOf(stepKey);
    wrap.querySelectorAll('.liveness-step').forEach(el => {
        const i = order.indexOf(el.dataset.step);
        el.classList.toggle('active', i === idx);
        el.classList.toggle('done', i >= 0 && i < idx);
    });
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
    livenessSetStep(null);
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

// ============================================================
// Driver principal: "Mire al centro" -> "Gire levemente" -> "Ahora
// parpadee". Devuelve { passed: true, checks } o { passed: false,
// reason }. video es el <video id="teacherVideo"> ya en vivo.
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

    const state = { multiFace: false, noseX: null, ear: null };
    faceMesh.onResults((results) => {
        const faces = results.multiFaceLandmarks || [];
        state.multiFace = faces.length > 1;
        if (faces.length >= 1 && video.videoWidth) {
            const lm = faces[0];
            state.noseX = lm[LIVENESS_NOSE_TIP].x * video.videoWidth;
            const earL = computeEAR(lm, LIVENESS_LEFT_EYE, video.videoWidth, video.videoHeight);
            const earR = computeEAR(lm, LIVENESS_RIGHT_EYE, video.videoWidth, video.videoHeight);
            state.ear = (earL + earR) / 2;
        } else {
            state.noseX = null;
            state.ear = null;
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

    try {
        // ===== Paso 1/3: Mire al centro =====
        livenessSetRing(null);
        const ring = document.getElementById('livenessRing');
        if (ring) ring.classList.remove('hidden');
        livenessSetStep('mirando');
        livenessSetStatus('<i class="bi bi-person-bounding-box"></i> Mire al centro', 'processing');

        let r = await waitFor(() => state.noseX != null, LIVENESS_FACE_WAIT_TIMEOUT_MS);
        if (r === 'multiface') throw new Error(abortReason);
        if (r === 'timeout') throw new Error('❌ No se detectó ningún rostro. Ubicate frente a la cámara con buena iluminación.');
        // Mantiene el rostro estable un instante antes de fijar la
        // posición base contra la que se va a medir el giro.
        r = await waitFor(() => false, LIVENESS_CENTER_HOLD_MS);
        if (r === 'multiface') throw new Error(abortReason);

        // ===== Paso 2/3: Gire levemente la cabeza =====
        livenessSetStep('girando');
        livenessSetStatus('<i class="bi bi-arrow-left-right"></i> Gire levemente la cabeza hacia un costado', 'processing');
        const baselineX = state.noseX;
        r = await waitFor(() => state.noseX != null && Math.abs(state.noseX - baselineX) > LIVENESS_HEAD_TURN_PX, LIVENESS_HEAD_TURN_TIMEOUT_MS);
        if (r === 'multiface') throw new Error(abortReason);
        if (r === 'timeout') throw new Error('❌ No se detectó movimiento de cabeza. Prueba de vida fallida - posible foto.');
        const headTurnPx = Math.round(Math.abs(state.noseX - baselineX));

        // ===== Paso 3/3: Parpadeo (EAR) =====
        livenessSetStep('parpadeo');
        livenessSetStatus('<i class="bi bi-eye"></i> Ahora parpadee', 'processing');
        let belowFrames = 0;
        let minEar = 1;
        let blinkOk = false;
        const blinkDeadline = Date.now() + LIVENESS_BLINK_TIMEOUT_MS;
        while (Date.now() < blinkDeadline) {
            if (multiFaceDetected()) throw new Error(abortReason);
            if (state.ear != null) {
                minEar = Math.min(minEar, state.ear);
                if (state.ear < LIVENESS_BLINK_EAR_THRESHOLD) {
                    belowFrames++;
                    if (belowFrames >= 2) { blinkOk = true; break; }
                } else {
                    belowFrames = 0;
                }
            }
            await sleep(80);
        }
        if (!blinkOk) throw new Error('❌ Prueba de vida fallida - posible foto');

        livenessSetStep('ok');
        livenessSetRing('ok');
        livenessSetStatus('<i class="bi bi-shield-check"></i> Prueba de vida OK', 'success');
        return {
            passed: true,
            checks: { head_turn: true, blink: true, ear_value: Number(minEar.toFixed(2)), head_turn_px: headTurnPx },
        };
    } catch (err) {
        livenessSetRing('fail');
        return { passed: false, reason: err.message || '❌ Prueba de vida fallida' };
    } finally {
        running = false;
        try { faceMesh.onResults(() => {}); } catch (e) { /* instancia ya liberada */ }
        setTimeout(livenessReset, 600); // deja ver el anillo verde/rojo un instante antes de ocultarlo
    }
}
