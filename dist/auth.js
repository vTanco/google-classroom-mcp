import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auth as googleAuth, classroom } from '@googleapis/classroom';
import 'dotenv/config';
// Hosts that fill settings from a form (Claude Desktop extensions) pass an empty
// string or the unresolved "${...}" placeholder for a field the user left blank.
const setting = (name) => {
    const value = process.env[name]?.trim();
    return value && !value.includes('${') ? value : undefined;
};
const root = fileURLToPath(new URL('../', import.meta.url));
// Installed from npm (npx / npm i -g) or as a Claude Desktop extension, the package
// folder is not a safe place for secrets, so files live in a per-user folder. A git
// checkout that already keeps credentials.json in its root continues to use it.
export const configDir = setting('GOOGLE_CLASSROOM_MCP_HOME')
    || path.join(setting('XDG_CONFIG_HOME') || path.join(os.homedir(), '.config'), 'google-classroom-mcp-docentes');
const defaultPath = (name) => fs.existsSync(path.join(root, 'credentials.json')) ? path.join(root, name) : path.join(configDir, name);
export const credentialsPath = setting('GOOGLE_CREDENTIALS_PATH') || defaultPath('credentials.json');
export const tokenPath = setting('GOOGLE_TOKEN_PATH') || defaultPath('token.json');
export const scopes = [
    'classroom.courses', 'classroom.coursework.students', 'classroom.courseworkmaterials',
    'classroom.topics', 'classroom.announcements', 'drive.file', 'drive.readonly',
].map(scope => `https://www.googleapis.com/auth/${scope}`);
export function hasRequiredScopes(token) {
    const granted = new Set((token.scope || '').split(' '));
    return scopes.every(scope => granted.has(scope));
}
function writePrivate(destination, content) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
        fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, destination);
    }
    finally {
        if (fs.existsSync(temporary))
            fs.unlinkSync(temporary);
    }
}
export function saveToken(token, destination = tokenPath) {
    writePrivate(destination, JSON.stringify(token, null, 2));
}
function readDesktopClient(file) {
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))?.installed;
    if (!config?.client_id || !config.client_secret)
        throw new Error('Desktop OAuth credentials are required.');
    return config;
}
export function credentialsState(file = credentialsPath) {
    try {
        readDesktopClient(file);
        return 'ok';
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return 'missing';
        return error instanceof SyntaxError || error.code ? 'invalid' : 'not_desktop';
    }
}
/** Copy a downloaded client_secret file into the private config folder. */
export function importCredentials(source) {
    readDesktopClient(source);
    writePrivate(credentialsPath, fs.readFileSync(source, 'utf8'));
}
const downloadFolders = () => ['Downloads', 'Descargas', 'Desktop', 'Escritorio'].map(name => path.join(os.homedir(), name));
function downloadedClientFiles(folders) {
    const found = [];
    for (const folder of folders) {
        let names = [];
        try {
            names = fs.readdirSync(folder);
        }
        catch {
            continue;
        }
        for (const name of names) {
            if (!/^client_secret.*\.json$/i.test(name))
                continue;
            const file = path.join(folder, name);
            try {
                const stat = fs.statSync(file);
                if (stat.isFile() && stat.size < 64 * 1024)
                    found.push({ file, time: stat.mtimeMs, state: credentialsState(file) });
            }
            catch { /* unreadable: skip */ }
        }
    }
    return found.sort((a, b) => b.time - a.time);
}
/** Newest valid "client_secret*.json" the browser left in Downloads or Desktop. */
export function findDownloadedCredentials(folders = downloadFolders()) {
    return downloadedClientFiles(folders).find(item => item.state === 'ok')?.file ?? null;
}
/** Why nothing usable is in place: tells a wrong-type download apart from no download at all. */
export function missingCredentialsReason(folders = downloadFolders()) {
    const stored = credentialsState();
    if (stored !== 'ok' && stored !== 'missing')
        return stored;
    return downloadedClientFiles(folders).some(item => item.state === 'not_desktop') ? 'not_desktop' : 'missing';
}
/**
 * Bring credentials into place without the teacher moving files by hand:
 * the file chosen in the host's settings form wins, then (only when asked)
 * a client_secret file sitting in Downloads. Returns where they came from.
 */
export function ensureCredentials(options = {}) {
    const chosen = setting('GOOGLE_CLASSROOM_CREDENTIALS_FILE');
    if (chosen && credentialsState(chosen) === 'ok') {
        const same = credentialsState() === 'ok' && fs.readFileSync(chosen, 'utf8') === fs.readFileSync(credentialsPath, 'utf8');
        if (same)
            return 'present';
        importCredentials(chosen);
        return 'settings';
    }
    if (credentialsState() === 'ok')
        return 'present';
    const downloaded = options.searchDownloads ? findDownloadedCredentials() : null;
    if (downloaded) {
        importCredentials(downloaded);
        return 'downloads';
    }
    return null;
}
export function createAuthClient(redirectUri, endpoints) {
    const config = readDesktopClient(credentialsPath);
    return new googleAuth.OAuth2({
        clientId: config.client_id, clientSecret: config.client_secret, redirectUri, ...(endpoints ? { endpoints } : {}),
    });
}
export function loadAuthClient() {
    const auth = createAuthClient();
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    if (!hasRequiredScopes(token))
        throw new Error('Required OAuth scopes are missing.');
    auth.setCredentials(token);
    auth.on('tokens', fresh => {
        // Google may omit refresh_token and scope when refreshing; preserve both.
        Object.assign(token, fresh);
        try {
            saveToken(token);
        }
        catch {
            console.error('Could not persist refreshed OAuth token. Check token file permissions.');
        }
    });
    return auth;
}
// ─── Browser sign-in (loopback redirect, PKCE) ────────────────────────────────
export function openBrowser(url) {
    const [command, args] = process.platform === 'darwin' ? ['open', [url]]
        : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
            : ['xdg-open', [url]];
    try {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });
        child.on('error', () => { });
        child.unref();
    }
    catch { /* same */ }
}
const page = (title, body, ok) => `<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;text-align:center;color:#1f2937">
<div style="font-size:3rem">${ok ? '✅' : '⚠️'}</div><h1 style="font-size:1.5rem">${title}</h1><p style="line-height:1.5">${body}</p></body></html>`;
let pendingLogin;
export const loginInProgress = () => pendingLogin;
/**
 * Start Google sign-in in the browser. Resolves as soon as the link is ready;
 * `done` settles when the teacher finishes (or after `timeoutMs`). Only one
 * sign-in runs at a time: parallel consent windows make Google answer 500.
 */
