import { BadRequestException } from '@nestjs/common';
import { ErrorCode } from '../../../common/errors/error-codes';

/**
 * Review requests: some hours after a guest checks out, an email thanking
 * them and linking to the property's review page (Google, TripAdvisor, or
 * wherever the hotel wants reviews). Sent through the ordinary comms outbox,
 * attached to the stay it's about.
 */

/** The trigger every review request is logged as — one per stay. */
export const REVIEW_REQUEST_TRIGGER = 'review_request';

export const REVIEW_PLACEHOLDERS = ['guest_first_name', 'hotel_name', 'review_url'] as const;

/**
 * Only stays that ended in the last fortnight are asked. Without a bound,
 * switching this on would email every guest the property has ever had.
 * (Stays that ended before it was switched on aren't asked either — the sweep
 * also starts from `enabledAt`.)
 */
export const REVIEW_LOOKBACK_DAYS = 14;

export interface ReviewRequestConfig {
  /** Hours after check-out before the email goes: long enough to be home, soon enough to remember. */
  delayHours: number;
  /** The review page per property, by branch id. A property with no link is never asked for. */
  links: Record<string, string>;
  subject: string;
  message: string;
}

export const DEFAULT_REVIEW_REQUEST: Omit<ReviewRequestConfig, 'links'> = {
  delayHours: 24,
  subject: 'Thank you for staying at {{hotel_name}}',
  message:
    'Hello {{guest_first_name}},\n\nThank you for staying with us at {{hotel_name}}. If you have a minute, we would be grateful if you could tell others about your stay:\n\n{{review_url}}\n\nWe hope to welcome you back soon.',
};

function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: ErrorCode.VALIDATION_FAILED, message });
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function assertPlaceholders(text: string, label: string): void {
  const unknown = [...text.matchAll(PLACEHOLDER)].map((match) => match[1]).filter((name) => !(REVIEW_PLACEHOLDERS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw invalid(`The ${label} uses ${unknown.map((name) => `{{${name}}}`).join(', ')}, which doesn't exist. Available: ${REVIEW_PLACEHOLDERS.map((name) => `{{${name}}}`).join(', ')}`);
  }
}

/** Parsed on every write and every read: the sweep only ever acts on settings that pass here. */
export function parseReviewRequestConfig(value: unknown, knownBranchIds: readonly string[]): ReviewRequestConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('Review request settings must be an object');
  const raw = value as Record<string, unknown>;

  const delayHours = Number(raw.delayHours);
  if (!Number.isInteger(delayHours) || delayHours < 1 || delayHours > 168) throw invalid('Send the request between 1 and 168 hours (a week) after check-out');

  const linksRaw = raw.links;
  if (linksRaw === null || typeof linksRaw !== 'object' || Array.isArray(linksRaw)) throw invalid('Add the review page for at least one property');
  const links: Record<string, string> = {};
  for (const [branchId, url] of Object.entries(linksRaw as Record<string, unknown>)) {
    if (url === null || url === undefined || url === '') continue;
    if (!knownBranchIds.includes(branchId)) throw invalid('A review link points at a property that doesn’t exist');
    if (typeof url !== 'string' || url.length > 500) throw invalid('A review link must be a web address under 500 characters');
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw invalid(`“${url}” isn’t a web address`);
    }
    // https only: this lands in a guest's inbox as a link from the hotel.
    if (parsed.protocol !== 'https:') throw invalid('Review links must start with https://');
    links[branchId] = parsed.toString();
  }
  if (Object.keys(links).length === 0) throw invalid('Add the review page for at least one property');

  const subject = typeof raw.subject === 'string' ? raw.subject.trim() : '';
  const message = typeof raw.message === 'string' ? raw.message.trim() : '';
  if (subject.length < 3 || subject.length > 200) throw invalid('The subject needs 3 to 200 characters');
  if (message.length < 10 || message.length > 5000) throw invalid('The message needs 10 to 5,000 characters');
  assertPlaceholders(subject, 'subject');
  assertPlaceholders(message, 'message');
  // Without the link the email asks for a review and gives no way to leave one.
  if (![...message.matchAll(PLACEHOLDER)].some((match) => match[1] === 'review_url')) throw invalid('The message must include {{review_url}}');

  return { delayHours, links, subject, message };
}

export function renderReviewRequest(
  config: Pick<ReviewRequestConfig, 'subject' | 'message'>,
  values: { guestName: string; hotelName: string; reviewUrl: string },
): { subject: string; body: string } {
  const firstName = values.guestName.trim().split(/\s+/)[0] || values.guestName;
  const fill = (text: string) =>
    text.replace(PLACEHOLDER, (whole, name: string) =>
      name === 'guest_first_name' ? firstName : name === 'hotel_name' ? values.hotelName : name === 'review_url' ? values.reviewUrl : whole,
    );
  return { subject: fill(config.subject), body: fill(config.message) };
}

/**
 * The window of check-outs one sweep asks about: ended at least `delayHours`
 * ago, but not before the integration was switched on and not more than
 * REVIEW_LOOKBACK_DAYS ago. `from` can pass `to` right after it's switched on
 * — that simply means nobody is due yet.
 */
export function reviewWindow(now: Date, enabledAt: Date, delayHours: number): { from: Date; to: Date } {
  const lookback = new Date(now.getTime() - REVIEW_LOOKBACK_DAYS * 86_400_000);
  return {
    from: enabledAt > lookback ? enabledAt : lookback,
    to: new Date(now.getTime() - delayHours * 3_600_000),
  };
}
