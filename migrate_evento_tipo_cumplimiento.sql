-- Ejecutar una sola vez en el SQL Editor de Supabase.
--
-- Agrega tipo_cumplimiento a evento_especial: "con_perjuicio" (el
-- docente convocado SOLO va al evento, no da sus materias ese día) o
-- "sin_perjuicio" (va al evento Y además debe dar clases igual - son
-- dos obligaciones independientes). Ver script.js: checkFaltas(),
-- getDocentesEsperadosHoy(), getEventoEntriesParaHoy().
--
-- Default 'con_perjuicio' a propósito: preserva el comportamiento que
-- ya tenía la app para todos los eventos existentes (checkFaltas() ya
-- saltaba la Falta de cátedra regular en la fecha de CUALQUIER evento,
-- sin distinguir - ver teacherHasEventoOnDate() antes de este fix), así
-- que los eventos ya cargados no cambian de comportamiento solo por
-- correr esta migración. Revisá los eventos existentes después y
-- marcá "sin_perjuicio" a mano los que correspondan.
alter table evento_especial add column if not exists tipo_cumplimiento text not null default 'con_perjuicio';

do $$
begin
    alter table evento_especial add constraint evento_especial_tipo_cumplimiento_check
        check (tipo_cumplimiento in ('con_perjuicio', 'sin_perjuicio'));
exception
    when duplicate_object then null;
end $$;

notify pgrst, 'reload schema';
