-- Ejecutar UNA VEZ en el SQL Editor de Supabase (además de
-- usuarios_schema.sql, que ya creó la tabla `usuarios` y la fila de
-- Programador/ADMIN).
--
-- Agrega las filas de Secretaría (ADMIN1) y Rector (ADMIN2), con la
-- contraseña YA HASHEADA (SHA-256, nunca texto plano) para que
-- login() (script.js > loadCredencialesFijas/coincideHashCredencial)
-- las compare por hash. Guardarlas acá en vez de en un archivo aparte
-- (config.secrets.js) hace que sobrevivan a cualquier redeploy
-- automático desde GitHub sin que haya que resubir nada a mano.
--
-- Las políticas de RLS ya creadas en usuarios_schema.sql (select+update
-- para "anon") ya cubren estas filas nuevas, no hace falta tocarlas.
--
-- Hash de "San Carlos1" (Secretaría): 51009d2e29451931b2afb3f36a2c90886546b77f4fc7a7209b642a9d48cb637c
-- Hash de "SanCarlos2" (Rector):      17a44de5375832b7cce861f1c8f861dd645a757da2be0b728e94e3192bcfa0bb
--
-- Si en algún momento cambiás alguna de las 2 contraseñas, hay que
-- recalcular su hash (sha256 en UTF-8) y volver a correr este UPDATE.
insert into usuarios (usuario, password, rol)
values
    ('ADMIN1', '51009d2e29451931b2afb3f36a2c90886546b77f4fc7a7209b642a9d48cb637c', 'secretaria'),
    ('ADMIN2', '17a44de5375832b7cce861f1c8f861dd645a757da2be0b728e94e3192bcfa0bb', 'rector')
on conflict (usuario) do update set password = excluded.password, rol = excluded.rol;

notify pgrst, 'reload schema';
