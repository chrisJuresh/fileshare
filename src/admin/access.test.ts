// Access JWT settings and verifier: certs URL override only in tests, strict team domain, no
// email-less (service) tokens unless explicitly allowed. Synthetic keys and identities only.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { accessSettings, certsOverrideIgnored, createAccessVerifier, type AccessSettings } from './access.js';

const cfg = (env: Record<string, string>) =>
  loadConfig({
    PUBLIC_BASE_URL: 'https://files.example.test',
    ADMIN_BASE_URL: 'https://admin.example.test',
    CF_ACCESS_AUD: 'aud-synthetic',
    ...env,
  });

describe('accessSettings', () => {
  it('ignores CF_ACCESS_CERTS_URL outside NODE_ENV=test', () => {
    const prod = cfg({ NODE_ENV: 'production', CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_CERTS_URL: 'http://127.0.0.1:1/certs' });
    const s = accessSettings(prod) as AccessSettings;
    expect(s.certsUrl.href).toBe('https://team.cloudflareaccess.com/cdn-cgi/access/certs');
    expect(certsOverrideIgnored(prod)).toBe(true);
    const test = cfg({ NODE_ENV: 'test', CF_ACCESS_TEAM_DOMAIN: 'team.example.test', CF_ACCESS_CERTS_URL: 'http://127.0.0.1:1/certs' });
    expect((accessSettings(test) as AccessSettings).certsUrl.href).toBe('http://127.0.0.1:1/certs');
    expect(certsOverrideIgnored(test)).toBe(false);
  });

  it('requires a bare *.cloudflareaccess.com host name in production', () => {
    const team = (d: string) => accessSettings(cfg({ NODE_ENV: 'production', CF_ACCESS_TEAM_DOMAIN: d }));
    expect(team('team.cloudflareaccess.com')).toMatchObject({ issuer: 'https://team.cloudflareaccess.com' });
    expect(team('https://Team.cloudflareaccess.com/')).toMatchObject({ issuer: 'https://team.cloudflareaccess.com' });
    for (const bad of ['team.example.com', 'evil.com/x.cloudflareaccess.com', 'team.cloudflareaccess.com:8443', 'user@team.cloudflareaccess.com', 'http://team.cloudflareaccess.com', 'cloudflareaccess.com.evil.com']) {
      expect(typeof team(bad)).toBe('string');
    }
  });
});

describe('createAccessVerifier', () => {
  it('refuses tokens without an email unless ADMIN_EMAILS lists the service token', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const base = { issuer: 'https://team.example.test', audience: 'aud', certsUrl: new URL('http://unused.invalid'), allowedOrigin: 'https://admin.example.test' };
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(base.issuer)
        .setAudience('aud')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

    const open = createAccessVerifier({ ...base, allowEmails: [] }, keys);
    expect(await open(await sign({ email: 'someone@example.test' }))).toEqual({ ok: true, email: 'someone@example.test' });
    expect(await open(await sign({ common_name: 'svc.access' }))).toEqual({ ok: false, reason: 'no_email' });
    expect(await open(await sign({ email: '' }))).toEqual({ ok: false, reason: 'no_email' });

    const listed = createAccessVerifier({ ...base, allowEmails: ['owner@example.test', 'svc.access'] }, keys);
    expect(await listed(await sign({ common_name: 'svc.access' }))).toEqual({ ok: true, email: '' });
    expect(await listed(await sign({ common_name: 'other.access' }))).toEqual({ ok: false, reason: 'no_email' });
    expect(await listed(await sign({ email: 'intruder@example.test' }))).toEqual({ ok: false, reason: 'email_not_allowed' });
  });
});
