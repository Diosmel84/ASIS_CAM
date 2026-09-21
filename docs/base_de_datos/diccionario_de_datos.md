# Diccionario de datos — ASISCAM PRO

Corresponde al esquema documentado en [`schema.sql`](./schema.sql). Ver
[`README.md`](./README.md) para el modelo entidad-relación completo y
la explicación de por qué el sistema combina tablas relacionales con
un almacén clave/valor (`app_data`).

## Tablas relacionales

### `usuarios`

| Columna | Tipo | Nulo | Default | Descripción |
|---|---|---|---|---|
| id | bigint | NO | identity | PK. |
| usuario | text | NO | — | Nombre de login. Valores reales: `ADMIN` (Programador), `ADMIN1` (Secretaría), `ADMIN2` (Rector). Único. |
| password | text | NO | — | Programador: texto plano (recuperable por e-mail). Secretaría/Rector: hash SHA-256 de la contraseña. |
| rol | text | NO | `'admin'` | `admin` (Programador) \| `secretaria` \| `rector`. |
| email | text | SÍ | — | Usado solo por Programador, para recuperar contraseña. |
| email_respaldo | text | SÍ | — | E-mail alternativo de recuperación. |
| reset_token | text | SÍ | — | Token de un solo uso para "¿Olvidaste tu contraseña?". |
| reset_token_expira | timestamptz | SÍ | — | Vencimiento del token. |
| updated_at | timestamptz | NO | `now()` | Última modificación. |

### `app_data`

| Columna | Tipo | Nulo | Default | Descripción |
|---|---|---|---|---|
| key | text | NO | — | PK. Nombre de la colección (`teachers`, `attendance`, `alerts`, `licencias`, `criteria`, `geofence`, `modoPrueba`, `kioskPrincipal`, `kioskCodes`). |
| value | jsonb | NO | `'[]'` | Contenido completo de esa colección (array u objeto). Ver el detalle campo por campo más abajo. |
| updated_at | timestamptz | NO | `now()` | Última escritura. |

### `carreras`

| Columna | Tipo | Nulo | Default | Descripción |
|---|---|---|---|---|
| id | bigint | NO | identity | PK. |
| escuela_id | bigint | NO | `2` | Reservado a una futura multi-escuela; hoy es un valor fijo, sin FK real (no existe tabla `escuelas` conectada). |
| nombre | text | NO | — | Nombre de la carrera/orientación. Único. |
| created_at | timestamptz | NO | `now()` | Alta. |

### `docentes`

| Columna | Tipo | Nulo | Default | Descripción |
|---|---|---|---|---|
| id | bigint | NO | identity (desde 500000) | PK. |
| escuela_id | bigint | NO | `2` | Igual que en `carreras`, sin FK real hoy. |
| dni | text | NO | — | Clave de sincronización con `app_data.teachers[].dni`. Único. |
| nombre | text | NO | — | |
| apellido | text | NO | — | |
| email | text | SÍ | — | |
| telefono | text | SÍ | — | |
| password | text | SÍ | — | Copia de la contraseña de fichaje del docente (no es la que se usa para autenticar: eso lo valida `app_data.teachers`). |
| calle | text | SÍ | — | |
| numero | text | SÍ | — | |
| barrio | text | SÍ | — | |
| localidad | text | SÍ | `'RESISTENCIA'` | |
| provincia | text | SÍ | `'CHACO'` | |
| pais | text | SÍ | `'ARGENTINA'` | |
| created_at | timestamptz | NO | `now()` | |

### `materias`

| Columna | Tipo | Nulo | Default | Descripción |
|---|---|---|---|---|
| id | bigint | NO | identity | PK. |
| escuela_id | bigint | NO | `2` | Sin FK real hoy. |
| carrera_id | bigint | NO | — | FK a `carreras.id`, `ON DELETE RESTRICT`. |
| nombre | text | NO | — | |
| anio | smallint | NO | — | `1`, `2` o `3` (check). |
| cuatrimestre | smallint | NO | — | `1` o `2` (check). |
| tipo | text | NO | — | `ANUAL` o `CUATRIMESTRAL` (check). |
| dias | text[] | NO | `'{}'` | Heredado; se deriva de `horarios`, ya no se edita directo. |
| hora_inicio | time | SÍ | — | Heredado (modelo de un solo horario para todos los días). |
| hora_fin | time | SÍ | — | Heredado. |
| horarios | jsonb | SÍ | — | `[{"dia","inicio","fin"}, ...]` — horario real, uno por día. |
| profesor_id | bigint | SÍ | — | FK a `docentes.id`, `ON DELETE SET NULL`. Puede quedar sin asignar. |
| created_at | timestamptz | NO | `now()` | |

