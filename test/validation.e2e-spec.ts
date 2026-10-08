import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, addDays, BranchLayout, Client, deleteOrganisation, headBrand, inTenant, lagosDay, Session, signIn, signUp, startApp } from './support/e2e';

/**
 * What the API refuses, and how — the second audit's query strings and body
 * limit, and the third audit's L1, L3, L10, L16, L23, L26.
 *
 * Each of these used to be a 500, a silently wrong record, or no limit at
 * all. Last in the file: two sign-ups racing for one email, and the
 * delete-organisation password check's own rate limit (which spends that
 * route's allowance for the rest of the file).
 */
describe('Validation and limits (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session | undefined;
  let brandId: string;
  let branch: BranchLayout;
  let guestId: string;
  const today = lagosDay(0);

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Validation');
    brandId = await headBrand(client, owner);
    branch = await addBranch(client, owner, brandId, 'Validation Branch', 2);
    const booking = await client.post(`/branches/${branch.id}/reservations`, owner, {
      guest: { name: 'Query Guest', email: `query.guest.${Date.now()}@example.com` },
      roomTypeId: branch.roomTypeId,
      checkInDate: lagosDay(5),
      checkOutDate: lagosDay(6),
      adults: 1,
    });
    guestId = (booking.body.guest?.id ?? booking.body.guestId) as string;
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it('turns a 9 MB body away with 413 and a sentence, and reads one of 200 KB (an ID photo) through to validation', async () => {
    const huge = await client.post('/auth/login', null, { email: 'x@example.com', password: 'x', padding: 'x'.repeat(9 * 1024 * 1024) });
    expect(huge.status).toBe(413);
    expect(huge.body.code).toBe('PAYLOAD_TOO_LARGE');
    // Under the limit it's parsed — and a field the route doesn't take is refused, as in production.
    const large = await client.post('/auth/login', null, { email: 'x@example.com', password: 'x', padding: 'x'.repeat(200 * 1024) });
    expect(large.status).toBe(400);
    expect(large.body.code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['an arrival date that is not a date', () => `/branches/${branch.id}/arrivals?date=garbage`],
    ['a departure date that does not exist', () => `/branches/${branch.id}/departures?date=2026-13-45`],
    ['a time on a date-only filter', () => `/branches/${branch.id}/arrivals?date=${today}T10:00:00Z`],
    ['an event calendar with no window', () => `/branches/${branch.id}/event-bookings`],
    ['an event calendar window that is not dates', () => `/branches/${branch.id}/event-bookings?from=garbage&to=garbage`],
    ['an event calendar window over a year', () => `/branches/${branch.id}/event-bookings?from=${today}&to=${addDays(today, 400)}`],
    ['a page that is not a number', () => '/guests?page=abc'],
    ['a page size of 100,000', () => '/guests?limit=100000'],
    ['a negative page size', () => '/guests?limit=-5'],
    ['a guest search with nothing to search for', () => '/guests/search'],
    ['a work-order status that does not exist', () => `/branches/${branch.id}/maintenance/work-orders?status=bogus`],
    ['a head-office report for a branch id that is not one', () => `/hq/reports?type=occupancy&from=${addDays(today, -7)}&to=${today}&branchIds=not-a-uuid`],
    ['a head-office report over 92 days', () => `/hq/reports?type=occupancy&from=${addDays(today, -200)}&to=${today}`],
    ['a bill filter that does not exist', () => `/branches/${branch.id}/folios?filter=bogus`],
    ['a bill list of 100,000', () => `/branches/${branch.id}/folios?limit=100000`],
    ['an occupancy report over a year', () => `/branches/${branch.id}/reports/occupancy?from=${addDays(today, -400)}&to=${today}`],
    ['a guest message history from a date that is not one', () => `/guests/${guestId}/communications?from=garbage`],
    ['an audit-log window given as times, not dates (was a 500)', () => `/audit-logs?from=${today}T00:00:00Z&to=${addDays(today, 1)}T00:00:00Z`],
  ])('refuses %s with a 400', async (_label, path) => {
    const res = await client.get(path(), owner);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['arrivals on a real date', () => `/branches/${branch.id}/arrivals?date=${today}`],
    ['bills a refund is due on', () => `/branches/${branch.id}/folios?filter=refund_due`],
    ['the audit log for a window of dates', () => `/audit-logs?from=${addDays(today, -1)}&to=${addDays(today, 1)}`],
  ])('answers %s', async (_label, path) => {
    expect((await client.get(path(), owner)).status).toBe(200);
  });

  it('refuses an event on 30 February (was stored as 2 March), and records who made the space', async () => {
    const space = await client.post(`/branches/${branch.id}/event-spaces`, owner, { name: 'Hall', category: 'ballroom', capacity: 100 });
    expect(space.status).toBe(201);
    const trail = await inTenant(prisma, owner!.tenantId, (tx) => tx.auditLog.findFirst({ where: { entityId: space.body.id as string } }));
    expect(trail?.userId).toBe(owner!.userId);
    const year = Number(today.slice(0, 4)) + 1;
    const book = (day: string) => client.post(`/event-spaces/${space.body.id}/bookings`, owner, { title: 'Gala', startsAt: `${year}-02-${day}T10:00:00.000Z`, endsAt: `${year}-02-${day}T12:00:00.000Z` });
    expect((await book('30')).status).toBe(400);
    expect((await book('28')).status).toBe(201);
  });

  it('takes room-type photos and the brand logo from https addresses only', async () => {
    const photo = (url: string) => client.post(`/branches/${branch.id}/room-types`, owner, { name: `Photo ${url.slice(0, 5)}`, baseRate: 10_000, capacity: { adults: 2, children: 0 }, photoUrls: [url] });
    expect((await photo('http://example.com/a.jpg')).status).toBe(400);
    expect((await photo('https://example.com/a.jpg')).status).toBe(201);
    expect((await client.patch(`/brands/${brandId}`, owner, { logoUrl: 'http://example.com/logo.png' })).status).toBe(400);
  });

  it('two sign-ups with one email at once: one account, and the other is told the email is taken (was a 500)', async () => {
    const email = `twins.${Date.now()}@example.com`;
    const password = 'Str0ngPass!1';
    const [one, two] = await Promise.all(
      ['One', 'Two'].map((n) => client.post('/auth/register', null, { groupName: `E2E Twin ${n} ${Date.now()}`, name: `Twin ${n}`, email, password, isDemo: true })),
    );
    expect([one.status, two.status].sort()).toEqual([201, 409]);
    const created = one.status === 201 ? one : two;
    const refused = created === one ? two : one;
    expect(refused.body.code).toBe('EMAIL_TAKEN');
    // Tidy up the one that was made.
    expect((await client.post('/auth/verify-email', null, { token: created.body.verificationToken })).status).toBe(200);
    expect(await deleteOrganisation(client, prisma, await signIn(client, email, password))).toBe(true);
  });

  it('allows five delete-organisation password checks per quarter hour, then refuses (was 600 a minute)', async () => {
    // Deletes so far in this file: the twin above. This one is the second.
    const gone = owner!;
    expect(await deleteOrganisation(client, prisma, gone)).toBe(true);
    owner = undefined;
    const statuses: number[] = [];
    for (let i = 0; i < 6 && !statuses.includes(429); i++) {
      statuses.push((await client.delete('/tenants/me', gone, { password: 'a wrong guess' })).status);
    }
    expect(statuses).toContain(429);
    expect(statuses.indexOf(429)).toBeLessThanOrEqual(3);
  });
});
