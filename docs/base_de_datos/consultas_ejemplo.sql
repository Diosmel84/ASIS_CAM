-- ============================================================
-- ASISCAM PRO — 5 consultas clave del sistema
-- ============================================================
--
-- Aclaración importante para quien lea esto sabiendo cómo funciona la
-- app: 3 de estas 5 lógicas (semáforo mensual, cálculo de tardanza y
-- RBAC) hoy se resuelven en JavaScript (script.js/roles.js), NO con
-- una consulta SQL que corra periódicamente — porque el dato base
-- (app_data.attendance, app_data.criteria) es jsonb, no filas
-- normalizadas. Estas consultas muestran cómo se verían contra el
-- modelo real de la base, y son la referencia directa de cómo se
-- haría este mismo cálculo si algún día attendance/criteria pasan a
-- ser tablas propias (ver decisiones_de_diseño.md).
-- ============================================================


-- ============================================================
-- 1) Semáforo de desempeño mensual por docente (verde/amarillo/rojo)
--    usando minAttendance y minHours de app_data (key='criteria')
-- ============================================================
-- Regla: VERDE si cumple el % de asistencia Y las horas mínimas
-- diarias promedio; AMARILLO si le falta solo uno de los dos; ROJO si
-- no cumple ninguno. Mes a evaluar: el actual (ajustar date_trunc si
-- se quiere otro).

with criterios as (
    select
        (value ->> 'minAttendance')::numeric as min_attendance,  -- % mínimo exigido
        (value ->> 'minHours')::numeric       as min_hours        -- horas mínimas diarias
    from app_data
    where key = 'criteria'
),
fichajes_mes as (
    -- Explota el array de attendance en filas; se descartan los
    -- fichajes anulados por el propio docente (ver diccionario_de_datos.md).
    select
        elem ->> 'teacherId'                as teacher_id,
        (elem ->> 'date')::date             as fecha,
        elem ->> 'type'                     as tipo,
        (elem ->> 'timestamp')::timestamptz as momento
    from app_data, jsonb_array_elements(value) as elem
    where key = 'attendance'
      and (elem ->> 'anulado') is distinct from 'true'
      and (elem ->> 'categoria') = 'regular'
      and date_trunc('month', (elem ->> 'date')::date) = date_trunc('month', current_date)
),
horas_por_dia as (
    -- Empareja cada 'entry' con el 'exit'/'early_exit' más próximo en
    -- el tiempo, del mismo docente y mismo día, para estimar horas
    -- trabajadas ese día.
    select
        teacher_id, fecha,
        extract(epoch from (
            min(momento) filter (where tipo in ('exit', 'early_exit'))
            - min(momento) filter (where tipo = 'entry')
        )) / 3600.0 as horas_trabajadas
    from fichajes_mes
    group by teacher_id, fecha
),
resumen_docente as (
    select
        teacher_id,
        count(*)                                             as dias_presentes,
        avg(horas_trabajadas) filter (where horas_trabajadas > 0) as promedio_horas
    from horas_por_dia
    group by teacher_id
),
dias_habiles_mes as (
    -- Aproximación: días de lunes a viernes transcurridos en el mes
    -- actual (la app real cruza contra el horario asignado de cada
    -- docente vía getScheduleEntriesForDate(), más preciso pero no
    -- expresable en una sola consulta sin una tabla de horarios por
    -- docente).
    select count(*) as total
    from generate_series(date_trunc('month', current_date), current_date, interval '1 day') d
    where extract(isodow from d) < 6
)
select
    r.teacher_id,
    r.dias_presentes,
    round(r.promedio_horas, 1)                                    as promedio_horas_diarias,
    round(100.0 * r.dias_presentes / nullif(h.total, 0), 1)       as pct_asistencia,
    case
        when 100.0 * r.dias_presentes / nullif(h.total, 0) >= c.min_attendance
             and r.promedio_horas >= c.min_hours then 'VERDE'
        when 100.0 * r.dias_presentes / nullif(h.total, 0) >= c.min_attendance
             or  r.promedio_horas >= c.min_hours then 'AMARILLO'
        else 'ROJO'
    end as semaforo
from resumen_docente r
cross join dias_habiles_mes h
cross join criterios c
order by pct_asistencia asc;


-- ============================================================
-- 2) Cálculo de tardanza usando lateLimit de app_data (key='criteria')
-- ============================================================
-- Cruza cada fichaje de entrada de cátedra regular contra el horario
-- de la materia correspondiente (tabla `materias`) y calcula los
-- minutos de diferencia contra el margen configurado.

