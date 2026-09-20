# Decisiones de diseño — ASISCAM PRO

## 1. Por qué `app_data` es una tabla clave/valor y no constantes en el código

`app_data` guarda, entre otras colecciones, `criteria`: un único
objeto jsonb con los 6 umbrales configurables del sistema (`lateLimit`,
`minAttendance`, `minHours`, `limitePresenteMin`, `limiteTardanzaMin`,
`limiteMediaFaltaMin`). La alternativa obvia —y más "relacional"—
sería una columna por umbral en una tabla `configuracion` con una sola
fila, o directamente constantes en `script.js` (`const LATE_LIMIT = 15`).
Se descartó esa alternativa por una razón concreta: **quién necesita
cambiar estos valores y con qué frecuencia**.

- Los umbrales los cambia Rectoría, no quien programa el sistema, y
  los puede cambiar en cualquier momento del ciclo lectivo (por
  ejemplo, endurecer el criterio de tardanza a mitad de año).
- Si esos números fueran constantes en `script.js`, cambiarlos
  implicaría editar código y volver a desplegar el sitio (`firebase
  deploy`) — un paso técnico, fuera del alcance de Rectoría, y un
  cambio en el código versionado por algo que en realidad es un dato
  de configuración, no lógica del sistema.
- Con `app_data`, la pantalla Configuración > Criterios de Puntualidad
  escribe directo en la fila `key='criteria'` (`UPSERT`, sin `ALTER
  TABLE` ni migración) y la próxima vez que cualquier pantalla llama a
  `getCriteria()` ya lee el valor nuevo. El cambio es inmediato y no
  toca el esquema de la base ni el código desplegado.

El costo de esta decisión es real y se documenta sin maquillarlo: un
objeto jsonb no tiene columnas tipadas ni constraints por campo (nada
impide, a nivel de base, que `limitePresenteMin` se guarde como texto
o quede fuera de rango — esa validación vive en
`guardarCriteriosPuntualidad()`, del lado del cliente). Fue una
decisión consciente de **flexibilidad de configuración por sobre
rigidez de esquema**, razonable para un sistema de una sola escuela
con 3 personas editando configuración, no para un sistema
multi-tenant con configuración crítica.

`app_config` (el nombre que se suele usar en otros proyectos para esto)
no existe como tabla separada acá: se llamó `app_data` porque además
de configuración guarda las colecciones operativas (`teachers`,
`attendance`, `alerts`, `licencias`) bajo el mismo mecanismo genérico —
ver el punto 3 para la justificación de unificarlas ahí también.

## 2. Por qué se eliminó el campo redundante de tardanza

