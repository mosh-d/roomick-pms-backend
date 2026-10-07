import { Inject, Injectable, Logger } from '@nestjs/common';
import { MAIL_TRANSPORT, MailTransport } from './mail-transport.interface';

/**
 * The emails about someone's own account — verifying the owner's address at
 * sign-up, a staff invitation, a password reset. Sent straight away through
 * the configured transport, after the database work has committed; unlike a
 * guest message there's no outbox, because the person is waiting on it.
 *
 * Each send says whether the message really left: `false` when no email
 * provider is set up (the log transport only writes it down) or the provider
 * refused it. The caller then shows the link on screen to hand over instead.
 */
@Injectable()
export class AccountMailService {
  private readonly logger = new Logger(AccountMailService.name);

  constructor(@Inject(MAIL_TRANSPORT) private readonly transport: MailTransport) {}

  /** Whether email reaches anyone — false until an SMTP provider is set up. */
  get delivers(): boolean {
    return this.transport.name !== 'log';
  }

  async verifyEmail(to: string, name: string, link: string): Promise<boolean> {
    return this.send(to, 'Confirm your email for Roomick', [
      `Hello ${name},`,
      '',
      'Confirm this is your email address to finish setting up your Roomick account:',
      link,
      '',
      'The link works for 72 hours. If you didn’t sign up for Roomick, ignore this email.',
    ]);
  }

  async staffInvite(to: string, details: { organisation: string; branch: string; role: string; invitedBy: string | null; link: string; expiresAt: Date }): Promise<boolean> {
    return this.send(to, `You’re invited to ${details.organisation} on Roomick`, [
      'Hello,',
      '',
      `${details.invitedBy ?? 'Your manager'} has invited you to work at ${details.branch} (${details.organisation}) as ${details.role}.`,
      'Open this link to set up your account:',
      details.link,
      '',
      `The invitation expires on ${details.expiresAt.toUTCString()}.`,
    ]);
  }

  async passwordReset(to: string, name: string, link: string, validForMinutes: number): Promise<boolean> {
    return this.send(to, 'Reset your Roomick password', [
      `Hello ${name},`,
      '',
      'Open this link to choose a new password:',
      link,
      '',
      `The link works once, for ${validForMinutes >= 120 ? `${Math.round(validForMinutes / 60)} hours` : `${validForMinutes} minutes`}. If you didn’t ask for this, ignore this email — your password stays as it is.`,
    ]);
  }

  private async send(to: string, subject: string, lines: string[]): Promise<boolean> {
    if (!this.delivers) {
      // Not handed to the log transport: these bodies carry sign-in links,
      // and a link written to the server log is a link anyone reading the log
      // can use. The person gets it on screen instead.
      this.logger.log(`No email provider set up — “${subject}” for ${to} wasn’t sent`);
      return false;
    }
    try {
      await this.transport.send({ to, subject, body: lines.join('\n') });
      return true;
    } catch (err) {
      // The account change has happened; the person gets the link on screen instead.
      this.logger.error(`Couldn’t email ${to}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
