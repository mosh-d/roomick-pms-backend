import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationsService } from './integrations.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';

describe('IntegrationsService', () => {
  let service: IntegrationsService;
  let tx: {
    apiKey: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
    webhook: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
  };
  let prisma: { withTenant: jest.Mock };

  beforeEach(async () => {
    tx = {
      apiKey: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), update: jest.fn() },
      webhook: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), update: jest.fn() },
    };
    prisma = { withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)) };
    const moduleRef = await Test.createTestingModule({
      providers: [IntegrationsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(IntegrationsService);
  });

  describe('createApiKey', () => {
    it('returns the raw key exactly once, and persists only its SHA-256 hash, never the raw value', async () => {
      tx.apiKey.create.mockImplementation(({ data }) => Promise.resolve({ id: 'key-1', ...data }));
      const result = await service.createApiKey(TENANT_ID, 'My Integration', ACTOR);

      expect(result.rawKey).toMatch(/^rk_[0-9a-f]{48}$/);
      const persistedData = tx.apiKey.create.mock.calls[0][0].data;
      expect(persistedData.keyHash).toBe(createHash('sha256').update(result.rawKey).digest('hex'));
      expect(persistedData).not.toHaveProperty('rawKey');
      expect(persistedData.keyPrefix).toBe(result.rawKey.slice(0, 10));
    });

    it('never returns keyHash in its response shape', async () => {
      tx.apiKey.create.mockImplementation(({ data }) => Promise.resolve({ id: 'key-1', ...data }));
      const result = await service.createApiKey(TENANT_ID, 'My Integration', ACTOR);
      expect(result).not.toHaveProperty('keyHash');
    });
  });

  describe('listApiKeys', () => {
    it('selects only metadata fields — never keyHash', async () => {
      await service.listApiKeys(TENANT_ID);
      expect(tx.apiKey.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.not.objectContaining({ keyHash: true }) }));
    });
  });

  describe('revokeApiKey', () => {
    it('throws NOT_FOUND for an unknown key', async () => {
      tx.apiKey.findFirst.mockResolvedValue(null);
      await expect(service.revokeApiKey(TENANT_ID, 'nonexistent')).rejects.toMatchObject({ status: 404 });
    });

    it('stamps revokedAt on a real key', async () => {
      tx.apiKey.findFirst.mockResolvedValue({ id: 'key-1' });
      tx.apiKey.update.mockImplementation(({ data }) => Promise.resolve({ id: 'key-1', name: 'x', keyPrefix: 'rk_abc', createdAt: new Date(), lastUsedAt: null, ...data }));
      const result = await service.revokeApiKey(TENANT_ID, 'key-1');
      expect(result.revokedAt).toBeInstanceOf(Date);
    });
  });

  describe('verifyApiKey', () => {
    it('returns false for an unknown or revoked key, without throwing', async () => {
      tx.apiKey.findFirst.mockResolvedValue(null);
      await expect(service.verifyApiKey(TENANT_ID, 'rk_bogus')).resolves.toBe(false);
      expect(tx.apiKey.update).not.toHaveBeenCalled();
    });

    it('returns true and stamps lastUsedAt for a real, non-revoked key presented as its raw value', async () => {
      const rawKey = 'rk_realkey';
      tx.apiKey.findFirst.mockResolvedValue({ id: 'key-1' });
      const result = await service.verifyApiKey(TENANT_ID, rawKey);
      expect(result).toBe(true);
      expect(tx.apiKey.findFirst).toHaveBeenCalledWith({ where: { keyHash: createHash('sha256').update(rawKey).digest('hex'), revokedAt: null } });
      expect(tx.apiKey.update).toHaveBeenCalledWith({ where: { id: 'key-1' }, data: { lastUsedAt: expect.any(Date) } });
    });
  });

  describe('createWebhook', () => {
    it('returns the signing secret exactly once, and persists the event types as given', async () => {
      tx.webhook.create.mockImplementation(({ data }) => Promise.resolve({ id: 'wh-1', isActive: true, createdAt: new Date(), ...data }));
      const result = await service.createWebhook(TENANT_ID, { url: 'https://example.com/hook', eventTypes: ['reservations.post'] }, ACTOR);
      expect(result.secret).toMatch(/^[0-9a-f]{48}$/);
      expect(result.eventTypes).toEqual(['reservations.post']);
    });
  });

  describe('listWebhooks', () => {
    it('selects only metadata fields — never the signing secret', async () => {
      await service.listWebhooks(TENANT_ID);
      expect(tx.webhook.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.not.objectContaining({ secret: true }) }));
    });
  });

  describe('deactivateWebhook', () => {
    it('throws NOT_FOUND for an unknown webhook', async () => {
      tx.webhook.findFirst.mockResolvedValue(null);
      await expect(service.deactivateWebhook(TENANT_ID, 'nonexistent')).rejects.toMatchObject({ status: 404 });
    });

    it('sets isActive to false rather than deleting the row', async () => {
      tx.webhook.findFirst.mockResolvedValue({ id: 'wh-1' });
      tx.webhook.update.mockImplementation(({ data }) => Promise.resolve({ id: 'wh-1', url: 'https://x.com', eventTypes: [], createdAt: new Date(), ...data }));
      const result = await service.deactivateWebhook(TENANT_ID, 'wh-1');
      expect(result.isActive).toBe(false);
      expect(tx.webhook.update).toHaveBeenCalledWith({ where: { id: 'wh-1' }, data: { isActive: false } });
    });
  });
});