Hasta hace poco, "Configuración > Criterios de Asistencia" tenía un
campo "Límite de tardanza (minutos)" que editaba `criteria.lateLimit`.
Cuando se agregó el semáforo de puntualidad de 4 franjas (Presente/
Tardanza/Media Falta/Ausente), la sección "Criterios de Puntualidad"
sumó su propio "Límite Tardanza" (`criteria.limiteTardanzaMin`) — dos
campos distintos, en dos secciones distintas de la misma pantalla,
editando dos claves distintas del mismo objeto `criteria`, pero
representando el mismo concepto de negocio ("a partir de cuántos
minutos se considera tardanza") a los ojos de quien usa el sistema.

Mantener los dos invitaba a un error real: que Rectoría cambiara uno
esperando que el otro también cambiara (o no supiera cuál de los dos
"vale"). Se resolvió sacando el input de "Límite de tardanza" de
Criterios de Asistencia, dejando **una sola fuente visible** para ese
umbral (Criterios de Puntualidad).

Importante para quien lea el código: `criteria.lateLimit` **no se
borró de la base ni de `getCriteria()`** — sigue existiendo, con su
valor tal cual estaba guardado, porque la lógica de detección de
tardanza que ya existía en el sistema (alertas de "Tardanza" al
fichar, `checkFaltas()`, ventana de salida) sigue leyendo ese campo
puntual, y tocar esa lógica no era parte del pedido. Lo que se
eliminó fue la UI duplicada, no el dato ni el comportamiento. Es un
ejemplo concreto de deuda técnica documentada a propósito en vez de
"prolija pero silenciosa": el campo redundante sigue ahí, comentado en
el código, en vez de esconder la duplicación con una migración de
datos que no hacía falta.

## 3. Normalización (1FN, 2FN, 3FN)

El sistema tiene **dos capas con tratamiento normativo distinto**, y
es importante no evaluarlas con la misma vara.

### Capa relacional (`usuarios`, `carreras`, `docentes`, `materias`, `evento_especial`, `evento_docente`, `auditoria_logs`)

Estas 7 tablas siguen un diseño relacional convencional:

- **1FN** — todos los campos son atómicos (sin listas ni repeticiones
  dentro de una columna), salvo dos excepciones deliberadas y
  acotadas: `materias.dias` (`text[]`) y `materias.horarios` (`jsonb`).
  Ambas modelan lo mismo (el horario semanal de una materia, variable
  en cantidad de días) — normalizarlo del todo implicaría una tabla
  `materia_horarios(materia_id, dia, inicio, fin)`. Se evaluó y se
  descartó por ahora: el horario de una materia se edita siempre
  entero (todos sus días juntos, desde un único formulario), nunca un
  día suelto, así que separarlo en filas no agrega integridad real y sí
  agrega una tabla y un `JOIN` a cada lectura de horario. Documentado
  acá como la excepción consciente que es, no como un olvido.
- **2FN** — no hay tablas con clave primaria compuesta y dependencias
  parciales: todas las PK son de una sola columna (`id`), excepto
  `evento_docente` (ver más abajo), cuyas únicas columnas son
  precisamente las de la PK compuesta — no hay nada parcialmente
  dependiente porque no hay ningún otro atributo.
- **3FN** — no hay dependencias transitivas: por ejemplo,
  `materias.profesor_id` apunta a `docentes.id`, y el nombre/apellido
  del profesor se lee siempre por ese `JOIN`, nunca se copia una
  segunda vez dentro de `materias`.

`evento_docente` es el caso de libro de tabla puente N:M: sin columnas
propias más allá de las 2 FK, con clave primaria compuesta
`(evento_id, docente_id)` — exactamente el diseño 3FN esperado para
resolver la relación "un evento convoca a varios docentes, un docente
puede estar convocado a varios eventos".

### Capa documental (`app_data`)

`app_data` **no está normalizada, y no es un descuido**: es una
decisión de diseño explícita, del mismo tipo que "usar MongoDB para
esto" — solo que acá, en vez de sumar otro motor de base de datos, se
emula el mismo patrón (una fila = un documento) dentro de Postgres,
con `jsonb`. Viola 1FN a propósito: la fila `key='attendance'` guarda
un array entero de fichajes en una sola celda.

La razón vuelve al punto 1: **quién es la persona que programa este
sistema (una sola, sin equipo de backend) y qué tan rápido necesitaba
poder agregar campos nuevos** a fichajes/docentes/alertas mientras el
sistema estaba en desarrollo activo (agregar `corregidoPorDocente`,
`fichajeAnuladoId` o `limitePresenteMin`, por ejemplo, fueron cambios
de una sola línea de JavaScript, sin `ALTER TABLE` ni migración de
filas existentes). El costo de esa velocidad es real y queda expuesto
adrede en este mismo documento y en `consultas_ejemplo.sql`: filtrar o
agregar sobre `attendance` requiere `jsonb_array_elements()` para
"explotar" el array en filas antes de poder usar `GROUP BY`/`WHERE`
como en una tabla normal, y no hay forma de indexar un campo puntual
dentro de cada elemento sin un índice `GIN` sobre todo el jsonb.

## 4. Uso de Supabase + Firebase Hosting

El sistema separa dos responsabilidades en dos servicios distintos, y
es una separación real, no cosmética:

- **Supabase (Postgres + PostgREST)** es el único backend de datos:
  guarda todo (tablas relacionales + `app_data`) y expone una API REST
  autogenerada a partir del esquema, que el cliente llama directo
  desde el navegador con la librería `@supabase/supabase-js`. No hay
  servidor propio, ni Cloud Functions, ni Edge Functions: **todo el
  código de la aplicación corre en el navegador de quien la usa.**
- **Firebase Hosting** sirve exactamente eso: los archivos estáticos
  (`index.html`, `script.js`, `style.css`, los modelos de
  reconocimiento facial). No tiene ninguna otra función en este
  proyecto — no hay Firestore ni Cloud Functions de Firebase
  conectadas (`firebase.json` solo declara `"hosting"`).

Esta combinación (backend-as-a-service para datos + hosting estático
para el frontend) evita mantener un servidor propio, algo razonable
para el tamaño y presupuesto de este proyecto. Tiene una consecuencia
de seguridad que hay que declarar con la misma honestidad con la que
está comentada en el propio código fuente (`supabase_schema.sql`,
`fix_rls_eventos.sql`): **esta app no usa Supabase Auth**. El login es
una comparación de usuario/contraseña hecha en el propio cliente,
contra `usuarios`/`docentes` leídos con la clave "publishable" de
Supabase — una clave que, por diseño de Supabase, es pública (viaja en
el HTML). Como consecuencia, las políticas de Row Level Security de
**todas** las tablas están abiertas a personas no autenticadas
(`to anon using (true)`): el control de acceso por rol
(`justificar_alerta`, `ver_reportes`, `borrar`, etc., ver
`roles.js`/`MATRIZ_PERMISOS`) es hoy una gate del lado del cliente, no
una política real de la base de datos.

Esto está identificado y aceptado como deuda técnica, no ignorado: es
exactamente la "Etapa 2" pendiente del sistema de roles (migrar a
Supabase Auth + políticas RLS por rol reales, de forma que un permiso
denegado lo sea también a nivel de base, no solo de interfaz),
planteada y pospuesta deliberadamente como un trabajo aparte porque
implica reescribir el login y las políticas de las 8 tablas, no un
ajuste menor.
