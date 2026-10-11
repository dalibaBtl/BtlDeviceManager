// Registers BTL Manager with the desktop launcher of the current user as an
// XDG .desktop entry with absolute paths, so it works regardless of what PATH
// the launcher inherits. The launcher calls `ensureDesktopEntry()` on every
// start, so the first `npm start` is enough to make the app appear under
// Mod+D; `npm run install-desktop` does the same explicitly and `--remove`
// deletes the entry. (bgcm leaves this to the Ansible role; here the whole
// point is self-service, so the app registers itself.)
//
// The `btl-printers` CLI is not installed here: `sudo` only searches
// `secure_path`, which a user-level script cannot write to. The `desktop` role
// in btl-infra links it into /usr/local/bin; the explicit install just says so
// when the link is missing, and the app falls back to the absolute script path.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'cli', 'btl-manager.js');
const printersCli = path.resolve(here, '..', 'cli', 'btl-printers.js');
const name = 'BTL Manager';
const systemLink = '/usr/local/bin/btl-printers';

const dir = path.join(
  process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'),
  'applications',
);
const file = path.join(dir, 'btl-manager.desktop');

/** The entry's content for this clone and this Node binary. */
function entryText() {
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    'Comment=Printers, displays, virtual machine and status of this workstation',
    `Exec=${quote(process.execPath)} ${quote(cli)}`,
    `Path=${path.dirname(cli)}`,
    'Icon=preferences-system',
    'Terminal=false',
    'Categories=System;Settings;',
    'StartupWMClass=btl-manager',
    'Keywords=printer;display;monitor;vm;',
    '',
  ].join('\n');
}

/**
 * Writes the .desktop entry when it is missing or differs from what this clone
 * would write (moved clone, other Node). Returns `'wrote'` or `'unchanged'`.
 * Never throws: a launcher that cannot register itself must still start.
 */
export function ensureDesktopEntry() {
  const text = entryText();
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === text) return 'unchanged';
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
    refreshDatabase();
    return 'wrote';
  } catch {
    return 'unchanged';
  }
}

export function removeDesktopEntry() {
  rmSync(file, { force: true });
  refreshDatabase();
}

function refreshDatabase() {
  try {
    execFileSync('update-desktop-database', [dir], { stdio: 'ignore' });
  } catch {
    // Optional; launchers rescan the directory on their own.
  }
}

/** Whether `link` resolves to the same file as `target`. */
function linksTo(link, target) {
  try {
    return realpathSync(link) === realpathSync(target);
  } catch {
    return false;
  }
}

/** Quotes a path for the `Exec=` key, which splits on spaces and honours double quotes. */
function quote(p) {
  return `"${p.replace(/"/g, '\\"')}"`;
}

// Run as `npm run install-desktop`: explicit, verbose, with the symlink hint.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'linux') {
    console.error(`BTL Manager runs on Linux only (CUPS, sway, libvirt); got ${process.platform}`);
    process.exit(1);
  }
  if (process.argv.includes('--remove')) {
    removeDesktopEntry();
    console.log(`removed ${file}`);
  } else {
    if (!existsSync(path.resolve(here, '..', 'dist', 'server.js'))) {
      console.error('dist/ is missing; run `npm run build` first');
      process.exit(1);
    }
    console.log(`${ensureDesktopEntry() === 'wrote' ? 'wrote' : 'up to date:'} ${file}`);
    if (!linksTo(systemLink, printersCli)) {
      console.log(
        `note: ${systemLink} does not point at this clone, so the app will type the full path\n` +
          `      of the CLI into the terminal. To get the short form, as root:\n` +
          `      ln -sf ${quote(printersCli)} ${systemLink}`,
      );
    }
  }
}
