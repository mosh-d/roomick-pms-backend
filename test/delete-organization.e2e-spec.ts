import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ProblemJsonExceptionFilter } from '../src/common/filters/problem-json.filter';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Deleting an organisation, and taking cash, against the real database.
 *
 * The organisation is given everything a hotel accumulates in a day before
 * it's deleted: a branch with rooms, a guest checked in (a bill with a room
 * charge, a card payment, a shift with cash in its drawer) and a group
 * checked in on one master bill — the one link in the schema that closes a
 * cycle between two tables (`Reservation.billToFolioId` → Folio →
 * Reservation). Deleting used to clear five tables and trust cascades, so
 * an organisation with a guest or a booking failed halfway: users and
 * branches gone, tenant and guests left behind, and the owner's email still
 * in the sign-in index — unable to sign in and unable to sign up again.
 *
 * Self-provisions its own tenant through the real signup flow, like the
 * reservation-lifecycle suite, and removes it itself — that's the test.
 */
describe('Delete organisation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let headers: Record<string, string>;
  let tenantId: string;
  let branchId: string;
  let roomTypeId: string;
  let roomIds: string[];
  const email = `e2e-delete-${Date.now()}@example.com`;
  const password = 'Str0ngPass!1';

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
  async function del(path: string, body?: Record<string, unknown>) {
    return request(app.getHttpServer())
      .delete(`/api/v1${path}`)
      .set(headers)
      .send(body ?? {});
  }

  /** A confirmed stay for tonight, checked in to `roomId` — its primary bill's id comes back. */
  async function checkedInStay(guestName: string, roomId: string): Promise<{ reservationId: string; folioId: string }> {
    const createRes = await post(`/branches/${branchId}/reservations`, {
      guest: { name: guestName },
      roomTypeId,
      checkInDate: iso(0),
      checkOutDate: iso(2),
      adults: 1,
    });
    expect(createRes.status).toBe(201);
    const reservationId = (createRes.body as { id: string }).id;
    const checkInRes = await post(`/reservations/${reservationId}/check-in`, { roomId });
    expect(checkInRes.status).toBe(201);
    const foliosRes = await get(`/reservations/${reservationId}/folios`);
    return { reservationId, folioId: (foliosRes.body as Array<{ id: string }>)[0].id };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new ProblemJsonExceptionFilter());
    await app.init();
    prisma = app.get(PrismaService);

    const registerRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ groupName: `E2E Delete Me Hotels ${Date.now()}`, name: 'E2E Owner', email, password, isDemo: true })
      .expect(201);
    const { verificationToken } = registerRes.body as { verificationToken: string };
    await request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ token: verificationToken }).expect(200);

    const loginRes = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(200);
    const { accessToken, user } = loginRes.body as { accessToken: string; user: { tenantId: string } };
    tenantId = user.tenantId;
    headers = { Authorization: `Bearer ${accessToken}`, 'X-Tenant-Id': tenantId };

    const configureRes = await post('/tenants/configure-mode', { mode: 'single' });
    const brandId = (configureRes.body as { brand: { id: string } }).brand.id;
    const branchRes = await post(`/brands/${brandId}/branches`, {
      name: 'E2E Delete Me Branch',
      address: { street: '1 Test Street', city: 'Lagos', country: 'NG' },
      timezone: 'Africa/Lagos',
      currency: 'NGN',
    });
    branchId = (branchRes.body as { id: string }).id;
    const roomTypeRes = await post(`/branches/${branchId}/room-types`, { name: 'Standard Queen', baseRate: 45000, capacity: { adults: 2, children: 1 } });
    roomTypeId = (roomTypeRes.body as { id: string }).id;
    await post(`/branches/${branchId}/rooms/bulk`, { roomTypeId, range: { from: 101, to: 106 } });
    roomIds = ((await get(`/branches/${branchId}/rooms`)).body as Array<{ id: string }>).map((r) => r.id);
    expect(roomIds.length).toBe(6);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('cash is refused until a shift is open, then lands in that shift', async () => {
    const { folioId } = await checkedInStay('Cash Before Shift', roomIds[0]);

    const noShift = await post(`/folios/${folioId}/payments`, { amount: 20_000, method: 'cash' });
    expect(noShift.status).toBe(409);
    expect(noShift.body).toMatchObject({ code: 'SHIFT_REQUIRED' });

    const card = await post(`/folios/${folioId}/payments`, { amount: 5_000, method: 'card' });
    expect(card.status).toBe(201); // a card payment needs no drawer

    const openRes = await post(`/branches/${branchId}/shifts/open`, { shiftType: 'morning', openingFloat: 50_000 });
    expect(openRes.status).toBe(201);
    const shift = openRes.body as { id: string };
    const cash = await post(`/folios/${folioId}/payments`, { amount: 20_000, method: 'cash' });
    expect(cash.status).toBe(201);
    expect((cash.body as { shiftId: string | null }).shiftId).toBe(shift.id);
  });

  it('a group checks in on one master bill — a stay pointing at a bill whose own stay points back', async () => {
    const blockRes = await post(`/branches/${branchId}/group-blocks`, {
      name: 'E2E Conference',
      roomTypeId,
      blockSize: 2,
      blockRate: 40_000,
      arrivalDate: iso(0),
      departureDate: iso(2),
      cutoffDate: iso(0),
      contactName: 'The Organiser',
    });
    expect(blockRes.status).toBe(201);
    const blockId = (blockRes.body as { id: string }).id;

    const members: string[] = [];
    for (const name of ['Lead Guest', 'Second Guest']) {
      const res = await post(`/group-blocks/${blockId}/reservations`, { guest: { name }, adults: 1 });
      expect(res.status).toBe(201);
      members.push((res.body as { reservationId: string }).reservationId);
    }

    const checkInRes = await post(`/group-blocks/${blockId}/check-in`, {
      assignments: [
        { reservationId: members[0], roomId: roomIds[1] },
        { reservationId: members[1], roomId: roomIds[2] },
      ],
      masterBill: { leadReservationId: members[0] },
    });
    expect((checkInRes.body as { detail?: string; errors?: unknown }).detail ?? (checkInRes.body as { errors?: unknown }).errors).toBeUndefined();
    expect(checkInRes.status).toBe(201);

    const second = await prisma.withTenant(tenantId, (tx) => tx.reservation.findUniqueOrThrow({ where: { id: members[1] } }));
    expect(second.status).toBe('checked_in');
    expect(second.billToFolioId).not.toBeNull();
  });

  it('needs the owner’s own password — without it, or with the wrong one, nothing goes', async () => {
    expect((await del('/tenants/me')).status).toBe(400);
    const wrong = await del('/tenants/me', { password: 'not-my-password' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ code: 'INVALID_CREDENTIALS' });

    const stillThere = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(stillThere).not.toBeNull();
    expect(await prisma.withTenant(tenantId, (tx) => tx.reservation.count())).toBe(3);
  });

  it('with the password, the organisation and everything in it goes in one transaction, and the email is free again', async () => {
    expect((await del('/tenants/me', { password })).status).toBe(204);

    expect(await prisma.tenant.findUnique({ where: { id: tenantId } })).toBeNull();
    expect(await prisma.userEmailIndex.findUnique({ where: { email } })).toBeNull();
    const counts = await prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.user.count(),
        tx.brand.count(),
        tx.branch.count(),
        tx.room.count(),
        tx.guestProfile.count(),
        tx.reservation.count(),
        tx.folio.count(),
        tx.lineItem.count(),
        tx.payment.count(),
        tx.shift.count(),
        tx.groupBlock.count(),
        tx.auditLog.count(),
        tx.refreshToken.count(),
      ]),
    );
    expect(counts).toEqual(counts.map(() => 0));

    // The owner's access token is refused at the door now — not a 500 from a route looking up a user that's gone.
    expect((await get('/tenants/me/onboarding-status')).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password })).status).toBe(401);
  });
});
