#!/usr/bin/env node
// `btl-printers`: see src/printers/cli.ts. This file only locates the built
// bundle next to it, so a symlink from /usr/local/bin works: Node resolves the
// main module's real path, and `../dist` is relative to this clone.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { main } = await import(path.join(here, '..', 'dist', 'printers-cli.js'));
process.exitCode = await main(process.argv.slice(2));
