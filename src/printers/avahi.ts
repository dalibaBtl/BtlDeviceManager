/**
 * Parser for `avahi-browse --resolve --terminate --parsable _ipp._tcp`.
 *
 * Each resolved service is one `=` line of semicolon-separated fields:
 *
 *     =;iface;IPv4|IPv6;name;type;domain;host;address;port;"k=v" "k=v" …
 *
 * `+` (appeared) and `-` (disappeared) lines carry no address and are skipped.
 * Avahi escapes `;` and `\` with a backslash and non-ASCII or space bytes as
 * `\ddd` (decimal), so a service called `Example Printer` arrives as
 * `Example\032Printer`.
 */

/** One IPP printer as announced over mDNS. */
export interface DiscoveredPrinter {
  /** Unescaped service name, e.g. `EPSON L3250 Series`. */
  name: string;
  host: string;
  ip: string;
  port: number;
  /** TXT `ty` (model), falling back to `product` without its parentheses, then the name. */
  model: string;
  /** IPP URI: `ipp://host:port/<rp>`. */
  uri: string;
  family: 'IPv4' | 'IPv6';
}

/**
 * Parses the output of `avahi-browse -rtp _ipp._tcp`. A printer announced on
 * both IPv4 and IPv6 is returned once, preferring the IPv4 record because that
 * is the address a user can read off the printer's own display.
 */
export function parseAvahi(output: string): DiscoveredPrinter[] {
  const byName = new Map<string, DiscoveredPrinter>();
  for (const line of output.split('\n')) {
    if (!line.startsWith('=;')) continue;
    const fields = splitFields(line);
    if (fields.length < 10) continue;
    const family = fields[2] === 'IPv6' ? 'IPv6' : 'IPv4';
    const name = unescape(fields[3] ?? '');
    const host = fields[6] ?? '';
    const ip = fields[7] ?? '';
    const port = Number(fields[8]) || 631;
    const txt = parseTxt(fields.slice(9).join(';'));
    const rp = (txt.get('rp') ?? 'ipp/print').replace(/^\/+/, '');
    const printer: DiscoveredPrinter = {
      name,
      host,
      ip,
      port,
      model: txt.get('ty') || stripParens(txt.get('product')) || name,
      uri: `ipp://${host}:${port}/${rp}`,
      family,
    };
    const existing = byName.get(name);
    if (!existing || (existing.family === 'IPv6' && family === 'IPv4')) byName.set(name, printer);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Splits one parsable line on unescaped semicolons; escapes are left in place. */
function splitFields(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cur += ch + line[i + 1];
      i++;
    } else if (ch === ';') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Undoes avahi's escaping: `\ddd` decimal byte values and backslash-escaped punctuation. */
export function unescape(s: string): string {
  const bytes: number[] = [];
  let out = '';
  const flush = () => {
    if (bytes.length > 0) {
      out += Buffer.from(bytes).toString('utf8');
      bytes.length = 0;
    }
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && /^\d{3}$/.test(s.slice(i + 1, i + 4))) {
      bytes.push(Number(s.slice(i + 1, i + 4)));
      i += 3;
    } else if (ch === '\\' && i + 1 < s.length) {
      flush();
      out += s[i + 1];
      i++;
    } else {
      flush();
      out += ch;
    }
  }
  flush();
  return out;
}

/** Parses the quoted TXT entries (`"k=v" "k=v"`) into a map; keys are lower-cased. */
function parseTxt(field: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of field.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const entry = m[1] ?? '';
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    map.set(entry.slice(0, eq).toLowerCase(), entry.slice(eq + 1));
  }
  return map;
}

function stripParens(v: string | undefined): string {
  return (v ?? '').replace(/^\(|\)$/g, '').trim();
}
