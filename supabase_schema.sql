-- Ejecutar una sola vez en el SQL Editor de Supabase (proyecto zyxcummfswlnaupvaqor)
-- Reemplaza el localStorage del sistema de asistencia por una tabla clave/valor:
-- cada fila guarda una de las colecciones que antes vivían en localStorage
-- (teachers, attendance, alerts, licencias, criteria, weeklyGrid) como jsonb.

create table if not exists app_data (
    key text primary key,
    value jsonb not null default '[]'::jsonb,
    updated_at timestamptz not null default now()
);

alter table app_data enable row level security;

-- ADVERTENCIA DE SEGURIDAD:
-- Esta app no usa Supabase Auth (el login es una comparación de usuario/clave
-- hecha en el propio HTML, igual que antes con localStorage). Como la clave
-- "publishable" queda visible en el código fuente del HTML, cualquiera que la
-- copie puede leer y escribir esta tabla si las políticas de abajo son
-- públicas. Aquí se guardan datos sensibles: contraseñas de docentes en texto
-- plano y descriptores biométricos faciales.
--
-- Se dejan políticas abiertas (select/insert/update para "anon") porque es lo
-- mínimo para que la app funcione sin backend ni autenticación real. Si esto
-- va a producción con datos reales de personas, lo recomendable es:
--   1. Migrar el login a Supabase Auth y restringir RLS a "authenticated", o
--   2. Meter las escrituras detrás de una Supabase Edge Function que valide
--      un secreto de servidor antes de tocar la tabla.
-- drop + create (en vez de un simple "create policy") para que este script
-- se pueda volver a correr sin errores. El SQL Editor de Supabase ejecuta
-- todo el bloque como una sola transacción: si "create policy" falla porque
-- la política ya existe, TODO el script se revierte, incluida la creación
-- de la tabla de más arriba, aunque el editor la haya mostrado como
-- ejecutada un instante antes del error.
drop policy if exists "app_data_select_anon" on app_data;
create policy "app_data_select_anon" on app_data
    for select
    to anon
    using (true);

drop policy if exists "app_data_insert_anon" on app_data;
create policy "app_data_insert_anon" on app_data
    for insert
    to anon
    with check (true);

drop policy if exists "app_data_update_anon" on app_data;
create policy "app_data_update_anon" on app_data
    for update
    to anon
    using (true)
    with check (true);

-- Filas iniciales (opcional; la app hace upsert igual si faltan)
insert into app_data (key, value) values
    ('teachers', '[]'),
    ('attendance', '[]'),
    ('alerts', '[]'),
    ('licencias', '[]'),
    ('criteria', '{}'),
    ('weeklyGrid', '[]')
on conflict (key) do nothing;

-- Fuerza a PostgREST a refrescar su caché de esquema. Es lo que suele
-- faltar cuando la tabla se creó bien pero la API sigue devolviendo
-- 404 "Could not find the table 'public.app_data' in the schema cache".
notify pgrst, 'reload schema';
