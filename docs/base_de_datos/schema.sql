-- ============================================================
-- ASISCAM PRO — Esquema de base de datos (PostgreSQL / Supabase)
-- Documentación para la materia Base de Datos
-- ============================================================
--
-- Este archivo reconstruye, en un solo DDL ordenado, el estado ACTUAL
-- de la base de datos del proyecto (proyecto Supabase kclnaabvcxdovvgblyoc)
-- a partir de:
--   1) las migraciones SQL versionadas en la raíz del repositorio
--      (supabase_schema.sql, usuarios_schema.sql, add_tabla_materias.sql,
--      add_horarios_por_dia_materias.sql, add_geocerca_evento.sql,
--      add_tabla_auditoria_logs.sql, add_secretaria_rector_usuarios.sql,
--      fix_rls_eventos.sql, fix_cascade_delete.sql, fix_unique_evento.sql,
--      migrate_kclnaabvcxdovvgblyoc_schema.sql), aplicadas en ese orden;
--   2) el uso real de cada tabla en el código (script.js/auditoria.js,
--      llamadas sb.from('...')), que es la fuente de verdad cuando una
--      migración no alcanza a mostrar el estado final de una columna.
--
-- Solo se documentan acá las tablas REALMENTE conectadas a la app hoy
-- (confirmado por código, no supuesto). El repositorio también tiene
-- supabase-schema.sql, con las tablas escuelas/docentes(v1)/asistencias/
-- suscripciones: quedan fuera de este archivo a propósito porque ese
-- script trae en su propio encabezado la advertencia "todavía NO está
-- conectado a la app" — es el diseño reservado para una futura versión
-- multi-escuela, nunca cableado al código (ver decisiones_de_diseño.md).
--
-- Dos tablas con nombre `docentes` en el repo, aclaración importante:
-- la que se crea acá abajo es la REAL (nació como `docente`, ver
-- migrate_kclnaabvcxdovvgblyoc_schema.sql), usada por Materias y
-- Eventos Especiales. NO es la tabla `docentes` de supabase-schema.sql
-- (esa es la dormant del punto anterior).
--
-- evento_especial / evento_docente: las columnas que se ven en las
-- migraciones de ALTER (add_geocerca_evento.sql, migrate_...) confirman
-- que ya existían antes de que este repo llevara historial de SQL
-- versionado (fueron creadas a mano en el SQL Editor de Supabase). Se
-- reconstruyen acá a partir de esas migraciones + el uso real en
-- script.js. evento_docente en particular: el código nunca lee su PK
-- propia (siempre opera por el par evento_id/docente_id: inserta,
-- borra por evento_id, selecciona docente_id) — se modela con PK
-- compuesta, que es además el diseño correcto de libro para una tabla
-- puente N:M, en vez de inventar un id que el sistema no usa.
--
-- NO incluye Supabase Auth: esta app no lo usa (ver advertencias de
-- seguridad repetidas en cada bloque de políticas RLS más abajo, y
-- decisiones_de_diseño.md).
-- ============================================================


-- ============================================================
-- 1) usuarios
-- Una sola cuenta por rol ADMIN (Secretaría/Rector/Programador). Los
-- docentes NO están acá (viven en app_data, ver más abajo) — usuarios
-- es exclusivamente el login de los 3 roles de gestión.
-- ============================================================
create table if not exists usuarios (
    id                  bigint generated always as identity primary key,
    usuario             text not null unique,          -- 'ADMIN' (Programador) | 'ADMIN1' (Secretaría) | 'ADMIN2' (Rector)
    password            text not null,                 -- Programador: texto plano (recuperable por e-mail). Secretaría/Rector: hash SHA-256.
    rol                 text not null default 'admin',  -- 'admin' | 'secretaria' | 'rector'
    email               text,
    email_respaldo      text,
    reset_token         text,                           -- token de un solo uso para "¿Olvidaste tu contraseña?" (solo Programador)
    reset_token_expira  timestamptz,
    updated_at          timestamptz not null default now()
);

alter table usuarios enable row level security;

-- Sin Supabase Auth (ver decisiones_de_diseño.md): política abierta a
-- "anon" solo para select + update (nunca insert/delete desde el
-- cliente — las 3 filas se cargan a mano, una vez, por SQL).
drop policy if exists "usuarios_select_anon" on usuarios;
create policy "usuarios_select_anon" on usuarios for select to anon using (true);
drop policy if exists "usuarios_update_anon" on usuarios;
create policy "usuarios_update_anon" on usuarios for update to anon using (true) with check (true);


