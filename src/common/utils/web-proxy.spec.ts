import type { Request, Response } from 'express';
import { visitorBehindWebProxy, WEB_PROXY_SECRET_HEADER, WEB_PROXY_VISITOR_HEADER } from './web-proxy';

const SECRET = 'a-long-random-secret-of-at-least-32-characters';

/** A request as Express hands it over: `ip` comes from the socket (and the trusted load balancer). */
function run(secret: string | undefined, headers: Record<string, string>): { ip: string; headers: Record<string, unknown> } {
  const req = { headers: { ...headers } } as unknown as Request;
  Object.defineProperty(req, 'ip', { value: '10.0.0.1', configurable: true, writable: true });
  const next = jest.fn();
  visitorBehindWebProxy(secret)(req, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  return { ip: req.ip as string, headers: req.headers };
}

describe('visitorBehindWebProxy', () => {
  it("takes the visitor's address when the web app's proxy proves itself", () => {
    const { ip } = run(SECRET, { [WEB_PROXY_SECRET_HEADER]: SECRET, [WEB_PROXY_VISITOR_HEADER]: '203.0.113.9' });
    expect(ip).toBe('203.0.113.9');
  });

  it('takes the first address of a list, and IPv6 too', () => {
    expect(run(SECRET, { [WEB_PROXY_SECRET_HEADER]: SECRET, [WEB_PROXY_VISITOR_HEADER]: '203.0.113.9, 10.1.1.1' }).ip).toBe('203.0.113.9');
    expect(run(SECRET, { [WEB_PROXY_SECRET_HEADER]: SECRET, [WEB_PROXY_VISITOR_HEADER]: '2001:db8::1' }).ip).toBe('2001:db8::1');
  });

  it('ignores the visitor header with a wrong secret, or none', () => {
    expect(run(SECRET, { [WEB_PROXY_SECRET_HEADER]: `${SECRET}x`, [WEB_PROXY_VISITOR_HEADER]: '203.0.113.9' }).ip).toBe('10.0.0.1');
    expect(run(SECRET, { [WEB_PROXY_VISITOR_HEADER]: '203.0.113.9' }).ip).toBe('10.0.0.1');
  });

  it("trusts nothing when this API has no secret, or one too short to be one (an unset variable's placeholder)", () => {
    expect(run(undefined, { [WEB_PROXY_SECRET_HEADER]: SECRET, [WEB_PROXY_VISITOR_HEADER]: '203.0.113.9' }).ip).toBe('10.0.0.1');
    expect(run('$WEB_PROXY_SECRET', { [WEB_PROXY_SECRET_HEADER]: '$WEB_PROXY_SECRET', [WEB_PROXY_VISITOR_HEADER]: '203.0.113.9' }).ip).toBe('10.0.0.1');
  });

  it("ignores a visitor that isn't an address", () => {
    expect(run(SECRET, { [WEB_PROXY_SECRET_HEADER]: SECRET, [WEB_PROXY_VISITOR_HEADER]: 'not-an-ip' }).ip).toBe('10.0.0.1');
  });

  it('never passes the two headers on', () => {
    const { headers } = run(SECRET, { [WEB_PROXY_SECRET_HEADER]: SECRET, [WEB_PROXY_VISITOR_HEADER]: '203.0.113.9', accept: 'application/json' });
    expect(headers).toEqual({ accept: 'application/json' });
  });
});