### `evento_especial`

| Columna | Tipo | Nulo | Default | Descripción |
|---|---|---|---|---|
| id | bigint | NO | identity | PK. |
| escuela_id | bigint | NO | `2` | Sin FK real hoy. |
| titulo | text | NO | — | Parte de la constraint única junto a `fecha_inicio`. |
| descripcion | text | SÍ | — | |
| fecha_inicio | timestamp | NO | — | Fecha + hora de inicio del evento. |
| fecha_fin | timestamp | NO | — | Fecha + hora de fin. |
| direccion_evento | text | SÍ | — | Dirección en texto (informativa, independiente de la geocerca). |
| tiene_geocerca | boolean | NO | `false` | Si exige validar ubicación al fichar. |
| geocerca_lat | double precision | SÍ | — | Solo si `tiene_geocerca`. |
| geocerca_lng | double precision | SÍ | — | Solo si `tiene_geocerca`. |
| geocerca_radio | integer | SÍ | — | Metros. Solo si `tiene_geocerca`. |
| tipo_cumplimiento | text | NO | `'con_perjuicio'` | `'con_perjuicio'` (el docente solo va al evento, no da clases ese día) o `'sin_perjuicio'` (va al evento Y da clases igual - obligaciones separadas). Check constraint. |
| created_at | timestamptz | NO | `now()` | |

### `evento_docente`

| Columna | Tipo | Nulo | Default | Descripción |
|---|---|---|---|---|
| evento_id | bigint | NO | — | FK a `evento_especial.id`, `ON DELETE CASCADE`. Parte de la PK compuesta. |
| docente_id | bigint | NO | — | FK a `docentes.id`, `ON DELETE CASCADE`. Parte de la PK compuesta. |

### `auditoria_logs`

| Columna | Tipo | Nulo | Default | Descripción |
|---|---|---|---|---|
| id | bigint | NO | identity | PK. |
| fecha | text | NO | — | Fecha/hora ya formateada para mostrar (`dd/mm/aaaa hh:mm:ss`). |
| timestamp | bigint | NO | — | Epoch en milisegundos; indexado, se usa para ordenar/filtrar. |
| usuario | text | SÍ | — | Usuario que hizo la acción (o DNI del docente). |
| rol | text | SÍ | — | Rol de ese usuario en el momento de la acción. |
| accion | text | NO | — | Código corto: `FICHAJE`, `ALTA_DOCENTE`, `PERMISO_DENEGADO`, `EDITAR_GEOCERCA`, etc. |
| detalle | text | SÍ | — | Descripción legible de la acción. |
| dispositivo | text | SÍ | — | `navigator.userAgent`. |
| plataforma | text | SÍ | — | `navigator.platform`. |
| ubicacion | jsonb | SÍ | — | `{lat,lng,precision,direccion,...}` si se pudo resolver; `null` si no. |
| created_at | timestamptz | NO | `now()` | |

## Contenido de `app_data.value` por `key`

Cada fila de `app_data` es una colección completa. Estas tablas
describen los campos de **cada elemento** del array (o del objeto,
cuando la colección es singular).

### `key = 'teachers'` (un elemento del array)

| Campo | Tipo | Nulo | Descripción |
|---|---|---|---|
| id | text | NO | Identificador interno (`Date.now().toString()`), distinto del `id` de `docentes`. |
| dni | text | NO | Documento; también su usuario de login. Único dentro del array. |
| nombre / apellido | text | NO | |
| materia | text | SÍ | Campo libre heredado (previo al módulo de Materias). |
| telefono / telefonoFamiliar / email | text | SÍ/NO | Teléfono y e-mail son obligatorios en el alta actual. |
| calle / numero / barrio / localidad / provincia / pais | text | SÍ | Domicilio normalizado en 6 campos. |
| photo | text | NO | Foto de perfil en `dataURL` (base64). |
| faceDescriptor | number[] (128) | NO | Descriptor biométrico facial (face-api.js), para el reconocimiento. |
| horario_laboral | `[{dia,inicio,fin}]` | SÍ | Horario propio, heredado; se ignora si el docente ya tiene materias asignadas. |
| password | text | NO | Contraseña de fichaje, en texto plano. |
| debeCambiarPassword | boolean | SÍ | Obliga a cambiarla en el primer login. |
| active | boolean | SÍ | |
| createdAt | text (ISO) | SÍ | |

### `key = 'attendance'` (un elemento del array — un fichaje)

