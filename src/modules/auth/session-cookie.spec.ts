import type { Request, Response } from 'express';
import { assertFromWebApp, clearSessionCookie, handOverSession, readSessionCookie, SESSION_COOKIE, SESSION_COOKIE_PATH } from './session-cookie';
import type { LoginResult } from './auth.service';

const request = (headers: Record<string, string>): Request => ({ headers }) as unknown as Request;

/** A refresh token's shape: three dot-separated parts, the middle one carrying `exp`. */
function token(exp: number): string {
  return ['header', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 'signature'].join('.');
}

describe('session cookie', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  describe('readSessionCookie', () => {
    it('finds the session among other cookies', () => {
      expect(readSessionCookie(request({ cookie: `theme=dark; ${SESSION_COOKIE}=a.b.c; other=1` }))).toBe('a.b.c');
    });

    it('is nothing without a cookie, without this one, or with it empty', () => {
      expect(readSessionCookie(request({}))).toBeUndefined();
      expect(readSessionCookie(request({ cookie: 'theme=dark' }))).toBeUndefined();
      expect(readSessionCookie(request({ cookie: `${SESSION_COOKIE}=` }))).toBeUndefined();
    });

    it("isn't fooled by a cookie whose name only ends the same", () => {
      expect(readSessionCookie(request({ cookie: `x${SESSION_COOKIE}=a.b.c` }))).toBeUndefined();
    });
  });

  describe('handOverSession', () => {
    function hand(result: LoginResult) {
      const cookie = jest.fn();
      const handed = handOverSession({ cookie } as unknown as Response, result);
      return { handed, cookie };
    }
    const result = (refreshToken: string): LoginResult => ({
      accessToken: 'access',
      refreshToken,
      user: { id: 'u', tenantId: 't', email: 'a@b.c', name: 'A', roles: [] },
    });

    it('puts the refresh token in an httpOnly, strict cookie for the sign-in routes only, and leaves it out of the answer', () => {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const { handed, cookie } = hand(result(token(exp)));
      expect(handed).toEqual({ accessToken: 'access', user: expect.objectContaining({ id: 'u' }) });
      expect(handed).not.toHaveProperty('refreshToken');
      expect(cookie).toHaveBeenCalledWith(SESSION_COOKIE, token(exp), {
        httpOnly: true,
        secure: false,
        sameSite: 'strict',
        path: SESSION_COOKIE_PATH,
        expires: new Date(exp * 1000),
      });
    });

    it('is Secure in production', () => {
      process.env.NODE_ENV = 'production';
      const { cookie } = hand(result(token(1)));
      expect(cookie.mock.calls[0][2]).toMatchObject({ secure: true });
    });

    it('is Secure anywhere with SESSION_COOKIE_SECURE=true', () => {
      process.env.NODE_ENV = 'development';
      process.env.SESSION_COOKIE_SECURE = 'true';
      const { cookie } = hand(result(token(1)));
      expect(cookie.mock.calls[0][2]).toMatchObject({ secure: true });
    });
  });

  it('clears the cookie with the attributes it was set with', () => {
    const clearCookie = jest.fn();
    clearSessionCookie({ clearCookie } as unknown as Response);
    expect(clearCookie).toHaveBeenCalledWith(SESSION_COOKIE, { httpOnly: true, secure: false, sameSite: 'strict', path: SESSION_COOKIE_PATH });
  });

  describe('assertFromWebApp', () => {
    beforeEach(() => {
      process.env.CORS_ORIGINS = 'https://app.example.com, https://staging.example.com';
      process.env.PUBLIC_WEB_BASE_URL = 'https://hotel.example.com/';
    });

    it("lets the web app's own addresses through", () => {
      for (const origin of ['https://app.example.com', 'https://staging.example.com', 'https://hotel.example.com']) {
        expect(() => assertFromWebApp(request({ origin }))).not.toThrow();
      }
    });

    it('lets a request with no Origin through — not a browser', () => {
      expect(() => assertFromWebApp(request({}))).not.toThrow();
    });

    it("refuses another site's page", () => {
      expect(() => assertFromWebApp(request({ origin: 'https://evil.example' }))).toThrow('did not come from the Roomick web app');
      expect(() => assertFromWebApp(request({ origin: 'null' }))).toThrow();
    });
  });
});
