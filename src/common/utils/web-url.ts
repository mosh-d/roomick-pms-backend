/**
 * A link into the web app, for emails: the invite, password reset and
 * verification links, and a guest's "Manage your booking".
 *
 * Built from `PUBLIC_WEB_BASE_URL` only — never from anything a request
 * carries. A link that followed the caller's Origin or Host header would let
 * someone ask for a password reset email that points at their own site.
 * Required in production (env validation); local development defaults to the
 * web app's own dev server.
 */
export function webUrl(path: string): string {
  const base = (process.env.PUBLIC_WEB_BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
