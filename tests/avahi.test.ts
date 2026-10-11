import { describe, expect, it } from 'vitest';
import { parseAvahi, unescape } from '../src/printers/avahi.js';

// Fixture shaped like real `avahi-browse -rtp _ipp._tcp` output; names and
// addresses are documentation values (RFC 5737), not any real network.
const OUTPUT = [
  '+;eth0;IPv6;Example\\032Printer;_ipp._tcp;local',
  '+;eth0;IPv4;Example\\032Printer;_ipp._tcp;local',
  '=;eth0;IPv6;Example\\032Printer;_ipp._tcp;local;printer-1234.local;fe80::1;631;"txtvers=1" "rp=ipp/print" "ty=Example L1234 Series" "pdl=application/pdf,image/urf"',
  '=;eth0;IPv4;Example\\032Printer;_ipp._tcp;local;printer-1234.local;192.0.2.10;631;"txtvers=1" "rp=ipp/print" "ty=Example L1234 Series" "pdl=application/pdf,image/urf"',
  '=;eth0;IPv4;Other\\032(Semi\\;colon;_ipp._tcp;local;other.local;192.0.2.11;8000;"product=(Other 9000)" "rp=/ipp/alt"',
  '-;eth0;IPv4;Gone;_ipp._tcp;local',
  '',
].join('\n');

describe('unescape', () => {
  it('decodes decimal byte escapes and backslash-escaped punctuation', () => {
    expect(unescape('Example\\032Printer')).toBe('Example Printer');
    expect(unescape('a\;b\\\\c')).toBe('a;b\\c');
    expect(unescape('Tisk\\195\\161rna')).toBe('Tiskárna');
  });
});

describe('parseAvahi', () => {
  it('returns one printer per service, preferring the IPv4 record', () => {
    const printers = parseAvahi(OUTPUT);
    expect(printers.map((p) => p.name)).toEqual(['Example Printer', 'Other (Semi;colon']);
    const ex = printers[0]!;
    expect(ex.ip).toBe('192.0.2.10');
    expect(ex.family).toBe('IPv4');
    expect(ex.host).toBe('printer-1234.local');
    expect(ex.model).toBe('Example L1234 Series');
    expect(ex.uri).toBe('ipp://printer-1234.local:631/ipp/print');
  });

  it('falls back to product for the model and honours port and rp', () => {
    const other = parseAvahi(OUTPUT)[1]!;
    expect(other.model).toBe('Other 9000');
    expect(other.uri).toBe('ipp://other.local:8000/ipp/alt');
  });

  it('is empty when nothing answered', () => {
    expect(parseAvahi('')).toEqual([]);
    expect(parseAvahi('+;eth0;IPv4;X;_ipp._tcp;local\n')).toEqual([]);
  });
});
