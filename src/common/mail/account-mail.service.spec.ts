import { AccountMailService } from './account-mail.service';
import { MailTransport } from './mail-transport.interface';

function transport(name: string, send = jest.fn().mockResolvedValue({ externalMessageId: 'x' })): MailTransport & { send: jest.Mock } {
  return { name, send };
}

describe('AccountMailService', () => {
  it('without an email provider, sends nothing — not even to the log, since the bodies carry sign-in links', async () => {
    const log = transport('log');
    const mail = new AccountMailService(log);
    expect(mail.delivers).toBe(false);
    await expect(mail.passwordReset('a@x.test', 'Ada', 'https://app/reset-password?token=secret', 60)).resolves.toBe(false);
    expect(log.send).not.toHaveBeenCalled();
  });

  it('with one, says the message went', async () => {
    const smtp = transport('smtp');
    const mail = new AccountMailService(smtp);
    await expect(mail.verifyEmail('a@x.test', 'Ada', 'https://app/verify-email?token=t')).resolves.toBe(true);
    expect(smtp.send).toHaveBeenCalledWith({ to: 'a@x.test', subject: 'Confirm your email for Roomick', body: expect.stringContaining('https://app/verify-email?token=t') });
  });

  it('a provider that refuses means the link is handed over instead — not an error', async () => {
    const smtp = transport('smtp', jest.fn().mockRejectedValue(new Error('550 mailbox unavailable')));
    const mail = new AccountMailService(smtp);
    const sent = await mail.staffInvite('a@x.test', { organisation: 'Acme', branch: 'Lekki', role: 'front desk', invitedBy: 'Ada', link: 'https://app/accept-invite?token=t', expiresAt: new Date() });
    expect(sent).toBe(false);
  });

  it('says how long a reset link works, in hours once it is long', async () => {
    const smtp = transport('smtp');
    const mail = new AccountMailService(smtp);
    await mail.passwordReset('a@x.test', 'Ada', 'l', 60);
    await mail.passwordReset('a@x.test', 'Ada', 'l', 1440);
    const bodies = smtp.send.mock.calls.map((c: [{ body: string }]) => c[0].body);
    expect(bodies[0]).toContain('for 60 minutes');
    expect(bodies[1]).toContain('for 24 hours');
  });
});
