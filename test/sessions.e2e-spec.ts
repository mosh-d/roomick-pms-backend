import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { Client, Session, sessionCookie, sessionSetCookie, sessionToken, signUp, startApp } from './support/e2e';

/**
 * Sessions live in an httpOnly cookie now, not in the page's storage: the
 * refresh token never appears in an answer, the cookie renews once, only the
 * web app may use it, and signing out ends it on the server. Sign-ins that
 * come through the web app's proxy are rate-limited per visitor, but only
 * when the proxy proves itself with the shared secret.
 */
describe('Sessions in a cookie (e2e)', () => {
  const PROXY_SECRET = 'e2e-proxy-secret-that-is-long-enough-to-count';
  const WEB_APP = 'https://web.e2e.test';
  const saved = { secret: process.env.WEB_PROXY_SECRET, cors: process.env.CORS_ORIGINS };

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;

  const http = () => request(app.getHttpServer());
  /** A sign-in through the web app's proxy, for `visitor`. */
  const login = (visitor: string, password = owner.password, cookie?: string) => {
    let req = http().post('/api/v1/auth/login').set('x-roomick-proxy-secret', PROXY_SECRET).set('x-roomick-visitor-ip', visitor);
    if (cookie) req = req.set('Cookie', cookie);
    return req.send({ email: owner.email, password });
  };
  const refresh = (cookie?: string, origin?: string) => {
    let req = http().post('/api/v1/auth/refresh');
    if (cookie) req = req.set('Cookie', cookie);
    if (origin) req = req.set('Origin', origin);
    return req.send({});
  };

  beforeAll(async () => {
    // Read when the app is set up (the proxy check) and on each request (the Origin check).
    process.env.WEB_PROXY_SECRET = PROXY_SECRET;
    process.env.CORS_ORIGINS = WEB_APP;
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Sessions');
  });

  afterAll(async () => {
    // Signed in through the proxy as yet another visitor: the last test spent this connection's sign-ins.
    const fresh = await login('198.51.100.99');
    await client.delete('/tenants/me', { ...owner, token: fresh.body.accessToken as string }, { password: owner.password });
    expect(await prisma.tenant.findUnique({ where: { id: owner.tenantId } })).toBeNull();
    await app.close();
    process.env.WEB_PROXY_SECRET = saved.secret;
    process.env.CORS_ORIGINS = saved.cors;
    if (saved.secret === undefined) delete process.env.WEB_PROXY_SECRET;
    if (saved.cors === undefined) delete process.env.CORS_ORIGINS;
  });

  it('signs in with the session in an httpOnly cookie for the sign-in routes, and never in the answer', async () => {
    const res = await login('198.51.100.1');
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ id: owner.userId });
    expect(res.body).not.toHaveProperty('refreshToken');
    const line = sessionSetCookie(res) ?? '';
    expect(line).toMatch(/^roomick_session=[\w-]+\.[\w-]+\.[\w-]+;/);
    expect(line).toMatch(/; HttpOnly/i);
    expect(line).toMatch(/; SameSite=Strict/i);
    expect(line).toMatch(/; Path=\/api\/v1\/auth/);
    // A week, like the token inside it.
    const expires = new Date(/Expires=([^;]+)/.exec(line)?.[1] ?? 0).getTime();
    expect(expires - Date.now()).toBeGreaterThan(6 * 86_400_000);
  });

  it('renews from the cookie once — the old cookie is refused afterwards, and a refusal leaves the newer cookie alone', async () => {
    const first = sessionCookie(await login('198.51.100.2'));
    const renewed = await refresh(first, WEB_APP);
    expect(renewed.status).toBe(200);
    expect(renewed.body.accessToken).toEqual(expect.any(String));
    expect(renewed.body).not.toHaveProperty('refreshToken');
    const second = sessionCookie(renewed);
    expect(second).not.toBe(first);

    const again = await refresh(first, WEB_APP);
    expect(again.status).toBe(401);
    // Another tab may have renewed a moment ago: the refusal mustn't wipe its cookie.
    expect(sessionSetCookie(again)).toBeUndefined();

    expect((await refresh(second, WEB_APP)).status).toBe(200);
  });

  it("refuses the cookie from another site's page", async () => {
    const cookie = sessionCookie(await login('198.51.100.3'));
    const res = await refresh(cookie, 'https://evil.example');
    expect(res.status).toBe(403);
    // Still a live session — the refusal spent nothing.
    expect((await refresh(cookie, WEB_APP)).status).toBe(200);
  });

  it('renews with no cookie and no token? No — the session has ended', async () => {
    const res = await refresh(undefined, WEB_APP);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  it('signing out ends the session on the server and clears the cookie', async () => {
    const cookie = sessionCookie(await login('198.51.100.4'));
    const out = await http().post('/api/v1/auth/logout').set('Cookie', cookie).set('Origin', WEB_APP).send({});
    expect(out.status).toBe(204);
    const cleared = sessionSetCookie(out) ?? '';
    expect(cleared).toMatch(/^roomick_session=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await refresh(cookie, WEB_APP)).status).toBe(401);
  });

  it('signing out with the cookie a renewal had just replaced still ends the renewed session', async () => {
    // The renewal crossed with the sign-out: the browser sent the old cookie
    // with "sign out", and the renewal's answer then set the new one.
    const old = sessionCookie(await login('198.51.100.7'));
    const renewed = await refresh(old, WEB_APP);
    expect(renewed.status).toBe(200);
    const newer = sessionCookie(renewed);
    expect((await http().post('/api/v1/auth/logout').set('Cookie', old).set('Origin', WEB_APP).send({})).status).toBe(204);
    expect((await refresh(newer, WEB_APP)).status).toBe(401);
  });

  it('a new sign-in in the same browser ends the session it replaces', async () => {
    const before = sessionCookie(await login('198.51.100.5'));
    const after = sessionCookie(await login('198.51.100.5', owner.password, before));
    expect((await refresh(before, WEB_APP)).status).toBe(401);
    expect((await refresh(after, WEB_APP)).status).toBe(200);
  });

  it('trades a token kept from before the cookie (sent in the body) for the cookie', async () => {
    const kept = sessionToken(await login('198.51.100.6'));
    const res = await http().post('/api/v1/auth/refresh').send({ refreshToken: kept });
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toMatch(/^roomick_session=/);
    expect(res.body).not.toHaveProperty('refreshToken');
  });

  it("counts sign-ins per visitor when the web app's proxy proves itself, and per connection otherwise", async () => {
    // Ten a minute per address (auth.controller.ts).
    for (let i = 0; i < 10; i++) expect((await login('203.0.113.50', 'wrong-password')).status).toBe(401);
    expect((await login('203.0.113.50', 'wrong-password')).status).toBe(429);
    // Someone else at the same moment is not held up by it.
    expect((await login('203.0.113.51', 'wrong-password')).status).toBe(401);

    // Without the secret the visitor header means nothing: these all count
    // against the connection itself, whatever visitor each one claims.
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await http()
        .post('/api/v1/auth/login')
        .set('x-roomick-proxy-secret', 'a-wrong-secret-that-is-also-long-enough-to-count')
        .set('x-roomick-visitor-ip', `203.0.113.${100 + i}`)
        .send({ email: owner.email, password: 'wrong-password' });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});
