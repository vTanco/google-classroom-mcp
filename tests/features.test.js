import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// A fake home: config folder, Downloads and an allowed upload folder, set before loading the modules.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-features-test-')));
const config = path.join(home, 'config');
const downloads = path.join(home, 'Downloads');
const teaching = path.join(home, 'Documents');
fs.mkdirSync(downloads); fs.mkdirSync(teaching);
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.GOOGLE_CLASSROOM_MCP_HOME = config;
process.env.GOOGLE_CLASSROOM_UPLOAD_DIRS = teaching;
delete process.env.GOOGLE_CREDENTIALS_PATH; delete process.env.GOOGLE_TOKEN_PATH; delete process.env.GOOGLE_CLASSROOM_CREDENTIALS_FILE;
const { GoogleClassroomServer } = await import('../dist/index.js');
const auth = await import('../dist/auth.js');
const cli = await import('../dist/cli.js');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const desktop = { installed: { client_id: 'test-client', client_secret: 'test-secret', redirect_uris: ['http://localhost'] } };
const web = { web: { client_id: 'test-client', client_secret: 'test-secret' } };

async function connected(t, apis, options) {
  const server = new GoogleClassroomServer(options);
  if (apis) server.initApis = async () => ({ classroom: {}, drive: {}, slides: {}, ...apis });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.run(a); await client.connect(b);
  t.after(() => client.close());
  return client;
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const data = result => { assert(!result.isError, result.content[0].text); return JSON.parse(result.content[0].text); };

// ─── Connecting from the chat ────────────────────────────────────────────────

test('status and connect explain each missing piece and pick up the downloaded key', async t => {
  const client = await connected(t, undefined, { signInWaitMs: 50, openBrowser: url => opened.push(url) });
  const opened = [];

  let status = data(await call(client, 'classroom_status'));
  assert.equal(status.connected, false);
  assert.equal(status.problem, 'credentials_missing');
  assert.match(status.nextStep, /client_secret/);
  assert(!JSON.stringify(status).includes(home), 'never reveals local paths');

  // A "Web application" client in Downloads is recognised as the wrong type.
  fs.writeFileSync(path.join(downloads, 'client_secret_web.json'), JSON.stringify(web));
  assert.equal(data(await call(client, 'classroom_connect')).problem, 'credentials_not_desktop');

  // The right file in Downloads is imported privately and sign-in starts in the browser.
  fs.writeFileSync(path.join(downloads, 'client_secret_desktop.json'), JSON.stringify(desktop));
  const waiting = data(await call(client, 'classroom_connect'));
  assert.equal(waiting.state, 'waiting_for_sign_in');
  assert.match(waiting.credentialsImported, /Downloads/);
  assert.equal(opened.length, 1);
  assert.equal(waiting.signInUrl, opened[0]);
  const stored = path.join(config, 'credentials.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(stored, 'utf8')), desktop);
  if (process.platform !== 'win32') assert.equal(fs.statSync(stored).mode & 0o777, 0o600);

  // While the teacher is in the browser, status reports the same pending sign-in.
  status = data(await call(client, 'classroom_status'));
  assert.equal(status.state, 'waiting_for_sign_in');
  assert.equal(status.signInUrl, opened[0]);

  // Tools that need Google say how to fix it instead of failing vaguely.
  const blocked = await call(client, 'classroom_list_courses');
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /not connected \(not_signed_in\).*classroom_connect/);

  const url = new URL(opened[0]);
  await fetch(`${url.searchParams.get('redirect_uri')}/?error=access_denied&state=${url.searchParams.get('state')}`);
  await assert.rejects(auth.loginInProgress()?.done ?? Promise.reject(new Error('already settled')));
  assert.equal(data(await call(client, 'classroom_status')).problem, 'not_signed_in');
});

// ─── New teaching tools ──────────────────────────────────────────────────────

test('multiple-choice questions carry their options', async t => {
  let body;
  const client = await connected(t, { classroom: { courses: { courseWork: { create: async ({ requestBody }) => { body = requestBody; return { data: requestBody }; } } } } });
  data(await call(client, 'classroom_create_assignment', { courseId: 'c', title: '¿Capital de Francia?', workType: 'MULTIPLE_CHOICE_QUESTION', choices: ['París', 'Roma'], maxPoints: 1 }));
  assert.deepEqual(body.multipleChoiceQuestion, { choices: ['París', 'Roma'] });
  assert.equal(body.state, 'DRAFT');
});

test('copying a post to other groups keeps content, matches topics and stays in draft', async t => {
  const created = [], topicsCreated = [];
  const future = new Date(Date.now() + 10 * 864e5);
  const source = {
    id: 's', title: 'Práctica 05', description: 'Instrucciones', workType: 'ASSIGNMENT', maxPoints: 10, topicId: 't1', state: 'PUBLISHED',
    alternateLink: 'https://classroom.google.com/x', creatorUserId: 'me',
    dueDate: { year: future.getUTCFullYear(), month: future.getUTCMonth() + 1, day: future.getUTCDate() }, dueTime: { hours: 22, minutes: 59 },
    materials: [
      { driveFile: { driveFile: { id: 'doc', title: 'Ficha', thumbnailUrl: 'x' }, shareMode: 'STUDENT_COPY' } },
      { link: { url: 'https://example.com', title: 'Web' } },
    ],
  };
  const classroom = { courses: {
    courseWork: {
      get: async () => ({ data: source }),
      create: async ({ courseId, requestBody }) => {
        if (courseId === 'broken') throw Object.assign(new Error('x'), { response: { status: 403 } });
        created.push({ courseId, requestBody });
        return { data: { id: `copy-${courseId}`, state: requestBody.state } };
      },
    },
    topics: {
      get: async () => ({ data: { topicId: 't1', name: 'Unidad 3' } }),
      list: async ({ courseId }) => ({ data: { topic: courseId === 'b' ? [{ topicId: 'tb', name: ' unidad 3 ' }] : [] } }),
      create: async ({ courseId, requestBody }) => { topicsCreated.push({ courseId, ...requestBody }); return { data: { topicId: `new-${courseId}` } }; },
    },
  } };
  const client = await connected(t, { classroom });
  const result = data(await call(client, 'classroom_copy_post', { sourceCourseId: 'a', id: 's', kind: 'assignment', targetCourseIds: ['b', 'c', 'broken'] }));
  assert.deepEqual(result.copies.map(c => c.id ?? 'error'), ['copy-b', 'copy-c', 'error']);
  assert.match(result.copies[2].error, /Access denied/);
  assert.deepEqual(created.map(c => c.requestBody.topicId), ['tb', 'new-c']);
  assert.deepEqual(topicsCreated.map(topic => topic.courseId), ['c', 'broken']);
  assert(topicsCreated.every(topic => topic.name === 'Unidad 3'));
  for (const { requestBody } of created) {
    assert.equal(requestBody.state, 'DRAFT');
    assert.equal(requestBody.maxPoints, 10);
    assert.deepEqual(requestBody.dueTime, { hours: 22, minutes: 59 });
    assert.deepEqual(requestBody.materials, [
      { driveFile: { driveFile: { id: 'doc' }, shareMode: 'STUDENT_COPY' } },
      { link: { url: 'https://example.com' } },
    ]);
    assert.equal(requestBody.alternateLink, undefined);
  }

  // A due date that has already passed is not copied.
  source.dueDate = { year: 2020, month: 1, day: 1 };
  created.length = 0;
  const past = data(await call(client, 'classroom_copy_post', { sourceCourseId: 'a', id: 's', kind: 'assignment', targetCourseIds: ['b'], keepTopic: false }));
  assert.equal(created[0].requestBody.dueDate, undefined);
  assert.equal(created[0].requestBody.topicId, undefined);
  assert.match(past.note, /due date has passed/);
});

test('overview lists drafts, scheduled posts and upcoming due dates per course', async t => {
  const soon = new Date(Date.now() + 2 * 864e5), later = new Date(Date.now() + 40 * 864e5);
  const date = d => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  let listed;
  const classroom = { courses: {
    list: async args => { listed = args; return { data: { courses: [{ id: 'c1', name: '1º ESO', section: 'A' }] } }; },
    courseWork: { list: async () => ({ data: { courseWork: [
      { id: 'w1', title: 'Borrador', state: 'DRAFT' },
      { id: 'w2', title: 'Programada', state: 'DRAFT', scheduledTime: soon.toISOString() },
      { id: 'w3', title: 'Entrega pronto', state: 'PUBLISHED', dueDate: date(soon), dueTime: { hours: 21 } },
      { id: 'w4', title: 'Entrega lejana', state: 'PUBLISHED', dueDate: date(later) },
    ] } }) },
    courseWorkMaterials: { list: async () => ({ data: { courseWorkMaterial: [{ id: 'm1', title: 'Apuntes' }] } }) },
    announcements: { list: async () => ({ data: { announcements: [{ id: 'a1', text: 'Recordad traer la calculadora', scheduledTime: soon.toISOString() }] } }) },
  } };
  const client = await connected(t, { classroom });
  const overview = data(await call(client, 'classroom_get_overview', { daysAhead: 7 }));
  assert.equal(listed.teacherId, 'me');
  const [course] = overview.courses;
  assert.deepEqual(course.drafts.map(d => d.id), ['w1', 'm1']);
  assert.equal(course.draftCount, 2);
  assert.deepEqual(course.scheduled.map(d => d.id), ['w2', 'a1']);
  assert.match(course.scheduled[0].publishesAt, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.deepEqual(course.dueSoon.map(d => d.id), ['w3']);
});

test('Drive search builds a safe query across shared drives', async t => {
  let request;
  const client = await connected(t, { drive: { files: { list: async args => { request = args; return { data: { files: [{ id: 'f' }] } }; } } } });
  assert.deepEqual(data(await call(client, 'drive_search_files', { query: "ficha  d'Anna", type: 'pdf', folderId: 'abc_1-2' })).items, [{ id: 'f' }]);
  assert.equal(request.q, "trashed = false and name contains 'ficha' and name contains 'd\\'Anna' and mimeType = 'application/pdf' and 'abc_1-2' in parents");
  assert.equal(request.includeItemsFromAllDrives, true);
  assert.equal(request.orderBy, 'modifiedTime desc');
});

test('uploads read local files from teaching folders only, with optional conversion', async t => {
  const uploads = [];
  const client = await connected(t, { drive: { files: { create: async args => {
    const chunks = []; for await (const chunk of args.media.body) chunks.push(chunk);
    uploads.push({ ...args, bytes: Buffer.concat(chunks).toString() });
    return { data: { id: 'uploaded', name: args.requestBody.name, mimeType: args.requestBody.mimeType } };
  } } } });
  const file = path.join(teaching, 'Ficha 05.docx');
  fs.writeFileSync(file, 'contenido');

  const plain = data(await call(client, 'drive_upload_file', { localPath: file }));
  assert.equal(plain.name, 'Ficha 05.docx');
  assert.equal(uploads[0].bytes, 'contenido');
  assert.equal(uploads[0].media.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

  data(await call(client, 'drive_upload_file', { localPath: '~/Documents/Ficha 05.docx', convertToGoogleFormat: true, folderId: 'folder1' }));
  assert.equal(uploads[1].requestBody.mimeType, 'application/vnd.google-apps.document');
  assert.deepEqual(uploads[1].requestBody.parents, ['folder1']);

  fs.writeFileSync(path.join(downloads, 'fuera.pdf'), 'x');
  fs.mkdirSync(path.join(teaching, '.oculta'));
  fs.writeFileSync(path.join(teaching, '.oculta', 'secreto.txt'), 'x');
  fs.writeFileSync(path.join(teaching, 'vacio.pdf'), '');
  fs.symlinkSync(path.join(downloads, 'fuera.pdf'), path.join(teaching, 'enlace.pdf'));
  for (const [localPath, reason] of [
    [path.join(downloads, 'fuera.pdf'), /only be uploaded from/],
    [path.join(teaching, 'enlace.pdf'), /only be uploaded from/],
    [path.join(teaching, '.oculta', 'secreto.txt'), /Hidden/],
    [path.join(teaching, 'vacio.pdf'), /empty/],
    [teaching, /folder/],
  ]) {
    const result = await call(client, 'drive_upload_file', { localPath });
    assert.equal(result.isError, true, localPath);
    assert.match(result.content[0].text, reason);
  }
  assert.equal(uploads.length, 2);
});

// ─── Setup wizard helpers ────────────────────────────────────────────────────

test('registering in Claude Desktop keeps other servers and makes a backup', () => {
  const file = path.join(home, 'claude_desktop_config.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } }, preferences: { theme: 'dark' } }));
  const spec = { command: '/usr/local/bin/node', args: ['/path/dist/index.js'] };
  const { backup } = cli.registerClaudeDesktop(file, spec);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.mcpServers, { other: { command: 'x' }, 'google-classroom': spec });
  assert.deepEqual(saved.preferences, { theme: 'dark' });
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')).mcpServers, { other: { command: 'x' } });

  fs.writeFileSync(file, '{ broken');
  assert.throws(() => cli.registerClaudeDesktop(file, spec));
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');

  const fresh = path.join(home, 'new_config.json');
  assert.equal(cli.registerClaudeDesktop(fresh, spec).backup, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, 'utf8')), { mcpServers: { 'google-classroom': spec } });
});

test('Claude starts the server the same way the wizard was started', () => {
  const local = cli.launchSpec('/Users/x/google-classroom-mcp/dist/index.js');
  assert.deepEqual(local, { command: process.execPath, args: ['/Users/x/google-classroom-mcp/dist/index.js'] });
  const viaNpx = cli.launchSpec(path.join('/Users/x/.npm/_npx/abc/node_modules/google-classroom-mcp-docentes/dist/index.js'));
  assert.equal(viaNpx.args.at(-1), 'google-classroom-mcp-docentes');
  assert(viaNpx.args.includes('-y'));
  assert(viaNpx.env.PATH.startsWith(path.dirname(process.execPath)));
});
