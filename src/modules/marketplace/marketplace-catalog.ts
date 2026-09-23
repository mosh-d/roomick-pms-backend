/**
 * The Integrations Marketplace's catalogue (Month 11).
 *
 * In code, not in a table, on purpose: a listing is only honest if there is
 * code behind it, so adding one is a code change by definition. The growth
 * plan asks for "the browsing/enable experience, not 400 real connectors" —
 * so this is a small list where every "available" entry really works end to
 * end, and everything else says plainly what it's waiting on instead of
 * offering an Enable button that does nothing.
 */

export const MARKETPLACE_CATEGORIES = {
  accounting: 'Accounting',
  marketing_reputation: 'Marketing & Reputation',
  channel_manager: 'Channel Manager',
  payments: 'Payments',
  automation: 'Automation',
  access_locks: 'Door Locks & Access',
} as const;
export type MarketplaceCategory = keyof typeof MARKETPLACE_CATEGORIES;

/** The connectors that can be switched on. Everything configurable is keyed by one of these. */
export const AVAILABLE_PROVIDERS = ['quickbooks_online', 'xero', 'review_requests'] as const;
export type AvailableProvider = (typeof AVAILABLE_PROVIDERS)[number];

export interface CatalogEntry {
  key: string;
  name: string;
  vendor: string;
  category: MarketplaceCategory;
  summary: string;
  /** How it actually works, in a sentence or two — including what it does NOT do. */
  howItWorks: string;
  availability: 'available' | 'coming_later';
  /** Only for `coming_later`: what it's waiting on. */
  waitingOn?: string;
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    key: 'quickbooks_online',
    name: 'QuickBooks Online',
    vendor: 'Intuit',
    category: 'accounting',
    summary: 'Each day’s takings as a journal entry — revenue by department, tax, and payments by method.',
    howItWorks:
      'You map each department and payment method to an account once, then download a file for any date range and import it with QuickBooks’ own journal-entry import. It isn’t a live connection: nothing is sent to QuickBooks until you import the file.',
    availability: 'available',
  },
  {
    key: 'xero',
    name: 'Xero',
    vendor: 'Xero',
    category: 'accounting',
    summary: 'Each day’s takings as a manual journal — revenue by department, tax, and payments by method.',
    howItWorks:
      'You map each department and payment method to an account code once, then download a file for any date range and import it through Xero’s manual-journal import. It isn’t a live connection: nothing reaches Xero until you import the file.',
    availability: 'available',
  },
  {
    key: 'review_requests',
    name: 'Review Requests',
    vendor: 'Google, TripAdvisor and any review site',
    category: 'marketing_reputation',
    summary: 'A thank-you email after check-out, with a link to leave a review.',
    howItWorks:
      'Add each property’s review page and choose how long after check-out to ask. Every guest with an email address gets one request per stay, from stays that end after you switch it on. Guests who unsubscribed from your emails aren’t asked.',
    availability: 'available',
  },
  {
    key: 'channel_manager',
    name: 'Channel Manager',
    vendor: 'Booking.com, Expedia, Airbnb',
    category: 'channel_manager',
    summary: 'Rates and availability pushed to online travel agents, and their bookings pulled in.',
    howItWorks: 'Connects through a channel-manager aggregator, so no OTA has to be integrated one by one.',
    availability: 'coming_later',
    waitingOn: 'An account with a channel-manager aggregator. Your own booking page already takes direct bookings.',
  },
  {
    key: 'stripe',
    name: 'Stripe Payments',
    vendor: 'Stripe',
    category: 'payments',
    summary: 'Card payments, cards on file and pre-authorisation holds, without card numbers touching Roomick.',
    howItWorks: 'Cards are entered in Stripe’s own secure form; Roomick only ever holds Stripe’s token.',
    availability: 'coming_later',
    waitingOn: 'The payments build, which needs a Stripe account’s keys.',
  },
  {
    key: 'webhooks',
    name: 'Zapier, Make & Webhooks',
    vendor: 'Zapier, Make, or your own systems',
    category: 'automation',
    summary: 'Booking, check-in, check-out and payment events sent to other apps as they happen.',
    howItWorks: 'Webhook subscriptions can already be created under Integrations & APIs.',
    availability: 'coming_later',
    waitingOn: 'Event delivery: subscriptions are saved, but no events are sent to them yet.',
  },
  {
    key: 'smart_locks',
    name: 'Smart Locks & Key Cards',
    vendor: 'Assa Abloy, Salto and similar',
    category: 'access_locks',
    summary: 'Room keys issued at check-in and cancelled at check-out.',
    howItWorks: 'Each lock vendor has its own system, so this is built for a specific vendor.',
    availability: 'coming_later',
    waitingOn: 'A lock vendor to be chosen.',
  },
];

export function catalogEntry(key: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.key === key);
}

export function isAvailableProvider(key: string): key is AvailableProvider {
  return (AVAILABLE_PROVIDERS as readonly string[]).includes(key);
}
