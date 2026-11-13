#!/usr/bin/env node
// Builds build/google-classroom-docentes.mcpb: a one-click Claude Desktop extension
// that bundles the compiled server and its production dependencies. Claude Desktop
// runs it with its own Node.js, so teachers install nothing else.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = path.join(root, 'build');
const stage = path.join(out, 'mcpb');
const bundle = path.join(out, 'google-classroom-docentes.mcpb');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const MCPB = '@anthropic-ai/mcpb@2.1.2';
const REPO = 'https://github.com/vTanco/google-classroom-mcp';

// Short Spanish descriptions shown in Claude Desktop's extension page.
const TOOLS = {
  classroom_status: 'Comprueba si Classroom está conectado y qué falta',
  classroom_connect: 'Conecta o reconecta tu cuenta de Google desde el chat',
  classroom_get_overview: 'Resumen de borradores, programados y entregas próximas',
  classroom_list_courses: 'Lista tus cursos',
  classroom_search_courses: 'Busca cursos por nombre o grupo',
  classroom_get_course: 'Detalles de un curso',
  classroom_update_course: 'Cambia nombre, sección o aula de un curso, o lo archiva',
  classroom_list_topics: 'Lista los temas de un curso',
  classroom_get_topic: 'Detalles de un tema',
  classroom_create_topic: 'Crea un tema',
  classroom_patch_topic: 'Renombra un tema',
  classroom_list_assignments: 'Lista las tareas y preguntas de un curso',
  classroom_get_assignment: 'Detalles de una tarea',
  classroom_create_assignment: 'Crea una tarea, pregunta corta o pregunta tipo test',
  classroom_patch_assignment: 'Cambia una tarea: fechas, puntos, tema, publicación',
  classroom_copy_post: 'Copia una tarea o material a otros grupos',
  classroom_list_materials: 'Lista los materiales de un curso',
  classroom_get_material: 'Detalles de un material',
  classroom_create_material: 'Crea un material con adjuntos',
  classroom_patch_material: 'Cambia un material',
  classroom_list_announcements: 'Lista los anuncios de un curso',
  classroom_post_announcement: 'Publica o programa un anuncio',
  classroom_patch_announcement: 'Cambia o programa un anuncio',
  drive_search_files: 'Busca archivos en tu Drive para adjuntarlos',
  drive_upload_file: 'Sube un archivo de tu ordenador a Drive',
  slides_get_presentation: 'Lee el texto de una presentación de Google Slides',
};

const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

// Every tool the server exposes must be described, and nothing else.
const { GoogleClassroomServer } = await import(path.join(root, 'dist', 'index.js'));
const names = new GoogleClassroomServer().getTools().map(tool => tool.name);
const missing = names.filter(name => !TOOLS[name]);
const stale = Object.keys(TOOLS).filter(name => !names.includes(name));
if (missing.length || stale.length) throw new Error(`Update TOOLS in build-mcpb.mjs. Missing: ${missing.join(', ') || '-'}; stale: ${stale.join(', ') || '-'}`);

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'dist'), { recursive: true });
for (const file of fs.readdirSync(path.join(root, 'dist')).filter(name => name.endsWith('.js'))) {
  fs.copyFileSync(path.join(root, 'dist', file), path.join(stage, 'dist', file));
}
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.copyFileSync(path.join(root, 'mcpb', 'icon.png'), path.join(stage, 'icon.png'));
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, type: pkg.type, license: pkg.license, dependencies: pkg.dependencies,
}, null, 2));

const manifest = {
  manifest_version: '0.3',
  name: 'google-classroom-docentes',
  display_name: 'Google Classroom para docentes',
  version: pkg.version,
  description: 'Prepara tareas, materiales, temas y anuncios de Google Classroom hablando con Claude.',
  long_description: [
    'Crea tareas, preguntas, materiales, temas y anuncios en tu Google Classroom escribiendo en lenguaje normal.',
    'Todo se crea en borrador para que lo revises antes de publicarlo. Adjunta archivos de Drive o de tu ordenador,',
    'copia una unidad a varios grupos y pregunta qué tienes pendiente esta semana.',
    '',
    'Funciona en tu ordenador con tu propia cuenta: no hay servidores intermedios. La primera vez necesitas crear',
    `una llave gratuita en Google Cloud (unos 10 minutos); la guía lo explica paso a paso: ${REPO}#readme`,
  ].join('\n'),
  author: { name: pkg.author, url: 'https://github.com/vTanco' },
  repository: { type: 'git', url: `${REPO}.git` },
  homepage: `${REPO}#readme`,
  documentation: `${REPO}/blob/main/INSTALACION.md`,
  support: `${REPO}/issues`,
  icon: 'icon.png',
  license: pkg.license,
  keywords: ['classroom', 'google', 'education', 'educación', 'docentes', 'drive'],
  server: {
    type: 'node',
    entry_point: 'dist/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/dist/index.js'],
      env: { GOOGLE_CLASSROOM_CREDENTIALS_FILE: '${user_config.credentials_file}' },
    },
  },
  user_config: {
    credentials_file: {
      type: 'file',
      title: 'Llave de Google (client_secret….json)',
      description: 'Opcional. El archivo que descargaste de Google Cloud. Si lo dejas en tu carpeta Descargas, no hace falta elegirlo: pídele a Claude «conecta Classroom».',
      required: false,
    },
  },
  tools: names.map(name => ({ name, description: TOOLS[name] })),
  compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=20.0.0' } },
  privacy_policies: [`${REPO}#privacidad`],
};
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
fs.rmSync(path.join(stage, 'package-lock.json'));
run('npx', ['-y', MCPB, 'validate', path.join(stage, 'manifest.json')]);
fs.rmSync(bundle, { force: true });
run('npx', ['-y', MCPB, 'pack', stage, bundle]);
console.log(`\nBuilt ${path.relative(root, bundle)}`);
