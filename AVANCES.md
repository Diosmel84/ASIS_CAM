# AVANCES - ASISCAM PRO

Contexto real del proyecto antes de arrancar (importante para lo que sigue):
no existe una carpeta `asiscampro` separada ni `asiscam-uno`. Todo vive en
esta única carpeta (`ASIS_CAM_PRO_LIMPIA`), que es **un sitio estático sin
build** (HTML + CSS + JS plano, sin React/Vite, ver `package.json`). Por eso
varias rutas pedidas (`public/`, `src/...`, `.env.local`) no aplican tal
cual - se adaptaron a la estructura real donde tenía sentido.

## 1. Logo nuevo - HECHO

- La imagen la subiste vos como `WhatsApp Image 2026-09-14 at 14.15.18.jpg`.
  Se convirtió a:
  - `logo.png` (imagen completa: ojo + texto "ASISCAM PRO")
  - `favicon.png` (recorte cuadrado del ojo, 256x256)
- `index.html`: el `<img>` viejo del escudo (base64 del "Instituto Superior
  de Formación Docente de Ituzaingó") se reemplazó por
  `<img src="/logo.png" alt="ASISCAM PRO" class="institution-logo">`.
- Se agregó `<link rel="icon" href="/favicon.png">` y el `<title>` pasó a
  "ASISCAM PRO".
- Nota: no hay carpeta `public/` (no hace falta, el sitio se publica desde
  la raíz - ver `netlify.toml`/`firebase.json`, `publish = "."`), así que
  `logo.png`/`favicon.png` quedaron en la raíz del proyecto en vez de
  `public/`. Con eso `/logo.png` resuelve bien igual.

## 2. Diseño estilo Apple - PARCIAL, con una limitación real que te aviso

Hecho:
- Paleta reemplazada a petróleo `#204E4A` + blanco + gris `#F5F5F7` en
  `style.css` (`:root`), reutilizando las mismas variables que ya usaba
  toda la app (`--olive-*`) para no tener que tocar cientos de reglas.
- Tipografía: Inter (Google Fonts) con fallback a San Francisco
  (`-apple-system, BlinkMacSystemFont`).
- Bordes redondeados subidos a 12-16px (`--radius-sm/md/lg`) en
  contenedores, tarjetas, botones y modales.
- Sombras más suaves (`--shadow-soft`/`--shadow-softer`) y transiciones a
  0.3s.
- **Celular**: listado de docentes ahora se ve como lista iOS (tarjetas
  apiladas con etiquetas, no tabla) en pantallas <768px -
  `.ios-table` en `style.css` + `data-label` en `loadTeachersTable()`
  (`script.js`). Botones y campos con alto mínimo de 44px. La barra de
  botones del admin (Calendario/Grilla/Estadísticas/Cambiar Contraseña) se
  reemplaza por un botón hamburguesa con menú desplegable en celular.

**Actualización**: ya se hizo el rediseño en pestañas del panel de admin
(pedido en un mensaje posterior). El panel de admin (`#adminDashboard`) se
partió en 7 pestañas Bootstrap (`Inicio`, `Alertas`, `Docentes`, `Licencias`,
`Eventos`, `Configuración`, `Reportes`) en vez de las 8 secciones apiladas
en una sola pantalla larga:

- **Inicio**: las 4 tarjetas de estadísticas.
- **Alertas**: el buzón de alertas (con scroll interno propio, `max-height`,
  para no alargar la página si hay muchas).
- **Docentes**: el formulario de alta/edición se agrupó en un acordeón
  interno de 3 grupos - **Datos Personales / Contacto / Laboral** (tal
  cual lo pediste) - y debajo el listado de docentes (accordion que ya
  existía).
- **Licencias**, **Eventos**, **Reportes**: cada uno en su propia pestaña.
- **Configuración**: Criterios de Asistencia + Geocerca + Dispositivos
  juntos (las 3 son ajustes, tenía sentido agruparlas).
- En celular, la fila de pestañas hace scroll horizontal en vez de romper
  el layout.

Los IDs de todos los campos/botones no cambiaron (verificado que cada uno
sigue apareciendo una sola vez en el HTML), así que `saveTeacher()`,
`loadTeachersTable()`, `addLicencia()`, etc. siguen funcionando igual -
solo cambió el contenedor visual alrededor.

**Honestidad sobre el "sin scroll" real**: esto reduce muchísimo el scroll
(cada pestaña es una fracción de lo que era la página completa), pero no
puedo garantizarte cero scroll en absolutamente todas las pestañas en
cualquier resolución - por ejemplo la pestaña "Docentes" con muchos
docentes cargados en el listado, o "Configuración" con el mapa de geocerca,
pueden seguir necesitando scroll en pantallas chicas o con zoom alto. Es
sustancialmente mejor, no un "cero scroll" matemático.

## 3. Conexión "virgen" - HECHO Y VERIFICADO

- Se encontraron `ASISCAMPRO_CREDENCIALES_VIRGEN.txt` y
  `ASISCAMPRO_VIRGEN_URL.txt` en esta misma carpeta.
- Misma URL de Supabase de siempre (`zyxcummfswlnaupvaqor`), key nueva en
  formato "publishable" (`sb_publishable_...`, reemplaza el JWT viejo).
- Se probó en vivo contra la API real (`HTTP 200`, trajo datos de
  `app_data`) antes de aplicarla.
- Actualizada en `script.js` (`SUPABASE_ANON_KEY`) y en `.env`
  (`VITE_SUPABASE_ANON_KEY`).

## 4. SQL base - HECHO

- `supabase-schema.sql` (nuevo, separado del `supabase_schema.sql` que ya
  existía para `app_data`): tablas vacías `escuelas`, `docentes`,
  `asistencias`, `suscripciones` (con `fecha_vencimiento`), con RLS +
  políticas de lectura para `anon`, mismo modelo de seguridad que el resto
  del proyecto.
- **Importante**: la app hoy sigue leyendo/escribiendo docentes y
  asistencias como JSON dentro de `app_data` (no de estas tablas nuevas).
  Esta tabla es la base para una futura migración a modelo relacional, no
  un reemplazo automático. `suscripciones` sí está conectada (ver punto 5).
- Correla en el SQL Editor de Supabase para que exista antes de usar el
  bloqueo por pago.

## 5. Bloqueo por pago - HECHO

- `src/utils/checkSuscripcion.js` (script clásico, no ES module - este
  proyecto no tiene build para procesar imports; se carga con
  `<script src="src/utils/checkSuscripcion.js">` después de `script.js` en
  `index.html`, y reutiliza el cliente `sb` ya creado).
- Como la app es de una sola escuela (sin multi-tenant), chequea una única
  fila global de `suscripciones` (la primera que exista).
- Si `fecha_vencimiento` < hoy: pantalla completa "Suscripción vencida"
  estilo Apple con botón "Contactar" (abre un mail a
  maximilianoempleo@gmail.com).
- Si la tabla `suscripciones` está vacía (todavía no corriste el SQL o no
  cargaste ninguna fila): **no bloquea nada**, a propósito - para no dejar
  a todo el mundo afuera por defecto apenas crees la tabla vacía. Cuando
  quieras activar el bloqueo, insertá una fila con su
  `fecha_vencimiento`.

## Pendiente / a confirmar

- ~~Correr `supabase-schema.sql`~~ - hecho por vos en el dashboard:
  `escuelas` id=2 y `suscripciones` id=3 (escuela_id=2, plan='pro',
  estado='activa', fecha_vencimiento='2026-12-31') creadas y verificadas
  en vivo desde acá con la key publishable (`GET /rest/v1/suscripciones` y
  `/escuelas` devuelven los datos). El bloqueo por pago ya está activo con
  vencimiento real (no va a bloquear hasta el 31/12/2026).
- No se tocó ningún proyecto llamado `asiscam-uno` porque no existe en esta
  máquina - si es una carpeta en otro lado, decime la ruta.
- Probar en el navegador que las 7 pestañas del admin abren bien y que
  `saveTeacher()` / `addLicencia()` / etc. siguen guardando correctamente -
  no tengo navegador conectado en esta sesión para probarlo yo mismo.
