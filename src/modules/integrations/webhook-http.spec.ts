import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { guardedLookup, isPrivateAddress, postWebhook, signatureHeader, webhookUrlProblem } from './webhook-http';

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['::1', true],
    ['::', true],
    ['[::1]', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['ff02::1', true],
    ['2001:db8::1', true],
    ['2606:4700:4700::1111', false],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['0:0:0:0:0:ffff:a00:1', true],
    ['::ffff:808:808', false],
    ['::127.0.0.1', true],
    ['64:ff9b::7f00:1', true],
    ['64:ff9b::808:808', false],
    ['example.com', false],
  ])('%s → %s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });
});

describe('webhookUrlProblem', () => {
  it('lets development use a receiver on this machine', () => {
    expect(webhookUrlProblem('http://localhost:4000/hook', false)).toBeNull();
    expect(webhookUrlProblem('http://127.0.0.1:4000/hook', false)).toBeNull();
  });

  it('wants https, and an address on the internet, in production', () => {
    expect(webhookUrlProblem('https://hooks.example.com/roomick', true)).toBeNull();
    expect(webhookUrlProblem('http://hooks.example.com/roomick', true)).toMatch(/https/);
    expect(webhookUrlProblem('https://localhost/hook', true)).toMatch(/private or local/);
    expect(webhookUrlProblem('https://10.0.0.5/hook', true)).toMatch(/private or local/);
    expect(webhookUrlProblem('https://[::ffff:7f00:1]/hook', true)).toMatch(/private or local/);
    expect(webhookUrlProblem('https://metadata.google.internal/hook', true)).toMatch(/private or local/);
  });

  it('refuses credentials in the address and anything that isn’t http(s)', () => {
    expect(webhookUrlProblem('https://user:secret@hooks.example.com/x', true)).toMatch(/username and password/);
    expect(webhookUrlProblem('ftp://hooks.example.com/x', false)).toMatch(/https:\/\//);
    expect(webhookUrlProblem('not a url', false)).toMatch(/isn’t a web address/);
  });
});

describe('signatureHeader', () => {
  it('is the HMAC-SHA256 of "<timestamp>.<body>" under the secret — what a receiver recomputes', () => {
    const body = '{"id":"evt-1","type":"reservation.created"}';
    const header = signatureHeader('s3cret', body, 1791380000);
    const expected = createHmac('sha256', 's3cret').update(`1791380000.${body}`).digest('hex');
    expect(header).toBe(`t=1791380000,v1=${expected}`);
  });
});

describe('guardedLookup', () => {
  it('refuses a name that resolves to this machine', (done) => {
    guardedLookup('localhost', {}, (error) => {
      expect(error?.code).toBe('EPRIVATEADDRESS');
      done();
    });
  });
});

describe('postWebhook', () => {
  let server: Server;
  let port: number;
  let received: Array<{ headers: IncomingMessage['headers']; body: string }>;
  let respond: (res: ServerResponse) => void;

  beforeEach(async () => {
    received = [];
    respond = (res) => res.writeHead(200).end('ok');
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        respond(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const options = { allowPrivate: true, timeoutMs: 2000 };

  it('POSTs the body as JSON with the headers given, and a 2xx is delivered', async () => {
    const result = await postWebhook(`http://127.0.0.1:${port}/hook`, '{"a":1}', { 'Roomick-Event': 'reservation.created' }, options);
    expect(result).toEqual({ ok: true, status: 200, error: null });
    expect(received[0].body).toBe('{"a":1}');
    expect(received[0].headers['content-type']).toBe('application/json');
    expect(received[0].headers['roomick-event']).toBe('reservation.created');
  });

  it('anything else is a failure with the status', async () => {
    respond = (res) => res.writeHead(500).end('boom');
    expect(await postWebhook(`http://127.0.0.1:${port}/hook`, '{}', {}, options)).toEqual({ ok: false, status: 500, error: 'HTTP 500' });
  });

  it('never follows a redirect', async () => {
    respond = (res) => res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }).end();
    const result = await postWebhook(`http://127.0.0.1:${port}/hook`, '{}', {}, options);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/redirects aren’t followed/);
    expect(received).toHaveLength(1);
  });

  it('gives up on a receiver that doesn’t answer in time', async () => {
    respond = () => undefined;
    const result = await postWebhook(`http://127.0.0.1:${port}/hook`, '{}', {}, { allowPrivate: true, timeoutMs: 300 });
    expect(result).toEqual({ ok: false, status: null, error: 'No answer within 0.3 seconds' });
  });

  it('outside development, never calls a private address', async () => {
    const result = await postWebhook(`http://127.0.0.1:${port}/hook`, '{}', {}, { allowPrivate: false, timeoutMs: 2000 });
    expect(result).toEqual({ ok: false, status: null, error: 'Not sent: the address is on a private network' });
    const byName = await postWebhook(`http://localhost:${port}/hook`, '{}', {}, { allowPrivate: false, timeoutMs: 2000 });
    expect(byName.ok).toBe(false);
    expect(received).toHaveLength(0);
  });
});
