-- Ejecutar una sola vez en el SQL Editor de Supabase.
--
-- Tabla `usuarios`: guarda solo la cuenta del ADMIN (login, contraseña,
-- e-mail y el token de recuperación de contraseña). Los docentes NO están
-- acá: siguen viviendo en app_data (key='teachers'), como hasta ahora.
--
-- reset_token / reset_token_expira: usados por "¿Olvidaste tu contraseña?"
-- (ver script.js -> solicitarRecuperacionPassword / checkResetTokenFromUrl).
-- No se usa Supabase Auth para el login de esta app (ver supabase_schema.sql
-- y fix_rls_eventos.sql), así que la recuperación de contraseña se resuelve
-- con un token propio de un solo uso en vez de auth.resetPasswordForEmail.

create table if not exists usuarios (
    id bigint generated always as identity primary key,
    usuario text not null unique,
    password text not null,
    rol text not null default 'admin',
    email text,
    email_respaldo text,
    reset_token text,
    reset_token_expira timestamptz,
    updated_at timestamptz not null default now()
);

alter table usuarios enable row level security;

-- ADVERTENCIA DE SEGURIDAD (la misma que ya aplica a app_data y a
-- evento_especial/evento_docente/docente, ver fix_rls_eventos.sql): esta
-- app no usa Supabase Auth, así que cualquiera con la clave "publishable"
-- (visible en script.js) puede leer y escribir esta tabla si las políticas
-- quedan abiertas a "anon". Se abre solo select + update (nunca insert ni
-- delete desde el cliente: la única fila de ADMIN se crea acá abajo, a
-- mano, una sola vez).
drop policy if exists "usuarios_select_anon" on usuarios;
create policy "usuarios_select_anon" on usuarios
    for select
    to anon
    using (true);

drop policy if exists "usuarios_update_anon" on usuarios;
create policy "usuarios_update_anon" on usuarios
    for update
    to anon
    using (true)
    with check (true);

-- Fila inicial del ADMIN, con las mismas credenciales que ya tenía
-- hardcodeadas en CONFIG.ADMIN_USER / CONFIG.ADMIN_PASS (script.js) antes
-- de este cambio, para que el login no se rompa. Cambiala cuanto antes
-- desde "Cambiar Contraseña" en el panel de admin.
insert into usuarios (usuario, password, rol)
values ('ADMIN', 'SantaMarta', 'admin')
on conflict (usuario) do nothing;

notify pgrst, 'reload schema';
