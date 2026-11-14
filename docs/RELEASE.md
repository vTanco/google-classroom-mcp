# Publicar una versión

1. Actualiza `version` en `package.json` y `package-lock.json` y añade la entrada en `CHANGELOG.md`.
2. `npm test` y `npm run build:mcpb`. Prueba la extensión en Claude Desktop: instalar, «conecta Classroom», «lista mis cursos».
3. Fusiona en `main` con el CI en verde.
4. Crea y sube la etiqueta: `git tag vX.Y.Z && git push origin vX.Y.Z`. El flujo **Release** comprueba que la etiqueta coincide con `package.json`, genera `google-classroom-docentes.mcpb` y lo adjunta a la *release* de GitHub. El enlace del README (`releases/latest/download/…`) apunta siempre a la última.
5. Publica en npm desde `main`: `npm publish` (requiere la cuenta del mantenedor con 2FA).

## Comprobaciones con Google

Los tests no se conectan a Google. Antes de una versión con cambios en la conexión o en las herramientas, comprueba en un **curso de prueba dedicado**: inicio de sesión desde cero, una lectura y la creación de un borrador. No modifiques cursos reales ni guardes en el repositorio identificadores de cursos, credenciales o datos de alumnos.

## Dependencias

`npm audit --audit-level=high` debe pasar (lo comprueba el CI). Revisa los avisos moderados en cada versión.
