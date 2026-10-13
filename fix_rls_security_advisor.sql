-- Ejecutar UNA VEZ en el SQL Editor de Supabase (proyecto kclnaabvcxdovvgblyoc).
--
-- Arregla las alertas "RLS Disabled in Public" / "Policy Exists RLS Disabled"
-- del Security Advisor. app_data y usuarios ya tienen políticas para "anon"
-- (ver supabase_schema.sql y usuarios_schema.sql) pero el RLS estaba apagado
-- en la base real: al activarlo la app sigue funcionando igual.
--
-- app_config y alerta no las usa ningún archivo de la app: sin políticas
-- quedan cerradas para "anon" (comportamiento deseado).
--
-- NO resuelve "Sensitive Columns Exposed" en usuarios: la app valida el
-- login en el navegador leyendo usuarios.password con la clave pública, así
-- que "anon" sigue necesitando leer esa columna. Eso requiere migrar el
-- login a Supabase Auth o a una Edge Function.

alter table public.app_data   enable row level security;
alter table public.usuarios   enable row level security;
alter table public.app_config enable row level security;
alter table public.alerta     enable row level security;

notify pgrst, 'reload schema';
