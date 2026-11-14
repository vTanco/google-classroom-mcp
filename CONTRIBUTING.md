# Contributing

Use Node 24 LTS (see `.nvmrc`); CI also checks Node 22.

```sh
npm ci --ignore-scripts
npm test
git diff --check
npm run build:mcpb   # optional: builds the Claude Desktop extension into build/
```

Code map: `src/index.ts` (MCP tools), `src/auth.ts` (credentials, browser sign-in, diagnosis), `src/cli.ts` (`setup` / `auth` / `doctor`), `src/upload.ts` (local file uploads), `scripts/build-mcpb.mjs` (extension bundle; its `TOOLS` list must name every tool).

Keep changes small. Tests in `tests/*.test.js` use the MCP in-memory transport and fake Google API responses; they must never need credentials or access real courses. Build output in `dist/` is tracked and must match `src/`.

When changing a tool, update its input schema, behavior tests, README and the `TOOLS` descriptions in `scripts/build-mcpb.mjs` together. Teacher-facing text is Spanish; tool descriptions for the model are English. Do not retain hidden administrative tools or add generic wrappers for hypothetical features. Keep authentication, input validation and safe failure behavior intact.

A live check needs a dedicated test course and explicit authorization. Record created object IDs locally, verify results by reading them back and never bulk-delete or modify existing course content. Do not put credentials, course identifiers, student details or local evidence into commits.

Dependency changes must include the lockfile, a fresh install and the relevant tests. Run `npm audit --audit-level=high`; do not auto-fix dependency ranges as part of unrelated changes. A release checklist lives in `docs/RELEASE.md`.
