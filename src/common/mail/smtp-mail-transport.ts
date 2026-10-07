import { Logger } from '@nestjs/common';
import { createTransport, SMTPSentMessageInfo, SMTPTransportOptions, Transporter } from 'nodemailer';
import { MailMessage, MailSendResult, MailTransport } from './mail-transport.interface';

export interface SmtpSettings {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  /** The sender every message goes out as — `Hotel Bookings <bookings@yourdomain>` or a bare address. */
  from: string;
  /** Refuse to send credentials or guest mail over a connection that didn't upgrade to TLS. */
  requireTls: boolean;
}

/**
 * Any SMTP provider — Resend, Postmark, Amazon SES, Mailtrap and the rest all
 * take SMTP, so this one transport covers whichever the owner signs up with.
 * Chosen at start-up when `SMTP_HOST` is set (`CommonModule`); without it the
 * log transport stays, exactly as before.
 *
 * Port 465 is TLS from the first byte; any other port starts plain and
 * upgrades with STARTTLS, which every provider offers. Outside development a
 * server that won't upgrade is refused rather than sent the password in clear.
 */
export class SmtpMailTransport implements MailTransport {
  readonly name = 'smtp';
  private readonly logger = new Logger('MailTransport:smtp');
  private readonly transporter: Transporter<SMTPSentMessageInfo, SMTPTransportOptions>;

  constructor(private readonly settings: SmtpSettings) {
    const secure = settings.port === 465;
    this.transporter = createTransport({
      host: settings.host,
      port: settings.port,
      secure,
      requireTLS: !secure && settings.requireTls,
      auth: settings.user ? { user: settings.user, pass: settings.pass ?? '' } : undefined,
      // A provider that hangs must not hold the dispatcher's tick: the row is
      // marked failed and the next message gets its turn.
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    this.logger.log(`Sending through ${settings.host}:${settings.port} as ${settings.from}`);
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const info = await this.transporter.sendMail({
      from: this.settings.from,
      to: message.to,
      subject: message.subject,
      text: message.body,
      ...(message.html ? { html: message.html } : {}),
    });
    // One recipient per message: refused means not sent, whatever the
    // provider said about the connection.
    if (info.rejected.length > 0) {
      throw new Error(`The mail server refused ${message.to}${info.response ? ` (${info.response})` : ''}`);
    }
    return { externalMessageId: info.messageId ?? null };
  }
}

/**
 * The SMTP transport when `SMTP_HOST` is set, the log transport otherwise —
 * so connecting email is setting five environment variables, and leaving
 * them out keeps development exactly as it was.
 */
export function smtpSettingsFromEnv(env: NodeJS.ProcessEnv): SmtpSettings | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  return {
    host,
    port: env.SMTP_PORT ? Number(env.SMTP_PORT) : 587,
    user: env.SMTP_USER?.trim() || undefined,
    pass: env.SMTP_PASS || undefined,
    from: env.MAIL_FROM?.trim() ?? '',
    requireTls: env.NODE_ENV === 'production',
  };
}
