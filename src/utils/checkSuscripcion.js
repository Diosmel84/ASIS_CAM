// ============================================================
// ASISCAM PRO - Bloqueo por pago (suscripción vencida)
//
// Este proyecto es un sitio estático sin build (ver package.json),
// así que este archivo es un <script> clásico más, no un módulo
// ES import/export: se carga con <script src="src/utils/
// checkSuscripcion.js"> DESPUÉS de script.js en index.html, y
// reutiliza el cliente `sb` (Supabase) y la constante SOPORTE_EMAIL
// que script.js ya deja en el scope global compartido entre
// <script> clásicos.
//
// Este proyecto es de una sola escuela (sin multi-tenant todavía),
// así que se chequea una única fila global en `suscripciones`
// (la primera que exista, ver supabase-schema.sql). Si la tabla
// está vacía (todavía no cargaste ninguna suscripción), NO se
// bloquea la app: se asume que el bloqueo por pago está desactivado
// hasta que exista al menos una fila. Esto evita dejar a todo el
// mundo afuera por defecto en una tabla recién creada y vacía.
// ============================================================

async function checkSuscripcion() {
    if (typeof sb === 'undefined' || !sb) {
        console.warn('checkSuscripcion: no hay cliente de Supabase, se omite el chequeo de suscripción.');
        return;
    }
    try {
        const { data, error } = await sb
            .from('suscripciones')
            .select('*')
            .order('id', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error('checkSuscripcion: no se pudo consultar la tabla suscripciones', error);
            return;
        }
        if (!data) {
            console.warn('checkSuscripcion: la tabla suscripciones está vacía, bloqueo por pago desactivado.');
            return;
        }

        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        const vencimiento = new Date(data.fecha_vencimiento + 'T00:00:00');

        if (vencimiento < hoy) {
            mostrarPantallaSuscripcionVencida(data);
        }
    } catch (e) {
        console.error('checkSuscripcion: error inesperado', e);
    }
}

function mostrarPantallaSuscripcionVencida(suscripcion) {
    if (document.getElementById('suscripcionVencidaOverlay')) return;

    const soporte = (typeof SOPORTE_EMAIL !== 'undefined' && SOPORTE_EMAIL) ? SOPORTE_EMAIL : 'maximilianoempleo@gmail.com';
    const overlay = document.createElement('div');
    overlay.id = 'suscripcionVencidaOverlay';
    overlay.innerHTML = `
        <div class="suscripcion-vencida-card">
            <div class="suscripcion-vencida-icon"><i class="bi bi-exclamation-circle"></i></div>
            <h1>Suscripción vencida</h1>
            <p>Tu plan ASISCAM PRO venció el <strong>${formatearFecha(suscripcion.fecha_vencimiento)}</strong>. Para seguir usando el sistema, renová tu suscripción.</p>
            <a class="btn btn-primary suscripcion-vencida-btn" href="mailto:${soporte}?subject=${encodeURIComponent('Renovar suscripción ASISCAM PRO')}">
                <i class="bi bi-envelope"></i> Contactar
            </a>
        </div>
    `;
    document.body.appendChild(overlay);
}

function formatearFecha(fechaISO) {
    const [anio, mes, dia] = fechaISO.split('-');
    return `${dia}/${mes}/${anio}`;
}

document.addEventListener('DOMContentLoaded', function () {
    checkSuscripcion();
});
