-- Ejecutar UNA VEZ en el SQL Editor de Supabase.
--
-- add_tabla_materias.sql había dejado `materias.carrera_id` con
-- ON DELETE CASCADE: borrar una carrera borraba en silencio todas sus
-- materias. Esto lo cambia a ON DELETE RESTRICT (no deja borrar una
-- carrera si todavía tiene materias, hay que borrarlas a mano primero)
-- para que un borrado de prueba nunca más se lleve datos reales.
--
-- No hay tabla `alumnos` en este proyecto, así que ese punto no aplica.

-- ===== 1) Diagnóstico: mostrá esto antes de tocar nada =====
select
    conname,
    conrelid::regclass as tabla,
    confrelid::regclass as referencia,
    case confdeltype
        when 'c' then 'CASCADE'
        when 'r' then 'RESTRICT'
        when 'n' then 'SET NULL'
        when 'a' then 'NO ACTION'
        else confdeltype::text
    end as on_delete,
    pg_get_constraintdef(oid) as definicion
from pg_constraint
where contype = 'f'
  and (confrelid::regclass::text in ('carreras', 'docentes') or conrelid::regclass::text = 'materias')
order by tabla;

-- ===== 2) Arregla materias.carrera_id (el que causó el problema) =====
alter table materias drop constraint if exists materias_carrera_id_fkey;
alter table materias add constraint materias_carrera_id_fkey
    foreign key (carrera_id) references carreras(id) on delete restrict;

-- ===== 3) Catch-all: cualquier OTRA FK con CASCADE que apunte a
-- carreras o docentes (por si hay alguna que no conozco desde acá,
-- por ejemplo si la tocaste vos a mano en el dashboard) se pasa
-- también a RESTRICT, sin tener que adivinar nombres de constraint. =====
do $$
declare
    r record;
begin
    for r in
        select conname, conrelid::regclass as tabla, pg_get_constraintdef(oid) as def
        from pg_constraint
        where contype = 'f'
          and confdeltype = 'c'
          and confrelid::regclass::text in ('carreras', 'docentes')
    loop
        raise notice 'Pasando a RESTRICT: % en %', r.conname, r.tabla;
        execute format('alter table %s drop constraint %I', r.tabla, r.conname);
        -- reconstruye la misma FK, solo cambiando CASCADE -> RESTRICT
        execute format(
            'alter table %s add constraint %I %s',
            r.tabla, r.conname, replace(r.def, 'ON DELETE CASCADE', 'ON DELETE RESTRICT')
        );
    end loop;
end $$;

-- ===== 4) Verificación: debería devolver 0 filas (nada en CASCADE) =====
select conname, conrelid::regclass as tabla, confrelid::regclass as referencia
from pg_constraint
where contype = 'f'
  and confdeltype = 'c'
  and confrelid::regclass::text in ('carreras', 'docentes');

notify pgrst, 'reload schema';
