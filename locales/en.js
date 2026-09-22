// ============================================================
// ASISCAM PRO - EN dictionary (English). See es.js for the coverage
// note - this first pass covers Login, Header, face check-in
// (Entry/Exit) and "Expected Today" (incl. CON/SIN perjuicio special
// events). Anything not listed here falls back to Spanish (t() in
// i18n.js), it never breaks or shows a raw key.
// ============================================================
window.ASISCAM_I18N = window.ASISCAM_I18N || {};
window.ASISCAM_I18N.en = {
    login: {
        title: 'ASIS-CAM',
        subtitle: 'Teacher Attendance Control',
        chooseRole: 'How would you like to sign in?',
        changeRole: 'Change role',
        enteringAs: 'Signing in as',
        userLabelDefault: 'Username',
        userLabelDocente: 'Username (National ID)',
        userPlaceholderDefault: 'Enter your username',
        userPlaceholderDocente: 'Enter your National ID',
        passwordLabel: 'Password',
        passwordPlaceholder: 'Enter your password',
        errorCredentials: 'Incorrect username or password',
        submit: 'Sign in',
        forgotPassword: 'Forgot your password?',
    },
    roles: {
        DOCENTE: 'Teacher',
        SECRETARIA: 'School Office',
        RECTOR: 'Principal',
        PROGRAMADOR: 'Developer',
    },
    header: {
        logout: 'Log out',
        welcome: 'Welcome,',
        panelOf: 'Dashboard —',
    },
    fichaje: {
        loadingModels: 'Loading facial recognition module...',
        waitingId: 'Waiting for identification...',
        identify: 'Identify me',
        entry: 'Check in',
        exit: 'Check out',
        earlyExit: 'Leave early',
        hint: 'Tap "Identify me" before each check-in, check-out or early leave.',
        advancedOptions: 'Advanced options',
        kioskAuthorizePrompt: 'Is this the school\'s PC? Authorize with code',
        kioskCodePlaceholder: '6-digit code',
        authorize: 'Authorize',
        hello: 'Hi {name}!',
        whatToRegister: 'What would you like to register?',
        registerEntry: 'CHECK IN',
        registerExit: 'CHECK OUT',
        registerEntryEvent: 'CHECK IN TO EVENT',
        registerExitEvent: 'CHECK OUT OF EVENT',
        notMeCancel: 'Not me / Cancel',
        alreadyDoneTodayFull: 'You already completed today\'s check-in (regular classes and special events).',
        alreadyDoneToday: 'You already completed today\'s check-in (entry and exit).',
        close: 'Close',
        specialEventsToday: 'Today\'s special events',
    },
    stats: {
        totalTeachers: 'Total Teachers',
        expectedToday: 'Expected Today',
        presentToday: 'Present Today',
        absentToday: 'Absent Today',
        lateToday: 'Late Today',
        halfAbsentToday: 'Half-Absent Today',
    },
    esperadosHoy: {
        title: 'Teachers expected to show up today',
        noTeachers: 'No teachers have a class assigned today.',
        checkedIn: 'checked in at',
        outOfSchedule: '(out of schedule)',
        event: 'Event',
        conPerjuicio: 'REPLACES CLASS',
        sinPerjuicio: 'IN ADDITION TO CLASS',
        conflict: 'CONFLICT',
        conflictWarning: 'SCHEDULE CONFLICT: this teacher has another subject overlapping the same day/time. Fix it under Subjects.',
    },
    semaforo: {
        esperado: 'Expected',
        presente: 'Present',
        tardanza: 'Late',
        media_falta: 'Half Absence',
        ausente: 'Absent',
    },
};
