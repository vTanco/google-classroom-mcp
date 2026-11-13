import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const MAX_LOCAL_UPLOAD = 100 * 1024 * 1024;
const MIME = {
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', rtf: 'application/rtf', html: 'text/html',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    zip: 'application/zip', epub: 'application/epub+zip', json: 'application/json', md: 'text/markdown',
};
const GOOGLE_FORMAT = {
    doc: 'document', docx: 'document', odt: 'document', rtf: 'document', txt: 'document', html: 'document',
    xls: 'spreadsheet', xlsx: 'spreadsheet', ods: 'spreadsheet', csv: 'spreadsheet',
    ppt: 'presentation', pptx: 'presentation', odp: 'presentation',
};
const extension = (name) => path.extname(name).slice(1).toLowerCase();
/** Google Docs/Sheets/Slides type a file can be converted to on upload, if any. */
export function googleFormatFor(name) {
    const kind = GOOGLE_FORMAT[extension(name)];
    return kind ? `application/vnd.google-apps.${kind}` : null;
}
/**
 * Folders a teacher keeps teaching files in. The assistant chooses the path, so
 * uploads are limited to these (and never to hidden files) instead of the whole disk.
 */
export function uploadRoots() {
    const custom = process.env.GOOGLE_CLASSROOM_UPLOAD_DIRS?.trim();
    const home = os.homedir();
    const folders = custom && !custom.includes('${') ? custom.split(path.delimiter)
        : ['Downloads', 'Descargas', 'Documents', 'Documentos', 'Desktop', 'Escritorio', 'OneDrive', path.join('Library', 'CloudStorage')]
            .map(name => path.join(home, name));
    const roots = [];
    for (const folder of folders) {
        try {
            roots.push(fs.realpathSync(folder));
        }
        catch { /* folder does not exist on this computer */ }
    }
    return roots;
}
/** Validate a path supplied for upload. Throws an Error whose message is safe to show. */
export function resolveUpload(localPath) {
    const expanded = localPath.startsWith('~') ? path.join(os.homedir(), localPath.slice(1)) : localPath;
    if (!path.isAbsolute(expanded))
        throw new Error('localPath must be an absolute path (or start with ~).');
    let file;
    try {
        file = fs.realpathSync(expanded);
    }
    catch {
        throw new Error('No file exists at localPath. Check the folder and the exact file name, including its extension.');
    }
    const root = uploadRoots().find(candidate => file.startsWith(candidate + path.sep));
    if (!root)
        throw new Error('For safety, files can only be uploaded from Downloads, Documents, Desktop or a cloud-drive folder. Ask the teacher to move the file to one of them.');
    if (path.relative(root, file).split(path.sep).some(part => part.startsWith('.')))
        throw new Error('Hidden files and folders cannot be uploaded.');
    const stat = fs.statSync(file);
    if (!stat.isFile())
        throw new Error('localPath is a folder; give the path of one file.');
    if (stat.size === 0)
        throw new Error('The file is empty.');
    if (stat.size > MAX_LOCAL_UPLOAD)
        throw new Error('The file is larger than 100 MB. Upload it to Drive in the browser and attach it by its Drive ID.');
    const name = path.basename(file);
    return { file, name, size: stat.size, mimeType: MIME[extension(name)] || 'application/octet-stream' };
}
//# sourceMappingURL=upload.js.map