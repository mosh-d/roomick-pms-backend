/**
 * Where an outbound message actually goes. Mirrors the adapter pattern this
 * codebase already uses for `DocumentStorageAdapter` and `BackupStorageAdapter`
 * — one narrow interface, a local/no-op implementation for development, and a
 * real provider dropped in behind the same DI token without any calling code
 * changing.
 *
 * The transport moves bytes only. It never decides WHETHER to send, what the
 * content is, or what to record — `CommsDispatcherService` owns all of that.
 */
export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. Always present — it is the fallback for a client that won't render HTML. */
  body: string;
  /**
   * The HTML alternative, when the message has one (marketing campaigns
   * render both; every transactional message is text only). A transport that
   * can't send multipart should send `body` and ignore this rather than
   * deliver markup as text.
   */
  html?: string;
}

export interface MailSendResult {
  /** The provider's own id for the message, stored on `CommunicationLog.externalMessageId` for later correlation with bounces/opens. */
  externalMessageId: string | null;
}

export interface MailTransport {
  /**
   * Resolves on a successful hand-off to the provider, throws otherwise.
   *
   * "Sent" here means accepted by the provider, NOT delivered to a mailbox —
   * those are genuinely different states, which is why `DeliveryStatus` has
   * both `sent` and `delivered`. Only a provider webhook can report the
   * latter, so nothing in this app sets `delivered` yet.
   */
  send(message: MailMessage): Promise<MailSendResult>;

  /** Shown in logs and in the System Admin health view so it's obvious which transport is live. */
  readonly name: string;
}

export const MAIL_TRANSPORT = 'MAIL_TRANSPORT';
