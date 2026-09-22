// ============================================================
// ASISCAM PRO - Diccionario ES (español, idioma base/fallback)
//
// Mismo patrón que config.secrets.js/presencia-logic.js: script
// clásico (no JSON + fetch) para que ande offline con el service
// worker sin cambios y sin flash de contenido sin traducir en el
// primer render. Se carga ANTES que i18n.js en index.html.
//
// Cobertura de esta primera pasada ("núcleo"): Login, Header, Fichaje
// con foto (Entrada/Salida/Retirada + modal de registro), y Esperados
// Hoy (incluye Eventos Especiales CON/SIN perjuicio). El resto de la
// app (Docentes, Materias, Eventos admin, Reportes, Auditoría, y los
// toasts de error en general) queda en español fijo por ahora - ver
// nota en i18n.js: t() cae a este mismo diccionario si una clave no
// existe en el idioma activo, así que nunca se rompe nada, solo queda
// sin traducir hasta una segunda pasada.
// ============================================================
window.ASISCAM_I18N = window.ASISCAM_I18N || {};
window.ASISCAM_I18N.es = {
    login: {
        title: 'ASIS-CAM',
        subtitle: 'Control de Asistencia Docente',
        chooseRole: '¿Cómo querés ingresar?',
        changeRole: 'Cambiar rol',
        enteringAs: 'Ingresando como',
        userLabelDefault: 'Usuario',
        userLabelDocente: 'Usuario (DNI)',
        userPlaceholderDefault: 'Ingresa tu usuario',
        userPlaceholderDocente: 'Ingresa tu DNI',
        passwordLabel: 'Contraseña',
        passwordPlaceholder: 'Ingresa tu contraseña',
        errorCredentials: 'Usuario o contraseña incorrectos',
        submit: 'Ingresar',
        forgotPassword: '¿Olvidaste tu contraseña?',
    },
    roles: {
        DOCENTE: 'Docente',
        SECRETARIA: 'Secretaría',
        RECTOR: 'Rector',
        PROGRAMADOR: 'Programador',
    },
    header: {
        logout: 'Salir',
        welcome: 'Bienvenido,',
        panelOf: 'Panel de',
    },
    fichaje: {
        loadingModels: 'Cargando módulo de reconocimiento facial...',
        waitingId: 'Esperando identificación...',
        identify: 'Identificarme',
        entry: 'Entrada',
        exit: 'Salida',
        earlyExit: 'Salir antes de tiempo',
        hint: 'Tocá "Identificarme" antes de cada registro (entrada, salida o retirada).',
        advancedOptions: 'Opciones avanzadas',
        kioskAuthorizePrompt: '¿Es esta la PC de la escuela? Autorizar con código',
        kioskCodePlaceholder: 'Código de 6 dígitos',
        authorize: 'Autorizar',
        hello: '¡Hola {name}!',
        whatToRegister: '¿Qué deseas registrar?',
        registerEntry: 'REGISTRAR INGRESO',
        registerExit: 'REGISTRAR SALIDA',
        registerEntryEvent: 'REGISTRAR INGRESO A EVENTO',
        registerExitEvent: 'REGISTRAR SALIDA DE EVENTO',
        notMeCancel: 'No soy yo / Cancelar',
        alreadyDoneTodayFull: 'Ya completaste tu registro de hoy (cátedra y eventos especiales).',
        alreadyDoneToday: 'Ya completaste tu registro de hoy (ingreso y salida).',
        close: 'Cerrar',
        specialEventsToday: 'Eventos especiales de hoy',
    },
    stats: {
        totalTeachers: 'Total Docentes',
        expectedToday: 'Esperados Hoy',
        presentToday: 'Presentes Hoy',
        absentToday: 'Ausentes Hoy',
        lateToday: 'Tardanzas Hoy',
        halfAbsentToday: 'Media Falta Hoy',
    },
    esperadosHoy: {
        title: 'Docentes que deberían presentarse hoy',
        noTeachers: 'No hay docentes con clase asignada hoy.',
        checkedIn: 'fichó',
        outOfSchedule: '(fuera de horario)',
        event: 'Evento',
        conPerjuicio: 'CON perjuicio',
        sinPerjuicio: 'SIN perjuicio',
        conflict: 'CONFLICTO',
        conflictWarning: 'CONFLICTO DE HORARIO: este docente tiene otra materia superpuesta el mismo día/horario. Corregí en Materias.',
    },
    semaforo: {
        esperado: 'Esperado',
        presente: 'Presente',
        tardanza: 'Tardanza',
        media_falta: 'Media Falta',
        ausente: 'Ausente',
    },
};
