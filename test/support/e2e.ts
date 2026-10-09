import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import request, { Response } from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app-setup';
import { PrismaService, TenantTx } from '../../src/prisma/prisma.service';

/**
 * Shared ground for the end-to-end suites: the API built exactly as
 * `main.ts` builds it, a small HTTP client, and the steps every suite needs —
 * sign up an organisation, lay out a property, hire staff, delete it all.
 *
 * Each suite signs up its own organisation(s), so suites never see each
 * other's data, whatever else is in the database. They run as an ordinary
 * database role (see the CI workflow) — never a superuser, which would skip
 * the row-level security every tenant boundary depends on.
 */

/** The timezone every branch these suites make is in. */
export const TIMEZONE = 'Africa/Lagos';

/** A calendar day `days` after `day` (both `YYYY-MM-DD`). */
export function addDays(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Today in Lagos, moved by `offsetDays` — not the machine's day, and not UTC's: for an hour each night those differ. */
export function lagosDay(offsetDays = 0): string {
  return addDays(new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }), offsetDays);
}

/**
 * The API as it runs: same body limit, validation, prefix, versioning and
 * error format as `main.ts`. The scheduled jobs are stopped: a suite drives
 * every step itself, and the hourly night-audit sweep closing a test's night
 * a minute before the test does would make it fail one run in fifty.
 */
export async function startApp(): Promise<{ app: INestApplication<App>; prisma: PrismaService }> {
  const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>({ bodyParser: false });
  configureApp(app);
  // Listening once, on a free port: handed a server that isn't listening,
  // supertest starts and closes it around every request, and two requests
  // in flight at once then reset each other's connections (ECONNRESET).
  await app.listen(0, '127.0.0.1');
  const scheduler = app.get(SchedulerRegistry);
  for (const job of scheduler.getCronJobs().values()) void job.stop();
  for (const name of scheduler.getIntervals()) scheduler.deleteInterval(name);
  return { app, prisma: app.get(PrismaService) };
}

/** Someone signed in: what every request on their behalf carries. */
export interface Session {
  token: string;
  tenantId: string;
  userId: string;
  email: string;
  password: string;
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** A thin HTTP client over the in-process app. Every path is under `/api/v1`. */
export class Client {
  constructor(private readonly app: INestApplication<App>) {}

  send(method: Method, path: string, as?: Session | null, body?: unknown): Promise<Response> {
    let req = request(this.app.getHttpServer())[method](`/api/v1${path}`);
    if (as) req = req.set({ Authorization: `Bearer ${as.token}`, 'X-Tenant-ID': as.tenantId });
    return body === undefined ? req : req.send(body as object);
  }

  get(path: string, as?: Session | null): Promise<Response> {
    return this.send('get', path, as);
  }
  post(path: string, as?: Session | null, body: unknown = {}): Promise<Response> {
    return this.send('post', path, as, body);
  }
  put(path: string, as?: Session | null, body: unknown = {}): Promise<Response> {
    return this.send('put', path, as, body);
  }
  patch(path: string, as?: Session | null, body: unknown = {}): Promise<Response> {
    return this.send('patch', path, as, body);
  }
  delete(path: string, as?: Session | null, body: unknown = {}): Promise<Response> {
    return this.send('delete', path, as, body);
  }
}

/** Runs `fn` inside the organisation's row-level-security context — for setting up what the API can't (a stay that arrived yesterday). */
export function inTenant<T>(prisma: PrismaService, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return prisma.withTenant(tenantId, fn);
}

/** Signs an organisation up the way a hotel does — register, confirm the email, sign in — and returns the owner's session. */
export async function signUp(client: Client, label: string): Promise<Session> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `e2e-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}@example.com`;
  const password = 'Str0ngPass!1';
  // A demo organisation expires on its own, so one a failed run leaves behind is swept away nightly.
  const registered = await client.post('/auth/register', null, { groupName: `E2E ${label} ${stamp}`, name: `${label} Owner`, email, password, isDemo: true });
  if (registered.status !== 201) throw new Error(`register ${registered.status}: ${JSON.stringify(registered.body)}`);
  const { verificationToken } = registered.body as { verificationToken: string };
  const verified = await client.post('/auth/verify-email', null, { token: verificationToken });
  if (verified.status !== 200) throw new Error(`verify ${verified.status}: ${JSON.stringify(verified.body)}`);
  return signIn(client, email, password);
}

export async function signIn(client: Client, email: string, password: string): Promise<Session> {
  const res = await client.post('/auth/login', null, { email, password });
  if (res.status !== 200) throw new Error(`login ${res.status}: ${JSON.stringify(res.body)}`);
  const { accessToken, user } = res.body as { accessToken: string; user: { id: string; tenantId: string } };
  return { token: accessToken, tenantId: user.tenantId, userId: user.id, email, password };
}

/** The `Set-Cookie` line that carries the session, if the answer set one. */
export function sessionSetCookie(res: Response): string | undefined {
  const lines = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return lines.find((line) => line.startsWith('roomick_session='));
}

/** What a browser sends back: `roomick_session=<token>`. */
export function sessionCookie(res: Response): string {
  const line = sessionSetCookie(res);
  if (!line) throw new Error(`no session cookie (${res.status}): ${JSON.stringify(res.body)}`);
  return line.split(';')[0];
}

