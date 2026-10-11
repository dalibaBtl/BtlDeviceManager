// Build script: bundles the server (Node ESM), the printers CLI (Node ESM) and
// the web front-end (browser) with esbuild. `node build.mjs --watch` rebuilds on change.
import { context, build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

/** Shared options for the Node-side bundles. */
const node = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
};

/** @type {import('esbuild').BuildOptions} */
const server = {
  ...node,
  entryPoints: ['src/server/main.ts'],
  outfile: 'dist/server.js',
  // node-pty ships a native addon and must stay a runtime dependency.
  external: ['node-pty'],
};

/** @type {import('esbuild').BuildOptions} */
const printersCli = {
  ...node,
  entryPoints: ['src/printers/cli.ts'],
  outfile: 'dist/printers-cli.js',
};

/** @type {import('esbuild').BuildOptions} */
const web = {
  entryPoints: ['src/web/main.tsx'],
  outfile: 'dist/web/main.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: !watch,
  sourcemap: true,
  logLevel: 'info',
};

await mkdir('dist/web', { recursive: true });
await cp('src/web/index.html', 'dist/web/index.html');

const all = [server, printersCli, web];
if (watch) {
  const contexts = await Promise.all(all.map(context));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(all.map(build));
}
