import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { FeatureFlagsService } from './feature-flags.service';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe('FeatureFlagsService', () => {
  let service: FeatureFlagsService;
  let prisma: { featureFlag: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      featureFlag: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [FeatureFlagsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(FeatureFlagsService);
  });

  describe('listFlags', () => {
    it('resolves enabledForThisTenant from enabledGlobally OR membership in enabledForTenants', async () => {
      prisma.featureFlag.findMany.mockResolvedValue([
        { id: 'f1', name: 'globally_on', enabledGlobally: true, enabledForTenants: [], rolloutPct: null, updatedAt: new Date() },
        { id: 'f2', name: 'on_for_a_only', enabledGlobally: false, enabledForTenants: [TENANT_A], rolloutPct: null, updatedAt: new Date() },
        { id: 'f3', name: 'off_for_everyone', enabledGlobally: false, enabledForTenants: [TENANT_B], rolloutPct: null, updatedAt: new Date() },
      ]);
      const result = await service.listFlags(TENANT_A);
      expect(result.find((f) => f.name === 'globally_on')?.enabledForThisTenant).toBe(true);
      expect(result.find((f) => f.name === 'on_for_a_only')?.enabledForThisTenant).toBe(true);
      expect(result.find((f) => f.name === 'off_for_everyone')?.enabledForThisTenant).toBe(false);
    });

    it('never exposes the raw enabledForTenants array — no other tenant IDs leak into the response', async () => {
      prisma.featureFlag.findMany.mockResolvedValue([
        { id: 'f1', name: 'flag', enabledGlobally: false, enabledForTenants: [TENANT_A, TENANT_B], rolloutPct: null, updatedAt: new Date() },
      ]);
      const result = await service.listFlags(TENANT_A);
      expect(result[0]).not.toHaveProperty('enabledForTenants');
      expect(JSON.stringify(result)).not.toContain(TENANT_B);
    });
  });

  describe('setEnabledForTenant', () => {
    it('adds the calling tenant to enabledForTenants when enabling, without touching other tenants already there', async () => {
      prisma.featureFlag.findUnique.mockResolvedValue({ id: 'f1', name: 'flag', enabledGlobally: false, enabledForTenants: [TENANT_B], rolloutPct: null, updatedAt: new Date() });
      prisma.featureFlag.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'f1', name: 'flag', enabledGlobally: false, rolloutPct: null, updatedAt: new Date(), ...data }));
      await service.setEnabledForTenant(TENANT_A, 'f1', true);
      expect(prisma.featureFlag.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ enabledForTenants: expect.arrayContaining([TENANT_A, TENANT_B]) }) }));
    });

    it('is idempotent — enabling twice does not duplicate the tenant id', async () => {
      prisma.featureFlag.findUnique.mockResolvedValue({ id: 'f1', name: 'flag', enabledGlobally: false, enabledForTenants: [TENANT_A], rolloutPct: null, updatedAt: new Date() });
      prisma.featureFlag.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'f1', name: 'flag', enabledGlobally: false, rolloutPct: null, updatedAt: new Date(), ...data }));
      await service.setEnabledForTenant(TENANT_A, 'f1', true);
      const nextTenants = prisma.featureFlag.update.mock.calls[0][0].data.enabledForTenants as string[];
      expect(nextTenants.filter((id) => id === TENANT_A)).toHaveLength(1);
    });

    it('removes the calling tenant when disabling, without touching other tenants', async () => {
      prisma.featureFlag.findUnique.mockResolvedValue({ id: 'f1', name: 'flag', enabledGlobally: false, enabledForTenants: [TENANT_A, TENANT_B], rolloutPct: null, updatedAt: new Date() });
      prisma.featureFlag.update.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'f1', name: 'flag', enabledGlobally: false, rolloutPct: null, updatedAt: new Date(), ...data }));
      await service.setEnabledForTenant(TENANT_A, 'f1', false);
      expect(prisma.featureFlag.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ enabledForTenants: [TENANT_B] }) }));
    });

    it('throws NOT_FOUND for an unknown flag id', async () => {
      prisma.featureFlag.findUnique.mockResolvedValue(null);
      await expect(service.setEnabledForTenant(TENANT_A, 'nonexistent', true)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('isEnabledForTenant', () => {
    it('returns false for an unknown flag name rather than throwing', async () => {
      prisma.featureFlag.findUnique.mockResolvedValue(null);
      await expect(service.isEnabledForTenant(TENANT_A, 'nonexistent')).resolves.toBe(false);
    });

    it('resolves true when globally enabled even if the tenant is not in the override list', async () => {
      prisma.featureFlag.findUnique.mockResolvedValue({ enabledGlobally: true, enabledForTenants: [] });
      await expect(service.isEnabledForTenant(TENANT_A, 'flag')).resolves.toBe(true);
    });
  });
});
