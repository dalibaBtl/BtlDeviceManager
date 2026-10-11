/**
 * `btl-displays`: the command behind the Displays panel.
 *
 *     btl-displays list [--json]        outputs as sway sees them
 *     btl-displays preview <layout>     print the outputs.conf a layout would produce
 *     btl-displays apply <layout>       write outputs.conf, validate the sway config, reload
 *     btl-displays config               print the current outputs.conf
 *     btl-displays move-workspace <name> <identifier>   move a workspace to an output now
 *
 * `<layout>` is a JSON file ({@link DisplayLayout}); the app writes one under
 * its cache directory and types `btl-displays apply <file>` into the terminal,
 * so the user sees the write, the validation and the reload, and can rerun it.
 * Nothing here needs root: the file is the user's own sway config.
 *
 * Exit codes: 0 success, 1 a system command failed, 2 usage error or invalid layout.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DisplayLayout, DisplayList, DisplayOutput } from '../shared/types.js';
import { renderConfig, validateLayout } from './config.js';
import { attachWorkspaces, describeMode, focusedWorkspace, parseOutputs } from './sway.js';

const TIMEOUT_MS = 10_000;

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 1 | 2,
  ) {
    super(message);
  }
}

/** Where sway's main config includes per-topic files; the role sets up the include. */
export function outputsConfPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config');
  return path.join(base, 'sway', 'config.d', 'outputs.conf');
}

function swayConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config');
  return path.join(base, 'sway', 'config');
}

/** Entry point used by `cli/btl-displays.js`; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'list':
        await list(rest.includes('--json'));
        return 0;
      case 'preview':
        process.stdout.write(renderConfig(await loadLayout(requireFile(rest), await outputs())));
        return 0;
      case 'apply':
        await apply(requireFile(rest));
        return 0;
      case 'config':
        process.stdout.write(await currentConfig());
        return 0;
      case 'move-workspace': {
        const [name, identifier] = rest;
        if (!name || !identifier)
          throw new CliError(`missing workspace name or output\n${USAGE}`, 2);
        await moveWorkspace(name, identifier, await outputs());
        return 0;
      }
      case undefined:
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        return command ? 0 : 2;
      default:
        throw new CliError(`unknown command: ${command}\n${USAGE}`, 2);
    }
  } catch (e) {
    const err =
      e instanceof CliError ? e : new CliError(e instanceof Error ? e.message : String(e), 1);
    process.stderr.write(`btl-displays: ${err.message}\n`);
    return err.exitCode;
  }
}

const USAGE = `usage: btl-displays list [--json]
       btl-displays preview <layout.json>
       btl-displays apply <layout.json>
       btl-displays config
       btl-displays move-workspace <name> <output identifier>
`;

function requireFile(rest: string[]): string {
  const f = rest.find((a) => !a.startsWith('-'));
  if (!f) throw new CliError(`missing layout file\n${USAGE}`, 2);
  if (!existsSync(f)) throw new CliError(`no such file: ${f}`, 2);
  return f;
}

// ---- commands ---------------------------------------------------------------

async function list(json: boolean): Promise<void> {
  const result = await scan();
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  for (const o of result.outputs) {
    const where = o.enabled
      ? `${o.width}x${o.height} at ${o.x},${o.y}  ${describeMode(o.mode)}  scale ${o.scale}  ${o.transform}`
      : 'disabled';
    const ws = o.workspaces.map((w) => (w.visible ? `[${w.name}]` : w.name)).join('  ');
    process.stdout.write(`${o.name.padEnd(10)} ${where}\n    ${o.identifier}\n`);
    if (ws) process.stdout.write(`    workspaces: ${ws}\n`);
  }
}

/**
 * Writes the file, then validates the whole sway config before reloading:
 * `swaymsg reload` reports success even when the config is broken (the error
 * only lands in sway's log), so the check has to happen first.
 */
async function apply(file: string): Promise<void> {
  const layout = await loadLayout(file, await outputs());
  const target = outputsConfPath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, renderConfig(layout), 'utf8');
  process.stdout.write(`wrote ${target}\n`);
  await run('sway', ['-C', '-c', swayConfigPath()]);
  process.stdout.write('+ swaymsg reload\n');
  await run('swaymsg', ['reload']);
  // `workspace … output …` only places workspaces when they are created or an
  // output appears; the ones open right now have to be moved explicitly.
  const after = await outputs();
  for (const e of layout.outputs) {
    const target = after.find((o) => o.identifier === e.identifier);
    if (!target?.enabled) continue;
    for (const w of e.workspaces) {
      if (
        !target.workspaces.some((x) => x.name === w) &&
        after.some((o) => o.workspaces.some((x) => x.name === w))
      ) {
        await moveWorkspace(w, e.identifier, after);
      }
    }
  }
}

/**
 * Moves one workspace now. sway moves only the focused workspace, so the
 * command focuses it first and returns to the previous one afterwards; when
 * the workspace is the focused one, a plain move will do.
 */
async function moveWorkspace(
  name: string,
  identifier: string,
  known: DisplayOutput[],
): Promise<void> {
  const target = known.find((o) => o.identifier === identifier || o.name === identifier);
  if (!target) throw new CliError(`unknown output ${identifier}`, 2);
  if (!target.enabled) throw new CliError(`${target.name} is disabled`, 2);
  if (!known.some((o) => o.workspaces.some((w) => w.name === name))) {
    throw new CliError(`no workspace called ${name}`, 2);
  }
  const move = `move workspace to output ${swayQuote(target.identifier)}`;
  const cmd =
    focusedWorkspace(known) === name
      ? move
      : `workspace ${swayQuote(name)}; ${move}; workspace back_and_forth`;
  process.stdout.write(`+ swaymsg '${cmd}'\n`);
  const out = await run('swaymsg', [cmd]);
  const failed = (JSON.parse(out) as { success: boolean; error?: string }[]).find(
    (r) => !r.success,
  );
  if (failed) throw new CliError(failed.error ?? 'swaymsg refused the command', 1);
}

/** Quotes a name for sway's command language; sway accepts double quotes with backslash escapes. */
function swayQuote(s: string): string {
  return `"${s.replace(/(["\\])/g, '\\$1')}"`;
}

async function currentConfig(): Promise<string> {
  try {
    return await readFile(outputsConfPath(), 'utf8');
  } catch {
    return '';
  }
}

async function loadLayout(file: string, known: DisplayOutput[]): Promise<DisplayLayout> {
  let layout: DisplayLayout;
  try {
    layout = JSON.parse(await readFile(file, 'utf8')) as DisplayLayout;
  } catch (e) {
    throw new CliError(`cannot read layout: ${e instanceof Error ? e.message : String(e)}`, 2);
  }
  const problems = validateLayout(layout, known);
  if (problems.length > 0) throw new CliError(`layout rejected:\n  ${problems.join('\n  ')}`, 2);
  return layout;
}

// ---- reading sway -----------------------------------------------------------

export async function scan(): Promise<DisplayList> {
  return { outputs: await outputs(), scannedAt: Date.now() };
}

async function outputs(): Promise<DisplayOutput[]> {
  const [o, w] = await Promise.all([
    run('swaymsg', ['-t', 'get_outputs']),
    run('swaymsg', ['-t', 'get_workspaces']),
  ]);
  return attachWorkspaces(parseOutputs(o), w);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (err)
          reject(new CliError(`${cmd} ${args.join(' ')}: ${stderr.trim() || err.message}`, 1));
        else resolve(stdout);
      },
    );
  });
}