| Campo | Tipo | Descripción |
|---|---|---|
| id | text | `Date.now().toString()` del momento del fichaje. |
| teacherId / teacherName | text | Referencia lógica a `teachers[].id` (no hay FK real: son arrays JSON separados). |
| date | text (`aaaa-mm-dd`) | |
| time | text (`hh:mm:ss`) | |
| type | text | `entry` \| `exit` \| `early_exit`. |
| status | text | `present` \| `late`, calculado al fichar. |
| timestamp / horaFichajeReal | text (ISO) | Momento real del hecho (nunca se pisa, ver `firstOffline`/offline más abajo). |
| categoria | text | `regular` (cátedra) \| `evento`. |
| materiaId | number | Solo si el docente tiene 2+ materias y eligió una al fichar. |
| eventoId / eventoTitulo / eventoHoraEntrada / eventoHoraSalida | — | Solo si `categoria = 'evento'`. |
| fichajeLat / fichajeLng | double | Coordenadas GPS reales del fichaje. |
| fichajeDistanciaMts | number | Distancia al punto de la geocerca. |
| fichajePrecisionM | number | Precisión del GPS, en metros. |
| fichajeFakeGpsSospechoso | boolean | Heurística anti-GPS-falso. |
| dentroGeocerca | boolean | Si pasó la geocerca o no. |
| geofenceStatus / offline / coords | — | Presentes solo en fichajes offline pendientes de revalidar (modo avión). |
| direccionFichaje / ip / horaSync / syncUbicacion | — | Se completan en segundo plano al reconectar. |
| anulado / anuladoEn | boolean / text (ISO) | El propio docente anuló este fichaje dentro de los 10 min (nunca se borra). |
| corregidoPorDocente / fichajeAnuladoId | boolean / text | Marca el fichaje de reemplazo generado tras un `anulado`, y a cuál anula. |

### `key = 'alerts'` (un elemento del array)

| Campo | Tipo | Descripción |
|---|---|---|
| id | text | |
| teacherId / teacherName | text | |
| type | text | `Falta` \| `Tardanza` \| `Salida Anticipada` \| `Falta Evento` \| `Tardanza Evento`. |
| message | text | |
| date | text (ISO) | Momento en que se generó la alerta. |
| faltaDate | text | Solo alertas de Falta: la fecha a la que corresponde. |
| eventoId | number | Solo alertas de evento. |
| justified | boolean | Si ya está resuelta. |
| justification | text | `justificada` \| `injustificada` \| `enfermedad` \| `personal` \| `otro` \| `licencia` \| `pendiente_aprobacion_rectoria`. |

### `key = 'licencias'` (un elemento del array)

| Campo | Tipo | Descripción |
|---|---|---|
| id | text | |
| teacherId / teacherName | text | |
| from / to | text (`aaaa-mm-dd`) | Rango de la licencia. |
| motivo | text | |
| createdAt | text (ISO) | |

### `key = 'criteria'` (objeto único)

| Campo | Tipo | Default | Descripción |
|---|---|---|---|
| lateLimit | number | 15 | Heredado; ya no tiene campo propio en "Criterios de Asistencia" (se sacó por redundante), pero lo sigue leyendo la lógica de tardanza existente. |
| minAttendance | number | 80 | % mínimo de asistencia exigido. |
| minHours | number | 4 | Horas mínimas diarias. |
| limitePresenteMin | number | 10 | Semáforo de puntualidad: minutos desde la hora asignada para contar "Presente". |
| limiteTardanzaMin | number | 15 | Techo de "Tardanza". |
| limiteMediaFaltaMin | number | 20 | Techo de "Media Falta"; pasado este valor (o sin fichar), "Ausente". |

### `key = 'geofence'` (objeto único)

| Campo | Tipo | Descripción |
|---|---|---|
| lat / lng | double | Punto de fichaje del colegio. |
| radio | number | Metros. |
| nombreLugar | text | |
| actualizadoPor / actualizadoEn | text | Auditoría del último cambio. |

### `key = 'modoPrueba'` (objeto único)

| Campo | Tipo | Descripción |
|---|---|---|
| activo | boolean | Si está prendido, se puede fichar sin exigir geocerca (pruebas). |

### `key = 'kioskPrincipal'` (objeto único) / `key = 'kioskCodes'` (array)

| Campo | Tipo | Descripción |
|---|---|---|
| (kioskPrincipal) deviceId / autorizadoEn | text | PC fija autorizada como kiosco, exenta de geocerca. |
| (kioskCodes) código, usado, expira | — | Códigos de 6 dígitos de un solo uso para autorizar un kiosco nuevo. |
