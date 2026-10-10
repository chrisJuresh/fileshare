import { describe, expect, it } from 'vitest';
import { redactUrl } from './log.js';

describe('redactUrl', () => {
  const id = 'AbCdEfGhIjKlMnOpQrStUv';
  const token = `${id}.1.zzzzzzzzzzzzzzzzzzzzzz`;

  it('hides tracker and webseed tokens', () => {
    expect(redactUrl(`/tr/${token}/announce?info_hash=x&peer_id=y`)).toBe('/tr/[token]/announce');
    expect(redactUrl(`/ws/${token}/name/a.bin`)).toBe('/ws/[token]/name/a.bin');
  });

  it('shortens share ids in page and API paths', () => {
    expect(redactUrl(`/s/${id}`)).toBe('/s/AbCd…');
    expect(redactUrl(`/api/s/${id}`)).toBe('/api/s/AbCd…');
    expect(redactUrl(`/api/s/${id}/unlock`)).toBe('/api/s/AbCd…/unlock');
    expect(redactUrl(`/api/s/${id}/live`)).toBe('/api/s/AbCd…/live');
  });

  it('hides every t= query value', () => {
    const out = redactUrl(`/api/s/${id}/torrent?t=${token}&x=1&t=${token}`);
    expect(out).toBe('/api/s/AbCd…/torrent?t=[token]&x=1&t=[token]');
    expect(out).not.toContain(id);
  });

  it('leaves other paths alone', () => {
    expect(redactUrl('/assets/app-123.js')).toBe('/assets/app-123.js');
    expect(redactUrl('/healthz')).toBe('/healthz');
  });
});
