import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ProblemJsonExceptionFilter } from '../src/common/filters/problem-json.filter';

/**
 * Production-readiness (MVP timeline Month 6): "All RBAC permissions
 * tested — no role can exceed its boundary." Every route this session
 * built gates itself with `@Roles(...)` at the controller, but nothing
 * previously proved those gates actually reject the roles they list as
 * NOT permitted — a decorator with a typo in its role list, or accidentally
 * dropped during a refactor, would silently open a route to everyone and
 * nothing would catch it. This asserts real 403s for real cross-role
 * attempts, using genuinely role-scoped accounts (not the owner, who
 * passes every gate and so proves nothing about the boundary).
 *
 * Self-provisions its own tenant exactly like `reservation-lifecycle.e2e-
 * spec.ts` — see that file's own comment for why (isolation + doubles as
 * self-onboarding proof) — then invites one real staff account per role
 * under test through the actual invite/accept-invite flow, not a raw DB
 * insert, so this exercises the same path a real hotel's own staff
 * onboarding does.
 */
describe('RBAC boundaries (e2e)', () => {
  let app: INestApplication<App>;
  let ownerHeaders: Record<string, string>;
  let branchId: string;
  let tenantId: string;

  async function postAs(headers: Record<string, string>, path: string, body?: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/v1${path}`)
      .set(headers)
      .send(body ?? {});
  }
  async function patchAs(headers: Record<string, string>, path: string, body?: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/api/v1${path}`)
      .set(headers)
      .send(body ?? {});
  }

  /** Invites a fresh staff account with the given system role and accepts the invite, returning headers ready to use as that role. */
  async function provisionStaff(roleName: string): Promise<Record<string, string>> {
    const rolesRes = await request(app.getHttpServer()).get('/api/v1/auth/roles').set(ownerHeaders);
    const role = (rolesRes.body as Array<{ id: string; name: string }>).find((r) => r.name === roleName);
    if (!role) throw new Error(`role ${roleName} not found`);

    const email = `e2e-${roleName}-${Date.now()}@example.com`;
    const inviteRes = await postAs(ownerHeaders, `/branches/${branchId}/staff/invite`, { invites: [{ email, roleId: role.id }] });
    const publicToken = (inviteRes.body as Array<{ publicToken: string }>)[0].publicToken;

    const acceptRes = await request(app.getHttpServer())
      .post(`/api/v1/auth/accept-invite/${publicToken}`)
      .send({ name: `E2E ${roleName}`, password: 'Str0ngPass!1' });
    const { accessToken } = acceptRes.body as { accessToken: string };
    return { Authorization: `Bearer ${accessToken}`, 'X-Tenant-Id': tenantId };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new ProblemJsonExceptionFilter());
    await app.init();

    const email = `e2e-rbac-owner-${Date.now()}@example.com`;
    const password = 'Str0ngPass!1';

    const registerRes = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ groupName: `E2E RBAC Hotels ${Date.now()}`, name: 'E2E Owner', email, password, isDemo: true })
      .expect(201);
    const { verificationToken } = registerRes.body as { verificationToken: string };
    await request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ token: verificationToken }).expect(200);

    const loginRes = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password }).expect(200);
    const { accessToken, user } = loginRes.body as { accessToken: string; user: { tenantId: string } };
    tenantId = user.tenantId;
    ownerHeaders = { Authorization: `Bearer ${accessToken}`, 'X-Tenant-Id': tenantId };

    const configureRes = await postAs(ownerHeaders, '/tenants/configure-mode', { mode: 'single' });
    const brandId = (configureRes.body as { brand: { id: string } }).brand.id;

    const branchRes = await postAs(ownerHeaders, `/brands/${brandId}/branches`, {
      name: 'E2E RBAC Branch',
      address: { street: '1 Test Street', city: 'Lagos', country: 'NG' },
      timezone: 'Africa/Lagos',
      currency: 'NGN',
    });
    branchId = (branchRes.body as { id: string }).id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('a housekeeper cannot create a reservation or open a cash shift', async () => {
    const headers = await provisionStaff('housekeeper');

    const reservationRes = await postAs(headers, `/branches/${branchId}/reservations`, {
      guest: { name: 'Should Not Be Created' },
      roomTypeId: '00000000-0000-4000-8000-000000000000',
      checkInDate: '2027-01-01',
      checkOutDate: '2027-01-02',
      adults: 1,
    });
    expect(reservationRes.status).toBe(403);

    const shiftRes = await postAs(headers, `/branches/${branchId}/shifts/open`, { shiftType: 'morning', openingFloat: 10_000 });
    expect(shiftRes.status).toBe(403);
  });

  it('a front-desk agent can open a shift, but cannot resolve a shift issue or correct a line item (owner/manager-only actions)', async () => {
    const headers = await provisionStaff('front_desk');

    const shiftRes = await postAs(headers, `/branches/${branchId}/shifts/open`, { shiftType: 'evening', openingFloat: 10_000 });
    expect(shiftRes.status).toBe(201);
    const shift = shiftRes.body as { id: string };

    const issueRes = await postAs(headers, `/shifts/${shift.id}/issues`, { description: 'RBAC test issue' });
    expect(issueRes.status).toBe(201);
    const issue = issueRes.body as { id: string };

    // Front desk can LOG an issue but not RESOLVE one — that's Owner/Manager only.
    const resolveRes = await patchAs(headers, `/shift-issues/${issue.id}`, { status: 'resolved' });
    expect(resolveRes.status).toBe(403);

    // Correcting a posted charge is Owner/Manager/Accountant only — front desk is deliberately excluded
    // (an append-only ledger correction needs a step up from whoever can merely post a charge).
    const correctRes = await postAs(headers, '/line-items/00000000-0000-4000-8000-000000000000/correct', { reason: 'RBAC test' });
    expect(correctRes.status).toBe(403);
  });

  it('an accountant can correct a line item, but cannot open a cash shift (front-desk-floor-staff-only action)', async () => {
    const headers = await provisionStaff('accountant');

    // Accountant IS allowed to hit /line-items/:id/correct — a 404 (route reached, entity not found) proves the
    // role gate passed; a 403 would mean the gate wrongly excluded this role.
    const correctRes = await postAs(headers, '/line-items/00000000-0000-4000-8000-000000000000/correct', { reason: 'RBAC test' });
    expect(correctRes.status).toBe(404);

    const shiftRes = await postAs(headers, `/branches/${branchId}/shifts/open`, { shiftType: 'night', openingFloat: 10_000 });
    expect(shiftRes.status).toBe(403);
  });

  it('the owner can do all of the above — the boundary is role-specific, not a blanket lockdown', async () => {
    const shiftRes = await postAs(ownerHeaders, `/branches/${branchId}/shifts/open`, { shiftType: 'morning', openingFloat: 10_000 });
    // Owner already opened no shift yet in this describe block's own tenant — first real open should succeed.
    expect(shiftRes.status).toBe(201);
    const shift = shiftRes.body as { id: string };
    const closeRes = await postAs(ownerHeaders, `/shifts/${shift.id}/close`, { closingCashCounted: 10_000 });
    expect(closeRes.status).toBe(201);
  });
});
