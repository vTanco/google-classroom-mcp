import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Point every file this module touches at a throwaway folder before loading it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-login-test-'));
process.env.GOOGLE_CLASSROOM_MCP_HOME = dir;
delete process.env.GOOGLE_CREDENTIALS_PATH; delete process.env.GOOGLE_TOKEN_PATH;
const auth = await import('../dist/auth.js');
const desktop = { installed: { client_id: 'test-client', client_secret: 'test-secret', redirect_uris: ['http://localhost'] } };
fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(desktop));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Stand-in for Google's token endpoint: records each exchange and answers with `grant`.
async function tokenServer(t, grant) {
  const exchanges = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      exchanges.push(Object.fromEntries(new URLSearchParams(body)));
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(grant));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { exchanges, endpoints: { oauth2TokenUrl: `http://127.0.0.1:${server.address().port}/token` } };
}

// Plays the browser: opens nothing, hands back the sign-in link.
const browser = () => { let open; const opened = new Promise(resolve => { open = resolve; }); return { open, opened }; };

test('sign-in uses PKCE and the account chooser, then stores a private token', async t => {
  const grant = { access_token: 'test-access', refresh_token: 'test-refresh', scope: auth.scopes.join(' '), token_type: 'Bearer', expires_in: 3600 };
  const { exchanges, endpoints } = await tokenServer(t, grant);
  const { open, opened } = browser();
  const login = await auth.startLogin({ open, endpoints, timeoutMs: 10_000 });
  const url = new URL(await opened);
  assert.equal(url.href, login.url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('prompt'), /select_account/);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.deepEqual(url.searchParams.get('scope').split(' '), auth.scopes);
  const redirect = new URL(url.searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, '127.0.0.1');

  // A second request while waiting reuses the same sign-in instead of opening another.
  const again = browser();
  assert.equal(await auth.startLogin({ open: again.open, endpoints }), login);
  assert.equal(await again.opened, login.url);

  const forged = await fetch(`${redirect.origin}/?code=x&state=wrong`);
  assert.equal(forged.status, 400);
  assert.equal(auth.loginInProgress(), login);

  const page = await fetch(`${redirect.origin}/?code=test-code&state=${url.searchParams.get('state')}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Classroom está conectado/);
  await login.done;
  assert.equal(auth.loginInProgress(), undefined);
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].code, 'test-code');
  assert(exchanges[0].code_verifier?.length >= 43);
  const token = path.join(dir, 'token.json');
  assert.equal(JSON.parse(fs.readFileSync(token, 'utf8')).refresh_token, 'test-refresh');
  if (process.platform !== 'win32') assert.equal(fs.statSync(token).mode & 0o777, 0o600);
});

test('sign-in without every permission is refused and explained', async t => {
  fs.rmSync(path.join(dir, 'token.json'), { force: true });
  const { endpoints } = await tokenServer(t, { access_token: 'x', scope: auth.scopes[0], token_type: 'Bearer' });
  const { open, opened } = browser();
  const login = await auth.startLogin({ open, endpoints, timeoutMs: 10_000 });
  const url = new URL(await opened);
  const page = await fetch(`${url.searchParams.get('redirect_uri')}/?code=c&state=${url.searchParams.get('state')}`);
  assert.equal(page.status, 403);
  assert.match(await page.text(), /todas/);
  await assert.rejects(login.done, error => auth.diagnose(error) === 'scopes_missing');
  assert.equal(fs.existsSync(path.join(dir, 'token.json')), false);
});

test('a cancelled sign-in changes nothing and frees the next attempt', async t => {
  const { open, opened } = browser();
  const login = await auth.startLogin({ open, timeoutMs: 10_000 });
  const url = new URL(await opened);
  const page = await fetch(`${url.searchParams.get('redirect_uri')}/?error=access_denied&state=${url.searchParams.get('state')}`);
  assert.match(await page.text(), /cancelado/);
  await assert.rejects(login.done);
  assert.equal(auth.loginInProgress(), undefined);
});

test('failures are classified into teacher-facing problems', () => {
  const google = (status, data) => Object.assign(new Error('x'), { response: { status, data } });
  assert.equal(auth.diagnose(google(400, { error: 'invalid_grant' })), 'sign_in_expired');
  assert.equal(auth.diagnose(google(401, { error: 'invalid_client' })), 'sign_in_expired');
  assert.equal(auth.diagnose(google(400, { error: 'deleted_client' })), 'client_mismatch');
  assert.equal(auth.diagnose(google(403, { error: { errors: [{ reason: 'accessNotConfigured' }] } })), 'api_disabled');
  assert.equal(auth.diagnose(google(403, { error: { errors: [{ reason: 'forbidden' }] } })), 'access_denied');
  assert.equal(auth.diagnose(Object.assign(new Error('x'), { code: 'ENOENT' })), 'not_signed_in');
  assert.equal(auth.diagnose(Object.assign(new Error('x'), { code: 'EACCES' })), 'file_permission');
  assert.equal(auth.diagnose(new Error('Desktop OAuth credentials are required.')), 'credentials_not_desktop');
  assert.equal(auth.diagnose(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })), 'offline');
});
