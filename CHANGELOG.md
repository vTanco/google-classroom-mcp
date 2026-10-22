# Changelog

## 1.0.0-docentes (2026-10-22) — fork para docentes

- Fork de [pengusto/google-classroom-mcp](https://github.com/pengusto/google-classroom-mcp) con documentación de instalación en español.
- **Arreglo de autenticación:** `@google-cloud/local-auth` trae otra versión de `google-auth-library` y su cliente no enviaba credenciales (401 `CREDENTIALS_MISSING`) al verificar el acceso; ahora se guarda el token y se verifica con el cliente propio.
- **Fechas de entrega en hora local:** `dueDate`/`dueTime` se interpretan en la zona horaria del ordenador y se convierten a UTC (antes «23:59» aparecía como 01:59 del día siguiente en España).
- **Modo de los adjuntos de Drive:** nuevo campo `shareMode` (`VIEW`, `EDIT`, `STUDENT_COPY` en tareas; `VIEW`, `EDIT` en materiales).
- Scripts con `npm` en lugar de `bun`; dependencias actualizadas (`npm audit`: 0 vulnerabilidades).

## Unreleased

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
