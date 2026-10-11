import type { IPty } from 'node-pty';
import * as pty from 'node-pty';

/**
 * One interactive shell bound to a WebSocket client.
 *
 * Commands the app wants the user to run (`sudo btl-printers add …`, the test
 * page) are *typed* into this shell rather than executed by the server. The
 * password prompt, the command line and its output are all visible, and the
 * command lands in the shell history where it can be repeated or copied.
 *
 * Unlike bgcm's terminal this one knows only POSIX shells: the app is Linux
 * only, so the PowerShell dialect handling was dropped rather than carried.
 */
export class Terminal {
  private readonly proc: IPty;

  constructor(
    cwd: string,
    cols: number,
    rows: number,
    onData: (data: string) => void,
    onExit: (code: number) => void,
  ) {
    this.proc = pty.spawn(process.env.SHELL || '/bin/bash', ['-l'], {
      name: 'xterm-256color',
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
        string,
        string
      >,
    });
    this.proc.onData(onData);
    this.proc.onExit(({ exitCode }) => onExit(exitCode));
  }

  /** Sends raw keystrokes. */
  write(data: string): void {
    this.proc.write(data);
  }

  /** Types the steps as one `&&` chain and presses Enter, so a failure stops the sequence. */
  runChain(steps: string[]): void {
    this.proc.write(steps.join(' && ') + '\r');
  }

  resize(cols: number, rows: number): void {
    this.proc.resize(Math.max(2, cols), Math.max(1, rows));
  }

  kill(): void {
    this.proc.kill();
  }
}

/** Single-quotes a string for a POSIX shell. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
