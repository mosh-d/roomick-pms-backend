import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationsService } from './integrations.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';

function makeTx() {
  return {
    apiKey: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), findFirstOrThrow: jest.fn(), update: jest.fn() },
    webhook: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), update: jest.fn() },
    webhookDelivery: { groupBy: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }), findMany: jest.fn().mockResolvedValue([]) },
    branch: { findFirst: jest.fn().mockResolvedValue({ id: BRANCH_ID }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

describe('IntegrationsService', () => {
  let service: IntegrationsService;
  let tx: ReturnType<typeof makeTx>;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(async () => {
    tx = makeTx();
    const prisma = { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) };
    const moduleRef = await Test.createTestingModule({
      providers: [IntegrationsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(IntegrationsService);
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('API keys', () => {
    beforeEach(() => {
      tx.apiKey.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'key-1', createdAt: new Date(), lastUsedAt: null, revokedAt: null, branch: null, ...data }));
    });

    it('returns the raw key exactly once, and keeps only its SHA-256 hash', async () => {
      const result = await service.createApiKey(TENANT_ID, { name: 'Accounting sync', scopes: ['folios'] }, ACTOR);

      expect(result.rawKey).toMatch(/^rk_[0-9a-f]{48}$/);
      const data = tx.apiKey.create.mock.calls[0][0].data;
      expect(data.keyHash).toBe(createHash('sha256').update(result.rawKey).digest('hex'));
      expect(data).not.toHaveProperty('rawKey');
      expect(data.keyPrefix).toBe(result.rawKey.slice(0, 10));
    });

    it('keeps what the key can read and its branch, once each', async () => {
      await service.createApiKey(TENANT_ID, { name: 'Branch BI', scopes: ['reports', 'reservations', 'reports'], branchId: BRANCH_ID }, ACTOR);
      expect(tx.apiKey.create.mock.calls[0][0].data).toMatchObject({ scopes: ['reports', 'reservations'], branchId: BRANCH_ID });
    });

    it('never writes the key to the audit trail', async () => {
      const result = await service.createApiKey(TENANT_ID, { name: 'Accounting sync', scopes: ['folios'] }, ACTOR);
      const row = tx.auditLog.create.mock.calls[0][0].data;
      expect(row.action).toBe('api_key.created');
      expect(JSON.stringify(row)).not.toContain(result.rawKey);
      expect(JSON.stringify(row)).not.toContain(tx.apiKey.create.mock.calls[0][0].data.keyHash);
    });

    it('refuses a branch that isn’t this account’s', async () => {
      tx.branch.findFirst.mockResolvedValue(null);
      await expect(service.createApiKey(TENANT_ID, { name: 'x1', scopes: ['folios'], branchId: BRANCH_ID }, ACTOR)).rejects.toMatchObject({ status: 404 });
      expect(tx.apiKey.create).not.toHaveBeenCalled();
    });

    it('lists keys without their hash', async () => {
      await service.listApiKeys(TENANT_ID);
      expect(tx.apiKey.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.not.objectContaining({ keyHash: true }) }));
    });

    it('changes what a key reads, and clears its branch with null', async () => {
      tx.apiKey.findFirst.mockResolvedValue({ id: 'key-1', name: 'BI', scopes: ['reports'], branchId: BRANCH_ID, revokedAt: null });
      tx.apiKey.update.mockResolvedValue({ id: 'key-1', name: 'BI', scopes: ['reports', 'guests'], branch: null });
      await service.updateApiKey(TENANT_ID, 'key-1', { scopes: ['reports', 'guests'], branchId: null }, ACTOR);
      expect(tx.apiKey.update.mock.calls[0][0].data).toEqual({ scopes: ['reports', 'guests'], branchId: null });
    });

    it('won’t change a revoked key', async () => {
      tx.apiKey.findFirst.mockResolvedValue({ id: 'key-1', revokedAt: new Date() });
      await expect(service.updateApiKey(TENANT_ID, 'key-1', { scopes: ['guests'] }, ACTOR)).rejects.toMatchObject({ status: 400 });
    });

    it('revokes a key once, and says so in the audit trail', async () => {
      tx.apiKey.findFirst.mockResolvedValue({ id: 'key-1', name: 'BI', revokedAt: null });
      tx.apiKey.update.mockResolvedValue({ id: 'key-1', revokedAt: new Date() });
      const result = await service.revokeApiKey(TENANT_ID, 'key-1', ACTOR);
      expect(result.revokedAt).toBeInstanceOf(Date);
      expect(tx.auditLog.create.mock.calls[0][0].data.action).toBe('api_key.revoked');
    });

    it('a missing key is a 404', async () => {
      tx.apiKey.findFirst.mockResolvedValue(null);
      await expect(service.revokeApiKey(TENANT_ID, 'nope', ACTOR)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('webhooks', () => {
    beforeEach(() => {
      tx.webhook.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'wh-1', isActive: true, createdAt: new Date(), branch: null, ...data }));
    });

    it('returns the signing secret exactly once, never into the audit trail', async () => {
      const result = await service.createWebhook(TENANT_ID, { url: 'https://partner.example.com/hook', eventTypes: ['reservation.created'] }, ACTOR);
      expect(result.secret).toMatch(/^[0-9a-f]{48}$/);
      expect(JSON.stringify(tx.auditLog.create.mock.calls[0][0].data)).not.toContain(result.secret);
    });

    it('in production, refuses an address that isn’t https or is private', async () => {
      process.env.NODE_ENV = 'production';
      await expect(service.createWebhook(TENANT_ID, { url: 'http://partner.example.com/hook', eventTypes: ['reservation.created'] }, ACTOR)).rejects.toMatchObject({ status: 400 });
      await expect(service.createWebhook(TENANT_ID, { url: 'https://192.168.1.10/hook', eventTypes: ['reservation.created'] }, ACTOR)).rejects.toMatchObject({ status: 400 });
      expect(tx.webhook.create).not.toHaveBeenCalled();
    });

    it('lists webhooks without their secret, with what is waiting and what failed', async () => {
      tx.webhook.findMany.mockResolvedValue([{ id: 'wh-1', url: 'https://x.example', eventTypes: ['reservation.created'], isActive: true, createdAt: new Date(), branch: null }]);
      tx.webhookDelivery.groupBy
        .mockResolvedValueOnce([{ webhookId: 'wh-1', _count: { _all: 2 } }])
        .mockResolvedValueOnce([{ webhookId: 'wh-1', _count: { _all: 1 } }])
        .mockResolvedValueOnce([{ webhookId: 'wh-1', _max: { deliveredAt: new Date('2026-10-07T10:00:00Z') } }]);
      const [webhook] = await service.listWebhooks(TENANT_ID);
      expect(tx.webhook.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.not.objectContaining({ secret: true }) }));
      expect(webhook).toMatchObject({ pending: 2, failedThisWeek: 1, lastDeliveredAt: new Date('2026-10-07T10:00:00Z') });
    });

    it('switching one off drops what was waiting — never deletes it', async () => {
      tx.webhook.findFirst.mockResolvedValue({ id: 'wh-1', url: 'https://x.example', eventTypes: ['reservation.created'], branchId: null, isActive: true });
      tx.webhook.update.mockResolvedValue({ id: 'wh-1', url: 'https://x.example', eventTypes: ['reservation.created'], branchId: null, isActive: false });
      await service.deactivateWebhook(TENANT_ID, 'wh-1', ACTOR);
      expect(tx.webhook.update).toHaveBeenCalledWith({ where: { id: 'wh-1' }, data: { isActive: false } });
      expect(tx.webhookDelivery.updateMany).toHaveBeenCalledWith({
        where: { webhookId: 'wh-1', status: 'pending' },
        data: expect.objectContaining({ status: 'failed', lastError: 'The webhook was switched off before this was sent' }),
      });
    });

    it('won’t switch on a webhook with nothing to listen for', async () => {
      tx.webhook.findFirst.mockResolvedValue({ id: 'wh-1', eventTypes: [], isActive: false });
      await expect(service.updateWebhook(TENANT_ID, 'wh-1', { isActive: true }, ACTOR)).rejects.toMatchObject({ status: 400 });
    });

    it('the catalogue names every event once', () => {
      const types = service.eventCatalogue().map((event) => event.type);
      expect(new Set(types).size).toBe(types.length);
      expect(types).toContain('reservation.checked_in');
    });
  });
});
