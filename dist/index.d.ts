#!/usr/bin/env node
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
export interface ServerOptions {
    /** How long classroom_connect waits for the teacher to finish in the browser before answering "still waiting". */
    signInWaitMs?: number;
    openBrowser?: (url: string) => void;
}
export declare class GoogleClassroomServer {
    private options;
    private server;
    private classroom?;
    private drive?;
    private slides?;
    constructor(options?: ServerOptions);
    private initApis;
    private resetApis;
    private report;
    private blocked;
    private status;
    private connect;
    private setupHandlers;
    private googleReason;
    private mapAttachments;
    private parseDueDateTime;
    private getTools;
    private handleToolCall;
    run(transport?: Transport): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map