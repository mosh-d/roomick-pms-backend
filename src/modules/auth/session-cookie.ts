import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorCode } from '../../common/errors/error-codes';
import type { LoginResult } from './auth.service';

/**
 * Where a browser keeps its session: the refresh token lives in an httpOnly
 * cookie the page's own scripts can't read, and the short-lived access token
 * only in the page's memory. Both used to sit in localStorage, where one
 * cross-site-scripting bug would have handed a week-long session to whoever
 * found it.
 *
 * The web app reaches the routes that set or read this cookie through its own
 * address (its proxy forwards `/api/v1/auth/*` here), so the cookie is the web
 * app's own, first-party — a browser that blocks third-party cookies (Safari
 * does, by default) still keeps it. `Path` keeps it off every other request.
 */
export const SESSION_COOKIE = 'roomick_session';
export const SESSION_COOKIE_PATH = '/api/v1/auth';

/** A session handed to a browser: everything but the refresh token, which went into the cookie. */
export type SessionStarted<T extends LoginResult = LoginResult> = Omit<T, 'refreshToken'>;

/** `Secure` everywhere but a developer's own machine, where the app runs on plain http. */
function secureCookies(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.SESSION_COOKIE_SECURE === 'true';
}

function cookieOptions() {
  return { httpOnly: true, secure: secureCookies(), sameSite: 'strict' as const, path: SESSION_COOKIE_PATH };
}

/** When the refresh token itself expires — the cookie goes with it. */
function expiryOf(token: string): Date | undefined {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof exp === 'number' ? new Date(exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

/** The refresh token the browser sent, if any. Read by hand: it's the only cookie this API takes. */
export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Puts the refresh token in the cookie and hands back the rest. */
export function handOverSession<T extends LoginResult>(res: Response, result: T): SessionStarted<T> {
  const { refreshToken, ...rest } = result;
  res.cookie(SESSION_COOKIE, refreshToken, { ...cookieOptions(), expires: expiryOf(refreshToken) });
  return rest;
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

/** The web app's own addresses: the CORS list and the address emails link to. */
function trustedOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const value of [...(process.env.CORS_ORIGINS ?? '').split(','), process.env.PUBLIC_WEB_BASE_URL ?? '']) {
    try {
      if (value.trim()) origins.add(new URL(value.trim()).origin);
    } catch {
      // Not an address; nothing to trust.
    }
  }
  return origins;
}

/**
 * A request that signs in with the cookie must come from the web app itself.
 * The cookie is `SameSite=Strict`, so another site's page can't send it; this
 * is the second lock, for an older browser or a sibling address on the same
 * domain. A request with no `Origin` isn't a browser's (browsers always send
 * one with a POST) and passes.
 */
export function assertFromWebApp(req: Request): void {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!trustedOrigins().has(origin)) {
    throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: 'This request did not come from the Roomick web app' });
  }
}
