-- Ejecutar UNA VEZ en el SQL Editor de Supabase (proyecto kclnaabvcxdovvgblyoc).
--
-- Grilla de cátedra por materia (carrera + año + cuatrimestre), como
-- CAPA NUEVA en paralelo: no reemplaza ni toca el horario_laboral de
-- cada docente (eso sigue siendo lo único que usan las tardanzas/
-- faltas/fichaje, ver script.js -> checkFaltas/getExitWindowInfo/etc).
--
-- Convenciones seguidas para que quede consistente con el resto del
-- proyecto (ver supabase-schema.sql, fix_rls_eventos.sql):
--   - PK bigint identity, no uuid (así son TODAS las tablas de acá).
--   - profesor_id referencia a `docentes` (la tabla real, plural - ver
--     migrate_kclnaabvcxdovvgblyoc_schema.sql, que renombró `docente` a
--     `docentes`), sin UNIQUE: un docente puede tener varias materias.
--   - Políticas RLS abiertas a "anon" para select/insert/update/delete,
--     igual que evento_especial/evento_docente/docentes (esta app no usa
--     Supabase Auth, así que cualquiera con la clave "publishable" puede
--     escribir estas tablas - mismo riesgo ya aceptado en el resto del
--     proyecto, no es nuevo de esto).

create table if not exists carreras (
    id bigint generated always as identity primary key,
    escuela_id bigint not null default 2,
    nombre text not null unique,
    created_at timestamptz not null default now()
);

create table if not exists materias (
    id bigint generated always as identity primary key,
    escuela_id bigint not null default 2,
    carrera_id bigint not null references carreras(id) on delete cascade,
    nombre text not null,
    anio smallint not null check (anio in (1, 2, 3)),
    cuatrimestre smallint not null check (cuatrimestre in (1, 2)),
    tipo text not null check (tipo in ('ANUAL', 'CUATRIMESTRAL')),
    dias text[] not null default '{}',
    hora_inicio time not null,
    hora_fin time not null,
    -- Docente a cargo (opcional al crear la materia, se puede asignar
    -- después desde el alta/edición de un docente). Sin UNIQUE: un
    -- docente puede estar a cargo de varias materias.
    profesor_id bigint references docentes(id) on delete set null,
    created_at timestamptz not null default now()
);

alter table carreras enable row level security;
alter table materias enable row level security;

drop policy if exists "carreras_select_anon" on carreras;
create policy "carreras_select_anon" on carreras for select to anon using (true);
drop policy if exists "carreras_insert_anon" on carreras;
create policy "carreras_insert_anon" on carreras for insert to anon with check (true);
drop policy if exists "carreras_update_anon" on carreras;
create policy "carreras_update_anon" on carreras for update to anon using (true) with check (true);
drop policy if exists "carreras_delete_anon" on carreras;
create policy "carreras_delete_anon" on carreras for delete to anon using (true);

drop policy if exists "materias_select_anon" on materias;
create policy "materias_select_anon" on materias for select to anon using (true);
drop policy if exists "materias_insert_anon" on materias;
create policy "materias_insert_anon" on materias for insert to anon with check (true);
drop policy if exists "materias_update_anon" on materias;
create policy "materias_update_anon" on materias for update to anon using (true) with check (true);
drop policy if exists "materias_delete_anon" on materias;
create policy "materias_delete_anon" on materias for delete to anon using (true);

notify pgrst, 'reload schema';
