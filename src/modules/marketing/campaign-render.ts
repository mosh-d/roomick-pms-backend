import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Turning a saved template into the two things a mail client receives — a
 * plain-text part and an HTML part — plus the three links that make a
 * campaign measurable. All of it is pure: no database, no clock, no config,
 * so the exact bytes a guest would get can be asserted in a test.
 *
 * A template is authored as PLAIN TEXT. The HTML part is generated from it
 * (escaped, paragraphed, links turned into anchors, tracking pixel appended)
 * rather than hand-written, which keeps the builder to "write your message"
 * and makes it impossible to author markup that renders as text or vice
 * versa.
 */

export interface MergeField {
  token: string;
  label: string;
  /** What the preview substitutes, so a draft can be read before any real guest exists. */
  example: string;
}

/**
 * Every placeholder that resolves. A template is rejected at save time if it
 * uses anything else — an unresolved `{{first_name}}` would otherwise reach a
 * guest verbatim, and a marketing email with a visible merge field in it is
 * worse than no email.
 */
export const MERGE_FIELDS: readonly MergeField[] = [
  { token: 'guest_name', label: "The guest's full name", example: 'Kemi Adeyemi' },
  { token: 'guest_first_name', label: "The guest's first name", example: 'Kemi' },
  { token: 'hotel_name', label: 'The property sending the campaign', example: 'Lekki Palms Hotel' },
  { token: 'loyalty_tier', label: "The guest's loyalty tier, or “Member”", example: 'Silver' },
  { token: 'loyalty_points', label: "The guest's current points balance", example: '550' },
  { token: 'unsubscribe_url', label: 'The unsubscribe link (added to the footer if you leave it out)', example: 'https://example.com/unsubscribe' },
];

export interface MergeContext {
  guest_name: string;
  guest_first_name: string;
  hotel_name: string;
  loyalty_tier: string;
  loyalty_points: string;
  unsubscribe_url: string;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
/** Bare URLs in plain text. Trailing sentence punctuation is deliberately excluded from the match. */
const URL_PATTERN = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;

/** The placeholders a draft uses that don't exist — named back to the author, not silently dropped. */
export function unknownMergeFields(text: string): string[] {
  const known = new Set(MERGE_FIELDS.map((field) => field.token));
  const unknown = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (!known.has(match[1])) unknown.add(match[1]);
  }
  return [...unknown];
}

/** Substitutes every known placeholder. Unknown ones are left untouched — `unknownMergeFields` is what refuses them, at save time. */
export function renderMergeFields(text: string, context: MergeContext): string {
  return text.replace(PLACEHOLDER, (whole, token: string) => (token in context ? context[token as keyof MergeContext] : whole));
}

/** Does the author's own body already place the unsubscribe link itself? If not, one is appended. */
export function hasUnsubscribeField(text: string): boolean {
  return [...text.matchAll(PLACEHOLDER)].some((match) => match[1] === 'unsubscribe_url');
}

// ---------------------------------------------------------------------------
// Click tracking
// ---------------------------------------------------------------------------

/**
 * A click link carries the destination in its own query string, which would
 * make the redirect an open redirect for anyone who could edit it — a real
 * one, on a public unauthenticated route, reachable by editing a URL out of
 * an email. So the destination is signed and the signature is checked before
 * anything is redirected anywhere.
 *
 * The signature is keyed per recipient token as well as per URL: lifting a
 * signed destination out of one guest's email and pasting it into another's
 * link doesn't verify.
 */
export function signTarget(token: string, target: string, secret: string): string {
  return createHmac('sha256', secret).update(`${token}\n${target}`).digest('hex').slice(0, 32);
}

export function verifyTarget(token: string, target: string, signature: string, secret: string): boolean {
  const expected = signTarget(token, target, secret);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export interface TrackingUrls {
  /** `<base>/public/marketing/open/<token>.gif` */
  pixelUrl: string;
  /** `<base>/public/marketing/unsubscribe/<token>` */
  unsubscribeUrl: string;
  /** Wraps one destination in a signed click-through. */
  clickUrlFor: (target: string) => string;
}

export function trackingUrlsFor(baseUrl: string, token: string, secret: string): TrackingUrls {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    pixelUrl: `${base}/api/v1/public/marketing/open/${token}.gif`,
    unsubscribeUrl: `${base}/api/v1/public/marketing/unsubscribe/${token}`,
    clickUrlFor: (target) =>
      `${base}/api/v1/public/marketing/click/${token}?u=${encodeURIComponent(target)}&s=${signTarget(token, target, secret)}`,
  };
}