-- ============================================================
-- 2) app_data
-- Almacén clave/valor: cada fila es una "colección" completa en jsonb
-- (arrays u objetos). Es la fuente de verdad de docentes, fichajes,
-- alertas, licencias y toda la configuración operativa del sistema
-- (ver decisiones_de_diseño.md para la justificación de este diseño
-- deliberadamente NO normalizado).
--
-- Claves usadas hoy (DATA_KEYS en script.js) y qué guarda cada una:
--   'teachers'      -> array de docentes (cuenta de fichaje: dni,
--                      password, foto, descriptor facial, contacto,
--                      domicilio, horario_laboral heredado)
--   'attendance'    -> array de fichajes (entrada/salida/retirada,
--                      cátedra regular y eventos especiales)
--   'alerts'        -> array de alertas (Falta/Tardanza/Salida
--                      Anticipada) con su resolución (Rector) o envío
--                      a aprobación (Secretaría)
--   'licencias'     -> array de licencias/permisos por docente
--   'criteria'      -> UN objeto con los umbrales configurables:
--                      lateLimit, minAttendance, minHours,
--                      limitePresenteMin, limiteTardanzaMin,
--                      limiteMediaFaltaMin
--   'geofence'      -> UN objeto con el punto + radio de fichaje
--   'modoPrueba'    -> UN objeto ({activo:boolean}) para probar el
--                      sistema sin exigir geocerca
--   'kioskPrincipal'-> UN objeto: PC autorizada como kiosco fijo
--   'kioskCodes'    -> array de códigos de autorización de kiosco
--
-- Ver diccionario_de_datos.md para el detalle campo por campo de cada
-- clave.
-- ============================================================
create table if not exists app_data (
    key         text primary key,
    value       jsonb not null default '[]'::jsonb,
    updated_at  timestamptz not null default now()
);

alter table app_data enable row level security;

-- ADVERTENCIA DE SEGURIDAD (documentada en el propio repo, supabase_schema.sql):
-- sin Supabase Auth, cualquiera con la clave "publishable" (pública en
-- el HTML) puede leer y escribir esta tabla. Acá se guardan datos
-- sensibles: contraseñas de docentes en texto plano y descriptores
-- biométricos faciales. Ver decisiones_de_diseño.md.
drop policy if exists "app_data_select_anon" on app_data;
create policy "app_data_select_anon" on app_data for select to anon using (true);
drop policy if exists "app_data_insert_anon" on app_data;
create policy "app_data_insert_anon" on app_data for insert to anon with check (true);
drop policy if exists "app_data_update_anon" on app_data;
create policy "app_data_update_anon" on app_data for update to anon using (true) with check (true);

insert into app_data (key, value) values
    ('teachers', '[]'), ('attendance', '[]'), ('alerts', '[]'), ('licencias', '[]'),
    ('criteria', '{}'), ('geofence', 'null'), ('modoPrueba', '{"activo": false}'),
    ('kioskPrincipal', 'null'), ('kioskCodes', '[]')
on conflict (key) do nothing;


-- ============================================================
-- 3) carreras
-- Carreras/orientaciones del establecimiento (p. ej. "Bachiller en
-- Informática"). Agrupan a las materias.
-- ============================================================
create table if not exists carreras (
    id          bigint generated always as identity primary key,
    escuela_id  bigint not null default 2,  -- reservado a multi-escuela; NO tiene FK real hoy (ver decisiones_de_diseño.md)
    nombre      text not null unique,
    created_at  timestamptz not null default now()
);

alter table carreras enable row level security;
drop policy if exists "carreras_select_anon" on carreras;
create policy "carreras_select_anon" on carreras for select to anon using (true);
drop policy if exists "carreras_insert_anon" on carreras;
create policy "carreras_insert_anon" on carreras for insert to anon with check (true);
drop policy if exists "carreras_update_anon" on carreras;
create policy "carreras_update_anon" on carreras for update to anon using (true) with check (true);
drop policy if exists "carreras_delete_anon" on carreras;
create policy "carreras_delete_anon" on carreras for delete to anon using (true);


-- ============================================================
-- 4) docentes
-- Espejo relacional MÍNIMO de app_data.teachers, que existe con un
-- único propósito: darle a materias.profesor_id y evento_docente.
-- docente_id una fila real a la que apuntar por FK (Postgres no puede
-- referenciar un elemento dentro de un array jsonb). Se sincroniza
-- automáticamente por dni cada vez que un docente se asigna a una
-- materia o se convoca a un evento (ver syncTeacherToDocenteTable() en
-- script.js) — nunca se edita a mano. NO es la fuente de verdad del
-- perfil del docente (eso es app_data.teachers); no guarda fichajes,
-- foto ni biometría.
-- ============================================================
create table if not exists docentes (
    id          bigint generated by default as identity (start with 500000) primary key,
    escuela_id  bigint not null default 2,  -- reservado a multi-escuela; NO tiene FK real hoy
    dni         text not null unique,       -- clave real de sincronización con app_data.teachers[].dni
    nombre      text not null,
    apellido    text not null,
    email       text,
    telefono    text,
    password    text,
    calle       text,
    numero      text,
    barrio      text,
    localidad   text default 'RESISTENCIA',
    provincia   text default 'CHACO',
    pais        text default 'ARGENTINA',
    created_at  timestamptz not null default now()
);

