#!/usr/bin/env node
import { runEncryptionTool } from 'src/utils/encryption-tool.js';

process.exitCode = await runEncryptionTool(process.argv.slice(2), console);
