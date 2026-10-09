import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';

/**
 * The web app forwards its sign-in routes through its own address (so the
 * session cookie is first-party — see auth/session-cookie.ts). Those requests
 * reach this API from the web host's servers, not from the person, so every
 * sign-in in the country would share one rate-limit bucket.
 *
 * The web app's proxy says who the visitor is in `x-roomick-visitor-ip`, and
 * proves it is the proxy with `x-roomick-proxy-secret` — the value of
 * WEB_PROXY_SECRET, set on both services. Only then is the visitor's address
 * taken as `req.ip` (for the rate limits and the audit trail). Without the
 * secret, or with a wrong one, nothing changes: anyone can send the headers,
 * so they mean nothing on their own.
 */
export const WEB_PROXY_SECRET_HEADER = 'x-roomick-proxy-secret';
export const WEB_PROXY_VISITOR_HEADER = 'x-roomick-visitor-ip';

/** Shorter than this is a placeholder, not a secret (an unset `$WEB_PROXY_SECRET` arrives as that literal text). */
export const WEB_PROXY_SECRET_MIN_LENGTH = 32;

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

export function visitorBehindWebProxy(secret: string | undefined) {
  const expected = secret && secret.length >= WEB_PROXY_SECRET_MIN_LENGTH ? digest(secret) : null;
  return (req: Request, _res: Response, next: NextFunction): void => {
    const presented = req.headers[WEB_PROXY_SECRET_HEADER];
    const visitor = req.headers[WEB_PROXY_VISITOR_HEADER];
    // Never passed on, logged or kept.
    delete req.headers[WEB_PROXY_SECRET_HEADER];
    delete req.headers[WEB_PROXY_VISITOR_HEADER];
    if (expected && typeof presented === 'string' && typeof visitor === 'string') {
      const address = visitor.split(',')[0].trim();
      if (timingSafeEqual(digest(presented), expected) && isIP(address)) {
        Object.defineProperty(req, 'ip', { value: address, configurable: true, enumerable: true, writable: true });
      }
    }
    next();
  };
}
