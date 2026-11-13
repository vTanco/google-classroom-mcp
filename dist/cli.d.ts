export declare const CONSOLE: {
    project: string;
    apis: string;
    consent: string;
    audience: string;
    client: string;
};
export interface LaunchSpec {
    command: string;
    args: string[];
    env?: Record<string, string>;
}
/** How Claude should start this server, given how the wizard itself was started. */
export declare function launchSpec(entry?: string): LaunchSpec;
/** Config files of the Claude Desktop installs found on this computer. */
export declare function claudeDesktopConfigs(home?: string): string[];
/** Add (or replace) the google-classroom entry, keeping every other setting and a backup. */
export declare function registerClaudeDesktop(file: string, spec: LaunchSpec): {
    backup: string | null;
};
export declare function main(argv: string[]): Promise<number>;
//# sourceMappingURL=cli.d.ts.map