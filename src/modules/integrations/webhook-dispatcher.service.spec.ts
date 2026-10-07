import { createHmac } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { MAX_ATTEMPTS, WebhookDispatcherService, WebhookSender } from './webhook-dispatcher.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

interface Row {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  lastAttemptAt: Date | null;
  responseStatus: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
  webhook: { url: string; secret: string; isActive: boolean };
}

function delivery(overrides: Partial<Row> = {}): Row {
  return {
    id: 'dlv-1',
    webhookId: 'wh-1',
    eventId: 'evt-1',
    eventType: 'reservation.created',
    payload: { id: 'evt-1', type: 'reservation.created', data: { reservation: { confirmationNumber: 'RES-1' } } },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: new Date(Date.now() - 1000),
    lockedUntil: null,
    lastAttemptAt: null,
    responseStatus: null,
    lastError: null,
    deliveredAt: null,
    createdAt: new Date(),
    webhook: { url: 'https://partner.example/hook', secret: 'whsec', isActive: true },
    ...overrides,
  };
}

/** Just enough of `webhook_deliveries` to claim, send and record — claims honour the lock the way the real `updateMany` does. */
function store(rows: Row[]) {
  const matches = (row: Row, where: Record<string, unknown>) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.status === 'pending' && row.status !== 'pending') return false;
    return true;
  };
  const tx = {
    webhookDelivery: {
      findMany: jest.fn(() => Promise.resolve(rows.filter((r) => r.status === 'pending' && r.nextAttemptAt <= new Date()).map((r) => ({ id: r.id })))),
      updateMany: jest.fn(({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const now = new Date();
        const hit = rows.filter((r) => matches(r, where) && (r.lockedUntil === null || r.lockedUntil < now));
        hit.forEach((r) => Object.assign(r, data));
        return Promise.resolve({ count: hit.length });
      }),
      findFirst: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve(rows.find((r) => r.id === where.id) ?? null)),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
      create: jest.fn(({ data }: { data: Partial<Row> }) => {
        const row = delivery({ id: 'dlv-test', ...data });
        rows.push(row);
        return Promise.resolve({ id: row.id });
      }),
    },
    webhook: { findFirst: jest.fn().mockResolvedValue({ id: 'wh-1', branchId: null, isActive: true }) },
  };
  const prisma = { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) } as unknown as PrismaService;
  return { tx, prisma };
}

describe('WebhookDispatcherService', () => {
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  let answer: { ok: boolean; status: number | null; error: string | null };
  const sender = {
    send: jest.fn((url: string, body: string, headers: Record<string, string>) => {
      sent.push({ url, body, headers });
      return Promise.resolve(answer);
    }),
  } as unknown as WebhookSender;

  beforeEach(() => {
    sent.length = 0;
    answer = { ok: true, status: 200, error: null };
  });

  it('sends what is due, signed with the webhook’s secret, and records it delivered', async () => {
    const rows = [delivery()];
    const { prisma } = store(rows);
    const summary = await new WebhookDispatcherService(prisma, sender).dispatchForTenant(TENANT_ID);

    expect(summary).toEqual({ delivered: 1, retrying: 0, failed: 0 });
    expect(rows[0]).toMatchObject({ status: 'delivered', attempts: 1, responseStatus: 200, lockedUntil: null, lastError: null });
    const [{ body, headers }] = sent;
    expect(JSON.parse(body)).toEqual(rows[0].payload);
    expect(headers['Roomick-Event']).toBe('reservation.created');
    expect(headers['Roomick-Delivery']).toBe('dlv-1');
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(headers['Roomick-Signature'])!.slice(0);
    expect(v1).toBe(createHmac('sha256', 'whsec').update(`${t}.${body}`).digest('hex'));
  });

  it('a failure is retried later — a minute after the first try', async () => {
    answer = { ok: false, status: 503, error: 'HTTP 503' };
    const rows = [delivery()];
    const { prisma } = store(rows);
    const before = Date.now();
    const summary = await new WebhookDispatcherService(prisma, sender).dispatchForTenant(TENANT_ID);

    expect(summary).toEqual({ delivered: 0, retrying: 1, failed: 0 });
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1, responseStatus: 503, lastError: 'HTTP 503' });
    expect(rows[0].nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(59_000);
    expect(rows[0].nextAttemptAt.getTime() - before).toBeLessThan(62_000);
  });

  it('gives up after the last try', async () => {
    answer = { ok: false, status: null, error: 'Connection refused' };
    const rows = [delivery({ attempts: MAX_ATTEMPTS - 1 })];
    const { prisma } = store(rows);
    await new WebhookDispatcherService(prisma, sender).dispatchForTenant(TENANT_ID);
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, lastError: 'Connection refused' });
  });

  it('never sends one that another server holds', async () => {
    const rows = [delivery({ lockedUntil: new Date(Date.now() + 30_000) })];
    const { prisma } = store(rows);
    const result = await new WebhookDispatcherService(prisma, sender).attempt(TENANT_ID, 'dlv-1');
    expect(result).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('a switched-off webhook gets nothing — its deliveries fail without a try', async () => {
    const rows = [delivery({ webhook: { url: 'https://partner.example/hook', secret: 'whsec', isActive: false } })];
    const { prisma } = store(rows);
    await new WebhookDispatcherService(prisma, sender).dispatchForTenant(TENANT_ID);
    expect(sent).toHaveLength(0);
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 0, lastError: 'The webhook was switched off before this was sent' });
  });

  it('a test is sent at once and tried once — the answer goes back to whoever pressed the button', async () => {
    answer = { ok: false, status: 404, error: 'HTTP 404' };
    const rows: Row[] = [];
    const { prisma } = store(rows);
    const result = await new WebhookDispatcherService(prisma, sender).sendTest(TENANT_ID, 'wh-1');
    expect(result).toMatchObject({ eventType: 'webhook.test', status: 'failed', attempts: 1, responseStatus: 404, nextAttemptAt: null });
    expect(JSON.parse(sent[0].body)).toMatchObject({ type: 'webhook.test', tenantId: TENANT_ID });
  });

  it('“Retry” tries a given-up delivery once more, now', async () => {
    const rows = [delivery({ status: 'failed', attempts: MAX_ATTEMPTS, lastError: 'HTTP 500', nextAttemptAt: new Date(Date.now() + 3_600_000) })];
    const { prisma } = store(rows);
    const result = await new WebhookDispatcherService(prisma, sender).retryNow(TENANT_ID, 'dlv-1');
    expect(result).toMatchObject({ status: 'delivered', attempts: MAX_ATTEMPTS + 1 });
  });

  it('won’t retry one that was delivered', async () => {
    const rows = [delivery({ status: 'delivered' })];
    const { prisma } = store(rows);
    await expect(new WebhookDispatcherService(prisma, sender).retryNow(TENANT_ID, 'dlv-1')).rejects.toMatchObject({ status: 409 });
    expect(sent).toHaveLength(0);
  });
});
