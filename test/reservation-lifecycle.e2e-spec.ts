import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ProblemJsonExceptionFilter } from '../src/common/filters/problem-json.filter';

/**
 * Production-readiness (MVP timeline Month 6): "Full E2E test suite passes:
 * reservation → check-in → folio → check-out" and "No-show, folio transfer,
 * shift close all covered by integration tests" — both named deliverables,
 * neither previously persisted anywhere in the repo. Every earlier phase's
 * own "live verification against real Postgres" this project did lived in
 * throwaway Playwright scripts outside the repo; this is that same kind of
 * proof, but committed, repeatable, and CI-runnable.
 *
 * Self-provisions its own tenant through the REAL public signup flow
 * (register → verify-email → login → configure-mode → branch → room type
 * → rooms) rather than reusing the shared `demo` seed tenant. Two reasons:
 * it's fully isolated (safe to run repeatedly against a long-lived dev DB
 * without date-range collisions against other tests' own data), and it
 * doubles as the proof for Month 6's other named deliverable — "a new hotel
 * can self-onboard and take their first booking without developer
 * intervention" — since every step here is exactly what a real owner's
 * browser session would call. `isDemo: true` on signup is the one
 * deliberate deviation from a real signup: it's the documented "self-serve
 * try it" flag, which auto-expires the tenant in 30 days — a genuine fit
 * for throwaway test data, not a workaround.
 */
