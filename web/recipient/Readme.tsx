import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Lexer, type MarkedToken, type Token, type Tokens } from 'marked';
import type { UnlockResponse } from '../../src/types.ts';
import { directUrl } from './engine.ts';
import { README_MAX_BYTES, decodeEntities, findReadme, safeHref } from './markdown.ts';

interface Loaded {
  path: string;
  tokens: MarkedToken[];
  truncated: boolean;
}

/** The share's README.md (if it has one), fetched over the webseed and shown under everything else. */
export function Readme({ info }: { info: UnlockResponse }) {
  const index = useMemo(() => findReadme(info.files), [info]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    setLoaded(null);
    if (index === null) return;
    const abort = new AbortController();
    void loadReadme(info, index, abort.signal).then((r) => {
      if (r && !abort.signal.aborted) setLoaded(r);
    });
    return () => abort.abort();
  }, [info, index]);

  if (!loaded || loaded.tokens.length === 0) return null;
  return (
    <section class="section" aria-labelledby="readme-h">
      <div class="section-head">
        <h2 id="readme-h">{loaded.path}</h2>
      </div>
      <div class="panel">
        <article class="md">
          {blocks(loaded.tokens)}
          {loaded.truncated && <p class="hint">This file is long, so only the start of it is shown.</p>}
        </article>
      </div>
    </section>
  );
}

async function loadReadme(info: UnlockResponse, index: number, signal: AbortSignal): Promise<Loaded | null> {
  const file = info.files[index];
  if (!file) return null;
  try {
    const res = await fetch(directUrl(info, index), {
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
      headers: { Range: `bytes=0-${README_MAX_BYTES - 1}` },
      signal,
    });
    if (!res.ok) return null; // gone/revoked is handled by the live socket; the README just doesn't show
    const bytes = new Uint8Array(await res.arrayBuffer()).subarray(0, README_MAX_BYTES);
    const text = new TextDecoder('utf-8').decode(bytes);
    return { path: file.path, tokens: Lexer.lex(text) as MarkedToken[], truncated: file.length > README_MAX_BYTES };
  } catch {
    return null;
  }
}

// --- rendering: marked tokens → Preact elements (never HTML strings) ---

function blocks(tokens: Token[]): ComponentChildren[] {
  return (tokens as MarkedToken[]).map((t, i) => block(t, i));
}

function block(t: MarkedToken, key: number): ComponentChildren {
  switch (t.type) {
    case 'heading': {
      // The page has its own h1/h2: README headings sit below the section heading.
      const Tag = `h${Math.min(t.depth + 2, 6)}` as 'h3';
      return (
        <Tag key={key} class={`md-h${t.depth}`}>
          {inline(t.tokens)}
        </Tag>
      );
    }
    case 'paragraph':
      return <p key={key}>{inline(t.tokens)}</p>;
    case 'text':
      return t.tokens ? <span key={key}>{inline(t.tokens)}</span> : decodeEntities(t.text);
    case 'code':
      return (
        <pre key={key}>
          <code>{t.text}</code>
        </pre>
      );
    case 'blockquote':
      return <blockquote key={key}>{blocks(t.tokens)}</blockquote>;
    case 'hr':
      return <hr key={key} />;
    case 'list': {
      const items = t.items.map((item, i) => <li key={i}>{blocks(item.tokens)}</li>);
      return t.ordered ? (
        <ol key={key} start={typeof t.start === 'number' && t.start !== 1 ? t.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case 'checkbox':
      return <input key={key} type="checkbox" class="md-task" checked={t.checked} disabled />;
    case 'table':
      return (
        <div key={key} class="table-wrap">
          <table>
            <thead>
              <tr>
                {t.header.map((c, i) => (
                  <th key={i} scope="col" class={alignClass(c.align)}>
                    {inline(c.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i} class={alignClass(c.align)}>
                      {inline(c.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'html': // raw HTML is never rendered
    case 'def':
    case 'space':
      return null;
    default:
      return inlineToken(t, key);
  }
}

function inline(tokens: Token[] | undefined): ComponentChildren[] {
  return ((tokens ?? []) as MarkedToken[]).map((t, i) => inlineToken(t, i));
}

function inlineToken(t: MarkedToken, key: number): ComponentChildren {
  switch (t.type) {
    case 'text':
      return t.tokens ? <span key={key}>{inline(t.tokens)}</span> : decodeEntities(t.text);
    case 'escape':
      return t.text;
    case 'strong':
      return <strong key={key}>{inline(t.tokens)}</strong>;
    case 'em':
      return <em key={key}>{inline(t.tokens)}</em>;
    case 'del':
      return <del key={key}>{inline(t.tokens)}</del>;
    case 'codespan':
      return <code key={key}>{t.text}</code>;
    case 'br':
      return <br key={key} />;
    case 'link': {
      const href = safeHref(t.autolink ? t.href : decodeEntities(t.href));
      if (!href) return <span key={key}>{inline(t.tokens)}</span>;
      return (
        <a key={key} href={href} title={t.title ? decodeEntities(t.title) : undefined} target="_blank" rel="noopener noreferrer nofollow">
          {inline(t.tokens)}
        </a>
      );
    }
    case 'image': // not loaded (the page only allows its own images): show the alt text
      return t.text ? (
        <span key={key} class="md-img">
          {decodeEntities(t.text)}
        </span>
      ) : null;
    case 'html':
      return /^<br\s*\/?>$/i.test(t.text.trim()) ? <br key={key} /> : null;
    default:
      return null;
  }
}

function alignClass(align: Tokens.TableCell['align']): string | undefined {
  return align ? `al-${align}` : undefined;
}
