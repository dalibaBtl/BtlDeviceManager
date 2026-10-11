/**
 * Wire types shared by the server, the browser front-end and the `btl-printers`
 * CLI. Everything crossing the HTTP/WebSocket boundary, and the JSON the CLI
 * prints, is declared here so all three compile against one contract.
 */

/** State of a CUPS queue as reported by `lpstat -p`. */
export type QueueState = 'idle' | 'printing' | 'stopped' | 'unknown';

/** A CUPS print queue that exists on this machine. */
export interface PrintQueue {
  /** Queue name, as used with `lp -d` and `lpadmin -p`. */
  name: string;
  /** Device URI the queue prints to, e.g. `ipp://host.local:631/ipp/print`. */
  uri: string;
  state: QueueState;
  /** Whether `lpstat -d` names this queue as the default destination. */
  isDefault: boolean;
}

/**
 * One printer as the UI sees it: a printer found on the network, a queue that
 * exists on this machine, or both when they match. `id` doubles as the queue
 * name, so `btl-printers add <id>` creates a queue called `<id>`.
 */
export interface Printer {
  /** Slug of the mDNS service name, or the queue name for a queue-only entry. */
  id: string;
  /** Human-readable name: the mDNS service name, or the queue name. */
  name: string;
  /** Model from the mDNS TXT record (`ty`), falling back to the name. */
  model: string;
  /** mDNS host name such as `printer-1234.local`; `null` when not discovered. */
  host: string | null;
  ip: string | null;
  /** IPP URI built from the mDNS record; `null` when not discovered. */
  uri: string | null;
  /** Seen on the network in the latest scan. Sleeping printers drop off mDNS. */
  discovered: boolean;
  /** The matching queue, or `null` when the printer has not been set up. */
  queue: PrintQueue | null;
}

/** Result of one `btl-printers list --json` run. */
export interface PrinterList {
  printers: Printer[];
  /** Epoch milliseconds when the scan finished. */
  scannedAt: number;
}

/** Messages pushed from server to client over the WebSocket. */
export type ServerMessage =
  | { type: 'printers'; items: Printer[]; scannedAt: number | null; error: string | null }
  | { type: 'scanning'; scanning: boolean }
  | { type: 'term-data'; data: string }
  | { type: 'term-exit'; code: number }
  | { type: 'notice'; level: 'info' | 'error'; text: string };

/**
 * Actions that are typed into the client's terminal rather than executed by
 * the server. Everything that needs `sudo`, and the test page, belongs here:
 * the user must see the command that ran on their machine and its answer.
 */
export type TerminalAction =
  | { action: 'printer-add'; id: string }
  | { action: 'printer-default'; id: string }
  | { action: 'printer-test'; id: string }
  | { action: 'printer-remove'; id: string };

/** Messages sent from client to server over the WebSocket. */
export type ClientMessage =
  | { type: 'term-open'; cols: number; rows: number }
  | { type: 'term-input'; data: string }
  | { type: 'term-resize'; cols: number; rows: number }
  | { type: 'term-run'; run: TerminalAction };