// ---------------------------------------------------------------------------
// The two parts
// ---------------------------------------------------------------------------

export interface RenderedMessage {
  /** What the guest's own comms history shows, and the fallback part of the email. */
  text: string;
  /** What a mail client renders — the only part that can carry the open pixel. */
  html: string;
}

/**
 * The finished message for one recipient: merge fields resolved, every link
 * rewritten to go through the click redirect, an unsubscribe line guaranteed
 * to be present, and (HTML only) the open pixel.
 *
 * Link rewriting happens AFTER the merge fields resolve, so a URL that came
 * in through a placeholder is tracked too — and the unsubscribe link is
 * substituted last and never rewritten, because routing an opt-out through a
 * click-tracker would record a "click" for someone leaving.
 */
export function renderForRecipient(body: string, context: Omit<MergeContext, 'unsubscribe_url'>, tracking: TrackingUrls): RenderedMessage {
  // A private-use character pair, not a word: it has to be impossible in real
  // copy, or a template saying "click to unsubscribe" would lose the word.
  const UNSUBSCRIBE_MARKER = '\uE000unsubscribe\uE000';
  const merged = renderMergeFields(body, { ...context, unsubscribe_url: UNSUBSCRIBE_MARKER });
  const tracked = merged.replace(URL_PATTERN, (url) => tracking.clickUrlFor(url));
  const withUnsubscribe = tracked.split(UNSUBSCRIBE_MARKER).join(tracking.unsubscribeUrl);
  const needsFooter = !hasUnsubscribeField(body);

  const text = needsFooter
    ? `${withUnsubscribe.trimEnd()}\n\n—\nYou're receiving this because you asked ${context.hotel_name} to send you offers. To stop: ${tracking.unsubscribeUrl}`
    : withUnsubscribe;

  return { text, html: toHtml(withUnsubscribe, context.hotel_name, tracking, needsFooter) };
}

/**
 * Plain text to a simple, deliberately boring email document: blank lines
 * become paragraphs, single newlines become breaks, URLs become anchors.
 * No table layout, no web fonts, no images beyond the pixel — every mail
 * client from Outlook to Gmail renders this the same way, which a
 * hand-rolled HTML template cannot be trusted to do.
 */
function toHtml(text: string, hotelName: string, tracking: TrackingUrls, needsFooter: boolean): string {
  const paragraphs = text
    .trimEnd()
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 16px">${linkify(block).split('\n').join('<br />')}</p>`)
    .join('\n      ');

  const footer = needsFooter
    ? `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e5e5e5;color:#767676;font-size:12px">You're receiving this because you asked ${escapeHtml(hotelName)} to send you offers. <a href="${escapeHtml(tracking.unsubscribeUrl)}" style="color:#767676">Unsubscribe</a>.</p>`
    : '';

  // The pixel is last, hidden, and alt-less: it is not content, and a client
  // that blocks remote images simply doesn't report the open — which is why
  // an open rate is a floor, never a headcount.
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f5f5f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1917;font-size:15px;line-height:1.6">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:28px">
      ${paragraphs}
      ${footer}
    </div>
    <img src="${escapeHtml(tracking.pixelUrl)}" width="1" height="1" alt="" style="display:none" />
  </body>
</html>`;
}

function linkify(block: string): string {
  let out = '';
  let lastIndex = 0;
  for (const match of block.matchAll(URL_PATTERN)) {
    const url = match[0];
    const start = match.index ?? 0;
    out += escapeHtml(block.slice(lastIndex, start));
    out += `<a href="${escapeHtml(url)}" style="color:#0f766e">${escapeHtml(url)}</a>`;
    lastIndex = start + url.length;
  }
  return out + escapeHtml(block.slice(lastIndex));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/**
 * The A/B split, as an exact division rather than a coin toss per recipient:
 * a 50/50 test on 10 guests gives 5 and 5, not "about half". A random draw
 * on an audience this size can land 8/2 and make the result unreadable.
 */
export function variantFor(index: number, total: number, splitRatio: number | null): 'A' | 'B' {
  if (splitRatio === null) return 'A';
  const onA = Math.max(1, Math.min(total - 1, Math.round(total * splitRatio)));
  return index < onA ? 'A' : 'B';
}
