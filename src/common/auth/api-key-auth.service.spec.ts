import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedRequest } from '../types/request-context';
import { ApiKeyAuthService, presentedApiKey } from './api-key-auth.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const RAW_KEY = `rk_${'a1'.repeat(24)}`;

function setup(options: { tenantStatus?: string | null; key?: Record<string, unknown> | null } = {}) {
  const tx = {
    apiKey: {
      findFirst: jest.fn().mockResolvedValue(options.key === undefined ? { id: 'key-1', name: 'BI', scopes: ['reports'], branchId: null } : options.key),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue(options.tenantStatus === null ? null : { status: options.tenantStatus ?? 'active' }) },
    withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)),
  };
  return { tx, prisma, service: new ApiKeyAuthService(prisma as unknown as PrismaService) };
}

describe('ApiKeyAuthService', () => {
  it('finds a live key by its hash, under the tenant the request names, and notes it was used', async () => {
    const { service, tx, prisma } = setup();
    await expect(service.authenticate(TENANT_ID, RAW_KEY)).resolves.toEqual({ id: 'key-1', name: 'BI', scopes: ['reports'], branchId: null });
    expect(prisma.withTenant).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(tx.apiKey.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { keyHash: createHash('sha256').update(RAW_KEY).digest('hex'), revokedAt: null } }));
    // At most once a minute — a busy integration doesn't turn every read into a write.
    expect(tx.apiKey.updateMany.mock.calls[0][0].where.OR).toEqual([{ lastUsedAt: null }, { lastUsedAt: { lt: expect.any(Date) } }]);
  });

  it('an unknown or revoked key is nobody', async () => {
    const { service } = setup({ key: null });
    await expect(service.authenticate(TENANT_ID, RAW_KEY)).resolves.toBeNull();
  });

  it('a suspended or missing account lets no key in', async () => {
    await expect(setup({ tenantStatus: 'suspended' }).service.authenticate(TENANT_ID, RAW_KEY)).resolves.toBeNull();
    await expect(setup({ tenantStatus: null }).service.authenticate(TENANT_ID, RAW_KEY)).resolves.toBeNull();
  });

  it('a malformed key or tenant id is refused before the database is asked', async () => {
    const { service, prisma } = setup();
    await expect(service.authenticate('not-a-uuid', RAW_KEY)).resolves.toBeNull();
    await expect(service.authenticate(TENANT_ID, 'rk_short')).resolves.toBeNull();
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});

describe('presentedApiKey', () => {
  const request = (headers: Record<string, string>) => ({ header: (name: string) => headers[name.toLowerCase()] }) as unknown as AuthenticatedRequest;

  it('takes a key from the bearer header or X-API-Key', () => {
    expect(presentedApiKey(request({ authorization: `Bearer ${RAW_KEY}` }))).toBe(RAW_KEY);
    expect(presentedApiKey(request({ 'x-api-key': RAW_KEY }))).toBe(RAW_KEY);
  });

  it('leaves a person’s token to the JWT check', () => {
    expect(presentedApiKey(request({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x' }))).toBeNull();
    expect(presentedApiKey(request({}))).toBeNull();
  });
});
