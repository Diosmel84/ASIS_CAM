-- Ejecutar una sola vez en el SQL Editor de Supabase (proyecto kclnaabvcxdovvgblyoc).
--
-- El módulo de Eventos Especiales necesita insertar/actualizar/borrar en
-- evento_especial, evento_docente y docente desde el propio navegador (con
-- la clave "publishable" del cliente, igual que ya hace el resto de ASISCAM
-- con app_data). Hoy esas 3 tablas solo tienen política de lectura para
-- "anon", así que cualquier insert/update/delete se rechaza con
-- "new row violates row-level security policy".
--
-- ADVERTENCIA DE SEGURIDAD (la misma que ya aplica a app_data): esta app no
-- usa Supabase Auth, así que cualquiera que tenga la clave publishable
-- (visible en script.js) puede escribir en estas tablas si estas políticas
-- quedan abiertas a "anon". Se documenta la misma salvedad que en
-- supabase_schema.sql: si esto va a producción con datos reales, conviene
-- migrar a Supabase Auth o mover las escrituras detrás de una Edge Function.
--
-- No se toca la tabla `alerta`: ya tiene su política de lectura funcionando
-- y las filas las genera tu propia función/consulta del lado de Supabase,
-- el frontend solo la lee.

alter table evento_especial enable row level security;
alter table evento_docente enable row level security;
alter table docente enable row level security;

-- ===== evento_especial =====
drop policy if exists "evento_especial_select_anon" on evento_especial;
create policy "evento_especial_select_anon" on evento_especial
    for select
    to anon
    using (true);

drop policy if exists "evento_especial_insert_anon" on evento_especial;
create policy "evento_especial_insert_anon" on evento_especial
    for insert
    to anon
    with check (true);

drop policy if exists "evento_especial_update_anon" on evento_especial;
create policy "evento_especial_update_anon" on evento_especial
    for update
    to anon
    using (true)
    with check (true);

drop policy if exists "evento_especial_delete_anon" on evento_especial;
create policy "evento_especial_delete_anon" on evento_especial
    for delete
    to anon
    using (true);

-- ===== evento_docente =====
drop policy if exists "evento_docente_select_anon" on evento_docente;
create policy "evento_docente_select_anon" on evento_docente
    for select
    to anon
    using (true);

drop policy if exists "evento_docente_insert_anon" on evento_docente;
create policy "evento_docente_insert_anon" on evento_docente
    for insert
    to anon
    with check (true);

drop policy if exists "evento_docente_update_anon" on evento_docente;
create policy "evento_docente_update_anon" on evento_docente
    for update
    to anon
    using (true)
    with check (true);

drop policy if exists "evento_docente_delete_anon" on evento_docente;
create policy "evento_docente_delete_anon" on evento_docente
    for delete
    to anon
    using (true);

-- ===== docente =====
-- Se usa como espejo automático de app_data.teachers (ver
-- syncTeacherToDocenteTable en script.js): cada vez que se convoca a un
-- docente a un evento, se hace upsert de su fila acá con el mismo id
-- (convertido a número) que tiene en app_data, para que la FK de
-- evento_docente.id_docente -> docente.id_docente nunca falle.
drop policy if exists "docente_select_anon" on docente;
create policy "docente_select_anon" on docente
    for select
    to anon
    using (true);

drop policy if exists "docente_insert_anon" on docente;
create policy "docente_insert_anon" on docente
    for insert
    to anon
    with check (true);

drop policy if exists "docente_update_anon" on docente;
create policy "docente_update_anon" on docente
    for update
    to anon
    using (true)
    with check (true);

-- Fuerza a PostgREST a refrescar su caché de esquema/políticas.
notify pgrst, 'reload schema';
