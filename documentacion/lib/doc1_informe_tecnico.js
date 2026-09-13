"use strict";
const {
  docx: { Document, Paragraph, TextRun, AlignmentType, Packer },
  FONT, COLOR, A4_PORTRAIT, MARGIN_APA,
  pageHeader, pageFooterAPA, titlePage, toc,
  h1, h2, h3, p, bullet, numbered, reference, referenceLink, codeBlock, simpleTable,
} = require("./common");

function build() {
  const sectionBase = {
    properties: { page: { size: A4_PORTRAIT, margin: MARGIN_APA } },
    headers: { default: pageHeader("Informe Técnico de Desarrollo") },
    footers: { default: pageFooterAPA() },
  };

  const portada = titlePage({
    institucion: "Institución Educativa — Proyecto de Expo Tecnológica",
    titulo: "ASIS_CAM",
    subtitulo: "Informe Técnico de Desarrollo de un Sistema Web de Control de Asistencia Docente con Reconocimiento Facial",
    autor: "Autor: Diosmel",
    curso: "Trabajo Final de Proyecto — Área de Tecnología",
    lugar: "Argentina",
    fecha: "Septiembre de 2026",
  });

  const resumen = [
    h1("Resumen"),
    p(
      "El presente informe documenta el proceso de diseño, desarrollo e implementación de ASIS_CAM, una aplicación web para el control de asistencia del personal docente de una institución educativa mediante reconocimiento facial. El sistema permite a un administrador registrar docentes, definir su horario laboral, convocarlos a eventos institucionales especiales y supervisar su asistencia, mientras que cada docente utiliza su propio rostro como credencial para marcar entrada, salida y retiro anticipado desde cualquier dispositivo con cámara y navegador. La plataforma se construyó como un sitio estático (HTML, CSS y JavaScript sin transpilación ni empaquetado) que persiste su información en Supabase (PostgreSQL con API REST autogenerada) y se publica de forma continua en Netlify a partir del repositorio de GitHub. Se describen las decisiones de arquitectura tomadas, el modelo de datos, el flujo de identificación biométrica basado en face-api.js, el mecanismo de detección automática de tardanzas y faltas, un caso real de corrección de datos —la aparición de eventos especiales duplicados por doble clic y su solución mediante una restricción de unicidad a nivel de base de datos combinada con validación en el cliente— y el mecanismo de sincronización diferida automática (offline-first) que permite seguir operando sin conexión a internet y subir los cambios pendientes en cuanto la señal se restablece. El informe cierra con los resultados de las pruebas realizadas, las limitaciones de seguridad detectadas y las líneas de trabajo futuro recomendadas."
    ),
    h2("Palabras clave"),
    p("Control de asistencia, reconocimiento facial, Supabase, PostgreSQL, JavaScript, Netlify, integridad de datos, sincronización offline-first, sistemas de información educativa.", { firstLine: false }),
  ];

  const abstract = [
    h1("Abstract"),
    p(
      "This report documents the design, development, and implementation of ASIS_CAM, a web application for controlling teaching staff attendance at an educational institution through facial recognition. The system allows an administrator to register teachers, define their work schedules, summon them to special institutional events, and monitor their attendance, while each teacher uses their own face as credential to record clock-in, clock-out, and early departure from any device with a camera and a browser. The platform was built as a static site (HTML, CSS, and JavaScript with no transpilation or bundling step) that persists its data in Supabase (PostgreSQL with an auto-generated REST API) and is continuously deployed to Netlify from a GitHub repository. The report describes the architectural decisions made, the data model, the biometric identification flow based on face-api.js, the automatic detection of tardiness and absences, a real data-correction case —duplicate special events caused by double-clicking, solved through a database-level uniqueness constraint combined with client-side validation— and the automatic deferred synchronization mechanism (offline-first) that keeps the application usable without internet access and uploads pending changes as soon as connectivity is restored. The report closes with the results of the tests performed, the security limitations found, and recommended lines of future work."
    ),
    h2("Keywords"),
    p("Attendance control, facial recognition, Supabase, PostgreSQL, JavaScript, Netlify, data integrity, offline-first synchronization, educational information systems.", { firstLine: false }),
  ];

  const intro = [
    h1("Introducción"),
    p(
      "El control manual de la asistencia del personal docente —mediante planillas de papel, relojes de fichaje mecánicos o cuadernos de firmas— es una práctica todavía extendida en numerosas instituciones educativas de la región. Este método presenta problemas conocidos: es fácil de adulterar (una persona puede firmar por otra), no ofrece visibilidad en tiempo real para la dirección del establecimiento, dificulta la generación de reportes y estadísticas, y demanda tiempo administrativo que podría destinarse a tareas pedagógicas. A esto se suma la dificultad de coordinar convocatorias a eventos institucionales especiales (actos, jornadas, capacitaciones) y de dejar constancia fehaciente de quién asistió y quién no."
    ),
    p(
      "ASIS_CAM nace como respuesta a esa problemática concreta. El objetivo del proyecto fue construir una herramienta web accesible desde cualquier dispositivo con cámara —sin instalar aplicaciones nativas ni hardware biométrico dedicado— que permitiera identificar a cada docente por su rostro al momento de marcar su ingreso y egreso, evitando la suplantación de identidad propia del fichaje por firma o por tarjeta compartida. El sistema debía además llevar el registro de licencias y permisos, generar alertas automáticas ante tardanzas o faltas, administrar convocatorias a eventos especiales y ofrecer al equipo directivo estadísticas consolidadas."
    ),
    p(
      "Este informe describe, en la sección de Desarrollo, el proceso seguido para construir la plataforma paso a paso: desde la definición del modelo de datos en Supabase hasta la puesta en producción en Netlify, pasando por la implementación del reconocimiento facial y la resolución de un incidente real de duplicación de datos que motivó la incorporación de una restricción de unicidad en la base de datos."
    ),
  ];

  const marco = [
    h1("Marco Teórico"),
    h2("Sistemas de información educativa y control de asistencia"),
    p(
      "Un sistema de información educativa es un conjunto organizado de componentes de software, datos y procesos destinados a apoyar la gestión académica y administrativa de una institución. Dentro de esta categoría, los módulos de control de asistencia buscan reemplazar registros en papel por evidencia digital, trazable y auditable, reduciendo el margen de error humano y el fraude por suplantación (marcar la entrada de un compañero ausente). La literatura sobre sistemas de información coincide en que la digitalización de procesos administrativos repetitivos libera tiempo del personal para tareas de mayor valor agregado y mejora la calidad de los datos disponibles para la toma de decisiones directivas."
    ),
    h2("Reconocimiento facial como mecanismo de autenticación biométrica"),
    p(
      "El reconocimiento facial es una técnica biométrica que identifica a una persona a partir de rasgos geométricos de su rostro. El flujo típico consta de tres etapas: detección del rostro dentro de una imagen o cuadro de video, extracción de un conjunto de puntos de referencia (landmarks) que describen su geometría, y cálculo de un vector numérico (descriptor facial) que resume esos rasgos de forma compacta. Dos rostros se consideran pertenecientes a la misma persona cuando la distancia euclidiana entre sus descriptores es menor a un umbral definido empíricamente. En ASIS_CAM esta técnica se implementa en el propio navegador del usuario mediante la librería face-api.js (Vincent, 2020), que reutiliza modelos entrenados derivados de la biblioteca dlib (King, 2009), evitando así enviar imágenes del rostro a un servidor externo: todo el cómputo biométrico ocurre del lado del cliente."
    ),
    h2("Backend como servicio (BaaS) y Supabase"),
    p(
      "Un backend como servicio (BaaS) es un modelo de provisión de infraestructura en el cual un proveedor externo gestiona la base de datos, la autenticación, el almacenamiento de archivos y la exposición de una API, permitiendo que el equipo de desarrollo se concentre en la lógica de la aplicación cliente. Supabase es una plataforma BaaS de código abierto construida sobre PostgreSQL que expone automáticamente una API REST (mediante PostgREST) sobre cada tabla de la base de datos, y que incorpora Row Level Security (RLS) de PostgreSQL como mecanismo declarativo de control de acceso a nivel de fila (Supabase Inc., 2024a, 2024b)."
    ),
    h2("Row Level Security (RLS)"),
    p(
      "RLS es una característica nativa de PostgreSQL que permite definir políticas de acceso —expresadas como condiciones SQL— que se evalúan por cada fila de una tabla antes de permitir una operación de lectura o escritura, para un rol de base de datos determinado. En el ecosistema Supabase, el rol anon representa a cualquier cliente que se conecta usando la clave pública (anon key) sin haber iniciado sesión mediante Supabase Auth. Una política RLS puede, por ejemplo, restringir el acceso a un rol authenticated exclusivamente, o exigir que una columna coincida con el identificador del usuario autenticado. En este proyecto, como se detalla en la sección de Resultados y en Limitaciones, las políticas se definieron abiertas para el rol anon porque la aplicación no utiliza Supabase Auth para autenticar usuarios."
    ),
    h2("Arquitectura de sitio estático y despliegue continuo"),
    p(
      "Un sitio estático es aquel cuyos archivos (HTML, CSS, JavaScript) se sirven tal cual al navegador, sin un paso de compilación (build) ni un servidor de aplicación que genere HTML dinámicamente en cada solicitud. Plataformas como Netlify permiten conectar un repositorio de control de versiones (GitHub) de modo que cada cambio subido a la rama principal dispare automáticamente una nueva publicación (integración y despliegue continuos, CI/CD), sin intervención manual del desarrollador."
    ),
  ];

  const metodologia = [
    h1("Metodología de Desarrollo"),
    p(
      "El desarrollo se llevó adelante bajo un enfoque ágil e iterativo, coherente con los valores del Manifiesto Ágil (Beck et al., 2001): se priorizó tener en todo momento una versión funcional desplegada, se incorporaron funcionalidades en incrementos pequeños (primero el fichaje básico, luego el reconocimiento facial, luego los eventos especiales, luego las estadísticas) y se corrigieron errores reales detectados en uso —como el de eventos duplicados descrito más adelante— apenas se identificaban, en lugar de posponerlos a una etapa de \"cierre\" del proyecto."
    ),
    h2("Estructura de carpetas del proyecto"),
    p("El repositorio se organiza como un sitio estático sin herramienta de build, con la siguiente estructura principal:", { firstLine: false }),
    codeBlock([
      "con_supabase/",
      "├── index.html          # Marcado, estilos embebidos y modales de la SPA",
      "├── script.js           # Toda la lógica de la aplicación (~2300 líneas)",
      "├── style.css           # Hoja de estilos (tema institucional)",
      "├── supabase_schema.sql # Creación de la tabla app_data + políticas RLS",
      "├── fix_rls_eventos.sql # Políticas RLS de evento_docente y docente",
      "├── fix_unique_evento.sql # Constraint unique_evento_dia_horario",
      "├── netlify.toml        # Configuración de publicación en Netlify",
      "├── firebase.json / .firebaserc # Configuración alternativa (Firebase Hosting)",
      "├── _redirects          # Redirección SPA de respaldo",
      "└── package.json        # Metadatos del proyecto y scripts de despliegue",
    ]),
    p(
      "La ausencia de un paso de build (no hay Webpack, Vite ni similar) es una decisión deliberada: al tratarse de una única página con navegación por paneles (mostrar/ocultar secciones del DOM), el costo de incorporar un framework de componentes no se justificaba frente a la simplicidad de mantener HTML, CSS y JavaScript planos, lo cual además simplifica el despliegue (no hay artefactos de build que puedan quedar desactualizados respecto del código fuente)."
    ),
  ];

  const desarrollo = [
    h1("Desarrollo Paso a Paso de la Aplicación"),

    h2("1. Configuración inicial del proyecto"),
    p(
      "El proyecto se inicializó como un sitio estático puro: un único documento index.html que actúa como cascarón de la aplicación (contiene todos los paneles y modales, mostrados u ocultados mediante JavaScript), una hoja style.css con el tema visual institucional y un único archivo script.js que concentra toda la lógica de negocio del lado del cliente. Las dependencias externas (Bootstrap 5.3.0 para la maquetación y los modales, Bootstrap Icons 1.10.0, Chart.js 4.4.4 para los gráficos estadísticos, jsPDF 2.5.1 para exportar reportes, face-api.js 0.22.2 para el reconocimiento facial y el cliente @supabase/supabase-js 2) se incorporan directamente desde la red de distribución de contenido (CDN) jsDelivr mediante etiquetas <script> y <link>, sin gestor de paquetes ni paso de instalación para el navegador."
    ),
    p("Se optó por esta configuración inicial —en lugar de un andamiaje con Vite, Webpack o un framework de componentes— por las razones que se detallan en la sección de Justificación de Decisiones Técnicas.", { firstLine: false }),

    h2("2. Diseño de la base de datos en Supabase"),
    p(
      "El modelo de datos combina dos estrategias de persistencia dentro de la misma base PostgreSQL provista por Supabase:"
    ),
    bullet("Un almacén clave-valor genérico, la tabla app_data, que guarda como documentos JSON (jsonb) las colecciones que originalmente vivían en localStorage: teachers (docentes), attendance (fichajes de entrada/salida/retiro), alerts (alertas locales de tardanza, falta y salida anticipada), licencias (permisos autorizados) y criteria (criterios de evaluación de asistencia)."),
    bullet("Un conjunto de tablas relacionales propias de PostgreSQL para el módulo de Eventos Especiales, que sí requiere integridad referencial real: evento_especial (los eventos), evento_docente (tabla puente que representa la convocatoria N:N entre eventos y docentes) y docente (una tabla espejo de app_data.teachers, que existe únicamente para que evento_docente pueda declarar una clave foránea válida hacia un id_docente numérico)."),
    h3("Diagrama entidad-relación (descripción textual)"),
    p("Dado que el documento no admite un diagrama gráfico interactivo, se describe a continuación la estructura entidad-relación equivalente:", { firstLine: false }),
    codeBlock([
      "app_data                        docente                    evento_especial",
      "┌─────────────────┐           ┌────────────────┐         ┌───────────────────────┐",
      "│ key        (PK)  │           │ id_docente (PK) │         │ id_evento      (PK)    │",
      "│ value  jsonb      │           └───────┬────────┘         │ titulo                 │",
      "│ updated_at        │                   │ 1                │ fecha                  │",
      "└─────────────────┘                   │                  │ hora_entrada           │",
      "  (independiente,                      │ N                │ ...                    │",
      "   sin relaciones FK;          ┌────────┴────────┐         │ UNIQUE(titulo, fecha,  │",
      "   contiene teachers,          │ evento_docente   │ N────1 │        hora_entrada)   │",
      "   attendance, alerts,         │ id_evento  (FK)  │────────┴───────────────────────┘",
      "   licencias, criteria)        │ id_docente (FK)  │",
      "                               └──────────────────┘",
      "",
      "alerta",
      "┌───────────────────────┐",
      "│ id_alerta      (PK)    │   (alertas generadas automáticamente por",
      "│ id_docente     (FK)    │    inasistencia o tardanza a un Evento Especial;",
      "│ id_evento      (FK)    │    tabla independiente de app_data.alerts)",
      "│ tipo                   │",
      "│ ...                    │",
      "└───────────────────────┘",
    ]),
    p(
      "Esta convivencia de un almacén documental (app_data) con tablas relacionales normalizadas para los eventos no es una inconsistencia sino una decisión pragmática: el fichaje diario y los datos de docentes tienen una estructura flexible que cambió varias veces durante el desarrollo (por ejemplo, el formato de horario_laboral evolucionó de bloques sueltos de 40 minutos a rangos de inicio y fin), mientras que la convocatoria a eventos especiales necesitaba integridad referencial real —evitar que un evento quede convocando a un docente inexistente, y, como se detalla más adelante, evitar eventos duplicados— algo que un documento jsonb no puede garantizar por sí mismo."
    ),

    h2("3. Autenticación y control de acceso"),
    p(
      "A diferencia de lo que suele recomendarse como mejor práctica, ASIS_CAM no utiliza Supabase Auth. El inicio de sesión del administrador compara el usuario y la contraseña ingresados contra credenciales fijas definidas en el objeto CONFIG del propio script.js, y el inicio de sesión de cada docente compara su DNI y contraseña contra el registro correspondiente dentro de la colección teachers de app_data (con una contraseña por defecto asignada al crear al docente, que este puede cambiar desde su panel). El rol resultante (admin o teacher) se guarda únicamente en la variable de JavaScript currentUser durante la sesión del navegador, y es esa variable —no una política de base de datos— la que decide qué paneles y botones se muestran."
    ),
    p(
      "Como consecuencia directa de no usar Supabase Auth, las políticas de Row Level Security de las tablas app_data, evento_especial, evento_docente y docente están definidas de forma abierta para el rol anon (permiten select, insert y update sin restricción alguna), tal como se documenta en supabase_schema.sql y fix_rls_eventos.sql. Esto significa que, en el estado actual del sistema, RLS no diferencia entre administrador y docente a nivel de base de datos: toda la autorización por rol ocurre exclusivamente en el cliente. Este punto se retoma con mayor detalle en la sección de Resultados y Pruebas y en Limitaciones y Trabajo Futuro, por ser la observación de seguridad más relevante detectada durante la elaboración de este informe."
    ),

    h2("4. Módulo de gestión de docentes"),
    p(
      "El administrador da de alta a cada docente completando sus datos personales y de contacto, definiendo su horario_laboral como una lista de bloques {dia, inicio, fin}, y capturando su rostro mediante la cámara del dispositivo: la interfaz exige un mínimo de tres fotografías (MIN_CAPTURES = 3) para calcular un descriptor facial promedio y confiable antes de habilitar el guardado. Cada docente queda identificado por un id numérico dentro de app_data.teachers, y ese mismo id se refleja en la tabla docente para que pueda ser referenciado por clave foránea desde evento_docente. El listado de docentes en el panel de administración admite un filtro de búsqueda en vivo por nombre, y cada fila incorpora un botón de contacto directo por WhatsApp que arma el enlace wa.me a partir del teléfono cargado, normalizando prefijos de larga distancia argentinos."
    ),

    h2("5. Módulo de horario laboral y grilla semanal"),
    p(
      "A partir del horario_laboral cargado por docente, el sistema arma en el momento —sin persistirla como una colección aparte— una grilla horaria semanal de solo lectura para el panel del administrador, que consolida qué docente tiene clase asignada en cada franja de cada día. Esa misma información alimenta un calendario anual: para cada docente se proyectan las fechas concretas del año en que le corresponde dictar clase, lo que permite comparar, día por día, el horario previsto contra los fichajes de entrada realmente registrados."
    ),

    h2("6. Módulo de fichaje (asistencia) y detección automática de tardanzas y faltas"),
    p(
      "Cada docente marca su ingreso identificándose primero frente a la cámara: la aplicación captura varias muestras en vivo (IDENTIFY_SAMPLES = 3, una cada 250 ms) y las compara contra su descriptor facial registrado; solo si la distancia euclidiana promedio es menor al umbral FACE_MATCH_THRESHOLD (0.55) se habilita el botón de Entrada, Salida o Retiro anticipado correspondiente. El sistema exige una identificación nueva antes de cada registro —no reutiliza una identificación previa de la sesión— para impedir que un docente marque la asistencia de otro. La lógica decide qué botón mostrar según tres factores: si ya existe una entrada registrada hoy para ese docente, si el horario_laboral define una hora de salida para el día actual, y si la hora presente cae dentro de la ventana de tolerancia configurada (EXIT_TOLERANCE_MINUTES = 15 minutos antes de la hora de salida) o si, por el contrario, corresponde clasificar la marcación como \"Retiro anticipado\", pendiente de autorización."
    ),
    p(
      "En paralelo, un proceso de comparación (no una tarea programada del lado del servidor, sino un recorrido que la propia aplicación ejecuta al abrir el panel del administrador) revisa el calendario anual de cada docente y genera una alerta de \"Falta\" para cada fecha con clase asignada, ya vencido el margen de tolerancia (LATE_LIMIT = 15 minutos), en la que no exista un registro de entrada, salvo que ese día esté cubierto por una licencia autorizada. El estado de cada día para un docente se resuelve con la prioridad licencia > presente > falta > programado, y el algoritmo evita generar alertas duplicadas comparando contra las que ya existen para ese docente y esa fecha puntual."
    ),

    h2("7. Módulo de licencias y permisos"),
    p(
      "El administrador puede registrar licencias (ausencias autorizadas) para un docente, indicando el período que cubren. Cualquier fecha comprendida dentro de una licencia vigente queda excluida de la detección automática de faltas descrita en el punto anterior, evitando que una ausencia justificada (por ejemplo, una licencia médica) se compute como una falta injustificada."
    ),

    h2("8. Módulo de Eventos Especiales: el problema de los duplicados y su solución"),
    p(
      "El módulo de Eventos Especiales permite al administrador crear convocatorias (por ejemplo, un acto institucional) e invitar a un subconjunto de docentes mediante un buscador con autocompletado. Al guardar el evento, la función saveEvento() del frontend primero refleja en la tabla docente a cada docente convocado (upsertTeacherAsDocente(), usando su mismo id numérico) y luego inserta las filas correspondientes en evento_especial y evento_docente."
    ),
    p(
      "Durante el uso real de la aplicación se detectó un incidente concreto: el acto \"Día del Estudiante\" quedó registrado dos veces —con id_evento 10 y 11— por un doble clic accidental sobre el botón Guardar antes de que la primera solicitud terminara de procesarse. Como ambos eventos duplicados ya tenían docentes convocados y varios de ellos habían fichado su asistencia contra ambos identificadores, la corrección no podía resolverse con un simple borrado: fue necesario (a) identificar cuál de los dos eventos concentraba más registros de asistencia reales, (b) migrar las convocatorias del evento sobrante al que se conservaba evitando filas repetidas, (c) reasignar manualmente, en los datos de asistencia, las marcaciones del evento sobrante hacia el evento conservado, y recién entonces (d) eliminar el evento duplicado."
    ),
    p(
      "La solución de fondo, para que el problema no volviera a ocurrir, combinó dos capas de protección:"
    ),
    numbered(1, "Validación en el frontend: antes de insertar, saveEvento() verifica si ya existe un evento con el mismo título, fecha y hora de entrada, y en ese caso avisa al usuario en lugar de crear una fila nueva; además, el botón Guardar se deshabilita apenas se hace clic para impedir un segundo envío mientras la primera solicitud está en curso."),
    numbered(2, "Restricción de integridad en la base de datos: se agregó la constraint UNIQUE unique_evento_dia_horario sobre las columnas (titulo, fecha, hora_entrada) de la tabla evento_especial, de modo que, aunque dos clics casi simultáneos superaran ambos la verificación del frontend (condición de carrera), PostgreSQL rechace la segunda inserción a nivel de base de datos."),
    p(
      "Esta doble capa ilustra un principio general de integridad de datos: una validación exclusivamente en el cliente puede evitar la mayoría de los duplicados accidentales, pero solo una restricción declarada en la propia base de datos garantiza la unicidad de forma absoluta frente a condiciones de carrera. El script SQL completo de esta corrección se incluye en el Anexo A."
    ),

    h2("9. Módulo de alertas, histórico y estadísticas"),
    p(
      "El buzón de alertas del administrador combina dos orígenes de datos: las alertas locales de app_data.alerts (Falta, Tardanza, Salida Anticipada, generadas por la lógica descrita en el punto 6) y las alertas de asistencia a Eventos Especiales, que viven en una tabla alerta separada. Una alerta local puede archivarse (marcarse visible = false) sin perderse, de modo que sigue disponible en un histórico institucional y en el histórico individual de cada docente, aunque deje de mostrarse en el buzón activo; las alertas de eventos, en cambio, no tienen ese estado y no participan del histórico. El panel de estadísticas calcula en el momento —sin mantener contadores persistidos— los indicadores de asistencia y ausentismo, y los presenta mediante gráficos de torta, barras y líneas construidos con Chart.js."
    ),

    h2("10. Persistencia híbrida y sincronización diferida automática (offline-first)"),
    p(
      "Cada colección de app_data se cachea además en localStorage bajo el prefijo sb_cache_. Al iniciar, la aplicación intenta primero traer los datos desde Supabase y, si la conexión falla o responde con error, recurre a esa copia local en lugar de arrancar vacía. Del mismo modo, cada guardado escribe primero en localStorage —de forma inmediata, para que la interfaz responda sin demora— y luego intenta sincronizar el cambio con Supabase en segundo plano."
    ),
    p(
      "En la primera versión de este mecanismo, si ese intento de sincronización en segundo plano fallaba por falta de conexión, el cambio quedaba guardado únicamente en el dispositivo y no existía ninguna forma de que se subiera a Supabase más adelante salvo que el usuario volviera a repetir la misma acción estando ya online. Esta limitación se corrigió incorporando una cola de sincronización diferida: cuando un guardado a Supabase falla, la clave de esa colección (teachers, attendance, alerts, licencias o criteria) queda marcada como pendiente en una entrada propia de localStorage (sb_pending_sync), además de haberse guardado igualmente el dato en sí."
    ),
    p(
      "A partir de ese momento, tres disparadores independientes intentan vaciar esa cola de pendientes subiendo a Supabase la versión más reciente de cada colección afectada —no la que había en el instante del fallo, sino la que resulte de todos los guardados que se hayan hecho mientras tanto sin conexión—:"
    ),
    numbered(1, "El evento online del navegador: apenas el dispositivo recupera conectividad, se dispara automáticamente el reintento de todas las claves pendientes."),
    numbered(2, "Un intervalo de respaldo cada 20 segundos mientras existan claves pendientes, para cubrir los casos en que el evento online no es del todo confiable (por ejemplo, un dispositivo conectado a una red wifi que en realidad no tiene salida a internet)."),
    numbered(3, "Un intento de sincronización al iniciar la aplicación, por si quedaron cambios pendientes de una sesión anterior que se cerró o se recargó estando aún sin conexión."),
    p(
      "La interfaz además informa al usuario en cada instancia relevante: un aviso al perder la conexión (\"los cambios se guardarán en este dispositivo y se subirán solos al reconectar\"), otro si un guardado puntual no pudo subirse, y un tercero de confirmación cuando la sincronización diferida se completa con éxito, indicando cuántos cambios pendientes se subieron. Esta estrategia prioriza que la aplicación siga siendo completamente utilizable ante una caída de conectividad —incluyendo el registro de asistencia, que es la función más crítica del sistema— sin perder esos cambios ni depender de que la persona usuaria repita manualmente la acción al recuperar la señal."
    ),
    p(
      "Una limitación que este mecanismo no resuelve, por quedar fuera del alcance de la mejora solicitada, es la resolución de conflictos entre dispositivos: como cada colección se sincroniza como un único documento jsonb completo (no registro por registro), si dos dispositivos distintos guardan cambios diferentes sobre la misma colección mientras ambos están sin conexión, el que logra sincronizar en segundo lugar sobrescribe por completo la versión que el primero ya había subido, sin fusionar ambos conjuntos de cambios. Este punto se retoma en la sección de Limitaciones y Trabajo Futuro."
    ),

    h2("11. Despliegue en Netlify con integración continua desde GitHub"),
    p(
      "El repositorio se publica en Netlify configurando el archivo netlify.toml con publish = \".\" (se sirve la raíz del repositorio tal cual, sin comando de build) y una regla de redirección que envía cualquier ruta (/*) hacia index.html con código 200, necesaria para que la navegación interna de la aplicación (basada en mostrar y ocultar secciones del DOM, no en un enrutador de URL con múltiples rutas reales) no produzca errores 404 al recargar la página. Netlify queda conectado directamente al repositorio de GitHub del proyecto (github.com/Diosmel84/ASIS_CAM), de modo que cada cambio subido a la rama principal dispara automáticamente una nueva publicación en la URL de producción (asiscam-uno.netlify.app), sin pasos manuales adicionales. El proyecto conserva además, como configuración alternativa de respaldo, un archivo firebase.json y un _redirects equivalente para poder publicarse en Firebase Hosting si fuera necesario."
    ),
  ];

  const justificacion = [
    h1("Justificación de las Decisiones Técnicas"),
    h3("¿Por qué HTML, CSS y JavaScript planos, sin un framework de componentes?"),
    p(
      "La aplicación es, en esencia, un panel de administración de una sola página con secciones que se muestran u ocultan según el rol y la acción del usuario. Un framework de componentes (React, Vue, Angular) aporta valor cuando la interfaz crece en complejidad de estado compartido entre muchas vistas independientes, pero introduce un costo de aprendizaje, un paso de build y una cadena de dependencias adicional. Dado el tamaño y el alcance del proyecto, mantener JavaScript plano permitió iterar rápido, depurar directamente en el navegador sin mapas de fuente (source maps) de por medio, y desplegar sin ningún paso de compilación: subir el cambio a GitHub es, literalmente, publicar la nueva versión."
    ),
    h3("¿Por qué Supabase y no Firebase como backend?"),
    p(
      "Supabase se apoya en PostgreSQL, una base de datos relacional madura con soporte nativo de restricciones de integridad (claves foráneas, UNIQUE) que resultaron indispensables para resolver el problema de eventos duplicados descrito en la sección anterior: una base documental pura habría requerido reimplementar esa unicidad a mano en el cliente, sin la garantía que ofrece una constraint de base de datos. Además, Supabase expone automáticamente una API REST sobre cualquier tabla nueva (vía PostgREST), lo que permitió combinar, dentro del mismo proyecto, un almacén flexible tipo documento (app_data) con tablas relacionales estrictas (evento_especial, evento_docente) sin cambiar de proveedor ni de paradigma. El proyecto conserva, no obstante, una configuración de respaldo para Firebase Hosting (archivo firebase.json), usada únicamente como alternativa de publicación del sitio estático, no como base de datos."
    ),
    h3("¿Por qué Row Level Security, si en este proyecto las políticas terminaron siendo abiertas?"),
    p(
      "RLS se habilitó en todas las tablas por ser la práctica recomendada por Supabase para cualquier tabla expuesta a través de su API pública: sin RLS habilitado, una tabla es accesible sin ninguna restricción declarativa. Haberla dejado activa, aunque con políticas abiertas para el rol anon, deja al proyecto en condiciones de endurecer el acceso en una etapa futura (restringiendo las políticas al rol authenticated una vez que se incorpore Supabase Auth) sin tener que rediseñar el esquema de la base de datos desde cero. Este punto se retoma como recomendación concreta en la sección de Limitaciones y Trabajo Futuro."
    ),
    h3("¿Por qué face-api.js para el reconocimiento facial?"),
    p(
      "face-api.js ejecuta la detección y el cálculo del descriptor facial enteramente en el navegador del usuario, usando modelos livianos (TinyFaceDetector) pensados para tiempo real. Esto evita transmitir imágenes del rostro de los docentes a un servidor externo para su procesamiento, y no requiere contratar un servicio de reconocimiento facial en la nube ni pagar por cada verificación realizada, lo cual era relevante para mantener el proyecto sin costos de infraestructura adicionales."
    ),
    h3("¿Por qué Netlify como plataforma de despliegue?"),
    p(
      "Netlify permite publicar un sitio estático conectándolo directamente a un repositorio de GitHub, sin configurar servidores propios, con certificado HTTPS automático y republicación en cada cambio subido a la rama principal. Para un proyecto sin paso de build, la configuración se reduce a indicar la carpeta a publicar y la regla de redirección para la navegación interna, lo que hizo de Netlify la opción de menor fricción operativa disponible."
    ),
  ];

  const resultados = [
    h1("Resultados y Pruebas"),
    h2("Prueba de la restricción de unicidad de eventos"),
    p(
      "Tras aplicar la constraint unique_evento_dia_horario, se verificó su funcionamiento intentando insertar manualmente, desde el editor SQL de Supabase, dos filas en evento_especial con idéntico titulo, fecha y hora_entrada: la segunda inserción fue rechazada por PostgreSQL con un error de violación de unicidad, confirmando que la protección persiste incluso si la validación del frontend llegara a omitirse o a fallar. Se verificó igualmente que un evento con el mismo título pero distinta fecha u hora se inserta sin inconvenientes, confirmando que la restricción no es más estricta de lo necesario."
    ),
    h2("Prueba de las políticas de Row Level Security"),
    p(
      "Se revisaron las políticas activas sobre app_data, evento_especial, evento_docente y docente y se confirmó que, en el estado actual, cualquier cliente que posea la clave anónima (anon key) del proyecto —visible en el código fuente servido al navegador— puede leer, insertar y actualizar filas de esas tablas sin distinción de rol. En términos prácticos, esto significa que la separación entre administrador y docente que percibe la persona usuaria es exclusivamente una capa de presentación: no está respaldada por una restricción equivalente en la base de datos. Se identificó además que app_data.teachers guarda las contraseñas de los docentes en texto plano junto con su descriptor biométrico facial, ambos alcanzados por esas mismas políticas abiertas."
    ),
    h2("Prueba del flujo de identificación facial"),
    p(
      "Se comprobó que, con un umbral FACE_MATCH_THRESHOLD de 0.55, el sistema identifica correctamente al docente registrado bajo distintas condiciones de iluminación moderadas, y rechaza la identificación cuando se presenta ante la cámara una persona distinta a la registrada, exigiendo un nuevo intento. Se verificó también que los botones de marcación permanecen deshabilitados hasta obtener una identificación válida, y que la ventana de tolerancia de salida (15 minutos) efectivamente reclasifica una marcación de \"Retiro anticipado\" a \"Salida\" en cuanto se alcanza la hora de fin de horario configurada."
    ),
    h2("Prueba de la sincronización diferida automática (offline-first)"),
    p(
      "Se simuló la pérdida de conectividad desactivando la red del dispositivo (modo offline de las herramientas de desarrollo del navegador) y se registró una asistencia y una alerta mientras la aplicación permanecía sin conexión. Se confirmó que ambos cambios quedaron disponibles de inmediato en la interfaz y guardados en localStorage, y que la clave correspondiente quedó registrada en la cola de pendientes (sb_pending_sync). Al restablecer la conectividad, se verificó que el evento online disparó automáticamente la sincronización, que los cambios se reflejaron en la tabla app_data de Supabase sin intervención manual, que la cola de pendientes quedó vacía y que se mostró el aviso de confirmación correspondiente. Se verificó además que, si la aplicación se recarga estando aún sin conexión, la cola de pendientes persiste en localStorage y se procesa igual al reabrir la aplicación ya con señal."
    ),
    h2("Prueba del despliegue continuo"),
    p(
      "Se confirmó que un cambio subido a la rama principal del repositorio de GitHub se refleja automáticamente, sin intervención manual, en la URL de producción (asiscam-uno.netlify.app), y que la regla de redirección definida en netlify.toml evita errores 404 al recargar la página desde cualquier estado de la interfaz."
    ),
  ];

  const conclusiones = [
    h1("Conclusiones"),
    p(
      "ASIS_CAM cumple su objetivo central: reemplazar el fichaje manual de asistencia docente por un mecanismo biométrico que dificulta la suplantación de identidad, corriendo enteramente en el navegador y sin requerir hardware dedicado. El proyecto demuestra que una arquitectura de sitio estático combinada con un backend como servicio puede sostener funcionalidad no trivial —reconocimiento facial, detección automática de faltas, convocatoria a eventos— sin necesidad de un framework de frontend ni de un servidor de aplicación propio."
    ),
    p(
      "El incidente real de eventos duplicados, y su resolución mediante una restricción de unicidad a nivel de base de datos, deja como aprendizaje concreto que la validación del lado del cliente es necesaria pero no suficiente: la garantía definitiva de integridad de datos debe residir en la base de datos misma. Al mismo tiempo, la revisión de las políticas de Row Level Security realizada para este informe puso en evidencia la limitación de seguridad más importante del sistema en su estado actual —la ausencia de autenticación real a nivel de base de datos y el almacenamiento de contraseñas en texto plano—, cuya corrección se detalla como prioridad en la siguiente sección."
    ),
  ];

  const limitaciones = [
    h1("Limitaciones y Trabajo Futuro"),
    bullet("Resolver la fusión de cambios entre dispositivos que sincronizan la sincronización diferida (offline-first) descrita en la sección de Desarrollo: hoy, si dos dispositivos guardan cambios distintos sobre la misma colección estando ambos sin conexión, el que sincroniza en segundo lugar sobrescribe por completo lo que había subido el primero. Una solución posible es pasar de guardar la colección entera como un único documento jsonb a registrar cada fichaje o alerta como una fila individual con marca de tiempo, de modo que sincronizar sea agregar filas nuevas en vez de reemplazar un documento completo."),
    bullet("Migrar la autenticación a Supabase Auth y restringir las políticas de RLS de app_data, evento_especial, evento_docente y docente al rol authenticated, de modo que la separación admin/docente exista también a nivel de base de datos y no solo en la interfaz."),
    bullet("Dejar de almacenar las contraseñas de los docentes en texto plano dentro de app_data.teachers, aplicando en su lugar un hash con sal (por ejemplo, mediante una función de base de datos o una Edge Function de Supabase que intermedie las escrituras)."),
    bullet("Evaluar el traslado de las escrituras sensibles detrás de una Supabase Edge Function que valide un secreto del lado del servidor, en lugar de exponer la clave anónima con permisos amplios directamente en el cliente."),
    bullet("Persistir la grilla horaria semanal como una vista materializada o una tabla propia si el volumen de docentes crece lo suficiente como para que recalcularla en el cliente en cada apertura del panel deje de ser eficiente."),
    bullet("Extender la constraint unique_evento_dia_horario con un índice adicional que contemple, si el caso de uso lo requiere, eventos recurrentes con el mismo título en fechas futuras planificadas de antemano."),
  ];

  const referencias = [
    h1("Referencias"),
    reference("American Psychological Association. (2020). Publication manual of the American Psychological Association (7th ed.). https://doi.org/10.1037/0000165-000"),
    reference("Beck, K., Beedle, M., van Bennekum, A., Cockburn, A., Cunningham, W., Fowler, M., Grenning, J., Highsmith, J., Hunt, A., Jeffries, R., Kern, J., Marick, B., Martin, R. C., Mellor, S., Schwaber, K., Sutherland, J., & Thomas, D. (2001). Manifesto for Agile Software Development. https://agilemanifesto.org/"),
    reference("Chart.js Contributors. (2024). Chart.js documentation (v4.4). https://www.chartjs.org/docs/latest/"),
    reference("Google. (2024). Firebase Hosting documentation. https://firebase.google.com/docs/hosting"),
    reference("King, D. E. (2009). Dlib-ml: A machine learning toolkit. Journal of Machine Learning Research, 10, 1755–1758."),
    reference("Mozilla Developer Network. (2024). JavaScript reference. Mozilla. https://developer.mozilla.org/es/docs/Web/JavaScript"),
    reference("Netlify, Inc. (2024). Netlify Docs: Continuous deployment. https://docs.netlify.com/site-deploys/create-deploys/"),
    reference("PostgreSQL Global Development Group. (2024). PostgreSQL 16 documentation: Row security policies. https://www.postgresql.org/docs/current/ddl-rowsecurity.html"),
    reference("PostgREST. (2024). PostgREST documentation. https://postgrest.org/en/stable/"),
    reference("Supabase Inc. (2024a). Supabase documentation. https://supabase.com/docs"),
    reference("Supabase Inc. (2024b). Row Level Security. https://supabase.com/docs/guides/database/postgres/row-level-security"),
    reference("Twitter, Inc. / Bootstrap Team. (2023). Bootstrap 5.3 documentation. https://getbootstrap.com/docs/5.3/"),
    reference("Vincent, J. [justadudewhohacks]. (2020). face-api.js: JavaScript face recognition API for the browser and Node.js, implemented on top of TensorFlow.js core [Software]. GitHub. https://github.com/justadudewhohacks/face-api.js"),
    reference("World Wide Web Consortium. (2024). HTML Living Standard. WHATWG. https://html.spec.whatwg.org/"),
  ];

  const anexos = [
    h1("Anexos"),
    h2("Anexo A. Script de corrección: eventos duplicados"),
    p("Constraint de unicidad agregada a evento_especial para impedir eventos con el mismo título, fecha y hora de entrada (fix_unique_evento.sql):", { firstLine: false }),
    codeBlock([
      "alter table evento_especial",
      "    add constraint unique_evento_dia_horario",
      "    unique (titulo, fecha, hora_entrada);",
      "",
      "notify pgrst, 'reload schema';",
    ]),
    h2("Anexo B. Creación de la tabla app_data"),
    codeBlock([
      "create table if not exists app_data (",
      "    key text primary key,",
      "    value jsonb not null default '[]'::jsonb,",
      "    updated_at timestamptz not null default now()",
      ");",
      "",
      "alter table app_data enable row level security;",
    ]),
    h2("Anexo C. Configuración de despliegue en Netlify (netlify.toml)"),
    codeBlock([
      "[build]",
      "  publish = \".\"",
      "",
      "[[redirects]]",
      "  from = \"/*\"",
      "  to = \"/index.html\"",
      "  status = 200",
    ]),
    h2("Anexo D. Parámetros de configuración del reconocimiento facial (script.js)"),
    codeBlock([
      "LATE_LIMIT: 15,                 // minutos de tolerancia para tardanza",
      "EXIT_TOLERANCE_MINUTES: 15,     // ventana previa a la salida",
      "FACE_MATCH_THRESHOLD: 0.55,     // distancia euclidiana máxima aceptada",
      "MIN_CAPTURES: 3,                // fotos mínimas para registrar un rostro",
      "IDENTIFY_SAMPLES: 3,            // muestras promediadas al identificar",
      "IDENTIFY_SAMPLE_INTERVAL_MS: 250",
    ]),
    h2("Anexo E. Sincronización diferida automática (script.js)"),
    p("Cola de pendientes y reintento automático al recuperar conexión, agregados sobre persistToSupabase:", { firstLine: false }),
    codeBlock([
      "function markPendingSync(key) {",
      "    const pending = getPendingSyncKeys();",
      "    if (!pending.includes(key)) {",
      "        pending.push(key);",
      "        localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(pending));",
      "    }",
      "}",
      "",
      "async function flushPendingSync() {",
      "    if (!sb || isFlushingPendingSync) return;",
      "    const pending = getPendingSyncKeys();",
      "    if (pending.length === 0) return;",
      "    isFlushingPendingSync = true;",
      "    let syncedCount = 0;",
      "    for (const key of pending) {",
      "        try {",
      "            const { error } = await sb.from('app_data')",
      "                .upsert({ key, value: dataStore[key], updated_at: new Date().toISOString() },",
      "                        { onConflict: 'key' });",
      "            if (error) throw error;",
      "            clearPendingSync(key);",
      "            syncedCount++;",
      "        } catch (e) {",
      "            console.error('Reintento de sincronización falló para \"' + key + '\":', e);",
      "        }",
      "    }",
      "    isFlushingPendingSync = false;",
      "    if (syncedCount > 0) {",
      "        supabaseAvailable = true;",
      "        showToast('Conexión restablecida: se sincronizaron ' + syncedCount +",
      "                  ' cambio(s) guardado(s) sin conexión.', 'success');",
      "    }",
      "}",
      "",
      "window.addEventListener('online', flushPendingSync);",
      "setInterval(() => {",
      "    if (getPendingSyncKeys().length > 0) flushPendingSync();",
      "}, 20000);",
    ]),
    h2("Anexo F. Tabla resumen de módulos y tecnologías"),
    simpleTable(
      ["Módulo", "Tecnología / mecanismo", "Persistencia"],
      [
        ["Autenticación", "Comparación de credenciales en cliente (sin Supabase Auth)", "app_data.teachers / CONFIG"],
        ["Reconocimiento facial", "face-api.js (TinyFaceDetector + landmarks + descriptor)", "Descriptor en app_data.teachers"],
        ["Fichaje de asistencia", "Lógica de horario + tolerancia en cliente", "app_data.attendance"],
        ["Licencias", "CRUD desde panel admin", "app_data.licencias"],
        ["Eventos especiales", "Tablas relacionales + constraint UNIQUE", "evento_especial / evento_docente"],
        ["Alertas", "Detección automática + tabla de alertas de eventos", "app_data.alerts / tabla alerta"],
        ["Estadísticas", "Chart.js, cálculo en el momento", "Derivado de attendance"],
        ["Despliegue", "Netlify (CI/CD desde GitHub); Firebase Hosting como respaldo", "—"],
      ],
      { zebra: true }
    ),
  ];

  const children = [
    ...portada,
    ...toc(),
    ...resumen,
    ...abstract,
    ...intro,
    ...marco,
    ...metodologia,
    ...desarrollo,
    ...justificacion,
    ...resultados,
    ...conclusiones,
    ...limitaciones,
    ...referencias,
    ...anexos,
  ];

  return new Document({
    creator: "Diosmel",
    title: "Informe Técnico de Desarrollo - ASIS_CAM",
    description: "Informe técnico APA 7 sobre el desarrollo de ASIS_CAM",
    styles: {
      default: {
        document: { run: { font: FONT, size: 24 } },
      },
    },
    sections: [{ ...sectionBase, children }],
  });
}

async function generate(outPath) {
  const doc = build();
  const buffer = await Packer.toBuffer(doc);
  require("fs").writeFileSync(outPath, buffer);
  return outPath;
}

module.exports = { generate };
