import { AddressInfo, createServer, Server, Socket } from 'node:net';
import { SmtpMailTransport, smtpSettingsFromEnv } from './smtp-mail-transport';

interface Received {
  from: string;
  to: string[];
  data: string;
}

/** Just enough SMTP to accept a message: no TLS, no auth, refuses any recipient at `refused.example`. */
function smtpSink(): Promise<{ server: Server; port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((socket: Socket) => {
    let current: Received = { from: '', to: [], data: '' };
    let inData = false;
    let buffer = '';
    socket.write('220 sink ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push(current);
          current = { from: '', to: [], data: '' };
          socket.write('250 OK queued as sink-1\r\n');
          continue;
        }
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-sink\r\n250 OK\r\n');
        else if (verb === 'MAIL') {
          current.from = line;
          socket.write('250 OK\r\n');
        } else if (verb === 'RCPT') {
          if (line.includes('@refused.example')) socket.write('550 No such user\r\n');
          else {
            current.to.push(line);
            socket.write('250 OK\r\n');
          }
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'QUIT') {
          socket.end('221 Bye\r\n');
        } else socket.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, received })));
}

describe('SmtpMailTransport', () => {
  let sink: Awaited<ReturnType<typeof smtpSink>>;

  beforeEach(async () => {
    sink = await smtpSink();
  });
  afterEach(() => new Promise<void>((resolve) => sink.server.close(() => resolve())));

  const transport = () => new SmtpMailTransport({ host: '127.0.0.1', port: sink.port, from: 'Lekki Suites <bookings@lekki.example>', requireTls: false });

  it('hands the message to the server as the configured sender, with both parts when there is HTML', async () => {
    const result = await transport().send({ to: 'ada@guest.example', subject: 'Reservation Confirmed — RES-1', body: 'Your stay is confirmed.', html: '<p>Your stay is confirmed.</p>' });

    expect(result.externalMessageId).toMatch(/^<.+>$/);
    expect(sink.received).toHaveLength(1);
    const [message] = sink.received;
    expect(message.from).toContain('<bookings@lekki.example>');
    expect(message.to).toEqual([expect.stringContaining('<ada@guest.example>')]);
    expect(message.data).toContain('From: Lekki Suites <bookings@lekki.example>');
    expect(message.data).toContain('Subject: =?UTF-8?Q?Reservation_Confirmed_=E2=80=94_RES-1?=');
    expect(message.data).toContain('Content-Type: multipart/alternative');
    expect(message.data).toContain('Your stay is confirmed.');
  });

  it('sends text only when there is no HTML', async () => {
    await transport().send({ to: 'ada@guest.example', subject: 'Welcome', body: 'Checked in to room 101.' });
    expect(sink.received[0].data).toContain('Content-Type: text/plain');
    expect(sink.received[0].data).not.toContain('multipart/alternative');
  });

  it('fails when the server refuses the recipient, so the dispatcher marks the message failed', async () => {
    await expect(transport().send({ to: 'nobody@refused.example', subject: 'Hello', body: 'Hi' })).rejects.toThrow();
    expect(sink.received).toHaveLength(0);
  });
});

describe('smtpSettingsFromEnv', () => {
  it('is off without SMTP_HOST — the log transport stays', () => {
    expect(smtpSettingsFromEnv({ NODE_ENV: 'production', MAIL_FROM: 'a@b.example' })).toBeNull();
    expect(smtpSettingsFromEnv({ SMTP_HOST: '  ' })).toBeNull();
  });

  it('defaults to port 587 and requires TLS in production only', () => {
    expect(smtpSettingsFromEnv({ SMTP_HOST: 'smtp.resend.com', SMTP_USER: 'resend', SMTP_PASS: 'key', MAIL_FROM: 'bookings@lekki.example', NODE_ENV: 'production' })).toEqual({
      host: 'smtp.resend.com',
      port: 587,
      user: 'resend',
      pass: 'key',
      from: 'bookings@lekki.example',
      requireTls: true,
    });
    expect(smtpSettingsFromEnv({ SMTP_HOST: 'localhost', SMTP_PORT: '2525', MAIL_FROM: 'x@y.example', NODE_ENV: 'development' })).toMatchObject({ port: 2525, requireTls: false, user: undefined });
  });
});
