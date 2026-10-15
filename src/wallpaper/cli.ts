/**
 * `btl-wallpaper`: the command behind the Wallpaper panel.
 *
 *     btl-wallpaper list [--json]                          background in use and the role's default
 *     btl-wallpaper set-color <#rrggbb>                    one colour on every output
 *     btl-wallpaper set-image <file> [fit] [#rrggbb]       a picture; the colour fills bars left by fit/center
 *     btl-wallpaper reset                                  back to what the main sway config sets
 *
 * `set-image` copies the picture under `$XDG_DATA_HOME/btl-device-manager/
 * wallpapers/`, named by its SHA-256, and points the config there by absolute
 * path: sway does not expand `~` in `output bg`, and a link into ~/Pictures
 * turns into a black screen and a start-up error once the original is moved.
 * Pictures no longer in use are removed from that directory.
 *
 * Every command writes `~/.config/sway/config.d/wallpaper.conf` and applies the
 * same line with `swaymsg`. Nothing here needs root: the file is the user's own.
 *
 * Exit codes: 0 success, 1 a system command failed, 2 usage error or unusable input.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { WallpaperSetting, WallpaperState } from '../shared/types.js';
import {
  MAX_IMAGE_BYTES,
  WALLPAPER_FITS,
  imageType,
  isColor,
  isFit,
  parseBackground,
  renderWallpaperConf,
  swaymsgCommand,
} from './config.js';

const TIMEOUT_MS = 10_000;
/** Used when neither the main config nor the user sets a background. */
const SWAY_DEFAULT: WallpaperSetting = { kind: 'color', color: '#000000' };
/** Names of the copies this CLI makes; nothing else in the directory is touched. */
const COPY_NAME = /^[0-9a-f]{64}\.(png|jpg)$/;

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 1 | 2,
  ) {
    super(message);
  }
}

function swayDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'sway');
}

/** `config.d/wallpaper.conf`, next to the files written by the other CLIs. */
export function wallpaperConfPath(): string {
  return path.join(swayDir(), 'config.d', 'wallpaper.conf');
}

/** Where copied pictures live; the config points here, never at the user's original. */
export function wallpapersDir(): string {
  const base = process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share');
  return path.join(base, 'btl-device-manager', 'wallpapers');
}

/** Entry point used by `cli/btl-wallpaper.js`; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'list':
        await list(rest.includes('--json'));
        return 0;
      case 'set-color': {
        const [color] = rest;
        if (!color || !isColor(color))
          throw new CliError(`expected a colour like #1d2330\n${USAGE}`, 2);
        await apply({ kind: 'color', color: color.toLowerCase() });
        return 0;
      }
      case 'set-image': {
        const [file, fit = 'fill', color] = rest;
        if (!file) throw new CliError(`missing image file\n${USAGE}`, 2);
        if (!isFit(fit))
          throw new CliError(`unknown fit ${fit}; offered: ${WALLPAPER_FITS.join(', ')}`, 2);
        if (color !== undefined && !isColor(color))
          throw new CliError(`expected a colour like #1d2330, got ${color}`, 2);
        const copy = await copyImage(file);
        await apply({ kind: 'image', path: copy, fit, color: color?.toLowerCase() ?? null });
        return 0;
      }
      case 'reset':
        await reset();
        return 0;
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
    process.stderr.write(`btl-wallpaper: ${err.message}\n`);
    return err.exitCode;
  }
}

const USAGE = `usage: btl-wallpaper list [--json]
       btl-wallpaper set-color <#rrggbb>
       btl-wallpaper set-image <file> [${WALLPAPER_FITS.join('|')}] [#rrggbb]
       btl-wallpaper reset
`;

async function list(json: boolean): Promise<void> {
  const state = await scan();
  if (json) {
    process.stdout.write(JSON.stringify(state) + '\n');
    return;
  }
  const describe = (s: WallpaperSetting | null) =>
    !s
      ? 'none'
      : s.kind === 'color'
        ? s.color
        : `${s.path} (${s.fit}${s.color ? `, ${s.color}` : ''})`;
  process.stdout.write(
    `wallpaper.conf: ${describe(state.current)}\nmain config:    ${describe(state.fallback)}\n`,
  );
  if (state.imageMissing) process.stdout.write('the picture is missing; sway shows its default\n');
}

export async function scan(): Promise<WallpaperState> {
  const [own, main] = await Promise.all([
    readOrEmpty(wallpaperConfPath()),
    readOrEmpty(path.join(swayDir(), 'config')),
  ]);
  const current = parseBackground(own);
  return {
    current,
    fallback: parseBackground(main),
    imageMissing: current?.kind === 'image' && !(await exists(current.path)),
    fits: WALLPAPER_FITS,
    scannedAt: Date.now(),
  };
}

/**
 * Copies a picture into {@link wallpapersDir} under its hash, after checking
 * it is a PNG or JPEG of sane size. Copying an existing copy is a no-op, so
 * changing only the fit of the current picture goes through here too.
 */
async function copyImage(file: string): Promise<string> {
  const src = path.resolve(file);
  let size: number;
  try {
    size = (await stat(src)).size;
  } catch {
    throw new CliError(`no such file: ${src}`, 2);
  }
  if (size > MAX_IMAGE_BYTES)
    throw new CliError(`${src} is larger than ${MAX_IMAGE_BYTES >> 20} MiB`, 2);
  const type = imageType(await readHead(src));
  if (!type) throw new CliError(`${src} is not a PNG or JPEG picture`, 2);
  const data = await readFile(src);
  const dest = path.join(
    wallpapersDir(),
    `${createHash('sha256').update(data).digest('hex')}.${type}`,
  );
  if (!(await exists(dest))) {
    await mkdir(wallpapersDir(), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    await writeFile(tmp, data);
    await rename(tmp, dest);
    process.stdout.write(`copied ${src} to ${dest}\n`);
  }
  return dest;
}

/** Writes the file first, so a failed `swaymsg` still leaves the choice for the next start. */
async function apply(setting: WallpaperSetting): Promise<void> {
  const target = wallpaperConfPath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, renderWallpaperConf(setting), 'utf8');
  process.stdout.write(`wrote ${target}\n`);
  await prune(setting.kind === 'image' ? setting.path : null);
  await swaymsg(setting);
}

/** Removes `wallpaper.conf` and shows what the main config sets, without reloading sway. */
async function reset(): Promise<void> {
  const target = wallpaperConfPath();
  await rm(target, { force: true });
  process.stdout.write(`removed ${target}\n`);
  await prune(null);
  const main = parseBackground(await readOrEmpty(path.join(swayDir(), 'config')));
  await swaymsg(main ?? SWAY_DEFAULT);
}

/** Deletes the copies this CLI made, except the one in use. */
async function prune(keep: string | null): Promise<void> {
  let names: string[];
  try {
    names = await readdir(wallpapersDir());
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(wallpapersDir(), name);
    if (COPY_NAME.test(name) && file !== keep) await rm(file, { force: true });
  }
}

async function swaymsg(setting: WallpaperSetting): Promise<void> {
  const cmd = swaymsgCommand(setting);
  process.stdout.write(`+ swaymsg '${cmd}'\n`);
  const failed = (JSON.parse(await run('swaymsg', [cmd])) as { success: boolean; error?: string }[])
    .filter((r) => !r.success)
    .map((r) => r.error ?? 'swaymsg refused the command');
  if (failed.length > 0) throw new CliError(failed.join('; '), 1);
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

async function readHead(file: string): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}
