export declare const MAX_LOCAL_UPLOAD: number;
/** Google Docs/Sheets/Slides type a file can be converted to on upload, if any. */
export declare function googleFormatFor(name: string): string | null;
/**
 * Folders a teacher keeps teaching files in. The assistant chooses the path, so
 * uploads are limited to these (and never to hidden files) instead of the whole disk.
 */
export declare function uploadRoots(): string[];
export interface LocalUpload {
    file: string;
    name: string;
    size: number;
    mimeType: string;
}
/** Validate a path supplied for upload. Throws an Error whose message is safe to show. */
export declare function resolveUpload(localPath: string): LocalUpload;
//# sourceMappingURL=upload.d.ts.map