/** The refresh token itself, from the cookie. */
export function sessionToken(res: Response): string {
  return sessionCookie(res).slice('roomick_session='.length);
}

export interface BranchLayout {
  id: string;
  roomTypeId: string;
  /** Rooms by number order. */
  rooms: Array<{ id: string; number: string }>;
}

/** The head brand (the signup wizard's step 2), once per organisation. */
export async function headBrand(client: Client, owner: Session): Promise<string> {
  const res = await client.post('/tenants/configure-mode', owner, { mode: 'single' });
  if (res.status !== 201) throw new Error(`configure-mode ${res.status}: ${JSON.stringify(res.body)}`);
  return (res.body as { brand: { id: string } }).brand.id;
}

/** A Lagos branch with one room type at `baseRate` and rooms numbered from 101. */
export async function addBranch(client: Client, owner: Session, brandId: string, name: string, roomCount: number, baseRate = 20_000): Promise<BranchLayout> {
  const branch = await client.post(`/brands/${brandId}/branches`, owner, {
    name,
    address: { street: '1 Test Street', city: 'Lagos', country: 'NG' },
    timezone: TIMEZONE,
    currency: 'NGN',
  });
  if (branch.status !== 201) throw new Error(`branch ${branch.status}: ${JSON.stringify(branch.body)}`);
  const id = (branch.body as { id: string }).id;
  const roomType = await client.post(`/branches/${id}/room-types`, owner, { name: `${name} Standard`, baseRate, capacity: { adults: 2, children: 1 } });
  const roomTypeId = (roomType.body as { id: string }).id;
  const bulk = await client.post(`/branches/${id}/rooms/bulk`, owner, { roomTypeId, range: { from: 101, to: 100 + roomCount } });
  if (bulk.status !== 201) throw new Error(`rooms ${bulk.status}: ${JSON.stringify(bulk.body)}`);
  const rooms = ((await client.get(`/branches/${id}/rooms`, owner)).body as Array<{ id: string; number: string }>)
    .map((r) => ({ id: r.id, number: r.number }))
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  return { id, roomTypeId, rooms };
}

/** Invites someone to `branchId` in `role` and accepts the invitation as them. */
export async function hire(client: Client, owner: Session, branchId: string, role: string, label: string): Promise<Session> {
  const roles = (await client.get('/auth/roles', owner)).body as Array<{ id: string; name: string }>;
  const roleId = roles.find((r) => r.name === role)?.id;
  const email = `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const invited = await client.post(`/branches/${branchId}/staff/invite`, owner, { invites: [{ email, roleId }] });
  if (invited.status !== 201) throw new Error(`invite ${invited.status}: ${JSON.stringify(invited.body)}`);
  const { publicToken } = (invited.body as Array<{ publicToken: string }>)[0];
  const password = 'StaffPass!1';
  const accepted = await client.post(`/auth/accept-invite/${encodeURIComponent(publicToken)}`, null, { name: `${label} person`, password });
  if (accepted.status !== 201) throw new Error(`accept ${accepted.status}: ${JSON.stringify(accepted.body)}`);
  const { accessToken, user } = accepted.body as { accessToken: string; user: { id: string; tenantId: string } };
  return { token: accessToken, tenantId: user.tenantId, userId: user.id, email, password };
}

/** A confirmed stay from `checkInDate` to `checkOutDate`; returns its id. */
export async function book(client: Client, owner: Session, branch: BranchLayout, guestName: string, checkInDate: string, checkOutDate: string): Promise<string> {
  const res = await client.post(`/branches/${branch.id}/reservations`, owner, {
    // An address of its own, whatever the name holds — a name can be anything, a formula included.
    guest: { name: guestName, email: `guest.${Date.now()}.${Math.random().toString(36).slice(2, 10)}@example.com` },
    roomTypeId: branch.roomTypeId,
    checkInDate,
    checkOutDate,
    adults: 1,
  });
  if (res.status !== 201) throw new Error(`book ${res.status}: ${JSON.stringify(res.body)}`);
  return (res.body as { id: string }).id;
}

/** Checks a stay in to `roomId`; returns its primary bill's id. */
export async function checkIn(client: Client, owner: Session, reservationId: string, roomId: string): Promise<string> {
  const res = await client.post(`/reservations/${reservationId}/check-in`, owner, { roomId });
  if (res.status !== 201) throw new Error(`check-in ${res.status}: ${JSON.stringify(res.body)}`);
  const folios = (await client.get(`/reservations/${reservationId}/folios`, owner)).body as Array<{ id: string }>;
  return folios[0].id;
}

/** Runs `fn` over `items`, `concurrency` at a time. */
export async function inParallel<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

/** Deletes the organisation the way its owner would; true when it's gone. */
export async function deleteOrganisation(client: Client, prisma: PrismaService, owner: Session): Promise<boolean> {
  const fresh = await signIn(client, owner.email, owner.password);
  const res = await client.delete('/tenants/me', fresh, { password: owner.password });
  if (res.status !== 204) return false;
  return (await prisma.tenant.findUnique({ where: { id: owner.tenantId } })) === null;
}
