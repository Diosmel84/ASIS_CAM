-- ASISCAM PRO - esquema base (tablas vacías, para correr una sola vez en
-- el SQL Editor de Supabase).
--
-- IMPORTANTE - esto todavía NO está conectado a la app: script.js hoy
-- guarda docentes/asistencias como JSON dentro de app_data (ver
-- supabase_schema.sql) y no lee ni escribe en estas tablas. Son la base
-- para una futura migración a un modelo relacional real y multi-escuela
-- (necesaria para la versión PRO con suscripción paga), pero requiere
-- reescribir la capa de datos de script.js para usarlas en vez de
-- app_data. No corras esto esperando que cambie el comportamiento actual
-- de la app.

create table if not exists escuelas (
    id bigint generated always as identity primary key,
    nombre text not null,
    direccion text,
    created_at timestamptz not null default now()
);

create table if not exists docentes (
    id bigint generated always as identity primary key,
    escuela_id bigint references escuelas(id) on delete cascade,
    dni text not null unique,
    nombre text not null,
    apellido text not null,
    email text,
    telefono text,
    password text not null,
    created_at timestamptz not null default now()
);

create table if not exists asistencias (
    id bigint generated always as identity primary key,
    docente_id bigint references docentes(id) on delete cascade,
    tipo text not null check (tipo in ('entry', 'exit', 'early_exit')),
    fecha date not null,
    hora time not null,
    estado text,
    created_at timestamptz not null default now()
);

create table if not exists suscripciones (
    id bigint generated always as identity primary key,
    escuela_id bigint references escuelas(id) on delete cascade,
    plan text not null default 'PRO',
    fecha_inicio date not null default current_date,
    fecha_vencimiento date not null,
    estado text not null default 'activa' check (estado in ('activa', 'vencida', 'cancelada')),
    created_at timestamptz not null default now()
);

alter table escuelas enable row level security;
alter table docentes enable row level security;
alter table asistencias enable row level security;
alter table suscripciones enable row level security;

-- Mismo modelo de seguridad que el resto de la app (ver fix_rls_eventos.sql
-- / usuarios_schema.sql): sin Supabase Auth, políticas abiertas a "anon"
-- para que el cliente pueda leer/escribir con la clave publishable. Ajustar
-- si en algún momento se migra el login a Supabase Auth.
drop policy if exists "escuelas_select_anon" on escuelas;
create policy "escuelas_select_anon" on escuelas for select to anon using (true);

drop policy if exists "docentes_select_anon" on docentes;
create policy "docentes_select_anon" on docentes for select to anon using (true);

drop policy if exists "asistencias_select_anon" on asistencias;
create policy "asistencias_select_anon" on asistencias for select to anon using (true);

drop policy if exists "suscripciones_select_anon" on suscripciones;
create policy "suscripciones_select_anon" on suscripciones for select to anon using (true);

notify pgrst, 'reload schema';
