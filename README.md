# Google Classroom MCP para docentes

Conecta **Claude** (Claude Desktop o Claude Code) con **tu Google Classroom** para preparar y publicar tareas, materiales, temas y anuncios escribiendo en lenguaje normal:

> «Crea en ESO 2º Tecnología una tarea "Práctica 05", 10 puntos, entrega el viernes a las 23:59, con la ficha de mi Drive como copia para cada alumno, en borrador.»

Funciona **en tu ordenador**, con **tu propia cuenta de Google** y tu propio permiso. Nadie más ve tus datos.

**→ Guía de instalación paso a paso: [INSTALACION.md](INSTALACION.md)** (unos 20-30 minutos la primera vez).

---

## Qué puede hacer

| Área | Herramientas |
|---|---|
| **Cursos** | Listar y buscar cursos, ver detalles, cambiar nombre/sección/aula o archivar |
| **Temas** | Listar, crear y renombrar temas |
| **Tareas** | Crear (tarea o pregunta de respuesta corta), consultar y editar: título, instrucciones, puntos, fecha y hora de entrega, tema |
| **Materiales** | Crear, consultar y editar materiales sin entrega |
| **Anuncios** | Publicar, programar y editar anuncios del tablón |
| **Adjuntos** | Archivos de Drive, enlaces, vídeos de YouTube y Google Forms |
| **Modo de los archivos de Drive** | `VIEW` (solo lectura), `EDIT` (un archivo compartido que edita toda la clase) o `STUDENT_COPY` (copia para cada alumno, solo en tareas) |
| **Programar** | Dejar publicaciones programadas para una fecha y hora |
| **Drive** | Subir archivos de hasta 5 MB |

- Todo se crea **en borrador** salvo que pidas publicarlo.
- Las **fechas y horas** se escriben en tu hora local (p. ej. 23:59 en España) y se guardan bien en Classroom.

## Qué NO puede hacer (a propósito o por límites de Google)

- **No borra nada** (ni cursos, ni tareas, ni materiales): eso lo haces tú en Classroom.
- **No pone notas** ni ve las entregas del alumnado; no gestiona alumnos ni tutores.
- **No crea preguntas tipo test** (usa un Google Form adjunto).
- **No puede cambiar los adjuntos de algo ya publicado** (límite de la API de Classroom): hay que crear la publicación de nuevo.
- **Solo puede editar lo que él mismo ha creado** (límite de Google: una tarea creada a mano en Classroom no se puede modificar desde aquí).

## Requisitos

- Una cuenta de Google con **acceso de profesor** en Classroom (cuentas educativas incluidas).
- **Node.js 22 o 24**.
- **Claude Desktop** o **Claude Code**.
- Crear **tu propio proyecto en Google Cloud** (gratuito) para obtener tu `credentials.json`. La guía lo explica paso a paso.

> Si tu cuenta es de un centro educativo, el administrador de Google Workspace puede tener bloqueadas las aplicaciones externas. Ver «Solución de problemas» en la guía.

## Privacidad y seguridad

- El servidor se ejecuta **en local** (stdio) y habla directamente con las APIs de Google; no hay servidores intermedios.
- `credentials.json` (tu aplicación de Google Cloud) y `token.json` (tu permiso) se quedan en tu ordenador y están en `.gitignore`. **No los compartas ni los subas a ningún sitio**: cada docente debe crear los suyos.
- Permisos que pide: cursos, tareas del alumnado, materiales, temas y anuncios de Classroom; `drive.file` (archivos que sube la app) y `drive.readonly` (leer tus archivos de Drive para adjuntarlos).
- Puedes retirar el acceso cuando quieras en <https://myaccount.google.com/permissions>.

## Desarrollo

```bash
npm ci --ignore-scripts
npm test            # compila y ejecuta los 18 tests (sin conexión a Google)
npm run doctor      # comprueba credenciales y permisos con lecturas inocuas
```

Tras cambiar el código: `npm run build` y reinicia Claude.

## Créditos y licencia

Fork de **[pengusto/google-classroom-mcp](https://github.com/pengusto/google-classroom-mcp)** (basado en el trabajo de Adrià Santacreu i Giménez), con licencia **MIT** ([LICENSE](LICENSE)). La documentación original en inglés está en [docs/README-original.md](docs/README-original.md).

Cambios de este fork (ver [CHANGELOG.md](CHANGELOG.md)):
- Arreglo de la autenticación (el permiso no se verificaba por un conflicto de versiones).
- Fechas de entrega en hora local, convertidas a UTC.
- Modo de los adjuntos de Drive (`shareMode`).
- Scripts con `npm`, dependencias actualizadas y guía en español.

Proyecto no oficial; no está afiliado a Google.
