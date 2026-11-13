#!/usr/bin/env node
// Kept for `npm run auth` / `npm run doctor` and the google-classroom-mcp-auth command.
import { main } from './dist/cli.js';

process.exitCode = await main([process.argv.includes('--check') ? 'doctor' : 'auth']);