alter table docentes enable row level security;
drop policy if exists "docentes_select_anon" on docentes;
create policy "docentes_select_anon" on docentes for select to anon using (true);
drop policy if exists "docentes_insert_anon" on docentes;
create policy "docentes_insert_anon" on docentes for insert to anon with check (true);
drop policy if exists "docentes_update_anon" on docentes;
create policy "docentes_update_anon" on docentes for update to anon using (true) with check (true);


-- ============================================================
-- 5) materias
-- Grilla de cátedra: qué materia se dicta, en qué carrera/año/
-- cuatrimestre, con qué horario y a cargo de qué docente. Capa nueva
-- en paralelo al horario_laboral histórico de cada docente (que sigue
-- viviendo en app_data.teachers y se usa solo si el docente todavía no
-- tiene ninguna materia asignada).
-- ============================================================
create table if not exists materias (
    id            bigint generated always as identity primary key,
    escuela_id    bigint not null default 2,
    carrera_id    bigint not null references carreras(id) on delete restrict,  -- RESTRICT desde fix_cascade_delete.sql (antes CASCADE por error)
    nombre        text not null,
    anio          smallint not null check (anio in (1, 2, 3)),
    cuatrimestre  smallint not null check (cuatrimestre in (1, 2)),
    tipo          text not null check (tipo in ('ANUAL', 'CUATRIMESTRAL')),
    dias          text[] not null default '{}',   -- heredado; hoy se deriva de horarios, no se edita directo
    hora_inicio   time,                             -- heredado (nullable desde add_horarios_por_dia_materias.sql)
    hora_fin      time,                             -- heredado (nullable desde add_horarios_por_dia_materias.sql)
    horarios      jsonb,                             -- [{"dia":"Lunes","inicio":"18:00","fin":"19:20"}, ...] — fuente real del horario
    profesor_id   bigint references docentes(id) on delete set null,  -- opcional: una materia puede crearse sin profesor asignado todavía
    created_at    timestamptz not null default now()
);

alter table materias enable row level security;
drop policy if exists "materias_select_anon" on materias;
create policy "materias_select_anon" on materias for select to anon using (true);
drop policy if exists "materias_insert_anon" on materias;
create policy "materias_insert_anon" on materias for insert to anon with check (true);
drop policy if exists "materias_update_anon" on materias;
create policy "materias_update_anon" on materias for update to anon using (true) with check (true);
drop policy if exists "materias_delete_anon" on materias;
create policy "materias_delete_anon" on materias for delete to anon using (true);


-- ============================================================
-- 6) evento_especial
-- Actos, capacitaciones u otros eventos puntuales fuera de la cátedra
-- regular, con convocatoria propia de docentes (ver evento_docente) y,
-- opcionalmente, su propia geocerca (si el evento es fuera del
-- colegio).
-- ============================================================
create table if not exists evento_especial (
    id                bigint generated always as identity primary key,
    escuela_id        bigint not null default 2,
    titulo            text not null,
    descripcion       text,
    fecha_inicio      timestamp not null,   -- reemplazó a fecha+hora_entrada (migrate_kclnaabvcxdovvgblyoc_schema.sql)
    fecha_fin         timestamp not null,   -- reemplazó a fecha+hora_salida
    direccion_evento  text,
    tiene_geocerca    boolean not null default false,
    geocerca_lat      double precision,
    geocerca_lng      double precision,
    geocerca_radio    integer,
    created_at        timestamptz not null default now(),
    constraint unique_evento_titulo_inicio unique (titulo, fecha_inicio)  -- freno anti doble-clic en "Guardar"
);

