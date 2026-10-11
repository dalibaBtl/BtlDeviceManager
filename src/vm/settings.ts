/**
 * Where each machine's console window goes, and where that is stored.
 *
 * sway has no IPC for the workspace names a config defines, and an empty
 * workspace does not exist in `get_workspaces`, so the names come from the
 * `set $ws… "…"` lines the `desktop` role writes into `~/.config/sway/config`
 * and are joined with the live ones. The choices are kept as sway variables in
 * `config.d/vm.conf`, one per machine: valid sway syntax, readable back by the
 * CLI, visible to anyone reading their sway config, and no state file of our
 * own.
 */

/** Prefix of the per-machine variable in `vm.conf`. */
export const VARIABLE_PREFIX = '$btl_vm_console_';

export const VM_CONF_HEADER =
  '# Written by btl-vm (BTL Device Manager). One line per machine: the workspace its console opens on.';

/**
 * Variable name for a machine. sway variable names are one token, so the
 * domain name is reduced to `[A-Za-z0-9_]`; two names differing only in other
 * characters would share a line, which is accepted as too unlikely to matter.
 */
export function consoleVariable(vmName: string): string {
  return VARIABLE_PREFIX + vmName.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Workspace names defined as `set $ws<anything> "<name>"` (or unquoted), in
 * file order. Comments and other variables are ignored.
 */
export function parseWorkspaceNames(config: string): string[] {
  const names: string[] = [];
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    const m = /^set\s+\$ws\w*\s+(.+?)\s*$/.exec(line);
    if (!m || m[1] === undefined) continue;
    const name = unquote(m[1]);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The content of `vm.conf` for a set of choices keyed by variable name (see {@link consoleVariable}). */
export function renderVmConf(choices: ReadonlyMap<string, string>): string {
  const lines = [...choices.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([variable, workspace]) => `set ${variable} ${swayQuote(workspace)}`);
  return `${VM_CONF_HEADER}\n${lines.join('\n')}\n`;
}

/** Reads the choices back from `vm.conf`, keyed by variable name; lines that are not ours are ignored. */
export function parseVmConf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const m = /^set\s+(\$btl_vm_console_\w+)\s+(.+?)\s*$/.exec(raw.trim());
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const workspace = unquote(m[2]);
    if (workspace) out.set(m[1], workspace);
  }
  return out;
}

/** Quotes a name for sway's config language: double quotes with backslash escapes. */
export function swayQuote(s: string): string {
  return `"${s.replace(/(["\\])/g, '\\$1')}"`;
}

function unquote(s: string): string {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
  return m && m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : s;
}
