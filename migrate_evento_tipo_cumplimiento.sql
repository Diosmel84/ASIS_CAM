-- Ejecutar una sola vez en el SQL Editor de Supabase.
--
-- YA SE CORRIÓ (2026-09-21) en el proyecto real, con un ajuste manual
-- posterior: el constraint quedó con los valores en MAYÚSCULA
-- ('CON_PERJUICIO'/'SIN_PERJUICIO', no en minúscula como decía la
-- versión original de este archivo) para que coincida con lo que
-- guarda script.js. Se deja el script actualizado en el repo como
-- referencia/historial para instalaciones nuevas; volver a correrlo
-- no debería romper nada (add column/constraint con manejo de
-- duplicate_object).
--
-- Agrega tipo_cumplimiento a evento_especial: "CON_PERJUICIO" (el
-- docente convocado SOLO va al evento, no da sus materias ese día) o
-- "SIN_PERJUICIO" (va al evento Y además debe dar clases igual - son
-- dos obligaciones independientes). Ver script.js: checkFaltas(),
-- getDocentesEsperadosHoy(), getEventoEntriesParaHoy().
--
-- Default 'CON_PERJUICIO' a propósito: preserva el comportamiento que
-- ya tenía la app para todos los eventos existentes (checkFaltas() ya
-- saltaba la Falta de cátedra regular en la fecha de CUALQUIER evento,
-- sin distinguir - ver teacherHasEventoOnDate() antes de este fix), así
-- que los eventos ya cargados no cambian de comportamiento solo por
-- correr esta migración. Revisá los eventos existentes después y
-- marcá "SIN_PERJUICIO" a mano los que correspondan.
alter table evento_especial add column if not exists tipo_cumplimiento text not null default 'CON_PERJUICIO';

-- Si esta columna ya existía con valores en minúscula (de una corrida
-- previa de la versión vieja de este archivo), los normaliza antes de
-- agregar el constraint - si no, el constraint de abajo fallaría con
-- filas existentes en minúscula.
update evento_especial set tipo_cumplimiento = upper(tipo_cumplimiento)
where tipo_cumplimiento in ('con_perjuicio', 'sin_perjuicio');

do $$
begin
    alter table evento_especial drop constraint if exists evento_especial_tipo_cumplimiento_check;
    alter table evento_especial add constraint evento_especial_tipo_cumplimiento_check
        check (tipo_cumplimiento in ('CON_PERJUICIO', 'SIN_PERJUICIO'));
exception
    when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';