export async function startLogin(options = {}) {
    const open = options.open ?? openBrowser;
    if (pendingLogin) {
        open(pendingLogin.url);
        return pendingLogin;
    }
    const server = http.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    let client;
    try {
        client = createAuthClient(redirectUri, options.endpoints);
    }
    catch (error) {
        server.close();
        throw error;
    }
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = randomUUID();
    const url = client.generateAuthUrl({
        access_type: 'offline',
        // Always show the account chooser: the browser's default account is often
        // a personal one, not the school account that owns the Classroom courses.
        prompt: 'consent select_account',
        scope: scopes, state, code_challenge: codeChallenge, code_challenge_method: 'S256',
    });
    const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Sign-in timed out.')), options.timeoutMs ?? 5 * 60 * 1000);
        timer.unref();
        server.on('request', async (request, response) => {
            const query = new URL(request.url || '/', redirectUri).searchParams;
            const send = (status, title, body) => {
                response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                response.end(page(title, body, status === 200));
            };
            if (!query.has('code') && !query.has('error')) {
                response.writeHead(404).end();
                return;
            }
            if (query.get('state') !== state) {
                send(400, 'Enlace no válido', 'Esta página no corresponde al inicio de sesión en curso. Vuelve a Claude y pide conectar de nuevo.');
                return;
            }
            try {
                if (query.has('error'))
                    throw Object.assign(new Error('Sign-in was cancelled or denied.'), { denied: true });
                const { tokens } = await client.getToken({ code: query.get('code'), codeVerifier, redirect_uri: redirectUri });
                if (!hasRequiredScopes(tokens))
                    throw new Error('Required OAuth scopes are missing.');
                saveToken(tokens);
                send(200, 'Classroom está conectado', 'Ya puedes cerrar esta pestaña y volver a Claude.');
                resolve();
            }
            catch (error) {
                if (error.message === 'Required OAuth scopes are missing.') {
                    send(403, 'Faltan permisos', 'No se marcaron todas las casillas de permisos. Vuelve a Claude, pide conectar de nuevo y marca <b>todas</b> las casillas antes de continuar.');
                }
                else if (error.denied) {
                    send(403, 'Inicio de sesión cancelado', 'No se ha conectado nada. Si fue sin querer, vuelve a Claude y pide conectar de nuevo.');
                }
                else {
                    send(500, 'No se pudo completar', 'Google no aceptó el inicio de sesión. Vuelve a Claude y pide conectar de nuevo.');
                }
                reject(error);
            }
            finally {
                clearTimeout(timer);
            }
        });
    }).finally(() => {
        pendingLogin = undefined;
        server.close();
        server.closeAllConnections();
    });
    done.catch(() => { });
    pendingLogin = { url, done };
    open(url);
    return pendingLogin;
}
/** Classify a failure from loading the OAuth files or from a Google API call. */
export function diagnose(error) {
    const status = Number(error?.response?.status ?? error?.status);
    const oauthError = error?.response?.data?.error;
    const reasons = (error?.response?.data?.error?.errors || []).map((item) => item.reason);
    if (error?.code === 'ENOENT')
        return credentialsState() === 'ok' ? 'not_signed_in' : 'credentials_missing';
    if (['EACCES', 'EPERM'].includes(error?.code))
        return 'file_permission';
    if (error instanceof SyntaxError)
        return credentialsState() === 'invalid' ? 'credentials_invalid' : 'not_signed_in';
    if (error?.message === 'Desktop OAuth credentials are required.')
        return 'credentials_not_desktop';
    if (error?.message === 'Required OAuth scopes are missing.')
        return 'scopes_missing';
    if (oauthError === 'invalid_grant' || status === 401)
        return 'sign_in_expired';
    if (['invalid_client', 'unauthorized_client', 'deleted_client'].includes(oauthError))
        return 'client_mismatch';
    if (reasons.includes('accessNotConfigured') || reasons.includes('serviceDisabled') || /has not been used in project|is disabled/i.test(String(error?.message)))
        return 'api_disabled';
    if (status === 403)
        return 'access_denied';
    return 'offline';
}
/** Read one course ID to prove the saved sign-in works. Changes nothing. */
export async function verifyConnection() {
    await classroom({ version: 'v1', auth: loadAuthClient() }).courses.list({ pageSize: 1, fields: 'courses(id)' });
}
/** `null` when Classroom answers; otherwise what stands in the way. */
export async function connectionProblem() {
    try {
        ensureCredentials();
        await verifyConnection();
        return null;
    }
    catch (error) {
        return diagnose(error);
    }
}
//# sourceMappingURL=auth.js.map