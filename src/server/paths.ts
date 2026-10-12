import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Directory for disposable per-user data (browser profile, server log):
 * `$XDG_CACHE_HOME/btl-device-manager`. Linux only, like the rest of the app.
 */
export function cacheDir(): string {
  return path.join(
    process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'),
    'btl-device-manager',
  );
}

/** Where the `desktop` role in btl-infra links the CLI so that `sudo` finds it. */
export const SYSTEM_CLI_LINK = '/usr/local/bin/btl-printers';
/** Where the role links the launcher, so `btl-device-manager update` works from any shell. */
export const SYSTEM_APP_LINK = '/usr/local/bin/btl-device-manager';

/** Root of this clone, resolved from the built server bundle in `dist/`. */
export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

/** Absolute path of `cli/btl-printers.js` in this clone, resolved from the built server bundle. */
export function printersCliPath(): string {
  return path.join(repoRoot(), 'cli', 'btl-printers.js');
}

/** Absolute path of the launcher, `cli/btl-device-manager.js`. */
export function appCliPath(): string {
  return path.join(repoRoot(), 'cli', 'btl-device-manager.js');
}

/**
 * The command the terminal should type for the printers CLI. `sudo` resets
 * `PATH` to `secure_path`, so the CLI must be reachable from `/usr/local/bin`;
 * when that link points at this clone the short name is used, otherwise the
 * absolute script path (a development checkout that the role never provisioned).
 */
export function printersCommand(
  cliPath: string = printersCliPath(),
  resolveLink: (p: string) => string | null = realpathOrNull,
): string {
  return linkedCommand(SYSTEM_CLI_LINK, 'btl-printers', cliPath, resolveLink);
}

/** The same rule for the launcher: `btl-device-manager` when linked, else the script path. */
export function appCommand(
  cliPath: string = appCliPath(),
  resolveLink: (p: string) => string | null = realpathOrNull,
): string {
  return linkedCommand(SYSTEM_APP_LINK, 'btl-device-manager', cliPath, resolveLink);
}

function linkedCommand(
  link: string,
  name: string,
  cliPath: string,
  resolveLink: (p: string) => string | null,
): string {
  const target = resolveLink(link);
  return target !== null && target === resolveLink(cliPath) ? name : cliPath;
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Absolute path of `cli/btl-displays.js` in this clone. */
export function displaysCliPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'cli', 'btl-displays.js');
}

/** Absolute path of `cli/btl-vm.js` in this clone. */
export function vmCliPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'cli', 'btl-vm.js');
}

/** Absolute path of `cli/btl-status.js` in this clone. */
export function statusCliPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'cli', 'btl-status.js');
}

/** Where the server stores layout files for `btl-displays apply <file>`. */
export function layoutsDir(): string {
  return path.join(cacheDir(), 'layouts');
}
