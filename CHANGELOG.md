# Changelog

## 1.0.0-docentes (2026-10-22) — fork para docentes

- Fork de [pengusto/google-classroom-mcp](https://github.com/pengusto/google-classroom-mcp) con documentación de instalación en español.
- **Arreglo de autenticación:** `@google-cloud/local-auth` trae otra versión de `google-auth-library` y su cliente no enviaba credenciales (401 `CREDENTIALS_MISSING`) al verificar el acceso; ahora se guarda el token y se verifica con el cliente propio.
- **Fechas de entrega en hora local:** `dueDate`/`dueTime` se interpretan en la zona horaria del ordenador y se convierten a UTC (antes «23:59» aparecía como 01:59 del día siguiente en España).
- **Modo de los adjuntos de Drive:** nuevo campo `shareMode` (`VIEW`, `EDIT`, `STUDENT_COPY` en tareas; `VIEW`, `EDIT` en materiales).
- Scripts con `npm` en lugar de `bun`; dependencias actualizadas (`npm audit`: 0 vulnerabilidades).

## 3.1.0 (2026-11-13)

Pensada para docentes sin experiencia técnica.

### Instalación más fácil
- **Extensión de un clic para Claude Desktop** (`google-classroom-docentes.mcpb`): se instala con doble clic, sin Node.js ni Terminal. Se genera y adjunta en cada *release* de GitHub.
- **Conexión desde el chat**: `classroom_connect` recoge la llave descargada en Descargas, abre el inicio de sesión de Google y espera a que termines. `classroom_status` explica qué falta y cómo arreglarlo. Cuando la sesión caduca, basta con decir «reconecta Classroom».
- **Asistente para la terminal** (`npx -y google-classroom-mcp-docentes setup`): abre cada pantalla de Google Cloud, detecta la llave descargada, conecta la cuenta y lo añade a Claude Desktop y Claude Code (con copia de seguridad de la configuración).
- Inicio de sesión propio (PKCE, selector de cuenta siempre visible, una sola ventana a la vez) en lugar de `@google-cloud/local-auth`.
- Mensajes de error en español, con el paso concreto a seguir.
- Dependencias de Google reducidas a Classroom, Drive y Slides: de 275 MB a 68 MB instalados.

### Funciones nuevas
- `classroom_get_overview`: borradores, publicaciones programadas y entregas próximas de todos tus cursos en una sola petición.
- `classroom_copy_post`: copia una tarea o material a otros grupos, en borrador, con sus adjuntos y en el tema del mismo nombre (lo crea si falta).
- Preguntas tipo test (`MULTIPLE_CHOICE_QUESTION` con `choices`).
- `drive_search_files`: busca en tu Drive y en las unidades compartidas por nombre, tipo o carpeta.
- `drive_upload_file` sube archivos de tu ordenador de hasta 100 MB (solo desde Descargas, Documentos, Escritorio o carpetas de nube), con conversión opcional a Documentos, Hojas o Presentaciones de Google.

### Documentación
- README y guía de instalación reescritos para docentes: tres pasos, enlaces directos a cada pantalla de Google Cloud y solución de problemas en lenguaje claro.

## 3.0.1 (2026-11-12)

- `npx -y google-classroom-mcp-docentes` arranca el servidor: el paquete expone un comando con su propio nombre (en 3.0.0 npx no sabía cuál de los dos comandos ejecutar).
- El servidor informa de la versión real del paquete (antes decía siempre `3.0.0-beta.1`).

## 3.0.0 (2026-11-12)

### Packaging

- Publicable en npm como `google-classroom-mcp-docentes` (`npx -y google-classroom-mcp-docentes`), con el comando `google-classroom-mcp-auth` para autorizar.
- Sin `credentials.json` en la raíz del proyecto, los archivos OAuth se guardan en `~/.config/google-classroom-mcp-docentes/` (`GOOGLE_CLASSROOM_MCP_HOME` para cambiarlo); las instalaciones clonadas siguen igual.

### Breaking changes

- Return bounded `{items, nextPageToken}` pages from list and course-search tools instead of arrays. Clients must follow continuation tokens.
- Default newly created posts to drafts; require explicit `PUBLISHED` for immediate publication.
- Require an explicit update mask for announcement patches.
- Reject unknown arguments and invalid dates, masks, attachment links and uploads before Google API calls.
- Support Node 22 and 24 and Desktop OAuth credentials.
- Remove unavailable administrative/combined-upload tool implementations and live tests with a hard-coded course. Multiple-choice creation is not offered.

### Improvements

- Restore current README badges, add a teaching workflow example and replace the distant scheduling example with an unpublished draft.

- Document the reported “Unknown User” display issue and its possible relation to Google Workspace administrator settings.

- Add read-only `npm run doctor` with redacted setup diagnostics.
- Allow cancelling a scheduled post with a null timestamp.
- Add bug/feature templates and document completed detachment and dependency assessment.

- Add a validated Drive upload tool with a 5 MiB decoded limit.
- Support scheduling changes for announcements as well as assignments and materials.
- Share OAuth scopes and paths; persist refreshed tokens atomically without dropping refresh tokens.
- Update Google API dependencies, use the existing SDK validator, and replace source-slicing tests with MCP transport tests.
- Add CI, security guidance, accurate setup documentation and release readiness checks.

No standalone release or npm publication has been performed. Live write validation remains open. The full MIT text and reconstructed upstream attribution are included in LICENSE and docs/PROVENANCE.md.
