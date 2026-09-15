-- Ejecutar una sola vez en el SQL Editor de Supabase (proyecto zyxcummfswlnaupvaqor).
--
-- Geocerca por Evento Especial: hasta ahora, un evento especial (acto,
-- capacitación, etc.) no tenía forma de exigir que el docente fiche
-- parado en un lugar puntual - si el evento es FUERA del colegio, no
-- tenía sentido validarlo contra la geocerca del colegio (ver
-- verifyGeofence()/DEFAULT_GEOFENCE_CONFIG en script.js), así que
-- quedaba sin validar la ubicación en absoluto.
--
-- Estas columnas son todas opcionales (nullable / default false): un
-- evento existente sin geocerca sigue funcionando exactamente igual
-- que antes (fichaje con reconocimiento facial, sin control de
-- ubicación). Solo se activa la validación de ubicación cuando el
-- admin tilda "¿Este evento requiere geocerca?" al crear/editar el
-- evento (ver toggleEventoGeocerca() en script.js) y carga un punto +
-- radio.

alter table evento_especial
    add column if not exists tiene_geocerca boolean not null default false,
    add column if not exists geocerca_lat double precision,
    add column if not exists geocerca_lng double precision,
    add column if not exists geocerca_radio integer,
    add column if not exists direccion_evento text;

-- No hace falta tocar RLS: las policies de evento_especial (ver
-- fix_rls_eventos.sql) ya cubren insert/update/select sobre la fila
-- completa, columnas nuevas incluidas.

notify pgrst, 'reload schema';
