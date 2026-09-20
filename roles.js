// ============================================================
// ASISCAM PRO - Sistema de roles y permisos
// roles.js - Script clásico (no ES module, igual que script.js) para
// que ROLES/tienePermiso() queden expuestos en window y disponibles
// tanto para script.js como para los onclick= del HTML.
//
// 4 roles: DOCENTE, SECRETARIA (ADMIN1), RECTOR (ADMIN2) y
// PROGRAMADOR (MEUDEUS).
//
// Las contraseñas de Secretaría y Rector son fijas, pero NO viven acá
// en texto plano: este archivo se commitea a git, así que solo guarda
// el usuario (que no es secreto) y compara contra un HASH SHA-256 que
// carga config.secrets.js (gitignored) o, si ese archivo no existe,
// config.example.js en modo demo (ver ambos y index.html, que los
// carga ANTES que este archivo).
//
// El Programador es un caso especial: su contraseña del día a día vive
// en la fila única de la tabla `usuarios` de Supabase (adminUsuario en
// script.js) y se puede cambiar/recuperar por mail como antes - eso
// nunca estuvo en texto plano en el código. PROGRAMADOR_BOOTSTRAP acá
// es solo el hash de arranque para el primer login, antes de que
// exista esa fila (ver login() en script.js).
// ============================================================

const ROLES = {
    DOCENTE: 'DOCENTE',
    SECRETARIA: 'SECRETARIA',
    RECTOR: 'RECTOR',
    PROGRAMADOR: 'PROGRAMADOR',
};

// Usuarios de login fijos (no son secretos, solo la contraseña lo es).
const CREDENCIALES_ADMIN_USUARIO = {
    [ROLES.SECRETARIA]: 'ADMIN1',
    [ROLES.RECTOR]: 'ADMIN2',
};

const PROGRAMADOR_LOGIN_USER = 'MEUDEUS';

// SHA-256 del texto ingresado, en hexadecimal, usando la Web Crypto
// API del navegador (requiere HTTPS o localhost). "Simple" a propósito
// - pedido así -: sin sal ni iteraciones, un solo hash.
async function sha256Hex(texto) {
    const bytes = new TextEncoder().encode(texto);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Compara una contraseña ingresada contra el hash cargado para ese rol
// (window.ASISCAM_CRED_HASHES, ver config.secrets.js/config.example.js).
async function coincideHashCredencial(rol, passwordIngresada) {
    const hashes = window.ASISCAM_CRED_HASHES;
    if (!hashes || !hashes[rol]) return false;
    const hashIngresado = await sha256Hex(passwordIngresada);
    return hashIngresado === hashes[rol];
}

// Muestra el cartel de modo demo si config.secrets.js no estaba
// presente (ver config.example.js). Se ejecuta acá directo, sin
// esperar DOMContentLoaded, porque roles.js se carga al final del
// <body> (el HTML de arriba ya existe en el DOM en ese momento).
if (window.ASISCAM_DEMO_MODE) {
    const banner = document.getElementById('demoModeBanner');
    if (banner) banner.style.display = 'block';
}

// Matriz de permisos: cada acción lista los roles que pueden hacerla.
// SECRETARIA puede agregar/editar/blanquear password pero no borrar
// ni tocar geocerca. RECTOR suma borrado + geocerca. PROGRAMADOR suma
// auditoría, ver claves y backup/restore.
const MATRIZ_PERMISOS = {
    ver_docentes: [ROLES.SECRETARIA, ROLES.RECTOR, ROLES.PROGRAMADOR],
    agregar_docente: [ROLES.SECRETARIA, ROLES.RECTOR, ROLES.PROGRAMADOR],
    editar_docente: [ROLES.SECRETARIA, ROLES.RECTOR, ROLES.PROGRAMADOR],
    blanquear_password: [ROLES.SECRETARIA, ROLES.RECTOR, ROLES.PROGRAMADOR],
    fichaje_manual: [ROLES.SECRETARIA, ROLES.RECTOR, ROLES.PROGRAMADOR],
    // Exclusivo Rector: Secretaría solo puede mandar una alerta a
    // aprobación de Rectoría (ver justifyAlert() en script.js), nunca
    // resolverla ella misma; Programador tampoco justifica.
    justificar_alerta: [ROLES.RECTOR],
    // Reportes/PDF: exclusivo Rector (Secretaría no reporta, Programador
    // no ve datos reales sin autorización de Rectoría).
    ver_reportes: [ROLES.RECTOR],
    exportar_reportes: [ROLES.RECTOR],
    // Solo Rector y Programador pueden borrar (docentes, licencias,
    // eventos) y tocar el punto geográfico (geocerca de la escuela o
    // de un evento especial).
    borrar: [ROLES.RECTOR, ROLES.PROGRAMADOR],
    editar_geo: [ROLES.RECTOR, ROLES.PROGRAMADOR],
    // Exclusivo Programador.
    ver_claves: [ROLES.PROGRAMADOR],
    // Auditoría: Rector y Programador la leen; solo Programador puede
    // borrar/gestionar el log (ver gestionar_auditoria).
    ver_auditoria: [ROLES.RECTOR, ROLES.PROGRAMADOR],
    gestionar_auditoria: [ROLES.PROGRAMADOR],
    backup_restore: [ROLES.PROGRAMADOR],
};

function tienePermiso(rol, accion) {
    const permitidos = MATRIZ_PERMISOS[accion];
    return !!permitidos && permitidos.includes(rol);
}

// Mensaje amigable para cuando se bloquea un botón/acción por falta
// de permiso, del estilo "No tenés permiso - solo Rector" pedido.
function mensajeSinPermiso(accion) {
    const permitidos = MATRIZ_PERMISOS[accion] || [];
    if (permitidos.length === 1 && permitidos[0] === ROLES.PROGRAMADOR) {
        return 'No tenés permiso - solo el Programador';
    }
    if (permitidos.includes(ROLES.RECTOR) && !permitidos.includes(ROLES.SECRETARIA)) {
        return 'No tenés permiso - solo Rector';
    }
    return 'No tenés permiso para realizar esta acción';
}

// Nombre lindo para mostrar en badges/encabezados.
const ROL_LABEL = {
    [ROLES.DOCENTE]: 'Docente',
    [ROLES.SECRETARIA]: 'Secretaría',
    [ROLES.RECTOR]: 'Rector',
    [ROLES.PROGRAMADOR]: 'Programador',
};
