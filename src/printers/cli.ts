/**
 * `btl-printers`: the command behind the Printers panel.
 *
 *     btl-printers list [--json]   printers on the network and queues on this machine
 *     btl-printers add <id>        create a queue for a discovered printer (sudo)
 *     btl-printers default <id>    make a queue the system default (sudo)
 *     btl-printers test <id>       print the CUPS test page
 *     btl-printers remove <id>     delete a queue (sudo)
 *
 * The logic lives here rather than in the app so it can be tested without a
 * window, run over SSH, and read in the terminal as one short line. Every
 * command that changes the system is echoed before it runs.
 *
 * Exit codes: 0 success, 1 a system command failed, 2 usage error or unknown id.
 */
import { execFile } from 'node:child_process';
import { parseAvahi, type DiscoveredPrinter } from './avahi.js';
import {
  DRIVERLESS,
  LPADMIN,
  lpTestPageArgs,
  lpadminAddArgs,
  lpadminDefaultArgs,
  lpadminRemoveArgs,
  parseDriverlessList,
  parseLpstat,
  uriHost,
} from './cups.js';
import { mergePrinters, slug } from './model.js';
import type { Printer, PrinterList, PrintQueue } from '../shared/types.js';

/** Upper bound for mDNS browsing; `-t` usually returns in one or two seconds. */
const SCAN_TIMEOUT_MS = 10_000;

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 1 | 2,
  ) {
    super(message);
  }
}

/** Entry point used by `cli/btl-printers.js`; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'list':
        await list(rest.includes('--json'));
        return 0;
      case 'add':
        await add(requireId(rest));
        return 0;
      case 'default':
        await setDefault(requireId(rest));
        return 0;
      case 'test':
        await testPage(requireId(rest));
        return 0;
      case 'remove':
        await remove(requireId(rest));
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
    process.stderr.write(`btl-printers: ${err.message}\n`);
    return err.exitCode;
  }
}

const USAGE = `usage: btl-printers list [--json]
       btl-printers add <id>        (sudo)
       btl-printers default <id>    (sudo)
       btl-printers test <id>
       btl-printers remove <id>     (sudo)
`;

function requireId(rest: string[]): string {
  const id = rest.find((a) => !a.startsWith('-'));
  if (!id) throw new CliError(`missing printer id\n${USAGE}`, 2);
  return id;
}

// ---- commands ---------------------------------------------------------------

async function list(json: boolean): Promise<void> {
  const result = await scan();
  if (json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (result.printers.length === 0) {
    process.stdout.write(
      'No printers found and no queues set up.\nPrinters go to sleep and drop off the network; wake one up and run again.\n',
    );
    return;
  }
  const rows = result.printers.map((p) => [p.id, p.model, p.ip ?? p.host ?? '-', status(p)]);
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  for (const r of rows) {
    process.stdout.write(
      `${(r[0] ?? '').padEnd(widths[0] ?? 0)}  ${(r[1] ?? '').padEnd(widths[1] ?? 0)}  ${(r[2] ?? '').padEnd(widths[2] ?? 0)}  ${r[3]}\n`,
    );
  }
}

function status(p: Printer): string {
  if (!p.queue) return 'not set up';
  const parts = [p.queue.isDefault ? 'default' : 'queue', p.queue.state];
  if (!p.discovered) parts.push('not seen on network');
  return parts.join(', ');
}

/**
 * Creates the queue. Needs the printer awake: both the mDNS record and the
 * `driverless list` entry come from the live device, and the PPD is generated
 * from the printer's own IPP attributes.
 */
async function add(id: string): Promise<void> {
  const { printers } = await scan();
  const printer = findPrinter(printers, id);
  if (printer.queue) {
    throw new CliError(`queue ${printer.queue.name} already exists for ${printer.name}`, 2);
  }
  if (!printer.discovered || !printer.uri) {
    throw new CliError(`${printer.name} is not seen on the network; wake it up and retry`, 1);
  }
  const entries = parseDriverlessList(await run(DRIVERLESS, ['list']));
  const wanted = new Set([printer.host?.toLowerCase(), printer.ip?.toLowerCase()]);
  const entry = entries.find((e) => wanted.has(uriHost(e.uri) ?? ''));
  if (!entry) {
    throw new CliError(
      `${printer.name} answered mDNS but not IPP (driverless found ${entries.length} printer(s)); retry in a moment`,
      1,
    );
  }
  await runVisible(LPADMIN, lpadminAddArgs(printer.id, entry.uri, entry.model));
  process.stdout.write(await run('lpstat', ['-p', printer.id]));
}

async function setDefault(id: string): Promise<void> {
  const q = requireQueue((await scan()).printers, id);
  await runVisible(LPADMIN, lpadminDefaultArgs(q.name));
  process.stdout.write(await run('lpstat', ['-d']));
}

async function testPage(id: string): Promise<void> {
  const q = requireQueue((await scan()).printers, id);
  process.stdout.write(await runVisible('lp', lpTestPageArgs(q.name)));
}

async function remove(id: string): Promise<void> {
  const q = requireQueue((await scan()).printers, id);
  await runVisible(LPADMIN, lpadminRemoveArgs(q.name));
}

function findPrinter(printers: Printer[], id: string): Printer {
  const wanted = id.toLowerCase();
  const found = printers.find(
    (p) => p.id.toLowerCase() === wanted || p.queue?.name.toLowerCase() === wanted,
  );
  if (found) return found;
  const known = printers.map((p) => p.id).join(', ') || 'none';
  throw new CliError(`unknown printer ${id}; known: ${known}`, 2);
}

function requireQueue(printers: Printer[], id: string): PrintQueue {
  const p = findPrinter(printers, id);
  if (!p.queue) throw new CliError(`${p.name} has no queue yet; run: btl-printers add ${p.id}`, 2);
  return p.queue;
}

// ---- scanning ---------------------------------------------------------------

/** Discovers printers over mDNS and reads the local queues; both are plain reads. */
export async function scan(): Promise<PrinterList> {
  const [discovered, queues] = await Promise.all([discover(), readQueues()]);
  return { printers: mergePrinters(discovered, queues), scannedAt: Date.now() };
}

async function discover(): Promise<DiscoveredPrinter[]> {
  // avahi-browse exits 0 with no output when nothing answers; a missing daemon is an error.
  const out = await run('avahi-browse', ['--resolve', '--terminate', '--parsable', '_ipp._tcp']);
  return parseAvahi(out);
}

async function readQueues(): Promise<PrintQueue[]> {
  // `lpstat -v`/`-p` exit 1 with "No destinations added." when CUPS has no queues.
  const [v, p, d] = await Promise.all([
    run('lpstat', ['-v'], [0, 1]),
    run('lpstat', ['-p'], [0, 1]),
    run('lpstat', ['-d'], [0, 1]),
  ]);
  return parseLpstat(v, p, d);
}

// ---- processes --------------------------------------------------------------

/** Runs a command with a C locale so output is parseable; rejects on a non-OK exit. */
function run(cmd: string, args: string[], okCodes: number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', timeout: SCAN_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        if (code !== null && okCodes.includes(code)) resolve(stdout);
        else reject(new CliError(`${cmd} ${args.join(' ')}: ${stderr.trim() || err?.message}`, 1));
      },
    );
  });
}

/** Echoes the command line first, so the terminal shows exactly what changed the system. */
function runVisible(cmd: string, args: string[]): Promise<string> {
  process.stdout.write(`+ ${[cmd, ...args].map(quote).join(' ')}\n`);
  return run(cmd, args);
}

function quote(s: string): string {
  return /^[\w./:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export { slug };