alter table evento_especial enable row level security;
drop policy if exists "evento_especial_select_anon" on evento_especial;
create policy "evento_especial_select_anon" on evento_especial for select to anon using (true);
drop policy if exists "evento_especial_insert_anon" on evento_especial;
create policy "evento_especial_insert_anon" on evento_especial for insert to anon with check (true);
drop policy if exists "evento_especial_update_anon" on evento_especial;
create policy "evento_especial_update_anon" on evento_especial for update to anon using (true) with check (true);
drop policy if exists "evento_especial_delete_anon" on evento_especial;
create policy "evento_especial_delete_anon" on evento_especial for delete to anon using (true);


-- ============================================================
-- 7) evento_docente
-- Tabla puente N:M entre evento_especial y docentes: qué docentes
-- fueron convocados a cada evento. Sin columnas propias más allá de
-- las 2 FK — el código siempre la reescribe entera por evento
-- (borra todas las filas de un evento_id y vuelve a insertar), nunca
-- lee ni depende de una PK propia, por eso PK compuesta en vez de un
-- id inventado que el sistema no usa.
-- ============================================================
create table if not exists evento_docente (
    evento_id   bigint not null references evento_especial(id) on delete cascade,
    docente_id  bigint not null references docentes(id) on delete cascade,
    primary key (evento_id, docente_id)
);

alter table evento_docente enable row level security;
drop policy if exists "evento_docente_select_anon" on evento_docente;
create policy "evento_docente_select_anon" on evento_docente for select to anon using (true);
drop policy if exists "evento_docente_insert_anon" on evento_docente;
create policy "evento_docente_insert_anon" on evento_docente for insert to anon with check (true);
drop policy if exists "evento_docente_update_anon" on evento_docente;
create policy "evento_docente_update_anon" on evento_docente for update to anon using (true) with check (true);
drop policy if exists "evento_docente_delete_anon" on evento_docente;
create policy "evento_docente_delete_anon" on evento_docente for delete to anon using (true);


-- ============================================================
-- 8) auditoria_logs
-- Log de auditoría de acciones del sistema (fichajes, altas/bajas,
-- permisos denegados, cambios de configuración, etc.), visible desde
-- cualquier dispositivo. Una fila por acción — nunca se actualiza,
-- solo se inserta y (ocasionalmente) se borra todo el historial desde
-- el panel de Programador, con backup automático previo.
-- ============================================================
create table if not exists auditoria_logs (
    id          bigint generated always as identity primary key,
    fecha       text not null,     -- fecha/hora ya formateada para mostrar (dd/mm/aaaa hh:mm:ss)
    timestamp   bigint not null,   -- epoch ms, para ordenar/filtrar por rango
    usuario     text,
    rol         text,
    accion      text not null,     -- p. ej. 'FICHAJE', 'ALTA_DOCENTE', 'PERMISO_DENEGADO'
    detalle     text,
    dispositivo text,              -- navigator.userAgent
    plataforma  text,              -- navigator.platform
    ubicacion   jsonb,             -- {lat,lng,precision,direccion,...} si se pudo resolver
    created_at  timestamptz not null default now()
);

create index if not exists auditoria_logs_timestamp_idx on auditoria_logs (timestamp);

alter table auditoria_logs enable row level security;
drop policy if exists "auditoria_logs_select_anon" on auditoria_logs;
create policy "auditoria_logs_select_anon" on auditoria_logs for select to anon using (true);
drop policy if exists "auditoria_logs_insert_anon" on auditoria_logs;
create policy "auditoria_logs_insert_anon" on auditoria_logs for insert to anon with check (true);
drop policy if exists "auditoria_logs_delete_anon" on auditoria_logs;
create policy "auditoria_logs_delete_anon" on auditoria_logs for delete to anon using (true);


-- ============================================================
-- Fuerza a PostgREST a refrescar su caché de esquema (necesario cada
-- vez que se crea/altera una tabla desde el SQL Editor de Supabase).
-- ============================================================
notify pgrst, 'reload schema';
