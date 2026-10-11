// Helpers for showing a share's README.md on the share page. The markdown is parsed with marked's
// lexer and rendered as Preact elements (Readme.tsx), never as HTML: raw HTML in the file is dropped
// and only absolute http(s)/mailto links become links.
import type { FileEntry } from '../../src/types.ts';

/** Only this much of the README is fetched and shown. */
export const README_MAX_BYTES = 256 * 1024;

/** Index of the README.md (any case) nearest the top of the share, or null if there is none. */
export function findReadme(files: readonly FileEntry[]): number | null {
  let best: number | null = null;
  let bestDepth = Infinity;
  files.forEach((f, i) => {
    const parts = f.path.split('/');
    if (parts[parts.length - 1]?.toLowerCase() !== 'readme.md') return;
    if (parts.length < bestDepth) {
      best = i;
      bestDepth = parts.length;
    }
  });
  return best;
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  times: '×',
  deg: '°',
  euro: '€',
  pound: '£',
};

/** Decode the character references marked leaves in text (as plain text; never parsed as HTML). */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, ref: string) => {
    if (ref[0] !== '#') return NAMED[ref] ?? m;
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return String.fromCodePoint(code);
  });
}

/** The link target if it is an absolute http(s) or mailto URL, else null (rendered as plain text). */
export function safeHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return null;
  }
  return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : null;
}
