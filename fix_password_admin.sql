-- Ejecutar UNA VEZ en el SQL Editor de Supabase.
--
-- La fila `usuarios` (id=1, usuario='ADMIN') que usa el login de
-- Programador (MEUDEUS) tenía guardada la contraseña "SanCarlos" en
-- vez de "SantaMarta" - por eso MEUDEUS tiraba "Usuario o contraseña
-- incorrectos". Esta fila se compara en texto plano (no hash), así
-- que se corrige así, directo:
update usuarios
set password = 'SantaMarta'
where usuario = 'ADMIN';

-- Verificación: debería devolver una fila con password = SantaMarta.
select id, usuario, rol, password from usuarios where usuario = 'ADMIN';