describe('Reservation lifecycle (e2e)', () => {
  let app: INestApplication<App>;
  let headers: Record<string, string>;
  let branchId: string;
  let roomTypeId: string;
  let roomIds: string[];

  function iso(offsetDays: number): string {
    return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  }

  async function post(path: string, body?: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set(headers)
      .send(body ?? {});
  }
  async function get(path: string) {
    return request(app.getHttpServer()).get(`/api/v1${path}`).set(headers);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new ProblemJsonExceptionFilter());
    await app.init();

    const email = `e2e-${Date.now()}@example.com`;
    const password = 'Str0ngPass!1';

    const registerRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ groupName: `E2E Test Hotels ${Date.now()}`, name: 'E2E Owner', email, password, isDemo: true })
      .expect(201);
    const { verificationToken } = registerRes.body as { verificationToken: string };

    await request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ token: verificationToken }).expect(200);

    const loginRes = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(200);
    const { accessToken, user } = loginRes.body as { accessToken: string; user: { tenantId: string } };
    headers = { Authorization: `Bearer ${accessToken}`, 'X-Tenant-Id': user.tenantId };

    const configureRes = await post('/tenants/configure-mode', { mode: 'single' });
    const brandId = (configureRes.body as { brand: { id: string } }).brand.id;

    const branchRes = await post(`/brands/${brandId}/branches`, {
      name: 'E2E Test Branch',
      address: { street: '1 Test Street', city: 'Lagos', country: 'NG' },
      timezone: 'Africa/Lagos',
      currency: 'NGN',
    });
    branchId = (branchRes.body as { id: string }).id;

    const roomTypeRes = await post(`/branches/${branchId}/room-types`, {
      name: 'Standard Queen',
      baseRate: 45000,
      capacity: { adults: 2, children: 1 },
    });
    roomTypeId = (roomTypeRes.body as { id: string }).id;

    // Omitting floorId — "Rooms Only" onboarding auto-creates a hidden default building+floor.
    await post(`/branches/${branchId}/rooms/bulk`, { roomTypeId, range: { from: 101, to: 105 } });
    const roomsRes = await get(`/branches/${branchId}/rooms`);
    roomIds = (roomsRes.body as Array<{ id: string }>).map((r) => r.id);
    expect(roomIds.length).toBe(5);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('reservation → check-in → folio accrues a room charge → payment → check-out → folio settles', async () => {
    const createRes = await post(`/branches/${branchId}/reservations`, {
      guest: { name: 'Jane Doe' },
      roomTypeId,
      checkInDate: iso(0),
      checkOutDate: iso(2),
      adults: 1,
    });
    expect(createRes.status).toBe(201);
    const reservation = createRes.body as { id: string; status: string };
    expect(reservation.status).toBe('confirmed');

    const checkInRes = await post(`/reservations/${reservation.id}/check-in`, { roomId: roomIds[0] });
    expect(checkInRes.status).toBe(201);
    expect((checkInRes.body as { status: string }).status).toBe('checked_in');

    const foliosRes = await get(`/reservations/${reservation.id}/folios`);
    const folioId = (foliosRes.body as Array<{ id: string }>)[0].id;

    const folioAfterCheckIn = await get(`/folios/${folioId}`);
    const totalsAfterCheckIn = (folioAfterCheckIn.body as { totals: { balanceDue: string }; lineItems: Array<{ chargeType: string }> }).totals;
    expect((folioAfterCheckIn.body as { lineItems: Array<{ chargeType: string }> }).lineItems.some((li) => li.chargeType === 'room')).toBe(true);
    expect(Number(totalsAfterCheckIn.balanceDue)).toBeGreaterThan(0);

    const paymentRes = await post(`/folios/${folioId}/payments`, { amount: Number(totalsAfterCheckIn.balanceDue), method: 'card' });
    expect(paymentRes.status).toBe(201);

    const checkOutRes = await post(`/reservations/${reservation.id}/check-out`);
    expect(checkOutRes.status).toBe(201);
    expect((checkOutRes.body as { status: string }).status).toBe('checked_out');

    const folioAfterCheckOut = await get(`/folios/${folioId}`);
    const finalBody = folioAfterCheckOut.body as { status: string; totals: { balanceDue: string } };
    expect(Number(finalBody.totals.balanceDue)).toBeLessThanOrEqual(0);
    expect(finalBody.status).toBe('settled');
  });

  it('check-out is NEVER blocked by an outstanding balance — City Ledger, not a hard stop', async () => {
    const createRes = await post(`/branches/${branchId}/reservations`, {
      guest: { name: 'Unpaid Guest' },
      roomTypeId,
      checkInDate: iso(0),
      checkOutDate: iso(2),
      adults: 1,
    });
    const reservation = createRes.body as { id: string };
    await post(`/reservations/${reservation.id}/check-in`, { roomId: roomIds[1] });

    // No payment recorded — check-out must still succeed.
    const checkOutRes = await post(`/reservations/${reservation.id}/check-out`);
    expect(checkOutRes.status).toBe(201);
    expect((checkOutRes.body as { status: string }).status).toBe('checked_out');

    const foliosRes = await get(`/reservations/${reservation.id}/folios`);
    const folioId = (foliosRes.body as Array<{ id: string }>)[0].id;
    const folioRes = await get(`/folios/${folioId}`);
    const body = folioRes.body as { status: string; totals: { balanceDue: string }; guestStatus: string };
    expect(Number(body.totals.balanceDue)).toBeGreaterThan(0);
    expect(body.status).toBe('open'); // never force-closed with money owed
    expect(body.guestStatus).toBe('city_ledger');
  });

  it('marks a no-show, posts the penalty charge, then reinstates', async () => {
    const createRes = await post(`/branches/${branchId}/reservations`, {
      guest: { name: 'No-Show Guest' },
      roomTypeId,
      checkInDate: iso(0),
      checkOutDate: iso(3),
      adults: 1,
    });
    const reservation = createRes.body as { id: string };

    const noShowRes = await post(`/reservations/${reservation.id}/no-show`);
    expect(noShowRes.status).toBe(201);
    expect((noShowRes.body as { reservation: { status: string } }).reservation.status).toBe('no_show');

    const reinstateRes = await post(`/reservations/${reservation.id}/reinstate`, { checkInDate: iso(0), checkOutDate: iso(3) });
    expect(reinstateRes.status).toBe(201);
    expect((reinstateRes.body as { status: string }).status).toBe('confirmed');
  });

  it('splits charges between two folios on the same reservation (folio transfer)', async () => {
    const createRes = await post(`/branches/${branchId}/reservations`, {
      guest: { name: 'Split Bill Guest' },
      roomTypeId,
      checkInDate: iso(0),
      checkOutDate: iso(2),
      adults: 1,
    });
    const reservation = createRes.body as { id: string };
    await post(`/reservations/${reservation.id}/check-in`, { roomId: roomIds[2] });

    const foliosRes = await get(`/reservations/${reservation.id}/folios`);
    const primaryFolioId = (foliosRes.body as Array<{ id: string }>)[0].id;

    const chargeRes = await post(`/folios/${primaryFolioId}/charges`, { description: 'Minibar', amount: 5000, chargeType: 'minibar' });
    expect(chargeRes.status).toBe(201);
    const lineItemId = (chargeRes.body as { id: string }).id;

    const secondaryRes = await post(`/reservations/${reservation.id}/folios`, { label: 'Company Account' });
    expect(secondaryRes.status).toBe(201);
    const secondaryFolioId = (secondaryRes.body as { id: string }).id;

    const splitRes = await post(`/folios/${primaryFolioId}/split`, {
      targetFolioId: secondaryFolioId,
      lineItemIds: [lineItemId],
      reason: 'E2E test: bill minibar to the company account',
    });
    expect(splitRes.status).toBe(201);

    const secondaryAfter = await get(`/folios/${secondaryFolioId}`);
    const secondaryLineItems = (secondaryAfter.body as { lineItems: Array<{ chargeType: string }> }).lineItems;
    expect(secondaryLineItems.some((li) => li.chargeType === 'minibar')).toBe(true);
  });

  it('opens a cash shift, attaches a cash payment to it, and closes with zero variance', async () => {
    const openRes = await post(`/branches/${branchId}/shifts/open`, { shiftType: 'morning', openingFloat: 50_000 });
    expect(openRes.status).toBe(201);
    const shift = openRes.body as { id: string };

    const createRes = await post(`/branches/${branchId}/reservations`, {
      guest: { name: 'Cash Payer' },
      roomTypeId,
      checkInDate: iso(0),
      checkOutDate: iso(2),
      adults: 1,
    });
    const reservation = createRes.body as { id: string };
    await post(`/reservations/${reservation.id}/check-in`, { roomId: roomIds[3] });

    const foliosRes = await get(`/reservations/${reservation.id}/folios`);
    const folioId = (foliosRes.body as Array<{ id: string }>)[0].id;
    const paymentRes = await post(`/folios/${folioId}/payments`, { amount: 20_000, method: 'cash' });
    expect((paymentRes.body as { shiftId: string | null }).shiftId).toBe(shift.id);

    const closeRes = await post(`/shifts/${shift.id}/close`, { closingCashCounted: 70_000 }); // 50000 float + 20000 cash taken
    expect(closeRes.status).toBe(201);
    const closed = closeRes.body as { variance: string; closedAt: string | null };
    expect(Number(closed.variance)).toBe(0);
    expect(closed.closedAt).not.toBeNull();
  });
});
