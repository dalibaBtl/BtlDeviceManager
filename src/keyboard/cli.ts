/**
 * `btl-keyboard`: the command behind the Keyboard panel.
 *
 *     btl-keyboard list [--json]        layout of the connected keyboards and the stored choice
 *     btl-keyboard set <variant>        switch now and keep it (qwerty | basic)
 *
 * `set` writes `~/.config/sway/config.d/keyboard.conf` and applies the same
 * lines through `swaymsg`, so the change takes effect at once and survives a
 * restart of sway. Nothing here needs root: the file is the user's own sway
 * config.
 *
 * Exit codes: 0 success, 1 a system command failed, 2 usage error or unknown variant.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { KeyboardState } from '../shared/types.js';
import {
  KEYBOARD_LAYOUTS,
  activeLayouts,
  currentVariant,
  findLayout,
  parseKeyboardConf,
  parseKeyboards,
  renderKeyboardConf,
  swaymsgCommand,
} from './layout.js';

const TIMEOUT_MS = 10_000;

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 1 | 2,
  ) {
    super(message);
  }
}

/** `config.d/keyboard.conf`, next to the files written by `btl-displays` and `btl-vm`. */
export function keyboardConfPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config');
  return path.join(base, 'sway', 'config.d', 'keyboard.conf');
}

/** Entry point used by `cli/btl-keyboard.js`; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'list':
        await list(rest.includes('--json'));
        return 0;
      case 'set': {
        const [variant] = rest;
        if (!variant) throw new CliError(`missing variant\n${USAGE}`, 2);
        await set(variant);
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
    process.stderr.write(`btl-keyboard: ${err.message}\n`);
    return err.exitCode;
  }
}

const USAGE = `usage: btl-keyboard list [--json]
       btl-keyboard set <${KEYBOARD_LAYOUTS.map((l) => l.variant).join(' | ')}>
`;

async function list(json: boolean): Promise<void> {
  const state = await scan();
  if (json) {
    process.stdout.write(JSON.stringify(state) + '\n');
    return;
  }
  const now = state.active.length > 0 ? state.active.join(', ') : 'no keyboard connected';
  const saved = state.saved ? (findLayout(state.saved)?.label ?? state.saved) : 'not set';
  process.stdout.write(`active: ${now}\nstored: ${saved}\n`);
}

/** Writes the file first, so a failed `swaymsg` still leaves the choice for the next start. */
async function set(variant: string): Promise<void> {
  const layout = findLayout(variant);
  if (!layout) {
    throw new CliError(
      `unknown variant ${variant}; offered: ${KEYBOARD_LAYOUTS.map((l) => l.variant).join(', ')}`,
      2,
    );
  }
  const target = keyboardConfPath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, renderKeyboardConf(layout.variant), 'utf8');
  process.stdout.write(`wrote ${target}\n`);
  const cmd = swaymsgCommand(layout.variant);
  process.stdout.write(`+ swaymsg '${cmd}'\n`);
  const failed = (JSON.parse(await run('swaymsg', [cmd])) as { success: boolean; error?: string }[])
    .filter((r) => !r.success)
    .map((r) => r.error ?? 'swaymsg refused the command');
  if (failed.length > 0) throw new CliError(failed.join('; '), 1);
}

export async function scan(): Promise<KeyboardState> {
  const [devices, saved] = await Promise.all([
    run('swaymsg', ['-t', 'get_inputs']).then(parseKeyboards),
    readOrEmpty(keyboardConfPath()).then(parseKeyboardConf),
  ]);
  return {
    offered: KEYBOARD_LAYOUTS,
    current: currentVariant(devices),
    active: activeLayouts(devices),
    saved,
    scannedAt: Date.now(),
  };
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err)
          reject(new CliError(`${cmd} ${args.join(' ')}: ${stderr.trim() || err.message}`, 1));
        else resolve(stdout);
      },
    );
  });
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}
