-- Ejecutar UNA VEZ en el SQL Editor de Supabase (proyecto kclnaabvcxdovvgblyoc).
--
-- Certificados de Licencias: el Docente (a sus propias licencias),
-- Secretaría (ADMIN1) y Rector (ADMIN2) pueden adjuntar certificados
-- (JPG, PNG o PDF) a una licencia. El archivo va al bucket de Storage
-- "certificados-licencias" y la tabla licencia_certificado guarda a qué
-- licencia pertenece y quién lo subió (ver la sección CERTIFICADOS DE
-- LICENCIAS en script.js).
--
-- Las licencias viven en app_data (clave "licencias", un JSON), no en
-- una tabla propia: por eso licencia_id y teacher_id son texto (el id
-- de la licencia y del docente dentro de ese JSON) y no tienen FK.
--
-- ADVERTENCIA DE SEGURIDAD (la misma de fix_rls_eventos.sql): esta app
-- no usa Supabase Auth, así que las políticas quedan abiertas a "anon".
-- El control de quién puede subir/borrar se hace en el navegador
-- (MATRIZ_PERMISOS en roles.js). El bucket es PRIVADO: los archivos solo
-- se ven con una URL firmada temporal que genera la app.

-- ===== Tabla =====
create table if not exists licencia_certificado (
    id bigint generated always as identity primary key,
    licencia_id text not null,
    teacher_id text not null,
    nombre_archivo text not null,
    ruta text not null unique,
    tipo_mime text not null check (tipo_mime in ('image/jpeg', 'image/png', 'application/pdf')),
    tamano_bytes integer,
    subido_por_rol text not null,
    subido_por text,
    created_at timestamptz not null default now()
);

create index if not exists licencia_certificado_licencia_idx on licencia_certificado(licencia_id);
create index if not exists licencia_certificado_teacher_idx on licencia_certificado(teacher_id);

alter table licencia_certificado enable row level security;

drop policy if exists "licencia_certificado_select_anon" on licencia_certificado;
create policy "licencia_certificado_select_anon" on licencia_certificado
    for select to anon using (true);

drop policy if exists "licencia_certificado_insert_anon" on licencia_certificado;
create policy "licencia_certificado_insert_anon" on licencia_certificado
    for insert to anon with check (true);

drop policy if exists "licencia_certificado_delete_anon" on licencia_certificado;
create policy "licencia_certificado_delete_anon" on licencia_certificado
    for delete to anon using (true);

-- ===== Bucket de Storage =====
-- Privado, máximo 5 MB por archivo y solo JPG/PNG/PDF (el navegador
-- valida lo mismo antes de subir, esto es el freno del lado servidor).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('certificados-licencias', 'certificados-licencias', false, 5242880,
        array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "certificados_licencias_select_anon" on storage.objects;
create policy "certificados_licencias_select_anon" on storage.objects
    for select to anon using (bucket_id = 'certificados-licencias');

drop policy if exists "certificados_licencias_insert_anon" on storage.objects;
create policy "certificados_licencias_insert_anon" on storage.objects
    for insert to anon with check (bucket_id = 'certificados-licencias');

drop policy if exists "certificados_licencias_delete_anon" on storage.objects;
create policy "certificados_licencias_delete_anon" on storage.objects
    for delete to anon using (bucket_id = 'certificados-licencias');

notify pgrst, 'reload schema';
