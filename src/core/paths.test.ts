import { describe, expect, it } from 'vitest';
import { safeJoin, validateRelativePath, validateSegment } from './paths.js';

describe('paths', () => {
  it('rejects traversal and bad names', () => {
    for (const bad of ['..', '.', '', 'a/b', 'a\\b', ' x', 'x ', 'a\u0000b', '.syncthing.x.tmp']) {
      expect(() => validateSegment(bad)).toThrow();
    }
    expect(() => validateSegment('a#b', { forUpload: true })).toThrow();
    expect(validateSegment('Holiday 2026')).toBe('Holiday 2026');
  });
  it('validates relative paths', () => {
    expect(validateRelativePath('/Folder/sub/file.bin')).toEqual(['Folder', 'sub', 'file.bin']);
    expect(() => validateRelativePath('a/../../etc')).toThrow();
  });
  it('safeJoin stays inside root', () => {
    expect(safeJoin('/r', 'a', 'b')).toBe('/r/a/b');
    expect(() => safeJoin('/r', '..', 'x')).toThrow();
  });
});
