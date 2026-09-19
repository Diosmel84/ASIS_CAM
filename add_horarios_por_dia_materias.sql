-- Ejecutar UNA VEZ en el SQL Editor de Supabase.
--
-- Antes, cada materia tenía UN solo horario (hora_inicio/hora_fin)
-- aplicado a todos los días de `dias`. Ahora cada día puede tener su
-- propio horario: se agrega `horarios` (jsonb), un array de objetos
-- [{"dia":"Lunes","inicio":"18:00","fin":"19:20"}, ...].
--
-- Compatibilidad: `dias`/`hora_inicio`/`hora_fin` NO se borran (para no
-- perder datos de materias ya cargadas con el modelo viejo). script.js
-- (materiaHorarios()) lee `horarios` si existe y si no, arma el mismo
-- array a partir de esas 3 columnas viejas al vuelo. De acá en más, las
-- materias nuevas o editadas se guardan solo en `horarios` - por eso
-- hora_inicio/hora_fin pasan a ser opcionales (ya no tiene sentido
-- pedir un horario único global).

alter table materias add column if not exists horarios jsonb;

alter table materias alter column hora_inicio drop not null;
alter table materias alter column hora_fin drop not null;

notify pgrst, 'reload schema';
