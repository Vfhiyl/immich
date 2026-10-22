#!/usr/bin/env node
import { runExportTool } from 'src/utils/export-tool.js';

process.exitCode = await runExportTool(process.argv.slice(2), console);
