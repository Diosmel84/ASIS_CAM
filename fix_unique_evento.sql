-- Ejecutar una sola vez en el SQL Editor de Supabase (proyecto kclnaabvcxdovvgblyoc).
--
-- Evita que se puedan crear dos "Eventos Especiales" con el mismo título +
-- fecha + hora de entrada (típicamente por un doble clic en "Guardar" al
-- crear el evento). El frontend (index.html -> saveEvento()) ya hace una
-- verificación antes de insertar, pero esta constraint es el freno real
-- contra la condición de carrera (dos clics casi simultáneos que pasan la
-- verificación del frontend casi al mismo tiempo).
--
-- IMPORTANTE: ya existe en la base un evento duplicado real -
-- "Acto por el día del Estudiante" del 2026-09-12 19:15, con id_evento 10 y
-- 11, cada uno con los mismos 5 docentes convocados. Varios docentes ya
-- ficharon contra AMBOS ids (hay asistencias de eventos guardadas con
-- eventoId:10 y con eventoId:11 para la misma gente). El ALTER TABLE de más
-- abajo va a FALLAR si esas dos filas duplicadas siguen existiendo, así que
-- hay que decidir primero cuál id_evento se conserva y fusionar a mano:
--
-- 1) Mirar cuál de los dos (10 u 11) tiene más registros de asistencia
--    reales antes de decidir cuál borrar (ajustar los ids según lo que
--    encuentres si el duplicado es otro):
--
--    select id_docente from evento_docente where id_evento in (10, 11);
--
-- 2) Mover las convocatorias del evento que se va a borrar (11) al que se
--    conserva (10), evitando duplicar filas ya existentes:
--
--    insert into evento_docente (id_evento, id_docente)
--    select 10, id_docente from evento_docente
--    where id_evento = 11
--    and id_docente not in (select id_docente from evento_docente where id_evento = 10);
--
--    delete from evento_docente where id_evento = 11;
--
-- 3) Las asistencias de evento viven en app_data (key='attendance', un
--    array JSON), no en una tabla de Supabase, así que NO se corrigen con
--    SQL. Hay que editarlas a mano desde el navegador (o pedirle a Claude
--    que lo haga) para que las filas con eventoId:11 pasen a eventoId:10 -
--    si no, esas asistencias "reales" del evento 11 van a quedar
--    huérfanas una vez borrado.
--
-- 4) Recién ahí borrar el evento 11:
--
--    delete from evento_especial where id_evento = 11;
--
-- Con eso ya no hay filas duplicadas y el ALTER TABLE de abajo va a andar.

alter table evento_especial
    add constraint unique_evento_dia_horario unique (titulo, fecha, hora_entrada);

notify pgrst, 'reload schema';
