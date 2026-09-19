-- Ejecutar UNA VEZ en el SQL Editor de Supabase.
--
-- Hasta ahora el log de auditoría (logAccion() en auditoria.js) vivía
-- SOLO en localStorage - por diseño original, pero eso significa que
-- cada navegador/dispositivo tiene su propio historial separado: si
-- Secretaría loguea desde su PC y Programador mira el panel desde
-- otra, cada uno ve solo lo que pasó en la suya. Esta tabla pasa a ser
-- la fuente principal (se ve desde cualquier dispositivo);
-- localStorage queda como respaldo si no hay conexión.
--
-- Una fila por acción (no un JSON gigante en app_data) para no tener
-- que resubir todo el historial en cada fichaje/login.

create table if not exists auditoria_logs (
    id bigint generated always as identity primary key,
    fecha text not null,
    timestamp bigint not null,
    usuario text,
    rol text,
    accion text not null,
    detalle text,
    dispositivo text,
    plataforma text,
    ubicacion jsonb,
    created_at timestamptz not null default now()
);

create index if not exists auditoria_logs_timestamp_idx on auditoria_logs (timestamp);

alter table auditoria_logs enable row level security;

-- Mismo modelo abierto a "anon" que el resto de la app (sin Supabase
-- Auth). No hace falta política de update: los logs son inmutables,
-- solo se insertan y (desde "Borrar LOG", con confirmación + backup
-- automático) se borran todos.
drop policy if exists "auditoria_logs_select_anon" on auditoria_logs;
create policy "auditoria_logs_select_anon" on auditoria_logs for select to anon using (true);
drop policy if exists "auditoria_logs_insert_anon" on auditoria_logs;
create policy "auditoria_logs_insert_anon" on auditoria_logs for insert to anon with check (true);
drop policy if exists "auditoria_logs_delete_anon" on auditoria_logs;
create policy "auditoria_logs_delete_anon" on auditoria_logs for delete to anon using (true);

notify pgrst, 'reload schema';