with criterios as (
    select (value ->> 'lateLimit')::int as late_limit_min
    from app_data
    where key = 'criteria'
),
entradas as (
    select
        elem ->> 'teacherId'      as teacher_id,
        (elem ->> 'date')::date   as fecha,
        (elem ->> 'time')::time   as hora_fichada,
        (elem ->> 'materiaId')::bigint as materia_id
    from app_data, jsonb_array_elements(value) as elem
    where key = 'attendance'
      and elem ->> 'type' = 'entry'
      and (elem ->> 'categoria') = 'regular'
      and (elem ->> 'anulado') is distinct from 'true'
),
horario_del_dia as (
    -- Un horario por materia y día de la semana en español, tomado
    -- del jsonb `materias.horarios`.
    select
        m.id as materia_id,
        h ->> 'dia'                as dia,
        (h ->> 'inicio')::time     as hora_inicio
    from materias m, jsonb_array_elements(m.horarios) as h
)
select
    e.teacher_id,
    e.fecha,
    e.hora_fichada,
    hd.hora_inicio                                         as hora_asignada,
    extract(epoch from (e.hora_fichada - hd.hora_inicio)) / 60 as minutos_diferencia,
    case
        when extract(epoch from (e.hora_fichada - hd.hora_inicio)) / 60 <= c.late_limit_min
            then 'A HORARIO'
        else 'TARDANZA'
    end as resultado
from entradas e
join horario_del_dia hd
    on hd.materia_id = e.materia_id
    and hd.dia = trim(to_char(e.fecha, 'TMDay'))  -- nombre del día en español (requiere lc_time es_AR, ver nota)
cross join criterios c
order by e.fecha desc, minutos_diferencia desc;

-- Nota: to_char(..., 'TMDay') devuelve el nombre del día en el idioma
-- del `lc_time` de la sesión; si la base no tiene el locale es_AR
-- configurado, conviene resolver el nombre del día en la aplicación
-- (como hace hoy FULL_DAYS en script.js) en vez de en SQL.


-- ============================================================
-- 3) Asistencia por docente por mes
-- ============================================================
-- Cantidad de entradas registradas por docente en cada mes, con el
-- desglose de a horario / tardanza (campo `status`, ya calculado por
-- la app al fichar).

select
    elem ->> 'teacherId'                                as teacher_id,
    elem ->> 'teacherName'                              as docente,
    to_char((elem ->> 'date')::date, 'YYYY-MM')         as mes,
    count(*)                                            as entradas_totales,
    count(*) filter (where elem ->> 'status' = 'present') as a_horario,
    count(*) filter (where elem ->> 'status' = 'late')    as tardanzas
from app_data, jsonb_array_elements(value) as elem
where key = 'attendance'
  and elem ->> 'type' = 'entry'
  and (elem ->> 'categoria') = 'regular'
  and (elem ->> 'anulado') is distinct from 'true'
group by teacher_id, docente, mes
order by mes desc, docente;


-- ============================================================
-- 4) Auditoría de cambios: quién modificó qué
-- ============================================================
-- auditoria_logs SÍ es una tabla relacional real (no jsonb) — esta es
-- la única de las 5 consultas que corre en producción tal cual, desde
-- el panel de Auditoría (ver renderAuditoriaPanel() en auditoria.js).

select
    fecha,
    usuario,
    rol,
    accion,
    detalle
from auditoria_logs
where accion in (
    'ALTA_DOCENTE', 'EDITAR_DOCENTE', 'BORRAR_DOCENTE',
    'ALTA_CARRERA', 'EDITAR_GEOCERCA',
    'EDITAR_CRITERIOS_PUNTUALIDAD', 'BORRAR_LOG',
    'PERMISO_DENEGADO'
)
order by timestamp desc
limit 200;


-- ============================================================
-- 5) Vista para RBAC: qué puede ver/hacer cada rol
-- ============================================================
-- Hoy la matriz de permisos (MATRIZ_PERMISOS) vive 100% en el cliente
-- (roles.js: tienePermiso()), no en la base — no hay tablas roles/
-- permisos porque el sistema no usa Supabase Auth (ver
-- decisiones_de_diseño.md, Etapa 2 pendiente). Esta vista materializa
-- esa misma matriz como datos, útil para auditar el diseño de
-- permisos o como punto de partida si se migra a políticas RLS reales
-- por rol.

create or replace view v_rbac_matriz as
select * from (values
    ('ver_docentes',                 array['secretaria','rector','programador']),
    ('agregar_docente',              array['secretaria','rector','programador']),
    ('editar_docente',               array['secretaria','rector','programador']),
    ('blanquear_password',           array['secretaria','rector','programador']),
    ('fichaje_manual',               array['secretaria','rector','programador']),
    ('justificar_alerta',            array['rector']),
    ('ver_reportes',                 array['rector']),
    ('exportar_reportes',            array['rector']),
    ('borrar',                       array['rector','programador']),
    ('editar_geo',                   array['rector','programador']),
    ('editar_criterios_puntualidad', array['rector']),
    ('ver_claves',                   array['programador']),
    ('ver_auditoria',                array['rector','programador']),
    ('gestionar_auditoria',          array['programador']),
    ('backup_restore',               array['programador'])
) as t(accion, roles_permitidos);

-- Ejemplo de uso: qué puede hacer Secretaría.
select accion
from v_rbac_matriz
where 'secretaria' = any(roles_permitidos)
order by accion;
