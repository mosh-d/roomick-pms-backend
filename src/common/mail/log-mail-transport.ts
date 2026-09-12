import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MailMessage, MailSendResult, MailTransport } from './mail-transport.interface';

/**
 * The development default: writes the message to the application log and
 * reports success. Nothing leaves the machine.
 *
 * This is deliberately NOT a silent no-op. A silent one would let the whole
 * pipeline report `sent` while a developer had no way to see what a guest
 * would actually have received — the exact failure mode where broken copy or
 * a wrong recipient ships unnoticed. Logging the real recipient, subject and
 * body makes the outbox observable end-to-end without any provider account.
 *
 * It also means `deliveryStatus` becomes honest: a row reaching `sent` under
 * this transport genuinely did reach the configured destination, which just
 * happens to be the log. Swapping in a real provider changes the destination,
 * not the semantics.
 */
@Injectable()
export class LogMailTransport implements MailTransport {
  readonly name = 'log';
  private readonly logger = new Logger('MailTransport:log');

  send(message: MailMessage): Promise<MailSendResult> {
    this.logger.log(`[no provider configured — logged only] to=${message.to} subject=${JSON.stringify(message.subject)}`);
    this.logger.debug(message.body);
    // A synthetic id keeps `externalMessageId` non-null and uniformly shaped
    // across transports; the `log:` prefix makes it obvious it isn't a real
    // provider reference if one ever turns up in a support conversation.
    return Promise.resolve({ externalMessageId: `log:${randomUUID()}` });
  }
}
