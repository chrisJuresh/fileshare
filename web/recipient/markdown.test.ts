import { describe, expect, it } from 'vitest';
import { decodeEntities, findReadme, safeHref } from './markdown.ts';

const f = (path: string) => ({ path, length: 1 });

describe('findReadme', () => {
  it('picks the README.md nearest the top, any case', () => {
    expect(findReadme([f('a/README.md'), f('b.txt'), f('readme.MD')])).toBe(2);
    expect(findReadme([f('x/y/README.md'), f('z/Readme.md')])).toBe(1);
    expect(findReadme([f('README.md')])).toBe(0);
  });

  it('ignores other files', () => {
    expect(findReadme([f('README.txt'), f('README.md.bak'), f('NOTREADME.md'), f('README')])).toBeNull();
    expect(findReadme([])).toBeNull();
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric references', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;&#39;&#x41;&copy;')).toBe(`a & b <c> "'A©`);
  });

  it('leaves unknown and invalid references alone', () => {
    expect(decodeEntities('&nope; & &amp')).toBe('&nope; & &amp');
    expect(decodeEntities('&#0;&#xD800;&#x110000;')).toBe('���');
  });
});

describe('safeHref', () => {
  it('allows absolute http(s) and mailto links', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref(' http://example.com ')).toBe('http://example.com/');
    expect(safeHref('mailto:someone@example.com')).toBe('mailto:someone@example.com');
  });

  it('rejects scripts, data and relative links', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<b>x</b>')).toBeNull();
    expect(safeHref('docs/guide.md')).toBeNull();
    expect(safeHref('#install')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
  });
});
