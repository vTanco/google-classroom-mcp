import { auth as googleAuth } from '@googleapis/classroom';
import 'dotenv/config';
type OAuth2Client = InstanceType<typeof googleAuth.OAuth2>;
type Credentials = OAuth2Client['credentials'];
export declare const configDir: string;
export declare const credentialsPath: string;
export declare const tokenPath: string;
export declare const scopes: string[];
export declare function hasRequiredScopes(token: Credentials): boolean;
export declare function saveToken(token: Credentials, destination?: string): void;
export type CredentialsState = 'ok' | 'missing' | 'invalid' | 'not_desktop';
export declare function credentialsState(file?: string): CredentialsState;
/** Copy a downloaded client_secret file into the private config folder. */
export declare function importCredentials(source: string): void;
/** Newest valid "client_secret*.json" the browser left in Downloads or Desktop. */
export declare function findDownloadedCredentials(folders?: string[]): string | null;
/** Why nothing usable is in place: tells a wrong-type download apart from no download at all. */
export declare function missingCredentialsReason(folders?: string[]): Exclude<CredentialsState, 'ok'>;
/**
 * Bring credentials into place without the teacher moving files by hand:
 * the file chosen in the host's settings form wins, then (only when asked)
 * a client_secret file sitting in Downloads. Returns where they came from.
 */
export declare function ensureCredentials(options?: {
    searchDownloads?: boolean;
}): 'present' | 'settings' | 'downloads' | null;
export declare function createAuthClient(redirectUri?: string, endpoints?: Record<string, string>): OAuth2Client;
export declare function loadAuthClient(): OAuth2Client;
export declare function openBrowser(url: string): void;
export interface Login {
    url: string;
    done: Promise<void>;
}
export declare const loginInProgress: () => Login | undefined;
/**
 * Start Google sign-in in the browser. Resolves as soon as the link is ready;
 * `done` settles when the teacher finishes (or after `timeoutMs`). Only one
 * sign-in runs at a time: parallel consent windows make Google answer 500.
 */
export declare function startLogin(options?: {
    open?: (url: string) => void;
    timeoutMs?: number;
    endpoints?: Record<string, string>;
}): Promise<Login>;
export type Problem = 'credentials_missing' | 'credentials_invalid' | 'credentials_not_desktop' | 'not_signed_in' | 'scopes_missing' | 'sign_in_expired' | 'client_mismatch' | 'api_disabled' | 'access_denied' | 'file_permission' | 'offline';
/** Classify a failure from loading the OAuth files or from a Google API call. */
export declare function diagnose(error: any): Problem;
/** Read one course ID to prove the saved sign-in works. Changes nothing. */
export declare function verifyConnection(): Promise<void>;
/** `null` when Classroom answers; otherwise what stands in the way. */
export declare function connectionProblem(): Promise<Problem | null>;
export {};
//# sourceMappingURL=auth.d.ts.map