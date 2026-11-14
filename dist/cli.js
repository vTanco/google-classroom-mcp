import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { drive } from '@googleapis/drive';
import { configDir, connectionProblem, credentialsState, diagnose, ensureCredentials, findDownloadedCredentials, importCredentials, loadAuthClient, missingCredentialsReason, openBrowser, startLogin, verifyConnection, } from './auth.js';
const PACKAGE = 'google-classroom-mcp-docentes';
const RUN = `npx -y ${PACKAGE}`;
const GUIDE = 'https://github.com/vTanco/google-classroom-mcp/blob/main/INSTALACION.md';
export const CONSOLE = {
    project: 'https://console.cloud.google.com/projectcreate',
    apis: 'https://console.cloud.google.com/flows/enableapi?apiid=classroom.googleapis.com,drive.googleapis.com,slides.googleapis.com',
    consent: 'https://console.cloud.google.com/auth/overview',
    audience: 'https://console.cloud.google.com/auth/audience',
    client: 'https://console.cloud.google.com/auth/clients/create',
};
const PROBLEMS = {
    credentials_missing: `Falta tu llave de Google. Ejecuta el asistente: ${RUN} setup`,
    credentials_invalid: 'El archivo de tu llave de Google no es un JSON válido (descarga incompleta o editado a mano). Descárgalo de nuevo en Google Cloud: Google Auth Platform → Clientes → icono de descarga.',
    credentials_not_desktop: 'Tu llave es de tipo «Aplicación web» y no sirve aquí. Crea un cliente de tipo «App de escritorio» y descarga su JSON.',
    not_signed_in: `Aún no has iniciado sesión con Google. Ejecuta: ${RUN} auth`,
    scopes_missing: `Faltan permisos: al iniciar sesión hay que marcar todas las casillas. Ejecuta: ${RUN} auth`,
    sign_in_expired: `Tu inicio de sesión ha caducado (con la app en modo «Prueba», Google lo retira cada 7 días). Dile a Claude «reconecta Classroom» o ejecuta: ${RUN} auth`,
    client_mismatch: 'Google ya no reconoce esta llave (el cliente se borró o se sustituyó). Descarga de nuevo su JSON en Google Cloud y repite el asistente.',
    api_disabled: `Falta habilitar una API en tu proyecto de Google Cloud. Abre este enlace con tu proyecto seleccionado y pulsa «Habilitar»: ${CONSOLE.apis}`,
    access_denied: `Google ha denegado el acceso. Suele ser porque el administrador de tu centro bloquea aplicaciones externas o porque tu correo no está en «Usuarios de prueba». Mira ${GUIDE}#si-algo-falla`,
    file_permission: `No se pueden leer o escribir los archivos de sesión en ${configDir}. Revisa los permisos de esa carpeta.`,
    offline: 'No se ha podido contactar con Google. Revisa tu conexión a internet e inténtalo de nuevo.',
};
const say = (text = '') => console.log(text);
const ok = (text) => console.log(`  ✓ ${text}`);
const warn = (text) => console.error(`  ✗ ${text}`);
/** How Claude should start this server, given how the wizard itself was started. */
export function launchSpec(entry = fileURLToPath(new URL('./index.js', import.meta.url))) {
    if (!entry.includes(`${path.sep}_npx${path.sep}`))
        return { command: process.execPath, args: [entry] };
    // Started with npx: its cache folder is not a stable address, so Claude runs npx too
    // (which also keeps the server up to date). Desktop apps start with a minimal PATH,
    // so pass the one from this terminal, where node is known to be reachable.
    const nodeDir = path.dirname(process.execPath);
    const npx = [
        process.env.npm_execpath && path.join(path.dirname(process.env.npm_execpath), 'npx-cli.js'),
        path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
        path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    ].find(candidate => candidate && fs.existsSync(candidate));
    const env = { PATH: [nodeDir, process.env.PATH].filter(Boolean).join(path.delimiter) };
    return npx ? { command: process.execPath, args: [path.resolve(npx), '-y', PACKAGE], env } : { command: 'npx', args: ['-y', PACKAGE], env };
}
/** Config files of the Claude Desktop installs found on this computer. */
export function claudeDesktopConfigs(home = os.homedir()) {
    const folders = [];
    if (process.platform === 'darwin')
        folders.push(path.join(home, 'Library', 'Application Support', 'Claude'));
    else if (process.platform === 'win32') {
        folders.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude'));
        // Microsoft Store builds keep a private copy of AppData.
        const packages = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages');
        try {
            for (const name of fs.readdirSync(packages)) {
                if (name.startsWith('Claude_'))
                    folders.push(path.join(packages, name, 'LocalCache', 'Roaming', 'Claude'));
            }
        }
        catch { /* no Store apps */ }
    }
    else
        folders.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude'));
    return folders.filter(folder => fs.existsSync(folder)).map(folder => path.join(folder, 'claude_desktop_config.json'));
}
/** Add (or replace) the google-classroom entry, keeping every other setting and a backup. */
export function registerClaudeDesktop(file, spec) {
    let config = {};
    let backup = null;
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) {
        config = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof config !== 'object' || Array.isArray(config) || config === null)
            throw new SyntaxError('Not a JSON object.');
        backup = `${file}.copia-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        fs.copyFileSync(file, backup);
    }
    config.mcpServers = { ...(config.mcpServers ?? {}), 'google-classroom': spec };
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
    return { backup };
}
function registerClaudeCode(spec) {
    const run = (args) => spawnSync('claude', args, { stdio: 'pipe', shell: process.platform === 'win32', timeout: 30_000 });
    const probe = run(['mcp', 'get', 'google-classroom']);
    if (probe.error)
        return 'absent';
    if (probe.status === 0)
        return 'already';
    const env = Object.entries(spec.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    return run(['mcp', 'add', 'google-classroom', '--scope', 'user', ...env, '--', spec.command, ...spec.args]).status === 0 ? 'added' : 'failed';
}
// ─── Commands ────────────────────────────────────────────────────────────────
async function signIn() {
    const login = await startLogin({ open: process.env.GOOGLE_CLASSROOM_NO_BROWSER ? () => { } : openBrowser, timeoutMs: 10 * 60 * 1000 });
    say('  Se ha abierto tu navegador con la página de Google:');
    say('    1. Elige tu cuenta del centro (la que usas en Classroom).');
    say('    2. Si avisa de que «Google no ha verificado esta aplicación», es normal (la aplicación es tuya):');
    say('       pulsa «Configuración avanzada» y después «Ir a Classroom MCP».');
    say('    3. Marca TODAS las casillas de permisos y pulsa «Continuar».');
    say();
    say('  Si no se ha abierto, copia este enlace en tu navegador:');
    say(`  ${login.url}`);
    say();
    say('  Esperando a que termines en el navegador…');
    try {
        await login.done;
    }
    catch (error) {
        const problem = diagnose(error);
        if (problem !== 'offline')
            return problem;
        warn(error.message === 'Sign-in timed out.' ? 'Se acabó el tiempo de espera (10 minutos).' : 'Google no completó el inicio de sesión.');
        return 'not_signed_in';
    }
    return connectionProblem();
}
async function auth() {
    ensureCredentials({ searchDownloads: true });
    if (credentialsState() !== 'ok') {
        const reason = missingCredentialsReason();
        warn(PROBLEMS[reason === 'missing' ? 'credentials_missing' : reason === 'invalid' ? 'credentials_invalid' : 'credentials_not_desktop']);
        return 1;
    }
    if (!(await connectionProblem())) {
        ok('Tu cuenta de Google ya está conectada.');
        return 0;
    }
    const problem = await signIn();
    if (problem) {
        warn(PROBLEMS[problem]);
        return 1;
    }
    ok('Conectado. Ya puedes usar Classroom desde Claude.');
    return 0;
}
async function doctor() {
    try {
        ensureCredentials();
        await verifyConnection();
        ok('Classroom responde.');
        await drive({ version: 'v3', auth: loadAuthClient() }).files.list({ pageSize: 1, fields: 'files(id)' });
        ok('Drive responde.');
        ok('Todo en orden. No se ha modificado nada en tus cursos.');
        return 0;
    }
    catch (error) {
        warn(PROBLEMS[diagnose(error)]);
        return 1;
    }
}
async function setup(assumeYes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const enter = async (text) => { if (!assumeYes)
        await rl.question(`  ${text} `); };
    const yes = async (text) => assumeYes || !/^n/i.test((await rl.question(`  ${text} [S/n] `)).trim());
    try {
        say();
        say('Google Classroom para Claude · asistente de instalación');
        say('═══════════════════════════════════════════════════════');
        say('Son 3 pasos. Puedes salir cuando quieras con Ctrl+C y volver a empezar: no se pierde nada.');
        // ── Paso 1 ──
        say();
        say('Paso 1 de 3 · Tu llave de Google');
        let source = ensureCredentials({ searchDownloads: true });
        if (source === 'downloads')
            ok('He encontrado tu llave en Descargas y he guardado una copia privada.');
        else if (source)
            ok('Ya tienes tu llave de Google guardada.');
        else {
            say('  Google pide que cada docente cree su propia llave gratuita (unos 10 minutos, una sola vez).');
            say('  Te abro cada página en el navegador. Haz lo que indico y vuelve aquí.');
            say('  Importante: entra con tu cuenta del centro, la misma que usas en Classroom.');
            const pages = [
                ['A. Crear el proyecto', CONSOLE.project, ['Nombre del proyecto: Classroom MCP', 'Pulsa «Crear» y espera a que termine.']],
                ['B. Activar Classroom, Drive y Slides', CONSOLE.apis, ['Comprueba que arriba está elegido el proyecto «Classroom MCP».', 'Pulsa «Siguiente» y después «Habilitar».']],
                ['C. Pantalla de consentimiento', CONSOLE.consent, [
                        'Pulsa «Comenzar». Nombre de la aplicación: Classroom MCP. Correo de asistencia: el tuyo.',
                        'Público: elige «Interno» si aparece; si no, «Externo».',
                        'Escribe tu correo de contacto, acepta la política y pulsa «Crear».',
                    ]],
                ['D. Solo si elegiste «Externo»: añadirte como usuario de prueba', CONSOLE.audience, ['En «Usuarios de prueba» pulsa «Add users», escribe tu propio correo y guarda.', 'Si elegiste «Interno», no hagas nada en esta página.']],
                ['E. Crear y descargar la llave', CONSOLE.client, [
                        'Tipo de aplicación: «App de escritorio» (no «Aplicación web»). Nombre: Claude.',
                        'Pulsa «Crear» y después «Descargar JSON». Déjalo en tu carpeta Descargas.',
                    ]],
            ];
            for (const [title, url, steps] of pages) {
                say();
                say(`  ${title}`);
                for (const step of steps)
                    say(`    · ${step}`);
                await enter('Pulsa Intro para abrir la página…');
                if (!process.env.GOOGLE_CLASSROOM_NO_BROWSER)
                    openBrowser(url);
                say(`    ${url}`);
                if (title.startsWith('E'))
                    break;
                await enter('Cuando lo hayas hecho, pulsa Intro para seguir…');
            }
            say();
            say('  Esperando a que aparezca el archivo descargado (client_secret_….json) en Descargas…');
            say('  Si lo guardaste en otro sitio, arrástralo a esta ventana y pulsa Intro.');
            const abort = new AbortController();
            const typed = rl.question('  ', { signal: abort.signal }).catch(() => null);
            let file = null;
            const deadline = Date.now() + 15 * 60 * 1000;
            while (!file && Date.now() < deadline) {
                const answer = await Promise.race([typed, sleep(2000, undefined)]);
                // Terminals quote or backslash-escape a dragged path.
                if (typeof answer === 'string' && answer.trim())
                    file = answer.trim().replace(/^['"]|['"]$/g, '').replace(/\\(.)/g, '$1');
                else
                    file = findDownloadedCredentials();
            }
            abort.abort();
            if (!file) {
                warn('No he encontrado el archivo. Vuelve a ejecutar el asistente cuando lo hayas descargado.');
                return 1;
            }
            const state = credentialsState(file);
            if (state !== 'ok') {
                warn(PROBLEMS[state === 'missing' ? 'credentials_missing' : state === 'invalid' ? 'credentials_invalid' : 'credentials_not_desktop']);
                return 1;
            }
            importCredentials(file);
            ok('Llave guardada en un lugar privado de tu ordenador. Ya puedes borrar el archivo descargado.');
        }
        // ── Paso 2 ──
        say();
        say('Paso 2 de 3 · Conectar tu cuenta de Google');
        let problem = await connectionProblem();
        if (problem && ['not_signed_in', 'scopes_missing', 'sign_in_expired'].includes(problem))
            problem = await signIn();
        if (problem) {
            warn(PROBLEMS[problem]);
            return 1;
        }
        ok('Cuenta conectada: Classroom responde.');
        // ── Paso 3 ──
        say();
        say('Paso 3 de 3 · Añadirlo a Claude');
        const spec = launchSpec();
        let registered = false;
        for (const file of claudeDesktopConfigs()) {
            if (!(await yes('He encontrado Claude Desktop. ¿Lo añado a su configuración?')))
                continue;
            try {
                const { backup } = registerClaudeDesktop(file, spec);
                ok(`Añadido a Claude Desktop.${backup ? ` Copia de seguridad de tu configuración anterior: ${backup}` : ''}`);
                registered = true;
            }
            catch {
                warn(`No he tocado ${file} porque no he podido leerlo. Ábrelo desde Claude (Configuración → Desarrollador → Editar configuración) y revisa que sea un JSON válido.`);
            }
        }
        const code = registerClaudeCode(spec);
        if (code === 'added') {
            ok('Añadido a Claude Code.');
            registered = true;
        }
        if (code === 'already') {
            ok('Claude Code ya lo tenía configurado.');
            registered = true;
        }
        if (code === 'failed')
            warn('No he podido añadirlo a Claude Code automáticamente.');
        if (!registered) {
            say('  No he encontrado Claude en este ordenador. Cuando lo instales, añade este bloque en');
            say('  Claude Desktop → Configuración → Desarrollador → Editar configuración:');
            say();
            say(JSON.stringify({ mcpServers: { 'google-classroom': spec } }, null, 2).replace(/^/gm, '    '));
        }
        say();
        say('¡Listo!');
        say('  1. Cierra Claude del todo (Cmd+Q en Mac; «Salir» desde la bandeja en Windows) y vuelve a abrirlo.');
        say('  2. Escríbele: «Lista mis cursos de Classroom».');
        say('  Si algún día deja de responder, dile: «reconecta Classroom».');
        say();
        return 0;
    }
    finally {
        rl.close();
    }
}
export async function main(argv) {
    const command = (argv[0] || '').replace(/^--/, '');
    try {
        if (['setup', 'instalar', 'configurar'].includes(command))
            return await setup(argv.includes('--yes') || argv.includes('-y'));
        if (['auth', 'conectar'].includes(command))
            return await auth();
        if (['doctor', 'check', 'comprobar'].includes(command))
            return await doctor();
    }
    catch (error) {
        warn(PROBLEMS[diagnose(error)]);
        return 1;
    }
    say(`Uso:
  ${RUN} setup     Asistente de instalación paso a paso (recomendado)
  ${RUN} auth      Iniciar sesión con Google de nuevo
  ${RUN} doctor    Comprobar que todo funciona (no modifica nada)

Sin argumentos arranca el servidor MCP; eso lo hace Claude por ti.
Guía completa: ${GUIDE}`);
    return ['help', 'ayuda', 'h'].includes(command) ? 0 : 1;
}
//# sourceMappingURL=cli.js.map