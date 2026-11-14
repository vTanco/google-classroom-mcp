#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { classroom as classroomApi } from '@googleapis/classroom';
import { drive as driveApi } from '@googleapis/drive';
import { slides as slidesApi } from '@googleapis/slides';
import { loadAuthClient, ensureCredentials, missingCredentialsReason, connectionProblem, diagnose, startLogin, loginInProgress, openBrowser, } from './auth.js';
import { resolveUpload, googleFormatFor } from './upload.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const GUIDE = 'https://github.com/vTanco/google-classroom-mcp/blob/main/INSTALACION.md';
const ENABLE_APIS = 'https://console.cloud.google.com/flows/enableapi?apiid=classroom.googleapis.com,drive.googleapis.com,slides.googleapis.com';
// What to tell the teacher for each obstacle. Written for the assistant, which
// relays it in the teacher's language; never includes local paths or secrets.
const HELP = {
    credentials_missing: {
        summary: 'The teacher has not added their Google credentials file yet (a one-time step).',
        nextStep: `Walk them through "Tu llave de Google" in ${GUIDE}#paso-1-tu-llave-de-google. It ends with a downloaded file named client_secret_....json. Leave it in the Downloads folder and call classroom_connect: it is picked up automatically.`,
    },
    credentials_invalid: {
        summary: 'The Google credentials file is damaged (incomplete download or edited by hand).',
        nextStep: 'Ask them to download the JSON again from Google Cloud (Google Auth Platform > Clients > download icon), leave it in Downloads and call classroom_connect.',
    },
    credentials_not_desktop: {
        summary: 'The credentials belong to a "Web application" client, which cannot be used here.',
        nextStep: 'Ask them to create a new client of type "Desktop app" (App de escritorio) in Google Auth Platform > Clients, download its JSON and call classroom_connect.',
    },
    not_signed_in: {
        summary: 'The credentials are in place but the teacher has not signed in with Google yet.',
        nextStep: 'Call classroom_connect to open the Google sign-in page in their browser.',
    },
    scopes_missing: {
        summary: 'The teacher signed in without granting every permission.',
        nextStep: 'Call classroom_connect and ask them to tick every checkbox on Google\'s permission screen before continuing.',
    },
    sign_in_expired: {
        summary: 'The Google sign-in expired or was revoked. Google Cloud projects in "Testing" mode expire every 7 days; this is expected.',
        nextStep: 'Call classroom_connect to sign in again (about one minute, no terminal needed).',
    },
    client_mismatch: {
        summary: 'Google no longer recognises these credentials (the client was deleted or replaced).',
        nextStep: 'Ask them to download the client JSON again from Google Cloud, leave it in Downloads and call classroom_connect.',
    },
    api_disabled: {
        summary: 'A required Google API is not enabled in the teacher\'s Google Cloud project.',
        nextStep: `Ask them to open ${ENABLE_APIS} with the same project selected, press Enable, wait a minute and try again.`,
    },
    access_denied: {
        summary: 'Google denied access to Classroom for this account.',
        nextStep: `Usual causes: the school's Google Workspace administrator blocks third-party apps, or the account is not listed as a test user. See ${GUIDE}#si-algo-falla.`,
    },
    file_permission: {
        summary: 'The saved sign-in files cannot be read or written on this computer.',
        nextStep: 'Ask them to check that their user can write to the google-classroom-mcp-docentes folder inside their home .config folder, then call classroom_connect.',
    },
    offline: {
        summary: 'Google could not be reached.',
        nextStep: 'Ask them to check the internet connection and try again in a moment.',
    },
};
const SIGN_IN_FIXES = ['not_signed_in', 'scopes_missing', 'sign_in_expired'];
export class GoogleClassroomServer {
    options;
    server;
    classroom;
    drive;
    slides;
    constructor(options = {}) {
        this.options = options;
        this.server = new Server({ name: 'google-classroom-mcp', version: packageVersion }, { capabilities: { tools: {} } });
        this.setupHandlers();
    }
    async initApis() {
        if (!this.classroom || !this.drive || !this.slides) {
            const auth = loadAuthClient();
            this.classroom = classroomApi({ version: 'v1', auth });
            this.drive = driveApi({ version: 'v3', auth });
            this.slides = slidesApi({ version: 'v1', auth });
        }
        return { classroom: this.classroom, drive: this.drive, slides: this.slides };
    }
    resetApis() { this.classroom = this.drive = this.slides = undefined; }
    report(data, isError = false) {
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], ...(isError ? { isError } : {}) };
    }
    blocked(problem) {
        return this.report({ connected: false, problem, ...HELP[problem] });
    }
    // ─── classroom_status: is Classroom reachable, and if not, what is missing ──
    async status() {
        const problem = await connectionProblem();
        if (!problem)
            return this.report({ connected: true, version: packageVersion, summary: 'Google Classroom is connected and answering.' });
        const login = loginInProgress();
        if (login && SIGN_IN_FIXES.includes(problem)) {
            return this.report({
                connected: false, state: 'waiting_for_sign_in', signInUrl: login.url,
                summary: 'The Google sign-in page is open and waiting for the teacher to finish.',
                nextStep: 'Ask them to complete it in the browser (or open signInUrl), then call classroom_status again.',
            });
        }
        return this.blocked(problem);
    }
    // ─── classroom_connect: sign in from the chat, no terminal ─────────────────
    async connect() {
        let source;
        try {
            source = ensureCredentials({ searchDownloads: true });
        }
        catch (error) {
            return this.blocked(diagnose(error));
        }
        if (!source) {
            const reason = missingCredentialsReason();
            return this.blocked(reason === 'invalid' ? 'credentials_invalid' : reason === 'not_desktop' ? 'credentials_not_desktop' : 'credentials_missing');
        }
        const imported = source === 'downloads' ? { credentialsImported: 'Found the client_secret file in Downloads and stored a private copy; the downloaded file can be deleted.' } : {};
        const problem = await connectionProblem();
        if (!problem)
            return this.report({ connected: true, ...imported, summary: 'Google Classroom is already connected.' });
        if (!SIGN_IN_FIXES.includes(problem))
            return this.blocked(problem);
        let login;
        try {
            login = await startLogin({ open: this.options.openBrowser ?? (process.env.GOOGLE_CLASSROOM_NO_BROWSER ? () => { } : openBrowser) });
        }
        catch (error) {
            return this.blocked(diagnose(error));
        }
        login.done.then(() => this.resetApis(), () => { });
        const outcome = await Promise.race([
            login.done.then(() => 'done', (error) => ({ error })),
            sleep(this.options.signInWaitMs ?? 40_000, 'waiting', { ref: false }),
        ]);
        if (outcome === 'waiting') {
            return this.report({
                connected: false, state: 'waiting_for_sign_in', signInUrl: login.url, ...imported,
                summary: 'The Google sign-in page was opened in the teacher\'s browser.',
                nextStep: 'Ask them to choose their school account, tick every permission and continue. If no page opened, give them signInUrl. If Google warns that the app is not verified, that is expected (the app is their own): Advanced > Go to the app. When they say it is done, call classroom_status.',
            });
        }
        if (outcome !== 'done') {
            const reason = diagnose(outcome.error);
            if (reason !== 'offline')
                return this.blocked(reason);
            return this.report({ connected: false, ...imported, summary: 'The sign-in was cancelled or timed out; nothing changed.', nextStep: 'Call classroom_connect again when the teacher is ready.' });
        }
        const after = await connectionProblem();
        return after ? this.blocked(after) : this.report({ connected: true, ...imported, summary: 'Google Classroom is now connected.' });
    }
    setupHandlers() {
        const tools = this.getTools();
        const validator = new AjvJsonSchemaValidator();
        const validators = new Map(tools.map(tool => [tool.name, validator.getValidator(tool.inputSchema)]));
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });
            const name = request.params.name;
            const validate = validators.get(name);
            if (!validate)
                return fail('Tool is not available.');
            const args = request.params.arguments || {};
            if (!validate(args).valid)
                return fail('Invalid arguments. Check required fields, types and allowed values in tools/list.');
            if (name === 'classroom_update_course' && Object.keys(args).length === 1)
                return fail('Supply at least one course field to change.');
            const patch = name.startsWith('classroom_patch_') && args.updateMask;
            if (patch) {
                const fields = String(args.updateMask).split(',');
                if (new Set(fields).size !== fields.length || fields.some(field => args[field] === undefined)) {
                    return fail('Each updateMask field must be supplied exactly once. Use an empty string to clear a supported text field.');
                }
            }
            if (args.dueTime && !args.dueDate)
                return fail('dueTime requires dueDate; both use local time.');
            if (patch && args.dueTime && !String(args.updateMask).split(',').includes('dueTime'))
                return fail('Include dueTime in updateMask when supplying it.');
            if (args.scheduledTime && args.state === 'PUBLISHED')
                return fail('Scheduled posts must be DRAFT.');
            if ((args.attachments || []).some(a => a.shareMode && a.type !== 'driveFile'))
                return fail('shareMode only applies to driveFile attachments.');
            for (const attachment of (args.attachments || [])) {
                if (['link', 'form'].includes(attachment.type)) {
                    try {
                        if (!['http:', 'https:'].includes(new URL(attachment.idOrUrl).protocol))
                            return fail('Attachment links must use HTTP or HTTPS.');
                    }
                    catch {
                        return fail('Attachment link is invalid.');
                    }
                }
            }
            if (name === 'classroom_create_assignment') {
                const multipleChoice = args.workType === 'MULTIPLE_CHOICE_QUESTION';
                if (multipleChoice !== Boolean(args.choices))
                    return fail('choices is required for MULTIPLE_CHOICE_QUESTION and only allowed there.');
                if (multipleChoice && new Set(args.choices).size !== args.choices.length)
                    return fail('choices must be different from each other.');
            }
            if (name === 'drive_upload_file') {
                if (Boolean(args.localPath) === Boolean(args.base64Content))
                    return fail('Supply exactly one of localPath (a file on this computer) or base64Content.');
                if (args.localPath) {
                    try {
                        resolveUpload(args.localPath);
                    }
                    catch (error) {
                        return fail(error.message);
                    }
                }
                else {
                    if (!args.name)
                        return fail('name is required with base64Content.');
                    const content = args.base64Content;
                    const buffer = Buffer.from(content, 'base64');
                    if (buffer.length > 5 * 1024 * 1024 || buffer.toString('base64') !== content)
                        return fail('File must be canonical base64 and at most 5 MiB.');
                }
            }
            if (name === 'classroom_status')
                return this.status();
            if (name === 'classroom_connect')
                return this.connect();
            let apis;
            try {
                apis = await this.initApis();
            }
            catch (error) {
                const problem = diagnose(error);
                return fail(`Google Classroom is not connected (${problem}). ${HELP[problem].summary} ${HELP[problem].nextStep}`);
            }
            try {
                return await this.handleToolCall(apis.classroom, apis.drive, apis.slides, name, args);
            }
            catch (error) {
                const readOnly = /_(list|get|search)_/.test(name);
                return fail(this.googleReason(error) + (readOnly ? '' : ' Verify the target before retrying; the write may have succeeded.'));
            }
        });
    }
    googleReason(error) {
        const status = Number(error.response?.status || error.code);
        const problem = diagnose(error);
        if (problem === 'sign_in_expired' || problem === 'client_mismatch' || problem === 'api_disabled') {
            if (problem !== 'api_disabled')
                this.resetApis();
            return `${HELP[problem].summary} ${HELP[problem].nextStep}`;
        }
        return status === 403 ? 'Access denied. Check the course role and remember that Google only lets this app edit posts it created itself.'
            : status === 404 ? 'Resource not found or inaccessible.'
                : status === 400 ? 'Google rejected these arguments or this state change.'
                    : status === 429 ? 'Google rate limit reached.' : 'Google request failed.';
    }
    // ─── HELPER: map attachment descriptors to Classroom API material format ───
    mapAttachments(attachments) {
        return attachments.map(att => {
            switch (att.type) {
                case 'driveFile': return { driveFile: { driveFile: { id: att.idOrUrl }, ...(att.shareMode ? { shareMode: att.shareMode } : {}) } };
                case 'link': return { link: { url: att.idOrUrl } };
                case 'youtubeVideo': return { youtubeVideo: { id: att.idOrUrl } };
                case 'form': return { form: { formUrl: att.idOrUrl } };
                default: return att;
            }
        });
    }
    // ─── HELPER: parse "YYYY-MM-DD" and optional "HH:MM" into API date/time ───
    parseDueDateTime(dueDate, dueTime) {
        if (!dueDate)
            return {};
        const [year, month, day] = dueDate.split('-').map(Number);
        const [hours, minutes] = (dueTime || '23:59').split(':').map(Number);
        // Classroom stores due dates in UTC; treat the given date/time as local time.
        const due = new Date(year, month - 1, day, hours, minutes);
        return {
            dueDate: { year: due.getUTCFullYear(), month: due.getUTCMonth() + 1, day: due.getUTCDate() },
            dueTime: { hours: due.getUTCHours(), minutes: due.getUTCMinutes(), seconds: 0, nanos: 0 },
        };
    }
    // ─── TOOLS DECLARATION ────────────────────────────────────────────────────
    getTools() {
        const tools = [
            // ── CONNECTION ───────────────────────────────────────────────────────
            {
                name: 'classroom_status',
                description: 'Check whether Google Classroom is connected. If it is not, returns what is missing and the exact next step to tell the teacher. Call this first when the teacher asks whether the connection works or when another tool reports it is not connected.',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'classroom_connect',
                description: 'Connect or reconnect Google Classroom without a terminal: picks up the credentials file from the Downloads folder if needed and opens Google sign-in in the teacher\'s browser. Use it for first-time setup and whenever the sign-in has expired.',
                inputSchema: { type: 'object', properties: {} },
            },
            {
                name: 'slides_get_presentation',
                description: 'Read a Google Slides presentation by ID, including its slide text and structure.',
                inputSchema: {
                    type: 'object',
                    properties: { presentationId: { type: 'string', description: 'Google Slides presentation ID' } },
                    required: ['presentationId'],
                },
            },
            // ── COURSES ──────────────────────────────────────────────────────────
            {
                name: 'classroom_list_courses',
                description: 'List all Google Classroom courses. Supports filtering by state (ACTIVE, ARCHIVED, PROVISIONED).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseStates: { type: 'array', items: { type: 'string' }, description: 'ACTIVE, ARCHIVED, PROVISIONED' },
                        pageSize: { type: 'number', default: 50 },
                        pageToken: { type: 'string' },
                        fullData: { type: 'boolean', default: false, description: 'If true, return all fields (may be very large)' },
                    },
                },
            },
            {
                name: 'classroom_search_courses',
                description: 'Search courses by name or section (client-side filter, case-insensitive).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'String to search for in course name or section' },
                    },
                    required: ['query'],
                },
            },
            {
                name: 'classroom_get_course',
                description: 'Get full details of a specific course by ID.',
                inputSchema: {
                    type: 'object',
                    properties: { courseId: { type: 'string' } },
                    required: ['courseId'],
                },
            },
            {
                name: 'classroom_get_overview',
                description: 'One-call planning summary across the courses the teacher teaches: unpublished drafts (count plus up to 20 per course), posts scheduled for later and assignments due in the coming days. Use it for questions like "what do I have pending this week?" instead of listing each course.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        daysAhead: { type: 'integer', minimum: 1, maximum: 60, default: 14, description: 'How far ahead to look for due dates' },
                        courseIds: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 30, description: 'Limit to these courses (default: every active course the teacher teaches, up to 30)' },
                    },
                },
            },
            {
                name: 'classroom_update_course',
                description: 'Update course fields (name, section, description, room, state). State can be ACTIVE or ARCHIVED.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        name: { type: 'string' },
                        section: { type: 'string' },
                        description: { type: 'string' },
                        room: { type: 'string' },
                        state: { type: 'string', enum: ['ACTIVE', 'ARCHIVED', 'PROVISIONED', 'DECLINED'] },
                    },
                    required: ['courseId'],
                },
            },
            // ── COURSEWORK (ASSIGNMENTS / QUESTIONS) ─────────────────────────────
            {
                name: 'classroom_get_assignment',
                description: 'Get full details of a specific assignment by ID.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        id: { type: 'string', description: 'Assignment (courseWork) ID' },
                    },
                    required: ['courseId', 'id'],
                },
            },
            {
                name: 'classroom_list_assignments',
                description: 'List coursework (assignments/questions) for a course. Supports filtering by state.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        courseWorkStates: { type: 'array', items: { type: 'string' }, description: 'PUBLISHED, DRAFT, DELETED' },
                        pageSize: { type: 'number', default: 50 },
                        pageToken: { type: 'string' },
                    },
                    required: ['courseId'],
                },
            },
            {
                name: 'classroom_create_assignment',
                description: 'Create an assignment, a short-answer question or a multiple-choice question (one question with choices) with optional attachments, due date, and topic.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        title: { type: 'string' },
                        description: { type: 'string' },
                        workType: { type: 'string', enum: ['ASSIGNMENT', 'SHORT_ANSWER_QUESTION', 'MULTIPLE_CHOICE_QUESTION'], default: 'ASSIGNMENT' },
                        choices: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 2, maxItems: 20, description: 'Answer options; required for MULTIPLE_CHOICE_QUESTION only' },
                        state: { type: 'string', enum: ['PUBLISHED', 'DRAFT'], default: 'DRAFT' },
                        scheduledTime: { type: 'string', description: 'RFC 3339 timestamp for scheduled publication' },
                        maxPoints: { type: 'number' },
                        dueDate: { type: 'string', description: 'YYYY-MM-DD in the local time zone of this computer' },
                        dueTime: { type: 'string', description: 'HH:MM in local time (defaults to 23:59 if dueDate is set); converted to UTC automatically' },
                        topicId: { type: 'string' },
                        attachments: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    type: { type: 'string', enum: ['driveFile', 'link', 'youtubeVideo', 'form'] },
                                    idOrUrl: { type: 'string' },
                                    shareMode: { type: 'string', enum: ['VIEW', 'EDIT', 'STUDENT_COPY'], description: 'Only for driveFile: VIEW (read-only, default), EDIT (one shared editable file) or STUDENT_COPY (each student gets a copy).' },
                                },
                            },
                        },
                    },
                    required: ['courseId', 'title'],
                },
            },
            {
                name: 'classroom_patch_assignment',
                description: 'Update specific fields of an existing assignment using updateMask.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        id: { type: 'string', description: 'Assignment ID' },
                        updateMask: { type: 'string', description: 'Comma-separated fields: title,description,dueDate,dueTime,maxPoints,topicId,state' },
                        title: { type: 'string' },
                        description: { type: 'string' },
                        maxPoints: { type: 'number' },
                        topicId: { type: 'string' },
                        dueDate: { type: 'string', description: 'YYYY-MM-DD in the local time zone of this computer' },
                        dueTime: { type: 'string', description: 'HH:MM in local time; requires dueDate' },
                        scheduledTime: { type: 'string', description: 'RFC 3339 timestamp for scheduled publication' },
                        state: { type: 'string', enum: ['PUBLISHED', 'DRAFT'] },
                    },
                    required: ['courseId', 'id', 'updateMask'],
                },
            },
            {
                name: 'classroom_copy_post',
                description: 'Copy an assignment or a material to other courses (for example the same unit for several groups). Copies are always created as DRAFT with the same title, instructions, points and attachments; the topic is matched by name and created if missing. Copies made here stay editable by this app.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sourceCourseId: { type: 'string' },
                        id: { type: 'string', description: 'ID of the assignment or material to copy' },
                        kind: { type: 'string', enum: ['assignment', 'material'] },
                        targetCourseIds: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 10 },
                        keepTopic: { type: 'boolean', default: true, description: 'Place each copy under a topic with the same name' },
                        dueDate: { type: 'string', description: 'YYYY-MM-DD for the copies (assignments). Default: the original due date if it is still in the future, otherwise none.' },
                        dueTime: { type: 'string', description: 'HH:MM in local time; requires dueDate' },
                    },
                    required: ['sourceCourseId', 'id', 'kind', 'targetCourseIds'],
                },
            },
            // ── TOPICS ────────────────────────────────────────────────────────────
            {
                name: 'classroom_get_topic',
                description: 'Get details of a specific topic by ID.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        id: { type: 'string', description: 'Topic ID' },
                    },
                    required: ['courseId', 'id'],
                },
            },
            {
                name: 'classroom_list_topics',
                description: 'List all topics in a course.',
                inputSchema: {
                    type: 'object',
                    properties: { courseId: { type: 'string' } },
                    required: ['courseId'],
                },
            },
            {
                name: 'classroom_create_topic',
                description: 'Create a new topic/unit in a course.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        name: { type: 'string' },
                    },
                    required: ['courseId', 'name'],
                },
            },
            {
                name: 'classroom_patch_topic',
                description: 'Rename or update a topic.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        id: { type: 'string', description: 'Topic ID' },
                        name: { type: 'string' },
                    },
                    required: ['courseId', 'id', 'name'],
                },
            },
            // ── MATERIALS ─────────────────────────────────────────────────────────
            {
                name: 'classroom_get_material',
                description: 'Get full details of a specific course material by ID.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        id: { type: 'string', description: 'Material ID' },
                    },
                    required: ['courseId', 'id'],
                },
            },
            {
                name: 'classroom_list_materials',
                description: 'List all non-graded materials for a course.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        pageSize: { type: 'number', default: 50 },
                        courseWorkMaterialStates: { type: 'array', items: { type: 'string' }, description: 'PUBLISHED oder DRAFT' },
                    },
                    required: ['courseId'],
                },
            },
            {
                name: 'classroom_create_material',
                description: 'Create a study material post with optional attachments and topic.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        state: { type: 'string', enum: ['PUBLISHED', 'DRAFT'], default: 'DRAFT' },
                        title: { type: 'string' },
                        description: { type: 'string' },
                        topicId: { type: 'string' },
                        scheduledTime: { type: 'string', description: 'RFC 3339 timestamp for scheduled publication' },
                        attachments: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    type: { type: 'string', enum: ['driveFile', 'link', 'youtubeVideo', 'form'] },
                                    idOrUrl: { type: 'string' },
                                    shareMode: { type: 'string', enum: ['VIEW', 'EDIT'], description: 'Only for driveFile: VIEW (read-only, default) or EDIT (shared editable file).' },
                                },
                            },
                        },
                    },
                    required: ['courseId', 'title'],
                },
            },
            {
                name: 'classroom_patch_material',
                description: 'Update fields of an existing material post.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        id: { type: 'string' },
                        updateMask: { type: 'string', description: 'Comma-separated: title,description,state,topicId' },
                        title: { type: 'string' },
                        description: { type: 'string' },
                        topicId: { type: 'string' },
                        scheduledTime: { type: 'string', description: 'RFC 3339 timestamp for scheduled publication' },
                        state: { type: 'string', enum: ['PUBLISHED', 'DRAFT'] },
                    },
                    required: ['courseId', 'id', 'updateMask'],
                },
            },
            // ── ANNOUNCEMENTS ─────────────────────────────────────────────────────
            {
                name: 'classroom_list_announcements',
                description: 'List announcements for a course.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        announcementStates: { type: 'array', items: { type: 'string', enum: ['PUBLISHED', 'DRAFT', 'DELETED'] } },
                        pageSize: { type: 'number', default: 50 },
                    },
                    required: ['courseId'],
                },
            },
            {
                name: 'classroom_post_announcement',
                description: 'Post an announcement to the course stream.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        text: { type: 'string' },
                        state: { type: 'string', enum: ['PUBLISHED', 'DRAFT'], default: 'DRAFT' },
                        scheduledTime: { type: 'string', description: 'RFC 3339 timestamp for scheduled publication' },
                    },
                    required: ['courseId', 'text'],
                },
            },
            {
                name: 'classroom_patch_announcement',
                description: 'Edit an existing announcement.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        courseId: { type: 'string' },
                        id: { type: 'string' },
                        text: { type: 'string' },
                        state: { type: 'string', enum: ['PUBLISHED', 'DRAFT'] },
                        scheduledTime: { type: 'string' },
                        updateMask: { type: 'string' },
                    },
                    required: ['courseId', 'id', 'updateMask'],
                },
            },
            // ── DRIVE & ATTACHMENTS ───────────────────────────────────────────────
            {
                name: 'drive_search_files',
                description: 'Find files in the teacher\'s Google Drive (including shared drives) by words in the name, by type or inside a folder, newest first. Use the returned id as a driveFile attachment.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', maxLength: 200, description: 'Words that appear in the file name, e.g. "práctica 05"' },
                        type: { type: 'string', enum: ['any', 'document', 'spreadsheet', 'presentation', 'form', 'pdf', 'image', 'video', 'folder'], default: 'any' },
                        folderId: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', description: 'Only files directly inside this Drive folder' },
                    },
                },
            },
            {
                name: 'drive_upload_file',
                description: 'Upload a file to Google Drive and return its Drive ID and URL, ready to attach. Prefer localPath for a file on the teacher\'s computer (Downloads, Documents, Desktop or a cloud-drive folder; up to 100 MB). base64Content is for small generated files (up to 5 MiB).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        localPath: { type: 'string', maxLength: 1024, description: 'Absolute path (or ~/...) of a file on this computer' },
                        name: { type: 'string', description: 'File name in Drive (default: the local file name)' },
                        mimeType: { type: 'string', maxLength: 127, pattern: '^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$', description: 'Default: detected from the file extension' },
                        base64Content: { type: 'string', maxLength: 6990508, pattern: '^[A-Za-z0-9+/=]+$' },
                        convertToGoogleFormat: { type: 'boolean', default: false, description: 'Convert Word/Excel/PowerPoint/OpenDocument/CSV files to Google Docs/Sheets/Slides so students can edit them online' },
                        folderId: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', description: 'Drive folder to upload into (default: My Drive)' },
                    },
                },
            },
        ];
        for (const tool of tools) {
            const properties = tool.inputSchema.properties;
            tool.inputSchema.additionalProperties = false;
            tool.annotations = { readOnlyHint: /_(list|get|search)_|_status$/.test(tool.name), openWorldHint: true };
            if (tool.name.includes('_list_') || ['classroom_search_courses', 'drive_search_files'].includes(tool.name)) {
                properties.pageToken = { type: 'string', minLength: 1 };
                properties.pageSize = { type: 'integer', minimum: 1, maximum: 100, default: 50 };
                properties.fullData = { type: 'boolean', default: false };
                tool.description += ' Returns one page as {items, nextPageToken}; continue until nextPageToken is null.';
            }
            for (const [name, property] of Object.entries(properties)) {
                if (property.type === 'string' && !['description', 'section', 'room', 'topicId', 'query'].includes(name))
                    property.minLength = 1;
                if (name === 'scheduledTime') {
                    property.format = 'date-time';
                    if (tool.name.startsWith('classroom_patch_')) {
                        property.type = ['string', 'null'];
                        property.description = 'RFC 3339 timestamp, or null to cancel scheduled publication.';
                    }
                }
                if (name === 'dueDate')
                    property.format = 'date';
                if (name === 'dueTime')
                    property.pattern = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
                if (name === 'maxPoints')
                    property.minimum = 0;
                if (name.endsWith('States'))
                    property.items.enum = name === 'courseStates'
                        ? ['ACTIVE', 'ARCHIVED', 'PROVISIONED', 'DECLINED', 'SUSPENDED'] : ['PUBLISHED', 'DRAFT', 'DELETED'];
                if (name === 'attachments') {
                    property.maxItems = 20;
                    property.items.required = ['type', 'idOrUrl'];
                    property.items.additionalProperties = false;
                    property.items.properties.idOrUrl.minLength = 1;
                }
            }
            if (properties.updateMask) {
                const fields = Object.keys(properties).filter(key => !['courseId', 'id', 'updateMask'].includes(key));
                properties.updateMask.pattern = `^(${fields.join('|')})(,(${fields.join('|')}))*$`;
                properties.updateMask.description = `Comma-separated supplied fields: ${fields.join(',')}`;
            }
        }
        return tools;
    }
    // ─── TOOL DISPATCH ────────────────────────────────────────────────────────
    async handleToolCall(classroom, drive, slides, name, args) {
        const ok = (data) => ({
            content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        });
        switch (name) {
            case 'slides_get_presentation': {
                const r = await slides.presentations.get({ presentationId: args.presentationId });
                return ok(r.data);
            }
            // ── COURSES ────────────────────────────────────────────────────────
            case 'classroom_list_courses': {
                const r = await classroom.courses.list({
                    courseStates: args.courseStates,
                    pageSize: args.pageSize ?? 50,
                    pageToken: args.pageToken,
                    fields: args.fullData
                        ? undefined
                        : 'courses(id,name,section,courseState,enrollmentCode,alternateLink,ownerId,updateTime),nextPageToken',
                });
                return ok({ items: r.data.courses ?? [], nextPageToken: r.data.nextPageToken ?? null });
            }
            case 'classroom_search_courses': {
                const r = await classroom.courses.list({ pageSize: args.pageSize ?? 50, pageToken: args.pageToken, fields: args.fullData ? undefined : 'courses(id,name,section,courseState),nextPageToken' });
                const q = args.query.toLowerCase();
                const filtered = (r.data.courses ?? []).filter(c => c.name?.toLowerCase().includes(q) ||
                    c.section?.toLowerCase().includes(q));
                return ok({ items: filtered, nextPageToken: r.data.nextPageToken ?? null });
            }
            case 'classroom_get_course': {
                const r = await classroom.courses.get({ id: args.courseId });
                return ok(r.data);
            }
            case 'classroom_update_course': {
                const body = {};
                const maskFields = [];
                if (args.name !== undefined) {
                    body.name = args.name;
                    maskFields.push('name');
                }
                if (args.section !== undefined) {
                    body.section = args.section;
                    maskFields.push('section');
                }
                if (args.description !== undefined) {
                    body.descriptionHeading = args.description;
                    maskFields.push('descriptionHeading');
                }
                if (args.room !== undefined) {
                    body.room = args.room;
                    maskFields.push('room');
                }
                if (args.state !== undefined) {
                    body.courseState = args.state;
                    maskFields.push('courseState');
                }
                const r = await classroom.courses.patch({
                    id: args.courseId,
                    updateMask: maskFields.join(','),
                    requestBody: body,
                });
                return ok(r.data);
            }
            // ── COURSEWORK ─────────────────────────────────────────────────────
            case 'classroom_get_assignment': {
                const r = await classroom.courses.courseWork.get({
                    courseId: args.courseId,
                    id: args.id,
                });
                return ok(r.data);
            }
            case 'classroom_list_assignments': {
                const r = await classroom.courses.courseWork.list({
                    courseId: args.courseId,
                    courseWorkStates: args.courseWorkStates ?? ['PUBLISHED', 'DRAFT'],
                    pageSize: args.pageSize ?? 50,
                    pageToken: args.pageToken,
                    fields: args.fullData
                        ? undefined
                        : 'courseWork(id,title,workType,state,maxPoints,dueDate,dueTime,scheduledTime,topicId,creationTime,updateTime),nextPageToken',
                });
                return ok({ items: r.data.courseWork ?? [], nextPageToken: r.data.nextPageToken ?? null });
            }
            case 'classroom_create_assignment': {
                const body = {
                    title: args.title,
                    description: args.description,
                    workType: args.workType ?? 'ASSIGNMENT',
                    state: args.scheduledTime ? 'DRAFT' : (args.state ?? 'DRAFT'),
                    scheduledTime: args.scheduledTime,
                    maxPoints: args.maxPoints,
                    topicId: args.topicId,
                    ...(args.choices ? { multipleChoiceQuestion: { choices: args.choices } } : {}),
                    ...this.parseDueDateTime(args.dueDate, args.dueTime),
                };
                if (args.attachments?.length) {
                    body.materials = this.mapAttachments(args.attachments);
                }
                const r = await classroom.courses.courseWork.create({
                    courseId: args.courseId,
                    requestBody: body,
                });
                return ok(r.data);
            }
            case 'classroom_patch_assignment': {
                const body = {};
                if (args.title !== undefined)
                    body.title = args.title;
                if (args.description !== undefined)
                    body.description = args.description;
                if (args.maxPoints !== undefined)
                    body.maxPoints = args.maxPoints;
                if (args.topicId !== undefined)
                    body.topicId = args.topicId;
                if (args.state !== undefined)
                    body.state = args.state;
                if (args.scheduledTime != null)
                    body.scheduledTime = args.scheduledTime;
                if (args.dueDate) {
                    Object.assign(body, this.parseDueDateTime(args.dueDate, args.dueTime));
                }
                const r = await classroom.courses.courseWork.patch({
                    courseId: args.courseId,
                    id: args.id,
                    updateMask: args.updateMask,
                    requestBody: body,
                });
                return ok(r.data);
            }
            case 'classroom_copy_post': {
                const assignment = args.kind === 'assignment';
                const source = assignment
                    ? (await classroom.courses.courseWork.get({ courseId: args.sourceCourseId, id: args.id })).data
                    : (await classroom.courses.courseWorkMaterials.get({ courseId: args.sourceCourseId, id: args.id })).data;
                // Keep only what identifies each attachment; titles and thumbnails are output-only.
                const materials = (source.materials ?? []).map((m) => m.driveFile ? { driveFile: { driveFile: { id: m.driveFile.driveFile?.id }, ...(m.driveFile.shareMode ? { shareMode: m.driveFile.shareMode } : {}) } }
                    : m.youtubeVideo ? { youtubeVideo: { id: m.youtubeVideo.id } }
                        : m.link ? { link: { url: m.link.url } }
                            : m.form ? { form: { formUrl: m.form.formUrl } } : null).filter(Boolean);
                const topicName = args.keepTopic !== false && source.topicId
                    ? (await classroom.courses.topics.get({ courseId: args.sourceCourseId, id: source.topicId })).data.name ?? undefined
                    : undefined;
                let due = {};
                let dueDateDropped = false;
                if (assignment && args.dueDate) {
                    due = this.parseDueDateTime(args.dueDate, args.dueTime);
                }
                else if (assignment && source.dueDate) {
                    const { year, month, day } = source.dueDate;
                    const original = Date.UTC(year, month - 1, day, source.dueTime?.hours ?? 23, source.dueTime?.minutes ?? 59);
                    if (original > Date.now())
                        due = { dueDate: source.dueDate, dueTime: source.dueTime ?? { hours: 23, minutes: 59 } };
                    else
                        dueDateDropped = true;
                }
                const copies = [];
                for (const courseId of args.targetCourseIds) {
                    try {
                        let topicId;
                        if (topicName) {
                            const topics = (await classroom.courses.topics.list({ courseId, pageSize: 100 })).data.topic ?? [];
                            const same = topics.find(topic => topic.name?.trim().toLowerCase() === topicName.trim().toLowerCase());
                            topicId = same?.topicId ?? (await classroom.courses.topics.create({ courseId, requestBody: { name: topicName } })).data.topicId ?? undefined;
                        }
                        const requestBody = {
                            title: source.title, description: source.description, topicId, state: 'DRAFT',
                            ...(materials.length ? { materials } : {}),
                            ...(assignment ? {
                                workType: source.workType, maxPoints: source.maxPoints, ...due,
                                ...(source.multipleChoiceQuestion ? { multipleChoiceQuestion: { choices: source.multipleChoiceQuestion.choices } } : {}),
                            } : {}),
                        };
                        const created = assignment
                            ? (await classroom.courses.courseWork.create({ courseId, requestBody })).data
                            : (await classroom.courses.courseWorkMaterials.create({ courseId, requestBody })).data;
                        copies.push({ courseId, id: created.id, state: created.state ?? 'DRAFT', topic: topicName ?? null, alternateLink: created.alternateLink ?? null });
                    }
                    catch (error) {
                        copies.push({ courseId, error: this.googleReason(error) });
                    }
                }
                return ok({
                    title: source.title, kind: args.kind, copies,
                    ...(dueDateDropped ? { note: 'The original due date has passed, so the copies have no due date. Set one with classroom_patch_assignment.' } : {}),
                });
            }
            case 'classroom_get_overview': {
                const days = args.daysAhead ?? 14;
                const now = Date.now();
                const until = now + days * 24 * 60 * 60 * 1000;
                const local = (time) => {
                    const d = new Date(time);
                    const two = (n) => String(n).padStart(2, '0');
                    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
                };
                let courses;
                let moreCourses = false;
                if (args.courseIds) {
                    courses = args.courseIds.map(id => ({ id }));
                }
                else {
                    const r = await classroom.courses.list({ teacherId: 'me', courseStates: ['ACTIVE'], pageSize: 30, fields: 'courses(id,name,section),nextPageToken' });
                    courses = (r.data.courses ?? []).map(c => ({ id: c.id, name: c.name, section: c.section }));
                    moreCourses = Boolean(r.data.nextPageToken);
                }
                const summarize = async (course) => {
                    try {
                        const [work, materials, announcements] = await Promise.all([
                            classroom.courses.courseWork.list({ courseId: course.id, courseWorkStates: ['PUBLISHED', 'DRAFT'], pageSize: 100, fields: 'courseWork(id,title,state,dueDate,dueTime,scheduledTime)' }),
                            classroom.courses.courseWorkMaterials.list({ courseId: course.id, courseWorkMaterialStates: ['DRAFT'], pageSize: 100, fields: 'courseWorkMaterial(id,title,scheduledTime)' }),
                            classroom.courses.announcements.list({ courseId: course.id, announcementStates: ['DRAFT'], pageSize: 100, fields: 'announcements(id,text,scheduledTime)' }),
                        ]);
                        const pending = [
                            ...(work.data.courseWork ?? []).filter(w => w.state === 'DRAFT').map(w => ({ kind: 'assignment', id: w.id, title: w.title, scheduledTime: w.scheduledTime })),
                            ...(materials.data.courseWorkMaterial ?? []).map(m => ({ kind: 'material', id: m.id, title: m.title, scheduledTime: m.scheduledTime })),
                            ...(announcements.data.announcements ?? []).map(a => ({ kind: 'announcement', id: a.id, title: (a.text ?? '').slice(0, 80), scheduledTime: a.scheduledTime })),
                        ];
                        const dueSoon = (work.data.courseWork ?? []).flatMap(w => {
                            if (w.state !== 'PUBLISHED' || !w.dueDate?.year)
                                return [];
                            const time = Date.UTC(w.dueDate.year, (w.dueDate.month ?? 1) - 1, w.dueDate.day ?? 1, w.dueTime?.hours ?? 23, w.dueTime?.minutes ?? 59);
                            return time >= now && time <= until ? [{ id: w.id, title: w.title, due: local(time), time }] : [];
                        }).sort((a, b) => a.time - b.time).map(({ time, ...rest }) => rest);
                        return {
                            courseId: course.id, name: course.name ?? undefined, section: course.section ?? undefined,
                            draftCount: pending.filter(p => !p.scheduledTime).length,
                            // The newest drafts are enough to plan with; a long backlog would flood the answer.
                            drafts: pending.filter(p => !p.scheduledTime).slice(0, 20).map(({ scheduledTime, ...rest }) => rest),
                            scheduled: pending.filter(p => p.scheduledTime).map(({ scheduledTime, ...rest }) => ({ ...rest, publishesAt: local(Date.parse(scheduledTime)) })),
                            dueSoon,
                        };
                    }
                    catch (error) {
                        return { courseId: course.id, name: course.name ?? undefined, error: this.googleReason(error) };
                    }
                };
                const summaries = [];
                for (let i = 0; i < courses.length; i += 5)
                    summaries.push(...await Promise.all(courses.slice(i, i + 5).map(summarize)));
                return ok({
                    timesAre: 'local time of this computer', from: local(now), to: local(until), courses: summaries,
                    ...(moreCourses ? { note: 'Only the first 30 active courses are included; pass courseIds for others.' } : {}),
                });
            }
            // ── TOPICS ─────────────────────────────────────────────────────────
            case 'classroom_get_topic': {
                const r = await classroom.courses.topics.get({
                    courseId: args.courseId,
                    id: args.id,
                });
                return ok(r.data);
            }
            case 'classroom_list_topics': {
                const r = await classroom.courses.topics.list({ courseId: args.courseId, pageToken: args.pageToken, pageSize: args.pageSize ?? 50 });
                return ok({ items: r.data.topic ?? [], nextPageToken: r.data.nextPageToken ?? null });
            }
            case 'classroom_create_topic': {
                const r = await classroom.courses.topics.create({
                    courseId: args.courseId,
                    requestBody: { name: args.name },
                });
                return ok(r.data);
            }
            case 'classroom_patch_topic': {
                const r = await classroom.courses.topics.patch({
                    courseId: args.courseId,
                    id: args.id,
                    updateMask: 'name',
                    requestBody: { name: args.name },
                });
                return ok(r.data);
            }
            // ── MATERIALS ──────────────────────────────────────────────────────
            case 'classroom_get_material': {
                const r = await classroom.courses.courseWorkMaterials.get({
                    courseId: args.courseId,
                    id: args.id,
                });
                return ok(r.data);
            }
            case 'classroom_list_materials': {
                const r = await classroom.courses.courseWorkMaterials.list({
                    courseId: args.courseId,
                    courseWorkMaterialStates: args.courseWorkMaterialStates ?? ['PUBLISHED', 'DRAFT'],
                    pageToken: args.pageToken,
                    pageSize: args.pageSize ?? 50,
                    fields: args.fullData
                        ? undefined
                        : 'courseWorkMaterial(id,title,description,topicId,state,scheduledTime,creationTime,updateTime),nextPageToken',
                });
                return ok({ items: r.data.courseWorkMaterial ?? [], nextPageToken: r.data.nextPageToken ?? null });
            }
            case 'classroom_create_material': {
                const body = {
                    title: args.title,
                    description: args.description,
                    topicId: args.topicId,
                    state: args.scheduledTime ? 'DRAFT' : (args.state ?? 'DRAFT'),
                    scheduledTime: args.scheduledTime,
                };
                if (args.attachments?.length) {
                    body.materials = this.mapAttachments(args.attachments);
                }
                const r = await classroom.courses.courseWorkMaterials.create({
                    courseId: args.courseId,
                    requestBody: body,
                });
                return ok(r.data);
            }
            case 'classroom_patch_material': {
                const body = {};
                if (args.title !== undefined)
                    body.title = args.title;
                if (args.description !== undefined)
                    body.description = args.description;
                if (args.topicId !== undefined)
                    body.topicId = args.topicId;
                if (args.state !== undefined)
                    body.state = args.state;
                if (args.scheduledTime != null)
                    body.scheduledTime = args.scheduledTime;
                const r = await classroom.courses.courseWorkMaterials.patch({
                    courseId: args.courseId,
                    id: args.id,
                    updateMask: args.updateMask,
                    requestBody: body,
                });
                return ok(r.data);
            }
            // ── ANNOUNCEMENTS ──────────────────────────────────────────────────
            case 'classroom_list_announcements': {
                const r = await classroom.courses.announcements.list({
                    courseId: args.courseId,
                    pageToken: args.pageToken,
                    announcementStates: args.announcementStates ?? ['PUBLISHED', 'DRAFT'],
                    pageSize: args.pageSize ?? 50,
                    fields: args.fullData
                        ? undefined
                        : 'announcements(id,text,state,scheduledTime,creationTime,updateTime),nextPageToken',
                });
                return ok({ items: r.data.announcements ?? [], nextPageToken: r.data.nextPageToken ?? null });
            }
            case 'classroom_post_announcement': {
                const r = await classroom.courses.announcements.create({
                    courseId: args.courseId,
                    requestBody: {
                        text: args.text,
                        state: args.scheduledTime ? 'DRAFT' : (args.state ?? 'DRAFT'),
                        scheduledTime: args.scheduledTime,
                    },
                });
                return ok(r.data);
            }
            case 'classroom_patch_announcement': {
                const r = await classroom.courses.announcements.patch({
                    courseId: args.courseId,
                    id: args.id,
                    updateMask: args.updateMask,
                    requestBody: { text: args.text, state: args.state, scheduledTime: args.scheduledTime ?? undefined },
                });
                return ok(r.data);
            }
            // ── DRIVE & ATTACHMENTS ────────────────────────────────────────────
            case 'drive_search_files': {
                const quote = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
                const google = (kind) => `mimeType = 'application/vnd.google-apps.${kind}'`;
                const byType = {
                    document: google('document'), spreadsheet: google('spreadsheet'), presentation: google('presentation'),
                    form: google('form'), folder: google('folder'), pdf: "mimeType = 'application/pdf'",
                    image: "mimeType contains 'image/'", video: "mimeType contains 'video/'",
                };
                const conditions = ['trashed = false'];
                for (const word of String(args.query ?? '').split(/\s+/).filter(Boolean))
                    conditions.push(`name contains ${quote(word)}`);
                if (args.type && args.type !== 'any')
                    conditions.push(byType[args.type]);
                if (args.folderId)
                    conditions.push(`${quote(args.folderId)} in parents`);
                const r = await drive.files.list({
                    q: conditions.join(' and '),
                    orderBy: 'modifiedTime desc',
                    pageSize: args.pageSize ?? 50,
                    pageToken: args.pageToken,
                    supportsAllDrives: true,
                    includeItemsFromAllDrives: true,
                    fields: args.fullData ? 'files,nextPageToken' : 'files(id,name,mimeType,modifiedTime,webViewLink),nextPageToken',
                });
                return ok({ items: r.data.files ?? [], nextPageToken: r.data.nextPageToken ?? null });
            }
            case 'drive_upload_file': {
                const local = args.localPath ? resolveUpload(args.localPath) : undefined;
                const name = args.name ?? local.name;
                const mimeType = args.mimeType ?? local?.mimeType ?? 'application/octet-stream';
                const converted = args.convertToGoogleFormat ? googleFormatFor(local?.name ?? name) : null;
                const r = await drive.files.create({
                    requestBody: { name, mimeType: converted ?? mimeType, ...(args.folderId ? { parents: [args.folderId] } : {}) },
                    media: { mimeType, body: local ? fs.createReadStream(local.file) : Readable.from(Buffer.from(args.base64Content, 'base64')) },
                    supportsAllDrives: true,
                    fields: 'id,name,mimeType,webViewLink',
                });
                return ok({
                    ...r.data,
                    ...(args.convertToGoogleFormat && !converted ? { note: 'This file type has no Google Docs/Sheets/Slides equivalent, so it was uploaded unchanged.' } : {}),
                });
            }
            default:
                throw new Error(`Tool not implemented: ${name}`);
        }
    }
    async run(transport = new StdioServerTransport()) {
        await this.server.connect(transport);
        console.error('Google Classroom MCP ready.');
    }
}
// npm runs bins through a symlink (node_modules/.bin, npx), so compare real paths.
const realEntry = (file) => { try {
    return fs.realpathSync(file);
}
catch {
    return path.resolve(file);
} };
if (process.argv[1] && realEntry(process.argv[1]) === realEntry(__filename)) {
    if (process.argv.length > 2) {
        // setup / auth / doctor: the commands a person runs; Claude starts the server with none.
        import('./cli.js').then(async (cli) => { process.exitCode = await cli.main(process.argv.slice(2)); });
    }
    else {
        new GoogleClassroomServer().run().catch(() => {
            console.error('MCP startup failed.');
            process.exitCode = 1;
        });
    }
}
//# sourceMappingURL=index.js.map