import { createHmac } from 'node:crypto';
import { lookup as dnsLookup, LookupAddress, LookupOptions } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Sending a webhook: the signature a receiver checks, and a POST that can't
 * be pointed back at this server's own network.
 *
 * A webhook's address is typed in by a customer, so without care it is a way
 * to make this server send requests to whatever it can reach that the
 * internet can't — a database, a cloud provider's metadata service. Outside
 * development every address a hostname resolves to is checked against the
 * private, loopback and link-local ranges *at connect time* (a custom DNS
 * lookup), so a name that resolves somewhere public when the webhook is saved
 * and somewhere private when it's sent is still caught. Redirects are never
 * followed, for the same reason.
 */

const PRIVATE_RANGES = (() => {
  const list = new BlockList();
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
})();

/** An IPv6 address as its eight 16-bit groups, or null if it isn't one. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

/**
 * The IPv4 address an IPv6 one carries — mapped (`::ffff:a.b.c.d`), the old
 * compatible form (`::a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`) — so it's
 * judged by where it really goes. `::` and `::1` are themselves, not IPv4.
 */
function embeddedIpv4(address: string): string | null {
  const groups = ipv6Groups(address);
  if (!groups) return null;
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  const mapped = zeros(0, 5) && groups[5] === 0xffff;
  const compatible = zeros(0, 6) && !(groups[6] === 0 && groups[7] <= 1);
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6);
  if (!mapped && !compatible && !nat64) return null;
  return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
}

/** Whether an address is one this server must never be made to call: private, loopback, link-local, reserved or multicast. */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  const family = isIP(bare);
  if (family === 4) return PRIVATE_RANGES.check(bare, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(bare);
    return v4 !== null ? PRIVATE_RANGES.check(v4, 'ipv4') : PRIVATE_RANGES.check(bare, 'ipv6');
  }
  return false;
}

/**
 * Why a webhook address can't be used, or null when it can. In production it
 * must be https, carry no username or password, and not name a private
 * address outright; in development any http(s) address is fine, so a receiver
 * on localhost can be tested.
 */
export function webhookUrlProblem(raw: string, production: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'That isn’t a web address';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'The address must start with https://';
  if (production && url.protocol !== 'https:') return 'The address must start with https:// — webhooks carry guest details';
  if (url.username || url.password) return 'Leave the username and password out of the address';
  if (production) {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || isPrivateAddress(host)) {
      return 'The address must be reachable on the internet, not a private or local one';
    }
  }
  return null;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` — what a receiver recomputes with the webhook's secret. */
export function signatureHeader(secret: string, body: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

export interface WebhookPostResult {
  ok: boolean;
  status: number | null;
  /** Why it didn't land, in words for the delivery log. */
  error: string | null;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** `dns.lookup` that refuses to hand back a private address — used by the socket itself, so there's no gap between checking and connecting. */
export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
      callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'EPRIVATEADDRESS' }), []);
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

function describeError(error: unknown, timeoutMs: number): string {
  const err = error as NodeJS.ErrnoException;
  switch (err?.code) {
    case 'EPRIVATEADDRESS':
      return 'Not sent: the address resolves to a private network';
    case 'ETIMEDOUT':
      return `No answer within ${timeoutMs / 1000} seconds`;
    case 'ECONNREFUSED':
      return 'Connection refused';
    case 'ENOTFOUND':
      return 'The address’s domain doesn’t exist';
    case 'ECONNRESET':
      return 'The connection was dropped';
    default:
      return (err?.message ?? String(error)).slice(0, 300);
  }
}

/**
 * POSTs `body` and reports what happened. Any 2xx is delivered; anything else
 * — another status, a redirect, a timeout, a refused or blocked connection —
 * is a failure with a reason. The response body is read and thrown away.
 */
export function postWebhook(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  options: { allowPrivate: boolean; timeoutMs: number },
): Promise<WebhookPostResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: WebhookPostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      resolve({ ok: false, status: null, error: 'That isn’t a web address' });
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!options.allowPrivate && (host.toLowerCase() === 'localhost' || isPrivateAddress(host))) {
      resolve({ ok: false, status: null, error: 'Not sent: the address is on a private network' });
      return;
    }

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body).toString() },
      ...(options.allowPrivate ? {} : { lookup: guardedLookup }),
    });
    // The whole exchange, not just a quiet socket: a receiver that answers one
    // byte at a time still gets cut off.
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), options.timeoutMs);

    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      if (status >= 200 && status < 300) finish({ ok: true, status, error: null });
      else if (status >= 300 && status < 400) finish({ ok: false, status, error: `HTTP ${status} — redirects aren’t followed; use the final address` });
      else finish({ ok: false, status, error: `HTTP ${status}` });
    });
    req.on('error', (error) => finish({ ok: false, status: null, error: describeError(error, options.timeoutMs) }));
    req.end(body);
  });
}
